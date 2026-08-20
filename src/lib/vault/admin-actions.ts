"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/db/client";
import { requireAdmin } from "@/lib/auth/guard";
import { revealCredential, type RevealResult } from "@/lib/vault/reveal";

/**
 * Admin-only vault actions.
 *
 * Kept out of actions.ts so the guard used by each file is obvious at a glance: every
 * export here calls `requireAdmin()`, every export there calls `requireMember()`. A
 * Server Action is an individually-addressable POST endpoint, so mixing the two in one
 * module is exactly how the wrong guard ends up on the wrong action.
 */

/**
 * Reveal any member's app password.
 *
 * Unlike the member action there is no owner predicate -- that is the point of the
 * admin view. The `vault_reveals` row records it as `onBehalf`, which is the flag worth
 * filtering on later: reading someone else's mailbox password is the event that matters.
 *
 * This grants nothing the audited export doesn't already grant; it just avoids
 * downloading a file full of credentials to read one line.
 */
export async function revealAppPasswordForAdmin(form: FormData): Promise<RevealResult> {
  const viewer = await requireAdmin();
  const email = String(form.get("email") ?? "")
    .trim()
    .toLowerCase();
  if (!email) return { ok: false, error: "Missing address." };

  // Same alias resolution as the member action -- see revealOwnAppPassword.
  const credential = await prisma.emailCredential.findFirst({
    where: { OR: [{ email }, { aliases: { some: { email } } }] },
    select: { id: true, email: true, appPasswordEnc: true, discordUserId: true },
  });
  return revealCredential(credential, viewer.discordUserId);
}

/**
 * "These edits are confirmed."
 *
 * The other half of the pair the schema describes on `VaultChange.appliedAt`: a member can
 * only report a change, and only the operator can see it take effect. Until this existed the
 * honest answer to "did my new card get used" was nothing at all, which is why members kept
 * asking in the channel.
 *
 * EXPLICIT IDS ONLY. There is deliberately no "confirm this whole retailer" or "confirm
 * everything" path: confirming is a claim that a specific edit is live, and a single
 * mis-click that wiped the entire queue would silently tell every member their changes had
 * landed when nothing had been loaded. There is no undo -- the column never unsets -- so
 * the guard belongs here and not only in the UI. A Server Action is an individually
 * addressable POST endpoint, so a bulk path left callable would make the protection
 * cosmetic.
 *
 * NEVER UNSETS. A confirmed change stays confirmed; a later edit appends its own row. That
 * is also why `appliedAt: null` is the only filter anything needs.
 *
 * The COLUMNS stay `applied_at` / `applied_by` while the UI says "confirmed" -- the wording
 * changed after the migration was already applied in production, and renaming a column to
 * match a label is not worth a second migration.
 */
export async function markChangesApplied(
  form: FormData,
): Promise<{ ok: true; applied: number } | { ok: false; error: string }> {
  const viewer = await requireAdmin();

  const ids = [...new Set(form.getAll("changeId").map(String).filter(Boolean))];
  if (ids.length === 0) return { ok: false, error: "Nothing selected." };

  const pending = await prisma.vaultChange.findMany({
    // `appliedAt: null` as well as the ids: re-confirming an already-confirmed change would
    // otherwise overwrite who confirmed it and when, losing the original record.
    where: { id: { in: ids }, appliedAt: null },
    select: { id: true, ownerDiscordId: true },
  });
  // Not an error: the selection was valid, someone else just got there first. Saying
  // "0 confirmed" is more useful than a failure for a no-op.
  if (pending.length === 0) return { ok: true, applied: 0 };

  const at = new Date();
  await prisma.$transaction([
    prisma.vaultChange.updateMany({
      where: { id: { in: pending.map((p) => p.id) } },
      data: { appliedAt: at, appliedBy: viewer.discordUserId },
    }),
    prisma.adminAudit.create({
      data: {
        actorDiscordId: viewer.discordUserId,
        action: "vault_change.confirm",
        entity: "vault_change",
        entityId: pending.length === 1 ? pending[0].id : null,
        after: {
          count: pending.length,
          members: [...new Set(pending.map((p) => p.ownerDiscordId))].length,
        },
      },
    }),
  ]);

  // Both sides: the operator's queue and every member's own profile page.
  revalidatePath("/admin/profiles");
  revalidatePath("/dashboard/profiles");
  return { ok: true, applied: pending.length };
}

export type RevealAllResult =
  | { ok: true; revealed: { email: string; value: string }[]; failed: string[] }
  | { ok: false; error: string };

/**
 * Every app password one member holds, in one click.
 *
 * The point is the drop-day case: a member's codes aren't arriving, and finding out why
 * meant clicking reveal on each of their addresses in turn, on each retailer page
 * separately. This is the same read, batched.
 *
 * It grants nothing the IMAP export doesn't already grant -- that writes every one of
 * these to a CSV on disk. This is strictly the smaller exposure of the two, because
 * nothing touches the filesystem and the values clear themselves off screen.
 *
 * ONE AUDIT ROW PER CREDENTIAL, not one for the batch. `vault_reveals` has to answer
 * "who read the password for this mailbox, and when" per mailbox; a single row saying
 * "read 6 of them" would leave that unanswerable. Reusing `revealCredential` rather than
 * decrypting here is what guarantees the row is written before the plaintext exists.
 *
 * A credential whose envelope won't open is reported by address in `failed` rather than
 * failing the batch -- one unopenable row must not hide the five that are fine.
 */
export async function revealAllAppPasswordsForAdmin(form: FormData): Promise<RevealAllResult> {
  const viewer = await requireAdmin();
  const discordUserId = String(form.get("discordUserId") ?? "").trim();
  if (!discordUserId) return { ok: false, error: "Missing member." };

  const credentials = await prisma.emailCredential.findMany({
    where: { discordUserId },
    orderBy: { email: "asc" },
    select: { id: true, email: true, appPasswordEnc: true, discordUserId: true },
  });
  if (credentials.length === 0) {
    return { ok: false, error: "No app passwords on file for this member." };
  }

  const revealed: { email: string; value: string }[] = [];
  const failed: string[] = [];

  // Sequential, deliberately: these are audit writes, and a Promise.all over them buys
  // milliseconds on a list this size while making the failure mode harder to reason about.
  for (const credential of credentials) {
    const result = await revealCredential(credential, viewer.discordUserId);
    if (result.ok) revealed.push({ email: result.email, value: result.value });
    else failed.push(credential.email);
  }

  return { ok: true, revealed, failed };
}

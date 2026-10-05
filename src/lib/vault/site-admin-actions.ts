"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/db/client";
import { pendingInBucket } from "@/db/queries/admin-vault";
import { ALL_SITES, vaultScopeFor } from "@/lib/auth/admin-scope";
import { requireAnyAdmin } from "@/lib/auth/guard";

/**
 * Vault actions a RUNNER may take, as well as a full admin.
 *
 * Its own module so the guard is obvious at a glance, the same split admin-actions.ts and
 * actions.ts keep: every export here calls `requireAnyAdmin()` AND narrows what it touches
 * to the viewer's own queue. A Server Action is an individually-addressable POST endpoint,
 * so the narrowing lives in the query, never only in what the page chose to render.
 */

/**
 * "These edits are confirmed."
 *
 * The other half of the pair the schema describes on `VaultChange.appliedAt`: a member can
 * only report a change, and only the operator can see it take effect. Until this existed the
 * honest answer to "did my new card get used" was nothing at all, which is why members kept
 * asking in the channel.
 *
 * A RUNNER CONFIRMS THEIR OWN QUEUE ONLY: changes on their retailers that were stamped for
 * their bot. Chess loads his Crunchyroll profiles into his bot, so he is the one who can say
 * one of those edits is live -- and nobody else's, including another Crunchyroll runner's.
 * An id from anyone else's queue is simply not found, and so not confirmed, rather than
 * failing the rest: the count that comes back says what actually happened. A full admin can
 * confirm anyone's.
 *
 * EXPLICIT IDS ONLY, here. Confirming is a claim that a specific edit is live, and there is
 * no undo -- the column never unsets. (The one multi-id caller is a move between runners,
 * which lists every id it confirms: one move is one gesture, and those rows tell a member
 * nothing either way.) The one bulk path is `confirmAllPendingChanges` below, which is
 * narrower than it sounds: one retailer's tab, only what that tab showed, and only after a
 * second click.
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
  const viewer = await requireAnyAdmin();

  const ids = [...new Set(form.getAll("changeId").map(String).filter(Boolean))];
  if (ids.length === 0) return { ok: false, error: "Nothing selected." };

  const pending = await prisma.vaultChange.findMany({
    // `appliedAt: null` as well as the ids: re-confirming an already-confirmed change would
    // otherwise overwrite who confirmed it and when, losing the original record.
    where: {
      id: { in: ids },
      appliedAt: null,
      ...(viewer.adminSites === ALL_SITES
        ? {}
        : { siteKey: { in: [...viewer.adminSites] }, assigneeId: viewer.discordUserId }),
    },
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

/**
 * "Confirm all" for ONE retailer's tab: every change in it, after the export is loaded.
 *
 * The bulk path the rule above held off, added once a drop's queue reached the size where
 * row-by-row was the slow part of the night. What keeps it from being the mis-click that
 * rule feared -- each half held here, not just in the button:
 *
 *   ONE BUCKET.  A retailer (or the mailbox bucket), never "everything": the operator loads
 *                one bot at a time, and confirms the bot they just loaded.
 *   WHAT WAS SEEN. Only changes made by the time the page was drawn (`seenAt`), and only if
 *                there are still exactly as many as the tab said (`expected`). A change that
 *                arrived since, or one somebody else confirmed in the meantime, refuses the
 *                whole click rather than confirming a set nobody looked at.
 *   THE SAME SCOPE as the page: a runner's own queue, or the queue a full admin had open
 *                (`runner`), rebuilt from the viewer -- never widened by the request.
 *
 * The second click lives in the button; this is what makes a forged or replayed POST no
 * worse than one careful click.
 */
export async function confirmAllPendingChanges(
  form: FormData,
): Promise<{ ok: true; applied: number } | { ok: false; error: string }> {
  const viewer = await requireAnyAdmin();

  const bucket = String(form.get("bucket") ?? "");
  const seenAt = new Date(String(form.get("seenAt") ?? ""));
  const expected = Number(form.get("expected"));
  const runner = form.get("runner") ? String(form.get("runner")) : null;
  if (!bucket || Number.isNaN(seenAt.getTime()) || !Number.isInteger(expected) || expected < 1) {
    return { ok: false, error: "Reload the page and try again." };
  }

  const { scope } = vaultScopeFor(viewer, runner);
  const pending = await prisma.vaultChange.findMany({
    where: pendingInBucket(scope, bucket, seenAt),
    select: { id: true, ownerDiscordId: true },
  });
  if (pending.length !== expected) {
    return {
      ok: false,
      error: `The queue changed since this page loaded (${pending.length} waiting, not ${expected}). Reload and check it again.`,
    };
  }

  const at = new Date();
  await prisma.$transaction([
    prisma.vaultChange.updateMany({
      where: { id: { in: pending.map((p) => p.id) }, appliedAt: null },
      data: { appliedAt: at, appliedBy: viewer.discordUserId },
    }),
    prisma.adminAudit.create({
      data: {
        actorDiscordId: viewer.discordUserId,
        action: "vault_change.confirm_all",
        entity: "vault_change",
        entityId: null,
        after: {
          bucket,
          count: pending.length,
          members: new Set(pending.map((p) => p.ownerDiscordId)).size,
          seenAt: seenAt.toISOString(),
        },
      },
    }),
  ]);

  revalidatePath("/admin/profiles");
  revalidatePath("/dashboard/profiles");
  return { ok: true, applied: pending.length };
}

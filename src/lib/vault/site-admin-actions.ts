"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/db/client";
import { ALL_SITES } from "@/lib/auth/admin-scope";
import { requireAnyAdmin } from "@/lib/auth/guard";

/**
 * Vault actions a SITE admin may take, as well as a full one.
 *
 * Its own module so the guard is obvious at a glance, the same split admin-actions.ts and
 * actions.ts keep: every export here calls `requireAnyAdmin()` AND narrows what it touches
 * to the viewer's retailers. A Server Action is an individually-addressable POST endpoint,
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
 * A SITE ADMIN CONFIRMS THEIR OWN RETAILERS ONLY. Chess loads the Crunchyroll profiles into
 * his bot, so he is the one who can say a Crunchyroll edit is live -- and nobody else's. An
 * id from another retailer in the selection is simply not found, and so not confirmed,
 * rather than failing the rest: the count that comes back says what actually happened.
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
  const viewer = await requireAnyAdmin();

  const ids = [...new Set(form.getAll("changeId").map(String).filter(Boolean))];
  if (ids.length === 0) return { ok: false, error: "Nothing selected." };

  const pending = await prisma.vaultChange.findMany({
    // `appliedAt: null` as well as the ids: re-confirming an already-confirmed change would
    // otherwise overwrite who confirmed it and when, losing the original record.
    where: {
      id: { in: ids },
      appliedAt: null,
      ...(viewer.adminSites === ALL_SITES ? {} : { siteKey: { in: [...viewer.adminSites] } }),
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

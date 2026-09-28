"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/db/client";
import type { Prisma } from "@/generated/prisma/client";
import { getRunnerNames, isRunnerFor } from "@/db/queries/runners";
import { VaultAction, VaultEntity } from "@/generated/prisma/enums";
import { EVERYONE } from "@/lib/auth/admin-scope";
import { requireAdmin } from "@/lib/auth/guard";
import { isKnownSite, siteStyle, siteUsesProfiles } from "@/lib/sites";
import { recordBulkChange, type ChangeRecord } from "@/lib/vault/audit";

/**
 * Moving profiles between runners. FULL ADMINS ONLY: every export here calls
 * `requireAdmin()`, never `requireAnyAdmin()` -- deciding which runner reaches which
 * members' cards is exactly the power the full-admin allowlist exists to hold.
 *
 * A MOVE IS WORK ON TWO BOTS. The old runner has to take the profile off theirs and the new
 * one has to load it, and a profile left running on both is a member checking out twice. So
 * each moved row writes a pair of changes -- UNASSIGN into the old runner's queue, ASSIGN
 * into the new one's -- and they stay pending until each runner confirms their half. Both
 * rows share one timestamp, which is how the queue shows the whole move as one line with
 * one confirm.
 *
 * Edits the member made that are STILL waiting to reach a bot move with the profile: the new
 * runner loads its current details anyway, and the old one is taking it off, so the old
 * queue has nothing left to do with them.
 *
 * Moves are recorded in `admin_audit` as well, since `vault_changes` rows are a to-do list
 * that gets confirmed away and this is the permanent record of who reassigned what.
 */

export type AssignResult = { ok: true; moved: number } | { ok: false; error: string };

/** A bound on either selection, matching the roster's own export cap. */
const MAX_SELECTED = 500;

export async function assignProfiles(form: FormData): Promise<AssignResult> {
  const viewer = await requireAdmin();

  const siteKey = String(form.get("siteKey") ?? "");
  const to = String(form.get("assigneeId") ?? "");
  if (!isKnownSite(siteKey)) return { ok: false, error: "Unknown retailer." };
  if (!/^\d{15,25}$/.test(to)) return { ok: false, error: "Pick who to move them to." };

  // Two ways to say what moves, never both: explicit rows from the profile table, or whole
  // members from the roster -- narrowed to the runner the page was showing, so moving "these
  // members" from your own view moves your share of them and not another runner's.
  const accountIds = [...new Set(form.getAll("accountId").map(String).filter(Boolean))];
  const memberIds = [...new Set(form.getAll("memberId").map(String).filter(Boolean))];
  const from = String(form.get("from") ?? "");
  if (accountIds.length === 0 && memberIds.length === 0) {
    return { ok: false, error: "Nothing selected." };
  }
  if (accountIds.length > MAX_SELECTED || memberIds.length > MAX_SELECTED) {
    return { ok: false, error: `Too many at once (max ${MAX_SELECTED}).` };
  }

  // Checked here, not trusted from the picker: the list the page rendered can be stale by
  // the time someone clicks, and a profile handed to a non-runner is one nobody can see.
  const label = siteStyle(siteKey).label;
  if (!(await isRunnerFor(siteKey, to))) {
    return { ok: false, error: `They don't have the ${label} runner role.` };
  }

  const selection: Prisma.VaultAccountWhereInput =
    accountIds.length > 0
      ? { id: { in: accountIds } }
      : {
          discordUserId: { in: memberIds },
          ...(from && from !== EVERYONE ? { assigneeId: from } : {}),
        };

  const accounts = await prisma.vaultAccount.findMany({
    // Already with them is not a move: re-writing it would put a pair of no-op changes in
    // two queues for somebody to confirm.
    where: { AND: [{ siteKey }, selection, { assigneeId: { not: to } }] },
    select: {
      id: true,
      email: true,
      discordUserId: true,
      assigneeId: true,
      profile: { select: { id: true, name: true } },
    },
  });
  // Not an error: the selection was valid, it was just already where it was being sent.
  if (accounts.length === 0) return { ok: true, moved: 0 };

  const ids = accounts.map((account) => account.id);
  const profileIds = accounts.flatMap((account) => (account.profile ? [account.profile.id] : []));
  const previous = Object.fromEntries(
    [...Map.groupBy(accounts, (account) => account.assigneeId)].map(([id, list]) => [
      id,
      list.length,
    ]),
  );

  await prisma.$transaction([
    prisma.vaultAccount.updateMany({ where: { id: { in: ids } }, data: { assigneeId: to } }),
    // Waiting edits follow the profile -- see the note at the top.
    prisma.vaultChange.updateMany({
      where: {
        appliedAt: null,
        action: { notIn: [VaultAction.ASSIGN, VaultAction.UNASSIGN] },
        OR: [
          { entity: VaultEntity.VAULT_ACCOUNT, entityId: { in: ids } },
          { entity: VaultEntity.VAULT_PROFILE, entityId: { in: profileIds } },
        ],
      },
      data: { assigneeId: to },
    }),
    prisma.adminAudit.create({
      data: {
        actorDiscordId: viewer.discordUserId,
        action: "vault.assign",
        entity: "vault_account",
        entityId: ids.length === 1 ? ids[0] : null,
        before: { siteKey, assignees: previous },
        after: {
          siteKey,
          assigneeId: to,
          count: ids.length,
          members: new Set(accounts.map((account) => account.discordUserId)).size,
        },
      },
    }),
  ]);

  // The pair of changes per row. A profile is named by its profile row, which is what the
  // queue and the member's page already key on; a login-only retailer's login stands alone.
  const changes: ChangeRecord[] = [];
  const incoming: ChangeRecord[] = [];
  for (const account of accounts) {
    const subject = account.profile
      ? {
          entity: VaultEntity.VAULT_PROFILE,
          entityId: account.profile.id,
          label: account.profile.name,
        }
      : { entity: VaultEntity.VAULT_ACCOUNT, entityId: account.id, label: account.email };
    const base = {
      actorDiscordId: viewer.discordUserId,
      ownerDiscordId: account.discordUserId,
      siteKey,
      ...subject,
    };
    const arriving = { ...base, action: VaultAction.ASSIGN, assigneeId: to };
    changes.push(
      { ...base, action: VaultAction.UNASSIGN, assigneeId: account.assigneeId },
      arriving,
    );
    incoming.push(arriving);
  }

  const noun = siteUsesProfiles(siteKey) ? "profile" : "login";
  const toName = (await getRunnerNames([to]))[to];
  await recordBulkChange(
    changes,
    viewer.displayName,
    `moved ${ids.length} ${siteKey} ${noun}${ids.length === 1 ? "" : "s"} to ${toName}`,
    // Each name once, not once per half of the move.
    { listed: incoming, at: new Date() },
  );

  revalidatePath("/admin/profiles");
  return { ok: true, moved: ids.length };
}

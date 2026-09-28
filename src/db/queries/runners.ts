import "server-only";

import { prisma } from "@/db/client";
import { fullAdminIds, operatorId, runnerRoleFor } from "@/lib/auth/admin-scope";
import { payeeForSite } from "@/lib/billing/payees";
import { pickDefaultAssignee } from "@/lib/vault/assignment";

/**
 * Who runs what: the people a profile can be assigned to, and their names.
 *
 * A runner on a retailer is a full admin, or anyone holding that retailer's runner role
 * (see RUNNER_ROLES). Roles are read from `discord_members.roles`, which the bot keeps
 * current -- so this is also the list that stops including someone within seconds of the
 * role being taken away.
 *
 * No authorization here, same split as the other query modules: callers are the pages and
 * actions that have already passed a guard, and the write paths that assign a new row.
 */

export type Runner = {
  discordUserId: string;
  /** Their Discord display name, or the id when we have no row for them yet. */
  name: string;
  /** Full admins can hold anything; everyone else is here by a role. */
  fullAdmin: boolean;
};

const collator = new Intl.Collator("en", { sensitivity: "base" });

/**
 * Everyone who may be assigned profiles on this retailer, the operator first.
 *
 * Full admins are listed even with no member row, under their id: a full admin who has
 * never signed in can still be handed profiles, and leaving them out of the picker would
 * make that impossible to do by any means.
 */
export async function getRunnersForSite(siteKey: string): Promise<Runner[]> {
  const admins = fullAdminIds();
  const role = runnerRoleFor(siteKey);

  const rows = await prisma.discordMember.findMany({
    where: {
      OR: [
        { discordUserId: { in: admins } },
        ...(role ? [{ roles: { has: role }, leftAt: null }] : []),
      ],
    },
    select: { discordUserId: true, username: true, globalName: true },
  });
  const byId = new Map(rows.map((row) => [row.discordUserId, row]));
  const nameOf = (id: string) => byId.get(id)?.globalName ?? byId.get(id)?.username ?? id;

  const fullAdmins = admins.map((id) => ({ discordUserId: id, name: nameOf(id), fullAdmin: true }));
  const others = rows
    .filter((row) => !admins.includes(row.discordUserId))
    .map((row) => ({
      discordUserId: row.discordUserId,
      name: nameOf(row.discordUserId),
      fullAdmin: false,
    }))
    .sort((a, b) => collator.compare(a.name, b.name));

  return [...fullAdmins, ...others];
}

/** Whether this person may hold profiles on this retailer right now. */
export async function isRunnerFor(siteKey: string, discordUserId: string): Promise<boolean> {
  if (fullAdminIds().includes(discordUserId)) return true;
  const role = runnerRoleFor(siteKey);
  if (!role) return false;
  const row = await prisma.discordMember.findFirst({
    where: { discordUserId, roles: { has: role }, leftAt: null },
    select: { discordUserId: true },
  });
  return row !== null;
}

/**
 * Display names for a set of runner ids, falling back to the id.
 *
 * A plain object rather than a Map so it can cross into a client component as a prop.
 */
export async function getRunnerNames(ids: Iterable<string>): Promise<Record<string, string>> {
  const wanted = [...new Set(ids)];
  if (wanted.length === 0) return {};
  const rows = await prisma.discordMember.findMany({
    where: { discordUserId: { in: wanted } },
    select: { discordUserId: true, username: true, globalName: true },
  });
  const names: Record<string, string> = Object.fromEntries(wanted.map((id) => [id, id]));
  for (const row of rows) names[row.discordUserId] = row.globalName ?? row.username;
  return names;
}

/**
 * Everyone currently holding at least one profile or login, most first -- the "runner" tabs
 * on a full admin's profiles page.
 *
 * Read from the assignments rather than from who holds a role, for the reason the charges
 * page reads payees from the bills: a tab for someone holding nothing is noise, and one
 * missing for someone who IS holding profiles would hide them.
 */
export async function getAssigneesInUse(): Promise<{ discordUserId: string; count: number }[]> {
  const groups = await prisma.vaultAccount.groupBy({
    by: ["assigneeId"],
    _count: { _all: true },
    orderBy: { _count: { assigneeId: "desc" } },
  });
  return groups.map((group) => ({ discordUserId: group.assigneeId, count: group._count._all }));
}

/**
 * The runner a member's NEW row on this retailer is assigned to. See pickDefaultAssignee.
 *
 * Throws only when no full admin is configured and nothing else claims the row -- a
 * deployment with no ADMIN_DISCORD_IDS has nobody to hold anything, and saving a profile
 * that no bot will ever run is worse than refusing the save.
 */
export async function defaultAssignee(siteKey: string, memberId: string): Promise<string> {
  const [existing, runners] = await Promise.all([
    prisma.vaultAccount.findMany({
      where: { siteKey, discordUserId: memberId },
      select: { assigneeId: true },
    }),
    getRunnersForSite(siteKey),
  ]);

  const assignee = pickDefaultAssignee({
    existing: existing.map((row) => row.assigneeId),
    eligible: new Set(runners.map((runner) => runner.discordUserId)),
    sitePayee: payeeForSite(siteKey)?.id ?? null,
    operator: operatorId(),
  });
  if (!assignee) throw new Error("No runner to assign to: ADMIN_DISCORD_IDS is empty.");
  return assignee;
}

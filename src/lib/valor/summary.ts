import {
  ACO_BACKUP,
  ACO_MAIN,
  PKC_TASK_GROUPS,
  TARGET_ACCOUNT_GROUP,
  TARGET_PROFILE_GROUP,
  TARGET_PROXY_GROUP,
  TARGET_TASK_GROUP,
  VALOR_VERSION,
  groupKey,
  groupsNamed,
  type ValorBackup,
} from "@/lib/valor/format";
import { MISC_POSITION } from "@/lib/valor/split";

/**
 * What the operator sees on adding a Valor backup, before anything is built: every group in
 * it and whether the export works in it, and anything that would make the build refuse it.
 * No secret in it -- names and counts only.
 */

export type ValorGroupLine = {
  name: string;
  count: number;
  /** Rebuilt by the export, or never touched. */
  managed: boolean;
};

export type ValorSummary = {
  version: string;
  /** Another format than the export was built against: it still builds, with a warning. */
  otherVersion: boolean;
  profileGroups: ValorGroupLine[];
  taskGroups: ValorGroupLine[];
  loginGroups: ValorGroupLine[];
  mailboxes: number;
  /** What would make the build refuse this backup for this instance. */
  problems: string[];
};

export function summarizeValorBackup(backup: ValorBackup, position: number): ValorSummary {
  const misc = position === MISC_POSITION;
  const problems: string[] = [];
  const need = <T extends { name: string }>(
    groups: Record<string, T>,
    name: string,
    what: string,
  ) => {
    const found = groupsNamed(groups, name);
    if (found.length === 0) problems.push(`no ${what} named "${name}"`);
    if (found.length > 1) problems.push(`${found.length} ${what}s named "${name}"`);
    return found[0];
  };

  const profileNames = [ACO_MAIN, ACO_BACKUP, ...(misc ? [TARGET_PROFILE_GROUP] : [])];
  const taskNames: string[] = [
    ...PKC_TASK_GROUPS.map((g) => g.name),
    ...(misc ? [TARGET_TASK_GROUP] : []),
  ];
  for (const name of profileNames) need(backup.profiles.groups, name, "profile group");
  for (const { name } of PKC_TASK_GROUPS) {
    const group = need(backup.tasks.groups, name, "task group");
    if (group && group.siteModule !== "PokemonCenter")
      problems.push(`"${group.name}" isn't a Pokémon Center task group`);
  }
  if (misc) {
    const tasks = need(backup.tasks.groups, TARGET_TASK_GROUP, "task group");
    if (tasks && tasks.siteModule !== "Target")
      problems.push(`"${tasks.name}" isn't a Target task group`);
    need(backup.accounts.groups, TARGET_ACCOUNT_GROUP, "login group");
    need(backup.proxies.groups, TARGET_PROXY_GROUP, "proxy group");
  }

  const ours = (names: string[]) => new Set(names.map(groupKey));
  const lines = <T extends { id: string; name: string }>(
    groups: Record<string, T>,
    count: (id: string) => number,
    managed: Set<string>,
  ): ValorGroupLine[] =>
    Object.values(groups).map((g) => ({
      name: g.name,
      count: count(g.id),
      managed: managed.has(groupKey(g.name)),
    }));

  return {
    version: String(backup.version),
    otherVersion: backup.version !== VALOR_VERSION,
    profileGroups: lines(
      backup.profiles.groups,
      (id) => Object.keys(backup.profiles.lists[id] ?? {}).length,
      ours(profileNames),
    ),
    taskGroups: lines(
      backup.tasks.groups,
      (id) =>
        Object.values(backup.tasks.lists[id] ?? {}).reduce(
          (n, list) => n + Object.keys(list).length,
          0,
        ),
      ours(taskNames),
    ),
    loginGroups: lines(
      backup.accounts.groups,
      (id) => Object.keys(backup.accounts.lists[id] ?? {}).length,
      ours(misc ? [TARGET_ACCOUNT_GROUP] : []),
    ),
    mailboxes: Object.keys(backup.imap).length,
    problems,
  };
}

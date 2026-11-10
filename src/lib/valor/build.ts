import { runnableQty } from "@/lib/products/qty";
import {
  ACO_BACKUP,
  ACO_MAIN,
  DEFAULT_CATEGORY,
  PKC_TASK_GROUPS,
  TARGET_ACCOUNT_GROUP,
  TARGET_PROFILE_GROUP,
  TARGET_PROXY_GROUP,
  TARGET_TASK_GROUP,
  VALOR_VERSION,
  groupsNamed,
  newValorProfile,
  updateValorProfile,
  type ValorAccount,
  type ValorBackup,
  type ValorGroup,
  type ValorImap,
  type ValorProduct,
  type ValorProfile,
  type ValorTask,
  type ValorTaskGroup,
} from "@/lib/valor/format";
import type {
  DesiredMiscProfile,
  DesiredValorInstance,
  DesiredValorProfile,
  KnownValorProfile,
  MiscTaskLine,
  TaskGroupReport,
  ValorBuildOptions,
  ValorMailbox,
  ValorReport,
} from "@/lib/valor/types";

/**
 * Rewrites one Valor instance's backup from the vault, on a copy, CLEAN and IN PLACE -- the
 * Shikari export's rules (lib/shikari/build.ts), on Valor's file.
 *
 * POKÉMON CENTER, on both instances. "ACO Main" comes out holding exactly this instance's
 * main-bot profiles and "ACO Backup" its backup-bot ones, and each of the three task groups
 * (PKC_TASK_GROUPS) one task per profile of its group: the main-bot profiles' in "PKC ACO -
 * ISP" and "PKC ACO - Resi", the backup-bot ones' in "PKC ACO (backup) - Resi". A profile
 * already there keeps its id -- every task holding it points at that -- and its task stays
 * exactly as it is, product and settings and all; a new task copies the group's own (its
 * proxies, its product, its settings). Profiles the vault doesn't put here come out, with
 * their tasks, and the review says why.
 *
 * THE MISCELLANEOUS LINE, on the second instance only (`misc` in the request): "Target" holds
 * the profiles that picked from it and nothing else, "Target"'s logins only theirs, and the
 * IMAP list only the mailboxes their codes arrive at. Each profile's picks go in one task, as
 * Valor takes several -- "12345, 67890" -- with a task per qty when its picks' qtys differ,
 * since a task buys every product it holds at one qty. Every task checks out and monitors on
 * "Target ISP". A profile with no Target password on file and no login in Valor is left
 * out, and named.
 *
 * NEVER TOUCHED: every other group -- the operator's own "PKC Personal", Walmart, Best Buy,
 * Shopify -- the proxies, settings, harvesters and captcha keys, and on the first instance
 * the logins and IMAP list too. That is checked, not assumed: the build fails rather than
 * hand back a file in which any of it moved.
 */

export class ValorBuildError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValorBuildError";
  }
}

export type ValorBuild = { backup: ValorBackup; report: ValorReport };

export function buildValorInstance(
  source: ValorBackup,
  desired: DesiredValorInstance,
  options: ValorBuildOptions,
): ValorBuild {
  const backup = structuredClone(source);
  const report = new ValorBuilder(source, backup, desired, options).run();
  return { backup, report };
}

const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });
const lower = (value: string | null | undefined) =>
  String(value ?? "")
    .trim()
    .toLowerCase();
const byName = <T extends { name: string }>(a: T, b: T) => collator.compare(a.name, b.name);

/** A task as Valor leaves it when it isn't running: what every task the export writes is set to. */
function idle(task: ValorTask) {
  task.selected = false;
  task.running = false;
  task.status = "Idle";
  task.color = "neutral";
  task.carted = false;
  task.successful = false;
  task.failed = false;
  task.currentProxy = null;
  if ("queueTime" in task) task.queueTime = -1;
  if ("passedQueue" in task) task.passedQueue = false;
}

/**
 * A Target task with nothing to copy, in the shape of the operator's own example tasks
 * (2026-11-10): settings as Valor's task editor leaves them, checkout and monitor on one proxy
 * group, one product entry. Only used when "Target" holds no task to copy from.
 */
function builtInTargetTask(): ValorTask {
  return {
    id: "",
    selected: false,
    running: false,
    status: "Idle",
    color: "neutral",
    queueTime: -1,
    carted: false,
    successful: false,
    failed: false,
    passedQueue: false,
    currentProxy: null,
    type: null,
    mode: "Default",
    proxyGroupID: null,
    queueProxyGroupID: null,
    monitorProxyGroupID: null,
    profile: null,
    profileGroupID: null,
    accountGroupID: null,
    account: null,
    products: [
      {
        sizeRange: [],
        displayedItem: "",
        displayedSize: "",
        monitorInput: "",
        color: "",
        minSizesLoaded: 0,
        minPrice: 0,
        maxPrice: null,
        productQuantity: 1,
        skipIfOOS: false,
      },
    ],
    monitorDelay: 3500,
    retryDelay: 3500,
    config: {
      appMode: false,
      resetAfter: 5,
      waitForDiscountCode: false,
      discountCode: null,
      browser: null,
      maxPickupRadius: 50,
      pickupStoreList: null,
      maxQueueTime: 90,
      reEnterOnFail: false,
      clearAccountInfo: false,
      startOnQueue: false,
      loopCheckout: false,
      disable3DSBypass: false,
      doubleRaffleEntry: false,
      startOnRestock: false,
      autoSwitchMode: false,
      hideCodeWindow: false,
      usePickupPerson: false,
      useRewardCertificate: false,
      preLogin: false,
      requestHCaptcha: false,
      useCircleBalance: false,
      otpLogin: false,
      highStockPreordersOnly: false,
      shippingMethodName: null,
      queueEntryDelay: null,
      extraProduct: null,
    },
    isAutomationTask: false,
    startScheduleTime: null,
    stopScheduleTime: null,
  };
}

/**
 * The settings a group's tasks share -- everything but the task's own id, profile, login,
 * what it watches and its run state -- as one string, to find the shape most of them have.
 */
function settingsOf(task: ValorTask): string {
  const rest: Record<string, unknown> = { ...task };
  for (const key of [
    "id",
    "selected",
    "running",
    "status",
    "color",
    "queueTime",
    "carted",
    "successful",
    "failed",
    "passedQueue",
    "currentProxy",
    "profile",
    "account",
  ])
    delete rest[key];
  rest.products = task.products.map((p) => ({
    ...p,
    displayedItem: undefined,
    monitorInput: undefined,
    productQuantity: undefined,
  }));
  return JSON.stringify(rest);
}

/** The task most of `tasks` look like, first-seen winning a tie; null when there are none. */
function commonest(tasks: ValorTask[]): ValorTask | null {
  const counts = new Map<string, { task: ValorTask; n: number }>();
  let best: { task: ValorTask; n: number } | null = null;
  for (const task of tasks) {
    const key = settingsOf(task);
    const entry = counts.get(key) ?? { task, n: 0 };
    entry.n += 1;
    counts.set(key, entry);
    if (!best || entry.n > best.n) best = entry;
  }
  return best?.task ?? null;
}

/** A Target task's products as the review shows them. */
function lineOf(task: ValorTask): MiscTaskLine[] {
  return task.products.map((p) => ({
    skus: String(p.monitorInput ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    qty: Number(p.productQuantity),
  }));
}

/**
 * A profile's picks as tasks: one per qty, each with every TCIN at that qty, in the order its
 * first product comes in the catalog. Most profiles' picks share a qty, so most get one task.
 */
export function tasksFor(products: { sku: string; qty: number }[]): MiscTaskLine[] {
  const byQty = new Map<number, string[]>();
  for (const { sku, qty } of products) {
    const n = runnableQty(qty);
    byQty.set(n, [...(byQty.get(n) ?? []), sku]);
  }
  return [...byQty].map(([qty, skus]) => ({ skus, qty }));
}

class ValorBuilder {
  private readonly report: ValorReport;
  private readonly known: Record<
    "pkc" | "target",
    { byEmail: Map<string, KnownValorProfile>; byName: Map<string, KnownValorProfile> }
  >;
  /** Every part of the file the export may not change, as it was: compared again at the end. */
  private readonly untouched: string;
  /** Profile, task and login groups this build rewrites, by id: everything else must not move. */
  private readonly managed = {
    profiles: new Set<string>(),
    tasks: new Set<string>(),
    accounts: new Set<string>(),
  };

  constructor(
    private readonly source: ValorBackup,
    private readonly b: ValorBackup,
    private readonly desired: DesiredValorInstance,
    private readonly options: ValorBuildOptions,
  ) {
    const index = (site: "pkc" | "target") => {
      const mine = desired.known.filter((k) => k.site === site);
      return {
        byEmail: new Map(mine.map((k) => [lower(k.email), k])),
        byName: new Map(mine.map((k) => [lower(k.name), k])),
      };
    };
    this.known = { pkc: index("pkc"), target: index("target") };
    this.report = {
      version: String(b.version),
      pkc: {
        profiles: { added: [], updated: [], moved: [], removed: [], unchanged: 0 },
        main: 0,
        backup: 0,
        taskGroups: [],
      },
      misc: null,
      warnings: [],
    };
    // Settled before anything is touched, so the check at the end compares against the file
    // as it came in: which groups are this build's depends only on their names.
    this.claimGroups();
    this.untouched = this.untouchedParts(source);
  }

  run(): ValorReport {
    if (this.b.version !== VALOR_VERSION) {
      this.report.warnings.push(
        `This backup is Valor format ${this.b.version}; the export was built against ${VALOR_VERSION}. ` +
          "Load the new file into a spare Valor first.",
      );
    }
    this.syncPkc();
    if (this.desired.misc) this.syncMisc(this.desired.misc);
    this.checkIntegrity();
    return this.report;
  }

  // -------------------------------------------------------------------------
  // Groups
  // -------------------------------------------------------------------------

  /** The one group by that name, or a refusal saying what's wrong with the backup. */
  private one<T extends { name: string }>(
    groups: Record<string, T>,
    name: string,
    what: string,
  ): T {
    const found = groupsNamed(groups, name);
    if (found.length === 1) return found[0];
    throw new ValorBuildError(
      found.length === 0
        ? `This backup has no ${what} named "${name}", so the export can't tell where its profiles go. Nothing was changed.`
        : `This backup has ${found.length} ${what}s named "${name}". Rename all but one in Valor, then export again.`,
    );
  }

  private claimGroups() {
    const { b } = this;
    for (const name of [ACO_MAIN, ACO_BACKUP])
      this.managed.profiles.add(this.one(b.profiles.groups, name, "profile group").id);
    for (const { name } of PKC_TASK_GROUPS) {
      const group = this.one(b.tasks.groups, name, "task group");
      if (group.siteModule !== "PokemonCenter") {
        throw new ValorBuildError(
          `Task group "${group.name}" runs Valor's ${group.siteModule} module, not Pokémon Center's. Nothing was changed.`,
        );
      }
      this.managed.tasks.add(group.id);
    }
    if (!this.desired.misc) return;
    this.managed.profiles.add(
      this.one(b.profiles.groups, TARGET_PROFILE_GROUP, "profile group").id,
    );
    this.managed.accounts.add(this.one(b.accounts.groups, TARGET_ACCOUNT_GROUP, "login group").id);
    const tasks = this.one(b.tasks.groups, TARGET_TASK_GROUP, "task group");
    if (tasks.siteModule !== "Target") {
      throw new ValorBuildError(
        `Task group "${tasks.name}" runs Valor's ${tasks.siteModule} module, not Target's. Nothing was changed.`,
      );
    }
    this.managed.tasks.add(tasks.id);
    this.one(b.proxies.groups, TARGET_PROXY_GROUP, "proxy group");
  }

  /**
   * Every part of `file` the build may not change, as one string: the sections it never
   * reads, every group it doesn't rewrite, and -- on an instance without the Miscellaneous
   * line -- every login and mailbox.
   */
  private untouchedParts(file: ValorBackup): string {
    const outside = <T>(groups: Record<string, T>, mine: Set<string>) =>
      Object.entries(groups).filter(([id]) => !mine.has(id));
    const parts: unknown[] = [];
    for (const [key, value] of Object.entries(file)) {
      if (["tasks", "profiles", "accounts", "imap"].includes(key)) continue;
      parts.push([key, value]);
    }
    parts.push(outside(file.profiles.groups, this.managed.profiles));
    parts.push(outside(file.profiles.lists, this.managed.profiles));
    parts.push(outside(file.tasks.groups, this.managed.tasks));
    parts.push(outside(file.tasks.lists, this.managed.tasks));
    // A rewritten task group's own settings stay: only its counts move.
    parts.push(
      Object.entries(file.tasks.groups)
        .filter(([id]) => this.managed.tasks.has(id))
        .map(([id, g]) => [id, { ...g, totalAmount: undefined, taskCounts: undefined }]),
    );
    parts.push(outside(file.accounts.groups, this.managed.accounts));
    parts.push(outside(file.accounts.lists, this.managed.accounts));
    if (!this.desired.misc) parts.push(file.imap);
    return JSON.stringify(parts);
  }

  /** Why a profile in the backup isn't one this instance runs, in the review's words. */
  private whyNotHere(site: "pkc" | "target", profile: ValorProfile): string {
    const index = this.known[site];
    const known = index.byEmail.get(lower(profile.email)) ?? index.byName.get(lower(profile.name));
    if (!known) return "not on the site";
    return known.why ?? "a second copy";
  }

  /** Puts `profiles` in a group's list, in that order, and its count to match. */
  private fillGroup(group: ValorGroup, profiles: ValorProfile[]) {
    this.b.profiles.lists[group.id] = Object.fromEntries(profiles.map((p) => [p.id, p]));
    group.totalAmount = profiles.length;
  }

  /** Puts `tasks` in a task group's default list, and its counts to match. */
  private fillTasks(group: ValorTaskGroup, tasks: ValorTask[]) {
    const lists = (this.b.tasks.lists[group.id] ??= {});
    lists[DEFAULT_CATEGORY] = Object.fromEntries(tasks.map((t) => [t.id, t]));
    const counts: Record<string, number> = { ...(group.taskCounts ?? {}) };
    for (const [category, list] of Object.entries(lists))
      counts[category] = Object.keys(list).length;
    group.taskCounts = counts;
    group.totalAmount = Object.values(counts).reduce((sum, n) => sum + n, 0);
  }

  /** A new task in `template`'s shape -- its key order, settings and product -- not running. */
  private newTask(template: ValorTask): ValorTask {
    const task = structuredClone(template);
    task.id = this.options.uuid();
    idle(task);
    return task;
  }

  // -------------------------------------------------------------------------
  // Pokémon Center
  // -------------------------------------------------------------------------

  /**
   * Matches each vault profile to the Valor profile it already is, in either ACO group: by
   * EMAIL first (one per profile in the vault), then by NAME, which catches a changed email.
   * Of two claiming one vault profile, the one already in the right group wins, then the
   * one first in the file.
   */
  private syncPkc() {
    const { b } = this;
    const main = this.one(b.profiles.groups, ACO_MAIN, "profile group");
    const backup = this.one(b.profiles.groups, ACO_BACKUP, "profile group");
    const groupName = new Map([
      [main.id, main.name],
      [backup.id, backup.name],
    ]);
    const pool = [main, backup].flatMap((group) =>
      Object.values(b.profiles.lists[group.id] ?? {}).map((profile) => ({
        profile,
        groupId: group.id,
      })),
    );
    type Entry = (typeof pool)[number];
    const byEmail = new Map<string, Entry[]>();
    const byNameMap = new Map<string, Entry[]>();
    for (const entry of pool) {
      byEmail.set(lower(entry.profile.email), [
        ...(byEmail.get(lower(entry.profile.email)) ?? []),
        entry,
      ]);
      byNameMap.set(lower(entry.profile.name), [
        ...(byNameMap.get(lower(entry.profile.name)) ?? []),
        entry,
      ]);
    }
    const claimed = new Set<string>();
    const pick = (list: Entry[] | undefined, groupId: string) =>
      (list ?? [])
        .filter((e) => !claimed.has(e.profile.id))
        .sort((x, y) => Number(x.groupId !== groupId) - Number(y.groupId !== groupId))[0];

    // Every email match before any name match, so a name can't take a profile another vault
    // profile's email would have claimed.
    const wanted = [
      ...[...this.desired.main].sort(byName).map((d) => ({ d, group: main })),
      ...[...this.desired.backup].sort(byName).map((d) => ({ d, group: backup })),
    ];
    const matchOf = new Map<DesiredValorProfile, Entry>();
    for (const byKey of [
      (d: DesiredValorProfile) => byEmail.get(lower(d.email)),
      (d: DesiredValorProfile) => byNameMap.get(lower(d.name)),
    ]) {
      for (const { d, group } of wanted) {
        if (matchOf.has(d)) continue;
        const entry = pick(byKey(d), group.id);
        if (!entry) continue;
        claimed.add(entry.profile.id);
        matchOf.set(d, entry);
      }
    }

    const report = this.report.pkc.profiles;
    const place = (group: ValorGroup): ValorProfile[] =>
      wanted
        .filter((w) => w.group === group)
        .map(({ d }) => {
          const line = { name: d.name, owner: d.ownerName };
          const entry = matchOf.get(d);
          if (!entry) {
            report.added.push(line);
            return newValorProfile(d, this.options.uuid());
          }
          const fields = updateValorProfile(entry.profile, d);
          if (fields.length > 0) report.updated.push({ ...line, fields });
          if (entry.groupId !== group.id)
            report.moved.push({ ...line, why: `from "${groupName.get(entry.groupId)}"` });
          if (fields.length === 0 && entry.groupId === group.id) report.unchanged += 1;
          return entry.profile;
        });
    const placed = { main: place(main), backup: place(backup) };

    for (const { profile } of pool) {
      if (claimed.has(profile.id)) continue;
      report.removed.push({ name: profile.name, why: this.whyNotHere("pkc", profile) });
    }
    this.fillGroup(main, placed.main);
    this.fillGroup(backup, placed.backup);
    this.report.pkc.main = placed.main.length;
    this.report.pkc.backup = placed.backup.length;

    // Most of what's here belonging to the other instance is the backup for that instance.
    const elsewhere = report.removed.filter((l) => l.why?.startsWith("runs on Instance")).length;
    if (pool.length > 0 && elsewhere > pool.length / 2) {
      this.report.warnings.push(
        `${elsewhere} of this backup's ${pool.length} Pokémon Center profiles run on another instance — ` +
          `check this is Instance ${this.desired.position}'s backup before loading it.`,
      );
    }

    const aco = new Set([main.id, backup.id]);
    for (const { name, profiles } of PKC_TASK_GROUPS) {
      const group = this.one(b.tasks.groups, name, "task group");
      const home = profiles === "main" ? main : backup;
      this.report.pkc.taskGroups.push(
        this.syncPkcTasks(group, home, profiles === "main" ? placed.main : placed.backup, aco),
      );
    }
  }

  /**
   * One task per profile of `home` in `group`: each keeps the one it has, and one without
   * gets a copy of the group's own. A task for a profile in another group -- not an ACO one
   * -- is left where it is, after the group's own.
   */
  private syncPkcTasks(
    group: ValorTaskGroup,
    home: ValorGroup,
    profiles: ValorProfile[],
    aco: Set<string>,
  ): TaskGroupReport {
    const lists = this.b.tasks.lists[group.id] ?? {};
    const all = Object.values(lists[DEFAULT_CATEGORY] ?? {});
    const ours = all.filter((t) => t.profileGroupID !== null && aco.has(t.profileGroupID));
    const theirs = all.filter((t) => !ours.includes(t));
    const template = commonest(ours);
    const report: TaskGroupReport = {
      name: group.name,
      added: [],
      removed: [],
      kept: 0,
      renamed: 0,
      untouched: theirs.length,
      after: 0,
    };

    const byProfile = new Map<string, ValorTask[]>();
    for (const task of ours) {
      if (task.profileGroupID !== home.id || !task.profile) continue;
      byProfile.set(task.profile.id, [...(byProfile.get(task.profile.id) ?? []), task]);
    }
    const kept = new Set<string>();
    const next: ValorTask[] = [];
    for (const profile of profiles) {
      const task = byProfile.get(profile.id)?.[0];
      if (task?.profile) {
        kept.add(task.id);
        if (task.profile.name !== profile.name) {
          task.profile.name = profile.name;
          report.renamed += 1;
        }
        report.kept += 1;
        next.push(task);
        continue;
      }
      if (!template) {
        throw new ValorBuildError(
          `Task group "${group.name}" has no task to copy its settings from. Add one task to it in Valor, then export again.`,
        );
      }
      const fresh = this.newTask(template);
      fresh.profile = { name: profile.name, id: profile.id };
      fresh.profileGroupID = home.id;
      next.push(fresh);
      report.added.push(profile.name);
    }
    const placed = new Set(profiles.map((p) => p.id));
    for (const task of ours) {
      if (kept.has(task.id)) continue;
      const name = task.profile?.name ?? `task ${task.id}`;
      report.removed.push(
        task.profile && placed.has(task.profile.id) && task.profileGroupID === home.id
          ? `${name} (a second copy)`
          : name,
      );
    }
    this.fillTasks(group, [...next, ...theirs]);
    report.after = next.length + theirs.length;
    return report;
  }

  // -------------------------------------------------------------------------
  // The Miscellaneous line, on Target
  // -------------------------------------------------------------------------

  private syncMisc(misc: DesiredMiscProfile[]) {
    const { b } = this;
    const profileGroup = this.one(b.profiles.groups, TARGET_PROFILE_GROUP, "profile group");
    const accountGroup = this.one(b.accounts.groups, TARGET_ACCOUNT_GROUP, "login group");
    const taskGroup = this.one(b.tasks.groups, TARGET_TASK_GROUP, "task group");
    const proxyGroup = this.one(b.proxies.groups, TARGET_PROXY_GROUP, "proxy group");
    if ((b.proxies.lists[proxyGroup.id] ?? []).length === 0) {
      this.report.warnings.push(
        `Proxy group "${proxyGroup.name}" has no proxies, so the Target tasks have none to run on.`,
      );
    }
    const report: NonNullable<ValorReport["misc"]> = {
      profiles: { added: [], updated: [], removed: [], unchanged: 0 },
      skipped: [],
      accounts: { added: [], updated: [], removed: 0, unchanged: 0 },
      imap: { added: [], updated: [], removed: 0, unchanged: 0, missing: [] },
      tasks: { changed: [], unchanged: 0, untouched: 0, after: 0 },
    };
    this.report.misc = report;

    // Each member's profiles together, members by their first profile's name.
    const members = new Map<string, DesiredMiscProfile[]>();
    for (const d of [...misc].sort(byName))
      members.set(d.ownerId, [...(members.get(d.ownerId) ?? []), d]);
    const people = [...members.values()].flat().filter((d) => d.products.length > 0);

    // --- logins: who can run at all ---
    const accountList = Object.values(b.accounts.lists[accountGroup.id] ?? {});
    const accountFor = new Map<string, ValorAccount>();
    for (const account of accountList) {
      const key = lower(account.email);
      const held = accountFor.get(key);
      // Of two for one email, the one signed in.
      if (!held || (!held.session && account.session)) accountFor.set(key, account);
    }
    const running = people.filter((d) => {
      if (accountFor.has(lower(d.email)) || d.password !== null) return true;
      report.skipped.push({ name: d.name, owner: d.ownerName, why: "no Target password on file" });
      return false;
    });
    if (report.skipped.length > 0) {
      const names = report.skipped.map((l) => l.name);
      this.report.warnings.push(
        `No Target password on file for ${names.slice(0, 5).join(", ")}${names.length > 5 ? ` and ${names.length - 5} more` : ""}, ` +
          "so they get no Target task. Add the password on the site and export again.",
      );
    }

    const accounts: ValorAccount[] = [];
    const loginOf = new Map<string, ValorAccount>();
    for (const d of running) {
      const existing = accountFor.get(lower(d.email));
      if (existing) {
        if (d.password !== null && existing.password !== d.password) {
          // The password and nothing else: a signed-in session is the login's whole value.
          existing.password = d.password;
          report.accounts.updated.push(existing.email);
        } else {
          report.accounts.unchanged += 1;
        }
        accounts.push(existing);
        loginOf.set(d.key, existing);
        continue;
      }
      const account: ValorAccount = {
        id: this.options.uuid(),
        email: d.email,
        password: d.password as string,
        proxy: null,
        session: false,
        selected: false,
      };
      accounts.push(account);
      loginOf.set(d.key, account);
      report.accounts.added.push(d.email);
    }
    const keptLogins = new Set(accounts.map((a) => a.id));
    report.accounts.removed = accountList.filter((a) => !keptLogins.has(a.id)).length;
    b.accounts.lists[accountGroup.id] = Object.fromEntries(accounts.map((a) => [a.id, a]));
    accountGroup.totalAmount = accounts.length;

    // --- profiles ---
    const pool = Object.values(b.profiles.lists[profileGroup.id] ?? {});
    const byEmail = new Map<string, ValorProfile[]>();
    const byNameMap = new Map<string, ValorProfile[]>();
    for (const p of pool) {
      byEmail.set(lower(p.email), [...(byEmail.get(lower(p.email)) ?? []), p]);
      byNameMap.set(lower(p.name), [...(byNameMap.get(lower(p.name)) ?? []), p]);
    }
    const claimed = new Set<string>();
    const pick = (list: ValorProfile[] | undefined) => (list ?? []).find((p) => !claimed.has(p.id));
    // Every email match before any name match, as on Pokémon Center.
    const matchOf = new Map<string, ValorProfile>();
    for (const byKey of [
      (d: DesiredMiscProfile) => byEmail.get(lower(d.email)),
      (d: DesiredMiscProfile) => byNameMap.get(lower(d.name)),
    ]) {
      for (const d of running) {
        if (matchOf.has(d.key)) continue;
        const found = pick(byKey(d));
        if (!found) continue;
        claimed.add(found.id);
        matchOf.set(d.key, found);
      }
    }
    const profileOf = new Map<string, ValorProfile>();
    for (const d of running) {
      const line = { name: d.name, owner: d.ownerName };
      const existing = matchOf.get(d.key);
      if (!existing) {
        const profile = newValorProfile(d, this.options.uuid());
        profileOf.set(d.key, profile);
        report.profiles.added.push(line);
        continue;
      }
      const fields = updateValorProfile(existing, d);
      if (fields.length > 0) report.profiles.updated.push({ ...line, fields });
      else report.profiles.unchanged += 1;
      profileOf.set(d.key, existing);
    }
    const skipped = new Set(
      people.filter((d) => !running.includes(d)).flatMap((d) => [lower(d.email), lower(d.name)]),
    );
    for (const p of pool) {
      if (claimed.has(p.id)) continue;
      report.profiles.removed.push({
        name: p.name,
        why:
          skipped.has(lower(p.email)) || skipped.has(lower(p.name))
            ? "no Target password on file"
            : this.whyNotHere("target", p),
      });
    }
    this.fillGroup(
      profileGroup,
      running.map((d) => profileOf.get(d.key) as ValorProfile).sort(byName),
    );

    // --- mailboxes ---
    this.syncImap(running, report);

    // --- tasks ---
    const lists = b.tasks.lists[taskGroup.id] ?? {};
    const all = Object.values(lists[DEFAULT_CATEGORY] ?? {});
    const ours = all.filter((t) => t.profileGroupID === profileGroup.id);
    const theirs = all.filter((t) => t.profileGroupID !== profileGroup.id);
    report.tasks.untouched = theirs.length;
    const template = commonest(ours) ?? builtInTargetTask();
    const product: ValorProduct = structuredClone(
      template.products[0] ?? builtInTargetTask().products[0],
    );
    const tasksOf = new Map<string, ValorTask[]>();
    for (const task of ours) {
      if (!task.profile) continue;
      tasksOf.set(task.profile.id, [...(tasksOf.get(task.profile.id) ?? []), task]);
    }

    const next: ValorTask[] = [];
    const reused = new Set<string>();
    for (const d of running) {
      const profile = profileOf.get(d.key) as ValorProfile;
      const login = loginOf.get(d.key) as ValorAccount;
      const before = (tasksOf.get(profile.id) ?? []).flatMap(lineOf);
      const after = tasksFor(d.products);
      const spare = [...(tasksOf.get(profile.id) ?? [])];
      for (const { skus, qty } of after) {
        const task = spare.shift() ?? this.newTask(template);
        reused.add(task.id);
        idle(task);
        task.proxyGroupID = proxyGroup.id;
        task.monitorProxyGroupID = proxyGroup.id;
        task.profile = { name: profile.name, id: profile.id };
        task.profileGroupID = profileGroup.id;
        task.accountGroupID = accountGroup.id;
        task.account = { name: login.email, id: login.id };
        const input = skus.join(", ");
        // Its own product's settings -- price limits, out-of-stock rule -- or the template's.
        const base: ValorProduct = structuredClone(task.products[0] ?? product);
        task.products = [
          { ...base, displayedItem: input, monitorInput: input, productQuantity: qty },
        ];
        next.push(task);
      }
      if (JSON.stringify(before) === JSON.stringify(after)) report.tasks.unchanged += 1;
      else report.tasks.changed.push({ profile: d.name, before, after });
    }
    for (const task of ours) {
      if (reused.has(task.id) || !task.profile) continue;
      // A profile that came out, or picked nothing now: its tasks go with it.
      if (!running.some((d) => profileOf.get(d.key)?.id === task.profile?.id)) {
        const line = report.tasks.changed.find((c) => c.profile === task.profile?.name);
        if (line) line.before.push(...lineOf(task));
        else
          report.tasks.changed.push({
            profile: task.profile.name,
            before: lineOf(task),
            after: [],
          });
      }
    }
    this.fillTasks(taskGroup, [...next, ...theirs]);
    report.tasks.after = next.length;
  }

  /**
   * The IMAP list, cut to the mailboxes these profiles' codes arrive at: the one the site
   * says, with its app password; or, where the site doesn't know, the profile's own inbox if
   * Valor already reads it. Every other mailbox comes out -- the first instance's list is never
   * touched, since it has no Target side to read for.
   */
  private syncImap(running: DesiredMiscProfile[], report: NonNullable<ValorReport["misc"]>) {
    const { b } = this;
    const entries = Object.values(b.imap);
    const byEmail = new Map<string, ValorImap>();
    for (const entry of entries) {
      const key = lower(entry.email);
      const held = byEmail.get(key);
      if (!held || (!held.connected && entry.connected)) byEmail.set(key, entry);
    }
    const needed = new Map<string, ValorMailbox | null>();
    for (const d of running) {
      if (d.mailbox) {
        if (!needed.get(lower(d.mailbox.email))) needed.set(lower(d.mailbox.email), d.mailbox);
      } else if (byEmail.has(lower(d.email)) && !needed.has(lower(d.email))) {
        needed.set(lower(d.email), null);
      } else if (!byEmail.has(lower(d.email))) {
        report.imap.missing.push(`${d.email} (${d.name})`);
      }
    }

    const keep = new Set<string>();
    const added: ValorImap[] = [];
    for (const [email, box] of needed) {
      const existing = byEmail.get(email);
      if (existing) {
        keep.add(existing.id);
        const changed =
          box !== null &&
          (existing.password !== box.password || lower(existing.server) !== lower(box.server));
        if (changed || !existing.enabled) {
          if (box) {
            existing.password = box.password;
            existing.server = box.server;
          }
          existing.enabled = true;
          report.imap.updated.push(existing.email);
        } else {
          report.imap.unchanged += 1;
        }
        continue;
      }
      if (!box) continue;
      added.push({
        id: this.options.uuid(),
        server: box.server,
        email: box.email,
        password: box.password,
        readEmails: 0,
        codesReceived: 0,
        connected: false,
        enabled: true,
        selected: false,
        status: "Idle",
      });
      report.imap.added.push(box.email);
    }
    report.imap.removed = entries.filter((e) => !keep.has(e.id)).length;
    b.imap = Object.fromEntries(
      [...entries.filter((e) => keep.has(e.id)), ...added].map((e) => [e.id, e]),
    );
    if (report.imap.missing.length > 0) {
      const list = report.imap.missing;
      this.report.warnings.push(
        `No mailbox on file for ${list.slice(0, 5).join(", ")}${list.length > 5 ? ` and ${list.length - 5} more` : ""}: ` +
          "Valor can't read their sign-in codes until one is added.",
      );
    }
  }

  // -------------------------------------------------------------------------
  // The last line of defence
  // -------------------------------------------------------------------------

  /**
   * Nothing the export doesn't own moved; every id is unique and keyed by itself; every count
   * matches its list; and no task points at a profile or login that isn't there, unless it
   * already did before. Any of these failing throws: the file is not offered at all.
   */
  private checkIntegrity() {
    const fail = (what: string) => {
      throw new ValorBuildError(
        `The rebuilt backup failed a check (${what}). Nothing was exported.`,
      );
    };
    if (this.untouchedParts(this.b) !== this.untouched)
      fail("something outside the export's groups changed");

    const seen = {
      profiles: new Set<string>(),
      tasks: new Set<string>(),
      accounts: new Set<string>(),
    };
    for (const [groupId, list] of Object.entries(this.b.profiles.lists)) {
      for (const [id, profile] of Object.entries(list)) {
        if (profile.id !== id || seen.profiles.has(id))
          fail(`profile ${id} is listed twice or under another id`);
        seen.profiles.add(id);
      }
      const group = this.b.profiles.groups[groupId];
      if (
        group &&
        this.managed.profiles.has(groupId) &&
        group.totalAmount !== Object.keys(list).length
      )
        fail(
          `"${group.name}" counts ${group.totalAmount} profiles but holds ${Object.keys(list).length}`,
        );
    }
    for (const [groupId, lists] of Object.entries(this.b.tasks.lists)) {
      for (const list of Object.values(lists)) {
        for (const [id, task] of Object.entries(list)) {
          if (task.id !== id || seen.tasks.has(id))
            fail(`task ${id} is listed twice or under another id`);
          seen.tasks.add(id);
        }
      }
      const group = this.b.tasks.groups[groupId];
      if (group && this.managed.tasks.has(groupId)) {
        const total = Object.values(lists).reduce((n, l) => n + Object.keys(l).length, 0);
        if (group.totalAmount !== total)
          fail(`"${group.name}" counts ${group.totalAmount} tasks but holds ${total}`);
      }
    }
    for (const [groupId, list] of Object.entries(this.b.accounts.lists)) {
      for (const [id, account] of Object.entries(list)) {
        if (account.id !== id || seen.accounts.has(id))
          fail(`login ${id} is listed twice or under another id`);
        seen.accounts.add(id);
      }
      const group = this.b.accounts.groups[groupId];
      if (
        group &&
        this.managed.accounts.has(groupId) &&
        group.totalAmount !== Object.keys(list).length
      )
        fail(
          `"${group.name}" counts ${group.totalAmount} logins but holds ${Object.keys(list).length}`,
        );
    }
    for (const [id, entry] of Object.entries(this.b.imap))
      if (entry.id !== id) fail(`mailbox ${id} is under another id`);

    // Keyed by task id and what it points at, with its group's name beside, to say where.
    const dangling = (file: ValorBackup) => {
      const problems = new Map<string, string>();
      for (const [groupId, lists] of Object.entries(file.tasks.lists)) {
        const group = file.tasks.groups[groupId]?.name ?? groupId;
        for (const list of Object.values(lists)) {
          for (const task of Object.values(list)) {
            if (task.profile && task.profileGroupID) {
              const profile = file.profiles.lists[task.profileGroupID]?.[task.profile.id];
              if (!profile) problems.set(`${task.id}: profile`, group);
              else if (profile.name !== task.profile.name)
                problems.set(`${task.id}: profile name`, group);
            }
            if (task.account && task.accountGroupID) {
              const account = file.accounts.lists[task.accountGroupID]?.[task.account.id];
              if (!account) problems.set(`${task.id}: login`, group);
            }
          }
        }
      }
      return problems;
    };
    const before = dangling(this.source);
    const introduced = [...dangling(this.b)].filter(([key]) => !before.has(key));
    if (introduced.length > 0) {
      const groups = [...new Set(introduced.map(([, group]) => `"${group}"`))].slice(0, 3);
      fail(
        `${introduced.length} task(s) in ${groups.join(", ")} would point at a profile or login that isn't there`,
      );
    }
  }
}

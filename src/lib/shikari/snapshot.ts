import { jsonObject } from "@/lib/shikari/format";
import { checkShikariSchema } from "@/lib/shikari/schema";
import type { ShikariDb } from "@/lib/shikari/sqlite";
import type { TaskSettings } from "@/lib/shikari/types";

/**
 * Everything the export needs from a backup, read once.
 *
 * Secrets are read too -- card numbers, passwords -- because deciding whether a card
 * CHANGED means comparing it. They stay in the operator's browser memory, like the file
 * they came from, and the summary the page renders carries none of them.
 */

export type SProfileGroup = { id: number; name: string; orderIndex: number };
export type SProfile = {
  id: number;
  name: string;
  email: string;
  groupId: number;
  shippingId: number;
  billingId: number | null;
  cardId: number;
};
export type SAddress = {
  id: number;
  firstName: string;
  lastName: string;
  street: string;
  street2: string;
  city: string;
  state: string;
  zip: string;
  country: string;
  phone: string;
};
export type SCard = {
  id: number;
  number: string;
  expMonth: number | null;
  expYear: number | null;
  cvv: string;
};
export type SAccount = {
  id: number;
  username: string;
  password: string;
  websiteId: number;
  /** Logged in: Shikari holds a session for it, which is what an export must never lose. */
  signedIn: boolean;
};
export type SImap = {
  id: number;
  server: string;
  port: number | null;
  username: string;
  password: string;
  enabled: boolean;
};
export type SProxy = {
  id: number;
  host: string;
  port: number;
  username: string | null;
  password: string | null;
};
export type SProxyGroup = { id: number; name: string; orderIndex: number; proxies: SProxy[] };
export type STaskGroup = { id: number; name: string; orderIndex: number };
/**
 * The text columns stay NULL where Shikari left them NULL. A Wipe Account task's
 * `target_kind` is NULL, not "", and a copy has to say the same thing its original did.
 */
export type STask = {
  id: number;
  groupId: number | null;
  type: string | null;
  flowKey: string | null;
  targetKind: string | null;
  websiteId: number;
  profileId: number | null;
  browserId: number;
  imapId: number | null;
  genericData: string | null;
  options: string | null;
  state: string | null;
};
export type SProduct = {
  id: number;
  taskId: number | null;
  method: string;
  data: string;
  qty: number | null;
};
export type SBrowser = {
  id: number;
  proxyGroupId: number | null;
  proxyId: number | null;
  fingerprint: string;
  cookieJarId: number | null;
};

export type ShikariSnapshot = {
  version: string | null;
  /** Target's id in Shikari's own (code-side) website table: 5 in every backup seen. */
  targetWebsiteId: number;
  profileGroups: SProfileGroup[];
  profiles: SProfile[];
  addresses: Map<number, SAddress>;
  cards: Map<number, SCard>;
  accounts: SAccount[];
  imap: SImap[];
  proxyGroups: SProxyGroup[];
  taskGroups: STaskGroup[];
  tasks: STask[];
  products: SProduct[];
  browsers: Map<number, SBrowser>;
};

const text = (value: unknown): string =>
  value === null || value === undefined ? "" : String(value);
const textOrNull = (value: unknown): string | null =>
  value === null || value === undefined ? null : String(value);
const intOrNull = (value: unknown): number | null =>
  value === null || value === undefined || value === "" ? null : Number(value);

export const lower = (value: string | null | undefined): string =>
  String(value ?? "")
    .trim()
    .toLowerCase();

// --- what kind of task a row is ------------------------------------------------------
// Matched on both columns: `type` is what Shikari shows ("Checkout") and `flow_key` what it
// runs ("checkout"). Either saying so is enough.

export const isCheckout = (task: STask) =>
  lower(task.type) === "checkout" || lower(task.flowKey) === "checkout";
export const isWatchdog = (task: STask) =>
  lower(task.type) === "watchdog" || lower(task.flowKey) === "watchdog";
export const isRemoteWatchdog = (task: STask) =>
  isWatchdog(task) && lower(task.targetKind) === "remote";
/**
 * A Wipe Account task: type "Wipe Account", flow "wipe_account" in the main instance's 38.
 * Matched on the word rather than the exact spelling, and the export copies whichever one
 * the instance already has rather than writing its own -- see the wipe section of build.ts.
 */
export const isWipe = (task: STask) =>
  /wipe/.test(lower(task.type)) || /wipe/.test(lower(task.flowKey));

/**
 * The group names the export works with. Looked up by `groupKey`, so "Target - Paused" and
 * "Target Paused" are one group: the instances spell them differently, and a near-miss would
 * mean a second, empty group created beside the real one.
 */
export const TARGET_GROUP = "Target";
export const UPDATES_GROUP = "Target - Profile Updates";
export const PAUSED_PROFILE_GROUP = "Target - Paused";

/** A group name with case, spaces and punctuation ignored: "Target - Paused" -> "targetpaused". */
export function groupKey(name: string | null | undefined): string {
  return lower(name).replace(/[^a-z0-9]/g, "");
}

export function findGroup<T extends { name: string }>(groups: T[], name: string): T | undefined {
  return groups.find((g) => groupKey(g.name) === groupKey(name));
}

/**
 * A profile group on the Target side, by its name: "Target - Secondary", "Crisp Target".
 * Profiles belong to no retailer in Shikari -- one row serves every site -- so the name the
 * operator gave the group is the only thing that says whose side it is on.
 */
export function isTargetGroupName(name: string | null | undefined): boolean {
  return groupKey(name).includes("target");
}

export type TargetGroups = {
  /** The profile group whose profiles the export runs: "Target". Null until there is one. */
  profiles: SProfileGroup | null;
  /**
   * Where profiles not being run used to be parked, by hand or by earlier exports. Null when
   * there is none. A clean export empties it -- what isn't running isn't kept -- and takes
   * it out.
   */
  paused: SProfileGroup | null;
  /** Ids of every profile in those two: the only profiles the export ever matches. */
  candidates: Set<number>;
  /**
   * The task group the export rebuilds as "Target": the one already called that, or failing
   * that the one holding most of the Target profiles' checkout tasks -- "Target - All
   * Products" on the main instance. Null when there are no such tasks to go by.
   */
  tasks: STaskGroup | null;
};

/**
 * Which groups are the export's, in a backup it didn't build.
 *
 * ONLY THE "Target" PROFILE GROUP (and its paused group) is ever matched against the vault.
 * One instance holds Walmart profiles too -- 131 of whose emails, and 141 of whose names, are
 * the same as a Target profile's, because members reuse both across retailers -- along with
 * other runners' profiles ("Crisp Target") and deliberately parked ones ("Target -
 * Secondary"). Matching across all of them would rewrite a member's Walmart profile with
 * their Target card, or delete somebody else's member. Another Target group is cleared out
 * only when the operator says so (see defaultGroupChoice); anything not Target, never.
 */
export function targetGroups(snapshot: ShikariSnapshot): TargetGroups {
  const profiles = findGroup(snapshot.profileGroups, TARGET_GROUP) ?? null;
  const paused = findGroup(snapshot.profileGroups, PAUSED_PROFILE_GROUP) ?? null;
  const candidates = new Set(
    snapshot.profiles
      .filter((p) => p.groupId === profiles?.id || p.groupId === paused?.id)
      .map((p) => p.id),
  );

  const named = findGroup(snapshot.taskGroups, TARGET_GROUP);
  if (named) return { profiles, paused, candidates, tasks: named };

  const counts = new Map<number, number>();
  for (const task of snapshot.tasks) {
    if (!isCheckout(task) || task.websiteId !== snapshot.targetWebsiteId) continue;
    if (task.groupId === null || task.profileId === null || !candidates.has(task.profileId))
      continue;
    counts.set(task.groupId, (counts.get(task.groupId) ?? 0) + 1);
  }
  const groups = new Map(snapshot.taskGroups.map((g) => [g.id, g]));
  const [best] = [...counts].sort(
    ([a, m], [b, n]) =>
      n - m || (groups.get(a)?.orderIndex ?? 0) - (groups.get(b)?.orderIndex ?? 0),
  );
  return { profiles, paused, candidates, tasks: best ? (groups.get(best[0]) ?? null) : null };
}

export function readSnapshot(db: ShikariDb): ShikariSnapshot {
  const schema = checkShikariSchema(db);

  const profiles = db.all("SELECT * FROM profile ORDER BY id").map((r) => ({
    id: Number(r.id),
    name: text(r.name),
    email: text(r.email),
    groupId: Number(r.profile_group_id),
    shippingId: Number(r.shipping_address_id),
    billingId: intOrNull(r.billing_address_id),
    cardId: Number(r.credit_card_id),
  }));

  const addresses = new Map<number, SAddress>();
  for (const r of db.all("SELECT * FROM address")) {
    addresses.set(Number(r.id), {
      id: Number(r.id),
      firstName: text(r.first_name),
      lastName: text(r.last_name),
      street: text(r.street),
      street2: text(r.street_2),
      city: text(r.city),
      state: text(r.state),
      zip: text(r.zip_code),
      country: text(r.country),
      phone: text(r.phone_number),
    });
  }

  const cards = new Map<number, SCard>();
  for (const r of db.all("SELECT * FROM credit_card")) {
    cards.set(Number(r.id), {
      id: Number(r.id),
      number: text(r.card_number),
      expMonth: intOrNull(r.expire_month),
      expYear: intOrNull(r.expire_year),
      cvv: text(r.cvv),
    });
  }

  const accounts = db
    .all(
      // A session is the thing to protect, so it is worth knowing which accounts have one.
      `SELECT id, username, password, website_id,
              (cookie_jar_id IS NOT NULL OR mobile_cookie_jar_id IS NOT NULL
               OR session_data NOT IN ('', '{}')) AS signed_in
         FROM account ORDER BY id`,
    )
    .map((r) => ({
      id: Number(r.id),
      username: text(r.username),
      password: text(r.password),
      websiteId: Number(r.website_id),
      signedIn: Number(r.signed_in) === 1,
    }));

  const imap = db.all("SELECT * FROM imap_account ORDER BY id").map((r) => ({
    id: Number(r.id),
    server: text(r.imap_server),
    port: intOrNull(r.port),
    username: text(r.username),
    password: text(r.password),
    enabled: Number(r.is_enabled) === 1,
  }));

  const proxiesByGroup = new Map<number, SProxy[]>();
  for (const r of db.all(
    "SELECT id, proxy_group_id, host, port, username, password FROM proxy ORDER BY id",
  )) {
    const group = Number(r.proxy_group_id);
    const list = proxiesByGroup.get(group) ?? [];
    list.push({
      id: Number(r.id),
      host: text(r.host),
      port: Number(r.port),
      username: r.username === null ? null : text(r.username),
      password: r.password === null ? null : text(r.password),
    });
    proxiesByGroup.set(group, list);
  }
  const proxyGroups = db
    .all("SELECT id, name, order_index FROM proxy_group ORDER BY order_index, id")
    .map((r) => ({
      id: Number(r.id),
      name: text(r.name),
      orderIndex: Number(r.order_index),
      proxies: proxiesByGroup.get(Number(r.id)) ?? [],
    }));

  const tasks = db.all("SELECT * FROM task ORDER BY id").map((r) => ({
    id: Number(r.id),
    groupId: intOrNull(r.task_group_id),
    type: textOrNull(r.type),
    flowKey: textOrNull(r.flow_key),
    targetKind: textOrNull(r.target_kind),
    websiteId: Number(r.website_id),
    profileId: intOrNull(r.profile_id),
    browserId: Number(r.browser_id),
    imapId: intOrNull(r.imap_account_id),
    genericData: textOrNull(r.generic_data),
    options: textOrNull(r.options),
    state: textOrNull(r.state),
  }));

  const browsers = new Map<number, SBrowser>();
  for (const r of db.all(
    "SELECT id, proxy_group_id, proxy_id, fingerprint_name, cookie_jar_id FROM browser",
  )) {
    browsers.set(Number(r.id), {
      id: Number(r.id),
      proxyGroupId: intOrNull(r.proxy_group_id),
      proxyId: intOrNull(r.proxy_id),
      fingerprint: text(r.fingerprint_name),
      cookieJarId: intOrNull(r.cookie_jar_id),
    });
  }

  return {
    version: schema.version,
    // From the tasks that watch TCINs, which only Target has: an instance running Walmart
    // has checkout tasks for both, and could have more of Walmart's.
    targetWebsiteId:
      mostCommon(tasks.filter((t) => lower(t.targetKind) === "tcins").map((t) => t.websiteId)) ?? 5,
    profileGroups: db
      .all("SELECT id, name, order_index FROM profile_group ORDER BY order_index, id")
      .map((r) => ({
        id: Number(r.id),
        name: text(r.name),
        orderIndex: Number(r.order_index),
      })),
    profiles,
    addresses,
    cards,
    accounts,
    imap,
    proxyGroups,
    taskGroups: db
      .all("SELECT id, name, order_index FROM task_group ORDER BY order_index, id")
      .map((r) => ({
        id: Number(r.id),
        name: text(r.name),
        orderIndex: Number(r.order_index),
      })),
    tasks,
    products: db
      .all("SELECT id, task_id, target_method, target_data, qty FROM target_product ORDER BY id")
      .map((r) => ({
        id: Number(r.id),
        taskId: intOrNull(r.task_id),
        method: text(r.target_method),
        data: text(r.target_data),
        qty: intOrNull(r.qty),
      })),
    browsers,
  };
}

/** The value that appears most, first-seen winning a tie; null for an empty list. */
export function mostCommon<T>(values: T[]): T | null {
  const counts = new Map<T, number>();
  let best: T | null = null;
  let most = 0;
  for (const value of values) {
    const n = (counts.get(value) ?? 0) + 1;
    counts.set(value, n);
    if (n > most) {
      most = n;
      best = value;
    }
  }
  return best;
}

/** A watchdog's check interval, from its options. */
export function checkInterval(task: STask): number | null {
  const value = jsonObject(task.options).check_interval;
  return typeof value === "number" ? value : null;
}

// ---------------------------------------------------------------------------
// What the operator sees on upload
// ---------------------------------------------------------------------------

export type BackupSummary = {
  version: string | null;
  /** The groups an export works in, as this backup has them -- see targetGroups. */
  target: {
    profileGroup: string | null;
    pausedGroup: string | null;
    taskGroup: string | null;
    /** Target profiles the export can match: the "Target" group and its paused group. */
    candidates: number;
  };
  counts: {
    profiles: number;
    accounts: number;
    signedIn: number;
    imap: number;
    proxies: number;
    tasks: number;
  };
  profileGroups: SummaryProfileGroup[];
  /** Profiles grouped by the member name they start with. */
  users: { name: string; profiles: { name: string; group: string }[] }[];
  proxyGroups: { id: number; name: string; count: number }[];
  taskGroups: {
    id: number;
    name: string;
    kinds: { kind: string; count: number }[];
    watchdogs: { remote: boolean; skus: number; interval: number | null }[];
    /** Distinct products across the group's checkout tasks. */
    checkoutSkus: number;
  }[];
};

/**
 * A profile group as the instance setup shows it:
 *
 *   target   "Target": keeps exactly this instance's active profiles
 *   paused   its paused group: emptied, then taken out
 *   other    another Target group ("Target - Secondary", "Crisp Target"): kept or cleared,
 *            the operator's choice -- see defaultGroupChoice
 *   outside  not Target at all ("Walmart"): never touched
 */
export type SummaryProfileGroup = {
  id: number;
  name: string;
  count: number;
  role: "target" | "paused" | "other" | "outside";
  /** Tasks that use the group's profiles, on any site: what "in use" means. */
  tasks: number;
};

/**
 * What an export does with another Target group unless told otherwise: clear it out when
 * nothing runs its profiles ("Target - Secondary", parked past the cap), keep it when
 * something does ("Crisp Target", another runner's, run from "MNs Target").
 */
export function defaultGroupChoice(group: SummaryProfileGroup): "keep" | "remove" {
  return group.role === "other" && group.tasks === 0 ? "remove" : "keep";
}

/** The operator's saved choice for a group, by name, or its default. Only "other" groups have one. */
export function groupChoice(
  group: SummaryProfileGroup,
  saved: Record<string, "keep" | "remove">,
): "keep" | "remove" {
  if (group.role !== "other") return "keep";
  return saved[groupKey(group.name)] ?? defaultGroupChoice(group);
}

/** The ids an export is told to clear, for one backup and one instance's saved choices. */
export function groupsToClear(
  summary: BackupSummary,
  saved: Record<string, "keep" | "remove">,
): number[] {
  return summary.profileGroups.filter((g) => groupChoice(g, saved) === "remove").map((g) => g.id);
}

/**
 * "azndeptrai - 6" -> "azndeptrai", "Target 11" -> "Target". The separator is required, so
 * a member whose name merely ends in digits ("kennethm321") keeps them.
 */
export function userOf(profileName: string): string {
  return profileName.replace(/(?:\s*-\s*|\s+)\d+$/, "").trim() || profileName;
}

export function summarize(snapshot: ShikariSnapshot): BackupSummary {
  const groupName = new Map(snapshot.profileGroups.map((g) => [g.id, g.name]));
  const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

  const users = new Map<string, { name: string; group: string }[]>();
  for (const profile of snapshot.profiles) {
    const user = userOf(profile.name);
    const list = users.get(user) ?? [];
    list.push({ name: profile.name, group: groupName.get(profile.groupId) ?? "—" });
    users.set(user, list);
  }

  const productsByTask = new Map<number, string[]>();
  for (const product of snapshot.products) {
    if (product.taskId === null) continue;
    productsByTask.set(product.taskId, [
      ...(productsByTask.get(product.taskId) ?? []),
      product.data,
    ]);
  }

  const target = targetGroups(snapshot);
  const groupOf = new Map(snapshot.profiles.map((p) => [p.id, p.groupId]));
  const tasksByGroup = new Map<number, number>();
  for (const task of snapshot.tasks) {
    const group = task.profileId === null ? undefined : groupOf.get(task.profileId);
    if (group !== undefined) tasksByGroup.set(group, (tasksByGroup.get(group) ?? 0) + 1);
  }
  const role = (g: SProfileGroup): SummaryProfileGroup["role"] =>
    g.id === target.profiles?.id
      ? "target"
      : g.id === target.paused?.id
        ? "paused"
        : isTargetGroupName(g.name)
          ? "other"
          : "outside";

  return {
    version: snapshot.version,
    target: {
      profileGroup: target.profiles?.name ?? null,
      pausedGroup: target.paused?.name ?? null,
      taskGroup: target.tasks?.name ?? null,
      candidates: target.candidates.size,
    },
    counts: {
      profiles: snapshot.profiles.length,
      accounts: snapshot.accounts.length,
      signedIn: snapshot.accounts.filter((a) => a.signedIn).length,
      imap: snapshot.imap.length,
      proxies: snapshot.proxyGroups.reduce((sum, g) => sum + g.proxies.length, 0),
      tasks: snapshot.tasks.length,
    },
    profileGroups: snapshot.profileGroups.map((g) => ({
      id: g.id,
      name: g.name,
      count: snapshot.profiles.filter((p) => p.groupId === g.id).length,
      role: role(g),
      tasks: tasksByGroup.get(g.id) ?? 0,
    })),
    users: [...users.entries()]
      .map(([name, profiles]) => ({
        name,
        profiles: profiles.sort((a, b) => collator.compare(a.name, b.name)),
      }))
      .sort((a, b) => collator.compare(a.name, b.name)),
    proxyGroups: snapshot.proxyGroups
      // Shikari's built-in "localhost" group (id -1) is no list anybody uploaded.
      .filter((g) => g.id >= 0)
      .map((g) => ({ id: g.id, name: g.name, count: g.proxies.length })),
    taskGroups: snapshot.taskGroups.map((group) => {
      const tasks = snapshot.tasks.filter((t) => t.groupId === group.id);
      const kinds = new Map<string, number>();
      for (const task of tasks) {
        const kind = isRemoteWatchdog(task)
          ? "Remote watchdog"
          : task.type || task.flowKey || "Task";
        kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
      }
      return {
        id: group.id,
        name: group.name,
        kinds: [...kinds.entries()].map(([kind, count]) => ({ kind, count })),
        watchdogs: tasks.filter(isWatchdog).map((task) => ({
          remote: isRemoteWatchdog(task),
          skus: productsByTask.get(task.id)?.length ?? 0,
          interval: checkInterval(task),
        })),
        checkoutSkus: new Set(
          tasks.filter(isCheckout).flatMap((t) => productsByTask.get(t.id) ?? []),
        ).size,
      };
    }),
  };
}

/**
 * Task settings as the backup has them now -- what "leave it as it is" means, and what the
 * page pre-fills so the operator only ever edits what they mean to change.
 */
export function currentTaskSettings(snapshot: ShikariSnapshot): TaskSettings {
  const target = targetGroups(snapshot).tasks;
  const inTarget = snapshot.tasks.filter((t) => target && t.groupId === target.id);
  const checkouts = inTarget.filter(isCheckout);
  const checkoutIds = new Set(checkouts.map((t) => t.id));
  const watchdogs = inTarget.filter((t) => isWatchdog(t) && !isRemoteWatchdog(t));
  // A browser can point at a proxy group that has since been deleted -- 71 on the main
  // instance do -- and a setting that names one would move every browser into nothing.
  const live = new Set(snapshot.proxyGroups.map((g) => g.id));
  const browserGroup = (task: STask) => {
    const id = snapshot.browsers.get(task.browserId)?.proxyGroupId ?? null;
    return id !== null && live.has(id) ? id : null;
  };

  // Three per list is how they are set up by hand; their intervals, in order, are the
  // pattern every list repeats.
  const intervals = watchdogs
    .slice(0, 3)
    .map(checkInterval)
    .filter((v): v is number => v !== null);

  return {
    checkoutQty:
      mostCommon(
        snapshot.products
          .filter((p) => p.taskId !== null && checkoutIds.has(p.taskId) && p.qty !== null)
          .map((p) => p.qty as number),
      ) ?? 1,
    checkoutProxyGroupId: mostCommon(checkouts.map(browserGroup).filter((id) => id !== null)),
    watchdogProxyGroupId: mostCommon(watchdogs.map(browserGroup).filter((id) => id !== null)),
    watchdogIntervals: intervals.length > 0 ? intervals : [3333, 4444, 5555],
    skusPerWatchdog: 30,
    remoteWatchdogs: Math.max(1, inTarget.filter(isRemoteWatchdog).length),
  };
}

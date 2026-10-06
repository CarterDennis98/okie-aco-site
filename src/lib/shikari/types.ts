/**
 * The shapes that cross between the server, the operator's browser, and the builder.
 *
 * The server sends a `DesiredInstance` -- what the vault says one Shikari instance should
 * hold -- and the browser hands it, with the operator's `BuildOptions`, to `buildInstance`,
 * which edits a copy of the instance's backup and answers with a `BuildReport`: what it
 * changed, in words, for the review screen and the summary after it.
 *
 * Everything here is plain data, so it serializes across a Server Action untouched.
 */

/** One address as Shikari stores it: a row of its own, shared when billing is shipping. */
export type ShikariAddress = {
  firstName: string;
  lastName: string;
  street: string;
  street2: string;
  city: string;
  /** Two-letter code, as Shikari stores it. */
  state: string;
  zip: string;
  country: string;
  /** Ten bare digits. */
  phone: string;
};

export type ShikariCard = {
  number: string;
  /** Shikari stores both as integers: 9, not "09". */
  expMonth: number;
  expYear: number;
  cvv: string;
};

/** Where a profile's verification codes can be read: its own inbox, or the one it forwards to. */
export type ShikariMailbox = {
  server: string;
  port: number;
  username: string;
  password: string;
};

/** One vault profile, as an instance should run it. Carries secrets -- never logged. */
export type DesiredProfile = {
  /** The vault profile's id. */
  key: string;
  ownerId: string;
  ownerName: string;
  /** "shockereyes - 6": the vault's names were imported from Shikari and are its form. */
  name: string;
  /** The Target login, which is also the profile's email. */
  email: string;
  shipping: ShikariAddress;
  /** Null when billing is the shipping address, which Shikari stores as one shared row. */
  billing: ShikariAddress | null;
  card: ShikariCard;
  /** The Target password. Null when none is on file -- the account is then left alone. */
  password: string | null;
  mailbox: ShikariMailbox | null;
  /** TCINs this profile is run for, in catalog order. Empty means it runs for nothing. */
  skus: string[];
  /**
   * Unconfirmed changes to this profile, and which fields. Earns it a Wipe Account task, so
   * the stale card and address saved on the Target account come off before the new ones go
   * on. Exporting never confirms them: that stays a separate, manual step.
   */
  pending: { fields: string[] } | null;
};

/**
 * Why a Target profile the site holds is NOT on this instance -- said beside it when the
 * export takes it off:
 *
 *   inactive  its member switched it off
 *   runner    it is assigned to another runner's bot
 *   main      it is one of its member's first five, so it runs on the main bot
 *   backup    it is past its member's first five, so it runs on a backup bot
 *   member    its member isn't one this instance runs
 */
export type AbsentReason = "inactive" | "runner" | "main" | "backup" | "member";

/**
 * One Target profile the site holds, on any runner, and why it isn't here (null: it is).
 * `instance` is the instance of the same export that runs it, when one does.
 */
export type KnownProfile = {
  name: string;
  email: string;
  why: AbsentReason | null;
  instance?: number;
};

export type CatalogProduct = { sku: string; name: string; setName: string };

export type DesiredInstance = {
  position: number;
  profiles: DesiredProfile[];
  /**
   * Every Target profile the site holds, on any runner. What tells a profile of ours that
   * isn't on this instance -- and so comes off it, with the reason -- from one the site has
   * never heard of.
   */
  known: KnownProfile[];
  /** Every product being run, in catalog order: names for the review, order for watchdogs. */
  products: CatalogProduct[];
};

export type Sections = {
  profiles: boolean;
  accounts: boolean;
  imap: boolean;
  proxies: boolean;
  /** The "Target" task group: watchdogs and checkout tasks. */
  tasks: boolean;
  /** The "Target - Profile Updates" task group: a Wipe Account task per pending change. */
  wipes: boolean;
};

export type ProxyEntry = {
  host: string;
  port: number;
  username: string | null;
  password: string | null;
};

export type TaskSettings = {
  /** Units per product on every checkout task. */
  checkoutQty: number;
  checkoutProxyGroupId: number | null;
  watchdogProxyGroupId: number | null;
  /** One check interval per watchdog in a list, in ms. Two by default: 3333 and 4444. */
  watchdogIntervals: number[];
  /** Shikari's ceiling is 30 products per watchdog. */
  skusPerWatchdog: number;
  remoteWatchdogs: number;
};

export type BuildOptions = {
  sections: Sections;
  /**
   * Other Target profile groups to clear out entirely ("Target - Secondary", say) -- by id,
   * in this backup. The export's own groups are always cleared of everything but this
   * instance's active profiles; these are the operator's choice, made per group.
   */
  removeProfileGroups: number[];
  proxyLists: { groupId: number; proxies: ProxyEntry[] }[];
  tasks: TaskSettings;
  /** Stamped on every row the export creates or changes. */
  now: Date;
  /** Draws device ids and picks among equals. Seeded in tests so a build is repeatable. */
  random: () => number;
};

/** A profile in the report: who, whose, what changed or why, and from which group. */
export type ProfileLine = {
  name: string;
  owner?: string;
  fields?: string[];
  why?: string;
  group?: string;
};
export type TaskLine = { profile: string; skus: number };
export type TaskChange = {
  profile: string;
  added: string[];
  removed: string[];
  /** Anything else about the task that moved: qty, mailbox, proxy group, group. */
  other: string[];
};
export type WatchList = { interval: number | null; skus: string[] };

export type BuildReport = {
  version: string | null;
  /**
   * The task group rebuilt as "Target": found and renamed (the main instance's "Target - All
   * Products"), found as it was, or created. Null when the tasks section was off.
   */
  taskGroup: { name: string; renamedFrom: string | null; created: boolean } | null;
  profiles: {
    /** New to this backup. */
    added: ProfileLine[];
    /** Details changed: card, address, name, email. */
    updated: ProfileLine[];
    /** Already in the backup but not running, and running now -- `why` says how. */
    activated: ProfileLine[];
    /** Running before, not now -- `why` says why. Taken out of the backup unless still active. */
    deactivated: ProfileLine[];
    /** Taken out of the backup, and weren't running anyway: parked, stale, or unknown. */
    removed: ProfileLine[];
    unchanged: number;
    /** A second Shikari profile for the same vault profile. Taken out like any other. */
    duplicates: string[];
    /** Other profile groups left as they were: not Target, kept by choice, or in use. */
    kept: { group: string; count: number; why: string }[];
  };
  accounts: {
    added: string[];
    updated: string[];
    unchanged: number;
    noPassword: string[];
    /** Target logins taken out: no profile left in the backup to use them. */
    removed: number;
  };
  imap: {
    added: string[];
    updated: string[];
    unchanged: number;
    /** Mailboxes taken out: no profile here reads codes there, and no task points at them. */
    removed: number;
  };
  /** Addresses and cards no profile pointed at even before: left behind by long-gone ones. */
  strays: number;
  /** Groups taken out: emptied by this export, or chosen to be cleared. */
  groupsRemoved: { profile: string[]; task: string[] };
  proxies: {
    group: string;
    before: number;
    after: number;
    /** Rows rewritten, added or removed. */
    changed: number;
    /** Browsers that were pinned to a removed row, re-pinned to one that's left. */
    browsersMoved: number;
  }[];
  checkout: {
    added: TaskLine[];
    removed: TaskLine[];
    changed: TaskChange[];
    unchanged: number;
    /** Checkout tasks in the Target group for profiles the export keeps its hands off. */
    untouched: string[];
    /** Selected profiles that picked no products, so got no task. */
    noProducts: string[];
    /** Selected profiles with no Shikari profile to attach a task to. */
    missingProfile: string[];
  };
  watchdogs: {
    before: WatchList[];
    after: WatchList[];
    remote: { before: number; after: number };
  };
  wipes: {
    added: ProfileLine[];
    /** Wipes taken out: last export's, and older ones made by hand that these replace. */
    removed: number;
    /** Where the new ones' shape came from: a Wipe Account task in the backup, or built in. */
    template: "copied" | "built-in" | null;
  };
  /** Things worth reading before exporting. None of them stop it. */
  warnings: string[];
};

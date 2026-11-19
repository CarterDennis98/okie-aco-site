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
   * How many of each TCIN its checkout buys, where its member picked a qty -- by TCIN, and
   * only TCINs in `skus`. One not listed buys the standard qty, TaskSettings.checkoutQty, or
   * the product's limit where that's lower (CatalogProduct.maxQty).
   */
  qty: Record<string, number>;
  /**
   * The raffles this profile is entered in, by their product's TCIN, in DesiredInstance.raffles
   * order. Each earns it a Draw task in that raffle's group. Empty: entered in none.
   */
  raffles: string[];
  /**
   * Unconfirmed changes to this profile, and which fields. Earns it a Wipe Account task, so
   * the stale card and address saved on the Target account come off before the new ones go
   * on. Exporting never confirms them: that stays a separate, manual step.
   */
  pending: { fields: string[] } | null;
};

/**
 * A raffle on Target Products: a drawing Target runs for one product, which Shikari enters
 * with a Draw task per profile. Every raffle the site lists, open or closed -- a raffle's group
 * stays in the backups until it's deleted from the site (see Raffle in schema.prisma).
 */
export type DesiredRaffle = {
  /** The product's TCIN: what the Draw tasks enter, and what names the raffle's group. */
  sku: string;
  /** The product's name, for the review. */
  name: string;
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

/**
 * A product Shikari runs. One in the Miscellaneous line (MISC_LINE) is sent only to an instance
 * set to run the line (Sections.misc), and runs there from a task group of its own, MISC_GROUP.
 */
export type CatalogProduct = {
  sku: string;
  name: string;
  setName: string;
  /** In the Miscellaneous line: run from MISC_GROUP, apart from everything else in "Target". */
  misc: boolean;
  /**
   * Target's limit per checkout, where an admin posted one (DropProduct.maxQty); null when
   * none is. Lowers the qty a profile whose member picked none runs at -- never a pick.
   */
  maxQty: number | null;
};

/**
 * Profiles entered in a raffle that NO instance of an export runs -- their member picked on
 * none, or past the main bot's share with no backup instance -- by raffle. Said on the review.
 */
export type RaffleGap = { raffle: string; profiles: string[] };

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
  /** Every raffle on the site, oldest first. */
  raffles: DesiredRaffle[];
  /**
   * The Miscellaneous line here: whether this instance runs it -- its products then come in
   * `products`, flagged, and its picks in each profile's `skus` -- and how many of the
   * instance's profiles picked from it, run here or not. The review warns with the second.
   */
  misc: { runs: boolean; picked: number };
};

export type Sections = {
  profiles: boolean;
  accounts: boolean;
  imap: boolean;
  proxies: boolean;
  /** The "Target" task group: watchdogs and checkout tasks. */
  tasks: boolean;
  /**
   * Part of the tasks section, and nothing without it: the Miscellaneous line's picks run from
   * "Target - Miscellaneous", built like "Target" (true), or that group is emptied and the
   * line left to Valor (false).
   */
  misc: boolean;
  /** The "Target - Profile Updates" task group: a Wipe Account task per pending change. */
  wipes: boolean;
  /** A "Target Raffle <SKU>" task group per raffle: a Draw task per profile entered. */
  raffles: boolean;
};

export type ProxyEntry = {
  host: string;
  port: number;
  username: string | null;
  password: string | null;
};

export type TaskSettings = {
  /**
   * The standard qty: units of a product on a checkout task whose member picked none for it
   * (see DesiredProfile.qty), unless the product's limit is lower -- then its limit. Starts at
   * the site's own STANDARD_QTY; never past MAX_QTY.
   */
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
/** A product the task already ran whose qty changed, and from what. */
export type QtyChange = { sku: string; from: number | null; to: number | null };
export type TaskChange = {
  profile: string;
  added: string[];
  removed: string[];
  qty: QtyChange[];
  /** Anything else about the task that moved: price limits, mailbox, proxy group, group. */
  other: string[];
};
export type WatchList = { interval: number | null; skus: string[] };

/** The checkout tasks of one task group the export builds. */
export type CheckoutReport = {
  added: TaskLine[];
  removed: TaskLine[];
  changed: TaskChange[];
  unchanged: number;
  /** Checkout tasks in the group for profiles the export keeps its hands off. */
  untouched: string[];
};

/** One raffle's task group, as the export leaves it. */
export type RaffleGroupReport = {
  sku: string;
  /** The raffle's product, as the site names it. */
  product: string;
  /** The group's name after the export: "Target Raffle 1012850572". */
  name: string;
  created: boolean;
  /** The name it had, when it was found under another -- "Target - Raffle", set up by hand. */
  renamedFrom: string | null;
  /** Profiles given an entry task. */
  added: string[];
  /** Profiles whose entry task came out: no longer entered, gone, or a second copy. */
  removed: string[];
  /** Entry tasks kept but changed, by profile, and what moved: "moved in", "mailbox", .... */
  changed: { profile: string; what: string[] }[];
  unchanged: number;
  /** Tasks in it for profiles the export keeps its hands off, left as they are. */
  untouched: string[];
};

export type RaffleReport = {
  groups: RaffleGroupReport[];
  /** Raffle groups taken out, emptied by this export, and why. */
  removed: { name: string; why: string; tasks: number }[];
  /** Profiles entered in a raffle with no Shikari profile to attach an entry to. */
  missingProfile: string[];
  /** Where the new entry tasks' shape came from: a Draw task in the backup, or built in. */
  template: "copied" | "built-in" | null;
};

/** The watchdogs of one task group the export builds. */
export type WatchdogReport = {
  before: WatchList[];
  after: WatchList[];
  remote: { before: number; after: number };
};

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
  /** The "Target" group's checkout tasks, and who got none in either group. */
  checkout: CheckoutReport & {
    /** Selected profiles that picked no products, so got no task. */
    noProducts: string[];
    /** Selected profiles with no Shikari profile to attach a task to. */
    missingProfile: string[];
  };
  watchdogs: WatchdogReport;
  /**
   * "Target - Miscellaneous" (MISC_GROUP): the Miscellaneous line's picks, built by the rules
   * "Target" is when this instance runs the line, emptied when it doesn't. Null when the tasks
   * section was off, or when the backup has no such group and nothing called for one.
   */
  misc: {
    name: string;
    /** Whether this instance runs the line: the group built, or emptied. */
    runs: boolean;
    created: boolean;
    checkout: CheckoutReport;
    watchdogs: WatchdogReport;
  } | null;
  wipes: {
    added: ProfileLine[];
    /** Wipes taken out: last export's, and older ones made by hand that these replace. */
    removed: number;
    /** Where the new ones' shape came from: a Wipe Account task in the backup, or built in. */
    template: "copied" | "built-in" | null;
  };
  /** The raffle groups: one per raffle anyone on this instance is entered in. */
  raffles: RaffleReport;
  /** Things worth reading before exporting. None of them stop it. */
  warnings: string[];
};

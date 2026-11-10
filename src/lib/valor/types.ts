import type { ProfileSource } from "@/lib/valor/format";

/**
 * The shapes that cross between the server, the operator's browser and the Valor builder,
 * like lib/shikari/types.ts: the server sends a `DesiredValorInstance` -- what the vault says
 * one Valor instance should hold -- and `buildValorInstance` edits a copy of that instance's
 * backup to match, answering with a `ValorReport` for the review. Plain data throughout.
 */

/** One vault profile, as a Valor instance runs it. Carries secrets -- never logged. */
export type DesiredValorProfile = ProfileSource & {
  /** The vault profile's id. */
  key: string;
  ownerId: string;
  ownerName: string;
};

/** The mailbox a Target profile's sign-in codes arrive at: its own inbox, or one it forwards to. */
export type ValorMailbox = { server: string; email: string; password: string };

/** One product a Target task runs, at the qty its member picked -- or the standard qty. */
export type MiscProduct = { sku: string; qty: number };

/** A Target profile that picked from the Miscellaneous line. */
export type DesiredMiscProfile = DesiredValorProfile & {
  /** The Target password. Null: none on file, so only a login already in Valor can run it. */
  password: string | null;
  /** Null: the site doesn't know where its codes go -- a mailbox Valor already has stays. */
  mailbox: ValorMailbox | null;
  /** Its picks from the line, in catalog order. Never empty. */
  products: MiscProduct[];
};

/**
 * A profile the site holds, and why it isn't on this instance -- said beside one the export
 * takes out of it. `why` null: it is on this instance.
 */
export type KnownValorProfile = {
  site: "pkc" | "target";
  name: string;
  email: string;
  why: string | null;
};

export type DesiredValorInstance = {
  position: number;
  /** Pokémon Center main-bot profiles, for "ACO Main", in name order. */
  main: DesiredValorProfile[];
  /** Pokémon Center backup-bot profiles, for "ACO Backup", in name order. */
  backup: DesiredValorProfile[];
  /**
   * The Miscellaneous line's pickers, for the Target side. Null on an instance that doesn't
   * run it -- the first -- whose Target side, if it had one, would be left alone.
   */
  misc: DesiredMiscProfile[] | null;
  /** The line's products, for the review's names. */
  products: { sku: string; name: string }[];
  known: KnownValorProfile[];
};

export type ValorBuildOptions = {
  /** Draws every new id. crypto.randomUUID in the browser; seeded in tests. */
  uuid: () => string;
};

/** A profile in the report: who, whose, what changed or why. */
export type ValorProfileLine = { name: string; owner?: string; fields?: string[]; why?: string };

/** One task group's tasks, before and after. */
export type TaskGroupReport = {
  name: string;
  /** Profiles given a task they didn't have. */
  added: string[];
  /** Tasks taken out, by profile: its profile left, or it was a second copy. */
  removed: string[];
  /** Tasks kept as they were -- id, settings, product and all. */
  kept: number;
  /** Kept, with the profile name they show changed to the profile's new one. */
  renamed: number;
  /** Tasks for profiles in another group, which the export leaves where they are. */
  untouched: number;
  after: number;
};

export type ProfilesReport = {
  added: ValorProfileLine[];
  updated: ValorProfileLine[];
  /** Into the other of the two groups: main-bot to backup-bot or back. */
  moved: ValorProfileLine[];
  removed: ValorProfileLine[];
  unchanged: number;
};

/** One Target task, as the review shows it: its products, and the qty they share. */
export type MiscTaskLine = { skus: string[]; qty: number };

export type MiscReport = {
  profiles: Omit<ProfilesReport, "moved">;
  /** Picked from the line, but with no Target password on file and no login in Valor. */
  skipped: ValorProfileLine[];
  accounts: { added: string[]; updated: string[]; removed: number; unchanged: number };
  imap: {
    added: string[];
    updated: string[];
    removed: number;
    unchanged: number;
    /** Mailboxes a profile here needs that have no app password on the site or in Valor. */
    missing: string[];
  };
  tasks: {
    /** Profile by profile, what its tasks run before and after, for those that changed. */
    changed: { profile: string; before: MiscTaskLine[]; after: MiscTaskLine[] }[];
    /** Profiles whose tasks are as they were. */
    unchanged: number;
    /** Tasks for profiles outside "Target", left where they are. */
    untouched: number;
    after: number;
  };
};

export type ValorReport = {
  version: string;
  pkc: {
    profiles: ProfilesReport;
    main: number;
    backup: number;
    taskGroups: TaskGroupReport[];
  };
  /** Null on an instance that doesn't run the Miscellaneous line. */
  misc: MiscReport | null;
  /** Things worth reading before downloading. None of them stop the export. */
  warnings: string[];
};

import type { ShikariDb } from "@/lib/shikari/sqlite";

/**
 * Row counts of what changed, table by table, between the uploaded backup and the rebuilt
 * one -- computed by comparing the two states of the file, not by asking the builder what it
 * did.
 *
 * The build report says what the export MEANT to do; this says what the file actually holds,
 * and the two are checked against each other on the review screen. It is also the quickest
 * proof of what was left alone: an export that touched `harvester`, `config` or a
 * `cookie_jar` belonging to an account would show it here in black and white.
 *
 * Rows are compared by a hash of their values, taken once before the build and once after,
 * in the same database. Keeping every row's text twice instead -- or opening the file twice
 * -- would double the memory a 170 MB main-instance backup already takes in the browser.
 */

export type TableDiff = {
  table: string;
  before: number;
  after: number;
  added: number;
  removed: number;
  changed: number;
};

/** Table -> rowid -> a hash of that row's values. */
export type TableHashes = Map<string, Map<number, number>>;

/**
 * Tables no export has any business changing, whatever the operator ticks. A difference in
 * one of these is a bug, and the review refuses to download a file that has one.
 */
export const UNTOUCHABLE_TABLES = [
  "alembic_version",
  "captcha_service",
  "config",
  "custom_browser",
  "custom_shopify_store",
  "harvester",
  "harvester_group",
  "notification_config",
  "sms_service",
] as const;

/**
 * cyrb53: a fast 53-bit string hash. Two different rows colliding is a one in 2^53 chance
 * per comparison -- for a cross-check on a review screen, never a problem worth the memory
 * of storing the rows themselves.
 */
function hash(text: string): number {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/** Every row of every table, hashed. Take one before a build and one after. */
export function tableHashes(db: ShikariDb): TableHashes {
  const tables = db
    .all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .map((t) => t.name);
  const result: TableHashes = new Map();
  for (const table of tables) {
    // Names come from sqlite_master of a file the operator chose; quoted, with any embedded
    // quote doubled, so even a hostile name cannot break out of the identifier.
    const quoted = `"${table.replaceAll('"', '""')}"`;
    const rows = new Map<number, number>();
    for (const [rowid, ...values] of db.values(`SELECT rowid, * FROM ${quoted}`)) {
      rows.set(
        Number(rowid),
        hash(JSON.stringify(values, (_, v) => (v instanceof Uint8Array ? [...v] : v))),
      );
    }
    result.set(table, rows);
  }
  return result;
}

export function diffTables(before: TableHashes, after: TableHashes): TableDiff[] {
  const names = [...new Set([...before.keys(), ...after.keys()])].sort();
  return names.map((table) => {
    const old = before.get(table) ?? new Map<number, number>();
    const next = after.get(table) ?? new Map<number, number>();
    let added = 0;
    let removed = 0;
    let changed = 0;
    for (const [rowid, value] of next) {
      const was = old.get(rowid);
      if (was === undefined) added += 1;
      else if (was !== value) changed += 1;
    }
    for (const rowid of old.keys()) if (!next.has(rowid)) removed += 1;
    return { table, before: old.size, after: next.size, added, removed, changed };
  });
}

/** The untouchable tables a rebuild changed anyway. Empty, or the export is refused. */
export function forbiddenChanges(diffs: TableDiff[]): string[] {
  const untouchable = new Set<string>(UNTOUCHABLE_TABLES);
  return diffs
    .filter((d) => untouchable.has(d.table) && d.added + d.removed + d.changed > 0)
    .map((d) => d.table);
}

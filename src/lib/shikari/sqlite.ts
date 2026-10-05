import type { Database, SqlJsStatic, SqlValue } from "sql.js";

/**
 * A Shikari backup, opened.
 *
 * Shikari's `.bak` is not an archive or an export format: it is the bot's own SQLite
 * database, copied whole. So "updating a backup in place" means editing that database and
 * handing the same file back -- every row the export does not touch (logged-in sessions,
 * cookie jars, harvesters, the licence key) survives byte for byte, because nothing ever
 * read it out and wrote it back.
 *
 * This runs IN THE OPERATOR'S BROWSER, under sql.js (SQLite compiled to WebAssembly). The
 * backup is never uploaded: it holds every member's card and password in clear, every
 * account's live session, the proxy credentials and the Shikari licence, and the only thing
 * the export needs from the server is the vault data the server already has. See
 * lib/shikari/load-sqljs.ts for how the engine is loaded, and the export page for the rest.
 *
 * Deliberately a thin wrapper over sql.js rather than an abstraction over SQLite engines:
 * the tests run the same build of the same engine the browser does, so nothing here can
 * behave one way under vitest and another in production.
 */

export type SqlParam = SqlValue;
export type Row = Record<string, SqlValue>;

/** "SQLite format 3\0" -- the first sixteen bytes of every SQLite database file. */
const MAGIC = [83, 81, 76, 105, 116, 101, 32, 102, 111, 114, 109, 97, 116, 32, 51, 0];

/**
 * Header bytes 18 and 19, the file format's write and read versions: 1 for a rollback
 * journal, 2 for WAL. Shikari keeps its database in WAL mode, and its backups carry that.
 */
const WRITE_VERSION = 18;
const READ_VERSION = 19;

export class ShikariDb {
  constructor(private readonly db: Database) {}

  /** Every row, as plain objects keyed by column name. */
  all<T = Row>(sql: string, params: SqlParam[] = []): T[] {
    const statement = this.db.prepare(sql);
    try {
      statement.bind(params);
      const rows: T[] = [];
      while (statement.step()) rows.push(statement.getAsObject() as T);
      return rows;
    } finally {
      statement.free();
    }
  }

  /** The first row, or null. */
  get<T = Row>(sql: string, params: SqlParam[] = []): T | null {
    return this.all<T>(sql, params)[0] ?? null;
  }

  /** Rows as bare value arrays: cheaper than objects when a table has eighty thousand. */
  values(sql: string, params: SqlParam[] = []): SqlValue[][] {
    const statement = this.db.prepare(sql);
    try {
      statement.bind(params);
      const rows: SqlValue[][] = [];
      while (statement.step()) rows.push(statement.get());
      return rows;
    } finally {
      statement.free();
    }
  }

  /** Runs a statement; answers how many rows it changed. */
  run(sql: string, params: SqlParam[] = []): number {
    this.db.run(sql, params);
    return this.db.getRowsModified();
  }

  /** Runs an INSERT and returns the new row's id. */
  insert(sql: string, params: SqlParam[] = []): number {
    this.db.run(sql, params);
    return Number(this.get<{ id: number }>("SELECT last_insert_rowid() AS id")?.id);
  }

  /**
   * One statement, prepared once and run many times -- what keeps rewriting a
   * fifty-thousand-line proxy list in the tens of milliseconds rather than seconds.
   */
  prepare(sql: string): { run(params: SqlParam[]): void; free(): void } {
    const statement = this.db.prepare(sql);
    return {
      run: (params) => statement.run(params),
      free: () => void statement.free(),
    };
  }

  /** Every statement passed in, or none of them. */
  transaction<T>(work: () => T): T {
    this.db.run("BEGIN");
    try {
      const result = work();
      this.db.run("COMMIT");
      return result;
    } catch (error) {
      this.db.run("ROLLBACK");
      throw error;
    }
  }

  /** The raw file, as SQLite last wrote it. */
  bytes(): Uint8Array {
    return this.db.export();
  }

  close(): void {
    this.db.close();
  }
}

export class NotABackupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotABackupError";
  }
}

/** Whether these bytes are a SQLite database at all, checked before handing them to one. */
export function looksLikeSqlite(bytes: Uint8Array): boolean {
  return bytes.length >= 100 && MAGIC.every((byte, i) => bytes[i] === byte);
}

export type OpenBackup = {
  db: ShikariDb;
  /** Whether the file was in WAL mode, which `backupBytes` restores on the way out. */
  wal: boolean;
};

/**
 * Opens a backup from its bytes. The caller's array is never modified -- the original stays
 * pristine so the export can always be rebuilt from scratch, and diffed against.
 *
 * WAL MODE IS SWITCHED OFF FOR THE EDIT. sql.js keeps the database in an in-memory file
 * system that has no shared memory for a write-ahead log, so a write in WAL mode would land
 * in a `-wal` file that `export()` never includes. Bytes 18 and 19 are set to the
 * rollback-journal value before opening, which is exactly what `PRAGMA journal_mode=DELETE`
 * would write -- safe because a backup is one checkpointed file with no log beside it.
 * `backupBytes` puts them back, so Shikari gets its file in the mode it left it in.
 */
export function openBackup(SQL: SqlJsStatic, bytes: Uint8Array): OpenBackup {
  if (!looksLikeSqlite(bytes)) {
    throw new NotABackupError("That file isn't a Shikari backup — it isn't a SQLite database.");
  }
  const copy = new Uint8Array(bytes);
  const wal = copy[WRITE_VERSION] === 2 || copy[READ_VERSION] === 2;
  copy[WRITE_VERSION] = 1;
  copy[READ_VERSION] = 1;
  return { db: new ShikariDb(new SQL.Database(copy)), wal };
}

/** The file to hand back to Shikari: the edited database, in the journal mode it arrived in. */
export function backupBytes(open: OpenBackup): Uint8Array {
  const bytes = open.db.bytes();
  if (open.wal) {
    bytes[WRITE_VERSION] = 2;
    bytes[READ_VERSION] = 2;
  }
  return bytes;
}

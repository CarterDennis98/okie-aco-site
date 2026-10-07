import type { ShikariDb } from "@/lib/shikari/sqlite";

/**
 * The parts of Shikari's database the export reads and writes, and a check that a backup
 * still has them.
 *
 * Shikari is someone else's software and updates on its own schedule; its schema is
 * migrated with Alembic, and the versions these were read from are below. A newer one is not
 * refused on sight -- most migrations add a table or a nullable column that changes nothing
 * here -- but anything that WOULD change something is: a missing column, or a new required
 * column on a table the export inserts into, which Shikari's own code fills in and ours
 * would leave empty. Better a clear refusal on upload than a backup Shikari can't open.
 */

/**
 * The Alembic revisions of the backups these tables were read from: 2026-10-05's, and
 * 2026-10-06's, which gave tasks drag-and-drop order (see hasTaskOrder).
 */
export const KNOWN_SHIKARI_VERSIONS = ["d4e8b21c7f05", "e5b1c9d3a7f2"];

/**
 * Every column the export touches, per table. `inserts` marks the tables it creates rows
 * in -- the ones where an unknown NOT NULL column without a default is fatal. `optional`
 * columns are filled when a version has them, and done without when it doesn't.
 */
const TABLES: Record<string, { columns: string[]; optional?: string[]; inserts: boolean }> = {
  profile_group: {
    columns: ["id", "created_at", "updated_at", "name", "order_index"],
    inserts: true,
  },
  profile: {
    columns: [
      "id",
      "created_at",
      "updated_at",
      "name",
      "email",
      "shipping_address_id",
      "billing_address_id",
      "credit_card_id",
      "profile_group_id",
    ],
    inserts: true,
  },
  address: {
    columns: [
      "id",
      "created_at",
      "updated_at",
      "first_name",
      "last_name",
      "street",
      "street_2",
      "city",
      "state",
      "zip_code",
      "country",
      "phone_number",
    ],
    inserts: true,
  },
  credit_card: {
    columns: [
      "id",
      "created_at",
      "updated_at",
      "card_number",
      "expire_month",
      "expire_year",
      "cvv",
    ],
    inserts: true,
  },
  account: {
    columns: [
      "id",
      "created_at",
      "updated_at",
      "username",
      "password",
      "website_id",
      "generic_data",
      "session_data",
      "cookie_jar_id",
      "mobile_cookie_jar_id",
    ],
    inserts: true,
  },
  imap_account: {
    columns: [
      "id",
      "created_at",
      "updated_at",
      "imap_server",
      "port",
      "username",
      "password",
      "is_enabled",
    ],
    inserts: true,
  },
  proxy_group: { columns: ["id", "name", "order_index"], inserts: false },
  proxy: {
    columns: [
      "id",
      "created_at",
      "updated_at",
      "proxy_group_id",
      "host",
      "port",
      "username",
      "password",
    ],
    inserts: true,
  },
  task_group: {
    columns: ["id", "created_at", "updated_at", "name", "color", "avatar", "order_index"],
    inserts: true,
  },
  task: {
    columns: [
      "id",
      "created_at",
      "updated_at",
      "task_group_id",
      "running",
      "preloaded",
      "start_time",
      "type",
      "website_id",
      "profile_id",
      "generic_data",
      "captcha_service_id",
      "browser_id",
      "sms_service_id",
      "imap_account_id",
      "flow_key",
      "options",
      "state",
      "target_kind",
    ],
    optional: ["order_index"],
    inserts: true,
  },
  target_product: {
    columns: [
      "id",
      "created_at",
      "updated_at",
      "task_id",
      "target_method",
      "target_data",
      "min_price",
      "max_price",
      "qty",
      "miscellaneous_data",
    ],
    inserts: true,
  },
  browser: {
    columns: [
      "id",
      "created_at",
      "updated_at",
      "proxy_group_id",
      "proxy_id",
      "fingerprint_name",
      "cookie_jar_id",
    ],
    inserts: true,
  },
  cookie_jar: { columns: ["id", "created_at", "updated_at", "cookies"], inserts: true },
  // Read only: a browser a harvester uses is never deleted along with a task.
  harvester: { columns: ["id", "browser_id"], inserts: false },
};

type ColumnInfo = { name: string; notnull: number; dflt_value: unknown; pk: number };

export type SchemaCheck =
  | { ok: true; version: string | null; newerVersion: boolean }
  | { ok: false; version: string | null; problems: string[] };

export function checkShikariSchema(db: ShikariDb): SchemaCheck {
  const tables = new Set(
    db
      .all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
      .map((t) => t.name),
  );
  const version = tables.has("alembic_version")
    ? (db.get<{ version_num: string }>("SELECT version_num FROM alembic_version")?.version_num ??
      null)
    : null;

  const problems: string[] = [];
  for (const [table, spec] of Object.entries(TABLES)) {
    if (!tables.has(table)) {
      problems.push(`no ${table} table`);
      continue;
    }
    // Table names come from the constant above, never from the file, so interpolating
    // them is not an injection path.
    const columns = db.all<ColumnInfo>(`PRAGMA table_info("${table}")`);
    const names = new Set(columns.map((c) => c.name));
    for (const column of spec.columns) {
      if (!names.has(column)) problems.push(`no ${table}.${column} column`);
    }
    if (!spec.inserts) continue;
    const known = new Set([...spec.columns, ...(spec.optional ?? [])]);
    for (const column of columns) {
      const required = column.notnull === 1 && column.dflt_value === null && column.pk === 0;
      if (required && !known.has(column.name)) {
        problems.push(
          `${table}.${column.name} is required and the export doesn't know how to fill it`,
        );
      }
    }
  }

  if (problems.length > 0) return { ok: false, version, problems };
  return {
    ok: true,
    version,
    newerVersion: version !== null && !KNOWN_SHIKARI_VERSIONS.includes(version),
  };
}

/**
 * Whether a backup's tasks have a place in their group: `task.order_index`, which Shikari
 * added with drag-and-drop reordering (e5b1c9d3a7f2) and lists a group by. Before it,
 * Shikari listed a group by task id.
 */
export function hasTaskOrder(db: ShikariDb): boolean {
  return db.all<ColumnInfo>('PRAGMA table_info("task")').some((c) => c.name === "order_index");
}

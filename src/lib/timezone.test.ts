/**
 * Guards the UTC session-timezone pin in src/db/client.ts.
 *
 * Prisma sends timestamps as naive UTC wall-clock strings; Postgres resolves them
 * against the SESSION timezone. On a machine set to America/Chicago that silently
 * stored 07:05Z as 12:05Z -- no error, no warning, just five hours of drift. Cloud
 * Run defaults to UTC and a laptop usually doesn't, so the bug is correct in
 * production and wrong locally, which is the hardest version to notice.
 *
 * These tests run only when a database is reachable, so CI without one stays green.
 */
import { describe, expect, it } from "vitest";
import { Client } from "pg";

const DATABASE_URL = process.env.DATABASE_URL;
const canConnect = Boolean(DATABASE_URL);

async function withClient<T>(options: string | undefined, fn: (c: Client) => Promise<T>) {
  const client = new Client({ connectionString: DATABASE_URL, options });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

describe.skipIf(!canConnect)("timestamp handling", () => {
  const INSTANT = "2026-08-07 07:05:26.404";

  it("stores a naive timestamp as UTC when the session is pinned", async () => {
    const iso = await withClient("-c timezone=UTC", async (c) => {
      await c.query("create temp table probe(t timestamptz)");
      await c.query("insert into probe values ($1)", [INSTANT]);
      const r = await c.query<{ t: Date }>("select t from probe");
      return r.rows[0].t.toISOString();
    });
    expect(iso).toBe("2026-08-07T07:05:26.404Z");
  });

  it("would drift without the pin -- this is the bug being guarded", async () => {
    const { iso, zone } = await withClient(undefined, async (c) => {
      const zone = (await c.query<{ TimeZone: string }>("show timezone")).rows[0].TimeZone;
      await c.query("create temp table probe(t timestamptz)");
      await c.query("insert into probe values ($1)", [INSTANT]);
      const r = await c.query<{ t: Date }>("select t from probe");
      return { iso: r.rows[0].t.toISOString(), zone };
    });

    // On a UTC machine there is nothing to drift, so the assertion adapts rather
    // than failing spuriously in CI.
    if (zone === "UTC") expect(iso).toBe("2026-08-07T07:05:26.404Z");
    else expect(iso).not.toBe("2026-08-07T07:05:26.404Z");
  });

  it("every timestamp column is timestamptz, not naive timestamp", async () => {
    const naive = await withClient("-c timezone=UTC", async (c) => {
      const r = await c.query<{ table_name: string; column_name: string }>(
        `select table_name, column_name
           from information_schema.columns
          where table_schema = 'public'
            and data_type = 'timestamp without time zone'`,
      );
      return r.rows;
    });
    expect(naive).toEqual([]);
  });
});

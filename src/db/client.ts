import "server-only";

import { PrismaPg } from "@prisma/adapter-pg";
import { Prisma, PrismaClient } from "@/generated/prisma/client";

// Prisma 7 dropped the Rust query engine; a driver adapter is now required and
// `new PrismaClient()` with no arguments is a compile error. Pool settings live on
// the pg config -- `?connection_limit=N` in the URL is silently ignored in v7.

// Per container instance. Multiply by Cloud Run max-instances and keep the product
// comfortably under Cloud SQL's max_connections (~25 on db-f1-micro).
const MAX_POOL = Number(process.env.DB_POOL_MAX ?? 3);

/**
 * Pin every session to UTC.
 *
 * Prisma sends timestamps as naive strings in UTC wall-clock form. Postgres then
 * resolves them using the SESSION timezone -- so on a machine set to America/Chicago
 * an instant of 07:05Z gets stored as 12:05Z, silently, with no error. Cloud Run
 * defaults to UTC and a developer laptop usually doesn't, which is the worst version
 * of this bug: correct in production, wrong locally, and invisible in both.
 */
const PG_OPTIONS = "-c timezone=UTC";

function buildAdapter() {
  // On Cloud Run the Cloud SQL connector exposes a Unix socket rather than a host.
  const connectionName = process.env.CLOUD_SQL_CONNECTION_NAME;

  if (connectionName) {
    return new PrismaPg({
      host: `/cloudsql/${connectionName}`,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
      ssl: false, // never TLS over a Unix socket
      options: PG_OPTIONS,
      max: MAX_POOL,
      // pg defaults to no connect timeout, unlike the v6 engine's 5s. Without this a
      // bad socket path hangs the request instead of failing.
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 30_000,
    });
  }

  return new PrismaPg({
    connectionString: process.env.DATABASE_URL,
    options: PG_OPTIONS,
    max: MAX_POOL,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
  });
}

// Next's dev server re-evaluates modules on every edit; without this each reload
// would open another pool and exhaust Postgres within a few saves.
//
// Kept with the schema it was generated from. After a schema change and `prisma generate`,
// a client cached from before doesn't know the new tables or columns, and every query that
// touches them fails until the dev server restarts -- so one from another generation isn't
// reused. Compared by content (every model's fields), not by class, because the dev server
// can hold more than one copy of the generated module at once, and they must share. The old
// client is left open rather than closed, for the same reason: one idle pool, in dev only.
const generation = JSON.stringify(
  Object.entries(Prisma)
    .filter(([name]) => name.endsWith("ScalarFieldEnum"))
    .sort(([a], [b]) => a.localeCompare(b)),
);

const globalForPrisma = globalThis as unknown as {
  prisma?: PrismaClient;
  prismaGeneration?: string;
};

export const prisma =
  (globalForPrisma.prismaGeneration === generation ? globalForPrisma.prisma : undefined) ??
  new PrismaClient({ adapter: buildAdapter() });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
  globalForPrisma.prismaGeneration = generation;
}

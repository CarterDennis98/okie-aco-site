import "server-only";

import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";

// Prisma 7 dropped the Rust query engine; a driver adapter is now required and
// `new PrismaClient()` with no arguments is a compile error. Pool settings live on
// the pg config -- `?connection_limit=N` in the URL is silently ignored in v7.

// Per container instance. Multiply by Cloud Run max-instances and keep the product
// comfortably under Cloud SQL's max_connections (~25 on db-f1-micro).
const MAX_POOL = Number(process.env.DB_POOL_MAX ?? 3);

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
      max: MAX_POOL,
      // pg defaults to no connect timeout, unlike the v6 engine's 5s. Without this a
      // bad socket path hangs the request instead of failing.
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 30_000,
    });
  }

  return new PrismaPg({
    connectionString: process.env.DATABASE_URL,
    max: MAX_POOL,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
  });
}

// Next's dev server re-evaluates modules on every edit; without this each reload
// would open another pool and exhaust Postgres within a few saves.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma = globalForPrisma.prisma ?? new PrismaClient({ adapter: buildAdapter() });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;

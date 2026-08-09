# okie-aco-site

Website and API for Okie ACO. Members sign in with Discord to see their checkouts and
unpaid PAS fees; the admin edits item fees and profile mappings.

Companion to [okie-aco-mirror](https://github.com/CarterDennis98/okie-aco-mirror), the
Discord bot that mirrors vendor checkout embeds and sends PAS fee DMs. **Postgres is the
single source of truth** — the bot reads and writes it through this app's API, never
directly, so normalization and idempotency have exactly one implementation.

## Stack

Next.js 16 (App Router) · TypeScript · Prisma + Postgres · Auth.js v5 (Discord) ·
Tailwind v4 · deployed to Cloud Run with Cloud SQL.

## Local development

Requires Node 24 and a local PostgreSQL 17 with an `okie-aco` database. One-time database
setup, run in pgAdmin's Query Tool **while connected to `okie-aco`**:

```sql
CREATE ROLE okie LOGIN CREATEDB PASSWORD 'okie';
ALTER DATABASE "okie-aco" OWNER TO okie;
GRANT ALL ON SCHEMA public TO okie;
ALTER SCHEMA public OWNER TO okie;
```

`CREATEDB` is required for `prisma migrate dev`'s shadow database. The schema grants are
required because PostgreSQL 15 dropped the implicit `CREATE` on `public` — without them
the first migration fails with `permission denied for schema public`.

Then:

```bash
cp .env.example .env
npm install
npm run db:migrate
npm run db:seed
npm run dev
```

Use `.env`, not `.env.local`. Next reads both, but the Prisma CLI only reads `.env`, so a
single file keeps the app and migrations from disagreeing about the database.

The seed imports real billing-run records from the bot repo (`MIRROR_REPO_PATH`, defaults
to `../okie-aco-mirror`), so local data carries the actual product names — including the
`é` and em-dash that catch UTF-8 bugs — plus 147 checkouts and 61 members.

`docker-compose.yml` is a fallback if you ever want a guaranteed-clean instance:
`npm run db:up` starts one on **5433**, since 5432 is taken by the native install. Point
`DATABASE_URL` at it and everything else is unchanged.

## Notable constraints

- **Authorization is enforced in the data layer**, not in proxy/middleware or layouts —
  every page, route handler, and server action calls its own guard. Next's own docs make
  this point: a matcher change or moving a Server Function to another route silently
  removes proxy coverage.
- **Money is integer cents everywhere**, matching the bot.
- **Discord snowflake IDs are strings**, never numbers — they exceed 2^53.
- **Sent bills are immutable.** Fee edits apply to future billing runs only.

## Next.js 16 notes

This is Next 16, which differs from 14/15 in ways worth writing down. `AGENTS.md` points at
the bundled docs in `node_modules/next/dist/docs/`; read them before writing framework code.

- `middleware.ts` is now `proxy.ts`, and it is Node-runtime only — `export const runtime`
  throws there.
- `params`, `searchParams`, `cookies()`, and `headers()` are all Promises and must be
  awaited. The Next 15 sync fallback is gone.
- `export const runtime = "nodejs"` is unnecessary — it's the default, and Edge is
  deprecated.
- `@prisma/client` is already on Next's built-in `serverExternalPackages` list, so it needs
  no config. Only add `outputFileTracingIncludes` if the container actually fails to find
  the query engine at runtime.
- Turbopack builds by default. **Adding any webpack config makes `next build` fail** unless
  you pass `--webpack`.
- `revalidateTag` now requires a second cache-profile argument.

### Cloud Run specifics

- `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` **must be set and stable across instances.** It
  otherwise defaults to a per-build random value, and mutations fail across instances with
  "Failed to find Server Action".
- ISR cache is per-instance local disk. The home page revalidates independently on each
  container — acceptable at `max-instances=3`, but it means `revalidateTag` on one instance
  does not invalidate the others.
- Set `deploymentId` for version-skew protection during rolling revisions.

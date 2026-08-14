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

### Refreshing local data after a drop

```bash
node src/scripts/exportCheckouts.js 2026-04-01
```

in the bot repo, then `npm run db:seed` here. The bot repo's README covers this from the
operator side, along with the other maintenance scripts — keep the two in step if either
changes. Always export the **full range**, not just
the new days: the script overwrites `checkouts-export.json` rather than appending, and
that file is your restore point after `db:reset`. The seed itself is additive
(`createMany({ skipDuplicates: true })` plus upserts), so re-running never duplicates.

Charges only appear for runs whose session status is `sent` — the seed skips previews, so
a dry-run drop shows its checkouts but no bill.

**Product thumbnails need no separate step.** `parseCheckoutEmbed` returns `thumbnailUrl`,
the export carries it inline, and the seed writes it to both `Checkout.imageUrl` (as
observed) and `Item.imageUrl` (canonical, used for display with the checkout's own as
fallback). `src/scripts/exportThumbnails.js` in the bot repo is a superseded stopgap: it
only covered the archived `pas-sessions/*.json` windows, which predate thumbnail capture,
and a full-range export now covers those too.

Images are stored as Discord's **unsigned** external-proxy URLs
(`images-ext-1.discordapp.net/external/<hash>/https/<original>`) — no `?ex=`/`&hm=` expiry
parameters, so they don't rot after 24 hours the way signed attachment CDN links do. That
form is also why `next.config.ts` needs only the two `**.discordapp.*` remote patterns to
cover every retailer.

**Every Postgres connection pins `timezone=UTC`** (`src/db/client.ts`, `prisma/seed.ts`).
Prisma sends timestamps as naive UTC wall-clock strings and Postgres resolves them against
the _session_ timezone — so on a machine set to `America/Chicago`, 07:05Z silently stored as
12:05Z. Cloud Run defaults to UTC and a laptop usually doesn't, which makes this correct in
production and wrong locally. `src/lib/timezone.test.ts` guards it.

`docker-compose.yml` is a fallback if you ever want a guaranteed-clean instance:
`npm run db:up` starts one on **5433**, since 5432 is taken by the native install. Point
`DATABASE_URL` at it and everything else is unchanged.

## Brand assets

Drop the logo at **`public/okie-logo.png`** — transparent background, at least 400px tall so
it stays crisp on retina. `src/components/brand.tsx` checks for the file at render time and
falls back to a text wordmark until it exists, so a missing logo degrades rather than
breaking. Delete `WordmarkFallback` once the real file is in.

A favicon can go at `src/app/icon.png` (Next picks it up by convention, no config).

Palette lives in `@theme` in `src/app/globals.css`. The contrast figures are recorded there
because they constrain usage: **brand red on the dark background is 3.84:1**, which passes
for large text and UI shapes but _fails_ AA for body copy. Red is for the logo, button
fills, and accent marks — never small text. White on red is 4.88:1 and is fine.

## Auth

Discord OAuth via Auth.js v5, database sessions, no email.

**Discord Developer Portal setup** (same application as the bot):

1. OAuth2 → copy the **Application ID** into `AUTH_DISCORD_ID` and the **OAuth2 client
   secret** — not the bot token — into `AUTH_DISCORD_SECRET`.
2. OAuth2 → Redirects → add both, on the one application:
   - `http://localhost:3000/api/auth/callback/discord`
   - `https://okie-aco.com/api/auth/callback/discord`

Scopes are `identify guilds.members.read`, set explicitly in `src/lib/auth/index.ts`.
The built-in provider defaults to `identify email`; the override is the only thing
keeping an email address out of the database. `guilds.members.read` covers one guild —
the broader `guilds` scope would expose every server a member is in.

The 404 from `GET /users/@me/guilds/{id}/member` **is** the membership check. A non-404
failure is treated as transient, never as "not a member", so a Discord outage can't
lock out a paying member. That lookup also refreshes `DiscordMember` (roles, OG,
avatar), which is why OG status is correct from the first login without waiting on the
bot's role sync — and why `User.discordUserId`'s foreign key resolves at createUser time.

The adapter is hand-written (`src/lib/auth/adapter.ts`) rather than
`@auth/prisma-adapter`: that package is typed against `PrismaClient` from
`@prisma/client`, requires a non-null `email`, and offers nowhere to set
`discordUserId` at insert time. `src/lib/auth/adapter.test.ts` covers the lifecycle
against a real database, including the assertion that **Discord access and refresh
tokens are never persisted** — we never call Discord as the user, so holding a live
credential would be pure liability.

### Authorization

The boundary is `src/lib/auth/guard.ts`, and it is called **inside every page, route
handler, and server action** — never in a layout, never in `proxy.ts`. Layouts don't
re-render on navigation and don't wrap Server Actions; Next's CVE-2025-29927 was a
crafted header skipping middleware outright.

- `requireMember()` redirects to `/signin`. `requireAdmin()` returns **404, not 403** —
  a 403 confirms the admin routes exist.
- **The session carries identity and nothing else.** `isOg` is re-read from the database
  and `isAdmin` from `ADMIN_DISCORD_IDS` on every request, so a role change takes effect
  immediately instead of when a cookie expires.
- Member queries take `discordUserId` as a **required first argument**, sourced only
  from the guard's return value. Resource lookups carry both predicates
  (`where: { id, discordUserId }`) rather than fetch-then-compare, which is what makes a
  guessed charge id indistinguishable from a nonexistent one.

`src/db/queries/member.test.ts` covers that last rule directly. It has been
mutation-checked: removing `discordUserId` from the `where` clause makes it fail.

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
- Any ISR cache is per-instance local disk, so `revalidateTag` on one container does not
  invalidate the others. Nothing uses ISR today (see below), but it constrains what can.
- Set `deploymentId` for version-skew protection during rolling revisions.

## Container

```bash
docker build -t okie-aco-site:dev .
```

```bash
docker run --rm -p 8080:8080 -e DATABASE_URL="postgresql://okie:okie@host.docker.internal:5432/okie-aco" okie-aco-site:dev
```

`host.docker.internal` reaches the native Postgres from inside the container; on Cloud Run
you set `CLOUD_SQL_CONNECTION_NAME` + `DB_*` instead and `src/db/client.ts` switches to the
connector's Unix socket.

**The build needs no database**, which is the reason `/` is `force-dynamic` rather than ISR.
ISR would prerender the page during `next build` — inside the Docker build, where there is
no Postgres and must not be one. Giving CI a tunnel into Cloud SQL just to produce an image
is a much worse trade than six indexed queries per request for a 66-person Discord. The
upgrade path, if traffic ever makes that false, is `cacheComponents: true` plus `"use cache"`
on the query functions, which caches the data without making the route a build artifact.

Two Dockerfile lines are load-bearing and look like boilerplate:

- **`ENV HOSTNAME=0.0.0.0`** — without it Next's standalone server binds to localhost, the
  Cloud Run health check never connects, and the deploy error says nothing about the cause.
- **`COPY .next/static` and `COPY public`** — neither is traced into `.next/standalone`. Omit
  them and you get a container that serves HTML with no CSS and no images.

`prisma migrate deploy` is deliberately **not** run on boot. Three instances starting at once
race the migration table, and a failed migration would take the site down rather than failing
loudly in one place. Run it by hand through the Cloud SQL Auth Proxy.

Base image is `node:24-slim`. The usual reason to avoid alpine was Prisma's Rust query engine
and its musl target; Prisma 7 removed that engine, so alpine would now work. Slim stays for
glibc and full ICU — `Intl.DateTimeFormat` with `America/Chicago` is on the drop cards, and
the container otherwise runs UTC.

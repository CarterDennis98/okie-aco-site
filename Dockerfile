# syntax=docker/dockerfile:1
#
# Production image for Cloud Run.
#
# Base image note: the usual reason to avoid alpine here was Prisma's Rust query
# engine, whose musl target is the classic "Query engine binary not found" failure.
# Prisma 7 removed that engine entirely -- the query compiler now ships as
# base64-embedded WASM inside plain .js files under @prisma/client/runtime -- so alpine
# would work. We stay on Debian slim anyway for glibc and full ICU, which keeps
# Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago" }) behaving exactly as it
# does in development. That formatting is on the drop cards, so it is visible.
#
# The build needs NO database. `/` is force-dynamic, so nothing is prerendered at build
# time and CI never has to tunnel into Cloud SQL to produce an image.

# ---------------------------------------------------------------------------
# deps -- install once, cached on the lockfile
# ---------------------------------------------------------------------------
FROM node:24-slim AS deps
WORKDIR /app

# package.json's postinstall runs `prisma generate`, which reads prisma.config.ts and
# the schema. Both have to be present before `npm ci`, not after.
COPY package.json package-lock.json prisma.config.ts ./
COPY prisma ./prisma

RUN npm ci

# ---------------------------------------------------------------------------
# builder
# ---------------------------------------------------------------------------
FROM node:24-slim AS builder
WORKDIR /app

ENV NEXT_TELEMETRY_DISABLED=1

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Regenerate rather than inherit: .dockerignore drops src/generated from the context,
# and the deps stage's copy lives in a layer we don't pull from. `next build` compiles
# this TypeScript directly, so it must exist and must match this schema.
#
# This logs "Prisma failed to detect the libssl/openssl version". Expected and harmless:
# it is @prisma/get-platform probing for the system libssl needed to pick a Rust engine
# binary, and v7 ships no such binary. Node has OpenSSL 3.5 linked in for real TLS. We
# deliberately do NOT `apt-get install openssl` to silence it -- that would imply the
# package matters here, and the next person would keep it forever.
RUN npx prisma generate

RUN npm run build

# ---------------------------------------------------------------------------
# runner
# ---------------------------------------------------------------------------
FROM node:24-slim AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
# Load-bearing on Cloud Run. Without it Next's standalone server binds to localhost,
# the container never answers the health check, and the deploy failure says nothing
# about the cause. This is the single most common Next-on-Cloud-Run mistake.
ENV HOSTNAME=0.0.0.0
# Cloud Run injects PORT; this is the default for `docker run` and matches its 8080.
ENV PORT=8080

RUN groupadd --system --gid 1001 nodejs \
  && useradd --system --uid 1001 --gid nodejs nextjs

# `output: "standalone"` traces the runtime dependency graph into .next/standalone,
# including @prisma/client and pg. Static assets and public/ are not traced and are
# copied separately -- omitting either yields a running server with no CSS.
COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

USER nextjs
EXPOSE 8080

CMD ["node", "server.js"]

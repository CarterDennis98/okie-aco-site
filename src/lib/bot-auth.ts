import "server-only";

import { timingSafeEqual } from "node:crypto";

/**
 * Bearer auth for the bot's endpoints.
 *
 * Checked BEFORE the body is read, so an unauthenticated caller can't make the server
 * parse a megabyte of JSON on their behalf.
 *
 * Two tokens are accepted so rotation isn't a coordinated outage: set the new one as
 * `BOT_INGEST_TOKEN`, move the old to `BOT_INGEST_TOKEN_PREVIOUS`, deploy, update the
 * bot, then drop the previous. Both are compared in constant time.
 *
 * `timingSafeEqual` throws on a length mismatch, so length is checked first -- and the
 * length check itself leaks only the token's length, which is fixed and public.
 */

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export type BotAuthResult = { ok: true } | { ok: false; status: number; error: string };

export function authorizeBot(request: Request): BotAuthResult {
  const current = process.env.BOT_INGEST_TOKEN;
  const previous = process.env.BOT_INGEST_TOKEN_PREVIOUS;

  // A missing token must not mean "everything is allowed". Refuse instead.
  if (!current) {
    console.error("bot ingest: BOT_INGEST_TOKEN is not configured; refusing all requests");
    return { ok: false, status: 503, error: "Ingest is not configured" };
  }

  const header = request.headers.get("authorization") ?? "";
  if (!header.startsWith("Bearer ")) {
    return { ok: false, status: 401, error: "Unauthorized" };
  }
  const presented = header.slice("Bearer ".length);

  // Both comparisons always run: short-circuiting on the first would make the response
  // time say which token matched.
  const matchesCurrent = safeEqual(presented, current);
  const matchesPrevious = previous ? safeEqual(presented, previous) : false;

  if (!matchesCurrent && !matchesPrevious) {
    return { ok: false, status: 401, error: "Unauthorized" };
  }
  return { ok: true };
}

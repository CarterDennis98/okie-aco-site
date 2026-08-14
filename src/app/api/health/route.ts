/**
 * Liveness probe for Cloud Run.
 *
 * Deliberately does NOT touch the database. A health endpoint that fails on a
 * transient Postgres blip tells Cloud Run to recycle every instance at exactly the
 * moment the database is already struggling. Process-is-up is the question a liveness
 * probe should answer.
 *
 * Database reachability is proven by the home page, which renders from Postgres on
 * every request.
 */
export const dynamic = "force-dynamic";

export function GET() {
  return Response.json({
    ok: true,
    // Set by CI to the deploying commit, so a running revision can be identified
    // without cross-referencing the Cloud Run console.
    revision: process.env.APP_REVISION ?? "dev",
    uptimeSeconds: Math.round(process.uptime()),
  });
}

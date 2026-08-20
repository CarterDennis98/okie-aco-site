import type { NextConfig } from "next";

/**
 * Origins permitted to POST a Server Action.
 *
 * Every mutation on this site is a Server Action, and Next's built-in CSRF defence is an
 * Origin/Host comparison. Behind Cloud Run the app sees the container's own host, not the
 * domain the browser used, so without declaring the real origins here every action would
 * be rejected -- or, worse, the check would be relaxed to compensate.
 *
 * Read at server start, not baked in at build time, so the same image runs against the
 * Cloud Run URL and the custom domain without a rebuild.
 */
function serverActionOrigins(): string[] {
  const origins = new Set(["okie-aco.com", "www.okie-aco.com"]);

  // The *.run.app URL, and anything else fronting the app. Comma-separated hosts.
  for (const entry of (process.env.SERVER_ACTIONS_ALLOWED_ORIGINS ?? "").split(",")) {
    const host = entry.trim();
    if (host) origins.add(host);
  }

  // AUTH_URL is already the canonical origin in every environment; deriving from it
  // keeps the two from drifting apart when a domain changes.
  try {
    const { host } = new URL(process.env.AUTH_URL ?? "");
    if (host) origins.add(host);
  } catch {
    // Unset or malformed -- the defaults above still apply.
  }

  return [...origins];
}

/**
 * The one hostname this site is served on.
 *
 * A CONSTANT, not derived from AUTH_URL, and that is the whole point. `redirects()` is
 * evaluated once during `next build` and compiled into routes-manifest.json -- unlike
 * `allowedOrigins` above, it is never re-read when the server boots. The build happens in
 * Cloud Build, where AUTH_URL does not exist, so anything derived from it would resolve to
 * the fallback in production and to a developer's `.env` value in a local image. That is a
 * config whose behaviour depends on which machine ran the build.
 *
 * `.dockerignore` excludes `.env*` for exactly this class of reason, so today a local
 * `setup.sh build` happens to bake the right value. This does not lean on that.
 *
 * Override only if the canonical domain itself changes, and rebuild: a bare hostname, no
 * scheme, no port (a `has` host matcher is compared against the hostname with the port
 * already stripped, so "localhost:3000" would match nothing -- including itself).
 */
function canonicalHost(): string {
  return process.env.CANONICAL_HOST?.trim() || "okie-aco.com";
}

const nextConfig: NextConfig = {
  // Required for the Cloud Run container: emits .next/standalone with a minimal
  // server.js and only the traced dependencies.
  output: "standalone",

  /**
   * www -> apex.
   *
   * Typing "www.okie-aco.com" got nothing at all: only the apex is mapped in Cloud Run
   * and only the apex has DNS, so the name never resolved. Fixing that needs the mapping
   * and the CNAME (see `./infra/setup.sh domain`) -- this is the other half, and it has to
   * exist before the mapping does.
   *
   * A REDIRECT rather than serving both. Auth is an Origin/Host comparison and the Discord
   * redirect URI names one host; two live hostnames means a session started on one and a
   * callback landing on the other, which fails in a way that looks like a broken login
   * rather than a misconfigured domain. One canonical origin, everything else bounces to it.
   *
   * TEMPORARY (307), DELIBERATELY, and this should become permanent once it has run in
   * production. Both 307 and 308 preserve the method and body -- which is what matters on a
   * site where every mutation is a POST Server Action, and why neither is 301/302. They
   * differ in caching: a 308 is cacheable by default and browsers persist it, so shipping
   * one before this had ever served a real request would bake an unproven redirect into
   * every member's browser with no way to recall it. 307 is re-checked every time.
   *
   * Flip `permanent` to true once `curl -sSI https://www.<host>` has been confirmed good,
   * and REBUILD -- see canonicalHost() on why a redeploy alone won't do it.
   */
  async redirects() {
    const host = canonicalHost();
    // Nothing to send anywhere when the app IS the www host, and a rule pointing a host
    // at itself is an infinite redirect.
    if (host.startsWith("www.")) return [];

    return [
      {
        source: "/:path*",
        has: [{ type: "host" as const, value: `www.${host}` }],
        destination: `https://${host}/:path*`,
        permanent: false,
      },
    ];
  },

  experimental: {
    serverActions: {
      allowedOrigins: serverActionOrigins(),
    },
  },

  images: {
    remotePatterns: [
      // Covers member avatars (cdn.) and product thumbnails, which we store as
      // Discord's proxy URL (images-ext-N. / media.) rather than the retailer's own.
      // One entry then works for every retailer the bots ever check out from, instead
      // of an allowlist that throws at runtime the first time a new store appears.
      { protocol: "https", hostname: "**.discordapp.net" },
      { protocol: "https", hostname: "**.discordapp.com" },
    ],
  },
};

export default nextConfig;

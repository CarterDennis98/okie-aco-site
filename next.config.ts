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

const nextConfig: NextConfig = {
  // Required for the Cloud Run container: emits .next/standalone with a minimal
  // server.js and only the traced dependencies.
  output: "standalone",

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

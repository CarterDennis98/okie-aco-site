import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Required for the Cloud Run container: emits .next/standalone with a minimal
  // server.js and only the traced dependencies.
  output: "standalone",

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

import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Required for the Cloud Run container: emits .next/standalone with a minimal
  // server.js and only the traced dependencies.
  output: "standalone",

  images: {
    remotePatterns: [
      // Discord avatars, used for member display
      { protocol: "https", hostname: "cdn.discordapp.com" },
    ],
  },
};

export default nextConfig;

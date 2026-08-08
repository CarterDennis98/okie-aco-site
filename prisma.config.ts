// Prisma 7 moved the datasource URL, .env loading, and the seed command out of
// schema.prisma / package.json and into this file. `package.json#prisma.seed` is
// silently ignored now, so the seed entry below is the only one that works.
//
// Note: the Prisma CLI does NOT read .env.local (that's Next's convention). It reads
// .env, via the dotenv import below. A working app with a broken `prisma migrate` is
// almost always this.
import "dotenv/config";
import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",

  migrations: {
    path: "prisma/migrations",
    seed: "tsx prisma/seed.ts",
  },

  datasource: {
    // Deliberately process.env rather than Prisma's env() helper: env() throws when
    // unset, which would break `prisma generate` during a Docker build where no
    // database URL exists. Generate doesn't need a URL; migrate will fail on its own
    // with a clearer message if it's genuinely missing.
    url: process.env.DATABASE_URL as string,
  },
});

import type { DefaultSession } from "next-auth";

/**
 * The session deliberately carries IDENTITY AND NOTHING ELSE.
 *
 * No `isOg`, no `isAdmin`, no roles. Those are re-derived on every request by
 * `src/lib/auth/guard.ts` -- from the database for OG, from the environment for admin.
 * Putting either in the session would mean a member demoted mid-session keeps their
 * old powers until the cookie expires, which is a whole class of bug this design makes
 * structurally impossible rather than something to remember.
 */
declare module "next-auth" {
  interface Session {
    user: {
      /** Discord snowflake. The join key for every domain table. */
      discordUserId: string | null;
    } & DefaultSession["user"];
  }
}

declare module "next-auth/adapters" {
  interface AdapterUser {
    /**
     * Added so the adapter can persist it at createUser time rather than patching the
     * row afterwards. Auth.js spreads the provider's `profile()` return straight into
     * `createUser`, so a field added there arrives here.
     */
    discordUserId?: string | null;
  }
}

export {};

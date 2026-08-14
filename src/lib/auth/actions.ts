"use server";

import { signIn, signOut } from "@/lib/auth";

/**
 * Sign-in and sign-out as Server Actions rather than links to /api/auth/*.
 *
 * Actions get Next's built-in Origin check; a bare GET link to the Auth.js signin
 * endpoint does not. Both of these redirect by throwing, which is expected -- do not
 * wrap them in try/catch, or the redirect is swallowed and the user sits on a page that
 * looks like it did nothing.
 */

export async function signInWithDiscord() {
  await signIn("discord", { redirectTo: "/dashboard" });
}

export async function signOutOfSite() {
  await signOut({ redirectTo: "/" });
}

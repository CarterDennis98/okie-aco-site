/**
 * The Discord OAuth callback, shaped the way Discord actually sends it.
 *
 * On 2026-10-06 Discord began appending `iss=https://discord.com` to the redirect back to
 * /api/auth/callback/discord (RFC 9207), and every sign-in failed: Auth.js checked it
 * against its "https://authjs.dev" placeholder issuer. The provider now names Discord's
 * issuer; these tests send each shape of callback through the real handler.
 *
 * Every callback here carries a made-up code and no PKCE cookie, so all of them fail.
 * What matters is WHERE. Auth.js checks `iss` first and the PKCE cookie second, and both
 * run before Discord is called or a row is written. So a failure on the missing cookie
 * means the issuer was accepted, and nothing in this file leaves the process.
 */
import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.hoisted(() => {
  // NextAuth reads these once, when it initialises at import. Fixed values so the test
  // never depends on .env, and CI sets none of them.
  process.env.AUTH_SECRET = "test-secret-not-a-real-credential";
  process.env.AUTH_URL = "http://localhost:3000";
  process.env.AUTH_TRUST_HOST = "true";
  process.env.AUTH_DISCORD_ID = "000000000000000000";
  process.env.AUTH_DISCORD_SECRET = "test-secret-not-a-real-credential";
});

import { handlers } from "@/lib/auth";

const ISSUER_REJECTED = /unexpected "iss" \(issuer\) response parameter value/;
// Auth.js rewraps "cookie was missing" as "value could not be parsed", so match the check.
const REACHED_PKCE = /InvalidCheck: pkceCodeVerifier/;

/** Runs one callback and returns everything Auth.js logged about it. */
async function callback(query: Record<string, string>): Promise<string> {
  const logged: string[] = [];
  const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  });
  try {
    const url = new URL("http://localhost:3000/api/auth/callback/discord");
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    await handlers.GET(new NextRequest(url));
  } finally {
    spy.mockRestore();
  }
  return logged.join("\n");
}

describe("Discord OAuth callback", () => {
  it("accepts the iss parameter Discord now sends", async () => {
    const logged = await callback({ code: "fake", iss: "https://discord.com" });
    expect(logged).not.toMatch(ISSUER_REJECTED);
    expect(logged).toMatch(REACHED_PKCE);
  });

  it("still accepts a callback without iss, as Discord sent before", async () => {
    const logged = await callback({ code: "fake" });
    expect(logged).not.toMatch(ISSUER_REJECTED);
    expect(logged).toMatch(REACHED_PKCE);
  });

  it("still rejects an iss that isn't Discord's", async () => {
    // The point of the check: a response minted by some other authorization server.
    const logged = await callback({ code: "fake", iss: "https://attacker.example" });
    expect(logged).toMatch(ISSUER_REJECTED);
  });
});

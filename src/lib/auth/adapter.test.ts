/**
 * Adapter integration tests, against the real database.
 *
 * These exist because the adapter is hand-written and every session in the system flows
 * through it. They cover the whole OAuth-shaped lifecycle in the order Auth.js actually
 * calls it -- createUser, linkAccount, getUserByAccount, createSession,
 * getSessionAndUser, updateSession, deleteSession -- plus the two behaviours that are
 * deliberate rather than incidental:
 *
 *   - Discord tokens are NOT persisted.
 *   - Signing out twice must not throw.
 *
 * Skipped when no database is reachable, so CI without one stays green.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/db/client";
import { prismaAdapter as adapter } from "@/lib/auth/adapter";

const canConnect = Boolean(process.env.DATABASE_URL);

// Snowflake-shaped but unmistakably synthetic, so a stray row is obvious in psql.
const DISCORD_USER_ID = "999900000000000001";
const SESSION_TOKEN = "test-session-token-adapter";

let createdUserId: string | null = null;

describe.skipIf(!canConnect)("auth adapter", () => {
  beforeAll(async () => {
    await cleanup();
    // User.discordUserId is a foreign key to DiscordMember. In production the signIn
    // callback upserts this from the guild lookup before createUser ever runs.
    await prisma.discordMember.create({
      data: { discordUserId: DISCORD_USER_ID, username: "adapter-test", roles: [] },
    });
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  it("creates a user with the Discord id populated", async () => {
    const user = await adapter.createUser!({
      id: "ignored-by-adapter",
      name: "Adapter Test",
      email: null as unknown as string,
      emailVerified: null,
      image: "https://cdn.discordapp.com/avatars/1/abc.png",
      discordUserId: DISCORD_USER_ID,
    });

    createdUserId = user.id;
    expect(user.discordUserId).toBe(DISCORD_USER_ID);
    // Never fabricated into a placeholder address.
    expect(user.email).toBeNull();
  });

  it("does not persist Discord tokens when linking the account", async () => {
    await adapter.linkAccount!({
      userId: createdUserId!,
      type: "oauth",
      provider: "discord",
      providerAccountId: DISCORD_USER_ID,
      scope: "identify guilds.members.read",
      access_token: "SHOULD-NOT-BE-STORED",
      refresh_token: "SHOULD-NOT-BE-STORED-EITHER",
      expires_at: 9_999_999_999,
      // Typed as Lowercase<string> by @auth/core, so "Bearer" is a compile error.
      token_type: "bearer",
    });

    const row = await prisma.account.findUnique({
      where: {
        provider_providerAccountId: {
          provider: "discord",
          providerAccountId: DISCORD_USER_ID,
        },
      },
      select: { access_token: true, refresh_token: true, id_token: true, scope: true },
    });

    expect(row).not.toBeNull();
    expect(row!.access_token).toBeNull();
    expect(row!.refresh_token).toBeNull();
    expect(row!.id_token).toBeNull();
    // Scope IS kept -- it's a record of what the member consented to, not a credential.
    expect(row!.scope).toBe("identify guilds.members.read");
  });

  it("finds the user by provider account", async () => {
    const user = await adapter.getUserByAccount!({
      provider: "discord",
      providerAccountId: DISCORD_USER_ID,
    });
    expect(user?.id).toBe(createdUserId);
    expect(user?.discordUserId).toBe(DISCORD_USER_ID);
  });

  it("never resolves a user by email", async () => {
    // With one provider there is nothing legitimate to merge, and we hold no addresses.
    await expect(adapter.getUserByEmail!("anyone@example.com")).resolves.toBeNull();
  });

  it("round-trips a session and carries the Discord id back", async () => {
    const expires = new Date(Date.now() + 60_000);
    await adapter.createSession!({
      sessionToken: SESSION_TOKEN,
      userId: createdUserId!,
      expires,
    });

    const found = await adapter.getSessionAndUser!(SESSION_TOKEN);
    expect(found).not.toBeNull();
    expect(found!.user.discordUserId).toBe(DISCORD_USER_ID);
    expect(found!.session.expires.getTime()).toBe(expires.getTime());
  });

  it("extends a session's expiry", async () => {
    const later = new Date(Date.now() + 3_600_000);
    const updated = await adapter.updateSession!({ sessionToken: SESSION_TOKEN, expires: later });
    expect(updated?.expires.getTime()).toBe(later.getTime());
  });

  it("deletes a session, and deleting it again is a no-op", async () => {
    await adapter.deleteSession!(SESSION_TOKEN);
    await expect(adapter.getSessionAndUser!(SESSION_TOKEN)).resolves.toBeNull();
    // Sign-out racing a request, or a double click, must not 500.
    await expect(adapter.deleteSession!(SESSION_TOKEN)).resolves.not.toThrow();
  });

  it("returns null for an unknown session rather than throwing", async () => {
    await expect(adapter.getSessionAndUser!("no-such-token")).resolves.toBeNull();
  });
});

async function cleanup() {
  await prisma.session.deleteMany({ where: { sessionToken: SESSION_TOKEN } });
  await prisma.account.deleteMany({ where: { providerAccountId: DISCORD_USER_ID } });
  await prisma.user.deleteMany({ where: { discordUserId: DISCORD_USER_ID } });
  await prisma.discordMember.deleteMany({ where: { discordUserId: DISCORD_USER_ID } });
}

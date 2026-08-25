import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/db/client";
import { encrypt } from "@/lib/vault/crypto";
import { CHECK_COOLDOWN_MS, cooldownRemainingMs, testCredential } from "@/lib/vault/imap-test";
import type { SocketLike } from "@/lib/vault/imap-check";

/**
 * What gets WRITTEN DOWN about a check, which is the part that misleads people later.
 *
 * The rule worth guarding: a mail server we couldn't reach is not a member with a bad
 * password. Recording it as one puts "re-enter the app password" on a working credential
 * because a server had a bad minute, and the member dutifully replaces something that was
 * never wrong -- then waits for codes that were always going to arrive.
 */

// Needs a database AND the keyring: the row it writes holds a real encrypted password.
const canRun = Boolean(process.env.DATABASE_URL && process.env.VAULT_KEY_ACTIVE);

const MEMBER = "999900000000000051";
const EMAIL = "imap-spec@gmail.com";

function socketAnswering(loginLine: string): SocketLike {
  let onData: ((chunk: string) => void) | null = null;
  const emit = (lines: string[]) =>
    setTimeout(() => onData?.(lines.map((l) => `${l}\r\n`).join("")), 0);

  return {
    setEncoding() {},
    write(data: string) {
      if (data.includes(" LOGIN ")) emit([loginLine]);
      else if (data.includes(" SELECT ")) emit(["a2 OK [READ-WRITE] SELECT completed"]);
      else emit(["a3 OK LOGOUT completed"]);
    },
    destroy() {},
    on(event: string, listener: (arg: never) => void) {
      if (event === "data") {
        onData = listener as (chunk: string) => void;
        emit(["* OK Gimap ready"]);
      }
    },
  };
}

async function credentialRow() {
  return prisma.emailCredential.findUniqueOrThrow({
    where: { email: EMAIL },
    select: {
      id: true,
      email: true,
      appPasswordEnc: true,
      imapHost: true,
      imapPort: true,
      lastCheckedAt: true,
      verifiedAt: true,
      lastError: true,
    },
  });
}

/** Puts the row back to "never checked" so each case starts outside the cooldown. */
async function reset() {
  await prisma.emailCredential.update({
    where: { email: EMAIL },
    data: { verifiedAt: null, lastError: null, lastCheckedAt: null },
  });
}

describe("cooldownRemainingMs", () => {
  it("is zero for a credential nobody has checked", () => {
    expect(cooldownRemainingMs(null)).toBe(0);
  });

  it("counts down from the last check and never goes negative", () => {
    const now = 1_000_000;
    expect(cooldownRemainingMs(new Date(now), now)).toBe(CHECK_COOLDOWN_MS);
    expect(cooldownRemainingMs(new Date(now - CHECK_COOLDOWN_MS / 2), now)).toBe(
      CHECK_COOLDOWN_MS / 2,
    );
    expect(cooldownRemainingMs(new Date(now - CHECK_COOLDOWN_MS), now)).toBe(0);
    expect(cooldownRemainingMs(new Date(now - CHECK_COOLDOWN_MS * 10), now)).toBe(0);
  });
});

describe.skipIf(!canRun)("testCredential", () => {
  beforeAll(async () => {
    await cleanup();
    await prisma.discordMember.create({
      data: { discordUserId: MEMBER, username: "imap-spec", roles: [] },
    });
    await prisma.emailCredential.create({
      data: {
        email: EMAIL,
        discordUserId: MEMBER,
        appPasswordEnc: encrypt("abcdefghijklmnop", {
          entity: "email_credential",
          field: "app_password",
        }),
        imapHost: "imap.gmail.com",
        imapPort: 993,
      },
    });
  });

  afterAll(cleanup);

  it("records a pass, and clears a previous failure", async () => {
    await prisma.emailCredential.update({
      where: { email: EMAIL },
      data: { lastError: "something old", lastCheckedAt: null },
    });

    const outcome = await testCredential(await credentialRow(), async () =>
      socketAnswering("a1 OK LOGIN completed"),
    );
    expect(outcome.ok).toBe(true);

    const row = await credentialRow();
    expect(row.verifiedAt).not.toBeNull();
    expect(row.lastError).toBeNull();
    expect(row.lastCheckedAt).not.toBeNull();
  });

  it("records an auth failure against the credential", async () => {
    await reset();
    const outcome = await testCredential(await credentialRow(), async () =>
      socketAnswering("a1 NO [AUTHENTICATIONFAILED] Invalid credentials (Failure)"),
    );
    expect(outcome.ok).toBe(false);

    const row = await credentialRow();
    expect(row.verifiedAt).toBeNull();
    expect(row.lastError).toContain("Invalid credentials");
  });

  it("does NOT blame the credential when the server is unreachable", async () => {
    // Start from a passing state, so a wrongly-recorded failure would be visible.
    await reset();
    await testCredential(await credentialRow(), async () =>
      socketAnswering("a1 OK LOGIN completed"),
    );
    await reset();
    await prisma.emailCredential.update({
      where: { email: EMAIL },
      data: { verifiedAt: new Date("2026-08-01T00:00:00Z") },
    });

    const outcome = await testCredential(await credentialRow(), async () => {
      throw new Error("ECONNREFUSED");
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.message).toMatch(/says nothing about your password/i);

    const row = await credentialRow();
    // The verdict from the last real check survives; only the attempt time moved.
    expect(row.verifiedAt).not.toBeNull();
    expect(row.lastError).toBeNull();
    expect(row.lastCheckedAt).not.toBeNull();
  });

  it("refuses a second check inside the cooldown without opening a socket", async () => {
    await reset();
    await testCredential(await credentialRow(), async () =>
      socketAnswering("a1 OK LOGIN completed"),
    );

    let connected = false;
    const second = await testCredential(await credentialRow(), async () => {
      connected = true;
      return socketAnswering("a1 OK LOGIN completed");
    });

    expect(second.throttled).toBe(true);
    expect(second.ok).toBe(false);
    expect(second.message).toMatch(/try again in/i);
    expect(connected).toBe(false);
  });

  it("answers the same for a missing credential as for somebody else's", async () => {
    const outcome = await testCredential(null);
    expect(outcome.ok).toBe(false);
    expect(outcome.message).toMatch(/no app password on file/i);
  });
});

async function cleanup() {
  await prisma.emailCredential.deleteMany({ where: { email: EMAIL } });
  await prisma.discordMember.deleteMany({ where: { discordUserId: MEMBER } });
}

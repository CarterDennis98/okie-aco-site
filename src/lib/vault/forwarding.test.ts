/**
 * Which addresses a bulk "Forwards to" points at an inbox, and why the rest are left alone.
 *
 * The properties with something behind them: only an address on the member's own logins is
 * ever taken; an address keeps its own app password, and another member's forwarding stays
 * theirs; one already pointing at another of the member's inboxes is moved, not duplicated;
 * and the same address asked for twice, in any case, is one address.
 */
import { describe, expect, it } from "vitest";
import { planForwards } from "@/lib/vault/forwarding";

const ME = "me";
const INBOX = { id: "inbox-1", email: "main@gmail.com" };

const plan = (emails: string[], over: Partial<Parameters<typeof planForwards>[0]> = {}) =>
  planForwards({
    emails,
    inbox: INBOX,
    viewerId: ME,
    logins: ["a1@drops.com", "a2@drops.com", "A3@Drops.com", "own@gmail.com", "main@gmail.com"],
    ownPasswords: ["own@gmail.com", "main@gmail.com"],
    aliases: [],
    ...over,
  });

describe("planForwards", () => {
  it("forwards every address on the member's logins, once each, whatever its case", () => {
    expect(plan(["a1@drops.com", "A2@DROPS.COM", "a3@drops.com", " a1@drops.com "])).toEqual({
      create: ["a1@drops.com", "a2@drops.com", "a3@drops.com"],
      repoint: [],
      skipped: [],
    });
  });

  it("leaves alone what it can't forward, saying why, in the order asked", () => {
    const aliases = [
      { id: "x", email: "a1@drops.com", discordUserId: "someone-else", credentialId: "theirs" },
      { id: "y", email: "a2@drops.com", discordUserId: ME, credentialId: INBOX.id },
    ];
    expect(
      plan(
        [
          "stranger@drops.com",
          "main@gmail.com",
          "own@gmail.com",
          "a1@drops.com",
          "a2@drops.com",
          "a3@drops.com",
        ],
        { aliases },
      ),
    ).toEqual({
      create: ["a3@drops.com"],
      repoint: [],
      skipped: [
        { email: "stranger@drops.com", why: "isn't on any of your logins" },
        { email: "main@gmail.com", why: "is the inbox itself" },
        { email: "own@gmail.com", why: "has its own app password" },
        { email: "a1@drops.com", why: "is already claimed" },
        { email: "a2@drops.com", why: "already forwards there" },
      ],
    });
  });

  it("moves the member's own forwarding from another inbox rather than adding a second", () => {
    const aliases = [
      { id: "z", email: "a1@drops.com", discordUserId: ME, credentialId: "inbox-2" },
    ];
    expect(plan(["a1@drops.com", "a2@drops.com"], { aliases })).toEqual({
      create: ["a2@drops.com"],
      repoint: [{ id: "z", email: "a1@drops.com" }],
      skipped: [],
    });
  });

  it("takes nothing at all from a member with no logins", () => {
    expect(plan(["a1@drops.com"], { logins: [] })).toEqual({
      create: [],
      repoint: [],
      skipped: [{ email: "a1@drops.com", why: "isn't on any of your logins" }],
    });
  });
});

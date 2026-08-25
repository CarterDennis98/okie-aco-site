import { describe, expect, it } from "vitest";
import { matchProfileOwner, normalizeName } from "@/lib/ingest/profile-owner";

/**
 * The property under test is one-directional, like the allowlist's: this may only ever
 * return an owner it is CERTAIN of. Every ambiguity is a null.
 *
 * The names are the real shapes from the profile table -- usernames ending in digits,
 * punctuation inside them, and the operator's numbered house profiles.
 */

const MEMBERS = [
  { discordUserId: "1", username: "steadycod", globalName: "Steady" },
  { discordUserId: "2", username: "n0va.1e", globalName: null },
  { discordUserId: "3", username: "thisisgold0220", globalName: "Gold" },
  { discordUserId: "4", username: "frit1963", globalName: "steady" },
];

describe("normalizeName", () => {
  it("strips case and punctuation", () => {
    expect(normalizeName("N0va.1e")).toBe("n0va1e");
    expect(normalizeName(" Steady_Cod ")).toBe("steadycod");
  });

  it("is empty for nothing", () => {
    expect(normalizeName(null)).toBe("");
    expect(normalizeName("---")).toBe("");
  });
});

describe("matchProfileOwner", () => {
  it("maps a profile named after a member's username", () => {
    expect(matchProfileOwner("steadycod", MEMBERS)).toBe("1");
    expect(matchProfileOwner("thisisgold0220", MEMBERS)).toBe("3");
  });

  it("ignores case and punctuation on both sides", () => {
    expect(matchProfileOwner("N0va 1E", MEMBERS)).toBe("2");
  });

  it("refuses a name two members answer to", () => {
    // "Steady" is one member's global name and another's username. Billing the wrong
    // person is the failure this exists to avoid, so neither wins.
    expect(matchProfileOwner("steady", MEMBERS)).toBeNull();
  });

  it("counts one member matching on both names as one member", () => {
    const same = [{ discordUserId: "9", username: "carter", globalName: "Carter" }];
    expect(matchProfileOwner("carter", same)).toBe("9");
  });

  it("refuses anything that is not exactly a member's name", () => {
    // The bot would take these on its prefix and substring rules. This will not: a
    // house profile and a stranger's profile both land here.
    expect(matchProfileOwner("steadycod2", MEMBERS)).toBeNull();
    expect(matchProfileOwner("steady cod pulls", MEMBERS)).toBeNull();
    expect(matchProfileOwner("target reseller 4", MEMBERS)).toBeNull();
    expect(matchProfileOwner("", MEMBERS)).toBeNull();
    expect(matchProfileOwner(null, MEMBERS)).toBeNull();
  });
});

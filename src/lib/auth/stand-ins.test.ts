import { describe, expect, it } from "vitest";
import { STAND_INS, standInsFor, standingInFor } from "@/lib/auth/stand-ins";
import { otherPayee } from "@/lib/billing/payees";

/**
 * Stand-in accounts: who signs in as whom, and the two refusals that keep a code change from
 * handing out more than a runner's own reach.
 */

const CRISP = "1099014657127223417";
const HULK_LOGAN = "1471194582153957409";
const OPERATOR = "235941044460584960";
const NO_ADMINS = { ADMIN_DISCORD_IDS: OPERATOR };

describe("STAND_INS", () => {
  it("pairs Discord snowflakes, never an account with itself", () => {
    for (const [standIn, original] of Object.entries(STAND_INS)) {
      expect(standIn).toMatch(/^\d{15,25}$/);
      expect(original).toMatch(/^\d{15,25}$/);
      expect(standIn).not.toBe(original);
    }
  });

  it("never chains: a member stood in for is not themselves a stand-in", () => {
    const standIns = new Set(Object.keys(STAND_INS));
    for (const original of Object.values(STAND_INS)) expect(standIns.has(original)).toBe(false);
  });

  it("puts CrispHeinz's alt on the id his Topps fees are owed to", () => {
    // The payee table is what scopes his charges; a stand-in for any other id would show him
    // a Charges page with none of his money on it.
    expect(STAND_INS[HULK_LOGAN]).toBe(CRISP);
    expect(otherPayee(STAND_INS[HULK_LOGAN])?.name).toBe("CrispHeinz");
  });
});

describe("standingInFor", () => {
  it("names the member a stand-in signs in as", () => {
    expect(standingInFor(HULK_LOGAN, NO_ADMINS)).toBe(CRISP);
  });

  it("is null for everybody else, the member stood in for included", () => {
    expect(standingInFor(CRISP, NO_ADMINS)).toBeNull();
    expect(standingInFor(OPERATOR, NO_ADMINS)).toBeNull();
    expect(standingInFor("999900000000000001", NO_ADMINS)).toBeNull();
    // Inherited keys are not entries.
    expect(standingInFor("constructor", NO_ADMINS)).toBeNull();
    expect(standingInFor("__proto__", NO_ADMINS)).toBeNull();
  });

  it("refuses to make or unmake a full admin", () => {
    // Standing in for a full admin would grant ADMIN_DISCORD_IDS by a code change...
    expect(standingInFor(HULK_LOGAN, { ADMIN_DISCORD_IDS: `${OPERATOR},${CRISP}` })).toBeNull();
    // ...and a full admin signing in as somebody else would quietly lose it.
    expect(standingInFor(HULK_LOGAN, { ADMIN_DISCORD_IDS: HULK_LOGAN })).toBeNull();
  });
});

describe("standInsFor", () => {
  it("finds the accounts standing in for a member", () => {
    expect(standInsFor(CRISP, NO_ADMINS)).toEqual([HULK_LOGAN]);
    expect(standInsFor(OPERATOR, NO_ADMINS)).toEqual([]);
  });

  it("leaves out an entry standingInFor refuses", () => {
    expect(standInsFor(CRISP, { ADMIN_DISCORD_IDS: CRISP })).toEqual([]);
  });
});

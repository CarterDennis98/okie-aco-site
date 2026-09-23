/**
 * Who administers what.
 *
 * The property that matters is that a site admin's reach is exactly their retailers: Chess
 * can download Crunchyroll members' cards and must not be able to download anyone else's.
 * Every other rule here exists to make that one hard to get wrong -- a malformed entry grants
 * nothing, and a full admin listed as a site admin as well is never narrowed by it.
 */
import { describe, expect, it } from "vitest";
import { ALL_SITES, adminSitesFor, coversSite, hasAdminArea } from "@/lib/auth/admin-scope";
import { billCoversSite } from "@/lib/billing/payees";

const OPERATOR = "111111111111111111";
const CHESS = "397045810996576266";
const MEMBER = "222222222222222222";

const env = {
  ADMIN_DISCORD_IDS: OPERATOR,
  SITE_ADMIN_DISCORD_IDS: `crunchyroll:${CHESS}`,
};

describe("adminSitesFor", () => {
  it("gives a full admin every retailer", () => {
    expect(adminSitesFor(OPERATOR, env)).toBe(ALL_SITES);
  });

  it("gives a site admin their retailers and nothing else", () => {
    const sites = adminSitesFor(CHESS, env);
    expect(sites).toEqual(["crunchyroll"]);
    expect(coversSite(sites, "crunchyroll")).toBe(true);
    for (const other of ["target", "walmart", "pokemon-center", "costco"]) {
      expect(coversSite(sites, other), other).toBe(false);
    }
  });

  it("gives a member nothing", () => {
    const sites = adminSitesFor(MEMBER, env);
    expect(sites).toEqual([]);
    expect(hasAdminArea(sites)).toBe(false);
  });

  it("never narrows a full admin who is also listed as a site admin", () => {
    const both = { ...env, SITE_ADMIN_DISCORD_IDS: `crunchyroll:${OPERATOR}` };
    expect(adminSitesFor(OPERATOR, both)).toBe(ALL_SITES);
  });

  it("collects several retailers for one id, normalized like every other site lookup", () => {
    const several = { SITE_ADMIN_DISCORD_IDS: `Crunchyroll:${CHESS}, Best Buy : ${CHESS}` };
    expect(adminSitesFor(CHESS, several)).toEqual(["best-buy", "crunchyroll"]);
  });

  it("grants nothing for an entry missing either half", () => {
    // A bare id, a bare site, and an id that isn't a snowflake. Guessing which half was
    // meant is how a typo becomes access.
    const broken = { SITE_ADMIN_DISCORD_IDS: `${CHESS},crunchyroll,crunchyroll:chess,:${CHESS}` };
    expect(adminSitesFor(CHESS, broken)).toEqual([]);
  });

  it("grants nothing when neither allowlist is set", () => {
    expect(adminSitesFor(OPERATOR, {})).toEqual([]);
  });
});

describe("coversSite", () => {
  it("normalizes the vendor's spelling before matching", () => {
    expect(coversSite(["crunchyroll"], "https://www.crunchyroll.com")).toBe(true);
    expect(coversSite(["crunchyroll"], "Crunchyroll")).toBe(true);
  });

  it("covers nothing for a missing site, even for a full admin", () => {
    expect(coversSite(ALL_SITES, "")).toBe(false);
    expect(coversSite(ALL_SITES, null)).toBe(false);
  });
});

describe("billCoversSite", () => {
  /**
   * A drop window that billed a member twice holds both sets of orders. Each bill's
   * breakdown has to show its own: Chess's Crunchyroll checkouts on his, and everything no
   * other payee claims on the operator's.
   */
  it("splits a window's checkouts between the two bills", () => {
    expect(billCoversSite(CHESS, "crunchyroll")).toBe(true);
    expect(billCoversSite(CHESS, "Target")).toBe(false);

    expect(billCoversSite(OPERATOR, "Target")).toBe(true);
    expect(billCoversSite(OPERATOR, "Pokemon Center US")).toBe(true);
    expect(billCoversSite(OPERATOR, "crunchyroll")).toBe(false);
  });
});

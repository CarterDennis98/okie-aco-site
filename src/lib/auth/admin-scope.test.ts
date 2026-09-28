/**
 * Who administers what.
 *
 * The property that matters is that a runner's reach is exactly their retailers, and within
 * those exactly their assigned profiles: chess can download Crunchyroll members' cards that
 * are assigned to him and nobody else's. Every other rule here exists to make that one hard
 * to get wrong -- an unknown role grants nothing, the URL can never widen a runner's view,
 * and a full admin holding runner roles is never narrowed by them.
 */
import { describe, expect, it } from "vitest";
import {
  ALL_SITES,
  EVERYONE,
  RUNNER_ROLES,
  adminSitesFor,
  coversSite,
  fullAdminIds,
  hasAdminArea,
  operatorId,
  runnerRoleFor,
  runnerSitesFor,
  vaultScopeFor,
} from "@/lib/auth/admin-scope";
import { billCoversSite } from "@/lib/billing/payees";

const OPERATOR = "111111111111111111";
const CHESS = "397045810996576266";
const PEACEMAKER = "720050977444724868";
const MEMBER = "222222222222222222";

const env = { ADMIN_DISCORD_IDS: OPERATOR };

describe("adminSitesFor", () => {
  it("gives a full admin every retailer, whatever roles they hold", () => {
    expect(adminSitesFor(OPERATOR, [], env)).toBe(ALL_SITES);
    expect(adminSitesFor(OPERATOR, [RUNNER_ROLES.target], env)).toBe(ALL_SITES);
  });

  it("gives a runner the retailers their roles name, and nothing else", () => {
    const sites = adminSitesFor(CHESS, [RUNNER_ROLES.crunchyroll], env);
    expect(sites).toEqual(["crunchyroll"]);
    expect(coversSite(sites, "crunchyroll")).toBe(true);
    for (const other of ["target", "walmart", "pokemon-center", "costco", "premium-bandai"]) {
      expect(coversSite(sites, other), other).toBe(false);
    }
  });

  it("collects every runner role one person holds", () => {
    const roles = [RUNNER_ROLES.target, RUNNER_ROLES["pokemon-center"]];
    expect(adminSitesFor(PEACEMAKER, roles, env)).toEqual(["pokemon-center", "target"]);
  });

  it("gives a member with no runner role nothing", () => {
    // Roles that exist but mean nothing here -- the OG role, say -- grant nothing either.
    const sites = adminSitesFor(MEMBER, ["1479215474926555178"], env);
    expect(sites).toEqual([]);
    expect(hasAdminArea(sites)).toBe(false);
  });

  it("grants nothing when no allowlist is set and no role is held", () => {
    expect(adminSitesFor(OPERATOR, [], {})).toEqual([]);
  });
});

describe("runner roles", () => {
  it("names a role for every retailer someone other than a full admin runs", () => {
    for (const site of ["crunchyroll", "premium-bandai", "target", "pokemon-center", "walmart"]) {
      expect(runnerRoleFor(site), site).toMatch(/^\d{15,25}$/);
    }
  });

  it("names none where only full admins reach", () => {
    expect(runnerRoleFor("costco")).toBeNull();
    expect(runnerRoleFor("best-buy")).toBeNull();
    expect(runnerRoleFor(null)).toBeNull();
  });

  it("normalizes the vendor's spelling like every other site lookup", () => {
    expect(runnerRoleFor("Pokemon Center US")).toBe(RUNNER_ROLES["pokemon-center"]);
  });

  it("never gives two retailers the same role", () => {
    // One role standing for two retailers would hand out the second with the first.
    const roles = Object.values(RUNNER_ROLES);
    expect(new Set(roles).size).toBe(roles.length);
  });

  it("maps roles back to retailers in a stable order", () => {
    expect(runnerSitesFor(Object.values(RUNNER_ROLES))).toEqual(Object.keys(RUNNER_ROLES).sort());
  });
});

describe("fullAdminIds / operatorId", () => {
  it("keeps the order they are listed in, so the operator is the first", () => {
    const two = { ADMIN_DISCORD_IDS: ` ${OPERATOR} , ${MEMBER}` };
    expect(fullAdminIds(two)).toEqual([OPERATOR, MEMBER]);
    expect(operatorId(two)).toBe(OPERATOR);
  });

  it("has no operator when no full admin is configured", () => {
    expect(operatorId({})).toBeNull();
    expect(operatorId({ ADMIN_DISCORD_IDS: " , " })).toBeNull();
  });
});

describe("vaultScopeFor", () => {
  const operator = { discordUserId: OPERATOR, adminSites: ALL_SITES };
  const chess = { discordUserId: CHESS, adminSites: ["crunchyroll"] as const };

  it("pins a runner to their own assigned profiles on their own retailers", () => {
    expect(vaultScopeFor(chess)).toEqual({
      scope: { sites: ["crunchyroll"], assigneeId: CHESS },
      runner: CHESS,
    });
  });

  it("never lets the URL widen a runner's view", () => {
    for (const requested of [EVERYONE, OPERATOR, "", null]) {
      expect(vaultScopeFor(chess, requested).scope, String(requested)).toEqual({
        sites: ["crunchyroll"],
        assigneeId: CHESS,
      });
    }
  });

  it("opens a full admin on their own profiles, with the mailbox work nobody else owns", () => {
    expect(vaultScopeFor(operator)).toEqual({
      scope: { assigneeId: OPERATOR, withUnassigned: true },
      runner: OPERATOR,
    });
  });

  it("gives a full admin everyone's, or one other runner's, on request", () => {
    expect(vaultScopeFor(operator, EVERYONE)).toEqual({ scope: {}, runner: EVERYONE });
    expect(vaultScopeFor(operator, CHESS)).toEqual({
      scope: { assigneeId: CHESS },
      runner: CHESS,
    });
  });

  it("falls back to their own for a value that isn't a runner id", () => {
    for (const requested of ["chess", "123", "all ", OPERATOR]) {
      expect(vaultScopeFor(operator, requested).runner, requested).toBe(OPERATOR);
    }
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
   * breakdown has to show its own: chess's Crunchyroll checkouts on his, and everything no
   * other payee claims on the operator's.
   */
  it("splits a window's checkouts between the two bills", () => {
    expect(billCoversSite(CHESS, "crunchyroll")).toBe(true);
    expect(billCoversSite(CHESS, "Target")).toBe(false);

    expect(billCoversSite(OPERATOR, "Target")).toBe(true);
    expect(billCoversSite(OPERATOR, "Pokemon Center US")).toBe(true);
    expect(billCoversSite(OPERATOR, "crunchyroll")).toBe(false);
  });

  it("gives Premium Bandai to peacemaker and not to the operator", () => {
    expect(billCoversSite(PEACEMAKER, "Premium Bandai")).toBe(true);
    expect(billCoversSite(PEACEMAKER, "Target")).toBe(false);
    expect(billCoversSite(OPERATOR, "premium-bandai")).toBe(false);
  });
});

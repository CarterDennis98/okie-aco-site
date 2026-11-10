/**
 * Where a new profile goes.
 *
 * What is being protected is that every new row lands with somebody who will actually run
 * it: the runner already holding that member, the retailer's own runner, or the operator --
 * and never someone who has since lost the role.
 */
import { describe, expect, it } from "vitest";
import { defaultRunnerFor } from "@/lib/auth/admin-scope";
import { payeeForSite } from "@/lib/billing/payees";
import { pickDefaultAssignee } from "@/lib/vault/assignment";

const OPERATOR = "111111111111111111";
const CHESS = "397045810996576266";
const ALICE = "333333333333333333";

const pick = (over: Partial<Parameters<typeof pickDefaultAssignee>[0]>) =>
  pickDefaultAssignee({
    existing: [],
    eligible: new Set([OPERATOR, CHESS, ALICE]),
    siteRunner: null,
    sitePayee: null,
    operator: OPERATOR,
    ...over,
  });

describe("pickDefaultAssignee", () => {
  it("keeps a member's profiles on one retailer with the runner who already has them", () => {
    expect(pick({ existing: [ALICE, ALICE, ALICE] })).toBe(ALICE);
    // Even over the retailer's payee: this member was moved to alice on purpose.
    expect(pick({ existing: [ALICE], sitePayee: CHESS })).toBe(ALICE);
  });

  it("gives a brand-new member to the retailer's own runner", () => {
    expect(pick({ sitePayee: CHESS })).toBe(CHESS);
  });

  /**
   * chess runs every Menards profile. What sends a new one to him is his payee entry, and it
   * only lands while he holds the Menards runner role -- without it, the operator gets it.
   */
  it("gives a new Menards member to chess, through his payee entry", () => {
    const sitePayee = payeeForSite("Menards")?.id ?? null;
    expect(sitePayee).toBe(CHESS);
    expect(pick({ sitePayee })).toBe(CHESS);
    expect(pick({ sitePayee, eligible: new Set([OPERATOR]) })).toBe(OPERATOR);
  });

  /**
   * chess runs Costco and is not owed its fees, so it is his default-runner entry that sends
   * a new Costco member to him -- not a payee entry, which would have moved the money too.
   */
  it("gives a new Costco member to chess, through his default-runner entry", () => {
    const siteRunner = defaultRunnerFor("Costco");
    expect(siteRunner).toBe(CHESS);
    expect(payeeForSite("costco")).toBeNull();
    expect(pick({ siteRunner })).toBe(CHESS);
    // Only while he holds the Costco role.
    expect(pick({ siteRunner, eligible: new Set([OPERATOR]) })).toBe(OPERATOR);
    // A member already held by someone stays with them: a login saved before the default
    // existed keeps its runner, and so does every profile that member adds after it.
    expect(pick({ existing: [OPERATOR], siteRunner })).toBe(OPERATOR);
  });

  it("puts a retailer's named runner before whoever is owed its fees", () => {
    expect(pick({ siteRunner: ALICE, sitePayee: CHESS })).toBe(ALICE);
    // Without the role, the payee is next in line.
    expect(
      pick({ siteRunner: ALICE, sitePayee: CHESS, eligible: new Set([OPERATOR, CHESS]) }),
    ).toBe(CHESS);
  });

  it("gives everything else to the operator", () => {
    expect(pick({})).toBe(OPERATOR);
  });

  it("doesn't guess between runners when a member is already split", () => {
    // Whichever half the new one joins would be a coin toss; the full admin decides.
    expect(pick({ existing: [ALICE, CHESS] })).toBe(OPERATOR);
    expect(pick({ existing: [ALICE, CHESS], sitePayee: CHESS })).toBe(CHESS);
  });

  it("skips anyone who is no longer a runner there", () => {
    const withoutAlice = new Set([OPERATOR, CHESS]);
    expect(pick({ existing: [ALICE], eligible: withoutAlice })).toBe(OPERATOR);
    expect(pick({ sitePayee: ALICE, eligible: withoutAlice })).toBe(OPERATOR);
  });

  it("has nobody to give it to when no operator is configured and nothing else applies", () => {
    expect(pick({ operator: null })).toBeNull();
  });
});

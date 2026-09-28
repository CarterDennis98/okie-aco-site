/**
 * Where a new profile goes.
 *
 * What is being protected is that every new row lands with somebody who will actually run
 * it: the runner already holding that member, the retailer's own runner, or the operator --
 * and never someone who has since lost the role.
 */
import { describe, expect, it } from "vitest";
import { pickDefaultAssignee } from "@/lib/vault/assignment";

const OPERATOR = "111111111111111111";
const CHESS = "397045810996576266";
const ALICE = "333333333333333333";

const pick = (over: Partial<Parameters<typeof pickDefaultAssignee>[0]>) =>
  pickDefaultAssignee({
    existing: [],
    eligible: new Set([OPERATOR, CHESS, ALICE]),
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

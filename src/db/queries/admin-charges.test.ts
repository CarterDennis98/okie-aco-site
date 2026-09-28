/**
 * Charges, scoped by who they are owed to.
 *
 * What is under test is the runner's view: Chess sees the Crunchyroll charges owed to
 * him and nothing of the operator's, and a bill owed to one person can't be opened through
 * the other's scope. The queries do not check authorization themselves -- the pages and
 * actions pass the payee from the guard -- so this pins that the predicate they are handed
 * is actually applied, everywhere it is taken.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/db/client";
import { PasRunStatus } from "@/generated/prisma/enums";
import {
  getAdminChargeTotals,
  getAdminCharges,
  getChargePayees,
  getDropDates,
  getPendingConfirmationCount,
} from "@/db/queries/admin-charges";
import { getBillCheckouts } from "@/db/queries/drop-checkouts";

const canRun = Boolean(process.env.DATABASE_URL);

const OPERATOR = "999900000000000071";
const RUNNER = "999900000000000072";
const MEMBER = "999900000000000073";
// The real payee table names Chess, and only a bill owed to a listed payee has retailers of
// its own -- so the breakdown split is checked against his id.
const CHESS = "397045810996576266";

const SESSION = "test-charge-scope";
// NOT "test-" prefixed: the pas-runs route test clears every profile starting with that, and
// the two files run in parallel.
const PROFILE = "scope-check-member";
const MESSAGES = ["999900000000000081", "999900000000000082"];

let operatorBill = "";
let runnerBill = "";
let chessBill = "";

describe.skipIf(!canRun)("charges scoped by payee", () => {
  beforeAll(async () => {
    await cleanup();

    await prisma.discordMember.create({
      data: { discordUserId: MEMBER, username: "scope-test-member", roles: [] },
    });
    await prisma.profile.create({
      data: { profileKey: PROFILE, displayName: PROFILE, discordUserId: MEMBER, billable: true },
    });

    const run = await prisma.pasRun.create({
      data: {
        sessionId: SESSION,
        windowStart: new Date("2026-07-01T00:00:00Z"),
        windowEnd: new Date("2026-07-01T06:00:00Z"),
        dropLabel: "Scope test drop",
        status: PasRunStatus.SENT,
        dryRun: false,
        operatorId: OPERATOR,
      },
    });

    // One member, three people owed in one run. The first two are unconfirmed claims, so
    // the scoped counts below each have exactly one to find.
    const claimed = { paidClaimedAt: new Date("2026-07-02T00:00:00Z"), paidClaimedMethod: "venmo" };
    const [a, b, c] = await Promise.all([
      prisma.pasBill.create({
        data: {
          pasRunId: run.id,
          discordUserId: MEMBER,
          payeeId: OPERATOR,
          subtotalCents: 800,
          totalCents: 800,
          ...claimed,
        },
      }),
      prisma.pasBill.create({
        data: {
          pasRunId: run.id,
          discordUserId: MEMBER,
          payeeId: RUNNER,
          subtotalCents: 1200,
          totalCents: 1200,
          ...claimed,
        },
      }),
      prisma.pasBill.create({
        data: {
          pasRunId: run.id,
          discordUserId: MEMBER,
          payeeId: CHESS,
          subtotalCents: 500,
          totalCents: 500,
        },
      }),
    ]);
    operatorBill = a.id;
    runnerBill = b.id;
    chessBill = c.id;

    // What the member checked out in that window: one of each retailer.
    await prisma.checkout.createMany({
      data: [
        { site: "Target", discordMessageId: MESSAGES[0] },
        { site: "crunchyroll", discordMessageId: MESSAGES[1] },
      ].map((row) => ({
        ...row,
        sourceBot: "stellar",
        discordChannelId: "999900000000000080",
        occurredAt: new Date("2026-07-01T01:00:00Z"),
        productKey: "test-scope-product",
        profileKey: PROFILE,
        profileRaw: PROFILE,
      })),
    });
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  it("lists only the charges owed to the payee asked for", async () => {
    const mine = await getAdminCharges({ filter: "all", payeeId: RUNNER });
    expect(mine.rows.map((row) => row.id)).toEqual([runnerBill]);

    const theirs = await getAdminCharges({ filter: "all", payeeId: OPERATOR });
    expect(theirs.rows.map((row) => row.id)).toEqual([operatorBill]);
  });

  it("lists everyone's when no payee is given -- the full admin's view", async () => {
    const all = await getAdminCharges({ filter: "all", search: "scope-test-member" });
    expect(all.rows.map((row) => row.id).sort()).toEqual(
      [operatorBill, runnerBill, chessBill].sort(),
    );
  });

  it("scopes the totals and the badge the same way", async () => {
    const totals = await getAdminChargeTotals(RUNNER);
    expect(totals.claimedCount).toBe(1);
    expect(totals.claimedCents).toBe(1200);
    expect(totals.outstandingCents).toBe(1200);

    expect(await getPendingConfirmationCount(RUNNER)).toBe(1);
    expect(await getPendingConfirmationCount(OPERATOR)).toBe(1);
  });

  it("offers a drop only to a payee it billed something for", async () => {
    expect((await getDropDates(RUNNER)).map((d) => d.label)).toContain("Scope test drop");
    expect(await getDropDates("999900000000000079")).toEqual([]);
  });

  it("names every payee a real bill is owed to", async () => {
    const payees = await getChargePayees();
    for (const id of [OPERATOR, RUNNER, CHESS]) expect(payees).toContain(id);
  });

  it("won't open a bill through someone else's scope", async () => {
    expect(await getBillCheckouts(operatorBill, RUNNER)).toBeNull();
    expect(await getBillCheckouts(runnerBill, RUNNER)).not.toBeNull();
  });

  it("breaks each bill down into the checkouts it covers", async () => {
    // Chess is owed for Crunchyroll, so his bill shows that checkout and not the Target one.
    const chess = await getBillCheckouts(chessBill);
    expect(chess?.checkoutCount).toBe(1);
    expect(chess?.profiles[0].checkouts[0].site).toBe("crunchyroll");

    // The operator's covers everything nobody else claims -- the Target one.
    const operator = await getBillCheckouts(operatorBill);
    expect(operator?.checkoutCount).toBe(1);
    expect(operator?.profiles[0].checkouts[0].site).toBe("Target");
  });
});

async function cleanup() {
  await prisma.checkout.deleteMany({ where: { discordMessageId: { in: MESSAGES } } });
  await prisma.pasRun.deleteMany({ where: { sessionId: SESSION } });
  await prisma.profile.deleteMany({ where: { profileKey: PROFILE } });
  await prisma.discordMember.deleteMany({ where: { discordUserId: MEMBER } });
}

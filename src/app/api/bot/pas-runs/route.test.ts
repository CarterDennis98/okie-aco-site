/**
 * Billing-run ingest: who gets charged, and who must not.
 *
 * The rule under test is the one that already went wrong once. After the 8/7 backfill the
 * operator found an $8 charge against himself, because his own house profiles hit during
 * the drop and got billed like anyone else's. `Profile.billable` exists to say "these
 * checkouts belong to a person but never generate a fee" -- and the bot has no idea the
 * flag exists, so this endpoint is the only thing standing between it and a repeat.
 *
 * The rule cuts both ways, which is why the fail-open case is tested too: a member whose
 * profiles the site hasn't seen yet MUST still be billed. Dropping them would be a silent
 * loss of real money, which is far worse than a visible charge the operator can void.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/db/client";
import { getAcoCreditBalance } from "@/db/queries/aco-credit";
import { POST } from "./route";

const canRun = Boolean(process.env.DATABASE_URL && process.env.BOT_INGEST_TOKEN);

// House profiles: owned, never billed.
const OPERATOR = "999900000000000021";
// One billable profile and one not -- billable wins.
const MIXED = "999900000000000022";
// Known to the site, every profile billable.
const NORMAL = "999900000000000023";
// Billed for the first time; no profile rows here yet.
const STRANGER = "999900000000000024";
// Somebody other than the operator a member can owe -- Chess, for Crunchyroll.
const PAYEE = "999900000000000025";

const SESSION = "test-pas-run-billable";
const SPLIT_SESSION = "test-pas-run-split";
const CREDIT_SESSION = "test-pas-run-credit";
const CREDIT_DRY_SESSION = "test-pas-run-credit-dry";

function post(body: unknown): Promise<Response> {
  return POST(
    new Request("http://localhost/api/bot/pas-runs", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${process.env.BOT_INGEST_TOKEN}`,
      },
      body: JSON.stringify(body),
    }),
  );
}

function billFor(userId: string) {
  return {
    userId,
    subtotalCents: 800,
    discountCents: 0,
    totalCents: 800,
    isOg: false,
    message: "test bill",
    lines: [
      {
        productKey: "test-billable-product",
        label: "Test Billable Product",
        qty: 1,
        feeCents: 800,
        subtotalCents: 800,
      },
    ],
  };
}

const payload = {
  sessionId: SESSION,
  operatorId: OPERATOR,
  dryRun: false,
  windowStartMs: 1786689000000,
  windowEndMs: 1786701900000,
  dropLabel: "test-drop",
  sentAtMs: 1786716999902,
  bills: [billFor(OPERATOR), billFor(MIXED), billFor(NORMAL), billFor(STRANGER)],
  delivery: [OPERATOR, MIXED, NORMAL, STRANGER].map((userId) => ({
    userId,
    status: "sent",
    messageId: "1537826897604386826",
  })),
};

describe.skipIf(!canRun)("POST /api/bot/pas-runs", () => {
  beforeAll(async () => {
    await cleanup();

    await prisma.discordMember.createMany({
      data: [OPERATOR, MIXED, NORMAL, STRANGER].map((discordUserId) => ({
        discordUserId,
        username: `test-${discordUserId.slice(-2)}`,
        roles: [],
      })),
    });

    await prisma.profile.createMany({
      data: [
        {
          profileKey: "test-house-a",
          displayName: "house a",
          discordUserId: OPERATOR,
          billable: false,
        },
        {
          profileKey: "test-house-b",
          displayName: "house b",
          discordUserId: OPERATOR,
          billable: false,
        },
        {
          profileKey: "test-mixed-off",
          displayName: "mixed off",
          discordUserId: MIXED,
          billable: false,
        },
        {
          profileKey: "test-mixed-on",
          displayName: "mixed on",
          discordUserId: MIXED,
          billable: true,
        },
        { profileKey: "test-normal", displayName: "normal", discordUserId: NORMAL, billable: true },
      ],
    });
  });

  afterAll(cleanup);

  it("bills the members who should be billed, and refuses the house profiles", async () => {
    const response = await post(payload);
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.billsCreated).toBe(3);
    expect(body.billsNonBillable).toBe(1);

    const billed = await billedUserIds();
    // The $8-charge regression: every profile non-billable means no bill at all.
    expect(billed).not.toContain(OPERATOR);
    // One billable profile is enough.
    expect(billed).toContain(MIXED);
    expect(billed).toContain(NORMAL);
    // Unknown to the site, so billed rather than silently dropped.
    expect(billed).toContain(STRANGER);
  });

  it("is idempotent -- re-posting the same run charges nobody twice", async () => {
    const response = await post(payload);
    const body = await response.json();

    expect(body.billsCreated).toBe(0);
    expect(body.billsAlreadyPresent).toBe(3);
    expect(await prisma.pasBill.count({ where: { run: { sessionId: SESSION } } })).toBe(3);
  });

  it("stays refused even after the run exists", async () => {
    // A later drop must not sneak the house profiles in through the already-created run.
    const billed = await billedUserIds();
    expect(billed).not.toContain(OPERATOR);
  });

  it("stores a bill with no payee as the operator's -- how every bill arrived before payees", async () => {
    const bills = await prisma.pasBill.findMany({
      where: { run: { sessionId: SESSION } },
      select: { payeeId: true },
    });
    expect(bills.length).toBeGreaterThan(0);
    expect(bills.every((bill) => bill.payeeId === OPERATOR)).toBe(true);
  });

  /**
   * One member, two people owed, one run: a Target checkout owed to the operator and a
   * Crunchyroll one owed to Chess. They are two bills with two DMs, and each has to keep its
   * own delivery result -- matching deliveries by member alone would stamp one bill with the
   * other's outcome.
   */
  it("stores one bill per person owed, each with its own delivery", async () => {
    const split = {
      ...payload,
      sessionId: SPLIT_SESSION,
      bills: [billFor(NORMAL), { ...billFor(NORMAL), payeeId: PAYEE }],
      delivery: [
        { userId: NORMAL, status: "sent", messageId: "1537826897604386826" },
        { userId: NORMAL, payeeId: PAYEE, status: "dms-closed", messageId: null },
      ],
    };

    const response = await post(split);
    expect(response.status).toBe(200);
    expect((await response.json()).billsCreated).toBe(2);

    const bills = await prisma.pasBill.findMany({
      where: { run: { sessionId: SPLIT_SESSION } },
      select: { payeeId: true, discordUserId: true, deliveryStatus: true },
    });
    const byPayee = new Map(bills.map((bill) => [bill.payeeId, bill]));
    expect(byPayee.get(OPERATOR)?.deliveryStatus).toBe("SENT");
    expect(byPayee.get(PAYEE)?.deliveryStatus).toBe("DMS_CLOSED");
    expect(bills.every((bill) => bill.discordUserId === NORMAL)).toBe(true);

    // Idempotent on (run, member, payee): the re-post finds both and creates neither.
    const again = await (await post(split)).json();
    expect(again.billsCreated).toBe(0);
    expect(again.billsAlreadyPresent).toBe(2);
  });

  /**
   * ACO credit is spent by the bill that spent it. One bill the credit covers entirely --
   * owed nothing, so stored settled, with no payment behind it -- and one it covers in part,
   * which stays owed like any other. Neither a re-post nor a dry run spends it again.
   */
  it("stores the credit a bill spent, and settles one it covered entirely", async () => {
    const grant = (discordUserId: string, amountCents: number) =>
      prisma.acoCredit.create({
        data: { discordUserId, amountCents, issuedBy: OPERATOR, requestKey: crypto.randomUUID() },
      });
    await grant(NORMAL, 1000);
    await grant(MIXED, 300);

    const withCredit = {
      ...payload,
      sessionId: CREDIT_SESSION,
      bills: [
        { ...billFor(NORMAL), creditCents: 800, totalCents: 0 },
        { ...billFor(MIXED), creditCents: 300, totalCents: 500 },
      ],
      delivery: [NORMAL, MIXED].map((userId) => ({ userId, status: "sent", messageId: null })),
    };
    expect((await (await post(withCredit)).json()).billsCreated).toBe(2);

    const bills = await prisma.pasBill.findMany({
      where: { run: { sessionId: CREDIT_SESSION } },
      select: {
        discordUserId: true,
        creditCents: true,
        totalCents: true,
        paidCents: true,
        paidAt: true,
        markedPaidBy: true,
      },
    });
    const byMember = new Map(bills.map((bill) => [bill.discordUserId, bill]));
    // Covered: settled on arrival -- paid_at set with nothing received, which is the schema's
    // invariant for a total of zero -- so it never sits in an unpaid queue as a $0 debt.
    expect(byMember.get(NORMAL)).toMatchObject({
      creditCents: 800,
      totalCents: 0,
      paidCents: 0,
      markedPaidBy: OPERATOR,
    });
    expect(byMember.get(NORMAL)?.paidAt?.getTime()).toBe(payload.sentAtMs);
    // Part covered: still owed, like any bill.
    expect(byMember.get(MIXED)).toMatchObject({ creditCents: 300, totalCents: 500, paidAt: null });

    expect(await getAcoCreditBalance(NORMAL)).toBe(200);
    expect(await getAcoCreditBalance(MIXED)).toBe(0);

    // A re-post finds the bills already there, so spends nothing more.
    expect((await (await post(withCredit)).json()).billsCreated).toBe(0);
    expect(await getAcoCreditBalance(NORMAL)).toBe(200);

    // And a dry run spends nothing at all: nobody was billed by it.
    await post({ ...withCredit, sessionId: CREDIT_DRY_SESSION, dryRun: true });
    expect(await getAcoCreditBalance(NORMAL)).toBe(200);
  });
});

async function billedUserIds(): Promise<string[]> {
  const bills = await prisma.pasBill.findMany({
    where: { run: { sessionId: SESSION } },
    select: { discordUserId: true },
  });
  return bills.map((b) => b.discordUserId);
}

async function cleanup() {
  await prisma.pasRun.deleteMany({
    where: { sessionId: { in: [SESSION, SPLIT_SESSION, CREDIT_SESSION, CREDIT_DRY_SESSION] } },
  });
  await prisma.acoCredit.deleteMany({
    where: { discordUserId: { in: [OPERATOR, MIXED, NORMAL, STRANGER] } },
  });
  await prisma.profile.deleteMany({ where: { profileKey: { startsWith: "test-" } } });
  await prisma.item.deleteMany({ where: { productKey: "test-billable-product" } });
  await prisma.discordMember.deleteMany({
    where: { discordUserId: { in: [OPERATOR, MIXED, NORMAL, STRANGER] } },
  });
}

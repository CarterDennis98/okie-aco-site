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

const SESSION = "test-pas-run-billable";

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
        { profileKey: "test-house-a", displayName: "house a", discordUserId: OPERATOR, billable: false },
        { profileKey: "test-house-b", displayName: "house b", discordUserId: OPERATOR, billable: false },
        { profileKey: "test-mixed-off", displayName: "mixed off", discordUserId: MIXED, billable: false },
        { profileKey: "test-mixed-on", displayName: "mixed on", discordUserId: MIXED, billable: true },
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
});

async function billedUserIds(): Promise<string[]> {
  const bills = await prisma.pasBill.findMany({
    where: { run: { sessionId: SESSION } },
    select: { discordUserId: true },
  });
  return bills.map((b) => b.discordUserId);
}

async function cleanup() {
  await prisma.pasRun.deleteMany({ where: { sessionId: SESSION } });
  await prisma.profile.deleteMany({ where: { profileKey: { startsWith: "test-" } } });
  await prisma.item.deleteMany({ where: { productKey: "test-billable-product" } });
  await prisma.discordMember.deleteMany({
    where: { discordUserId: { in: [OPERATOR, MIXED, NORMAL, STRANGER] } },
  });
}

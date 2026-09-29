/**
 * ACO credit, given and spent.
 *
 * The properties with money behind them: only the operator can give or take credit, a
 * double-clicked change is one ledger row, a take-back can't exceed what is left, a change
 * reviewed against a stale balance is refused -- and a balance is what was given less what
 * REAL bills spent, never a dry run's.
 *
 * Faked: who is signed in (the guard reads a session cookie that can't exist outside a
 * request) and Next's cache revalidation. Everything else is the real database.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@/db/client";
import { getAcoCreditBalance, getAcoCreditHolders } from "@/db/queries/aco-credit";
import { changeAcoCredit } from "@/lib/billing/credit-actions";

const asking = vi.hoisted(() => ({ viewer: null as { discordUserId: string } | null }));

vi.mock("@/lib/auth/guard", () => ({
  requireAdmin: async () => ({ ...asking.viewer, isAdmin: true }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

const canRun = Boolean(process.env.DATABASE_URL);

const OPERATOR = "999900000000000301";
const OTHER_ADMIN = "999900000000000302";
const MEMBER = "999900000000000311";
const PREFIX = "credit-spec-";

let adminIds: string | undefined;

function form(fields: Record<string, string | number>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, String(value));
  return data;
}

async function change(
  mode: "give" | "take",
  amount: string,
  opts: { key?: string; as?: string; reviewedBalance?: number; note?: string } = {},
) {
  asking.viewer = { discordUserId: opts.as ?? OPERATOR };
  return changeAcoCredit(
    form({
      key: opts.key ?? crypto.randomUUID(),
      mode,
      memberId: MEMBER,
      amount,
      note: opts.note ?? "",
      reviewedBalance: opts.reviewedBalance ?? (await getAcoCreditBalance(MEMBER)),
    }),
  );
}

/** A billing run that spent `creditCents` of the member's credit. */
async function spend(creditCents: number, { dryRun = false } = {}) {
  await prisma.pasRun.create({
    data: {
      sessionId: `${PREFIX}${crypto.randomUUID()}`,
      windowStart: new Date(),
      windowEnd: new Date(),
      dropLabel: "credit spec",
      dryRun,
      operatorId: OPERATOR,
      bills: {
        create: {
          discordUserId: MEMBER,
          payeeId: OPERATOR,
          subtotalCents: 800,
          discountCents: 0,
          creditCents,
          totalCents: 800 - creditCents,
        },
      },
    },
  });
}

describe.skipIf(!canRun)("ACO credit", () => {
  beforeAll(async () => {
    adminIds = process.env.ADMIN_DISCORD_IDS;
    // The operator is the FIRST full admin; the second is a full admin who isn't.
    process.env.ADMIN_DISCORD_IDS = `${OPERATOR},${OTHER_ADMIN}`;
    await cleanup();
    await prisma.discordMember.create({
      data: { discordUserId: MEMBER, username: "credit-spec-member", globalName: "Credit Spec" },
    });
  });

  afterAll(async () => {
    await cleanup();
    process.env.ADMIN_DISCORD_IDS = adminIds;
  });

  it("is the operator's alone -- not every full admin's", async () => {
    const outcome = await change("give", "10", { as: OTHER_ADMIN });
    expect(outcome).toEqual({ ok: false, error: "Only the operator gives ACO credit." });
    expect(await getAcoCreditBalance(MEMBER)).toBe(0);
  });

  it("gives credit, on the record", async () => {
    const outcome = await change("give", "$10", { note: "Referral bonus" });
    expect(outcome).toMatchObject({
      ok: true,
      amountCents: 1000,
      balanceCents: 1000,
      already: false,
    });
    expect(await getAcoCreditBalance(MEMBER)).toBe(1000);

    const audit = await prisma.adminAudit.findFirst({
      where: { actorDiscordId: OPERATOR, action: "aco_credit.give" },
    });
    expect(audit?.after).toMatchObject({ memberId: MEMBER, amountCents: 1000, balanceCents: 1000 });
  });

  it("makes one change of a double-click", async () => {
    const key = crypto.randomUUID();
    const reviewedBalance = await getAcoCreditBalance(MEMBER);
    const first = await change("give", "5", { key, reviewedBalance });
    const second = await change("give", "5", { key, reviewedBalance });
    expect(first).toMatchObject({ ok: true, already: false });
    expect(second).toMatchObject({ ok: true, already: true, balanceCents: 1500 });
    expect(await getAcoCreditBalance(MEMBER)).toBe(1500);
  });

  it("refuses a change reviewed against a balance that has since moved", async () => {
    const outcome = await change("give", "5", { reviewedBalance: 1000 });
    expect(outcome).toMatchObject({ ok: false });
    expect(await getAcoCreditBalance(MEMBER)).toBe(1500);
  });

  it("takes back, but never more than is left", async () => {
    expect(await change("take", "20")).toMatchObject({ ok: false });
    expect(await change("take", "4")).toMatchObject({
      ok: true,
      amountCents: -400,
      balanceCents: 1100,
    });
  });

  it("is spent by real bills, and never by a dry run", async () => {
    await spend(600);
    await spend(300, { dryRun: true });
    expect(await getAcoCreditBalance(MEMBER)).toBe(500);

    const holder = (await getAcoCreditHolders()).find((h) => h.memberId === MEMBER);
    expect(holder).toMatchObject({ name: "Credit Spec", balanceCents: 500 });
    // The last change the operator made, not the spending.
    expect(holder?.last).toMatchObject({ amountCents: -400 });
  });
});

async function cleanup() {
  await prisma.pasRun.deleteMany({ where: { sessionId: { startsWith: PREFIX } } });
  await prisma.adminAudit.deleteMany({
    where: { actorDiscordId: { in: [OPERATOR, OTHER_ADMIN] } },
  });
  await prisma.acoCredit.deleteMany({ where: { discordUserId: MEMBER } });
  await prisma.discordMember.deleteMany({ where: { discordUserId: MEMBER } });
}

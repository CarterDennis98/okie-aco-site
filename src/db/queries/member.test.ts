/**
 * Ownership tests for the member dashboard queries.
 *
 * The single worst bug this site could ship is one member seeing another's bill, so the
 * two-predicate rule (`where: { id, discordUserId }`) gets a test rather than a comment.
 * The second case here is the one that matters: a VALID charge id belonging to someone
 * else must be indistinguishable from one that doesn't exist.
 *
 * Also covers dry-run exclusion — a preview the operator ran against real data must
 * never surface to a member as money owed.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/db/client";
import { getMemberCharge, getMemberDashboard } from "@/db/queries/member";
import { PasRunStatus } from "@/generated/prisma/enums";

const canConnect = Boolean(process.env.DATABASE_URL);

const ALICE = "999900000000000011";
const BOB = "999900000000000012";
const REAL_RUN = "test-run-real";
const DRY_RUN = "test-run-dry";

let aliceChargeId = "";
let bobChargeId = "";
let aliceDryChargeId = "";

describe.skipIf(!canConnect)("member queries", () => {
  beforeAll(async () => {
    await cleanup();

    await prisma.discordMember.createMany({
      data: [
        { discordUserId: ALICE, username: "alice-test", roles: [] },
        { discordUserId: BOB, username: "bob-test", roles: [] },
      ],
    });

    const realRun = await prisma.pasRun.create({
      data: {
        sessionId: REAL_RUN,
        windowStart: new Date("2026-08-01T00:00:00Z"),
        windowEnd: new Date("2026-08-01T06:00:00Z"),
        dropLabel: "Test drop",
        status: PasRunStatus.SENT,
        dryRun: false,
        operatorId: ALICE,
      },
    });

    const dryRun = await prisma.pasRun.create({
      data: {
        sessionId: DRY_RUN,
        windowStart: new Date("2026-08-02T00:00:00Z"),
        windowEnd: new Date("2026-08-02T06:00:00Z"),
        dropLabel: "Dry run drop",
        status: PasRunStatus.PREVIEW,
        dryRun: true,
        operatorId: ALICE,
      },
    });

    const [alice, bob, aliceDry] = await Promise.all([
      prisma.pasBill.create({
        data: {
          pasRunId: realRun.id,
          discordUserId: ALICE,
          subtotalCents: 1600,
          totalCents: 1600,
        },
      }),
      prisma.pasBill.create({
        data: { pasRunId: realRun.id, discordUserId: BOB, subtotalCents: 800, totalCents: 800 },
      }),
      prisma.pasBill.create({
        data: {
          pasRunId: dryRun.id,
          discordUserId: ALICE,
          subtotalCents: 5000,
          totalCents: 5000,
        },
      }),
    ]);

    aliceChargeId = alice.id;
    bobChargeId = bob.id;
    aliceDryChargeId = aliceDry.id;
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  it("returns a member's own charge", async () => {
    const charge = await getMemberCharge(ALICE, aliceChargeId);
    expect(charge?.id).toBe(aliceChargeId);
    expect(charge?.totalCents).toBe(1600);
  });

  it("returns null for another member's charge id", async () => {
    // A real, existing id -- just not Alice's. This is the IDOR case; the page turns
    // this null into a 404, so a guessed id is indistinguishable from a missing one.
    await expect(getMemberCharge(ALICE, bobChargeId)).resolves.toBeNull();
    await expect(getMemberCharge(BOB, aliceChargeId)).resolves.toBeNull();
  });

  it("hides dry-run charges even from their own member", async () => {
    await expect(getMemberCharge(ALICE, aliceDryChargeId)).resolves.toBeNull();
  });

  it("excludes dry runs from the outstanding balance", async () => {
    const dashboard = await getMemberDashboard(ALICE);
    // 1600 from the real run; the 5000 dry-run preview must not appear.
    expect(dashboard.unpaidTotalCents).toBe(1600);
    expect(dashboard.unpaidCount).toBe(1);
    expect(dashboard.charges.map((c) => c.id)).toEqual([aliceChargeId]);
  });

  it("scopes the dashboard to one member", async () => {
    const dashboard = await getMemberDashboard(BOB);
    expect(dashboard.unpaidTotalCents).toBe(800);
    expect(dashboard.charges.map((c) => c.id)).toEqual([bobChargeId]);
  });
});

async function cleanup() {
  await prisma.pasBill.deleteMany({ where: { discordUserId: { in: [ALICE, BOB] } } });
  await prisma.pasRun.deleteMany({ where: { sessionId: { in: [REAL_RUN, DRY_RUN] } } });
  await prisma.discordMember.deleteMany({ where: { discordUserId: { in: [ALICE, BOB] } } });
}

/**
 * The success/fail view's reads, against the real database: each profile's counts, one
 * profile's history, and the two things that would leak or mislead if they went wrong -- another
 * member's checkouts reaching these numbers, and history from before failures were tracked.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/db/client";
import { getProfileActivity, getProfileHistory } from "@/db/queries/profile-activity";
import { profileIdentity } from "@/lib/vault/profile-input";

const canRun = Boolean(process.env.DATABASE_URL);

const MEMBER = "999900000000000975";
const OTHER = "999900000000000976";
const FAMILY = "actspec";
const OTHER_FAMILY = "actspec-other";
const MESSAGE_PREFIX = "15379200000000";

let messages = 0;
const nextMessageId = () => `${MESSAGE_PREFIX}${String(messages++).padStart(4, "0")}`;

async function vaultProfile(owner: string, siteKey: string, name: string) {
  const account = await prisma.vaultAccount.create({
    data: {
      siteKey,
      email: `${name.replace(/\W+/g, "")}.${siteKey}@activity-spec.example.com`,
      discordUserId: owner,
      assigneeId: owner,
    },
    select: { id: true },
  });
  return prisma.vaultProfile.create({
    data: {
      siteKey,
      discordUserId: owner,
      name,
      ...profileIdentity(name),
      accountId: account.id,
      firstName: "Activity",
      lastName: "Spec",
      shipLine1: "1 Main St",
      shipCity: "Tulsa",
      shipState: "OK",
      shipPostalCode: "74103",
      cardBrand: "Visa",
      cardLast4: "4242",
      cardExpMonth: "12",
      cardExpYear: "2030",
      cardNumberEnc: "",
      cardCvvEnc: "",
    },
    select: { id: true },
  });
}

function checkout(site: string, profileRaw: string, iso: string, orderId: string, quantity = 1) {
  const { profileKey, profileIndex } = profileIdentity(profileRaw);
  return {
    sourceBot: "shikari",
    discordMessageId: nextMessageId(),
    discordChannelId: "1461868217935855676",
    occurredAt: new Date(iso),
    site,
    productRaw: "Activity Spec Bundle",
    productKey: "activity spec bundle",
    profileRaw,
    profileKey,
    profileIndex,
    orderId,
    quantity,
  };
}

async function cleanup() {
  const owners = { in: [MEMBER, OTHER] };
  await prisma.checkoutFailure.deleteMany({
    where: { discordMessageId: { startsWith: MESSAGE_PREFIX } },
  });
  await prisma.checkout.deleteMany({ where: { discordMessageId: { startsWith: MESSAGE_PREFIX } } });
  await prisma.vaultProfile.deleteMany({ where: { discordUserId: owners } });
  await prisma.vaultAccount.deleteMany({ where: { discordUserId: owners } });
  await prisma.profile.deleteMany({ where: { profileKey: { in: [FAMILY, OTHER_FAMILY] } } });
  await prisma.discordMember.deleteMany({ where: { discordUserId: owners } });
}

describe.skipIf(!canRun)("profile activity", () => {
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    await cleanup();
    await prisma.discordMember.createMany({
      data: [
        { discordUserId: MEMBER, username: "actspec", roles: [] },
        { discordUserId: OTHER, username: "actspec-other", roles: [] },
      ],
    });
    // The families checkouts reach a member through, as the dashboard reads them.
    await prisma.profile.createMany({
      data: [
        { profileKey: FAMILY, displayName: FAMILY, discordUserId: MEMBER, status: "MAPPED" },
        {
          profileKey: OTHER_FAMILY,
          displayName: OTHER_FAMILY,
          discordUserId: OTHER,
          status: "MAPPED",
        },
      ],
    });
    ids.target2 = (await vaultProfile(MEMBER, "target", "actspec - 2")).id;
    ids.walmart2 = (await vaultProfile(MEMBER, "walmart", "actspec - 2")).id;
    ids.target3 = (await vaultProfile(MEMBER, "target", "actspec - 3")).id;
    ids.theirs = (await vaultProfile(OTHER, "target", "actspec-other - 2")).id;

    await prisma.checkout.createMany({
      data: [
        checkout("Target", "actspec - 2", "2026-11-03T02:00:00Z", "ORDER-1", 2),
        checkout("Target", "actspec - 2", "2026-11-04T02:00:00Z", "ORDER-2"),
        checkout("Walmart", "actspec - 2", "2026-11-04T03:00:00Z", "ORDER-3"),
        checkout("Target", "actspec - 3", "2026-11-05T02:00:00Z", "ORDER-4"),
        // Before failures were tracked: in neither view.
        checkout("Target", "actspec - 2", "2026-10-20T02:00:00Z", "ORDER-0"),
        // Another member's family, on a name of their own.
        checkout("Target", "actspec-other - 2", "2026-11-04T02:00:00Z", "ORDER-9"),
      ],
    });

    const failure = (iso: string, reason: string, orderId: string | null, profileId: string) => ({
      sourceBot: "shikari",
      discordMessageId: nextMessageId(),
      discordChannelId: "1461868217935855676",
      occurredAt: new Date(iso),
      siteKey: "target",
      profileRaw: "actspec - 2",
      orderId,
      reason,
      vaultProfileId: profileId,
    });
    await prisma.checkoutFailure.createMany({
      data: [
        // ORDER-2 checked out, then Target cancelled it.
        failure("2026-11-06T02:00:00Z", "Order Canceled: Item Demand", "ORDER-2", ids.target2),
        failure("2026-11-07T02:00:00Z", "Payment Declined", null, ids.target2),
        failure("2026-10-25T02:00:00Z", "Payment Declined", null, ids.target2),
      ],
    });
  });

  afterAll(cleanup);

  it("counts each profile's own record since failures were tracked", async () => {
    const activity = await getProfileActivity(MEMBER);

    expect(activity[ids.target2]).toMatchObject({
      checkedOut: 1,
      units: 2,
      cancelled: 1,
      failed: 1,
      lastAt: new Date("2026-11-07T02:00:00Z"),
    });
    // The same name on another retailer is another profile, with its own record.
    expect(activity[ids.walmart2]).toMatchObject({ checkedOut: 1, cancelled: 0, failed: 0 });
    expect(activity[ids.target3]).toMatchObject({ checkedOut: 1 });
    // Nothing of the other member's.
    expect(activity[ids.theirs]).toBeUndefined();
    expect(Object.keys(activity).sort()).toEqual([ids.target2, ids.target3, ids.walmart2].sort());
  });

  it("lists one profile's history newest first, a cancelled order once", async () => {
    const history = await getProfileHistory(MEMBER, ids.target2);
    expect(history?.total).toBe(3);
    expect(history?.events.map((e) => [e.kind, e.orderId])).toEqual([
      ["failed", null],
      ["cancelled", "ORDER-2"],
      ["checked-out", "ORDER-1"],
    ]);
    expect(history?.events[1]).toMatchObject({
      checkedOutAt: new Date("2026-11-04T02:00:00Z"),
      product: "Activity Spec Bundle",
      reason: "Order Canceled: Item Demand",
    });
  });

  it("gives nobody else a profile's history", async () => {
    expect(await getProfileHistory(OTHER, ids.target2)).toBeNull();
    expect(await getProfileHistory(MEMBER, ids.theirs)).toBeNull();
  });
});

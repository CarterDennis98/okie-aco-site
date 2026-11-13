/**
 * Failed-checkout ingest, against the real database: which profile a failure flags, which it
 * refuses to guess at, and from when a profile's failures count against it.
 *
 * The rules that would go wrong quietly are the ones pinned hardest. A flag on the wrong
 * member's profile is worse than no flag, so a name that keys to nobody -- or to the same name
 * on another retailer -- must match nothing. And a member who has already fixed a profile must
 * not see it flagged again by a failure that happened before the fix but arrived after it.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/db/client";
import { clearFailures, loadFailureFlags } from "@/db/queries/failures";
import { profileIdentity } from "@/lib/vault/profile-input";
import { POST } from "./route";

const canRun = Boolean(process.env.DATABASE_URL && process.env.BOT_INGEST_TOKEN);

const MEMBER = "999900000000000991";
const OTHER = "999900000000000992";
const RUNNER = "999900000000000993";

/** Message ids are the idempotency key; this suite's own range, as strings like every id. */
const MESSAGE_PREFIX = "15379000000000";
let messageCount = 0;
const nextMessageId = () => `${MESSAGE_PREFIX}${String(messageCount++).padStart(4, "0")}`;

const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000);

function failure(over: Record<string, unknown> = {}) {
  return {
    sourceBot: "valor",
    discordMessageId: nextMessageId(),
    discordChannelId: "1420180854617018399",
    occurredAt: minutesAgo(1).toISOString(),
    site: "Target",
    productRaw: "Fail Spec Product",
    profileRaw: "failspec - 2",
    reason: "Payment Declined",
    ...over,
  };
}

function post(failures: unknown[], token = process.env.BOT_INGEST_TOKEN) {
  return POST(
    new Request("http://localhost/api/bot/failures", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ failures }),
    }),
  );
}

/** A profile and the login it hangs off. The card columns are never read here, so blank. */
async function profile(owner: string, siteKey: string, name: string, createdAt?: Date) {
  const account = await prisma.vaultAccount.create({
    data: {
      siteKey,
      email: `${name.replace(/\W+/g, "")}-${siteKey}@fail-spec.example.com`,
      discordUserId: owner,
      assigneeId: RUNNER,
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
      firstName: "Fail",
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
      ...(createdAt ? { createdAt } : {}),
    },
    select: { id: true },
  });
}

async function cleanup() {
  const owners = { in: [MEMBER, OTHER] };
  await prisma.checkoutFailure.deleteMany({
    where: { discordMessageId: { startsWith: MESSAGE_PREFIX } },
  });
  await prisma.vaultProfile.deleteMany({ where: { discordUserId: owners } });
  await prisma.vaultAccount.deleteMany({ where: { discordUserId: owners } });
  await prisma.discordMember.deleteMany({ where: { discordUserId: owners } });
}

describe.skipIf(!canRun)("POST /api/bot/failures", () => {
  let target: { id: string };
  let walmart: { id: string };

  beforeAll(async () => {
    await cleanup();
    await prisma.discordMember.createMany({
      data: [
        { discordUserId: MEMBER, username: "failspec", roles: [] },
        { discordUserId: OTHER, username: "failspec-other", roles: [] },
      ],
    });
    target = await profile(MEMBER, "target", "failspec - 2", minutesAgo(60 * 24 * 30));
    walmart = await profile(MEMBER, "walmart", "failspec - 3", minutesAgo(60 * 24 * 30));
    await profile(OTHER, "target", "failspec-other", minutesAgo(60 * 24 * 30));
  });

  afterAll(cleanup);

  it("refuses a caller without the token, and a batch off the contract", async () => {
    expect((await post([failure()], "wrong")).status).toBe(401);
    // Strict, like checkouts: an unknown key is an error, and so is a vendor nobody listed.
    expect((await post([{ ...failure(), rawEmbed: {} }])).status).toBe(400);
    expect((await post([failure({ sourceBot: "someone-new" })])).status).toBe(400);
  });

  it("flags the profile it ran on, by retailer and name, however the bot spaced it", async () => {
    const response = await post([failure({ profileRaw: "  failspec  - 2 " })]);
    expect(await response.json()).toMatchObject({ inserted: 1, matched: 1 });

    const flags = await loadFailureFlags(MEMBER);
    expect(flags.get(target.id)).toMatchObject({
      count: 1,
      risk: "flagged",
      lastReason: "Payment Declined",
    });
    // Same member, other retailer: nothing.
    expect(flags.has(walmart.id)).toBe(false);
  });

  it("turns red at three, and counts a replayed failure once", async () => {
    const again = failure({ reason: "Policy - Item Demand" });
    await post([again, failure()]);
    const replay = await post([again]);
    expect(await replay.json()).toMatchObject({ inserted: 0, duplicates: 1 });

    expect((await loadFailureFlags(MEMBER)).get(target.id)).toMatchObject({
      count: 3,
      risk: "high",
    });
  });

  it("matches nothing on another retailer, an unknown store, or a name nobody has", async () => {
    const strays = [
      // The name is a Target profile's, but this is Pokémon Center.
      failure({ site: "Pokemon Center US" }),
      // Hayha's sample posts name a platform, not a retailer.
      failure({ site: "Demandware" }),
      failure({ profileRaw: "nobody - 9" }),
      failure({ site: null }),
      failure({ profileRaw: null }),
    ];
    const response = await post(strays);
    expect(await response.json()).toMatchObject({ inserted: strays.length, matched: 0 });

    const stored = await prisma.checkoutFailure.findMany({
      where: { discordMessageId: { in: strays.map((s) => s.discordMessageId) } },
      select: { vaultProfileId: true, siteKey: true },
    });
    expect(stored.every((row) => row.vaultProfileId === null)).toBe(true);
    expect(stored.map((row) => row.siteKey)).toContain("pokemon-center");
  });

  it("never shows one member's failures on another's page", async () => {
    await post([failure({ profileRaw: "failspec-other" })]);
    const mine = await loadFailureFlags(MEMBER);
    const theirs = await loadFailureFlags(OTHER);
    expect(theirs.size).toBe(1);
    expect([...mine.keys()]).toEqual([target.id]);
  });

  it("clears on a change, and a failure from before the change arrives already cleared", async () => {
    const changedAt = new Date();
    await prisma.$transaction([
      prisma.vaultProfile.update({
        where: { id: target.id },
        data: { failuresClearedAt: changedAt },
      }),
      clearFailures([target.id], changedAt),
    ]);
    expect((await loadFailureFlags(MEMBER)).has(target.id)).toBe(false);

    // Happened a minute before the fix, but the queue only delivered it now.
    const late = failure({ occurredAt: new Date(changedAt.getTime() - 60_000).toISOString() });
    expect(await (await post([late])).json()).toMatchObject({ inserted: 1, matched: 1 });
    expect((await loadFailureFlags(MEMBER)).has(target.id)).toBe(false);

    // Anything after the fix is news about the new details.
    await post([failure({ occurredAt: new Date(changedAt.getTime() + 60_000).toISOString() })]);
    expect((await loadFailureFlags(MEMBER)).get(target.id)).toMatchObject({ count: 1 });
  });

  it("doesn't count a failure from before the profile existed", async () => {
    // A name freed by a deletion and taken again: the old failure was somebody else's details.
    const fresh = await profile(MEMBER, "target", "failspec - 7");
    await post([
      failure({ profileRaw: "failspec - 7", occurredAt: minutesAgo(60 * 24).toISOString() }),
    ]);
    expect((await loadFailureFlags(MEMBER)).has(fresh.id)).toBe(false);
  });

  it("lets go of a deleted profile's failures rather than the other way round", async () => {
    const doomed = await profile(MEMBER, "target", "failspec - 8", minutesAgo(60));
    const gone = failure({ profileRaw: "failspec - 8" });
    await post([gone]);
    await prisma.vaultProfile.delete({ where: { id: doomed.id } });

    const kept = await prisma.checkoutFailure.findUnique({
      where: { discordMessageId: gone.discordMessageId },
      select: { vaultProfileId: true, profileRaw: true },
    });
    expect(kept).toEqual({ vaultProfileId: null, profileRaw: "failspec - 8" });
  });

  it("stores Target's Quantity Limit cancels without flagging for them, and a Reseller one flags", async () => {
    // A member who hit their own checkout limit: nothing wrong with the profile.
    const limited = await profile(MEMBER, "target", "failspec - 9", minutesAgo(60));
    const quantity = await post([
      failure({ profileRaw: "failspec - 9", reason: "Order Canceled: Quantity Limit" }),
      failure({
        sourceBot: "sniped",
        profileRaw: "failspec - 9",
        reason: "Cancelled Checkout (Policy - Quantity Limit)",
      }),
    ]);
    expect(await quantity.json()).toMatchObject({ inserted: 2, matched: 2, flagging: 0 });
    expect((await loadFailureFlags(MEMBER)).has(limited.id)).toBe(false);

    const reseller = await post([
      failure({ profileRaw: "failspec - 9", reason: "Order Canceled: Reseller" }),
    ]);
    expect(await reseller.json()).toMatchObject({ inserted: 1, flagging: 1 });
    expect((await loadFailureFlags(MEMBER)).get(limited.id)).toMatchObject({
      count: 1,
      lastReason: "Order Canceled: Reseller",
    });
  });
});

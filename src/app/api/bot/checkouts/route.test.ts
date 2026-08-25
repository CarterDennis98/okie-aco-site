/**
 * Checkout ingest: whose profile the checkout landed on.
 *
 * The rule under test is the one that went wrong quietly for weeks. A checkout reaches
 * its member through `profiles.discord_user_id` and nothing else, and until the ingest
 * started claiming profiles, only `prisma db seed` ever wrote that column. Every profile
 * that first appeared through this endpoint stayed UNMAPPED -- so the member's dashboard,
 * their charge pages, and the operator's per-charge breakdown all showed nothing, while
 * the bot went on billing them off its own mapping file.
 *
 * Both directions matter, which is why the refusals are tested at least as hard as the
 * claims: attributing a checkout to the wrong person is worse than leaving it unmapped,
 * because unmapped is visible (scripts/verify-attribution.ts) and wrong is not.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/db/client";
import { POST } from "./route";

const canRun = Boolean(process.env.DATABASE_URL && process.env.BOT_INGEST_TOKEN);

const CLAIMED = "999900000000000031";
const PUNCTUATED = "999900000000000032";
// Two members answering to the same name -- neither may win.
const TWIN_A = "999900000000000033";
const TWIN_B = "999900000000000034";

const MEMBERS = [
  { discordUserId: CLAIMED, username: "ingest-spec-claimed" },
  { discordUserId: PUNCTUATED, username: "ingest.spec.dots" },
  { discordUserId: TWIN_A, username: "ingest-spec-twin" },
  { discordUserId: TWIN_B, username: "someone-else", globalName: "ingest-spec-twin" },
];

/**
 * Every row this file writes, so cleanup can find them without touching real data.
 *
 * The "ingest-spec" prefix is not decoration: the pas-runs suite sweeps every profile
 * starting with "test-", the two files run in parallel, and sharing a prefix had it
 * deleting these rows out from under an insert.
 */
const PRODUCT = "Ingest Spec Product";
const PRODUCT_KEY = PRODUCT.toLowerCase();

/**
 * Message ids are the idempotency key, so each case needs its own. Built as a STRING:
 * a snowflake is 64-bit and past what a number holds, which is why they are strings
 * everywhere else too.
 */
let messageCount = 0;
const nextMessageId = () => `15378000000000000${String(messageCount++).padStart(2, "0")}`;

function checkout(profileRaw: string) {
  return {
    sourceBot: "valor",
    discordMessageId: nextMessageId(),
    discordChannelId: "1478473609180614809",
    occurredAt: "2026-08-21T02:00:00.000Z",
    site: "Target",
    productRaw: PRODUCT,
    profileRaw,
    quantity: 1,
  };
}

function post(checkouts: unknown[]): Promise<Response> {
  return POST(
    new Request("http://localhost/api/bot/checkouts", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${process.env.BOT_INGEST_TOKEN}`,
      },
      body: JSON.stringify({ checkouts }),
    }),
  );
}

function ownerOf(profileKey: string) {
  return prisma.profile.findUnique({
    where: { profileKey },
    select: { discordUserId: true, status: true, mappedBy: true, billable: true },
  });
}

describe.skipIf(!canRun)("POST /api/bot/checkouts", () => {
  beforeAll(async () => {
    await cleanup();
    await prisma.discordMember.createMany({
      data: MEMBERS.map((m) => ({ ...m, roles: [] })),
    });
  });

  afterAll(cleanup);

  it("claims a profile named after a member, numbered suffix and all", async () => {
    const response = await post([
      checkout("ingest-spec-claimed"),
      // " - 3" is the same person's third profile, so it collapses onto the same key.
      checkout("ingest-spec-claimed - 3"),
    ]);
    expect(response.status).toBe(200);

    const profile = await ownerOf("ingest-spec-claimed");
    expect(profile).toMatchObject({
      discordUserId: CLAIMED,
      status: "MAPPED",
      mappedBy: "ingest:name-match",
    });
  });

  it("matches through the punctuation the two sides spell differently", async () => {
    await post([checkout("Ingest Spec Dots")]);
    expect((await ownerOf("ingest spec dots"))?.discordUserId).toBe(PUNCTUATED);
  });

  it("refuses a name more than one member answers to", async () => {
    await post([checkout("ingest-spec-twin")]);
    const profile = await ownerOf("ingest-spec-twin");
    expect(profile?.discordUserId).toBeNull();
    expect(profile?.status).toBe("UNMAPPED");
  });

  it("refuses a near miss the bot's fuzzy rules would have taken", async () => {
    await post([checkout("ingest-spec-claimed-alt"), checkout("ingest spec")]);
    expect((await ownerOf("ingest-spec-claimed-alt"))?.discordUserId).toBeNull();
    expect((await ownerOf("ingest spec"))?.discordUserId).toBeNull();
  });

  it("never moves a profile that already has an owner", async () => {
    await prisma.profile.create({
      data: {
        profileKey: "ingest-spec-twin-owned",
        displayName: "ingest-spec-twin-owned",
        discordUserId: TWIN_A,
        status: "MAPPED",
        mappedBy: "test",
      },
    });
    // Its raw name collapses to the key above, and matches nobody -- but even if it did,
    // an existing owner is never reassigned.
    await post([checkout("ingest-spec-twin-owned")]);
    expect(await ownerOf("ingest-spec-twin-owned")).toMatchObject({
      discordUserId: TWIN_A,
      mappedBy: "test",
    });
  });

  it("leaves an IGNORED house profile attached to nobody", async () => {
    await prisma.profile.create({
      data: {
        profileKey: "ingest-spec-claimed-house",
        displayName: "ingest-spec-claimed-house",
        status: "IGNORED",
      },
    });
    await post([checkout("ingest-spec-claimed-house")]);
    expect(await ownerOf("ingest-spec-claimed-house")).toMatchObject({
      discordUserId: null,
      status: "IGNORED",
    });
  });

  it("claims a profile stranded by an earlier ingest, so the backlog heals itself", async () => {
    await prisma.profile.create({
      data: {
        profileKey: "ingest-spec-dots-old",
        displayName: "ingest-spec-dots-old",
        status: "UNMAPPED",
      },
    });
    // Renaming the member is what a real backlog looks like: the profile was ingested
    // before anybody could match it, and the next checkout on it is the chance to.
    await prisma.discordMember.update({
      where: { discordUserId: PUNCTUATED },
      data: { globalName: "ingest spec dots old" },
    });

    await post([checkout("ingest-spec-dots-old")]);
    expect((await ownerOf("ingest-spec-dots-old"))?.discordUserId).toBe(PUNCTUATED);
  });
});

async function cleanup() {
  await prisma.checkout.deleteMany({ where: { productKey: PRODUCT_KEY } });
  await prisma.profile.deleteMany({ where: { profileKey: { startsWith: "ingest-spec" } } });
  await prisma.profile.deleteMany({ where: { profileKey: { startsWith: "ingest spec" } } });
  await prisma.item.deleteMany({ where: { productKey: PRODUCT_KEY } });
  await prisma.discordMember.deleteMany({
    where: { discordUserId: { in: MEMBERS.map((m) => m.discordUserId) } },
  });
}

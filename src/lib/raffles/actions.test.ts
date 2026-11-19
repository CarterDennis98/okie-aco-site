/**
 * Raffles listed, entered and deleted, and read back the way the page and the export read them.
 *
 * The properties with something behind them: a member can only narrow an entry to their OWN
 * profiles, and nothing about an entry changes once entries are due; a raffle can't be listed
 * twice for one product, or listed already due; what the export enters each profile in is
 * exactly what its member chose -- all profiles, some, or none; and deleting a raffle takes
 * its entries with it, but never ones made since the page was loaded.
 *
 * Faked: who is signed in (the guard reads a session cookie that can't exist outside a
 * request) and Next's cache revalidation. Everything else is the real database.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@/db/client";
import {
  getMemberRaffleEntries,
  getRaffleCounts,
  getRaffleEntries,
  getRaffles,
} from "@/db/queries/raffles";
import { saveRaffleEntry } from "@/lib/raffles/actions";
import { createRaffle, deleteRaffle, updateRaffle } from "@/lib/raffles/admin-actions";
import { rafflesByProfile } from "@/lib/raffles/entries";
import { toZonedInput } from "@/lib/raffles/time";

const asking = vi.hoisted(() => ({ viewer: { discordUserId: "" } }));
vi.mock("@/lib/auth/guard", () => ({
  requireMember: async () => asking.viewer,
  requireAdmin: async () => asking.viewer,
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

const canRun = Boolean(process.env.DATABASE_URL);

const SITE = "target";
const ALICE = "999900000000001101";
const BOB = "999900000000001102";
const PREFIX = "raffle-spec-";
/** TCINs no real product has, so nothing here meets a real raffle. */
const SKU = "99700001";
const SKU_2 = "99700002";

const profileIds: Record<string, string> = {};

async function profile(owner: string, name: string) {
  const account = await prisma.vaultAccount.create({
    data: {
      siteKey: SITE,
      email: `${PREFIX}${name}@example.com`,
      discordUserId: owner,
      assigneeId: owner,
    },
  });
  const row = await prisma.vaultProfile.create({
    data: {
      siteKey: SITE,
      discordUserId: owner,
      name: `${PREFIX}${name}`,
      profileKey: `${PREFIX}${name}`,
      accountId: account.id,
      firstName: "Test",
      lastName: "Member",
      shipLine1: "1 Main St",
      shipCity: "Tulsa",
      shipState: "OK",
      shipPostalCode: "74103",
      cardBrand: "visa",
      cardLast4: "4242",
      cardExpMonth: "12",
      cardExpYear: "2030",
      cardNumberEnc: "not-a-real-ciphertext",
      cardCvvEnc: "not-a-real-ciphertext",
    },
  });
  profileIds[name] = row.id;
}

const as = (discordUserId: string) => (asking.viewer = { discordUserId });

/** Form fields for a raffle on `sku`, starting in a day and due in `dueInDays`. */
function fields(sku: string, dueInDays = 3, name = `${PREFIX}raffle ${sku}`) {
  const day = 86_400_000;
  return {
    url: `https://www.target.com/p/x/-/A-${sku}`,
    sku: "",
    name,
    price: "",
    imageUrl: "",
    startsAt: toZonedInput(new Date(Date.now() + day)),
    dueAt: toZonedInput(new Date(Date.now() + dueInDays * day)),
  };
}

describe.skipIf(!canRun)("raffles", () => {
  let raffleId = "";

  beforeAll(async () => {
    await cleanup();
    await prisma.discordMember.createMany({
      data: [ALICE, BOB].map((discordUserId) => ({
        discordUserId,
        username: `${PREFIX}${discordUserId.slice(-3)}`,
        roles: [],
      })),
    });
    await profile(ALICE, "a1");
    await profile(ALICE, "a2");
    await profile(BOB, "b1");
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  it("lists a raffle once per product, never already due, and audits it", async () => {
    as(ALICE);
    const made = await createRaffle({ fields: fields(SKU) });
    expect(made).toMatchObject({ ok: true });
    raffleId = made.ok ? made.id : "";
    expect(await createRaffle({ fields: fields(SKU) })).toEqual({
      ok: false,
      error: `There's already a raffle for SKU ${SKU}: “${PREFIX}raffle ${SKU}”. Delete it first to raffle it again.`,
    });
    expect(await createRaffle({ fields: fields(SKU_2, -1) })).toMatchObject({ ok: false });
    expect(await createRaffle({ fields: { ...fields(SKU_2), extra: "x" } })).toMatchObject({
      ok: false,
    });
    const audit = await prisma.adminAudit.findFirst({
      where: { action: "raffle.create", entityId: raffleId },
    });
    expect(audit?.actorDiscordId).toBe(ALICE);
  });

  it("enters every profile, or only the ones picked, and reads back as the export will", async () => {
    as(ALICE);
    expect(await saveRaffleEntry({ raffleId, mode: "all" })).toEqual({ ok: true });
    as(BOB);
    expect(await saveRaffleEntry({ raffleId, mode: "some", profileIds: [profileIds.b1] })).toEqual({
      ok: true,
    });

    expect(await getMemberRaffleEntries(ALICE, SITE)).toEqual({
      [raffleId]: { all: true, profileIds: [] },
    });
    const raffles = await getRaffles(SITE, { includeClosed: true });
    const entered = rafflesByProfile(
      [
        { id: profileIds.a1, discordUserId: ALICE },
        { id: profileIds.a2, discordUserId: ALICE },
        { id: profileIds.b1, discordUserId: BOB },
      ],
      await getRaffleEntries(SITE, [ALICE, BOB]),
      raffles,
    );
    expect(entered.get(profileIds.a1)).toEqual([SKU]);
    expect(entered.get(profileIds.a2)).toEqual([SKU]);
    expect(entered.get(profileIds.b1)).toEqual([SKU]);
    expect((await getRaffleCounts(SITE))[raffleId]).toEqual({
      members: 2,
      profiles: 3,
      entries: 2,
    });
  });

  it("narrows, widens and withdraws an entry", async () => {
    as(ALICE);
    await saveRaffleEntry({ raffleId, mode: "some", profileIds: [profileIds.a2] });
    expect((await getMemberRaffleEntries(ALICE, SITE))[raffleId]).toEqual({
      all: false,
      profileIds: [profileIds.a2],
    });
    await saveRaffleEntry({ raffleId, mode: "all" });
    expect((await getMemberRaffleEntries(ALICE, SITE))[raffleId]).toEqual({
      all: true,
      profileIds: [],
    });
    await saveRaffleEntry({ raffleId, mode: "off" });
    expect((await getMemberRaffleEntries(ALICE, SITE))[raffleId]).toBeUndefined();
    await saveRaffleEntry({ raffleId, mode: "all" });
  });

  it("refuses somebody else's profile, no profile, and an entry nobody can read", async () => {
    as(BOB);
    expect(await saveRaffleEntry({ raffleId, mode: "some", profileIds: [profileIds.a1] })).toEqual({
      ok: false,
      error: "Those aren't your profiles.",
    });
    expect(await saveRaffleEntry({ raffleId, mode: "some", profileIds: [] })).toEqual({
      ok: false,
      error: "Pick at least one profile, or switch it off.",
    });
    expect(await saveRaffleEntry({ raffleId, mode: "all", discordUserId: ALICE })).toMatchObject({
      ok: false,
    });
    // Bob's entry is still his own one profile.
    expect((await getMemberRaffleEntries(BOB, SITE))[raffleId]).toEqual({
      all: false,
      profileIds: [profileIds.b1],
    });
  });

  it("changes nothing about an entry once entries are due, and lists the raffle as past", async () => {
    as(ALICE);
    const now = Date.now();
    // Closed early by an edit: started yesterday, due a minute ago.
    const closed = {
      ...fields(SKU),
      startsAt: toZonedInput(new Date(now - 86_400_000)),
      dueAt: toZonedInput(new Date(now - 60_000)),
    };
    expect(await updateRaffle({ id: raffleId, fields: closed })).toEqual({
      ok: true,
      id: raffleId,
    });
    expect(await saveRaffleEntry({ raffleId, mode: "off" })).toMatchObject({
      ok: false,
      error: expect.stringMatching(/^Entries were due .* CT, so this can't change now\.$/),
    });
    // Her entry is still hers to read, under "Past raffles": the raffle is off the open list,
    // and on the one with closed raffles, after every open one.
    expect((await getMemberRaffleEntries(ALICE, SITE))[raffleId]).toEqual({
      all: true,
      profileIds: [],
    });
    const open = await getRaffles(SITE);
    expect(open.some((r) => r.id === raffleId)).toBe(false);
    const all = await getRaffles(SITE, { includeClosed: true });
    const at = all.findIndex((r) => r.id === raffleId);
    expect(at).toBeGreaterThanOrEqual(0);
    // After every open one: from it on, the list is closed raffles only. Read off the one list,
    // since other test files add and remove raffles of their own meanwhile.
    expect(all.slice(at).every((r) => r.dueAt <= new Date())).toBe(true);
  });

  it("deletes a raffle with its entries, but not if more came in since the page loaded", async () => {
    as(ALICE);
    expect(await deleteRaffle({ id: raffleId, entries: 1 })).toEqual({
      ok: false,
      error: "Entries changed since the page loaded. Reload the page and check before deleting.",
    });
    expect(await deleteRaffle({ id: raffleId, entries: 2 })).toEqual({ ok: true, entries: 2 });
    expect(await prisma.raffleEntry.count({ where: { raffleId } })).toBe(0);
    expect(await prisma.raffle.findUnique({ where: { id: raffleId } })).toBeNull();
    // And the product can be raffled again.
    const again = await createRaffle({ fields: fields(SKU) });
    expect(again).toMatchObject({ ok: true });
  });
});

async function cleanup() {
  await prisma.raffle.deleteMany({ where: { sku: { in: [SKU, SKU_2] } } });
  await prisma.vaultProfile.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await prisma.vaultAccount.deleteMany({ where: { email: { startsWith: PREFIX } } });
  await prisma.discordMember.deleteMany({ where: { discordUserId: { in: [ALICE, BOB] } } });
}

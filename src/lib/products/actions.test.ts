/**
 * A member's picks, saved and read back the way the export reads them.
 *
 * The properties with something behind them: a member can only narrow a pick to their OWN
 * profiles; nothing retired can be switched on; and what the export builds tasks from is
 * exactly what the member chose -- all profiles, some, or none.
 *
 * Faked: who is signed in (the guard reads a session cookie that can't exist outside a
 * request) and Next's cache revalidation. Everything else is the real database.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@/db/client";
import {
  getDropStats,
  getMemberChoices,
  getSelectionCounts,
  getSkusForProfiles,
} from "@/db/queries/products";
import { saveProductChoice } from "@/lib/products/actions";

const asking = vi.hoisted(() => ({ viewer: { discordUserId: "" } }));
vi.mock("@/lib/auth/guard", () => ({ requireMember: async () => asking.viewer }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

const canRun = Boolean(process.env.DATABASE_URL);

const SITE = "target";
const ALICE = "999900000000000611";
const BOB = "999900000000000612";
const PREFIX = "pick-spec-";

let products: { id: string; sku: string }[] = [];
let retiredId = "";
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

describe.skipIf(!canRun)("member product picks", () => {
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
    for (const [i, sku] of ["99000001", "99000002"].entries()) {
      products.push(
        await prisma.dropProduct.create({
          data: {
            siteKey: SITE,
            setName: `${PREFIX}set`,
            name: `${PREFIX}product ${i}`,
            url: `https://www.target.com/p/x/-/A-${sku}`,
            sku,
            createdBy: ALICE,
            // A fixed order, so "watch order" is deterministic.
            createdAt: new Date(Date.UTC(2026, 0, 1 + i)),
          },
          select: { id: true, sku: true },
        }),
      );
    }
    retiredId = (
      await prisma.dropProduct.create({
        data: {
          siteKey: SITE,
          setName: `${PREFIX}set`,
          name: `${PREFIX}retired`,
          url: "https://www.target.com/p/x/-/A-99000009",
          sku: "99000009",
          createdBy: ALICE,
          active: false,
        },
        select: { id: true },
      })
    ).id;
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  it("runs a product on every profile, or only the ones picked", async () => {
    as(ALICE);
    // Site-wide figures: measured as the change these picks make, so the database's other
    // rows can't move them. Only figures about PROFILES are compared: the count of live
    // products would move with any other test adding one meanwhile.
    const before = await getDropStats(SITE);
    expect(await saveProductChoice({ productIds: [products[1].id], mode: "all" })).toEqual({
      ok: true,
    });
    expect(
      await saveProductChoice({
        productIds: [products[0].id],
        mode: "some",
        profileIds: [profileIds.a2],
      }),
    ).toEqual({ ok: true });

    const { skus } = await getSkusForProfiles(SITE, [
      { id: profileIds.a1, discordUserId: ALICE },
      { id: profileIds.a2, discordUserId: ALICE },
      { id: profileIds.b1, discordUserId: BOB },
    ]);
    expect(skus.get(profileIds.a1)).toEqual(["99000002"]);
    expect(skus.get(profileIds.a2)).toEqual(["99000001", "99000002"]);
    expect(skus.get(profileIds.b1)).toEqual([]);

    expect(await getMemberChoices(ALICE, SITE)).toEqual({
      [products[0].id]: { all: false, profileIds: [profileIds.a2] },
      [products[1].id]: { all: true, profileIds: [] },
    });
    const counts = await getSelectionCounts(SITE);
    expect(counts[products[0].id]).toEqual({ members: 1, profiles: 1 });
    expect(counts[products[1].id]).toEqual({ members: 1, profiles: 2 });

    const after = await getDropStats(SITE);
    expect({
      running: after.running - before.running,
      profilesRunning: after.profilesRunning - before.profilesRunning,
      // Alice runs two products; three profile-product lines between her two profiles.
      selections: after.selections - before.selections,
      runs: after.runs - before.runs,
      watched: after.watched - before.watched,
    }).toEqual({
      running: 1,
      profilesRunning: 2,
      selections: 2,
      runs: 3,
      watched: 2,
    });
    // Bob picked nothing, and says so by name; Alice is off that list now.
    const idle = after.idle.map((m) => m.discordUserId);
    expect(idle).toContain(BOB);
    expect(idle).not.toContain(ALICE);
    expect(before.idle.map((m) => m.discordUserId)).toContain(ALICE);
  });

  it("switches a product off, and back to all profiles, dropping the narrowed list", async () => {
    as(ALICE);
    await saveProductChoice({ productIds: [products[0].id], mode: "off" });
    expect((await getMemberChoices(ALICE, SITE))[products[0].id]).toBeUndefined();
    await saveProductChoice({
      productIds: [products[0].id],
      mode: "some",
      profileIds: [profileIds.a1],
    });
    await saveProductChoice({ productIds: [products[0].id], mode: "all" });
    expect((await getMemberChoices(ALICE, SITE))[products[0].id]).toEqual({
      all: true,
      profileIds: [],
    });
  });

  it("refuses to narrow a pick to somebody else's profile", async () => {
    as(BOB);
    expect(
      await saveProductChoice({
        productIds: [products[0].id],
        mode: "some",
        profileIds: [profileIds.a1],
      }),
    ).toEqual({ ok: false, error: "Those aren't your profiles." });
    expect(await getMemberChoices(BOB, SITE)).toEqual({});
  });

  it("refuses to switch on a retired product, but lets one be switched off", async () => {
    as(BOB);
    expect(await saveProductChoice({ productIds: [retiredId], mode: "all" })).toMatchObject({
      ok: false,
    });
    expect(await saveProductChoice({ productIds: [retiredId], mode: "off" })).toEqual({ ok: true });
  });

  it("refuses an empty narrowed pick and anything that isn't the shape it expects", async () => {
    as(ALICE);
    expect(
      await saveProductChoice({ productIds: [products[0].id], mode: "some", profileIds: [] }),
    ).toMatchObject({
      ok: false,
    });
    expect(await saveProductChoice({ productIds: ["not-a-uuid"], mode: "all" })).toMatchObject({
      ok: false,
    });
    expect(
      await saveProductChoice({ productIds: [products[0].id], mode: "all", discordUserId: BOB }),
    ).toMatchObject({ ok: false });
  });
});

async function cleanup() {
  await prisma.dropProduct.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await prisma.vaultProfile.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await prisma.vaultAccount.deleteMany({ where: { email: { startsWith: PREFIX } } });
  await prisma.discordMember.deleteMany({ where: { discordUserId: { in: [ALICE, BOB] } } });
  products = [];
}

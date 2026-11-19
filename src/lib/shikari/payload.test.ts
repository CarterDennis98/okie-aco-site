/**
 * The Shikari export's server half, for raffles and the Miscellaneous line: which raffles each
 * profile goes out entered in, on which instance, and which entries no instance runs; and
 * which instances get the line's products and picks.
 *
 * The properties with something behind them: a member's raffle entries follow their profiles
 * through the main/backup split -- the first five (Target's soft cap, in name order) on the
 * main instance, the rest on the backup -- so no profile is entered from two bots; every
 * raffle on the site goes out to every instance, open or closed; and an entry no instance runs
 * is named, rather than silently left out of every backup. The Miscellaneous line goes only to
 * an instance whose box is ticked, with its tasks section on, and every instance says how many
 * of its profiles picked from it.
 *
 * Real database, real vault crypto under a throwaway key. Nothing here is logged.
 */
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/db/client";
import { MISC_LINE } from "@/lib/products/misc-line";
import { defaultInstanceConfig, type ShikariInstanceConfig } from "@/lib/shikari/config";
import { buildShikariPayload } from "@/lib/shikari/payload";
import { encrypt, resetKeyringCache } from "@/lib/vault/crypto";

const canRun = Boolean(process.env.DATABASE_URL);

const SITE = "target";
/** The operator, whose bot every profile here is assigned to: also a member, with seven. */
const OPERATOR = "999900000000001111";
/** A member nobody picks on an instance. */
const OTHER = "999900000000001112";
const PREFIX = "raffle-pay-spec-";
const SKU = "99800001";
const CLOSED_SKU = "99800002";
/** In a set of the Miscellaneous line. */
const LINE_SKU = "99800011";
/** In a set of no line: runs from "Target". */
const PLAIN_SKU = "99800012";

let saved: NodeJS.ProcessEnv;

async function profile(owner: string, name: string) {
  const account = await prisma.vaultAccount.create({
    data: {
      siteKey: SITE,
      email: `${PREFIX}${name.replace(/\W+/g, "")}@example.com`,
      discordUserId: owner,
      assigneeId: OPERATOR,
    },
  });
  await prisma.vaultProfile.create({
    data: {
      siteKey: SITE,
      discordUserId: owner,
      name,
      profileKey: name,
      accountId: account.id,
      firstName: "Test",
      lastName: "Member",
      shipLine1: "1 Main St",
      shipCity: "Tulsa",
      shipState: "OK",
      shipPostalCode: "74103",
      cardBrand: "visa",
      cardLast4: "1111",
      cardExpMonth: "12",
      cardExpYear: "2030",
      cardNumberEnc: encrypt("4111111111111111", { entity: "vault_profile", field: "card_number" }),
      cardCvvEnc: encrypt("123", { entity: "vault_profile", field: "card_cvv" }),
    },
  });
}

const instance = (
  position: number,
  bot: "main" | "backup" | "all",
  memberIds: string[],
  sections: Partial<ShikariInstanceConfig["sections"]> = {},
) => {
  const config = defaultInstanceConfig(memberIds);
  return { position, config: { ...config, bot, sections: { ...config.sections, ...sections } } };
};

describe.skipIf(!canRun)("the Shikari payload's raffles", () => {
  beforeAll(async () => {
    saved = { ...process.env };
    for (const name of Object.keys(process.env)) {
      if (name.startsWith("VAULT_KEY")) delete process.env[name];
    }
    process.env.VAULT_KEY_K1 = randomBytes(32).toString("base64");
    process.env.VAULT_KEY_ACTIVE = "k1";
    resetKeyringCache();

    await cleanup();
    await prisma.discordMember.createMany({
      data: [OPERATOR, OTHER].map((discordUserId) => ({
        discordUserId,
        username: `${PREFIX}${discordUserId.slice(-3)}`,
        roles: [],
      })),
    });
    for (let i = 1; i <= 7; i++) await profile(OPERATOR, `${PREFIX}op - ${i}`);
    await profile(OTHER, `${PREFIX}other - 1`);

    const day = 86_400_000;
    const raffle = await prisma.raffle.create({
      data: {
        siteKey: SITE,
        sku: SKU,
        name: `${PREFIX}open raffle`,
        url: `https://www.target.com/p/x/-/A-${SKU}`,
        startsAt: new Date(Date.now() - day),
        dueAt: new Date(Date.now() + day),
        createdBy: OPERATOR,
      },
    });
    // Closed, but still on the site: still in every export.
    await prisma.raffle.create({
      data: {
        siteKey: SITE,
        sku: CLOSED_SKU,
        name: `${PREFIX}closed raffle`,
        url: `https://www.target.com/p/x/-/A-${CLOSED_SKU}`,
        startsAt: new Date(Date.now() - 3 * day),
        dueAt: new Date(Date.now() - day),
        createdBy: OPERATOR,
      },
    });
    for (const discordUserId of [OPERATOR, OTHER]) {
      await prisma.raffleEntry.create({ data: { raffleId: raffle.id, discordUserId } });
    }
  });

  afterAll(async () => {
    await cleanup();
    process.env = saved;
    resetKeyringCache();
    await prisma.$disconnect();
  });

  it("enters the first five on the main instance and the rest on the backup", async () => {
    const result = await buildShikariPayload(OPERATOR, {
      instances: [instance(1, "main", [OPERATOR]), instance(2, "backup", [OPERATOR])],
    });
    if (!result.ok) throw new Error(result.error);
    const [main, backup] = result.instances;
    const entered = (list: typeof main.profiles) =>
      list.filter((p) => p.raffles.includes(SKU)).map((p) => p.name);

    expect(entered(main.profiles)).toEqual([1, 2, 3, 4, 5].map((i) => `${PREFIX}op - ${i}`));
    expect(entered(backup.profiles)).toEqual([6, 7].map((i) => `${PREFIX}op - ${i}`));
    // Both instances are told of both raffles: the closed one keeps its group until deleted.
    for (const desired of result.instances) {
      expect(desired.raffles).toEqual(
        expect.arrayContaining([
          { sku: SKU, name: `${PREFIX}open raffle` },
          { sku: CLOSED_SKU, name: `${PREFIX}closed raffle` },
        ]),
      );
    }
    // The member nobody picked is named, so the review can say their entry runs nowhere.
    expect(result.raffleGaps).toEqual([
      { raffle: `${PREFIX}open raffle`, profiles: [`${PREFIX}other - 1`] },
    ]);
  });

  it("names a sixth and seventh profile when there's no backup instance to run them", async () => {
    const result = await buildShikariPayload(OPERATOR, {
      instances: [instance(1, "main", [OPERATOR, OTHER])],
    });
    if (!result.ok) throw new Error(result.error);
    expect(result.raffleGaps).toEqual([
      { raffle: `${PREFIX}open raffle`, profiles: [`${PREFIX}op - 6`, `${PREFIX}op - 7`] },
    ]);
  });

  it("enters only the profiles an entry is narrowed to", async () => {
    const entry = await prisma.raffleEntry.findFirstOrThrow({
      where: { discordUserId: OPERATOR, raffle: { sku: SKU } },
    });
    const six = await prisma.vaultProfile.findFirstOrThrow({
      where: { name: `${PREFIX}op - 6` },
    });
    await prisma.raffleEntry.update({ where: { id: entry.id }, data: { allProfiles: false } });
    await prisma.raffleEntryProfile.create({ data: { entryId: entry.id, profileId: six.id } });

    const result = await buildShikariPayload(OPERATOR, {
      instances: [instance(1, "all", [OPERATOR, OTHER])],
    });
    if (!result.ok) throw new Error(result.error);
    expect(
      result.instances[0].profiles.filter((p) => p.raffles.length > 0).map((p) => p.name),
    ).toEqual([`${PREFIX}op - 6`, `${PREFIX}other - 1`]);
    expect(result.raffleGaps).toEqual([]);
  });

  describe("and the Miscellaneous line", () => {
    /** The line, when this test had to make it: the local database may already have one. */
    let madeLine: string | null = null;

    beforeAll(async () => {
      let line = await prisma.dropLine.findFirst({
        where: { siteKey: SITE, name: { equals: MISC_LINE, mode: "insensitive" } },
      });
      if (!line) {
        line = await prisma.dropLine.create({
          data: { siteKey: SITE, name: MISC_LINE, sortOrder: 999 },
        });
        madeLine = line.id;
      }
      await prisma.dropSet.create({
        data: { siteKey: SITE, name: `${PREFIX}odds and ends`, lineId: line.id },
      });
      // The operator picks both, on every profile.
      for (const [sku, setName] of [
        [LINE_SKU, `${PREFIX}odds and ends`],
        [PLAIN_SKU, `${PREFIX}cards`],
      ]) {
        const product = await prisma.dropProduct.create({
          data: {
            siteKey: SITE,
            setName,
            name: `${PREFIX}${sku}`,
            url: `https://www.target.com/p/x/-/A-${sku}`,
            sku,
            createdBy: OPERATOR,
          },
        });
        await prisma.productSelection.create({
          data: { productId: product.id, discordUserId: OPERATOR },
        });
      }
    });

    afterAll(async () => {
      await cleanupProducts();
      if (madeLine) await prisma.dropLine.delete({ where: { id: madeLine } });
    });

    /** Our two products as an instance gets them: TCIN and whether it's the line's. */
    const ours = (products: { sku: string; misc: boolean }[]) =>
      products.filter((p) => [LINE_SKU, PLAIN_SKU].includes(p.sku)).map((p) => [p.sku, p.misc]);
    const picks = (profiles: { skus: string[] }[]) =>
      profiles.map((p) => p.skus.filter((sku) => [LINE_SKU, PLAIN_SKU].includes(sku)));

    it("goes only to an instance set to run it, and each says how many of its profiles picked it", async () => {
      const result = await buildShikariPayload(OPERATOR, {
        instances: [
          instance(1, "main", [OPERATOR], { misc: true }),
          instance(2, "backup", [OPERATOR], { misc: false }),
        ],
      });
      if (!result.ok) throw new Error(result.error);
      const [main, backup] = result.instances;

      // The main instance runs it: the product comes flagged, and its five run it.
      expect(main.misc).toEqual({ runs: true, picked: 5 });
      expect(ours(main.products)).toEqual([
        [LINE_SKU, true],
        [PLAIN_SKU, false],
      ]);
      expect(picks(main.profiles)).toEqual(Array(5).fill([LINE_SKU, PLAIN_SKU]));

      // The backup doesn't: neither the product nor a pick of it goes -- the line is Valor's
      // there -- but its two pickers are counted, for the review to warn with.
      expect(backup.misc).toEqual({ runs: false, picked: 2 });
      expect(ours(backup.products)).toEqual([[PLAIN_SKU, false]]);
      expect(picks(backup.profiles)).toEqual([[PLAIN_SKU], [PLAIN_SKU]]);
    });

    it("isn't run with the tasks section off, box ticked or not", async () => {
      const result = await buildShikariPayload(OPERATOR, {
        instances: [instance(1, "all", [OPERATOR], { tasks: false, misc: true })],
      });
      if (!result.ok) throw new Error(result.error);
      expect(result.instances[0].misc).toEqual({ runs: false, picked: 7 });
      expect(ours(result.instances[0].products)).toEqual([[PLAIN_SKU, false]]);
    });
  });
});

async function cleanupProducts() {
  // Picks go with their products.
  await prisma.dropProduct.deleteMany({
    where: { siteKey: SITE, sku: { in: [LINE_SKU, PLAIN_SKU] } },
  });
  await prisma.dropSet.deleteMany({ where: { siteKey: SITE, name: { startsWith: PREFIX } } });
}

async function cleanup() {
  await cleanupProducts();
  await prisma.raffle.deleteMany({ where: { sku: { in: [SKU, CLOSED_SKU] } } });
  await prisma.vaultExport.deleteMany({ where: { targetDiscordId: { in: [OPERATOR, OTHER] } } });
  await prisma.vaultProfile.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await prisma.vaultAccount.deleteMany({ where: { email: { startsWith: PREFIX } } });
  await prisma.discordMember.deleteMany({ where: { discordUserId: { in: [OPERATOR, OTHER] } } });
}

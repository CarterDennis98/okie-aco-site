/**
 * The Shikari export's server half, for raffles: which raffles each profile goes out entered
 * in, on which instance, and which entries no instance runs.
 *
 * The properties with something behind them: a member's raffle entries follow their profiles
 * through the main/backup split -- the first five (Target's soft cap, in name order) on the
 * main instance, the rest on the backup -- so no profile is entered from two bots; every
 * raffle on the site goes out to every instance, open or closed; and an entry no instance runs
 * is named, rather than silently left out of every backup.
 *
 * Real database, real vault crypto under a throwaway key. Nothing here is logged.
 */
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/db/client";
import { defaultInstanceConfig } from "@/lib/shikari/config";
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

const instance = (position: number, bot: "main" | "backup" | "all", memberIds: string[]) => ({
  position,
  config: { ...defaultInstanceConfig(memberIds), bot },
});

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
});

async function cleanup() {
  await prisma.raffle.deleteMany({ where: { sku: { in: [SKU, CLOSED_SKU] } } });
  await prisma.vaultExport.deleteMany({ where: { targetDiscordId: { in: [OPERATOR, OTHER] } } });
  await prisma.vaultProfile.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await prisma.vaultAccount.deleteMany({ where: { email: { startsWith: PREFIX } } });
  await prisma.discordMember.deleteMany({ where: { discordUserId: { in: [OPERATOR, OTHER] } } });
}

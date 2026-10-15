/**
 * A member's export of their own profiles.
 *
 * Three properties under test: the file is every profile the member holds on the retailer
 * (disabled ones too) and nobody else's; the cards come back decrypted in AYCD's shape; and
 * the export is on the record before anything is decrypted, as the operator's is. Refusals
 * write no record, because nothing left.
 *
 * The one thing faked is who is asking: requireMember reads a session cookie that cannot
 * exist outside a request. Everything after that -- the query, the decryption, the audit
 * row -- is the real code against the real database.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/vault/export/route";
import { prisma } from "@/db/client";
import { encrypt } from "@/lib/vault/crypto";

vi.mock("@/lib/auth/guard", () => ({
  requireMember: async () => ({
    discordUserId: "999900000000000951",
    username: "memberexportspec",
    displayName: "Member Export Spec",
    avatarUrl: null,
    isOg: false,
    isAdmin: false,
    adminSites: [],
  }),
}));

// Needs a database AND the keyring: the fixtures hold real encrypted secrets, which the
// route decrypts.
const canRun = Boolean(process.env.DATABASE_URL && process.env.VAULT_KEY_ACTIVE);

const MEMBER = "999900000000000951";
const OTHER = "999900000000000952";
const RUNNER = "999900000000000953";
const PREFIX = "member-export-spec-";

async function profile(
  owner: string,
  site: string,
  name: string,
  { active = true, card = "4242424242424242" }: { active?: boolean; card?: string } = {},
) {
  const account = await prisma.vaultAccount.create({
    data: {
      siteKey: site,
      email: `${PREFIX}${name}@example.com`,
      discordUserId: owner,
      assigneeId: RUNNER,
    },
  });
  await prisma.vaultProfile.create({
    data: {
      siteKey: site,
      discordUserId: owner,
      name: `${PREFIX}${name}`,
      profileKey: `${PREFIX}${name}`,
      active,
      accountId: account.id,
      firstName: "Test",
      lastName: "Member",
      phone: "4055551234",
      shipLine1: "1 Main St",
      shipCity: "Tulsa",
      shipState: "OK",
      shipPostalCode: "74103",
      cardBrand: "visa",
      cardLast4: card.slice(-4),
      cardExpMonth: "12",
      cardExpYear: "2030",
      cardNumberEnc: encrypt(card, { entity: "vault_profile", field: "card_number" }),
      cardCvvEnc: encrypt("123", { entity: "vault_profile", field: "card_cvv" }),
    },
  });
}

async function exportSite(query: string) {
  const response = await GET(new Request(`http://localhost/api/vault/export?${query}`));
  const disposition = response.headers.get("content-disposition") ?? "";
  return {
    status: response.status,
    body: await response.text(),
    filename: disposition.match(/filename="([^"]+)"/)?.[1] ?? null,
    cacheControl: response.headers.get("cache-control"),
  };
}

type AycdRow = {
  name: string;
  shippingAddress: { email: string; state: string };
  paymentDetails: { cardNumber: string; cardCvv: string };
};

async function cleanup() {
  const owners = { in: [MEMBER, OTHER] };
  await prisma.vaultExport.deleteMany({ where: { actorDiscordId: owners } });
  await prisma.vaultProfile.deleteMany({ where: { discordUserId: owners } });
  await prisma.vaultAccount.deleteMany({ where: { discordUserId: owners } });
  await prisma.discordMember.deleteMany({ where: { discordUserId: owners } });
}

describe.skipIf(!canRun)("a member's own export", () => {
  beforeAll(async () => {
    await cleanup();
    await prisma.discordMember.createMany({
      data: [MEMBER, OTHER].map((discordUserId) => ({
        discordUserId,
        username: `member-export-spec-${discordUserId.slice(-3)}`,
        roles: [],
      })),
    });
    await profile(MEMBER, "topps", "a - 2");
    await profile(MEMBER, "topps", "a - 10", { active: false, card: "5555555555554444" });
    await profile(MEMBER, "topps", "a");
    await profile(MEMBER, "target", "a-target");
    await profile(OTHER, "topps", "b");
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  it("hands over every profile of theirs on the retailer, decrypted, on the record", async () => {
    const { status, body, filename, cacheControl } = await exportSite("site=topps");
    expect(status).toBe(200);
    expect(filename).toMatch(/^okie-profiles-topps-\d{4}-\d{2}-\d{2}\.json$/);
    expect(cacheControl).toContain("no-store");

    const rows = JSON.parse(body) as AycdRow[];
    // Theirs only, the disabled one included, in the order their list shows.
    expect(rows.map((row) => row.name)).toEqual([
      `${PREFIX}a`,
      `${PREFIX}a - 2`,
      `${PREFIX}a - 10`,
    ]);
    expect(rows[2].paymentDetails).toEqual(
      expect.objectContaining({ cardNumber: "5555555555554444", cardCvv: "123" }),
    );
    // AYCD's shape, not ours: the full state name, the login's email on the address.
    expect(rows[0].shippingAddress).toEqual(
      expect.objectContaining({ email: `${PREFIX}a@example.com`, state: "Oklahoma" }),
    );

    const records = await prisma.vaultExport.findMany({ where: { actorDiscordId: MEMBER } });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      siteKey: "topps",
      format: "aycd",
      scope: "self",
      targetDiscordId: MEMBER,
      profileCount: 3,
      accountCount: 0,
    });
  });

  it("reads the same rows for a retailer typed the way people say it", async () => {
    const { status, body } = await exportSite("site=Topps");
    expect(status).toBe(200);
    expect((JSON.parse(body) as AycdRow[]).map((row) => row.name)).toHaveLength(3);
  });

  it("refuses what has no profiles to export, and records nothing", async () => {
    await prisma.vaultExport.deleteMany({ where: { actorDiscordId: MEMBER } });

    expect((await exportSite("site=costco")).status).toBe(400);
    expect((await exportSite("site=nowhere")).status).toBe(400);
    expect((await exportSite("")).status).toBe(400);

    expect(await prisma.vaultExport.count({ where: { actorDiscordId: MEMBER } })).toBe(0);
  });
});

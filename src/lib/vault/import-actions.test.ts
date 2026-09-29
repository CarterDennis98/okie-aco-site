/**
 * The member's profile upload, end to end.
 *
 * What only the action can decide, pinned against the real database: which retailers take
 * a Valor file at all, that one imports on Pokémon Center with no logins asked for, that
 * the card lands encrypted, and that the stored name is the member's own sequence --
 * never the file's.
 *
 * Faked: who is signed in (the guard reads a session cookie that can't exist outside a
 * request), Next's cache revalidation, and the operator notification -- which would
 * otherwise post to the real vault webhook the local .env points at. Every card is a
 * published test number.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/db/client";
import { toAycdProfile } from "@/lib/vault/aycd";
import { decrypt, isEnvelope } from "@/lib/vault/crypto";
import { importProfileFile } from "@/lib/vault/import-actions";

const MEMBER = "999900000000000401";
const OPERATOR = "999900000000000402";

vi.mock("@/lib/auth/guard", () => ({
  requireMember: async () => ({
    discordUserId: "999900000000000401",
    username: "valorspec",
    displayName: "Valor Spec",
    avatarUrl: null,
    isOg: false,
    isAdmin: false,
  }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

const notified = vi.hoisted(() => ({
  calls: [] as { changes: { fields?: string[]; label: string }[]; summary: string }[],
}));
vi.mock("@/lib/vault/audit", () => ({
  recordBulkChange: async (
    changes: { fields?: string[]; label: string }[],
    _actor: string,
    summary: string,
  ) => {
    notified.calls.push({ changes, summary });
  },
}));

const canRun = Boolean(process.env.DATABASE_URL && process.env.VAULT_KEY_ACTIVE);

function valorProfile(id: string, email: string, number: string) {
  const address = {
    firstName: "%fname%",
    lastName: "%lname%",
    addressLine1: "QRS 123 Main St",
    addressLine2: "",
    city: "Norman",
    countryName: "United States",
    countryCode: "US",
    state: "Oklahoma",
    zipCode: "73069",
  };
  return {
    name: `${email.split("@")[0]}_Pokemoncenter`,
    email,
    emailPassword: "",
    phoneNumber: "0",
    billingSameAsShipping: true,
    oneCheckout: false,
    quickTask: false,
    card: { holder: "Test Holder", number, expiration: "09/31", cvv: "123", type: "mastercard" },
    shipping: address,
    billing: address,
    id,
    totalSpent: 0,
  };
}

const VALOR_FILE = JSON.stringify({
  "3f2b0c1e-0000-4000-8000-000000000001": valorProfile(
    "3f2b0c1e-0000-4000-8000-000000000001",
    "valorspec.one@example.com",
    "5555 5555 5555 4444",
  ),
  "3f2b0c1e-0000-4000-8000-000000000002": valorProfile(
    "3f2b0c1e-0000-4000-8000-000000000002",
    "valorspec.two@example.com",
    "5105 1051 0510 5100",
  ),
});

function upload(siteKey: string, profiles: string): FormData {
  const form = new FormData();
  form.set("siteKey", siteKey);
  form.set("profiles", new File([profiles], "profiles.json", { type: "application/json" }));
  return form;
}

async function cleanup() {
  await prisma.vaultProfile.deleteMany({ where: { discordUserId: MEMBER } });
  await prisma.vaultAccount.deleteMany({ where: { discordUserId: MEMBER } });
  await prisma.discordMember.deleteMany({ where: { discordUserId: MEMBER } });
}

describe.skipIf(!canRun)("importProfileFile", () => {
  let adminIds: string | undefined;

  beforeAll(async () => {
    adminIds = process.env.ADMIN_DISCORD_IDS;
    // New rows go to the retailer's runner, and Pokémon Center's is the operator.
    process.env.ADMIN_DISCORD_IDS = OPERATOR;
    await cleanup();
    await prisma.discordMember.create({
      data: { discordUserId: MEMBER, username: "valorspec", globalName: "Valor Spec" },
    });
  });

  afterAll(async () => {
    await cleanup();
    if (adminIds === undefined) delete process.env.ADMIN_DISCORD_IDS;
    else process.env.ADMIN_DISCORD_IDS = adminIds;
  });

  beforeEach(() => {
    notified.calls.length = 0;
  });

  it("imports Valor's own file on Pokémon Center, with no logins asked for", async () => {
    const result = await importProfileFile(upload("pokemon-center", VALOR_FILE));
    expect(result).toEqual({
      ok: true,
      created: 2,
      updated: 0,
      skipped: 0,
      needPassword: [],
      issues: [],
    });

    const rows = await prisma.vaultProfile.findMany({
      where: { discordUserId: MEMBER, siteKey: "pokemon-center" },
      orderBy: { name: "asc" },
      include: { account: true },
    });
    // The member's own sequence, not the "<name>_Pokemoncenter" the file carried.
    expect(rows.map((row) => row.name)).toEqual(["valorspec", "valorspec - 2"]);
    expect(rows.map((row) => row.account.email)).toEqual([
      "valorspec.one@example.com",
      "valorspec.two@example.com",
    ]);

    const [first] = rows;
    // Guest checkout: an account that carries the address, and no login.
    expect(first.account.passwordEnc).toBeNull();
    expect(first.account.assigneeId).toBe(OPERATOR);
    // Valor's placeholders and its "make up a phone" are instructions to the bot -- kept.
    expect([first.firstName, first.lastName, first.phone]).toEqual(["%fname%", "%lname%", "0"]);
    expect([first.shipState, first.cardBrand, first.cardLast4]).toEqual([
      "OK",
      "MasterCard",
      "4444",
    ]);
    expect([first.cardExpMonth, first.cardExpYear]).toEqual(["09", "2031"]);
    // Encrypted on arrival, and the card that went in is the card that comes back out.
    expect(isEnvelope(first.cardNumberEnc)).toBe(true);
    expect(decrypt(first.cardNumberEnc, { entity: "vault_profile", field: "card_number" })).toBe(
      "5555555555554444",
    );
    expect(decrypt(first.cardCvvEnc, { entity: "vault_profile", field: "card_cvv" })).toBe("123");

    // The operator's queue and the audit trail say where the profiles came from.
    expect(notified.calls).toHaveLength(1);
    expect(notified.calls[0].summary).toMatch(/from Valor$/);
    expect(notified.calls[0].changes.map((change) => change.fields)).toEqual([
      ["imported from Valor"],
      ["imported from Valor"],
    ]);
  });

  it("updates in place when the same file is uploaded again", async () => {
    const result = await importProfileFile(upload("pokemon-center", VALOR_FILE));
    expect(result).toMatchObject({ ok: true, created: 0, updated: 2 });
    expect(
      await prisma.vaultProfile.count({
        where: { discordUserId: MEMBER, siteKey: "pokemon-center" },
      }),
    ).toBe(2);
  });

  it("refuses a Valor file on a retailer that doesn't take one", async () => {
    const result = await importProfileFile(upload("target", VALOR_FILE));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/Valor.*Pokémon Center only.*AYCD/);
    expect(
      await prisma.vaultAccount.count({ where: { discordUserId: MEMBER, siteKey: "target" } }),
    ).toBe(0);
    expect(notified.calls).toHaveLength(0);
  });

  it("still takes an AYCD file on Pokémon Center", async () => {
    const aycd = toAycdProfile({
      id: "cm0a1b2c3d4e5f6g7h8i9j0k",
      siteKey: "pokemon-center",
      name: "whatever - 9",
      email: "valorspec.three@example.com",
      firstName: "Jane",
      lastName: "Public",
      phone: null,
      shipLine1: "123 Main St",
      shipLine2: null,
      shipCity: "Norman",
      shipState: "OK",
      shipPostalCode: "73069",
      shipCountry: "US",
      sameBillingAndShipping: true,
      billFirstName: null,
      billLastName: null,
      billLine1: null,
      billLine2: null,
      billCity: null,
      billState: null,
      billPostalCode: null,
      billCountry: null,
      onlyCheckoutOnce: false,
      matchNameOnCardAndAddress: false,
      cardBrand: "Visa",
      cardExpMonth: "07",
      cardExpYear: "2030",
      cardNumber: "4111111111111111",
      cardCvv: "321",
    });

    const result = await importProfileFile(upload("pokemon-center", JSON.stringify([aycd])));
    expect(result).toMatchObject({ ok: true, created: 1, updated: 0 });
    expect(notified.calls[0].changes.map((change) => change.fields)).toEqual([
      ["imported from AYCD"],
    ]);
  });
});

/**
 * The address book end to end, and the two places it meets a profile: a saved card filling one,
 * and a profile copied into the book. Plus what an edit does to a profile's failure flags.
 *
 * Pinned against the real database, because the bugs worth catching here are all in what gets
 * written: a card that lands in a profile's columns still sealed for the book's (and so can
 * never be exported), another member's card or address reachable by id, a duplicate added
 * twice, and a flag that survives the edit that should have cleared it -- or clears on a save
 * that changed nothing.
 *
 * Faked, as in finish-login.test.ts: who is signed in, Next's cache revalidation, and the
 * operator notification (the real one would post to the vault webhook the local .env points
 * at). `changedFields` stays real -- whether a save changed anything is under test.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/db/client";
import { getAddressBook } from "@/db/queries/address-book";
import { loadFailureFlags } from "@/db/queries/failures";
import {
  deleteSavedAddress,
  deleteSavedCard,
  saveProfileToAddressBook,
  saveSavedAddress,
  saveSavedCard,
} from "@/lib/vault/address-book-actions";
import { saveProfile } from "@/lib/vault/actions";
import { sealCard } from "@/lib/vault/card-secrets";
import { decrypt } from "@/lib/vault/crypto";

const MEMBER = "999900000000000971";
const OTHER = "999900000000000972";
const SITE = "target";
const DOMAIN = "book-spec.example.com";
const MESSAGE_PREFIX = "15379100000000";

vi.mock("@/lib/auth/guard", () => ({
  requireMember: async () => ({
    discordUserId: "999900000000000971",
    username: "bookspec",
    displayName: "Book Spec",
    avatarUrl: null,
    isOg: false,
    isAdmin: false,
    adminSites: [],
    signedInAs: null,
  }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/vault/audit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/vault/audit")>()),
  recordChange: async () => {},
  recordBulkChange: async () => {},
}));

const canRun = Boolean(process.env.DATABASE_URL && process.env.VAULT_KEY_ACTIVE);

const PROFILE_NUMBER = { entity: "vault_profile", field: "card_number" };
const PROFILE_CVV = { entity: "vault_profile", field: "card_cvv" };
const BOOK_NUMBER = { entity: "saved_card", field: "card_number" };

function formOf(values: Record<string, string>): FormData {
  const form = new FormData();
  for (const [key, value] of Object.entries(values)) if (value !== "") form.set(key, value);
  return form;
}

const ADDRESS = {
  firstName: "Book",
  lastName: "Spec",
  phone: "4055551234",
  shipLine1: "1 Main St",
  shipCity: "Tulsa",
  shipState: "OK",
  shipPostalCode: "74103",
  sameBillingAndShipping: "on",
};

const CARD = {
  cardNumber: "4242424242424242",
  cardCvv: "052",
  cardExpMonth: "1",
  cardExpYear: "2031",
};

/** The add-profile form, card fields left out unless given. */
function profileForm(over: Record<string, string>) {
  return formOf({ siteKey: SITE, ...ADDRESS, matchNameOnCardAndAddress: "on", ...over });
}

async function cleanup() {
  const owners = { in: [MEMBER, OTHER] };
  await prisma.checkoutFailure.deleteMany({
    where: { discordMessageId: { startsWith: MESSAGE_PREFIX } },
  });
  await prisma.savedCard.deleteMany({ where: { discordUserId: owners } });
  await prisma.savedAddress.deleteMany({ where: { discordUserId: owners } });
  await prisma.vaultProfile.deleteMany({ where: { discordUserId: owners } });
  await prisma.vaultAccount.deleteMany({ where: { discordUserId: owners } });
  await prisma.discordMember.deleteMany({ where: { discordUserId: owners } });
}

const mineOnSite = () =>
  prisma.vaultProfile.findMany({
    where: { discordUserId: MEMBER, siteKey: SITE },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      name: true,
      cardBrand: true,
      cardLast4: true,
      cardExpMonth: true,
      cardExpYear: true,
      cardNumberEnc: true,
      cardCvvEnc: true,
      shipCity: true,
    },
  });

describe.skipIf(!canRun)("the address book", () => {
  beforeEach(async () => {
    await cleanup();
    await prisma.discordMember.createMany({
      data: [
        { discordUserId: MEMBER, username: "bookspec", roles: [] },
        { discordUserId: OTHER, username: "bookspec-other", roles: [] },
      ],
    });
  });

  afterAll(cleanup);

  it("keeps a card write-only, sealed for the book, and only once", async () => {
    expect(await saveSavedCard(formOf({ ...CARD, label: "  Daily  Visa " }))).toEqual({ ok: true });
    const [card] = (await getAddressBook(MEMBER)).cards;
    expect(card).toMatchObject({
      label: "Daily Visa",
      cardBrand: "Visa",
      cardLast4: "4242",
      cardExpMonth: "01",
      cardExpYear: "2031",
    });
    // The read the page renders never carries the envelopes.
    expect(Object.keys(card)).not.toContain("cardNumberEnc");

    const row = await prisma.savedCard.findUniqueOrThrow({ where: { id: card.id } });
    expect(decrypt(row.cardNumberEnc, BOOK_NUMBER)).toBe("4242424242424242");

    const twice = await saveSavedCard(formOf(CARD));
    expect(twice).toMatchObject({
      ok: false,
      error: expect.stringMatching(/already in your address book/),
    });
  });

  it("edits a card's expiry alone, keeping its number", async () => {
    await saveSavedCard(formOf(CARD));
    const [card] = (await getAddressBook(MEMBER)).cards;
    const before = await prisma.savedCard.findUniqueOrThrow({ where: { id: card.id } });

    const result = await saveSavedCard(
      formOf({ cardId: card.id, cardExpMonth: "6", cardExpYear: "2032" }),
    );
    expect(result).toEqual({ ok: true });
    const after = await prisma.savedCard.findUniqueOrThrow({ where: { id: card.id } });
    expect(after).toMatchObject({ cardExpMonth: "06", cardExpYear: "2032", cardLast4: "4242" });
    expect(after.cardNumberEnc).toBe(before.cardNumberEnc);
  });

  it("keeps addresses to a profile's rules, and each member to their own", async () => {
    expect(await saveSavedAddress(formOf({ ...ADDRESS, shipPostalCode: "741" }))).toMatchObject({
      ok: false,
    });
    expect(await saveSavedAddress(formOf({ ...ADDRESS, label: "Home" }))).toEqual({ ok: true });

    const theirs = await prisma.savedAddress.create({
      data: {
        discordUserId: OTHER,
        firstName: "Not",
        lastName: "Mine",
        shipLine1: "2 Elm",
        shipCity: "Norman",
        shipState: "OK",
        shipPostalCode: "73069",
      },
    });
    // Someone else's id reads as missing, for an edit and a removal alike.
    expect(await saveSavedAddress(formOf({ ...ADDRESS, addressId: theirs.id }))).toMatchObject({
      ok: false,
    });
    expect(await deleteSavedAddress(formOf({ addressId: theirs.id }))).toMatchObject({ ok: false });
    expect(await prisma.savedAddress.findUnique({ where: { id: theirs.id } })).not.toBeNull();

    const [home] = (await getAddressBook(MEMBER)).addresses;
    expect(home).toMatchObject({ label: "Home", shipCity: "Tulsa", phone: "4055551234" });
    expect(await deleteSavedAddress(formOf({ addressId: home.id }))).toEqual({ ok: true });
    expect((await getAddressBook(MEMBER)).addresses).toEqual([]);
  });

  it("fills a new profile from a saved card, re-sealed for the profile's own columns", async () => {
    await saveSavedCard(formOf(CARD));
    const [card] = (await getAddressBook(MEMBER)).cards;

    const result = await saveProfile(
      profileForm({
        email: `filled@${DOMAIN}`,
        accountPassword: "pw",
        savedCardId: card.id,
        // Whatever the form says, the expiry is the saved card's.
        cardExpMonth: "9",
        cardExpYear: "2099",
      }),
    );
    expect(result).toEqual({ ok: true });

    const [profile] = await mineOnSite();
    expect(profile).toMatchObject({
      cardBrand: "Visa",
      cardLast4: "4242",
      cardExpMonth: "01",
      cardExpYear: "2031",
    });
    // What the export decrypts: the number, under the PROFILE's binding.
    expect(decrypt(profile.cardNumberEnc, PROFILE_NUMBER)).toBe("4242424242424242");
    expect(decrypt(profile.cardCvvEnc, PROFILE_CVV)).toBe("052");
  });

  it("lets a typed card win over a picked one, and refuses another member's card", async () => {
    const theirs = await prisma.savedCard.create({
      data: {
        discordUserId: OTHER,
        cardBrand: "Visa",
        cardLast4: "1111",
        cardExpMonth: "01",
        cardExpYear: "2031",
        ...sealCard("4111111111111111", "123", "saved_card"),
      },
    });

    const refused = await saveProfile(
      profileForm({ email: `theirs@${DOMAIN}`, accountPassword: "pw", savedCardId: theirs.id }),
    );
    expect(refused).toMatchObject({ ok: false, error: expect.stringMatching(/address book/) });
    expect(await mineOnSite()).toEqual([]);

    // A typed number is used, and the (foreign) pick never even looked up.
    const typed = await saveProfile(
      profileForm({
        email: `typed@${DOMAIN}`,
        accountPassword: "pw",
        savedCardId: theirs.id,
        cardNumber: "5555555555554444",
        cardCvv: "321",
        cardExpMonth: "3",
        cardExpYear: "2030",
      }),
    );
    expect(typed).toEqual({ ok: true });
    expect((await mineOnSite())[0]).toMatchObject({ cardBrand: "MasterCard", cardLast4: "4444" });
  });

  it("copies a profile's address and card into the book, once", async () => {
    await saveProfile(profileForm({ email: `copy@${DOMAIN}`, accountPassword: "pw", ...CARD }));
    const [profile] = await mineOnSite();

    const first = await saveProfileToAddressBook(formOf({ profileId: profile.id }));
    expect(first).toMatchObject({
      ok: true,
      message: expect.stringMatching(/Saved its address; saved its card/),
    });

    const book = await getAddressBook(MEMBER);
    expect(book.addresses).toHaveLength(1);
    expect(book.addresses[0]).toMatchObject({ firstName: "Book", shipCity: "Tulsa", label: null });
    expect(book.cards).toHaveLength(1);
    const saved = await prisma.savedCard.findUniqueOrThrow({ where: { id: book.cards[0].id } });
    expect(decrypt(saved.cardNumberEnc, BOOK_NUMBER)).toBe("4242424242424242");

    const second = await saveProfileToAddressBook(formOf({ profileId: profile.id }));
    expect(second).toMatchObject({ ok: true, message: expect.stringMatching(/already/) });
    expect((await getAddressBook(MEMBER)).cards).toHaveLength(1);

    // Removing the saved card leaves the profile's alone: they were copies.
    expect(await deleteSavedCard(formOf({ cardId: book.cards[0].id }))).toEqual({ ok: true });
    expect((await mineOnSite())[0].cardLast4).toBe("4242");
  });

  it("clears a profile's failure flag on an edit that changes something, and only then", async () => {
    await saveProfile(profileForm({ email: `flag@${DOMAIN}`, accountPassword: "pw", ...CARD }));
    const [profile] = await mineOnSite();
    await prisma.checkoutFailure.createMany({
      data: [0, 1, 2].map((n) => ({
        sourceBot: "valor",
        discordMessageId: `${MESSAGE_PREFIX}000${n}`,
        discordChannelId: "1420180854617018399",
        occurredAt: new Date(Date.now() - (n + 1) * 60_000),
        siteKey: SITE,
        profileRaw: profile.name,
        reason: "Payment Declined",
        vaultProfileId: profile.id,
      })),
    });
    expect((await loadFailureFlags(MEMBER)).get(profile.id)).toMatchObject({
      count: 3,
      risk: "high",
    });

    const edit = {
      profileId: profile.id,
      email: `flag@${DOMAIN}`,
      cardExpMonth: "01",
      cardExpYear: "2031",
    };
    // Saved exactly as it was: three failures and nothing changed is what red is for.
    expect(await saveProfile(profileForm(edit))).toEqual({ ok: true });
    expect((await loadFailureFlags(MEMBER)).get(profile.id)).toMatchObject({ count: 3 });

    // A real change: the flag goes, and the profile remembers when.
    expect(await saveProfile(profileForm({ ...edit, shipCity: "Broken Arrow" }))).toEqual({
      ok: true,
    });
    expect((await loadFailureFlags(MEMBER)).has(profile.id)).toBe(false);
    const after = await prisma.vaultProfile.findUniqueOrThrow({
      where: { id: profile.id },
      select: { failuresClearedAt: true, shipCity: true },
    });
    expect(after.shipCity).toBe("Broken Arrow");
    expect(after.failuresClearedAt).not.toBeNull();
  });
});

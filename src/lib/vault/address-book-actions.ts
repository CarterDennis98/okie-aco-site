"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/db/client";
import { SAVED_ADDRESS_SELECT, SAVED_CARD_SELECT } from "@/db/queries/address-book";
import { requireMember } from "@/lib/auth/guard";
import {
  addressFingerprint,
  cardTitle,
  cleanLabel,
  hasCard,
  MAX_SAVED_ADDRESSES,
  MAX_SAVED_CARDS,
  type SavedAddressFields,
} from "@/lib/vault/address-book";
import { detectBrand, last4, normalizeExpiry, normalizePan } from "@/lib/vault/card";
import { moveCard, sealCard } from "@/lib/vault/card-secrets";
import {
  addressFieldsFromForm,
  text,
  validateAddressForm,
  validateCardForm,
} from "@/lib/vault/profile-input";
import type { ActionResult } from "@/lib/vault/actions";

/**
 * Every write to the address book. See SavedAddress and SavedCard in the schema.
 *
 * The rules are the vault's (lib/vault/actions.ts), for the same reasons:
 *
 *   - `requireMember()` inside each action, and the owner id only ever from its return value.
 *     Every write by id carries both predicates, so another member's id reads as missing.
 *   - The card number and security code are WRITE-ONLY. A blank number on an edit keeps the
 *     card on file; nothing is ever read back to the browser.
 *   - Nothing is logged: not the values, not the form, not on error.
 *
 * And one of its own: NOTHING HERE TOUCHES A PROFILE. An entry is copied into a profile when
 * the member uses it, by saveProfile; editing or removing it afterwards changes no profile and
 * puts nothing in a runner's queue, because no bot ever reads the book.
 */

const PAGE = "/dashboard/profiles";

export async function saveSavedAddress(form: FormData): Promise<ActionResult> {
  const viewer = await requireMember();
  const addressId = text(form, "addressId");

  const problem = validateAddressForm(form);
  if (problem) return { ok: false, error: problem };
  const data = { ...addressFieldsFromForm(form), label: cleanLabel(text(form, "label")) };

  try {
    if (!addressId) {
      const held = await prisma.savedAddress.count({
        where: { discordUserId: viewer.discordUserId },
      });
      if (held >= MAX_SAVED_ADDRESSES) {
        return {
          ok: false,
          error: `Your address book holds ${MAX_SAVED_ADDRESSES} addresses. Remove one to add another.`,
        };
      }
      await prisma.savedAddress.create({ data: { ...data, discordUserId: viewer.discordUserId } });
    } else {
      const { count } = await prisma.savedAddress.updateMany({
        where: { id: addressId, discordUserId: viewer.discordUserId },
        data,
      });
      if (count === 0)
        return { ok: false, error: "That address isn't in your address book anymore." };
    }
  } catch (error) {
    console.error(
      "address book: saveSavedAddress failed",
      error instanceof Error ? error.message : "unknown",
    );
    return { ok: false, error: "Couldn't save that address." };
  }

  revalidatePath(PAGE);
  return { ok: true };
}

export async function deleteSavedAddress(form: FormData): Promise<ActionResult> {
  const viewer = await requireMember();
  const { count } = await prisma.savedAddress.deleteMany({
    where: { id: text(form, "addressId"), discordUserId: viewer.discordUserId },
  });
  if (count === 0) return { ok: false, error: "That address isn't in your address book anymore." };

  revalidatePath(PAGE);
  return { ok: true };
}

/**
 * Add a card, or edit one. Editing can change the label and the expiry alone -- a reissued card
 * with a new date -- or replace the number, which then needs its security code, exactly as on a
 * profile.
 */
export async function saveSavedCard(form: FormData): Promise<ActionResult> {
  const viewer = await requireMember();
  const cardId = text(form, "cardId");

  const problem = validateCardForm(form, !cardId);
  if (problem) return { ok: false, error: problem };

  const pan = normalizePan(text(form, "cardNumber"));
  const { month, year } = normalizeExpiry(text(form, "cardExpMonth"), text(form, "cardExpYear"));
  const label = cleanLabel(text(form, "label"));

  try {
    // Sealed for the book's own columns, never a profile's. See card-secrets.ts.
    const number = pan
      ? {
          cardBrand: detectBrand(pan),
          cardLast4: last4(pan),
          ...sealCard(pan, text(form, "cardCvv"), "saved_card"),
        }
      : null;

    if (!cardId) {
      // validateCardForm has required a number to get here.
      const saved = await prisma.savedCard.findMany({
        where: { discordUserId: viewer.discordUserId },
        select: SAVED_CARD_SELECT,
      });
      if (saved.length >= MAX_SAVED_CARDS) {
        return {
          ok: false,
          error: `Your address book holds ${MAX_SAVED_CARDS} cards. Remove one to add another.`,
        };
      }
      const twin = saved.find((card) =>
        hasCard([card], { ...number!, cardExpMonth: month, cardExpYear: year }),
      );
      if (twin) {
        return {
          ok: false,
          error: `That card is already in your address book as ${cardTitle(twin)}.`,
        };
      }
      await prisma.savedCard.create({
        data: {
          ...number!,
          label,
          cardExpMonth: month,
          cardExpYear: year,
          discordUserId: viewer.discordUserId,
        },
      });
    } else {
      const { count } = await prisma.savedCard.updateMany({
        where: { id: cardId, discordUserId: viewer.discordUserId },
        data: { ...(number ?? {}), label, cardExpMonth: month, cardExpYear: year },
      });
      if (count === 0) return { ok: false, error: "That card isn't in your address book anymore." };
    }
  } catch (error) {
    console.error(
      "address book: saveSavedCard failed",
      error instanceof Error ? error.message : "unknown",
    );
    return { ok: false, error: "Couldn't save that card." };
  }

  revalidatePath(PAGE);
  return { ok: true };
}

export async function deleteSavedCard(form: FormData): Promise<ActionResult> {
  const viewer = await requireMember();
  const { count } = await prisma.savedCard.deleteMany({
    where: { id: text(form, "cardId"), discordUserId: viewer.discordUserId },
  });
  if (count === 0) return { ok: false, error: "That card isn't in your address book anymore." };

  revalidatePath(PAGE);
  return { ok: true };
}

export type CopyToBookResult = { ok: true; message: string } | { ok: false; error: string };

/**
 * Copy one of the member's profiles into their address book: its address, and its card.
 *
 * The quick way to fill the book for a member who already has profiles -- nobody has to type a
 * card they already gave us. The card is re-sealed for the book's own columns on the server
 * (card-secrets.ts); the number never leaves it.
 *
 * Either half that is already in the book is skipped rather than added twice, and the answer
 * says what happened. So is a card with nothing to copy: some imported profiles carry no
 * security code, and a saved card without one would only fail the next profile filled from it.
 */
export async function saveProfileToAddressBook(form: FormData): Promise<CopyToBookResult> {
  const viewer = await requireMember();
  const owner = viewer.discordUserId;

  const profile = await prisma.vaultProfile.findFirst({
    // Both predicates, never fetch-then-compare.
    where: { id: text(form, "profileId"), discordUserId: owner },
    select: {
      name: true,
      firstName: true,
      lastName: true,
      phone: true,
      shipLine1: true,
      shipLine2: true,
      shipCity: true,
      shipState: true,
      shipPostalCode: true,
      shipCountry: true,
      sameBillingAndShipping: true,
      billFirstName: true,
      billLastName: true,
      billLine1: true,
      billLine2: true,
      billCity: true,
      billState: true,
      billPostalCode: true,
      billCountry: true,
      cardBrand: true,
      cardLast4: true,
      cardExpMonth: true,
      cardExpYear: true,
      cardNumberEnc: true,
      cardCvvEnc: true,
    },
  });
  if (!profile) return { ok: false, error: "Profile not found." };

  const [addresses, cards] = await Promise.all([
    prisma.savedAddress.findMany({ where: { discordUserId: owner }, select: SAVED_ADDRESS_SELECT }),
    prisma.savedCard.findMany({ where: { discordUserId: owner }, select: SAVED_CARD_SELECT }),
  ]);

  const address: SavedAddressFields = {
    firstName: profile.firstName,
    lastName: profile.lastName,
    phone: profile.phone,
    shipLine1: profile.shipLine1,
    shipLine2: profile.shipLine2,
    shipCity: profile.shipCity,
    shipState: profile.shipState,
    shipPostalCode: profile.shipPostalCode,
    shipCountry: profile.shipCountry,
    sameBillingAndShipping: profile.sameBillingAndShipping,
    billFirstName: profile.billFirstName,
    billLastName: profile.billLastName,
    billLine1: profile.billLine1,
    billLine2: profile.billLine2,
    billCity: profile.billCity,
    billState: profile.billState,
    billPostalCode: profile.billPostalCode,
    billCountry: profile.billCountry,
  };
  const fingerprint = addressFingerprint(address);
  const addressHeld = addresses.some((saved) => addressFingerprint(saved) === fingerprint);
  const cardHeld = hasCard(cards, profile);
  // Whether there is anything to copy, asked of the envelopes without opening them: an absent
  // secret is stored as the empty string (crypto.ts, `encrypt`).
  const cardComplete = profile.cardNumberEnc !== "" && profile.cardCvvEnc !== "";

  const addAddress = !addressHeld && addresses.length < MAX_SAVED_ADDRESSES;
  const addCard = !cardHeld && cardComplete && cards.length < MAX_SAVED_CARDS;

  if (addAddress || addCard) {
    try {
      const sealed = addCard
        ? moveCard(
            { cardNumberEnc: profile.cardNumberEnc, cardCvvEnc: profile.cardCvvEnc },
            "vault_profile",
            "saved_card",
          )
        : null;
      await prisma.$transaction([
        ...(addAddress
          ? [prisma.savedAddress.create({ data: { ...address, discordUserId: owner } })]
          : []),
        ...(sealed
          ? [
              prisma.savedCard.create({
                data: {
                  ...sealed,
                  cardBrand: profile.cardBrand,
                  cardLast4: profile.cardLast4,
                  cardExpMonth: profile.cardExpMonth,
                  cardExpYear: profile.cardExpYear,
                  discordUserId: owner,
                },
              }),
            ]
          : []),
      ]);
    } catch (error) {
      console.error(
        "address book: saveProfileToAddressBook failed",
        error instanceof Error ? error.message : "unknown",
      );
      return { ok: false, error: `Couldn't copy ${profile.name} into your address book.` };
    }
    revalidatePath(PAGE);
  }

  // What happened to each half, in the member's words.
  const said: string[] = [];
  if (addAddress) said.push("Saved its address");
  else if (addressHeld) said.push("Its address is already in your book");
  else
    said.push(
      `Address book is full (${MAX_SAVED_ADDRESSES} addresses), so its address wasn't saved`,
    );

  if (addCard) said.push("saved its card");
  else if (cardHeld) said.push("its card is already there");
  else if (!cardComplete)
    said.push("its card has no security code on file to copy — add that card by hand");
  else said.push(`the book is full (${MAX_SAVED_CARDS} cards), so its card wasn't saved`);

  return { ok: true, message: `${said.join("; ")}.` };
}

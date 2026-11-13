import { cardSignature, isExpired, maskedLabel } from "@/lib/vault/card";

/**
 * The member's address book: addresses and cards kept once, to fill a new profile on any
 * retailer from. See SavedAddress and SavedCard in the schema for what it is and is not.
 *
 * Plain functions and types, no "server-only": the profile form renders the pickers from
 * these in the browser, and the actions dedupe with them on the server. Nothing here sees a
 * card number -- a saved card arrives as brand, last four and expiry, like a profile's does.
 */

/** Enough for any one person; a guard against a runaway script, not a limit anyone should hit. */
export const MAX_SAVED_ADDRESSES = 25;
export const MAX_SAVED_CARDS = 25;

/** "Home", "Mom's Amex" -- a nickname, so short. */
export const MAX_LABEL_LENGTH = 40;

export type SavedAddressFields = {
  firstName: string;
  lastName: string;
  phone: string | null;
  shipLine1: string;
  shipLine2: string | null;
  shipCity: string;
  shipState: string;
  shipPostalCode: string;
  shipCountry: string;
  sameBillingAndShipping: boolean;
  billFirstName: string | null;
  billLastName: string | null;
  billLine1: string | null;
  billLine2: string | null;
  billCity: string | null;
  billState: string | null;
  billPostalCode: string | null;
  billCountry: string | null;
};

export type SavedAddressSummary = SavedAddressFields & {
  id: string;
  label: string | null;
  updatedAt: Date;
};

export type SavedCardSummary = {
  id: string;
  label: string | null;
  cardBrand: string;
  cardLast4: string;
  cardExpMonth: string;
  cardExpYear: string;
  /** "Visa ···· 3384" */
  cardLabel: string;
  cardExpired: boolean;
  updatedAt: Date;
};

export type AddressBook = { addresses: SavedAddressSummary[]; cards: SavedCardSummary[] };

export const EMPTY_ADDRESS_BOOK: AddressBook = { addresses: [], cards: [] };

/** A label as typed, tidied: trimmed, spaces collapsed, capped. Null when there is none. */
export function cleanLabel(raw: string | null | undefined): string | null {
  const label = String(raw ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_LABEL_LENGTH)
    .trim();
  return label || null;
}

/** What a list shows first: the member's own label, else the name on it. */
export function addressTitle(
  address: Pick<SavedAddressSummary, "label" | "firstName" | "lastName">,
) {
  return address.label ?? `${address.firstName} ${address.lastName}`;
}

/** "10621 NW 40th Ter, Apt 2, Yukon, OK 73099" */
export function addressLine(
  address: Pick<
    SavedAddressFields,
    "shipLine1" | "shipLine2" | "shipCity" | "shipState" | "shipPostalCode"
  >,
): string {
  const street = [address.shipLine1, address.shipLine2].filter(Boolean).join(", ");
  return `${street}, ${address.shipCity}, ${address.shipState} ${address.shipPostalCode}`;
}

/** What a list shows for a card: its label and the masked number, or the masked number. */
export function cardTitle(card: Pick<SavedCardSummary, "label" | "cardBrand" | "cardLast4">) {
  const masked = maskedLabel(card.cardBrand, card.cardLast4);
  return card.label ? `${card.label} · ${masked}` : masked;
}

/** The summary a list renders, from a row's clear columns. */
export function toSavedCardSummary(row: {
  id: string;
  label: string | null;
  cardBrand: string;
  cardLast4: string;
  cardExpMonth: string;
  cardExpYear: string;
  updatedAt: Date;
}): SavedCardSummary {
  return {
    ...row,
    cardLabel: maskedLabel(row.cardBrand, row.cardLast4),
    cardExpired: isExpired(row.cardExpMonth, row.cardExpYear),
  };
}

/** "10621 N.W. 40th Ter." and "10621 NW 40th Ter" alike: dots and apostrophes go, other marks part words. */
const squash = (value: string | null | undefined) =>
  String(value ?? "")
    .toLowerCase()
    .replace(/[.'’#]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/**
 * Whether two addresses are the same entry, for "Save to address book" not to add one twice:
 * the name, the street and the ZIP, and the billing address when there is one, read past
 * case and punctuation. Not the phone -- a randomized phone on one profile doesn't make its
 * address a different one -- and not the label, which is only what the member calls it.
 */
export function addressFingerprint(address: SavedAddressFields): string {
  return [
    address.firstName,
    address.lastName,
    address.shipLine1,
    address.shipLine2,
    address.shipPostalCode.slice(0, 5),
    address.sameBillingAndShipping ? "same" : "billing",
    ...(address.sameBillingAndShipping
      ? []
      : [address.billLine1, address.billLine2, (address.billPostalCode ?? "").slice(0, 5)]),
  ]
    .map(squash)
    .join("|");
}

/**
 * Whether a card is already in the book. The same plain-column stand-in the profile list uses
 * to spot a shared card (cardSignature) -- the numbers themselves are envelopes that can't be
 * compared without decrypting them.
 */
export function hasCard(
  cards: readonly Parameters<typeof cardSignature>[0][],
  card: Parameters<typeof cardSignature>[0],
): boolean {
  const signature = cardSignature(card);
  return signature !== null && cards.some((saved) => cardSignature(saved) === signature);
}

/** How many of these profiles already pay with this card -- what the card picker warns with. */
export function profilesUsingCard(
  profiles: readonly Partial<Parameters<typeof cardSignature>[0]>[],
  card: Parameters<typeof cardSignature>[0],
): number {
  const signature = cardSignature(card);
  if (!signature) return 0;
  return profiles.filter(
    (profile) =>
      profile.cardLast4 &&
      cardSignature({
        cardBrand: profile.cardBrand ?? "",
        cardLast4: profile.cardLast4,
        cardExpMonth: profile.cardExpMonth ?? "",
        cardExpYear: profile.cardExpYear ?? "",
      }) === signature,
  ).length;
}

import "server-only";

import { prisma } from "@/db/client";
import { toSavedCardSummary, type AddressBook } from "@/lib/vault/address-book";

/**
 * A member's address book, for their profiles page.
 *
 * Same rules as db/queries/vault.ts: `discordUserId` is a required first argument, sourced
 * only from `requireMember()`, and nothing here decrypts -- the card envelopes are not
 * selected at all, so no page rendering this can leak a number even by accident.
 *
 * Oldest first, so the book reads in the order the member built it and a new entry lands at
 * the end rather than reshuffling the ones they already know the place of.
 */

export const SAVED_ADDRESS_SELECT = {
  id: true,
  label: true,
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
  updatedAt: true,
} as const;

export const SAVED_CARD_SELECT = {
  id: true,
  label: true,
  cardBrand: true,
  cardLast4: true,
  cardExpMonth: true,
  cardExpYear: true,
  updatedAt: true,
} as const;

export async function getAddressBook(discordUserId: string): Promise<AddressBook> {
  const [addresses, cards] = await Promise.all([
    prisma.savedAddress.findMany({
      where: { discordUserId },
      orderBy: { createdAt: "asc" },
      select: SAVED_ADDRESS_SELECT,
    }),
    prisma.savedCard.findMany({
      where: { discordUserId },
      orderBy: { createdAt: "asc" },
      select: SAVED_CARD_SELECT,
    }),
  ]);
  return { addresses, cards: cards.map(toSavedCardSummary) };
}

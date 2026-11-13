import "server-only";

import { decrypt, encrypt, type VaultField } from "@/lib/vault/crypto";

/**
 * Where a card's number and security code can be stored, and moving them between those places.
 *
 * Every envelope is bound to the column it was written for (crypto.ts, `aad`), so copying a
 * profile's card into the address book -- or a saved card onto a new profile -- cannot be a
 * copy of the ciphertext: it would fail to decrypt in its new column, which is the point of
 * the binding. It is a decrypt under the old binding and an encrypt under the new one, here,
 * on the server. The number is never returned, logged or sent to a browser on the way.
 *
 * These strings are part of the data format: change one and the rows written under it stop
 * decrypting. The profile's pair is the one saveProfile has always used.
 */

export type CardHome = "vault_profile" | "saved_card";

const BINDINGS: Record<CardHome, { number: VaultField; cvv: VaultField }> = {
  vault_profile: {
    number: { entity: "vault_profile", field: "card_number" },
    cvv: { entity: "vault_profile", field: "card_cvv" },
  },
  saved_card: {
    number: { entity: "saved_card", field: "card_number" },
    cvv: { entity: "saved_card", field: "card_cvv" },
  },
};

export type CardEnvelopes = { cardNumberEnc: string; cardCvvEnc: string };

/** A typed card's number and code, encrypted for where they are going. */
export function sealCard(pan: string, cvv: string, home: CardHome): CardEnvelopes {
  return {
    cardNumberEnc: encrypt(pan, BINDINGS[home].number),
    cardCvvEnc: encrypt(cvv, BINDINGS[home].cvv),
  };
}

/** A stored card's envelopes, re-encrypted for another home. Throws if they don't decrypt. */
export function moveCard(card: CardEnvelopes, from: CardHome, to: CardHome): CardEnvelopes {
  return {
    cardNumberEnc: encrypt(decrypt(card.cardNumberEnc, BINDINGS[from].number), BINDINGS[to].number),
    cardCvvEnc: encrypt(decrypt(card.cardCvvEnc, BINDINGS[from].cvv), BINDINGS[to].cvv),
  };
}

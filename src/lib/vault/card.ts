/**
 * Card number helpers.
 *
 * No secrets here and nothing server-only: this runs in the browser too, so the add/
 * edit form can show the brand and validate a number before it is ever submitted.
 *
 * Brand names match AYCD's vocabulary exactly ("AmericanExpress", not "Amex"), because
 * the export writes them verbatim into `paymentDetails.cardType`. Six profiles in the
 * real export have a blank cardType, which is why this derives it from the number
 * rather than trusting the field.
 */

export type CardBrand =
  "Visa" | "MasterCard" | "AmericanExpress" | "Discover" | "TargetRedCard" | "Unknown";

/**
 * AYCD's `paymentDetails.cardType` vocabulary.
 *
 * Store-branded cards map to an EMPTY STRING, which is exactly what AYCD itself writes
 * for all six REDcards in the real export -- inventing a value the bots have never
 * seen would be a worse guess than the blank they already handle.
 */
export function toAycdCardType(brand: CardBrand): string {
  if (brand === "TargetRedCard" || brand === "Unknown") return "";
  return brand;
}

/** Strips spaces and dashes. Never call anything else with a raw user-typed number. */
export function normalizePan(raw: string): string {
  return String(raw ?? "").replace(/\D/g, "");
}

/**
 * Issuer from the leading digits (the IIN ranges), which is how every checkout form
 * does it. Deliberately not a length check -- Amex is 15 and everything else 16, but
 * that tells you nothing about a 16-digit card.
 */
export function detectBrand(pan: string): CardBrand {
  const digits = normalizePan(pan);
  if (/^4/.test(digits)) return "Visa";
  if (/^3[47]/.test(digits)) return "AmericanExpress";
  // 51-55, plus the 2221-2720 range Mastercard added in 2017.
  if (/^5[1-5]/.test(digits)) return "MasterCard";
  if (/^2(2[2-9][1-9]|[3-6]\d\d|7[01]\d|720)/.test(digits)) return "MasterCard";
  // 639463 is Target's own REDcard range. Checked before Discover's 6xx rules, which
  // it would otherwise fall through past into Unknown -- six real profiles use these,
  // and "Unknown" on a member's own card reads like a bug.
  if (/^6394/.test(digits)) return "TargetRedCard";
  if (/^6(011|5|4[4-9]|22)/.test(digits)) return "Discover";
  return "Unknown";
}

export function last4(pan: string): string {
  return normalizePan(pan).slice(-4);
}

/** "Visa ···· 3384" -- what the UI shows in place of a number it will never display. */
export function maskedLabel(brand: string, last4Digits: string): string {
  return `${brand} ···· ${last4Digits}`;
}

/**
 * Luhn check digit.
 *
 * Catches transposed and mistyped digits at entry, which is the whole point -- a bad
 * number saved now surfaces as a failed checkout during a drop, when nobody can fix it.
 * Passing Luhn does NOT mean the card exists.
 */
export function isLuhnValid(pan: string): boolean {
  const digits = normalizePan(pan);
  if (digits.length < 12 || digits.length > 19) return false;

  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let value = digits.charCodeAt(i) - 48;
    if (double) {
      value *= 2;
      if (value > 9) value -= 9;
    }
    sum += value;
    double = !double;
  }
  return sum % 10 === 0;
}

/**
 * The code length to hint in the UI (maxlength, placeholder). Amex is 4, everyone
 * else 3.
 */
export function expectedCvvLength(brand: CardBrand): 3 | 4 {
  return brand === "AmericanExpress" ? 4 : 3;
}

/**
 * Whether a code is acceptable for a brand.
 *
 * Deliberately looser than `expectedCvvLength` for store cards. The real export
 * contains four distinct Target REDcards: three carry a 3-digit code and one carries 4.
 * With no way to tell whether that fourth is genuine or a mistyped leading zero,
 * rejecting either length would block a member from saving a card that works. Validate
 * what we can defend -- digits only, plausible length -- and let the checkout be the
 * judge of the rest.
 */
export function isValidCvv(cvv: string, brand: CardBrand): boolean {
  if (!/^\d+$/.test(cvv)) return false;
  if (brand === "AmericanExpress") return cvv.length === 4;
  if (brand === "TargetRedCard" || brand === "Unknown") return cvv.length === 3 || cvv.length === 4;
  return cvv.length === 3;
}

/**
 * Expiry as stored: two-digit month, four-digit year, both TEXT.
 *
 * Leading zeros are load-bearing -- "09" must not become "9" -- so this pads rather
 * than parsing to a number anywhere.
 */
export function normalizeExpiry(month: string, year: string): { month: string; year: string } {
  const m = String(month ?? "").replace(/\D/g, "");
  const y = String(year ?? "").replace(/\D/g, "");
  return {
    month: m.padStart(2, "0").slice(-2),
    // Two-digit years are assumed to be 20xx; these cards all expire this century.
    year: y.length === 2 ? `20${y}` : y,
  };
}

/** True once the card is past its expiry month, for the "needs updating" nudge. */
export function isExpired(month: string, year: string, now: Date = new Date()): boolean {
  const m = Number(month);
  const y = Number(year);
  if (!m || !y) return false;
  // Cards are valid through the LAST day of their expiry month.
  return y < now.getUTCFullYear() || (y === now.getUTCFullYear() && m < now.getUTCMonth() + 1);
}

/**
 * A stand-in for "is this the same card", used only to WARN -- never to block.
 *
 * Card numbers are AES-GCM envelopes with a random IV, so two profiles holding the
 * identical PAN have entirely different ciphertext: equality cannot be tested without
 * decrypting. The alternatives were decrypting every card on every page load, or adding a
 * keyed fingerprint column plus a migration and a backfill of 1,287 rows. Both are a lot
 * to carry for an advisory note.
 *
 * So this compares what is already stored in plain columns: brand, last four, and expiry.
 * Two DIFFERENT cards collide only by sharing all four, which needs the same issuer, the
 * same final four digits, and the same month AND year. The cost of that rare collision is
 * one member seeing a note they can ignore -- cheaper than holding plaintext card numbers
 * in memory to render a list.
 */
export function cardSignature(card: {
  cardBrand: string;
  cardLast4: string;
  cardExpMonth: string;
  cardExpYear: string;
}): string | null {
  if (!card.cardLast4) return null;
  return [card.cardBrand, card.cardLast4, card.cardExpMonth, card.cardExpYear]
    .join("|")
    .toLowerCase();
}

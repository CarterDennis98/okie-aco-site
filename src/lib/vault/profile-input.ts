import { normalizeProfile } from "@/lib/normalize";
import {
  detectBrand,
  isLuhnValid,
  isValidCvv,
  normalizeExpiry,
  normalizePan,
} from "@/lib/vault/card";

/**
 * Form parsing and validation for a checkout profile.
 *
 * Split out of `actions.ts` for two reasons: a `"use server"` module may only export
 * async functions, so nothing here could be unit tested while it lived there; and this
 * is where the bugs are. The action is thin plumbing around these.
 *
 * Never touches secrets beyond validating their shape -- no encryption, no logging.
 */

export type ProfileFormValues = ReturnType<typeof profileFieldsFromForm>;

export function text(form: FormData, key: string): string {
  return String(form.get(key) ?? "").trim();
}

export function bool(form: FormData, key: string): boolean {
  return form.get(key) === "on" || form.get(key) === "true";
}

/** A message describing the first problem, or null when the form is acceptable. */
export function validateProfileForm(form: FormData, isCreate: boolean): string | null {
  // No name check: profile names are generated, never submitted. See nextProfileName.
  if (!text(form, "firstName") || !text(form, "lastName")) {
    return "First and last name are required.";
  }
  if (!text(form, "shipLine1") || !text(form, "shipCity")) return "A shipping address is required.";
  if (text(form, "shipState").length !== 2) return "Use the two-letter state code.";
  if (!/^\d{5}(-\d{4})?$/.test(text(form, "shipPostalCode"))) return "Enter a valid ZIP code.";

  const pan = normalizePan(text(form, "cardNumber"));
  // On edit a blank card number means "keep the existing card", so it is only required
  // when creating. Anything typed is validated either way.
  if (isCreate && !pan) return "A card number is required.";
  if (pan) {
    if (!isLuhnValid(pan)) return "That card number doesn't look right — check for a typo.";
    const cvv = text(form, "cardCvv");
    if (!cvv) return "Enter the security code for the new card.";
    if (!isValidCvv(cvv, detectBrand(pan))) {
      return "That security code doesn't match the card type.";
    }
  }

  const { month, year } = normalizeExpiry(text(form, "cardExpMonth"), text(form, "cardExpYear"));
  if (!/^(0[1-9]|1[0-2])$/.test(month)) return "Expiry month must be 01–12.";
  if (!/^20\d{2}$/.test(year)) return "Enter a four-digit expiry year.";

  if (!bool(form, "sameBillingAndShipping")) {
    if (!text(form, "billLine1") || !text(form, "billCity")) {
      return "A billing address is required.";
    }
    if (text(form, "billState").length !== 2) return "Use the two-letter billing state code.";
  }
  return null;
}

/**
 * The non-secret columns.
 *
 * Billing fields are nulled when the member says billing matches shipping, so a stale
 * address can't linger in the row and reappear in an export.
 */
export function profileFieldsFromForm(form: FormData) {
  const same = bool(form, "sameBillingAndShipping");
  const { month, year } = normalizeExpiry(text(form, "cardExpMonth"), text(form, "cardExpYear"));

  return {
    firstName: text(form, "firstName"),
    lastName: text(form, "lastName"),
    phone: text(form, "phone") || null,
    shipLine1: text(form, "shipLine1"),
    shipLine2: text(form, "shipLine2") || null,
    shipCity: text(form, "shipCity"),
    shipState: text(form, "shipState").toUpperCase(),
    shipPostalCode: text(form, "shipPostalCode"),
    shipCountry: "US",
    sameBillingAndShipping: same,
    billFirstName: same ? null : text(form, "billFirstName") || null,
    billLastName: same ? null : text(form, "billLastName") || null,
    billLine1: same ? null : text(form, "billLine1") || null,
    billLine2: same ? null : text(form, "billLine2") || null,
    billCity: same ? null : text(form, "billCity") || null,
    billState: same ? null : text(form, "billState").toUpperCase() || null,
    billPostalCode: same ? null : text(form, "billPostalCode") || null,
    billCountry: same ? null : "US",
    cardExpMonth: month,
    cardExpYear: year,
    matchNameOnCardAndAddress: bool(form, "matchNameOnCardAndAddress"),
    onlyCheckoutOnce: bool(form, "onlyCheckoutOnce"),
  };
}

/**
 * The normalized key and index a profile name resolves to.
 *
 * Uses the SAME `normalizeProfile` the checkout pipeline uses -- not a lookalike regex.
 * If a profile saved here keyed differently from the one the bot records on a checkout,
 * the two would never join and the member's own checkouts would stop appearing against
 * their profile. That port is covered by the parity suite in normalize.test.ts.
 */
export function profileIdentity(name: string): { profileKey: string; profileIndex: number | null } {
  const parsed = normalizeProfile(name);
  return {
    profileKey: parsed?.profileKey ?? name.trim().toLowerCase(),
    profileIndex: parsed?.profileIndex ?? null,
  };
}

/** A trailing " 12" or "-12" on a profile KEY, which the suffix rule left in place. */
const FAMILY_SUFFIX_RE = /^(.*?)[\s-]+(\d+)$/;

/**
 * Collapse a profile key onto its family.
 *
 * `normalizeProfile` only strips a HYPHENATED suffix, so "Target 9" keys as `target 9`
 * while "carter - 9" keys as `carter`. Both are the ninth of a family, and the bot's
 * own `profileMap.json` matching treats them that way -- so grouping has to as well.
 * Without this, 58 house profiles named "Target 1".."Target 59" look like 58 unrelated
 * bases and the next name comes out as "target 1 - 2".
 */
export function familyBase(profileKey: string): string {
  const match = profileKey.match(FAMILY_SUFFIX_RE);
  return match ? match[1] : profileKey;
}

/**
 * Which number within `base` an existing profile occupies, or null if it isn't in that
 * family at all. A bare base name counts as 1.
 */
function familyIndex(
  identity: { profileKey: string; profileIndex: number | null },
  base: string,
): number | null {
  if (identity.profileKey === base) return identity.profileIndex ?? 1;

  const match = identity.profileKey.match(FAMILY_SUFFIX_RE);
  if (match && match[1] === base) return Number(match[2]);
  return null;
}

/**
 * The base a member's profile names are built from, for one retailer.
 *
 * Their EXISTING profiles win over their Discord handle. Those two often disagree --
 * `shockereyes` checks out under that name while their Discord username is something
 * else entirely -- and switching base mid-stream would leave a member with two
 * unrelated series of profiles on the same site.
 *
 * Falls back to the Discord username only when they have no profiles for that retailer
 * yet, which is the one moment there is nothing to be consistent with.
 */
export function profileBaseFor(existingNames: string[], discordUsername: string): string {
  const counts = new Map<string, number>();
  for (const name of existingNames) {
    const key = familyBase(profileIdentity(name).profileKey);
    if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  let best: string | null = null;
  let bestCount = 0;
  for (const [key, count] of counts) {
    if (count > bestCount) {
      best = key;
      bestCount = count;
    }
  }
  if (best) return best;

  return profileIdentity(discordUsername).profileKey || discordUsername.trim().toLowerCase();
}

/**
 * The next profile name for a member on one retailer.
 *
 * First is the bare base (`shockereyes`), then ` - 2`, ` - 3`, matching the convention
 * already in the data and the one the bot's normalizer understands.
 *
 * **Fills the lowest free number**, so deleting `- 3` and adding one reuses `- 3`
 * rather than drifting to `- 8`. Numbering stays tight, which matters more now that a
 * retailer's soft cap makes members think in terms of how many profiles they have.
 *
 * The trade, accepted deliberately: checkout history and past bills record the profile
 * name as text, so a reissued `- 3` makes an old order ambiguous about which card and
 * address it used. Nothing in the code breaks -- there is no foreign key from a
 * checkout to a profile row -- but a dispute six months out can't be answered from the
 * name alone.
 */
export function nextProfileName(base: string, existingNames: string[]): string {
  const taken = new Set(existingNames.map((n) => n.trim().toLowerCase()));

  const used = new Set<number>();
  for (const name of existingNames) {
    const index = familyIndex(profileIdentity(name), base);
    if (index !== null) used.add(index);
  }

  for (let index = 1; index <= used.size + 500; index++) {
    if (used.has(index)) continue;
    const candidate = index === 1 ? base : `${base} - ${index}`;
    // The unique constraint is on (site, name) across ALL members, so a name another
    // member already holds has to be skipped rather than collided with.
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  throw new Error(`Could not find a free profile name for "${base}".`);
}

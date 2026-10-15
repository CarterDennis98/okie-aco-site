import { normalizeProfile } from "@/lib/normalize";
import { siteRequiresPhone, siteStyle } from "@/lib/sites";
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

/**
 * "0" in the phone field means "bot, generate one yourself".
 *
 * A VALOR CONVENTION, not junk data, and it is load-bearing on 229 real Pokémon Center
 * profiles. Valor reads a bare 0 as an instruction to invent a random number at checkout
 * -- the same family of placeholder as the `%fname%` / `%lname%` that Pokémon Center
 * profiles carry in their name fields.
 *
 * Recorded here as a named constant purely so the next person to look at a column full of
 * zeroes does not do what this file's first draft did and "clean them up" -- which nulls
 * the column, exports an empty phone, and quietly takes away the bot's instruction.
 *
 * NOT accepted where the retailer requires a real number: `siteRequiresPhone` rejects it,
 * because a generated number cannot receive the call or text Walmart makes.
 *
 * And ONLY VALOR READS IT. Any other bot would take "0" as the number itself, so the AYCD
 * export swaps it for a generated one on those retailers. See `botGeneratesPhone`.
 */
export const BOT_SENTINEL_PHONE = "0";

/**
 * A US phone number as ten digits, or null when it isn't one.
 *
 * Accepts whatever a member types -- "(405) 555-1234", "405.555.1234", "+1 405 555 1234"
 * -- and returns one canonical form, because the retailer sees the digits and the
 * punctuation is decoration. A leading country code 1 is dropped rather than rejected;
 * that is the single most common way the field gets eleven digits.
 *
 * Returning null does NOT mean "discard this". A caller that stores the result must decide
 * separately whether an unrecognized value is junk or a sentinel; see BOT_SENTINEL_PHONE.
 */
export function normalizePhone(raw: string | null | undefined): string | null {
  let digits = String(raw ?? "").replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) digits = digits.slice(1);
  if (digits.length !== 10) return null;
  // A US area code and exchange never start with 0 or 1, so these are typos, not numbers.
  if (/^[01]/.test(digits) || /^\d{3}[01]/.test(digits)) return null;
  return digits;
}

/**
 * A US ZIP: five digits, optionally +4.
 *
 * THE ONE DEFINITION. Every write path shares it -- the member's form, the AYCD upload,
 * the operator's import script -- because the form used to be the only thing checking, and
 * the import path put "100128" and "1374" into live Pokémon Center profiles, where they sat
 * unnoticed until an export was traced by hand.
 *
 * ZIP+4 IS VALID and must stay that way. It is real address precision, Valor's own store
 * holds profiles that use it, and a file carrying one imports fine -- the temptation to
 * "clean" it to five digits is throwing information away to fix a problem it never caused.
 *
 * Nothing here repairs a bad value, and nothing should: the digits missing from a
 * four-digit ZIP cannot be guessed, and a wrong guess ships somebody's order to the wrong
 * address. An unusable ZIP is refused at the door and sent back to whoever typed it.
 */
export const POSTAL_CODE_RE = /^\d{5}(-\d{4})?$/;

export function isValidPostalCode(raw: string | null | undefined): boolean {
  return POSTAL_CODE_RE.test(String(raw ?? "").trim());
}

/**
 * A message describing the first problem, or null when the form is acceptable.
 *
 * `siteKey` is a parameter rather than something read from the form here because the
 * caller has already checked it against the known retailers -- see saveProfile. It only
 * affects the phone rule.
 */
export function validateProfileForm(
  form: FormData,
  isCreate: boolean,
  siteKey?: string,
): string | null {
  // No name check: profile names are generated, never submitted. See nextProfileName.
  if (!text(form, "firstName") || !text(form, "lastName")) {
    return "First and last name are required.";
  }

  // Checked on EDIT as well as create. A Walmart profile that predates this rule is
  // exactly the one that has been failing orders, and letting an edit save without a
  // phone would leave it broken -- the field is one line and the retailer requires it.
  //
  // ONLY on a retailer that requires one. Elsewhere an unrecognized phone is not an error
  // at all, and must not be: 229 real Pokémon Center profiles carry the bare "0" that tells
  // Valor to generate its own number, and rejecting the form would block every unrelated
  // edit on them over a value that is doing its job. See BOT_SENTINEL_PHONE.
  //
  // Walmart is the exception on purpose. A generated number cannot take the call or text
  // Walmart sends, so "0" is refused there like any other non-number.
  const phone = text(form, "phone");
  if (siteRequiresPhone(siteKey)) {
    if (!phone) {
      return `${siteStyle(siteKey).label} checkout needs a phone number — add one to save.`;
    }
    if (!normalizePhone(phone)) return "Enter a 10-digit US phone number.";
  }
  if (!text(form, "shipLine1") || !text(form, "shipCity")) return "A shipping address is required.";
  if (text(form, "shipState").length !== 2) return "Use the two-letter state code.";
  if (!isValidPostalCode(text(form, "shipPostalCode"))) {
    return "Enter a valid ZIP code — five digits, or ZIP+4 like 73069-1234.";
  }

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
    // Checked at last. The billing ZIP went unvalidated while the shipping one beside it
    // was checked from the start, so a typo here saved cleanly and only surfaced as a
    // declined card -- the ZIP is what an issuer matches on.
    if (!isValidPostalCode(text(form, "billPostalCode"))) {
      return "Enter a valid billing ZIP code — five digits, or ZIP+4 like 73069-1234.";
    }
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
    // A recognizable US number is stored as ten bare digits. ANYTHING ELSE IS PRESERVED
    // VERBATIM -- see BOT_SENTINEL_PHONE. Only a genuinely blank field becomes null.
    phone: normalizePhone(text(form, "phone")) ?? (text(form, "phone") || null),
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

/**
 * AYCD's collision noise on an imported name: "Walmart 82-!50", "PKC 32-!5176". AYCD added
 * it to tell two same-named profiles apart, so it is no part of the name anyone chose.
 */
const AYCD_NOISE_RE = /-[!@#$%^&]\w*$/;

/**
 * A name's number and what comes before it: "carter - 4", "PKC 7", "Walmart sahab #4".
 *
 * The separator is required, so a handle that ends in digits is a bare name rather than a
 * stem and an index. "thisisgold0220" is a real member, and reading it as the 220th
 * "thisisgold" would rename them "thisisgold - 2".
 */
const NUMBERED_RE = /^(.*?\S)(\s*-\s*|\s*#\s*|\s+)(\d+)$/;

/** The separator new profiles have always had, and the one a tie goes to. */
const CANONICAL_SEPARATOR = " - ";

/**
 * One name, read as the Nth of a family. A bare name is the first.
 *
 * `family` is the stem as the checkout pipeline keys it -- lowercase, markdown stripped --
 * so "carter", "Carter 3" and "carter - 9" are one family, the way the bot's own
 * profileMap.json matching treats them. So are "Walmart sahab #4" and "#9", and the house
 * "Walmart 82-!50" with "Walmart 83", which normalizeProfile alone keys as unrelated names.
 * Without this, 58 house profiles named "Target 1".."Target 59" looked like 58 unrelated
 * bases and the next name came out as "target 1 - 2".
 */
type NumberedName = { stem: string; separator: string | null; index: number; family: string };

function parseNumbered(name: string): NumberedName {
  const cleaned = name.trim().replace(AYCD_NOISE_RE, "").trim();
  const match = cleaned.match(NUMBERED_RE);
  const stem = match ? match[1] : cleaned;
  return {
    stem,
    separator: match ? match[2] : null,
    index: match ? Number(match[3]) : 1,
    family: profileIdentity(stem).profileKey,
  };
}

/** The value seen most often. A tie goes to `preferred` if it is one of them, else the first seen. */
function mostCommon(values: string[], preferred?: string): string {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  let best = values[0];
  for (const [value, count] of counts) {
    const bestCount = counts.get(best) ?? 0;
    if (count > bestCount || (count === bestCount && value === preferred)) best = value;
  }
  return best;
}

/** The order every list and every bot split reads profile names in. See bot-split.ts. */
const nameOrder = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

/**
 * The family most of these names belong to, or null for no names. A tie goes to
 * `preferred` if it is one of them, else to the family listed first.
 */
function dominantFamily(names: string[], preferred: string): string | null {
  if (names.length === 0) return null;
  const families = [...names].sort(nameOrder.compare).map((name) => parseNumbered(name).family);
  return mostCommon(families, preferred);
}

/** How a family numbers its names. See numberingOf. */
type Numbering = { stem: string; separator: string; bareFirst: boolean };

/**
 * The numbering a family's names already use: their spelling of the stem, the separator
 * before the number, and whether the first goes without one. "PKC 1".."PKC 81" continue as
 * "PKC 82", and "Walmart sahab #1".."#136" as "Walmart sahab #137".
 *
 * With no names yet, it's the convention new profiles have always had: the bare family
 * name, then " - 2", " - 3". Ties go to that convention too. A family split evenly between
 * "Carter 3" and "carter - 5" carries on as "carter - N".
 */
function numberingOf(family: string, members: NumberedName[]): Numbering {
  if (members.length === 0) {
    return { stem: family, separator: CANONICAL_SEPARATOR, bareFirst: true };
  }
  const separators = members.flatMap((member) => (member.separator ? [member.separator] : []));
  const separator = separators.length
    ? mostCommon(separators, CANONICAL_SEPARATOR)
    : CANONICAL_SEPARATOR;
  return {
    stem: mostCommon(
      members.map((member) => member.stem),
      family,
    ),
    separator,
    // A bare first where the family already has one. "PKC 1" and "carter - 1" stay
    // numbered, and a " - " family whose first profile was deleted gets the bare name back.
    bareFirst:
      members.some((member) => member.separator === null) ||
      (separator === CANONICAL_SEPARATOR && !members.some((member) => member.index === 1)),
  };
}

function numberedName({ stem, separator, bareFirst }: Numbering, index: number): string {
  return index === 1 && bareFirst ? stem : `${stem}${separator}${index}`;
}

/**
 * The base a member's profile names are built from, for one retailer: the family most of
 * their names belong to (see NumberedName), keyed as the checkout pipeline keys it.
 *
 * Their EXISTING profiles win over their Discord handle. Those two often disagree --
 * `shockereyes` checks out under that name while their Discord username is something
 * else entirely -- and switching base mid-stream would leave a member with two
 * unrelated series of profiles on the same site.
 *
 * Falls back to the Discord username only when they have no profiles for that retailer
 * yet, which is the one moment there is nothing to be consistent with. The username also
 * settles a tie: "pokelover23" and "pokelover - 2" carry on as the family their handle is.
 *
 * THE ONE PLACE a member's family is chosen. Add profile, the import and a reorder all
 * come through here, so a reorder and the next profile added agree on the sequence.
 */
export function profileBaseFor(existingNames: string[], discordUsername: string): string {
  const handle =
    profileIdentity(discordUsername).profileKey || discordUsername.trim().toLowerCase();
  return dominantFamily(existingNames, handle) || handle;
}

/**
 * The next profile name for a member on one retailer, in `base`'s own numbering.
 *
 * For a member starting out that is the bare base (`shockereyes`), then ` - 2`, ` - 3` --
 * the convention most of the data is in, and the one the bot's normalizer understands. A
 * family already numbered some other way carries on in that way: "PKC 81" is followed by
 * "PKC 82", not by "pkc - 82". That one sorted ahead of "PKC 1" and took a main-bot slot,
 * because names are the order (bot-split.ts). See numberingOf.
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
  const family = existingNames.map(parseNumbered).filter((name) => name.family === base);
  const numbering = numberingOf(base, family);
  const used = new Set(family.map((name) => name.index));

  for (let index = 1; index <= used.size + 500; index++) {
    if (used.has(index)) continue;
    const candidate = numberedName(numbering, index);
    // The unique constraint is on (site, name) across ALL members, so a name another
    // member already holds has to be skipped rather than collided with.
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  throw new Error(`Could not find a free profile name for "${base}".`);
}

/**
 * The names a member's profiles on one retailer take when they're renumbered, for the first
 * position on down. The member drags their profiles into order, and position N gets the Nth
 * name here.
 *
 * Names are how order is stored. Every list sorts by name and the bot split takes the first
 * few as the main bot's (bot-split.ts), so renumbering is how a member picks which profiles
 * the main bot runs. That only works if every name sorts where its position says, so all of
 * them are put on ONE numbering. A name outside it would sort by its own stem, wherever
 * that falls.
 *
 * The numbering is the member's own. It comes from the family most of their names already
 * share -- profileBaseFor's pick, `discordUsername` settling a tie -- with that family's
 * spelling, separator and starting point (numberingOf):
 *
 *   carter, carter - 2, carter - 4   ->  carter, carter - 2, carter - 3
 *   PKC 1, PKC 2, PKC 7              ->  PKC 1, PKC 2, PKC 3
 *   Walmart sahab #4, #9             ->  Walmart sahab #1, Walmart sahab #2
 *
 * Mostly that means swapping the numbers. In the usual "carter - N" form the profile key the
 * checkout pipeline joins on is the part before the number, so a member's checkouts still
 * reach them under the new names. A name outside the family is pulled into it, and AYCD's
 * collision noise ("-!50") is dropped. It is the numbering nextProfileName continues, so a
 * profile added after a reorder lands at the end of the same sequence.
 *
 * `othersOnSite` is every other member's names on the same retailer. A number another
 * member holds in the family is stepped over, under any spelling, the same way
 * nextProfileName does it. So is any exact name they hold, since (site, name) is unique
 * across members. The gap that leaves still sorts in order.
 *
 * Pure: the profiles page calls it to preview the names, and reorderProfiles calls it again at
 * write time. That way a preview drawn before another member took a name can't save a
 * clash.
 */
export function renumberedNames(
  mine: string[],
  othersOnSite: string[],
  discordUsername: string,
): string[] {
  if (mine.length === 0) return [];
  const family = profileBaseFor(mine, discordUsername);

  const numbering = numberingOf(
    family,
    mine.map(parseNumbered).filter((name) => name.family === family),
  );
  const used = new Set(
    othersOnSite
      .map(parseNumbered)
      .filter((name) => name.family === family)
      .map((name) => name.index),
  );
  const taken = new Set(othersOnSite.map((name) => name.trim().toLowerCase()));

  const names: string[] = [];
  // Every skip is a name somebody else holds, so this never runs past mine plus theirs.
  for (let index = 1; names.length < mine.length; index++) {
    if (index > mine.length + othersOnSite.length) {
      throw new Error(`Could not renumber the profiles named after "${numbering.stem}".`);
    }
    if (used.has(index)) continue;
    const candidate = numberedName(numbering, index);
    if (!taken.has(candidate.toLowerCase())) names.push(candidate);
  }
  return names;
}

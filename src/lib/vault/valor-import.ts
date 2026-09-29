import {
  checkProfiles,
  type ParseOptions,
  type ParseResult,
  type RawAddress,
  type RawProfile,
} from "@/lib/vault/aycd-import";
import { normalizePhone } from "@/lib/vault/profile-input";

/**
 * Reading Valor's own profile export.
 *
 * Members who run their own Valor on Pokémon Center keep their profiles there, not in AYCD
 * Toolbox -- so this reads Valor's file as it comes, and hands every profile to
 * `checkProfiles`: the same rules, and the same messages, as an AYCD upload. Which retailers
 * take one is declared in sites.ts (`importsValor`) and enforced by the import action;
 * nothing here knows about retailers.
 *
 * THE SHAPE, as Valor writes it -- one object, keyed by each profile's id:
 *
 *   { "<uuid>": { name, email, emailPassword, phoneNumber, billingSameAsShipping,
 *                 oneCheckout, quickTask, card: { holder, number, expiration, cvv, type },
 *                 shipping: { firstName, lastName, addressLine1, addressLine2, city,
 *                             countryName, countryCode, state, zipCode },
 *                 billing: { ...the same as shipping }, id, totalSpent } }
 *
 * A bare list of those objects, or one on its own, is taken too: a member who trims a file
 * by hand shouldn't be refused over the wrapper.
 *
 * Where it differs from AYCD, and what that means here:
 *
 *   - First and last name are separate fields, so nothing is split. "Mary Ann" stays a first
 *     name, which AYCD's single name field has no way to say.
 *   - The expiry is one "MM/YY" field.
 *   - One email per profile, at the top, rather than one per address.
 *   - `oneCheckout` is AYCD's onlyCheckoutOnce. Valor has no matchNameOnCardAndAddress, and
 *     every Pokémon Center profile already in the vault has it false, so false it is.
 *   - The phone is stored the way the profile form stores one: ten bare digits when it is a
 *     US number, anything else as written -- which keeps Valor's own "0", its instruction to
 *     make a number up at checkout. See BOT_SENTINEL_PHONE.
 *
 * NOT READ, on purpose:
 *
 *   - `emailPassword` -- the MAILBOX's password, not a retailer login. Pokémon Center checks
 *     out as a guest and nothing of ours reads its inbox (usesEmailCodes), so storing it
 *     would be holding a credential for nothing. It is never even looked at.
 *   - `card.holder` and `card.type` -- the export derives the name on the card from the
 *     shipping name, and the brand from the number, exactly as it does for an AYCD import.
 *   - `quickTask`, `totalSpent` and `id` -- Valor's own bookkeeping.
 *
 * Pure: no database, no `server-only`, nothing encrypted here. The action does that.
 */

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown): Json {
  return isObject(value) ? value : {};
}

// Strings only, like the AYCD reader. A card number written as a bare JSON number has
// already lost digits by the time it is parsed -- sixteen digits is past what a double
// holds -- so taking one would import a different card than the member has.
function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** A Valor profile keeps its card and addresses under these names; AYCD never does. */
function isValorProfile(value: unknown): boolean {
  return isObject(value) && (isObject(value.card) || isObject(value.shipping));
}

/** AYCD's names for the same things -- see aycd.ts. */
function isAycdProfile(value: unknown): boolean {
  return isObject(value) && ("paymentDetails" in value || "shippingAddress" in value);
}

/** The profiles in a parsed file, or null when it isn't Valor's. */
function valorEntries(root: unknown): unknown[] | null {
  if (isValorProfile(root)) return [root];
  const entries = Array.isArray(root) ? root : isObject(root) ? Object.values(root) : null;
  if (!entries || !entries.some(isValorProfile) || entries.some(isAycdProfile)) return null;
  return entries;
}

/**
 * Whether a file is a Valor profile export rather than AYCD's.
 *
 * Read from the file's SHAPE -- never from its name, or from which retailer was picked -- so
 * a member never has to say which bot wrote it. Anything that isn't Valor's belongs to the
 * AYCD reader, which says what's wrong with it just as it always has.
 */
export function isValorExport(text: string): boolean {
  try {
    return valorEntries(JSON.parse(text)) !== null;
  } catch {
    return false;
  }
}

export function parseValorExport(text: string, options: ParseOptions = {}): ParseResult {
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch {
    return {
      profiles: [],
      issues: [
        { position: 0, name: "", problem: "That file isn't valid JSON.", severity: "error" },
      ],
    };
  }

  const entries = valorEntries(root);
  if (!entries) {
    return {
      profiles: [],
      issues: [
        {
          position: 0,
          name: "",
          problem:
            "That doesn't look like a Valor profile export — expected profiles with a card and a shipping address.",
          severity: "error",
        },
      ],
    };
  }

  return checkProfiles(entries, valorRow, options);
}

/**
 * Valor's "MM/YY", as the month and year `checkProfiles` takes. "2/31", "02/2031" and
 * "02-31" read the same way -- normalizeExpiry pads the month and widens the year. Anything
 * else comes back empty, and is refused there as not a real month and year rather than
 * guessed at.
 */
function splitExpiry(raw: string): { month: string; year: string } {
  const parts = raw.split(/\D+/).filter(Boolean);
  if (parts.length !== 2) return { month: "", year: "" };
  return { month: parts[0], year: parts[1] };
}

function valorAddress(address: Json): RawAddress {
  return {
    line1: str(address.addressLine1),
    line2: str(address.addressLine2),
    city: str(address.city),
    state: str(address.state),
    postalCode: str(address.zipCode),
    // Valor writes the code beside the name; the code is what the vault stores.
    country: str(address.countryCode) || str(address.countryName),
  };
}

function valorRow(raw: unknown): RawProfile {
  const entry = record(raw);
  const card = record(entry.card);
  const ship = record(entry.shipping);
  const bill = record(entry.billing);
  const phone = str(entry.phoneNumber);
  const expiry = splitExpiry(str(card.expiration));

  return {
    sourceName: str(entry.name),
    email: str(entry.email),
    firstName: str(ship.firstName),
    lastName: str(ship.lastName),
    phone: normalizePhone(phone) ?? phone,
    ship: valorAddress(ship),
    sameBillingAndShipping: entry.billingSameAsShipping === true,
    bill: { ...valorAddress(bill), firstName: str(bill.firstName), lastName: str(bill.lastName) },
    onlyCheckoutOnce: entry.oneCheckout === true,
    matchNameOnCardAndAddress: false,
    cardNumber: str(card.number),
    cardCvv: str(card.cvv),
    cardExpMonth: expiry.month,
    cardExpYear: expiry.year,
  };
}

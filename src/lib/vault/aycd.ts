/**
 * AYCD profile export.
 *
 * The shape is dictated by the files the bots already consume, not by us -- every
 * decision below was checked against the 269 real profiles in the existing exports:
 *
 *   - `state` is the FULL name ("Oklahoma"), while we store the two-letter code.
 *   - `country` is "United States", while we store "US".
 *   - `nameOnCard` always equalled the SHIPPING name, so it is derived, not stored.
 *   - `line3` was empty on all 269, so it is always "".
 *   - When `sameBillingAndShippingAddress` is true, AYCD still writes both address
 *     objects out in full, identically.
 *   - `cardType` is "" for store cards; see toAycdCardType.
 *
 * This module is pure: it takes already-decrypted values and returns objects. Nothing
 * here reads the database or touches the keyring, so it can be tested directly.
 */

import { toAycdCardType, type CardBrand } from "@/lib/vault/card";
import { BOT_SENTINEL_PHONE } from "@/lib/vault/profile-input";

/** Two-letter code to the full name AYCD writes. */
const STATE_NAMES: Record<string, string> = {
  AL: "Alabama",
  AK: "Alaska",
  AZ: "Arizona",
  AR: "Arkansas",
  CA: "California",
  CO: "Colorado",
  CT: "Connecticut",
  DE: "Delaware",
  DC: "District of Columbia",
  FL: "Florida",
  GA: "Georgia",
  HI: "Hawaii",
  ID: "Idaho",
  IL: "Illinois",
  IN: "Indiana",
  IA: "Iowa",
  KS: "Kansas",
  KY: "Kentucky",
  LA: "Louisiana",
  ME: "Maine",
  MD: "Maryland",
  MA: "Massachusetts",
  MI: "Michigan",
  MN: "Minnesota",
  MS: "Mississippi",
  MO: "Missouri",
  MT: "Montana",
  NE: "Nebraska",
  NV: "Nevada",
  NH: "New Hampshire",
  NJ: "New Jersey",
  NM: "New Mexico",
  NY: "New York",
  NC: "North Carolina",
  ND: "North Dakota",
  OH: "Ohio",
  OK: "Oklahoma",
  OR: "Oregon",
  PA: "Pennsylvania",
  PR: "Puerto Rico",
  RI: "Rhode Island",
  SC: "South Carolina",
  SD: "South Dakota",
  TN: "Tennessee",
  TX: "Texas",
  UT: "Utah",
  VT: "Vermont",
  VA: "Virginia",
  WA: "Washington",
  WV: "West Virginia",
  WI: "Wisconsin",
  WY: "Wyoming",
};

/** Unknown codes pass through unchanged rather than becoming empty. */
export function stateName(code: string): string {
  return STATE_NAMES[String(code ?? "").toUpperCase()] ?? code;
}

export function countryName(code: string): string {
  return String(code ?? "").toUpperCase() === "US" ? "United States" : code;
}

// The inverses, for reading an export back in. Built from the same table so the two
// directions cannot drift: a round trip has to land on the code the rest of the system
// stores, or the database ends up holding "Oklahoma" on some rows and "OK" on others.
const STATE_CODES: Record<string, string> = Object.fromEntries(
  Object.entries(STATE_NAMES).map(([code, name]) => [name.toUpperCase(), code]),
);

/** "Oklahoma" -> "OK". Already-coded input and anything unrecognised passes through. */
export function stateCode(value: string): string {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) return trimmed;
  const upper = trimmed.toUpperCase();
  if (STATE_NAMES[upper]) return upper;
  return STATE_CODES[upper] ?? trimmed;
}

/** "United States" -> "US". Anything else passes through. */
export function countryCode(value: string): string {
  const trimmed = String(value ?? "").trim();
  return trimmed.toUpperCase() === "UNITED STATES" ? "US" : trimmed;
}

export type AycdAddress = {
  name: string;
  email: string;
  phone: string;
  line1: string;
  line2: string;
  line3: string;
  postCode: string;
  city: string;
  country: string;
  state: string;
};

export type AycdProfile = {
  name: string;
  notes: string;
  billingAddress: AycdAddress;
  shippingAddress: AycdAddress;
  paymentDetails: {
    nameOnCard: string;
    cardType: string;
    cardNumber: string;
    cardExpMonth: string;
    cardExpYear: string;
    cardCvv: string;
  };
  sameBillingAndShippingAddress: boolean;
  onlyCheckoutOnce: boolean;
  matchNameOnCardAndAddress: boolean;
};

/** Everything one profile needs, with secrets already decrypted by the caller. */
export type ExportableProfile = {
  name: string;
  email: string;
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
  cardBrand: string;
  cardExpMonth: string;
  cardExpYear: string;
  onlyCheckoutOnce: boolean;
  matchNameOnCardAndAddress: boolean;
  /** Decrypted. */
  cardNumber: string;
  /** Decrypted. */
  cardCvv: string;
};

function address(parts: {
  name: string;
  email: string;
  phone: string;
  line1: string;
  line2: string;
  city: string;
  state: string;
  postCode: string;
  country: string;
}): AycdAddress {
  return {
    name: parts.name,
    email: parts.email,
    phone: parts.phone,
    line1: parts.line1,
    line2: parts.line2,
    line3: "",
    postCode: parts.postCode,
    city: parts.city,
    country: countryName(parts.country),
    state: stateName(parts.state),
  };
}

export function toAycdProfile(profile: ExportableProfile): AycdProfile {
  const shippingName = `${profile.firstName} ${profile.lastName}`.trim();

  /**
   * A MISSING PHONE EXPORTS AS THE SENTINEL, NEVER AS "".
   *
   * Valor's profile importer rejects the WHOLE FILE -- "invalid profile list", naming no
   * row -- if any profile carries an empty phone. One member with a blank phone therefore
   * takes down the export for everybody in it, which is exactly what happened to the
   * Pokémon Center batch: two profiles, one blank phone, nothing imported.
   *
   * Established by bisecting the failing file against Valor's own store. Everything else
   * suspected first turned out to be fine and is deliberately NOT normalized here --
   * punctuated phones ("330-607-9000") and ZIP+4 ("15001-2908") both import, and 173 and
   * 2 live profiles respectively carry them.
   *
   * "0" rather than a made-up number: Valor reads a bare zero as "generate one at
   * checkout", which is the honest way to say we don't have one. See BOT_SENTINEL_PHONE,
   * and note `siteRequiresPhone` already stops a blank phone being saved at all on the
   * one retailer where a generated number cannot work.
   */
  const phone = profile.phone?.trim() || BOT_SENTINEL_PHONE;

  const shippingAddress = address({
    name: shippingName,
    email: profile.email,
    phone,
    line1: profile.shipLine1,
    line2: profile.shipLine2 ?? "",
    city: profile.shipCity,
    state: profile.shipState,
    postCode: profile.shipPostalCode,
    country: profile.shipCountry,
  });

  // When billing matches shipping, AYCD writes the same object twice rather than
  // omitting one, so the export mirrors that rather than emitting nulls a bot would
  // have to interpret.
  const billingAddress = profile.sameBillingAndShipping
    ? shippingAddress
    : address({
        name: `${profile.billFirstName ?? profile.firstName} ${
          profile.billLastName ?? profile.lastName
        }`.trim(),
        email: profile.email,
        phone,
        line1: profile.billLine1 ?? "",
        line2: profile.billLine2 ?? "",
        city: profile.billCity ?? "",
        state: profile.billState ?? "",
        postCode: profile.billPostalCode ?? "",
        country: profile.billCountry ?? "US",
      });

  return {
    name: profile.name,
    notes: "",
    billingAddress,
    shippingAddress,
    paymentDetails: {
      // Verified equal to the shipping name on all 269 real profiles.
      nameOnCard: shippingName,
      cardType: toAycdCardType(profile.cardBrand as CardBrand),
      cardNumber: profile.cardNumber,
      cardExpMonth: profile.cardExpMonth,
      cardExpYear: profile.cardExpYear,
      cardCvv: profile.cardCvv,
    },
    sameBillingAndShippingAddress: profile.sameBillingAndShipping,
    onlyCheckoutOnce: profile.onlyCheckoutOnce,
    matchNameOnCardAndAddress: profile.matchNameOnCardAndAddress,
  };
}

/** `<username>:<password>` per line, the format the bots take for accounts. */
export function toAccountList(accounts: { email: string; password: string }[]): string {
  return accounts.map((a) => `${a.email}:${a.password}`).join("\n");
}

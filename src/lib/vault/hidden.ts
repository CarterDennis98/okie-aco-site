import { countryCode, exportPhone, stateCode, type ExportableProfile } from "@/lib/vault/aycd";
import { detectBrand, normalizeExpiry, normalizePan } from "@/lib/vault/card";

/**
 * Hidden AIO's profile CSV -- the file Costco's bot loads.
 *
 * Read off a file Hidden itself exported (one test profile, 2026-11-19), so every column name,
 * "(do not edit)" and all, is Hidden's own:
 *
 *   - 36 columns, comma-separated; "\n" between lines and none after the last; no BOM.
 *   - Country "US" and the two-letter state -- not AYCD's "United States" and "Oklahoma".
 *   - First and last names in columns of their own, for shipping, billing and the card.
 *   - Both flags as lowercase "true" / "false".
 *   - Billing written out in full even when it is the shipping address, as AYCD does.
 *   - cardType "visa", lowercase.
 *
 * WHAT THAT FILE COULDN'T SAY. Its one card was a Visa, so "mastercard", "amex" and
 * "discover" follow its lowercase and Valor's names (valorCardType) without having been seen in
 * a Hidden file. `profileId` is Hidden's id for a profile it already holds, and every row here
 * is new to it, so it stays blank. `accountEmail` stays blank because Hidden's own file left it
 * blank.
 *
 * Pure, like aycd.ts: it takes already-decrypted values and returns text.
 */

export const HIDDEN_HEADER = [
  "profileName",
  "shippingFirstName",
  "shippingLastName",
  "shippingEmail",
  "shippingPhone",
  "shippingLine1",
  "shippingLine2",
  "shippingLine3",
  "shippingPostCode",
  "shippingCity",
  "shippingCountry",
  "shippingState",
  "sameBillingAndShippingAddress",
  "billingFirstName",
  "billingLastName",
  "billingEmail",
  "billingPhone",
  "billingLine1",
  "billingLine2",
  "billingLine3",
  "billingPostCode",
  "billingCity",
  "billingCountry",
  "billingState",
  "cardFirstName",
  "cardLastName",
  "cardType",
  "cardNumber",
  "cardExpMonth",
  "cardExpYear",
  "cardCvv",
  "onlyCheckoutOnce",
  "accountEmail",
  "profileId (do not edit)",
  "groupName",
  "groupId (do not edit)",
] as const;

export type HiddenColumn = (typeof HIDDEN_HEADER)[number];

/** A Hidden profile group: its name and the id Hidden gave it. See `hiddenGroup` in sites.ts. */
export type HiddenGroup = { name: string; id: string };

/**
 * Hidden's card type, from the number's leading digits -- as valorCardType does it, rather
 * than trusting the stored brand: the number is what the card is. "" for anything that isn't
 * one of the four, as AYCD leaves a store card blank.
 */
export function hiddenCardType(cardNumber: string): string {
  switch (detectBrand(cardNumber)) {
    case "Visa":
      return "visa";
    case "MasterCard":
      return "mastercard";
    case "AmericanExpress":
      return "amex";
    case "Discover":
      return "discover";
    default:
      return "";
  }
}

/** Digits only, as Hidden writes them: "(405) 555-0101" and "+1 405 555 0101" are "4055550101". */
export function hiddenPhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  return digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
}

type Address = {
  firstName: string;
  lastName: string;
  line1: string;
  line2: string;
  postCode: string;
  city: string;
  country: string;
  state: string;
};

/** One profile as Hidden's columns. The name on the card is the billing name. */
export function toHiddenRow(
  profile: ExportableProfile,
  group: HiddenGroup,
): Record<HiddenColumn, string> {
  // The same number the AYCD file gives this profile -- generated, where it has none.
  const phone = hiddenPhone(exportPhone(profile));
  const shipping: Address = {
    firstName: profile.firstName,
    lastName: profile.lastName,
    line1: profile.shipLine1,
    line2: profile.shipLine2 ?? "",
    postCode: profile.shipPostalCode,
    city: profile.shipCity,
    country: countryCode(profile.shipCountry) || "US",
    state: stateCode(profile.shipState),
  };
  const billing: Address = profile.sameBillingAndShipping
    ? shipping
    : {
        firstName: profile.billFirstName ?? profile.firstName,
        lastName: profile.billLastName ?? profile.lastName,
        line1: profile.billLine1 ?? "",
        line2: profile.billLine2 ?? "",
        postCode: profile.billPostalCode ?? "",
        city: profile.billCity ?? "",
        country: countryCode(profile.billCountry ?? "") || "US",
        state: stateCode(profile.billState ?? ""),
      };
  const cardNumber = normalizePan(profile.cardNumber);
  const expiry = normalizeExpiry(profile.cardExpMonth, profile.cardExpYear);

  return {
    profileName: profile.name,
    shippingFirstName: shipping.firstName,
    shippingLastName: shipping.lastName,
    shippingEmail: profile.email,
    shippingPhone: phone,
    shippingLine1: shipping.line1,
    shippingLine2: shipping.line2,
    shippingLine3: "",
    shippingPostCode: shipping.postCode,
    shippingCity: shipping.city,
    shippingCountry: shipping.country,
    shippingState: shipping.state,
    sameBillingAndShippingAddress: String(profile.sameBillingAndShipping),
    billingFirstName: billing.firstName,
    billingLastName: billing.lastName,
    billingEmail: profile.email,
    billingPhone: phone,
    billingLine1: billing.line1,
    billingLine2: billing.line2,
    billingLine3: "",
    billingPostCode: billing.postCode,
    billingCity: billing.city,
    billingCountry: billing.country,
    billingState: billing.state,
    cardFirstName: billing.firstName,
    cardLastName: billing.lastName,
    cardType: hiddenCardType(cardNumber),
    cardNumber,
    cardExpMonth: expiry.month,
    cardExpYear: expiry.year,
    cardCvv: profile.cardCvv,
    onlyCheckoutOnce: String(profile.onlyCheckoutOnce),
    accountEmail: "",
    "profileId (do not edit)": "",
    groupName: group.name,
    "groupId (do not edit)": group.id,
  };
}

/** Quoted only when it has to be -- a comma, a quote or a line break, "1 Main St, Apt 2" being the usual one. */
function cell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

/** The whole file: Hidden's header, then one line per profile, every one filed under `group`. */
export function toHiddenCsv(profiles: ExportableProfile[], group: HiddenGroup): string {
  const lines = profiles.map((profile) => {
    const row = toHiddenRow(profile, group);
    return HIDDEN_HEADER.map((column) => cell(row[column])).join(",");
  });
  return [HIDDEN_HEADER.join(","), ...lines].join("\n");
}

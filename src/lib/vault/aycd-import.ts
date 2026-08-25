import { countryCode, stateCode } from "@/lib/vault/aycd";
import { isValidPostalCode, nextProfileName, profileBaseFor } from "@/lib/vault/profile-input";
import {
  detectBrand,
  isExpired,
  isLuhnValid,
  isValidCvv,
  last4,
  normalizeExpiry,
  normalizePan,
} from "@/lib/vault/card";

/**
 * Reading an AYCD profile export back in.
 *
 * The mirror of `aycd.ts`, which writes this format. Members already keep their profiles
 * in AYCD Toolbox; asking them to retype 15 of them into a web form to use this site
 * would be the reason they don't.
 *
 * NO SECRET EVER APPEARS IN AN ISSUE MESSAGE. Every problem is reported by the profile's
 * position and its name in the file, never by the value that failed -- a validation
 * report is rendered in a browser, and "card 4111111111111111 failed the Luhn check" is
 * a card number on someone's screen. The only value this module ever puts in a message
 * is a DIGIT COUNT.
 *
 * Pure: no database, no `server-only`, no secrets at rest. The action that calls this
 * does the encrypting.
 */

export type ParsedProfile = {
  /** 1-based position in the uploaded file, for reporting. */
  position: number;
  /** The name AYCD had. Used only to report; the server assigns the stored name. */
  sourceName: string;
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

  onlyCheckoutOnce: boolean;
  matchNameOnCardAndAddress: boolean;

  cardNumber: string;
  cardCvv: string;
  cardExpMonth: string;
  cardExpYear: string;
  cardBrand: string;
  cardLast4: string;
};

export type ImportIssue = {
  position: number;
  name: string;
  problem: string;
  /** Warnings import anyway; errors skip the row. */
  severity: "error" | "warning";
};

export type ParseResult = {
  profiles: ParsedProfile[];
  issues: ImportIssue[];
};

/**
 * Hard ceiling on one MEMBER upload. Well past any real member's profile count.
 *
 * The operator's CLI import raises it: their own exports run to hundreds of profiles
 * across every member, and a limit meant to bound an untrusted upload has no business
 * bounding a local admin script.
 */
export const MAX_PROFILES = 250;

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function bool(value: unknown): boolean {
  return value === true;
}

/** Splits "Jane Q Public" into first and last the same way the export joined them. */
function splitName(full: string): { firstName: string; lastName: string } {
  const parts = full.split(/\s+/).filter(Boolean);
  if (parts.length < 2) return { firstName: parts[0] ?? "", lastName: "" };
  return { firstName: parts[0], lastName: parts.slice(1).join(" ") };
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export type ParseOptions = {
  /** Ceiling on how many profiles one file may carry. */
  maxProfiles?: number;
  /**
   * Downgrade a wrong-length security code from an error to a warning.
   *
   * Off by default: a member uploading their own file should be told the code is wrong
   * while they can still fix it. The operator's CLI turns it on to force through known
   * data -- those profiles import, but they will fail at checkout until corrected.
   */
  allowInvalidCvv?: boolean;
};

export function parseAycdExport(text: string, options: ParseOptions = {}): ParseResult {
  const maxProfiles = options.maxProfiles ?? MAX_PROFILES;
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

  // AYCD exports a bare array. Accept `{ profiles: [...] }` too, since some tools wrap it.
  const list = Array.isArray(root)
    ? root
    : Array.isArray((root as { profiles?: unknown }).profiles)
      ? ((root as { profiles: unknown[] }).profiles as unknown[])
      : null;

  if (!list) {
    return {
      profiles: [],
      issues: [
        {
          position: 0,
          name: "",
          problem: "That doesn't look like an AYCD profile export — expected a list of profiles.",
          severity: "error",
        },
      ],
    };
  }

  if (list.length > maxProfiles) {
    return {
      profiles: [],
      issues: [
        {
          position: 0,
          name: "",
          problem: `That file holds ${list.length} profiles; the limit is ${maxProfiles} per import.`,
          severity: "error",
        },
      ],
    };
  }

  const profiles: ParsedProfile[] = [];
  const issues: ImportIssue[] = [];
  const seenEmails = new Set<string>();

  list.forEach((raw, i) => {
    const position = i + 1;
    const entry = (raw ?? {}) as Record<string, unknown>;
    const sourceName = str(entry.name) || `#${position}`;
    const fail = (problem: string) =>
      issues.push({ position, name: sourceName, problem, severity: "error" });
    const warn = (problem: string) =>
      issues.push({ position, name: sourceName, problem, severity: "warning" });

    const ship = (entry.shippingAddress ?? {}) as Record<string, unknown>;
    const bill = (entry.billingAddress ?? {}) as Record<string, unknown>;
    const pay = (entry.paymentDetails ?? {}) as Record<string, unknown>;

    const email = str(ship.email).toLowerCase() || str(bill.email).toLowerCase();
    if (!EMAIL_RE.test(email)) {
      fail("No usable email address on the profile.");
      return;
    }
    // The 1:1 account-to-profile rule means one address cannot appear twice.
    if (seenEmails.has(email)) {
      fail("That email appears more than once in this file.");
      return;
    }
    seenEmails.add(email);

    const { firstName, lastName } = splitName(str(ship.name));
    if (!firstName || !lastName) {
      fail("Shipping name needs a first and last name.");
      return;
    }

    const shipLine1 = str(ship.line1);
    const shipCity = str(ship.city);
    const shipState = stateCode(str(ship.state));
    const shipPostalCode = str(ship.postCode) || str(ship.postcode) || str(ship.zip);
    if (!shipLine1 || !shipCity || !shipState || !shipPostalCode) {
      fail("Shipping address is missing a street, city, state, or ZIP.");
      return;
    }
    // A REJECTION, not a warning like the Luhn check below. A card that fails Luhn is
    // sometimes a real store card; a four-digit ZIP is never a real address, and importing
    // it puts a profile in the vault that quietly ships to the wrong place. This path is
    // how "100128" and "1374" reached live profiles.
    if (!isValidPostalCode(shipPostalCode)) {
      fail(`Shipping ZIP "${shipPostalCode}" isn't a US ZIP — five digits, or ZIP+4.`);
      return;
    }

    const sameBillingAndShipping = bool(entry.sameBillingAndShippingAddress);
    const billLine1 = str(bill.line1);
    const billCity = str(bill.city);
    const billState = stateCode(str(bill.state));
    const billPostalCode = str(bill.postCode) || str(bill.postcode) || str(bill.zip);
    if (!sameBillingAndShipping && (!billLine1 || !billCity || !billState || !billPostalCode)) {
      fail("Billing address is incomplete, and it isn't marked the same as shipping.");
      return;
    }
    // Only when it is a real second address. With the flag set the billing columns are
    // never stored, so whatever the file happens to carry there is not ours to judge.
    if (!sameBillingAndShipping && !isValidPostalCode(billPostalCode)) {
      fail(`Billing ZIP "${billPostalCode}" isn't a US ZIP — five digits, or ZIP+4.`);
      return;
    }

    const pan = normalizePan(str(pay.cardNumber));
    if (!pan) {
      fail("No card number.");
      return;
    }
    if (pan.length < 12 || pan.length > 19) {
      fail(`Card number is ${pan.length} digits, which isn't a card length.`);
      return;
    }
    // A warning, not a rejection: the same call the operator's own importer makes, and
    // some store cards genuinely fail Luhn.
    if (!isLuhnValid(pan)) warn("Card number fails the Luhn check — importing anyway.");

    const brand = detectBrand(pan);
    const cvv = str(pay.cardCvv);
    if (!cvv) {
      fail("No security code.");
      return;
    }
    if (!isValidCvv(cvv, brand)) {
      if (!options.allowInvalidCvv) {
        fail("Security code isn't the right length for that card.");
        return;
      }
      warn("Security code isn't the right length for that card -- it will fail at checkout.");
    }

    const { month, year } = normalizeExpiry(str(pay.cardExpMonth), str(pay.cardExpYear));
    if (
      !/^\d{2}$/.test(month) ||
      !/^\d{4}$/.test(year) ||
      Number(month) < 1 ||
      Number(month) > 12
    ) {
      fail("Expiry date isn't a real month and year.");
      return;
    }
    if (isExpired(month, year)) warn("Card is expired — importing anyway, but it won't check out.");

    const billName = splitName(str(bill.name));

    profiles.push({
      position,
      sourceName,
      email,
      firstName,
      lastName,
      phone: str(ship.phone) || null,
      shipLine1,
      shipLine2: str(ship.line2) || null,
      shipCity,
      shipState,
      shipPostalCode,
      shipCountry: countryCode(str(ship.country)) || "US",
      sameBillingAndShipping,
      billFirstName: sameBillingAndShipping ? null : billName.firstName || null,
      billLastName: sameBillingAndShipping ? null : billName.lastName || null,
      billLine1: sameBillingAndShipping ? null : billLine1,
      billLine2: sameBillingAndShipping ? null : str(bill.line2) || null,
      billCity: sameBillingAndShipping ? null : billCity,
      billState: sameBillingAndShipping ? null : billState,
      billPostalCode: sameBillingAndShipping ? null : billPostalCode,
      billCountry: sameBillingAndShipping ? null : countryCode(str(bill.country)) || "US",
      onlyCheckoutOnce: bool(entry.onlyCheckoutOnce),
      matchNameOnCardAndAddress: bool(entry.matchNameOnCardAndAddress),
      cardNumber: pan,
      cardCvv: cvv,
      cardExpMonth: month,
      cardExpYear: year,
      cardBrand: brand,
      cardLast4: last4(pan),
    });
  });

  return { profiles, issues };
}

/**
 * The retailer logins that go with those profiles.
 *
 * AYCD's profile export carries no account password -- it holds cards and addresses, not
 * logins -- so a member importing profiles for accounts we've never seen has to supply
 * them separately. This reads the same `email:password` shape the admin accounts export
 * writes, so a round trip works without conversion.
 *
 * Splits on the FIRST colon only: passwords containing colons are common and splitting
 * on all of them would silently truncate them.
 */
export function parseAccountList(text: string): Map<string, string> {
  const accounts = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const split = trimmed.indexOf(":");
    if (split <= 0) continue;
    const email = trimmed.slice(0, split).trim().toLowerCase();
    const password = trimmed.slice(split + 1);
    if (EMAIL_RE.test(email) && password) accounts.set(email, password);
  }
  return accounts;
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

/**
 * What to do with a parsed file, decided before anything is written.
 *
 * Pure on purpose. Name assignment, ownership rejection, and the "this account needs a
 * login" rule are the parts of an import that are actually easy to get wrong, and a
 * decision that lives inside a Server Action can only be exercised through a browser.
 * The action loads the current state, calls this, and applies what comes back.
 */

export type ExistingAccount = {
  id: string;
  email: string;
  discordUserId: string;
  /** The profile hanging off it, if it has one. Accounts may exist profile-less. */
  profileId: string | null;
};

export type PlannedCreate = {
  parsed: ParsedProfile;
  /** Server-assigned. Never the name from the file. */
  name: string;
  /** Reuse an existing account row, or create one with `password`. */
  accountId: string | null;
  password: string | null;
};

export type PlannedUpdate = {
  parsed: ParsedProfile;
  profileId: string;
  accountId: string;
  /** Only set when the upload supplied a login for an account we already hold. */
  password: string | null;
};

export type ImportPlan = {
  creates: PlannedCreate[];
  updates: PlannedUpdate[];
  /** Addresses that would be new accounts but had no login supplied. */
  needPassword: string[];
  issues: ImportIssue[];
};

export function planImport(input: {
  profiles: ParsedProfile[];
  accounts: ExistingAccount[];
  /** Every profile name on this site, across all members: the unique spans everyone. */
  takenNames: string[];
  /** Just this member's names, which is what their base is derived from. */
  myNames: string[];
  passwords: Map<string, string>;
  viewerDiscordId: string;
  viewerUsername: string;
}): ImportPlan {
  const accountByEmail = new Map(input.accounts.map((a) => [a.email.toLowerCase(), a]));
  const base = profileBaseFor(input.myNames, input.viewerUsername);
  const taken = [...input.takenNames];

  const plan: ImportPlan = { creates: [], updates: [], needPassword: [], issues: [] };

  for (const parsed of input.profiles) {
    const existing = accountByEmail.get(parsed.email);
    const password = input.passwords.get(parsed.email) ?? null;

    if (existing && existing.discordUserId !== input.viewerDiscordId) {
      plan.issues.push({
        position: parsed.position,
        name: parsed.sourceName,
        problem: "That email is already registered to another member.",
        severity: "error",
      });
      continue;
    }

    if (existing?.profileId) {
      plan.updates.push({
        parsed,
        profileId: existing.profileId,
        accountId: existing.id,
        password,
      });
      continue;
    }

    // A brand-new account needs a login; AYCD's profile export doesn't carry one.
    if (!existing && !password) {
      plan.needPassword.push(parsed.email);
      continue;
    }

    const name = nextProfileName(base, taken);
    taken.push(name);
    plan.creates.push({ parsed, name, accountId: existing?.id ?? null, password });
  }

  return plan;
}

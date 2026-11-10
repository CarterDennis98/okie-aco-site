import { countryName, stateName } from "@/lib/vault/aycd";

/**
 * Valor's backup ("setup") file, as Valor 3.0 writes it -- read off the operator's two real
 * instances on 2026-11-10 -- and how a vault profile is written into it.
 *
 * ONE JSON OBJECT, pretty-printed with two spaces, no trailing newline:
 *
 *   version            "3.0"
 *   tasks              { groups: {<id>: TaskGroup}, lists: {<group id>: {<category>: {<id>: Task}}} }
 *   proxies            { groups: {<id>: {id, name, totalAmount}}, lists: {<group id>: Proxy[]} }
 *   accounts           { groups: {<id>: AccountGroup}, lists: {<group id>: {<id>: Account}} }
 *   profiles           { groups: {<id>: ProfileGroup}, lists: {<group id>: {<id>: Profile}} }
 *   settings, captchaHarvesters, captchaProviders, automations   -- never read or written
 *   imap               {<id>: Imap}                              -- one list, for every site
 *
 * Every id is a UUID v4, and every map is keyed by the id its value also carries. A group's
 * `totalAmount` (and a task group's `taskCounts`, per category) is the size of its list, kept
 * by Valor rather than worked out on load, so an export that changes a list changes its count.
 * A task points at its profile by `{name, id}` plus the profile's group, and at its login the
 * same way; nothing else in the file holds a profile, task or login id.
 *
 * The files read back byte for byte through JSON.parse and JSON.stringify(_, null, 2), so an
 * export edits the parsed object and writes it out the same way, and every part of the file
 * it doesn't touch comes out exactly as it went in.
 *
 * Everything here is pure, so it runs in the operator's browser and in the tests alike.
 */

export type ValorRef = { name: string; id: string };

export type ValorAddress = {
  firstName: string;
  lastName: string;
  addressLine1: string;
  addressLine2: string;
  city: string;
  /** "United States". */
  countryName: string;
  /** "US". */
  countryCode: string;
  /** The FULL name -- "Oklahoma" -- as AYCD writes it, never the two-letter code. */
  state: string;
  zipCode: string;
};

export type ValorCard = {
  holder: string;
  /** Spaced as printed: "4111 1111 1111 1111", or "3782 822463 10005" for Amex. */
  number: string;
  /** "MM/YY". */
  expiration: string;
  cvv: string;
  /** "visa", "mastercard", "amex", "discover", "jcb", or "" for any other card. */
  type: string;
};

export type ValorProfile = {
  name: string;
  email: string;
  /** "405-555-0101", or "0": Pokémon Center's "make one up at checkout". */
  phoneNumber: string;
  billingSameAsShipping: boolean;
  oneCheckout: boolean;
  quickTask: boolean;
  card: ValorCard;
  shipping: ValorAddress;
  /** The shipping address again, field for field, when billingSameAsShipping. */
  billing: ValorAddress;
  id: string;
  totalSpent: number;
};

export type ValorGroup = { id: string; name: string; totalAmount: number };

export type ValorTaskGroup = ValorGroup & {
  /** "PokemonCenter", "Target", "Shopify"... */
  siteModule: string;
  site: string;
  taskCounts: Record<string, number>;
  [key: string]: unknown;
};

export type ValorProduct = {
  sizeRange: unknown[];
  displayedItem: string;
  displayedSize: string;
  /** What the task watches: a TCIN on Target, several as "12345, 67890". */
  monitorInput: string;
  color: string;
  minSizesLoaded: number;
  minPrice: number;
  maxPrice: number | null;
  productQuantity: number;
  skipIfOOS: boolean;
};

/**
 * A task. The fields the export writes are named; the rest -- settings, schedule, mode --
 * are copied as they are. Valor writes these keys in more than one order, so a new task is
 * always a copy of one already in its group (or of the built-in shape) and keeps its order.
 */
export type ValorTask = {
  id: string;
  selected: boolean;
  running: boolean;
  status: string;
  color: string;
  queueTime?: number;
  carted: boolean;
  successful: boolean;
  failed: boolean;
  passedQueue?: boolean;
  currentProxy: string | null;
  proxyGroupID: string | null;
  monitorProxyGroupID?: string | null;
  profile: ValorRef | null;
  profileGroupID: string | null;
  accountGroupID: string | null;
  account: ValorRef | null;
  products: ValorProduct[];
  [key: string]: unknown;
};

export type ValorAccount = {
  id: string;
  email: string;
  password: string;
  proxy: unknown;
  /** Signed in: what an export must keep rather than recreate. */
  session: unknown;
  selected: boolean;
  [key: string]: unknown;
};

export type ValorAccountGroup = ValorGroup & { site: string };

export type ValorImap = {
  id: string;
  /** "imap.gmail.com" -- Valor keeps no port. */
  server: string;
  email: string;
  password: string;
  readEmails: number;
  codesReceived: number;
  connected: boolean;
  enabled: boolean;
  selected: boolean;
  status: string;
  [key: string]: unknown;
};

export type ValorBackup = {
  version: string;
  tasks: {
    groups: Record<string, ValorTaskGroup>;
    lists: Record<string, Record<string, Record<string, ValorTask>>>;
  };
  proxies: { groups: Record<string, ValorGroup>; lists: Record<string, unknown[]> };
  accounts: {
    groups: Record<string, ValorAccountGroup>;
    lists: Record<string, Record<string, ValorAccount>>;
  };
  profiles: {
    groups: Record<string, ValorGroup>;
    lists: Record<string, Record<string, ValorProfile>>;
  };
  imap: Record<string, ValorImap>;
  [key: string]: unknown;
};

/** The version these shapes were read from. Another one still loads, with a warning. */
export const VALOR_VERSION = "3.0";

// ---------------------------------------------------------------------------
// The groups the export works in, by name
// ---------------------------------------------------------------------------

/** Pokémon Center profiles: each member's first five on the main bot, the rest on a backup. */
export const ACO_MAIN = "ACO Main";
export const ACO_BACKUP = "ACO Backup";

/**
 * The Pokémon Center task groups, one task per profile in each: the main-bot profiles run on
 * both ISP and resi proxies, the backup-bot ones on resi only. Each instance has all three.
 */
export const PKC_TASK_GROUPS = [
  { name: "PKC ACO - ISP", profiles: "main" },
  { name: "PKC ACO - Resi", profiles: "main" },
  { name: "PKC ACO (backup) - Resi", profiles: "backup" },
] as const;

/** The Target side of the second instance: the Miscellaneous line's picks, and only theirs. */
export const TARGET_PROFILE_GROUP = "Target";
export const TARGET_ACCOUNT_GROUP = "Target";
export const TARGET_TASK_GROUP = "Target";
/** Where Target tasks check out and monitor from: the operator's choice, 2026-11-10. */
export const TARGET_PROXY_GROUP = "Target ISP";

/** The task list a group holds its tasks in, on every site that has only one. */
export const DEFAULT_CATEGORY = "Default";

/** A group name with case, spaces and punctuation ignored: "PKC ACO (backup) - Resi" -> "pkcacobackupresi". */
export function groupKey(name: string | null | undefined): string {
  return String(name ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

/** Every group by that name, however it's spelled. More than one is the caller's problem. */
export function groupsNamed<T extends { name: string }>(
  groups: Record<string, T>,
  name: string,
): T[] {
  return Object.values(groups).filter((g) => groupKey(g.name) === groupKey(name));
}

// ---------------------------------------------------------------------------
// Reading a file
// ---------------------------------------------------------------------------

export class ValorFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValorFormatError";
  }
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Parses a backup and checks the parts the export reads or writes have the shape above.
 * Throws a ValorFormatError saying what's wrong, rather than half-reading a file Valor may
 * have changed under it.
 */
export function parseValorBackup(text: string): ValorBackup {
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch {
    throw new ValorFormatError("That file isn't valid JSON, so it isn't a Valor backup.");
  }
  const problems = valorProblems(root);
  if (problems.length > 0) {
    throw new ValorFormatError(
      `This doesn't look like a Valor backup the export knows (${problems.slice(0, 4).join("; ")}). ` +
        "Valor may have changed its format — nothing was read.",
    );
  }
  return root as ValorBackup;
}

function valorProblems(root: unknown): string[] {
  if (!isObject(root)) return ["not a JSON object"];
  const problems: string[] = [];
  if (typeof root.version !== "string") problems.push("no version");
  for (const section of ["tasks", "proxies", "accounts", "profiles"]) {
    const value = root[section];
    if (!isObject(value) || !isObject(value.groups) || !isObject(value.lists)) {
      problems.push(`no ${section} groups and lists`);
    }
  }
  if (!isObject(root.imap)) problems.push("no imap list");
  if (problems.length > 0) return problems;

  const sections = root as unknown as ValorBackup;
  for (const [id, group] of Object.entries(sections.profiles.groups)) {
    if (!isObject(group) || group.id !== id || typeof group.name !== "string")
      problems.push(`profile group ${id} is malformed`);
    const list = sections.profiles.lists[id];
    if (list !== undefined && !isObject(list)) problems.push(`profile list ${id} isn't a map`);
    for (const [pid, profile] of Object.entries(list ?? {})) {
      if (
        !isObject(profile) ||
        profile.id !== pid ||
        typeof profile.name !== "string" ||
        typeof profile.email !== "string" ||
        !isObject(profile.card) ||
        !isObject(profile.shipping) ||
        !isObject(profile.billing)
      ) {
        problems.push(`profile ${pid} is malformed`);
        break;
      }
    }
  }
  for (const [id, group] of Object.entries(sections.tasks.groups)) {
    if (!isObject(group) || group.id !== id || typeof group.name !== "string")
      problems.push(`task group ${id} is malformed`);
    const lists = sections.tasks.lists[id];
    if (lists !== undefined && !isObject(lists)) problems.push(`task lists of ${id} aren't a map`);
    for (const [category, list] of Object.entries(lists ?? {})) {
      if (!isObject(list)) {
        problems.push(`task list ${id}/${category} isn't a map`);
        continue;
      }
      for (const [tid, task] of Object.entries(list)) {
        if (!isObject(task) || task.id !== tid || !Array.isArray(task.products)) {
          problems.push(`task ${tid} is malformed`);
          break;
        }
      }
    }
  }
  for (const [id, group] of Object.entries(sections.accounts.groups)) {
    if (!isObject(group) || group.id !== id || typeof group.name !== "string")
      problems.push(`account group ${id} is malformed`);
  }
  for (const [id, group] of Object.entries(sections.proxies.groups)) {
    if (!isObject(group) || group.id !== id || typeof group.name !== "string")
      problems.push(`proxy group ${id} is malformed`);
  }
  for (const [id, entry] of Object.entries(sections.imap)) {
    if (!isObject(entry) || entry.id !== id || typeof entry.email !== "string") {
      problems.push(`imap entry ${id} is malformed`);
      break;
    }
  }
  return problems;
}

/** The file as Valor writes it: two-space indent, no trailing newline. */
export function serializeValorBackup(backup: ValorBackup): string {
  return JSON.stringify(backup, null, 2);
}

// ---------------------------------------------------------------------------
// A vault profile, as Valor writes one
// ---------------------------------------------------------------------------

/** An address as the vault holds it: the two-letter state and country codes. */
export type VaultAddress = {
  firstName: string;
  lastName: string;
  street: string;
  street2: string;
  city: string;
  state: string;
  zip: string;
  country: string;
};

/** What a Valor profile is built from. Carries secrets -- never logged. */
export type ProfileSource = {
  name: string;
  email: string;
  /** Ten digits, "0" for Valor to make one up, or whatever the vault holds. */
  phone: string;
  shipping: VaultAddress;
  /** Null when billing is the shipping address. */
  billing: VaultAddress | null;
  card: {
    /** Digits only. */
    number: string;
    /** "09". */
    expMonth: string;
    /** "2031". */
    expYear: string;
    cvv: string;
  };
  onlyCheckoutOnce: boolean;
};

/** Ten digits as Valor shows them, "405-555-0101"; "0" and anything else as they are. */
export function valorPhone(phone: string): string {
  const trimmed = phone.trim();
  let digits = trimmed.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) digits = digits.slice(1);
  if (digits.length !== 10 || trimmed === "0") return trimmed;
  return `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`;
}

/** A card number spaced the way Valor stores it: 4-4-4-4, or 4-6-5 for a 15-digit Amex. */
export function valorCardNumber(number: string): string {
  const digits = number.replace(/\D/g, "");
  if (digits.length === 16) return digits.replace(/(\d{4})(?=\d)/g, "$1 ");
  if (digits.length === 15)
    return `${digits.slice(0, 4)} ${digits.slice(4, 10)} ${digits.slice(10)}`;
  return digits;
}

/**
 * Valor's card brand, from the number's leading digits -- matched against every card in both
 * real instances: Target's REDcard (6394...) and anything unrecognised are "".
 */
export function valorCardType(number: string): string {
  const digits = number.replace(/\D/g, "");
  if (/^4/.test(digits)) return "visa";
  if (/^3[47]/.test(digits)) return "amex";
  if (/^5[1-5]/.test(digits) || /^2(2[2-9][1-9]|[3-6]\d\d|7[01]\d|720)/.test(digits))
    return "mastercard";
  if (/^6394/.test(digits)) return "";
  if (/^6(011|5|4[4-9]|22)/.test(digits)) return "discover";
  if (/^35(2[89]|[3-8]\d)/.test(digits)) return "jcb";
  return "";
}

/** "09", "2031" -> "09/31". */
export function valorExpiry(month: string, year: string): string {
  const m = month.replace(/\D/g, "").padStart(2, "0").slice(-2);
  const y = year.replace(/\D/g, "").slice(-2).padStart(2, "0");
  return `${m}/${y}`;
}

export function valorAddress(a: VaultAddress): ValorAddress {
  return {
    firstName: a.firstName,
    lastName: a.lastName,
    addressLine1: a.street,
    addressLine2: a.street2,
    city: a.city,
    countryName: countryName(a.country || "US"),
    countryCode: (a.country || "US").toUpperCase(),
    state: stateName(a.state),
    zipCode: a.zip,
  };
}

const fullName = (a: { firstName: string; lastName: string }) =>
  `${a.firstName} ${a.lastName}`.trim();

/**
 * A new Valor profile for `source`. The name on the card is the billing name -- the shipping
 * name when billing is shipping -- which is what most profiles in both instances hold.
 */
export function newValorProfile(source: ProfileSource, id: string): ValorProfile {
  const shipping = valorAddress(source.shipping);
  const billing = source.billing ? valorAddress(source.billing) : { ...shipping };
  return {
    name: source.name,
    email: source.email,
    phoneNumber: valorPhone(source.phone),
    billingSameAsShipping: source.billing === null,
    oneCheckout: source.onlyCheckoutOnce,
    quickTask: false,
    card: {
      holder: fullName(billing),
      number: valorCardNumber(source.card.number),
      expiration: valorExpiry(source.card.expMonth, source.card.expYear),
      cvv: source.card.cvv,
      type: valorCardType(source.card.number),
    },
    shipping,
    billing,
    id,
    totalSpent: 0,
  };
}

const ADDRESS_FIELDS: [keyof ValorAddress, string][] = [
  ["firstName", "first name"],
  ["lastName", "last name"],
  ["addressLine1", "street"],
  ["addressLine2", "street 2"],
  ["city", "city"],
  ["state", "state"],
  ["zipCode", "ZIP"],
  ["countryCode", "country"],
];

function addressChanges(current: ValorAddress | undefined, next: ValorAddress): string[] {
  if (!current) return ["address"];
  return ADDRESS_FIELDS.filter(
    ([field]) => String(current[field] ?? "").trim() !== String(next[field] ?? "").trim(),
  ).map(([, label]) => label);
}

/**
 * Brings an existing Valor profile in line with `source`, IN PLACE -- keeping its id, which
 * every task holding it points at, and Valor's own `quickTask` and `totalSpent` -- and answers
 * what changed, in words. Nothing changed, nothing is written.
 *
 * The name on the card stays as it is while it is still the profile's shipping or billing
 * name: both instances hold some of each, and rewriting one that is right would only churn.
 */
export function updateValorProfile(profile: ValorProfile, source: ProfileSource): string[] {
  const next = newValorProfile(source, profile.id);
  const changed: string[] = [];
  if (profile.name !== next.name) changed.push("profile name");
  if (profile.email.trim().toLowerCase() !== next.email.trim().toLowerCase()) changed.push("email");
  else if (profile.email !== next.email) changed.push("email capitals");
  if (String(profile.phoneNumber ?? "").replace(/\D/g, "") !== next.phoneNumber.replace(/\D/g, ""))
    changed.push("phone");
  if (profile.oneCheckout !== next.oneCheckout) changed.push("one checkout");

  const card = profile.card;
  if (String(card?.number ?? "").replace(/\D/g, "") !== source.card.number.replace(/\D/g, ""))
    changed.push("card");
  else if (card.number !== next.card.number) changed.push("card spacing");
  if (card?.expiration !== next.card.expiration) changed.push("card expiry");
  if (String(card?.cvv ?? "").trim() !== next.card.cvv) changed.push("CVV");
  if (card?.type !== next.card.type) changed.push("card type");
  const names = new Set([fullName(next.shipping), fullName(next.billing)]);
  const holder = card && names.has(String(card.holder ?? "")) ? card.holder : next.card.holder;
  if (card?.holder !== holder) changed.push("name on card");

  for (const field of addressChanges(profile.shipping, next.shipping)) changed.push(field);
  if (profile.billingSameAsShipping !== next.billingSameAsShipping) {
    changed.push(
      next.billingSameAsShipping ? "billing (now the shipping address)" : "billing address",
    );
  } else {
    for (const field of addressChanges(profile.billing, next.billing))
      changed.push(`billing ${field}`);
  }
  // Valor's own spelling of a country beside the code, should it ever differ.
  if (
    profile.shipping?.countryName !== next.shipping.countryName ||
    profile.billing?.countryName !== next.billing.countryName
  ) {
    if (!changed.some((c) => c.includes("country"))) changed.push("country name");
  }

  if (changed.length === 0) return changed;
  profile.name = next.name;
  profile.email = next.email;
  profile.phoneNumber = next.phoneNumber;
  profile.billingSameAsShipping = next.billingSameAsShipping;
  profile.oneCheckout = next.oneCheckout;
  profile.card = { ...next.card, holder };
  profile.shipping = next.shipping;
  profile.billing = next.billing;
  return changed;
}

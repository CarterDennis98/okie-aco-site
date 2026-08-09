/**
 * Deliberate port of the Discord bot's normalizers.
 *
 * Source of truth: okie-aco-mirror/src/pas/scrape.js -- `normalizeProfile`,
 * `normalizeProduct`, and `parseQuantity`.
 *
 * These functions produce the primary keys that join checkouts to people and to items.
 * The bot and this app must agree byte for byte: if they drift by a single character,
 * keys silently fork and members get billed for someone else's checkouts. The parity
 * suite in normalize.test.ts asserts agreement against every distinct product and
 * profile string in the real billing-run records.
 *
 * If you change anything here, change it in the bot in the same commit.
 */

/** "carter - 2" is carter's second profile, not a different person. */
const PROFILE_SUFFIX_RE = /\s*-\s*(\d+)\s*$/;

export type NormalizedProfile = {
  profileRaw: string;
  profileKey: string;
  profileIndex: number | null;
};

export type NormalizedProduct = {
  productKey: string;
  label: string;
  unreadable: boolean;
};

export function normalizeProfile(raw: string | null | undefined): NormalizedProfile | null {
  if (raw === undefined || raw === null) return null;

  const cleaned = String(raw)
    .replace(/\|\|/g, "") // spoiler bars, stripped by the mirror but be defensive
    .replace(/[`*_~]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  if (!cleaned) return null;

  const match = cleaned.match(PROFILE_SUFFIX_RE);
  const base = match ? cleaned.slice(0, match.index).trim() : cleaned;

  // A profile that is nothing but "- 2" isn't a real name
  if (!base) return { profileRaw: cleaned, profileKey: cleaned.toLowerCase(), profileIndex: null };

  return {
    profileRaw: cleaned,
    profileKey: base.toLowerCase(),
    profileIndex: match ? Number(match[1]) : null,
  };
}

export function normalizeProduct(
  raw: string | null | undefined,
  aliases: Record<string, string> = {},
): NormalizedProduct {
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return { productKey: "__unknown__", label: "(no product listed)", unreadable: true };
  }

  const cleaned = String(raw).replace(/\*\*/g, "").replace(/\s+/g, " ").trim();

  const alias = aliases[cleaned.toLowerCase()];
  if (alias) return { productKey: alias.toLowerCase(), label: alias, unreadable: false };

  // Bare SKUs (Swft) are meaningless to a member reading their bill
  const unreadable = /^\d{6,}$/.test(cleaned);

  return { productKey: cleaned.toLowerCase(), label: cleaned, unreadable };
}

export function parseQuantity(raw: string | number | null | undefined): {
  quantity: number;
  assumed: boolean;
} {
  if (raw === undefined || raw === null) return { quantity: 1, assumed: true };

  const digits = String(raw).replace(/[^\d]/g, "");
  const parsed = Number.parseInt(digits, 10);

  if (!Number.isFinite(parsed) || parsed < 1) return { quantity: 1, assumed: true };

  return { quantity: parsed, assumed: false };
}

/**
 * Alias lookups are case-insensitive on the raw string, matching the bot's
 * loadProductAliases(). Call this on rows from the item_aliases table before
 * passing them to normalizeProduct.
 */
export function toAliasMap(rows: { aliasKey: string; label: string }[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const row of rows) map[row.aliasKey.toLowerCase()] = row.label;
  return map;
}

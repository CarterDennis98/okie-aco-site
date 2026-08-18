/**
 * What of a raw vendor embed is allowed into the database.
 *
 * Raw vendor embeds carry LIVE CREDENTIALS: plaintext retailer account passwords, proxy
 * credentials with their own passwords, and payment fields. Storing the embed whole --
 * which is what makes SKU and order-id extraction recoverable later -- would mean
 * storing those too, in a column nothing encrypts.
 *
 * So this is an ALLOWLIST, not a denylist. A vendor field nobody has thought about
 * defaults to not-stored. Anything wrongly dropped is re-scrapable from Discord; a
 * credential written to a JSON column is not recoverable from.
 *
 * Dropped field NAMES are returned so the operator can widen this deliberately. Values
 * are never returned, logged, or stored.
 *
 * Pure: no database, no `server-only`. The ingest route and the backfill both use it.
 */

/**
 * Field names kept, compared case-insensitively with bold markers stripped (Swft bolds
 * its field names). Anything with an "Order" prefix is kept -- the vendors spell it
 * "Order Number", "Order ID", and "Order #".
 */
const ALLOWED_FIELDS = new Set([
  "site",
  "module",
  "product",
  "item",
  "quantity",
  "profile",
  "price",
  "total",
  "size",
  "color",
  "mode",
  "id",
  "fraud reason",
  "fraud status",
  "cancel reason",
]);

/**
 * Explicitly named so the reason is on the record rather than implied by absence.
 *
 *   Email / Account          the retailer login
 *   Payment                  card details
 *   Proxy*, Checkout Proxy   proxy host, port, user, password
 *   Share Link               a base64 blob encoding the vendor's site + proxy setup
 */
const KNOWN_SENSITIVE = new Set([
  "email",
  "account",
  "payment",
  "proxy",
  "proxy details",
  "proxy group",
  "checkout proxy",
  "share link",
]);

function normalizeName(name: string): string {
  return name.replace(/\*\*/g, "").trim().toLowerCase();
}

function isAllowed(name: string): boolean {
  const normalized = normalizeName(name);
  if (normalized.startsWith("order")) return true;
  return ALLOWED_FIELDS.has(normalized);
}

export type SanitizedEmbed = {
  /** Safe to store. Null when there was nothing usable. */
  embed: Record<string, unknown> | null;
  /** Names of fields that were dropped, deduplicated. Never values. */
  dropped: string[];
  /** Dropped names that are known to carry credentials, for a louder log line. */
  droppedSensitive: string[];
};

export function sanitizeEmbed(raw: unknown): SanitizedEmbed {
  if (!raw || typeof raw !== "object") return { embed: null, dropped: [], droppedSensitive: [] };

  const source = raw as Record<string, unknown>;
  const kept: Record<string, unknown> = {};
  const dropped = new Set<string>();
  const droppedSensitive = new Set<string>();

  // Scalars worth keeping. `url` is the vendor's own link on the embed title.
  for (const key of ["title", "description", "timestamp", "url", "color"]) {
    if (source[key] !== undefined && source[key] !== null) kept[key] = source[key];
  }

  const author = source.author as { name?: unknown } | undefined;
  if (author && typeof author.name === "string") kept.author = { name: author.name };

  const footer = source.footer as { text?: unknown } | undefined;
  if (footer && typeof footer.text === "string") kept.footer = { text: footer.text };

  const thumbnail = source.thumbnail as { url?: unknown; proxy_url?: unknown } | undefined;
  if (thumbnail && (thumbnail.url || thumbnail.proxy_url)) {
    kept.thumbnail = {
      ...(typeof thumbnail.url === "string" ? { url: thumbnail.url } : {}),
      ...(typeof thumbnail.proxy_url === "string" ? { proxy_url: thumbnail.proxy_url } : {}),
    };
  }

  if (Array.isArray(source.fields)) {
    const fields: { name: string; value: unknown }[] = [];
    for (const entry of source.fields) {
      if (!entry || typeof entry !== "object") continue;
      const field = entry as { name?: unknown; value?: unknown };
      if (typeof field.name !== "string") continue;

      if (isAllowed(field.name)) {
        fields.push({ name: field.name, value: field.value });
      } else {
        const normalized = normalizeName(field.name);
        dropped.add(field.name);
        if (KNOWN_SENSITIVE.has(normalized)) droppedSensitive.add(field.name);
      }
    }
    if (fields.length) kept.fields = fields;
  }

  return {
    embed: Object.keys(kept).length ? kept : null,
    dropped: [...dropped],
    droppedSensitive: [...droppedSensitive],
  };
}

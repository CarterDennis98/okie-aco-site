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
 * Field names kept, compared case-insensitively with bold markers and a trailing colon
 * stripped (Swft bolds its field names; Alpine ends every one with ":"). Anything with an
 * "Order" prefix is kept -- the vendors spell it "Order Number", "Order ID", "Order #" and
 * "Order" -- but only as TEXT: see orderValue.
 */
const ALLOWED_FIELDS = new Set([
  "site",
  "module",
  // Sniped's name for the site, its mode in a bracket after it: "Target (Checkout)".
  "store",
  "product",
  "item",
  "quantity",
  // Stellar's spelling of quantity, and its product id -- both there for recoverability,
  // like the rest of this list.
  "qty",
  "sku",
  // Alpine's product id: the Shopify variant it bought.
  "variant",
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
 *   Profile Email            the retailer login's address (Alpine)
 *   Payment                  card details
 *   Proxy*, Checkout Proxy   proxy host, port, user, password
 *   Share Link               a base64 blob encoding the vendor's site + proxy setup
 */
const KNOWN_SENSITIVE = new Set([
  "email",
  "profile email",
  "account",
  "payment",
  "proxy",
  "proxy details",
  "proxy group",
  "checkout proxy",
  "share link",
]);

function normalizeName(name: string): string {
  return name.replace(/\*\*/g, "").trim().replace(/:$/, "").trim().toLowerCase();
}

function isOrderField(name: string): boolean {
  return normalizeName(name).startsWith("order");
}

function isAllowed(name: string): boolean {
  if (isOrderField(name)) return true;
  return ALLOWED_FIELDS.has(normalizeName(name));
}

/**
 * An order field's value with every link reduced to its text, and any bare URL removed.
 *
 * The order NUMBER is what's worth keeping. The link a vendor wraps it in can be a
 * credential in its own right: Alpine links each Topps order to its Shopify order-status
 * page with an `authenticate?key=` token in the query, and that URL opens the order -- the
 * member's address included -- for anyone holding it. The text survives; the URL never
 * reaches the database.
 */
function orderValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  return value
    .replace(/\[([^\]]*)\]\(\s*https?:\/\/[^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "")
    .trim();
}

const EMAIL = /[^\s@]+@[^\s@]+\.[^\s@]+/;

/**
 * A kept field's value with every line that holds an email address taken out.
 *
 * A field can be allowed by name and still carry a login: Sniped stacks the retailer
 * account's address under the profile name inside its Profile field, each line spoilered
 * on its own. The WHOLE line goes, not just the address -- whatever shares a line with a
 * login's address is likelier to be the rest of that login than anything worth keeping.
 */
function withoutEmailLines(value: unknown): unknown {
  if (typeof value !== "string" || !EMAIL.test(value)) return value;
  return value
    .split("\n")
    .filter((line) => !EMAIL.test(line))
    .join("\n")
    .trim();
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

      const value = withoutEmailLines(
        isOrderField(field.name) ? orderValue(field.value) : field.value,
      );
      // An order field that was nothing but a link, or any field that was nothing but an
      // email address, has nothing left worth storing.
      if (isAllowed(field.name) && value !== "") {
        fields.push({ name: field.name, value });
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

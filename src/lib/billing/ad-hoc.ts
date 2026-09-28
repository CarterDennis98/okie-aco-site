import { ogDiscountCents, parseCents } from "@/lib/money";
import { normalizeProduct } from "@/lib/normalize";

/**
 * Fees issued by hand, for a retailer `/pas run` cannot see.
 *
 * Premium Bandai sends the bot no webhook, so there are no checkouts for a billing run to
 * scan and no bill for the bot to send. Its runner enters the fee instead: a profile, a
 * product, a fee and a quantity, reviewed and then issued as an ordinary charge -- the same
 * `pas_bills` row, lines and payment flow as everything the bot bills. See PasRun.adHoc.
 *
 * Pure: the parsing and the arithmetic, so what the review step shows and what the action
 * stores are computed by the same code, and so both can be tested without a database.
 */

/** The bot's own typo guard -- MAX_REASONABLE_FEE in fees.js: past $1,000 a unit is a slip. */
export const MAX_FEE_CENTS = 100_000;
/** Per line. Bandai limits orders far below this; more is a typo. */
export const MAX_QTY = 100;
/** Per bill. A member rarely hits more than a couple of products in one drop. */
export const MAX_LINES = 10;
/** Same bound the billing-run contract puts on a line's label, halved for typing. */
export const MAX_LABEL = 200;
/** How far back a drop date can be. A fee for a drop older than this is almost surely a typo. */
export const MAX_AGE_DAYS = 90;

/** The timezone drop dates are named in -- PAS_TIMEZONE in the bot. */
const TIMEZONE = "America/Chicago";

/** One line as typed into the form. */
export type AdHocLineInput = { product: string; fee: string; qty: string };

/** One line, checked and priced. */
export type AdHocLine = {
  label: string;
  /** The bot's normalized key, so the same product billed both ways is one item. */
  productKey: string;
  qty: number;
  feeCents: number;
  subtotalCents: number;
};

export type AdHocTotals = { subtotalCents: number; discountCents: number; totalCents: number };

/**
 * The typed lines, checked. Fully blank rows are dropped -- the form keeps one spare -- and
 * anything else that won't price is an error naming the line, never a guess.
 */
export function parseAdHocLines(
  rows: readonly AdHocLineInput[],
): { ok: true; lines: AdHocLine[] } | { ok: false; error: string } {
  const lines: AdHocLine[] = [];
  const seen = new Set<string>();

  for (const [index, row] of rows.entries()) {
    const product = row.product.replace(/\s+/g, " ").trim();
    const fee = row.fee.trim();
    const qty = row.qty.trim();
    if (!product && !fee && !qty) continue;

    const n = `Line ${index + 1}`;
    if (!product) return { ok: false, error: `${n}: name the product.` };
    if (product.length > MAX_LABEL) {
      return { ok: false, error: `${n}: keep the product name under ${MAX_LABEL} characters.` };
    }

    const feeCents = parseCents(fee);
    if (feeCents === null || feeCents <= 0) {
      return { ok: false, error: `${n}: enter the fee per unit, like 8 or 12.50.` };
    }
    if (feeCents > MAX_FEE_CENTS) {
      return {
        ok: false,
        error: `${n}: $${(feeCents / 100).toFixed(2)} a unit looks like a typo.`,
      };
    }

    const units = /^\d+$/.test(qty) ? Number(qty) : NaN;
    if (!Number.isInteger(units) || units < 1 || units > MAX_QTY) {
      return { ok: false, error: `${n}: the quantity is a whole number from 1 to ${MAX_QTY}.` };
    }

    // The same normalizer the checkout pipeline and the bot use, byte for byte: a Bandai
    // product that one day arrives by webhook must land on the item billed by hand today.
    const { productKey, label } = normalizeProduct(product);
    if (seen.has(productKey)) {
      return {
        ok: false,
        error: `${n}: ${label} is already on this bill — put the whole quantity on one line.`,
      };
    }
    seen.add(productKey);

    lines.push({ label, productKey, qty: units, feeCents, subtotalCents: units * feeCents });
  }

  if (lines.length === 0) return { ok: false, error: "Add at least one product." };
  if (lines.length > MAX_LINES) return { ok: false, error: `At most ${MAX_LINES} products.` };
  return { ok: true, lines };
}

/**
 * What the bill comes to.
 *
 * The OG discount is the OPERATOR'S to give, exactly as in the bot's computeBills: it comes
 * off a fee owed to the operator, never off one owed to a payee like peacemaker. Rounded in
 * the member's favour by the same helper the rest of the site uses.
 */
export function priceAdHocBill(lines: readonly AdHocLine[], discounted: boolean): AdHocTotals {
  const subtotalCents = lines.reduce((sum, line) => sum + line.subtotalCents, 0);
  const discountCents = ogDiscountCents(subtotalCents, discounted);
  return { subtotalCents, discountCents, totalCents: subtotalCents - discountCents };
}

/** Today's date where drops are named, as YYYY-MM-DD -- the form's default. */
export function todayInDropZone(now: Date = new Date()): string {
  // en-CA formats as YYYY-MM-DD, which is exactly what a date input takes.
  return new Intl.DateTimeFormat("en-CA", { timeZone: TIMEZONE }).format(now);
}

/**
 * A drop date as typed, checked: a real date, not in the future, not older than
 * MAX_AGE_DAYS. Null when it is none of those.
 */
export function parseDropDate(value: string, now: Date = new Date()): string | null {
  const date = value.trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return null;
  const [year, month, day] = match.slice(1).map(Number);
  const probe = new Date(Date.UTC(year, month - 1, day));
  // Catches 2/30 rolling into March.
  if (probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return null;

  // YYYY-MM-DD compares correctly as a string.
  const today = todayInDropZone(now);
  if (date > today) return null;
  const oldest = new Date(Date.parse(`${today}T00:00:00Z`) - MAX_AGE_DAYS * 86_400_000);
  if (probe < oldest) return null;
  return date;
}

/** "9/27/2026" -- the bot's dateLabel, which goes into every drop's name. No leading zeros. */
export function dropDateLabel(date: string): string {
  const [year, month, day] = date.split("-").map(Number);
  return `${month}/${day}/${year}`;
}

/** "Premium Bandai · 9/27/2026" -- the title the charge carries on both sides. */
export function adHocDropLabel(siteLabel: string, date: string): string {
  return `${siteLabel} · ${dropDateLabel(date)}`;
}

/**
 * The instant an ad hoc run is dated at: noon on the drop date, drop-zone time.
 *
 * Noon rather than midnight so the date reads the same in every timezone the site renders
 * in, and so sorting and the charges page's date filter put it on the day it was for. Two
 * passes, like the bot's zonedToUtc, so a guess on the wrong side of a DST change corrects.
 */
export function adHocInstant(date: string): Date {
  const [year, month, day] = date.split("-").map(Number);
  const guess = Date.UTC(year, month - 1, day, 12, 0, 0);
  const first = offsetMs(guess);
  let ms = guess - first;
  const second = offsetMs(ms);
  if (second !== first) ms = guess - second;
  return new Date(ms);
}

/** How far ahead of UTC the drop zone is at an instant, in ms. */
function offsetMs(utcMs: number): number {
  const parts: Record<string, string> = {};
  for (const part of new Intl.DateTimeFormat("en-US", {
    timeZone: TIMEZONE,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(utcMs))) {
    parts[part.type] = part.value;
  }
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour) % 24,
    Number(parts.minute),
    Number(parts.second),
  );
  return asUtc - utcMs;
}

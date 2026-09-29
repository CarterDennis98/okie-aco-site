import { money, parseCents } from "@/lib/money";

/**
 * ACO credit -- the parts with no database in them.
 *
 * Credit is money the operator gives a member by hand that comes off their next Okie ACO
 * fees on its own: the bot spends it during `/pas run`, after the OG and one-off discounts,
 * on the operator's own bill only. See AcoCredit in the schema for the ledger, and
 * db/queries/aco-credit.ts for balances.
 *
 * Plain functions, so the dialog can review exactly what the action will then check again.
 */

/** Most that can be given or taken in one go. Past this it is far likelier a typo. */
export const MAX_CREDIT_CENTS = 100_000;

/** Long enough for a reason, short enough to sit beside a balance. */
export const CREDIT_NOTE_LIMIT = 120;

export type CreditMode = "give" | "take";

export function parseCreditMode(raw: unknown): CreditMode | null {
  return raw === "give" || raw === "take" ? raw : null;
}

/** "10", "$12.50", "1,000" -> cents, or why not. */
export function parseCreditAmount(
  raw: string,
): { ok: true; cents: number } | { ok: false; error: string } {
  const cents = parseCents(raw);
  if (cents === null) return { ok: false, error: "Enter an amount like 10 or 12.50." };
  if (cents <= 0) return { ok: false, error: "Enter an amount above $0." };
  if (cents > MAX_CREDIT_CENTS) {
    return {
      ok: false,
      error: `${money(cents)} at once looks like a typo — the most is ${money(MAX_CREDIT_CENTS)}.`,
    };
  }
  return { ok: true, cents };
}

/** What the member is told the credit is for. Null when nothing was typed. */
export function cleanCreditNote(raw: string): string | null {
  const note = raw.replace(/\s+/g, " ").trim().slice(0, CREDIT_NOTE_LIMIT);
  return note || null;
}

/**
 * The balance a change would leave, or why it can't be made.
 *
 * Taking back is limited to what they still hold: credit a bill has already spent is gone,
 * and taking it again would leave the member owing the operator for money they never had.
 */
export function balanceAfter(
  balanceCents: number,
  mode: CreditMode,
  cents: number,
): { ok: true; cents: number } | { ok: false; error: string } {
  if (mode === "give") return { ok: true, cents: balanceCents + cents };
  if (cents > balanceCents) {
    return {
      ok: false,
      error:
        balanceCents > 0
          ? `They only have ${money(balanceCents)} left to take back.`
          : "They have no credit left to take back.",
    };
  }
  return { ok: true, cents: balanceCents - cents };
}

/**
 * How members pay.
 *
 * A closed list rather than free text: the operator reconciles these against real
 * accounts, and "cashapp" / "Cash App" / "$cashtag" as three spellings of one method
 * makes that harder for no gain. `other` plus the note field covers anything unusual.
 *
 * Plain data, no "use server" -- imported by both the client form and the server action,
 * so the option a member picked is validated against the same list that rendered it.
 */

export const PAYMENT_METHODS = [
  { value: "cashapp", label: "Cash App" },
  { value: "venmo", label: "Venmo" },
  { value: "paypal", label: "PayPal" },
  { value: "zelle", label: "Zelle" },
  { value: "cash", label: "Cash" },
  { value: "other", label: "Other" },
] as const;

export type PaymentMethod = (typeof PAYMENT_METHODS)[number]["value"];

const BY_VALUE = new Map<string, string>(PAYMENT_METHODS.map((m) => [m.value, m.label]));

export function isPaymentMethod(value: string): value is PaymentMethod {
  return BY_VALUE.has(value);
}

/** Display form. Unknown values are echoed rather than dropped -- an older row that
 *  predates a change to this list should still render as whatever it recorded. */
export function methodLabel(value: string | null): string {
  if (!value) return "Not stated";
  return BY_VALUE.get(value) ?? value;
}

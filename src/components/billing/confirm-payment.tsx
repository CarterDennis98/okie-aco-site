"use client";

import { useActionState, useState } from "react";
import { confirmBillPaid, reopenBill, type BillingResult } from "@/lib/billing/actions";
import { PAYMENT_METHODS } from "@/lib/billing/methods";

/**
 * The operator's half: confirm money arrived, or reverse a confirmation made in error.
 *
 * Confirming is one click when the member already said how they sent it -- the method
 * carries over -- with the select there only to correct them. Reversing asks first,
 * because it moves a charge back onto someone's balance.
 */

export function ConfirmPayment({
  billId,
  claimedMethod,
}: {
  billId: string;
  claimedMethod: string | null;
}) {
  const [state, formAction, pending] = useActionState(
    async (_previous: BillingResult | null, formData: FormData) => confirmBillPaid(formData),
    null,
  );

  return (
    <form action={formAction} className="flex flex-wrap items-center justify-end gap-2">
      <input type="hidden" name="billId" value={billId} />
      <select
        name="method"
        defaultValue={claimedMethod ?? ""}
        aria-label="Payment method"
        className="rounded-lg border border-[var(--color-edge)] bg-[var(--color-ink)] px-2 py-1 text-xs text-[var(--color-fg)] focus:border-[var(--color-brand)] focus:outline-none"
      >
        <option value="">Method…</option>
        {PAYMENT_METHODS.map((m) => (
          <option key={m.value} value={m.value}>
            {m.label}
          </option>
        ))}
      </select>
      <button
        type="submit"
        disabled={pending}
        className="rounded-lg bg-[var(--color-brand)] px-3 py-1.5 text-xs font-semibold text-[var(--color-on-brand)] transition-colors hover:bg-[var(--color-brand-dark)] disabled:opacity-60"
      >
        {pending ? "Saving…" : "Mark received"}
      </button>
      {state && !state.ok && (
        <span className="text-xs text-[var(--color-warn)]">{state.error}</span>
      )}
    </form>
  );
}

export function ReopenBill({ billId }: { billId: string }) {
  const [confirming, setConfirming] = useState(false);
  const [state, formAction, pending] = useActionState(
    async (_previous: BillingResult | null, formData: FormData) => {
      const result = await reopenBill(formData);
      if (result.ok) setConfirming(false);
      return result;
    },
    null,
  );

  if (!confirming) {
    return (
      <button
        type="button"
        onClick={() => setConfirming(true)}
        className="text-xs text-[var(--color-muted)] transition-colors hover:text-[var(--color-brand)]"
      >
        Reverse
      </button>
    );
  }

  return (
    <form action={formAction} className="flex items-center justify-end gap-2">
      <input type="hidden" name="billId" value={billId} />
      <span className="text-xs text-[var(--color-muted)]">
        {state && !state.ok ? state.error : "Put this back on their balance?"}
      </span>
      <button
        type="submit"
        disabled={pending}
        className="text-xs font-semibold text-[var(--color-brand)] disabled:opacity-60"
      >
        Yes
      </button>
      <button
        type="button"
        onClick={() => setConfirming(false)}
        className="text-xs text-[var(--color-muted)]"
      >
        No
      </button>
    </form>
  );
}

"use client";

import { useActionState, useState } from "react";
import { claimBillPaid, unclaimBillPaid, type BillingResult } from "@/lib/billing/actions";
import { PAYMENT_METHODS, methodLabel } from "@/lib/billing/methods";

/**
 * "I've sent this" — the member's half of the paid workflow.
 *
 * Says what it does and what it doesn't: recording a claim tells the operator to go and
 * look, it does not clear the balance. A control that read "Mark as paid" and then left
 * the charge showing Unpaid would look broken; the copy here is what stops that.
 *
 * Three states: nothing claimed, claim pending confirmation, confirmed received.
 */

const field =
  "rounded-lg border border-[var(--color-edge)] bg-[var(--color-ink)] px-3 py-2 text-sm text-[var(--color-fg)] placeholder:text-[var(--color-muted)]/60 focus:border-[var(--color-brand)] focus:outline-none";

export function ClaimPayment({
  billId,
  paidAt,
  claimedAt,
  claimedMethod,
  claimedNote,
}: {
  billId: string;
  paidAt: Date | null;
  claimedAt: Date | null;
  claimedMethod: string | null;
  claimedNote: string | null;
}) {
  const [open, setOpen] = useState(false);

  const [claimState, claimAction, claiming] = useActionState(
    async (_previous: BillingResult | null, formData: FormData) => {
      const result = await claimBillPaid(formData);
      if (result.ok) setOpen(false);
      return result;
    },
    null,
  );
  const [undoState, undoAction, undoing] = useActionState(
    async (_previous: BillingResult | null, formData: FormData) => unclaimBillPaid(formData),
    null,
  );

  if (paidAt) {
    return (
      <div className="mt-6 rounded-xl border border-[var(--color-edge)] bg-[var(--color-surface)] px-5 py-4">
        <p className="text-sm font-semibold text-white">Payment received</p>
        <p className="mt-1 text-xs text-[var(--color-muted)]">
          Confirmed on {paidAt.toLocaleDateString("en-US")}
          {claimedMethod ? ` · ${methodLabel(claimedMethod)}` : ""}. Nothing further owed on this
          charge.
        </p>
      </div>
    );
  }

  if (claimedAt) {
    return (
      <div className="mt-6 rounded-xl border border-[var(--color-edge)] bg-[var(--color-surface)] px-5 py-4">
        <p className="text-sm font-semibold text-white">Waiting on confirmation</p>
        <p className="mt-1 text-xs text-[var(--color-muted)]">
          You marked this sent on {claimedAt.toLocaleDateString("en-US")} via{" "}
          {methodLabel(claimedMethod)}
          {claimedNote ? ` — “${claimedNote}”` : ""}. It stays listed as unpaid until the payment is
          confirmed on our end.
        </p>
        <form action={undoAction} className="mt-3 flex items-center gap-3">
          <input type="hidden" name="billId" value={billId} />
          <button
            type="submit"
            disabled={undoing}
            className="text-xs font-medium text-[var(--color-muted)] transition-colors hover:text-[var(--color-brand)] disabled:opacity-60"
          >
            {undoing ? "Undoing…" : "I haven't sent it yet"}
          </button>
          {undoState && !undoState.ok && (
            <span className="text-xs text-[var(--color-warn)]">{undoState.error}</span>
          )}
        </form>
      </div>
    );
  }

  return (
    <div className="mt-6 rounded-xl border border-[var(--color-edge)] bg-[var(--color-surface)] px-5 py-4">
      <p className="text-sm font-semibold text-white">Already sent this?</p>
      <p className="mt-1 text-xs text-[var(--color-muted)]">
        Let us know and we&rsquo;ll confirm it against the account. This doesn&rsquo;t clear the
        balance on its own — the charge stays unpaid until the payment is confirmed.
      </p>

      {!open ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="mt-3 rounded-lg border border-[var(--color-edge)] px-3 py-1.5 text-sm font-medium text-[var(--color-fg)] transition-colors hover:border-[var(--color-brand)]/50"
        >
          I&rsquo;ve sent this
        </button>
      ) : (
        <form action={claimAction} className="mt-3 flex flex-wrap items-end gap-3">
          <input type="hidden" name="billId" value={billId} />
          <div>
            <label
              htmlFor="method"
              className="mb-1 block text-xs font-medium text-[var(--color-muted)]"
            >
              How did you send it?
            </label>
            <select id="method" name="method" defaultValue="" className={field} required>
              <option value="" disabled>
                Pick one
              </option>
              {PAYMENT_METHODS.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
          </div>
          <div className="min-w-56 flex-1">
            <label
              htmlFor="note"
              className="mb-1 block text-xs font-medium text-[var(--color-muted)]"
            >
              Reference <span className="font-normal">(optional)</span>
            </label>
            <input
              id="note"
              name="note"
              maxLength={140}
              placeholder="Your cashtag, handle, or what the note said"
              className={`${field} w-full`}
            />
          </div>
          <button
            type="submit"
            disabled={claiming}
            className="rounded-lg bg-[var(--color-brand)] px-4 py-2 text-sm font-semibold text-[var(--color-on-brand)] transition-colors hover:bg-[var(--color-brand-dark)] disabled:opacity-60"
          >
            {claiming ? "Saving…" : "Submit"}
          </button>
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="px-1 text-sm text-[var(--color-muted)] transition-colors hover:text-[var(--color-fg)]"
          >
            Cancel
          </button>
          {claimState && !claimState.ok && (
            <p role="alert" className="w-full text-xs text-[var(--color-warn)]">
              {claimState.error}
            </p>
          )}
        </form>
      )}
    </div>
  );
}

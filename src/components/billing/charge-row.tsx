"use client";

import { useState, useTransition } from "react";
import { CheckoutsByProfile } from "@/components/checkouts-by-profile";
import { ConfirmPayment, ReopenBill } from "@/components/billing/confirm-payment";
import type { AdminChargeRow } from "@/db/queries/admin-charges";
import type { BillCheckouts } from "@/db/queries/drop-checkouts";
import { loadBillCheckouts } from "@/lib/billing/admin-actions";
import { methodLabel } from "@/lib/billing/methods";
import { count, plural } from "@/lib/format";
import { money } from "@/lib/money";

/**
 * One row of the operator's charges table, with the checkouts behind it on demand.
 *
 * The whole row is a client component because the expansion needs a SECOND `<tr>` as a
 * sibling -- a full-width panel under the row, which is the only place an itemised
 * breakdown fits in a five-column table. A toggle nested inside a cell cannot produce that
 * sibling, so the row owns both.
 *
 * Fetched on first open, then cached in state: a page holds 50 charges, and loading every
 * member's checkouts for every drop on screen to serve the one row somebody expands would
 * make the page slower for everyone. Re-opening does not re-fetch -- nothing about a past
 * drop's checkouts changes while you read the list.
 */

const cell = "px-3 py-2.5 text-left align-middle";

function formatDate(date: Date): string {
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

/** Most drop windows open and close on one day, and "Aug 14 – Aug 14" reads as a bug. */
function formatWindow(start: Date, end: Date): string {
  const from = formatDate(start);
  const to = formatDate(end);
  return from === to ? from : `${from} – ${to}`;
}

export function ChargeRow({ row }: { row: AdminChargeRow }) {
  const [open, setOpen] = useState(false);
  const [checkouts, setCheckouts] = useState<BillCheckouts | null>(null);
  const [failed, setFailed] = useState(false);
  const [pending, startTransition] = useTransition();

  function toggle() {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    if (checkouts || pending) return;
    startTransition(async () => {
      const result = await loadBillCheckouts(row.id);
      if (result) setCheckouts(result);
      else setFailed(true);
    });
  }

  return (
    <>
      <tr>
        <td className={cell}>
          <span className="font-medium text-white">{row.username}</span>
        </td>
        <td className={cell}>
          <span className="text-[var(--color-fg)]">{row.dropLabel}</span>
          <span className="mt-0.5 block text-xs text-[var(--color-muted)]">
            {formatDate(row.windowStart)} · {count(row.lineCount)}{" "}
            {plural(row.lineCount, "product")}
          </span>
          {/* The answer to "what did they actually get". The bill lines are per product;
              this is per profile, which is the question that gets asked when a member
              queries a charge. */}
          <button
            type="button"
            onClick={toggle}
            aria-expanded={open}
            className="mt-1 inline-flex min-h-11 items-center gap-1 text-xs font-medium text-[var(--color-muted)] transition-colors hover:text-[var(--color-fg)] sm:min-h-0"
          >
            <span
              aria-hidden
              className={open ? "rotate-90 transition-transform" : "transition-transform"}
            >
              ›
            </span>
            {pending ? "Loading…" : open ? "Hide checkouts" : "Checkouts"}
          </button>
        </td>
        <td className={cell}>
          {row.paidAt ? (
            <>
              <span className="text-[var(--color-muted)]">Received {formatDate(row.paidAt)}</span>
              {row.paidClaimedMethod && (
                <span className="mt-0.5 block text-xs text-[var(--color-muted)]">
                  {methodLabel(row.paidClaimedMethod)}
                </span>
              )}
            </>
          ) : row.paidClaimedAt ? (
            <>
              <span className="text-[var(--color-warn)]">
                Sent {formatDate(row.paidClaimedAt)} · {methodLabel(row.paidClaimedMethod)}
              </span>
              {row.paidClaimedNote && (
                <span className="mt-0.5 block text-xs text-[var(--color-muted)]">
                  &ldquo;{row.paidClaimedNote}&rdquo;
                </span>
              )}
            </>
          ) : (
            <span className="text-[var(--color-muted)]">Unpaid</span>
          )}
        </td>
        <td className={`${cell} text-right`}>
          <span className="font-semibold text-white tabular-nums">{money(row.totalCents)}</span>
          {/* Part-paid: what is still owed is the number the operator is chasing, so it
              goes under the total rather than replacing it. */}
          {!row.paidAt && row.paidCents > 0 && (
            <span className="block text-xs text-[var(--color-muted)] tabular-nums">
              {money(row.totalCents - row.paidCents)} left
            </span>
          )}
        </td>
        <td className={`${cell} text-right`}>
          {row.paidAt ? (
            <ReopenBill billId={row.id} />
          ) : (
            <>
              <ConfirmPayment
                billId={row.id}
                totalCents={row.totalCents}
                paidCents={row.paidCents}
                claimedCents={row.paidClaimedCents}
                claimedMethod={row.paidClaimedMethod}
              />
              {/* Reversing is offered on a part-paid row too: a payment entered against the
                  wrong charge needs undoing whether or not it happened to settle the bill. */}
              {row.paidCents > 0 && (
                <div className="mt-1">
                  <ReopenBill billId={row.id} />
                </div>
              )}
            </>
          )}
        </td>
      </tr>

      {open && (
        <tr>
          <td colSpan={5} className="bg-[var(--color-ink)]/40 px-5 py-4">
            {pending && !checkouts ? (
              <p className="text-xs text-[var(--color-muted)]">Loading checkouts…</p>
            ) : failed ? (
              <p className="text-xs text-[var(--color-warn)]">
                Couldn&rsquo;t load the checkouts for this charge.
              </p>
            ) : checkouts ? (
              <>
                <p className="mb-3 text-xs text-[var(--color-muted)]">
                  {checkouts.checkoutCount === 0
                    ? `Nothing recorded on ${row.username}'s profiles during ${checkouts.dropLabel}.`
                    : `${count(checkouts.checkoutCount)} ${plural(
                        checkouts.checkoutCount,
                        "checkout",
                      )} · ${count(checkouts.unitCount)} ${plural(
                        checkouts.unitCount,
                        "unit",
                      )} across ${count(checkouts.profiles.length)} ${plural(
                        checkouts.profiles.length,
                        "profile",
                      )}, ${formatWindow(checkouts.windowStart, checkouts.windowEnd)}`}
                </p>
                <CheckoutsByProfile profiles={checkouts.profiles} />
                {checkouts.truncated && (
                  <p className="mt-3 text-xs text-[var(--color-muted)]">
                    Capped — older checkouts in this window aren&rsquo;t shown.
                  </p>
                )}
              </>
            ) : null}
          </td>
        </tr>
      )}
    </>
  );
}

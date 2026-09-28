"use client";

import { useRef, useState, useTransition } from "react";
import type { AdHocProfileOption, AdHocSite } from "@/db/queries/ad-hoc";
import {
  adHocDropLabel,
  parseAdHocLines,
  parseDropDate,
  priceAdHocBill,
  todayInDropZone,
  type AdHocLine,
  type AdHocLineInput,
  type AdHocTotals,
} from "@/lib/billing/ad-hoc";
import { issueAdHocFee, loadAdHocProfiles, type IssueResult } from "@/lib/billing/ad-hoc-actions";
import { money } from "@/lib/money";

/**
 * "Issue a fee" -- billing by hand, for a retailer `/pas run` can't see. See ad-hoc.ts.
 *
 * Three steps in one native <dialog>: fill it in, review it, done. The review is computed by
 * the same functions the action stores with, and the action refuses to store a total other
 * than the one reviewed -- so what was on screen when "Issue" was clicked is the bill.
 *
 * One idempotency key per bill, minted when the form opens or is reset: a double-click or a
 * retried POST lands on the same charge instead of billing the member twice.
 */

export type AdHocSiteOption = AdHocSite & {
  /** Who a fee here is owed to, as the viewer should read it: "you", a name, "Okie ACO". */
  owedTo: string;
};

type Review = {
  profile: AdHocProfileOption;
  dropLabel: string;
  lines: AdHocLine[];
  totals: AdHocTotals;
};

type Issued = Extract<IssueResult, { ok: true }>;

/** Profiles listed at once. The filter box is how you reach the rest. */
const SHOWN = 200;

const field =
  "w-full rounded-lg border border-[var(--color-edge)] bg-[var(--color-ink)] px-3 py-1.5 text-base sm:text-sm text-[var(--color-fg)] placeholder:text-[var(--color-muted)]/60 focus:border-[var(--color-brand)] focus:outline-none";
const label = "mb-1 block text-xs font-medium text-[var(--color-muted)]";
const primary =
  "rounded-lg bg-[var(--color-brand)] px-4 py-2 text-sm font-semibold text-[var(--color-on-brand)] transition-colors hover:bg-[var(--color-brand-dark)] disabled:opacity-60";
const secondary =
  "rounded-lg border border-[var(--color-edge)] px-4 py-2 text-sm font-medium text-[var(--color-fg)] transition-colors hover:border-[var(--color-brand)]/50 disabled:opacity-60";

const blankRow = (): AdHocLineInput => ({ product: "", fee: "", qty: "1" });

export function AdHocFee({ sites }: { sites: AdHocSiteOption[] }) {
  const dialog = useRef<HTMLDialogElement>(null);

  const [key, setKey] = useState("");
  const [step, setStep] = useState<"form" | "review" | "done">("form");
  const [siteKey, setSiteKey] = useState(sites[0]?.siteKey ?? "");
  const [profiles, setProfiles] = useState<AdHocProfileOption[] | null>(null);
  const [filter, setFilter] = useState("");
  const [profileId, setProfileId] = useState("");
  const [date, setDate] = useState("");
  const [rows, setRows] = useState<AdHocLineInput[]>([blankRow()]);
  const [review, setReview] = useState<Review | null>(null);
  const [issued, setIssued] = useState<Issued | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, startLoading] = useTransition();
  const [issuing, startIssuing] = useTransition();

  const site = sites.find((s) => s.siteKey === siteKey) ?? sites[0];

  function loadProfiles(next: string) {
    setProfiles(null);
    setProfileId("");
    setFilter("");
    startLoading(async () => {
      setProfiles((await loadAdHocProfiles(next)) ?? []);
    });
  }

  /**
   * A fresh bill: new key, empty lines. The retailer and the date carry over -- the usual
   * next thing after issuing one fee is the next member from the same drop. `reload` fetches
   * the profiles again, which opening does: assignments can have moved since last time.
   */
  function startBill(reload = false) {
    setKey(crypto.randomUUID());
    setStep("form");
    setRows([blankRow()]);
    setReview(null);
    setIssued(null);
    setError(null);
    setDate((current) => current || todayInDropZone());
    if (reload || profiles === null) {
      loadProfiles(siteKey);
    } else {
      setProfileId("");
      setFilter("");
    }
  }

  function open() {
    startBill(true);
    dialog.current?.showModal();
  }

  function toReview() {
    const profile = profiles?.find((p) => p.id === profileId);
    if (!profile) return setError("Pick the profile that checked out.");
    const day = parseDropDate(date);
    if (!day) return setError("Pick the drop date — today or earlier.");
    const parsed = parseAdHocLines(rows);
    if (!parsed.ok) return setError(parsed.error);

    setReview({
      profile,
      dropLabel: adHocDropLabel(site.label, day),
      lines: parsed.lines,
      totals: priceAdHocBill(parsed.lines, profile.discounted),
    });
    setError(null);
    setStep("review");
  }

  function issue() {
    if (!review) return;
    // The raw fields, not the parsed review: the action parses and prices again for itself
    // and checks its total against the one reviewed here.
    const form = new FormData();
    form.set("key", key);
    form.set("siteKey", siteKey);
    form.set("profileId", review.profile.id);
    form.set("date", date);
    form.set("reviewedTotal", String(review.totals.totalCents));
    for (const row of rows) {
      form.append("product", row.product);
      form.append("fee", row.fee);
      form.append("qty", row.qty);
    }
    startIssuing(async () => {
      const outcome = await issueAdHocFee(form);
      if (outcome.ok) {
        setIssued(outcome);
        setError(null);
        setStep("done");
      } else {
        setError(outcome.error);
      }
    });
  }

  const setRow = (index: number, patch: Partial<AdHocLineInput>) =>
    setRows((current) => current.map((row, i) => (i === index ? { ...row, ...patch } : row)));

  const terms = filter.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const matching = (profiles ?? []).filter((p) =>
    terms.every((term) => `${p.name} ${p.memberName}`.toLowerCase().includes(term)),
  );

  if (sites.length === 0) return null;

  return (
    <>
      <button type="button" onClick={open} className={secondary}>
        Issue a fee
      </button>

      <dialog
        ref={dialog}
        aria-labelledby="ad-hoc-title"
        className="m-auto w-[min(34rem,calc(100vw-2rem))] rounded-2xl border border-[var(--color-edge)] bg-[var(--color-surface)] p-0 text-[var(--color-fg)] backdrop:bg-black/60"
      >
        {/* Nothing inside until the first open: the form defaults to today's date, and the
            server's "today" and the browser's can disagree around midnight. */}
        {key && (
          <div className="max-h-[calc(100vh-4rem)] overflow-y-auto p-5 sm:p-6">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 id="ad-hoc-title" className="text-lg font-bold text-white">
                  {step === "review"
                    ? "Review the fee"
                    : step === "done"
                      ? "Fee issued"
                      : "Issue a fee"}
                </h2>
                <p className="mt-1 text-xs text-[var(--color-muted)]">
                  For a checkout /pas run can&rsquo;t see. It goes on the member&rsquo;s dashboard —
                  nobody is DMed.
                </p>
              </div>
              <button
                type="button"
                onClick={() => dialog.current?.close()}
                aria-label="Close"
                className="-mt-1 -mr-1 inline-flex size-11 shrink-0 items-center justify-center rounded-lg text-[var(--color-muted)] hover:text-[var(--color-fg)] sm:size-8"
              >
                ✕
              </button>
            </div>

            {step === "form" && (
              <div className="mt-5 space-y-4">
                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <label htmlFor="ad-hoc-site" className={label}>
                      Retailer
                    </label>
                    <select
                      id="ad-hoc-site"
                      value={siteKey}
                      onChange={(event) => {
                        const next = event.currentTarget.value;
                        setSiteKey(next);
                        loadProfiles(next);
                      }}
                      className={field}
                    >
                      {sites.map((s) => (
                        <option key={s.siteKey} value={s.siteKey}>
                          {s.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label htmlFor="ad-hoc-date" className={label}>
                      Drop date
                    </label>
                    <input
                      id="ad-hoc-date"
                      type="date"
                      value={date}
                      max={todayInDropZone()}
                      onChange={(event) => setDate(event.currentTarget.value)}
                      className={field}
                    />
                  </div>
                </div>

                <div>
                  <label htmlFor="ad-hoc-profile" className={label}>
                    Profile
                  </label>
                  <input
                    type="search"
                    value={filter}
                    onChange={(event) => setFilter(event.currentTarget.value)}
                    placeholder="Filter by profile or member"
                    aria-label="Filter profiles"
                    disabled={!profiles || profiles.length === 0}
                    className={`${field} mb-2`}
                  />
                  <select
                    id="ad-hoc-profile"
                    value={profileId}
                    onChange={(event) => setProfileId(event.currentTarget.value)}
                    disabled={!profiles || profiles.length === 0}
                    className={field}
                  >
                    <option value="">
                      {loading || !profiles
                        ? "Loading…"
                        : profiles.length === 0
                          ? `No ${site.label} profiles are assigned to you`
                          : matching.length === 0
                            ? "Nothing matches"
                            : "Pick a profile"}
                    </option>
                    {matching.slice(0, SHOWN).map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name} — {p.memberName}
                        {p.active ? "" : " (disabled)"}
                      </option>
                    ))}
                  </select>
                  {matching.length > SHOWN && (
                    <p className="mt-1 text-[11px] text-[var(--color-muted)]">
                      Showing {SHOWN} of {matching.length} — filter to narrow it.
                    </p>
                  )}
                </div>

                <fieldset>
                  <legend className={label}>Products</legend>
                  <div className="space-y-2">
                    {rows.map((row, index) => (
                      <div key={index} className="grid grid-cols-[1fr_5.5rem_4rem_auto] gap-2">
                        <input
                          value={row.product}
                          onChange={(event) =>
                            setRow(index, { product: event.currentTarget.value })
                          }
                          placeholder="Product"
                          aria-label={`Product ${index + 1}`}
                          className={field}
                        />
                        <input
                          value={row.fee}
                          onChange={(event) => setRow(index, { fee: event.currentTarget.value })}
                          inputMode="decimal"
                          placeholder="Fee"
                          aria-label={`Fee per unit, product ${index + 1}`}
                          className={field}
                        />
                        <input
                          value={row.qty}
                          onChange={(event) => setRow(index, { qty: event.currentTarget.value })}
                          inputMode="numeric"
                          placeholder="Qty"
                          aria-label={`Quantity, product ${index + 1}`}
                          className={field}
                        />
                        <button
                          type="button"
                          onClick={() =>
                            setRows((current) => current.filter((_, i) => i !== index))
                          }
                          disabled={rows.length === 1}
                          aria-label={`Remove product ${index + 1}`}
                          className="inline-flex min-h-11 items-center px-1 text-sm text-[var(--color-muted)] hover:text-[var(--color-fg)] disabled:invisible sm:min-h-0"
                        >
                          ✕
                        </button>
                      </div>
                    ))}
                  </div>
                  <button
                    type="button"
                    onClick={() => setRows((current) => [...current, blankRow()])}
                    className="mt-2 inline-flex min-h-11 items-center text-xs font-medium text-[var(--color-muted)] hover:text-[var(--color-fg)] sm:min-h-0"
                  >
                    + Another product
                  </button>
                  <p className="mt-1 text-[11px] text-[var(--color-muted)]">
                    Fee is per unit, in dollars.
                  </p>
                </fieldset>

                {error && (
                  <p role="alert" className="text-sm text-[var(--color-warn)]">
                    {error}
                  </p>
                )}

                <div className="flex justify-end gap-2 pt-1">
                  <button
                    type="button"
                    onClick={() => dialog.current?.close()}
                    className={secondary}
                  >
                    Cancel
                  </button>
                  <button type="button" onClick={toReview} disabled={loading} className={primary}>
                    Review
                  </button>
                </div>
              </div>
            )}

            {step === "review" && review && (
              <div className="mt-5 space-y-4">
                <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
                  <dt className="text-[var(--color-muted)]">Member</dt>
                  <dd className="font-semibold text-white">{review.profile.memberName}</dd>
                  <dt className="text-[var(--color-muted)]">Profile</dt>
                  <dd>{review.profile.name}</dd>
                  <dt className="text-[var(--color-muted)]">Charge</dt>
                  <dd>{review.dropLabel}</dd>
                  <dt className="text-[var(--color-muted)]">Owed to</dt>
                  <dd>{site.owedTo}</dd>
                </dl>

                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-[var(--color-edge)] text-left text-[11px] tracking-[0.1em] text-[var(--color-muted)] uppercase">
                      <th className="py-1.5 font-medium">Product</th>
                      <th className="py-1.5 pl-3 text-right font-medium">Qty</th>
                      <th className="py-1.5 pl-3 text-right font-medium">Fee</th>
                      <th className="py-1.5 pl-3 text-right font-medium">Subtotal</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[var(--color-edge)]">
                    {review.lines.map((line) => (
                      <tr key={line.productKey}>
                        <td className="py-2 pr-2 break-words">{line.label}</td>
                        <td className="py-2 pl-3 text-right tabular-nums">{line.qty}</td>
                        <td className="py-2 pl-3 text-right text-[var(--color-muted)] tabular-nums">
                          {money(line.feeCents)}
                        </td>
                        <td className="py-2 pl-3 text-right tabular-nums">
                          {money(line.subtotalCents)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot className="border-t border-[var(--color-edge)]">
                    {review.totals.discountCents > 0 && (
                      <tr className="text-[var(--color-brand)]">
                        <th colSpan={3} className="py-1.5 text-right font-normal">
                          OG discount
                        </th>
                        <td className="py-1.5 text-right tabular-nums">
                          −{money(review.totals.discountCents)}
                        </td>
                      </tr>
                    )}
                    <tr className="text-base font-bold text-white">
                      <th colSpan={3} className="py-2 text-right">
                        Total
                      </th>
                      <td className="py-2 text-right tabular-nums">
                        {money(review.totals.totalCents)}
                      </td>
                    </tr>
                  </tfoot>
                </table>

                {error && (
                  <p role="alert" className="text-sm text-[var(--color-warn)]">
                    {error}
                  </p>
                )}

                <div className="flex justify-end gap-2 pt-1">
                  <button
                    type="button"
                    onClick={() => {
                      setError(null);
                      setStep("form");
                    }}
                    disabled={issuing}
                    className={secondary}
                  >
                    Back
                  </button>
                  <button type="button" onClick={issue} disabled={issuing} className={primary}>
                    {issuing ? "Issuing…" : `Issue ${money(review.totals.totalCents)}`}
                  </button>
                </div>
              </div>
            )}

            {step === "done" && issued && (
              <div className="mt-5 space-y-4">
                <p role="status" className="text-sm">
                  {issued.already ? "Already issued: " : ""}
                  <span className="font-semibold text-white">
                    {money(issued.totalCents)}
                  </span> to <span className="font-semibold text-white">{issued.memberName}</span>,
                  owed to {issued.owedTo}. It&rsquo;s on their dashboard now — nobody was DMed, so
                  let them know it&rsquo;s there.
                </p>
                <div className="flex justify-end gap-2">
                  <button type="button" onClick={() => startBill()} className={secondary}>
                    Issue another
                  </button>
                  <button type="button" onClick={() => dialog.current?.close()} className={primary}>
                    Done
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </dialog>
    </>
  );
}

"use client";

import { useRef, useState, useTransition } from "react";
import type { CreditMemberOption } from "@/db/queries/aco-credit";
import {
  CREDIT_NOTE_LIMIT,
  balanceAfter,
  cleanCreditNote,
  parseCreditAmount,
  type CreditMode,
} from "@/lib/billing/aco-credit";
import { changeAcoCredit, type CreditResult } from "@/lib/billing/credit-actions";
import { money } from "@/lib/money";

/**
 * "ACO credit" -- giving a member credit against their next fees, or taking some back. The
 * operator's only; the page renders this for nobody else and the action refuses anybody else.
 *
 * Three steps in one native <dialog>, like "Issue a fee": fill it in, review it, done. The
 * review shows the balance before and after, and the action refuses a change whose balance
 * moved since then -- a billing run can spend credit in between.
 *
 * One idempotency key per change, minted when the form opens or is reset: a double-click or
 * a retried POST is one ledger row.
 */

type Review = {
  member: CreditMemberOption;
  mode: CreditMode;
  cents: number;
  note: string | null;
  afterCents: number;
};

type Changed = Extract<CreditResult, { ok: true }>;

/** Members listed at once. The filter box is how you reach the rest. */
const SHOWN = 200;

const field =
  "w-full rounded-lg border border-[var(--color-edge)] bg-[var(--color-ink)] px-3 py-1.5 text-base sm:text-sm text-[var(--color-fg)] placeholder:text-[var(--color-muted)]/60 focus:border-[var(--color-brand)] focus:outline-none";
const label = "mb-1 block text-xs font-medium text-[var(--color-muted)]";
const primary =
  "rounded-lg bg-[var(--color-brand)] px-4 py-2 text-sm font-semibold text-[var(--color-on-brand)] transition-colors hover:bg-[var(--color-brand-dark)] disabled:opacity-60";
const secondary =
  "rounded-lg border border-[var(--color-edge)] px-4 py-2 text-sm font-medium text-[var(--color-fg)] transition-colors hover:border-[var(--color-brand)]/50 disabled:opacity-60";

export function AcoCredit({ members }: { members: CreditMemberOption[] }) {
  const dialog = useRef<HTMLDialogElement>(null);

  const [key, setKey] = useState("");
  const [step, setStep] = useState<"form" | "review" | "done">("form");
  const [mode, setMode] = useState<CreditMode>("give");
  const [filter, setFilter] = useState("");
  const [memberId, setMemberId] = useState("");
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [review, setReview] = useState<Review | null>(null);
  const [changed, setChanged] = useState<Changed | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, startSaving] = useTransition();

  /** A fresh change: new key, empty fields. The mode carries over. */
  function startChange() {
    setKey(crypto.randomUUID());
    setStep("form");
    setFilter("");
    setMemberId("");
    setAmount("");
    setNote("");
    setReview(null);
    setChanged(null);
    setError(null);
  }

  function open() {
    startChange();
    dialog.current?.showModal();
  }

  function toReview() {
    const member = members.find((m) => m.id === memberId);
    if (!member) return setError("Pick a member.");
    const parsed = parseCreditAmount(amount);
    if (!parsed.ok) return setError(parsed.error);
    const after = balanceAfter(member.balanceCents, mode, parsed.cents);
    if (!after.ok) return setError(after.error);

    setReview({
      member,
      mode,
      cents: parsed.cents,
      note: cleanCreditNote(note),
      afterCents: after.cents,
    });
    setError(null);
    setStep("review");
  }

  function save() {
    if (!review) return;
    // The raw fields: the action parses and checks everything again for itself, including
    // that the balance is still the one reviewed here.
    const form = new FormData();
    form.set("key", key);
    form.set("mode", review.mode);
    form.set("memberId", review.member.id);
    form.set("amount", amount);
    form.set("note", note);
    form.set("reviewedBalance", String(review.member.balanceCents));
    startSaving(async () => {
      const outcome = await changeAcoCredit(form);
      if (outcome.ok) {
        setChanged(outcome);
        setError(null);
        setStep("done");
      } else {
        setError(outcome.error);
      }
    });
  }

  // Taking back only makes sense for someone who holds some.
  const eligible = mode === "take" ? members.filter((m) => m.balanceCents > 0) : members;
  const terms = filter.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const matching = eligible.filter((m) =>
    terms.every((term) => `${m.name} ${m.username}`.toLowerCase().includes(term)),
  );

  const title =
    step === "review"
      ? "Review the change"
      : step === "done"
        ? "Credit updated"
        : mode === "give"
          ? "Give ACO credit"
          : "Take back ACO credit";

  return (
    <>
      <button type="button" onClick={open} className={secondary}>
        ACO credit
      </button>

      <dialog
        ref={dialog}
        aria-labelledby="aco-credit-title"
        className="m-auto w-[min(32rem,calc(100vw-2rem))] rounded-2xl border border-[var(--color-edge)] bg-[var(--color-surface)] p-0 text-[var(--color-fg)] backdrop:bg-black/60"
      >
        {key && (
          <div className="max-h-[calc(100vh-4rem)] overflow-y-auto p-5 sm:p-6">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 id="aco-credit-title" className="text-lg font-bold text-white">
                  {title}
                </h2>
                <p className="mt-1 text-xs text-[var(--color-muted)]">
                  Comes off their next Okie ACO fees automatically — only what they owe you, never a
                  bill owed to another runner.
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
                <div role="radiogroup" aria-label="Give or take back" className="flex gap-2">
                  {(["give", "take"] as const).map((option) => (
                    <button
                      key={option}
                      type="button"
                      role="radio"
                      aria-checked={mode === option}
                      onClick={() => {
                        setMode(option);
                        setMemberId("");
                        setError(null);
                      }}
                      className={
                        "rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors " +
                        (mode === option
                          ? "border-[var(--color-brand)] bg-[var(--color-brand)]/10 text-white"
                          : "border-[var(--color-edge)] text-[var(--color-muted)] hover:text-[var(--color-fg)]")
                      }
                    >
                      {option === "give" ? "Give" : "Take back"}
                    </button>
                  ))}
                </div>

                <div>
                  <label htmlFor="aco-credit-member" className={label}>
                    Member
                  </label>
                  <input
                    type="search"
                    value={filter}
                    onChange={(event) => setFilter(event.currentTarget.value)}
                    placeholder="Filter by name"
                    aria-label="Filter members"
                    disabled={eligible.length === 0}
                    className={`${field} mb-2`}
                  />
                  <select
                    id="aco-credit-member"
                    value={memberId}
                    onChange={(event) => setMemberId(event.currentTarget.value)}
                    disabled={eligible.length === 0}
                    className={field}
                  >
                    <option value="">
                      {eligible.length === 0
                        ? mode === "take"
                          ? "Nobody holds any credit"
                          : "No members yet"
                        : matching.length === 0
                          ? "Nothing matches"
                          : "Pick a member"}
                    </option>
                    {matching.slice(0, SHOWN).map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name}
                        {m.name.toLowerCase() === m.username.toLowerCase()
                          ? ""
                          : ` (@${m.username})`}
                        {m.balanceCents !== 0 ? ` — ${money(m.balanceCents)} credit` : ""}
                      </option>
                    ))}
                  </select>
                  {matching.length > SHOWN && (
                    <p className="mt-1 text-[11px] text-[var(--color-muted)]">
                      Showing {SHOWN} of {matching.length} — filter to narrow it.
                    </p>
                  )}
                </div>

                <div className="grid gap-3 sm:grid-cols-[8rem_1fr]">
                  <div>
                    <label htmlFor="aco-credit-amount" className={label}>
                      Amount
                    </label>
                    <input
                      id="aco-credit-amount"
                      value={amount}
                      onChange={(event) => setAmount(event.currentTarget.value)}
                      inputMode="decimal"
                      placeholder="$10"
                      className={field}
                    />
                  </div>
                  <div>
                    <label htmlFor="aco-credit-note" className={label}>
                      Reason <span className="font-normal">(optional)</span>
                    </label>
                    <input
                      id="aco-credit-note"
                      value={note}
                      onChange={(event) => setNote(event.currentTarget.value)}
                      maxLength={CREDIT_NOTE_LIMIT}
                      placeholder={mode === "give" ? "Referral bonus" : "Given by mistake"}
                      className={field}
                    />
                  </div>
                </div>
                {mode === "give" && (
                  <p className="-mt-2 text-[11px] text-[var(--color-muted)]">
                    The reason shows on their dashboard beside their balance.
                  </p>
                )}

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
                  <button type="button" onClick={toReview} className={primary}>
                    Review
                  </button>
                </div>
              </div>
            )}

            {step === "review" && review && (
              <div className="mt-5 space-y-4">
                <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
                  <dt className="text-[var(--color-muted)]">Member</dt>
                  <dd className="font-semibold text-white">{review.member.name}</dd>
                  <dt className="text-[var(--color-muted)]">
                    {review.mode === "give" ? "Give" : "Take back"}
                  </dt>
                  <dd className="font-semibold text-white tabular-nums">{money(review.cents)}</dd>
                  <dt className="text-[var(--color-muted)]">Balance</dt>
                  <dd className="tabular-nums">
                    {money(review.member.balanceCents)} →{" "}
                    <span className="font-semibold text-white">{money(review.afterCents)}</span>
                  </dd>
                  {review.note && (
                    <>
                      <dt className="text-[var(--color-muted)]">Reason</dt>
                      <dd className="break-words">{review.note}</dd>
                    </>
                  )}
                </dl>

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
                    disabled={saving}
                    className={secondary}
                  >
                    Back
                  </button>
                  <button type="button" onClick={save} disabled={saving} className={primary}>
                    {saving
                      ? "Saving…"
                      : review.mode === "give"
                        ? `Give ${money(review.cents)}`
                        : `Take back ${money(review.cents)}`}
                  </button>
                </div>
              </div>
            )}

            {step === "done" && changed && (
              <div className="mt-5 space-y-4">
                <p role="status" className="text-sm">
                  {changed.already ? "Already saved: " : ""}
                  <span className="font-semibold text-white">{changed.memberName}</span> now has{" "}
                  <span className="font-semibold text-white">{money(changed.balanceCents)}</span> of
                  ACO credit. It comes off their next bill from you on its own, and shows on their
                  dashboard now.
                </p>
                <div className="flex justify-end gap-2">
                  <button type="button" onClick={startChange} className={secondary}>
                    Another
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

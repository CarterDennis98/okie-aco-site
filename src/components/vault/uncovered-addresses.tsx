"use client";

import { useActionState, useState } from "react";
import type { EmailCredentialSummary } from "@/db/queries/vault";
import {
  forwardEmailAddresses,
  saveEmailAlias,
  type ActionResult,
  type ForwardManyResult,
} from "@/lib/vault/actions";
import { domainOf } from "@/lib/vault/email-providers";
import type { ForwardSkip } from "@/lib/vault/forwarding";

/**
 * The member's addresses with nowhere to read a code from, and the two ways to cover one:
 * an app password of its own, or "Forwards to" an inbox they've already added.
 *
 * Forwarding goes one address at a time from its own picker, or for a whole selection at
 * once from the bar above the list. The bar is for members with hundreds of profiles: their
 * addresses are mostly on a catch-all domain or two, all landing in the same Gmail, and
 * picking that Gmail once per address was the only way to say so. Past a handful of
 * addresses a filter appears too, with a shortcut per domain, so "everything on my domain"
 * is a click and a tick rather than a scroll.
 *
 * What gets forwarded is exactly what's ticked and showing: narrowing the filter unticks
 * whatever it hides, so a tick you can't see never does anything.
 */

/** From this many addresses the list gets a filter. Fewer all fit in its scroll box. */
const FILTER_FROM = 10;
/** Domain shortcuts beside the filter, biggest first. Any other is a few keystrokes away. */
const MAX_DOMAINS = 6;
/** Skipped addresses named in the outcome line; the rest are counted. */
const SKIPS_NAMED = 3;

const matches = (email: string, filter: string) => email.includes(filter.trim().toLowerCase());

/**
 * "This address forwards into one of my inboxes."
 *
 * A select that submits on change rather than a select plus a Save button: there is one
 * field, and a member clearing up ten forwarded addresses should not click twenty times.
 */
function ForwardPicker({
  email,
  credentials,
}: {
  email: string;
  credentials: EmailCredentialSummary[];
}) {
  const [state, formAction] = useActionState(
    async (_previous: ActionResult | null, formData: FormData) => saveEmailAlias(formData),
    null,
  );

  return (
    <form action={formAction} className="flex items-center gap-2">
      <input type="hidden" name="email" value={email} />
      <select
        name="credentialId"
        defaultValue=""
        aria-label={`Inbox that ${email} forwards to`}
        onChange={(e) => e.currentTarget.form?.requestSubmit()}
        className="max-w-52 min-h-11 rounded-lg border border-[var(--color-edge)] bg-[var(--color-ink)] px-2 py-1 text-base text-[var(--color-fg)] focus:border-[var(--color-brand)] focus:outline-none sm:min-h-0 sm:text-xs"
      >
        <option value="" disabled>
          Forwards to…
        </option>
        {credentials.map((c) => (
          <option key={c.id} value={c.id}>
            {c.email}
          </option>
        ))}
      </select>
      {state && !state.ok && (
        <span className="text-[11px] text-[var(--color-warn)]">{state.error}</span>
      )}
    </form>
  );
}

/** "a@x.com has its own app password; b@x.com is already claimed; and 4 more." */
function skippedSentence(skipped: ForwardSkip[]): string {
  const named = skipped.slice(0, SKIPS_NAMED).map((skip) => `${skip.email} ${skip.why}`);
  const rest = skipped.length - named.length;
  return `Skipped: ${named.join("; ")}${rest > 0 ? `; and ${rest} more` : ""}.`;
}

function Outcome({ result }: { result: ForwardManyResult }) {
  if (!result.ok) {
    return (
      <p role="alert" className="mb-2 px-1 text-xs text-[var(--color-warn)]">
        {result.error}
      </p>
    );
  }
  const { forwarded, to, skipped } = result;
  return (
    <p role="status" className="mb-2 px-1 text-xs text-[var(--color-muted)]">
      {forwarded > 0 ? (
        <>
          <span className="font-semibold text-[var(--color-good)]">Forwarded {forwarded}</span>{" "}
          address{forwarded === 1 ? "" : "es"} to{" "}
          <span className="text-[var(--color-fg)]">{to}</span>.
        </>
      ) : (
        "Nothing was forwarded."
      )}
      {skipped.length > 0 && ` ${skippedSentence(skipped)}`}
    </p>
  );
}

export function UncoveredAddresses({
  emails,
  credentials,
  onAddPassword,
}: {
  /** Lowercased, sorted, every one uncovered. */
  emails: string[];
  credentials: EmailCredentialSummary[];
  onAddPassword: (email: string) => void;
}) {
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // With one inbox there's nothing to choose, so it's chosen.
  const [inboxId, setInboxId] = useState(credentials.length === 1 ? credentials[0].id : "");
  const [pending, setPending] = useState(false);
  // Kept here rather than in a form's action state so it outlives the list: forward every
  // address and the list is gone, but what happened to them still needs saying.
  const [result, setResult] = useState<ForwardManyResult | null>(null);

  const bulk = credentials.length > 0 && emails.length > 1;
  const shown = filter.trim() ? emails.filter((email) => matches(email, filter)) : emails;
  // From the current list, so an address forwarded since it was ticked drops out.
  const chosen = shown.filter((email) => selected.has(email));
  const allChosen = chosen.length > 0 && chosen.length === shown.length;
  // An inbox removed since it was picked: the select asks again.
  const inbox = credentials.find((c) => c.id === inboxId) ?? null;

  const counts = new Map<string, number>();
  for (const email of emails) counts.set(domainOf(email), (counts.get(domainOf(email)) ?? 0) + 1);
  const domains = [...counts]
    .sort(([a, x], [b, y]) => y - x || a.localeCompare(b))
    .slice(0, MAX_DOMAINS);

  if (emails.length === 0) {
    return result ? (
      <div className="mt-4">
        <Outcome result={result} />
      </div>
    ) : null;
  }

  function applyFilter(next: string) {
    setFilter(next);
    setResult(null);
    // A tick the filter hides is dropped, so what's forwarded is always what's in view.
    setSelected((current) => new Set([...current].filter((email) => matches(email, next))));
  }

  function tick(email: string, on: boolean) {
    setResult(null);
    setSelected((current) => {
      const next = new Set(current);
      if (on) next.add(email);
      else next.delete(email);
      return next;
    });
  }

  async function forward() {
    if (!inbox || chosen.length === 0) return;
    const form = new FormData();
    form.set("credentialId", inbox.id);
    for (const email of chosen) form.append("email", email);
    setPending(true);
    setResult(null);
    const outcome = await forwardEmailAddresses(form).catch((): ForwardManyResult => ({
      ok: false,
      error: "That didn't save. Check your connection.",
    }));
    setPending(false);
    setResult(outcome);
    if (outcome.ok) setSelected(new Set());
  }

  return (
    <div className="mt-4">
      <p className="mb-2 text-xs text-[var(--color-muted)]">
        <span className="text-[var(--color-fg)]">{emails.length}</span> address
        {emails.length === 1 ? " has" : "es have"} nowhere to read a code from. Give each one its
        own app password, or — if its mail lands in an inbox you have already added — point it there
        instead.
        {bulk
          ? " Tick all the ones that land in the same inbox to point them there at once."
          : emails.length > 1 &&
            " If they all land in one inbox, add that inbox's app password first, then point them all at it at once."}
      </p>

      {emails.length >= FILTER_FROM && (
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <input
            type="search"
            value={filter}
            onChange={(e) => applyFilter(e.currentTarget.value)}
            placeholder="Filter, e.g. @yourdomain.com"
            aria-label="Filter these addresses"
            autoComplete="off"
            className="min-h-11 w-full rounded-lg border border-[var(--color-edge)] bg-[var(--color-ink)] px-3 py-1.5 text-base text-[var(--color-fg)] placeholder:text-[var(--color-muted)]/60 focus:border-[var(--color-brand)] focus:outline-none sm:min-h-0 sm:w-64 sm:text-xs"
          />
          {/* One per domain, when there's more than one to tell apart: a catch-all domain is
              how members end up with hundreds of these, and its own inbox is where they go. */}
          {domains.length > 1 &&
            domains.map(([domain, count]) => {
              const on = filter.trim().toLowerCase() === `@${domain}`;
              return (
                <button
                  key={domain}
                  type="button"
                  aria-pressed={on}
                  onClick={() => applyFilter(on ? "" : `@${domain}`)}
                  className={
                    "inline-flex min-h-11 max-w-full items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] leading-none transition-colors sm:min-h-0 " +
                    (on
                      ? "border-[var(--color-brand)] bg-[var(--color-brand)]/10 text-white"
                      : "border-[var(--color-edge)] text-[var(--color-muted)] hover:text-[var(--color-fg)]")
                  }
                >
                  <span className="min-w-0 truncate">@{domain}</span>
                  <span className="tabular-nums">{count}</span>
                </button>
              );
            })}
        </div>
      )}

      {bulk && (
        <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-2 px-1">
          <label className="flex min-h-11 items-center gap-2 text-xs text-[var(--color-muted)] sm:min-h-0">
            <input
              type="checkbox"
              checked={allChosen}
              ref={(el) => {
                // Partly ticked reads as neither on nor off.
                if (el) el.indeterminate = chosen.length > 0 && !allChosen;
              }}
              onChange={(e) => {
                setResult(null);
                setSelected(e.currentTarget.checked ? new Set(shown) : new Set());
              }}
              disabled={shown.length === 0}
              className="size-4 accent-[var(--color-brand)]"
            />
            Select all {shown.length}
          </label>

          {chosen.length > 0 && (
            <span className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-[var(--color-fg)]">
                {chosen.length} selected · forward to
              </span>
              <select
                value={inbox?.id ?? ""}
                onChange={(e) => setInboxId(e.currentTarget.value)}
                aria-label="Inbox the selected addresses forward to"
                className="max-w-60 min-h-11 rounded-lg border border-[var(--color-edge)] bg-[var(--color-ink)] px-2 py-1 text-base text-[var(--color-fg)] focus:border-[var(--color-brand)] focus:outline-none sm:min-h-0 sm:text-xs"
              >
                <option value="" disabled>
                  Pick an inbox…
                </option>
                {credentials.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.email}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={forward}
                disabled={pending || !inbox}
                className="inline-flex min-h-11 items-center rounded-lg bg-[var(--color-brand)] px-3 py-1 text-xs font-semibold text-[var(--color-on-brand)] transition-colors hover:bg-[var(--color-brand-dark)] disabled:opacity-60 sm:min-h-0"
              >
                {pending ? "Forwarding…" : `Forward ${chosen.length}`}
              </button>
            </span>
          )}
        </div>
      )}

      {result && <Outcome result={result} />}

      {/* Scrolls rather than running the page long: a member can have hundreds of these. */}
      <ul className="max-h-64 divide-y divide-[var(--color-edge)] overflow-y-auto overscroll-contain rounded-xl border border-[var(--color-edge)] bg-[var(--color-surface)]">
        {shown.map((email) => (
          <li
            key={email}
            className={
              "flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5 sm:px-5 " +
              (selected.has(email) ? "bg-[var(--color-brand)]/5" : "")
            }
          >
            {/* A real basis, not flex-1's zero: with none, the picker and button stayed on the
                address's line on a phone and squeezed the address down to nothing. 14rem
                sends them to a line of their own instead. */}
            {bulk ? (
              // The address is the checkbox's label, so ticking down a list can hit either.
              <label className="flex min-h-11 min-w-0 grow basis-56 cursor-pointer items-center gap-3 sm:min-h-0">
                <input
                  type="checkbox"
                  checked={selected.has(email)}
                  onChange={(e) => tick(email, e.currentTarget.checked)}
                  className="size-5 shrink-0 accent-[var(--color-brand)] sm:size-4"
                />
                <span className="min-w-0 truncate text-sm text-[var(--color-fg)]">{email}</span>
              </label>
            ) : (
              <span className="min-w-0 grow basis-56 truncate text-sm text-[var(--color-fg)]">
                {email}
              </span>
            )}
            {credentials.length > 0 && <ForwardPicker email={email} credentials={credentials} />}
            <button
              type="button"
              onClick={() => onAddPassword(email)}
              className="inline-flex min-h-11 items-center text-sm font-medium text-[var(--color-fg)] transition-colors hover:text-white sm:min-h-0 sm:text-xs"
            >
              Add password
            </button>
          </li>
        ))}
        {shown.length === 0 && (
          <li className="px-4 py-2.5 text-xs text-[var(--color-muted)] sm:px-5">
            None of these match &ldquo;{filter.trim()}&rdquo;.
          </li>
        )}
      </ul>
    </div>
  );
}

"use client";

import { useActionState, useState } from "react";
import Image from "next/image";
import type { VaultLoginSummary } from "@/db/queries/vault";
import { relativeTime } from "@/lib/format";
import { siteChangesApplyImmediately, siteStoresCardCvv, siteStyle } from "@/lib/sites";
import {
  deleteLogin,
  revealOwnAppPassword,
  saveLogin,
  setLoginActive,
  type ActionResult,
} from "@/lib/vault/actions";
import { RevealAppPassword } from "@/components/vault/reveal-app-password";

/**
 * One retailer's logins, on a site where a login is all we hold.
 *
 * The counterpart to ProfileManager for a login-only retailer -- see `usesProfiles` in
 * sites.ts. Costco is the first: the bot takes queue spots without signing in, and the
 * order is placed by hand from the member's own account once a pass lands, so there is no
 * card and no address for this site to collect.
 *
 * That makes the copy load-bearing rather than decorative. A member whose Costco account
 * has no card or address saved WILL fail at the one moment nobody can fix it, and this
 * page is the only place they are told so. It is said up front, before the form, not in a
 * hint under a field they may never focus.
 *
 * Deliberately simpler than the profile list: no bulk selection, no soft cap, no
 * shared-card warning. A member has a handful of logins here, and a checkbox column for
 * three rows is furniture rather than a feature.
 */

const field =
  "w-full rounded-lg border border-[var(--color-edge)] bg-[var(--color-ink)] px-3 py-2 text-base sm:text-sm text-[var(--color-fg)] placeholder:text-[var(--color-muted)]/60 focus:border-[var(--color-brand)] focus:outline-none";
const label = "mb-1 block text-xs font-medium text-[var(--color-muted)]";

/** Same wording as the profile list's tick: an imported row has nothing confirmed yet. */
function confirmedLabel(confirmedAt: Date | null): string {
  return confirmedAt ? `Confirmed ${relativeTime(confirmedAt)}` : "Up to date";
}

/**
 * Add / edit one login.
 *
 * The password is write-only: on an existing login it renders empty with a "leave blank
 * to keep" hint, because nothing can read the stored value back to prefill it.
 */
function LoginForm({
  siteKey,
  login,
  onDone,
}: {
  siteKey: string;
  login?: VaultLoginSummary;
  onDone: () => void;
}) {
  const isEdit = Boolean(login);
  const style = siteStyle(siteKey);
  const wantsCvv = siteStoresCardCvv(siteKey);
  // Whether one is already stored, so the placeholder can tell "blank keeps the existing
  // code" apart from "there is no code yet". Never the value -- see VaultLoginSummary.
  const hasCvv = login?.hasCvv ?? false;

  const [state, formAction, pending] = useActionState(
    async (_previous: ActionResult | null, formData: FormData) => {
      const result = await saveLogin(formData);
      if (result.ok) onDone();
      return result;
    },
    null,
  );

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <input type="hidden" name="siteKey" value={siteKey} />
      {login && <input type="hidden" name="loginId" value={login.id} />}

      {state && !state.ok && (
        <p
          role="alert"
          className="rounded-lg border border-[var(--color-brand)]/40 bg-[var(--color-brand)]/10 px-3 py-2 text-sm text-[var(--color-fg)]"
        >
          {state.error}
        </p>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor="email" className={label}>
            {style.label} email<span className="ml-0.5 text-[var(--color-brand)]">*</span>
          </label>
          <input
            id="email"
            name="email"
            type="email"
            defaultValue={login?.email ?? ""}
            required
            autoComplete="off"
            className={field}
          />
          <p className="mt-1 text-[11px] text-[var(--color-muted)]">
            The address you sign in to {style.label} with.
          </p>
        </div>
        <div>
          <label htmlFor="accountPassword" className={label}>
            Password
            {!isEdit && <span className="ml-0.5 text-[var(--color-brand)]">*</span>}
          </label>
          <input
            id="accountPassword"
            name="accountPassword"
            type="password"
            placeholder={isEdit ? "•••••••• (unchanged)" : ""}
            required={!isEdit}
            // Browsers and password managers should not be storing these for us.
            autoComplete="off"
            className={field}
          />
          <p className="mt-1 text-[11px] text-[var(--color-muted)]">
            {isEdit
              ? "Leave blank to keep the current password."
              : "Encrypted on save and never shown back to you."}
          </p>
        </div>

        {/* Only where the retailer asks for one at checkout. The save action checks the
            same flag, because a field the form omits is still a field a POST can carry. */}
        {wantsCvv && (
          <div>
            <label htmlFor="cardCvv" className={label}>
              Card security code
              {/* Required to create, optional to edit -- exactly like the password above,
                  and for the same reason: a blank field on an edit means "keep it". */}
              {!isEdit && <span className="ml-0.5 text-[var(--color-brand)]">*</span>}
            </label>
            <input
              id="cardCvv"
              name="cardCvv"
              type="password"
              inputMode="numeric"
              // 4 rather than 3: Amex codes are four digits, and there is no card number
              // here to tell us which kind this is. See isPlausibleCvv.
              maxLength={4}
              pattern="\d{3,4}"
              title="Three digits, or four on American Express."
              placeholder={isEdit && hasCvv ? "••• (unchanged)" : ""}
              required={!isEdit}
              autoComplete="off"
              className={field}
            />
            <p className="mt-1 text-[11px] text-[var(--color-muted)]">
              {isEdit
                ? hasCvv
                  ? "Leave blank to keep the current code."
                  : "No code on file yet — add it so an order never stalls."
                : "3 digits on the back of the card — 4 on the front for Amex."}
            </p>
          </div>
        )}
      </div>

      {wantsCvv && !isEdit && (
        /* WHY a checkout site is asking for a CVV and nothing else about the card. Without
           this the field reads as an oversight or worse -- it is the one part of the card
           the member's own saved payment method cannot hand over at the prompt. */
        <p className="rounded-lg border border-[var(--color-edge)] bg-[var(--color-surface)] px-3 py-2 text-xs text-[var(--color-muted)]">
          {style.label} asks for the security code at checkout even when the card is already saved
          to your account. It&rsquo;s the only card detail we keep for {style.label} — no number, no
          expiry — and like your password it&rsquo;s encrypted on save and can never be shown back
          to you.
        </p>
      )}

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="inline-flex min-h-11 items-center rounded-lg bg-[var(--color-brand)] px-5 py-2.5 text-sm font-semibold text-[var(--color-on-brand)] transition-colors hover:bg-[var(--color-brand-dark)] disabled:opacity-60 sm:min-h-0"
        >
          {pending ? "Saving…" : isEdit ? "Save changes" : "Add login"}
        </button>
        <button
          type="button"
          onClick={onDone}
          className="inline-flex min-h-11 items-center text-sm text-[var(--color-muted)] transition-colors hover:text-[var(--color-fg)] sm:min-h-0"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

/** Enable / disable, same pill and same 44px touch target as the profile list's toggle. */
function Toggle({ login }: { login: VaultLoginSummary }) {
  const [state, formAction, pending] = useActionState(
    async (_previous: ActionResult | null, formData: FormData) => setLoginActive(formData),
    null,
  );

  return (
    <form action={formAction} title={state && !state.ok ? state.error : undefined}>
      <input type="hidden" name="siteKey" value={login.siteKey} />
      <input type="hidden" name="loginId" value={login.id} />
      <input type="hidden" name="active" value={login.active ? "false" : "true"} />
      <button
        type="submit"
        disabled={pending}
        aria-label={login.active ? `Disable ${login.email}` : `Enable ${login.email}`}
        title={login.active ? "Disable for this site" : "Enable for this site"}
        className="-my-3 flex min-h-11 shrink-0 items-center disabled:opacity-50 sm:my-0 sm:min-h-0"
      >
        <span
          className={
            "relative block h-5 w-9 rounded-full transition-colors " +
            (login.active ? "bg-[var(--color-brand)]" : "bg-[var(--color-elevated)]")
          }
        >
          <span
            className={
              "absolute top-0.5 size-4 rounded-full bg-white transition-[left] " +
              (login.active ? "left-[1.125rem]" : "left-0.5")
            }
          />
        </span>
      </button>
    </form>
  );
}

/**
 * Remove, in two steps.
 *
 * Inline rather than behind a selection: with no bulk bar there is nowhere else to put it,
 * and a login is one row a member can retype -- unlike a profile, which takes a card and
 * an address with it.
 */
function Remove({ login }: { login: VaultLoginSummary }) {
  const [confirming, setConfirming] = useState(false);
  const [state, formAction, pending] = useActionState(
    async (_previous: ActionResult | null, formData: FormData) => deleteLogin(formData),
    null,
  );

  if (!confirming) {
    return (
      <button
        type="button"
        onClick={() => setConfirming(true)}
        className="-my-2 flex min-h-11 shrink-0 items-center self-center rounded-lg border border-[var(--color-edge)] px-3 text-sm font-medium text-[var(--color-muted)] transition-colors hover:text-[var(--color-brand)] sm:my-0 sm:min-h-0 sm:border-0 sm:px-0 sm:text-xs"
      >
        Remove
      </button>
    );
  }

  return (
    <form action={formAction} className="flex shrink-0 items-center gap-2 self-center">
      <input type="hidden" name="siteKey" value={login.siteKey} />
      <input type="hidden" name="loginId" value={login.id} />
      <span className="text-xs text-[var(--color-muted)]">
        {state && !state.ok ? state.error : "Remove it?"}
      </span>
      <button
        type="submit"
        disabled={pending}
        className="text-xs font-semibold text-[var(--color-brand)] disabled:opacity-60"
      >
        {pending ? "Removing…" : "Yes"}
      </button>
      <button
        type="button"
        onClick={() => setConfirming(false)}
        className="inline-flex min-h-11 items-center text-xs text-[var(--color-muted)] sm:min-h-0"
      >
        Cancel
      </button>
    </form>
  );
}

function LoginRow({ login, onEdit }: { login: VaultLoginSummary; onEdit: () => void }) {
  const style = siteStyle(login.siteKey);
  // Costco: nothing loads these anywhere, so a saved login is in use and there is no
  // confirmation step to wait on. See changesApplyImmediately in sites.ts.
  const immediate = siteChangesApplyImmediately(login.siteKey);
  const status = immediate
    ? "In use — nothing to confirm here."
    : login.pendingSince
      ? null
      : confirmedLabel(login.confirmedAt);
  // A gap only where the retailer asks for a code. A login on a site that never prompts
  // is not "missing" one, and flagging it would send the member to fix nothing.
  const needsCvv = siteStoresCardCvv(login.siteKey) && !login.hasCvv;

  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3.5 sm:px-5">
      <span className="flex shrink-0 items-center sm:h-5">
        <Toggle login={login} />
      </span>

      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1.5 text-sm font-semibold break-all text-white">
          <span className={login.active ? "" : "text-[var(--color-muted)] line-through"}>
            {login.email}
          </span>
          {/* A tick, with what it means in the tooltip. On a retailer we load onto a bot
              this is the profile list's pair -- amber while an edit is waiting, green once
              it's confirmed. Where changes apply immediately there is no waiting state to
              show, and an amber "pending confirmation" chip would promise a review step
              that does not exist. */}
          {status === null ? (
            <span
              title={`Edited ${relativeTime(login.pendingSince!)}. Until it's confirmed, we still hold the previous password.`}
              className="inline-flex min-h-6 items-center rounded-full bg-[var(--color-warn)]/15 px-2 py-1 text-[10px] leading-none font-medium tracking-wide text-[var(--color-warn)] uppercase"
            >
              Pending confirmation
            </span>
          ) : (
            <span
              title={status}
              aria-label={status}
              className="inline-flex items-center text-xs leading-none font-bold text-[var(--color-good)]"
            >
              ✓
            </span>
          )}
          {/* Brand red rather than amber, matching a profile's expired card: this login
              works right up until the checkout that asks for a code it hasn't got, and
              that checkout is placed by hand while a queue pass runs down. Only shown on
              a retailer that asks -- elsewhere there is nothing missing. */}
          {needsCvv && (
            <span
              title={`${style.label} asks for the card's security code at checkout. Add yours with Edit so an order never stalls.`}
              className="inline-flex min-h-6 items-center rounded-full bg-[var(--color-brand)]/15 px-2 py-1 text-[10px] leading-none font-medium tracking-wide text-[var(--color-fg)] uppercase"
            >
              No security code
            </span>
          )}
        </p>
        {/* Renders nothing at all on a retailer we never read a code for, which is every
            login-only one today -- the operator is at the login and can read a code with
            the member if Costco asks for one. See usesEmailCodes. */}
        <RevealAppPassword
          email={login.email}
          mailbox={login.mailbox}
          usesEmailCodes={style.usesEmailCodes !== false}
          action={revealOwnAppPassword}
          compact
        />
      </div>

      <button
        type="button"
        onClick={onEdit}
        className="-my-2 flex min-h-11 shrink-0 items-center self-center rounded-lg border border-[var(--color-edge)] px-3 text-sm font-medium text-[var(--color-fg)] transition-colors hover:text-white sm:my-0 sm:min-h-0 sm:border-0 sm:px-0 sm:text-xs"
      >
        Edit
      </button>
      <Remove login={login} />
    </li>
  );
}

export function LoginManager({
  siteKey,
  siteLogo,
  logins,
}: {
  siteKey: string;
  siteLogo: string | null;
  logins: VaultLoginSummary[];
}) {
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const style = siteStyle(siteKey);
  const activeCount = logins.filter((l) => l.active).length;
  // Counted over ACTIVE logins: a disabled one isn't being used, so it isn't a gap to
  // chase. Said once for the retailer, like the profile list's shared-card line -- the
  // per-row chip marks WHICH, this says why it matters.
  const missingCvv = siteStoresCardCvv(siteKey)
    ? logins.filter((l) => l.active && !l.hasCvv).length
    : 0;

  return (
    <section className="mt-10">
      <header className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
          <span
            className="inline-flex items-center gap-1.5 rounded-full py-1 pr-2.5 pl-1 text-[11px] font-medium text-[var(--color-fg)]"
            style={{
              backgroundColor: `color-mix(in oklab, ${style.tint} 14%, transparent)`,
              boxShadow: `inset 0 0 0 1px color-mix(in oklab, ${style.tint} 35%, transparent)`,
            }}
          >
            {siteLogo && (
              <span className="grid h-4 w-5 shrink-0 place-items-center overflow-hidden rounded-[3px]">
                <Image
                  src={siteLogo}
                  alt=""
                  width={style.width}
                  height={style.height}
                  sizes="40px"
                  className="h-3.5 w-full object-contain"
                />
              </span>
            )}
            {style.label}
          </span>
          <span className="text-sm text-[var(--color-muted)]">
            {activeCount} of {logins.length} active
          </span>
        </div>

        <button
          type="button"
          onClick={() => {
            setAdding((v) => !v);
            setEditing(null);
          }}
          className="inline-flex min-h-11 items-center rounded-lg border border-[var(--color-edge)] px-3 py-1.5 text-sm font-medium text-[var(--color-fg)] transition-colors hover:border-[var(--color-brand)]/50 sm:min-h-0"
        >
          {adding ? "Cancel" : "Add login"}
        </button>
      </header>

      {/* THE REQUIREMENT, said before the form rather than after a failed drop. We only
          hold the login here; the card and the address come from the account itself, so an
          account without them saved cannot be checked out with no matter what we do. */}
      <p className="mb-4 rounded-xl border border-[var(--color-warn)]/40 bg-[var(--color-warn)]/10 px-4 py-3 text-sm text-[var(--color-fg)]">
        <strong className="font-semibold">
          Save your card and shipping address in your {style.label} account.
        </strong>{" "}
        We take spots in the queue without signing in, then place the order from your account once a
        pass comes through — so whatever {style.label} has saved is what gets used. A login with no
        payment method or address on file can&rsquo;t be checked out with.
      </p>

      {missingCvv > 0 && (
        <p className="mb-4 px-1 text-xs text-[var(--color-muted)]">
          <span aria-hidden>⚠ </span>
          <span className="font-medium text-[var(--color-brand)]">{missingCvv}</span> of these
          logins {missingCvv === 1 ? "has" : "have"} no card security code saved. {style.label} asks
          for it at checkout even on a saved card, so{" "}
          {missingCvv === 1 ? "that order" : "those orders"} can stall — add it with{" "}
          <span className="font-medium text-[var(--color-fg)]">Edit</span>.
        </p>
      )}

      {adding && (
        <div className="mb-4 rounded-xl border border-[var(--color-edge)] bg-[var(--color-surface)] p-5">
          <LoginForm siteKey={siteKey} onDone={() => setAdding(false)} />
        </div>
      )}

      {logins.length === 0 ? (
        <p className="rounded-xl border border-[var(--color-edge)] bg-[var(--color-surface)] px-5 py-10 text-center text-sm text-[var(--color-muted)]">
          No {style.label} logins yet.
        </p>
      ) : (
        <ul className="divide-y divide-[var(--color-edge)] overflow-hidden rounded-xl border border-[var(--color-edge)] bg-[var(--color-surface)]">
          {logins.map((login) =>
            editing === login.id ? (
              <li key={login.id} className="px-4 py-4 sm:px-5">
                <p className="mb-4 text-sm font-semibold break-all text-white">
                  Editing {login.email}
                </p>
                <LoginForm siteKey={siteKey} login={login} onDone={() => setEditing(null)} />
              </li>
            ) : (
              <LoginRow
                key={login.id}
                login={login}
                onEdit={() => {
                  setEditing(login.id);
                  setAdding(false);
                }}
              />
            ),
          )}
        </ul>
      )}
    </section>
  );
}

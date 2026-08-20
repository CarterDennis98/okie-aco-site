"use client";

import { useActionState, useState } from "react";
import type { EmailCredentialSummary } from "@/db/queries/vault";
import { EMAIL_PROVIDERS } from "@/lib/vault/email-providers";
import {
  deleteEmailAlias,
  deleteEmailCredential,
  saveEmailAlias,
  saveEmailCredential,
  type ActionResult,
} from "@/lib/vault/actions";

/**
 * Email app passwords, for reading checkout verification codes over IMAP.
 *
 * An app password is a provider-issued, revocable credential scoped to one application
 * — not the member's real password. That distinction is the whole reason this is
 * acceptable to ask for, so the copy says it plainly rather than burying it.
 *
 * The stored password is shown only through an explicit, audited reveal; the list itself
 * carries the address and whether it last worked, never the value.
 *
 * FORWARDING is the second half of this section. Ten retailer accounts whose mail all
 * lands in one Gmail need one app password between them, so an address can either hold a
 * password of its own or point at the mailbox it forwards into. The list below shows
 * both, because "why does that address have no password" is otherwise a mystery.
 */

const field =
  "w-full rounded-lg border border-[var(--color-edge)] bg-[var(--color-ink)] px-3 py-2 text-base sm:text-sm text-[var(--color-fg)] placeholder:text-[var(--color-muted)]/60 focus:border-[var(--color-brand)] focus:outline-none";

function AppPasswordGuide() {
  return (
    <details className="group mt-3 rounded-lg border border-[var(--color-edge)] bg-[var(--color-surface)] p-4">
      <summary className="inline-flex min-h-11 list-none items-center gap-1.5 text-sm font-medium text-[var(--color-fg)] sm:min-h-0">
        <span aria-hidden className="transition-transform group-open:rotate-90">
          ›
        </span>
        How do I get an app password?
      </summary>

      <div className="mt-3 flex flex-col gap-3 text-sm text-[var(--color-muted)]">
        <p>
          An app password is a one-off code your email provider generates for a single application.
          It is <strong className="text-[var(--color-fg)]">not</strong> your real password, it only
          works for mail access, and you can revoke it at any time without changing anything else
          about your account.
        </p>
        <ul className="flex flex-col gap-2">
          {EMAIL_PROVIDERS.map((provider) => (
            <li
              key={provider.key}
              className="rounded-md border border-[var(--color-edge)] px-3 py-2"
            >
              <a
                href={provider.setupUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex min-h-11 items-center text-sm font-medium text-[var(--color-fg)] underline decoration-[var(--color-edge)] underline-offset-2 transition-colors hover:decoration-[var(--color-brand)] sm:min-h-0"
              >
                {provider.label} app passwords ↗
              </a>
              <p className="mt-0.5 text-xs">
                {provider.domains.join(", ")}
                {provider.caveat && (
                  <span className="ml-1 text-[var(--color-warn)]">· {provider.caveat}</span>
                )}
              </p>
            </li>
          ))}
        </ul>

        <p className="text-xs">
          Using a work address or your own domain? We can&rsquo;t read those directly. Set it to
          forward into one of the inboxes above, add that inbox here, then point the address at it
          with &ldquo;Forwards to&rdquo;.
        </p>
      </div>
    </details>
  );
}

function RemoveCredential({ id }: { id: string }) {
  const [state, formAction, pending] = useActionState(
    async (_previous: ActionResult | null, formData: FormData) => deleteEmailCredential(formData),
    null,
  );

  return (
    // `contents` so the button itself is the flex child. Wrapped in a form element it
    // formed its own block box and sat on a different line from the plain button beside
    // it, which is what made "Replace" and "Remove" look misaligned.
    <form action={formAction} className="contents">
      <input type="hidden" name="credentialId" value={id} />
      <button
        type="submit"
        disabled={pending}
        title={state && !state.ok ? state.error : undefined}
        className="inline-flex min-h-11 items-center text-sm text-[var(--color-muted)] transition-colors hover:text-[var(--color-brand)] disabled:opacity-60 sm:min-h-0 sm:text-xs"
      >
        Remove
      </button>
    </form>
  );
}

function RemoveAlias({ id, alias }: { id: string; alias: string }) {
  const [state, formAction, pending] = useActionState(
    async (_previous: ActionResult | null, formData: FormData) => deleteEmailAlias(formData),
    null,
  );

  return (
    <form action={formAction} className="contents">
      <input type="hidden" name="aliasId" value={id} />
      {/* The glyph is 8px wide; the button is not. A negative margin keeps the pill its
          original size while the hit area extends past it, which is the difference
          between "tap the ×" working on a phone and not. */}
      <button
        type="submit"
        disabled={pending}
        aria-label={`Stop forwarding ${alias}`}
        title={state && !state.ok ? state.error : "No longer forwards here"}
        className="-my-2 -mr-1.5 inline-flex min-h-9 min-w-9 shrink-0 items-center justify-center text-[var(--color-muted)] transition-colors hover:text-[var(--color-brand)] disabled:opacity-60"
      >
        ×
      </button>
    </form>
  );
}

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

/**
 * The addresses forwarding into one mailbox.
 *
 * Capped at VISIBLE_ALIASES because a member who routes twenty retailer accounts through
 * one Gmail turned this row into a wall of chips taller than the rest of the section.
 * The rest are one click away rather than hidden.
 */
const VISIBLE_ALIASES = 5;

function AliasChips({ aliases }: { aliases: { id: string; email: string }[] }) {
  const [expanded, setExpanded] = useState(false);
  if (aliases.length === 0) return null;

  const shown = expanded ? aliases : aliases.slice(0, VISIBLE_ALIASES);
  const hidden = aliases.length - shown.length;

  return (
    <ul className="mt-1.5 flex flex-wrap items-center gap-1.5">
      {shown.map((alias) => (
        // max-w-full and a truncating address: these are single unbreakable tokens, and a
        // long one sized this pill wider than a phone screen -- which, on a flex-item
        // <main>, took the whole page's layout with it.
        <li
          key={alias.id}
          className="inline-flex max-w-full min-w-0 items-center gap-1.5 rounded-full bg-[var(--color-elevated)] py-1 pr-1.5 pl-2 text-[11px] leading-none text-[var(--color-muted)]"
        >
          <span aria-hidden>↳</span>
          <span className="min-w-0 truncate text-[var(--color-fg)]">{alias.email}</span>
          <RemoveAlias id={alias.id} alias={alias.email} />
        </li>
      ))}
      {(hidden > 0 || expanded) && (
        <li>
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="inline-flex min-h-11 items-center rounded-full px-2 py-1 text-[11px] leading-none font-medium text-[var(--color-muted)] underline underline-offset-2 transition-colors hover:text-[var(--color-fg)] sm:min-h-0"
          >
            {expanded ? "Show fewer" : `Show ${hidden} more`}
          </button>
        </li>
      )}
    </ul>
  );
}

export function EmailCredentials({
  credentials,
  needingPassword,
}: {
  credentials: EmailCredentialSummary[];
  needingPassword: string[];
}) {
  const [adding, setAdding] = useState<string | null>(null);

  const [state, formAction, pending] = useActionState(
    async (_previous: ActionResult | null, formData: FormData) => {
      const result = await saveEmailCredential(formData);
      if (result.ok) setAdding(null);
      return result;
    },
    null,
  );

  return (
    <section className="mt-12">
      <h2 className="mb-2 flex items-center gap-2.5 text-xl font-bold tracking-tight">
        <span aria-hidden className="h-5 w-1 rounded-full bg-[var(--color-brand)]" />
        Email app passwords
      </h2>
      <p className="mb-4 max-w-2xl text-sm text-[var(--color-muted)]">
        Retailers send a verification code to your email during login. With an app password saved,
        we can read that code automatically instead of messaging you mid-drop.
      </p>

      {state && !state.ok && (
        <p
          role="alert"
          className="mb-4 rounded-lg border border-[var(--color-brand)]/40 bg-[var(--color-brand)]/10 px-3 py-2 text-sm text-[var(--color-fg)]"
        >
          {state.error}
        </p>
      )}

      {credentials.length > 0 && (
        <ul className="divide-y divide-[var(--color-edge)] overflow-hidden rounded-xl border border-[var(--color-edge)] bg-[var(--color-surface)]">
          {credentials.map((credential) => (
            <li key={credential.id} className="flex items-start gap-4 px-4 py-3 sm:px-5">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm text-[var(--color-fg)]">{credential.email}</p>
                <p className="mt-0.5 text-xs text-[var(--color-muted)]">
                  {credential.lastError
                    ? `Last check failed — re-enter the app password`
                    : credential.verifiedAt
                      ? "Working"
                      : "Saved, not yet checked"}
                  {credential.aliases.length > 0 &&
                    ` · covers ${credential.aliases.length} forwarded address${
                      credential.aliases.length === 1 ? "" : "es"
                    }`}
                </p>
                <AliasChips aliases={credential.aliases} />
              </div>
              {/* One row, fixed height, matching the email line above it -- so both
                  controls share a baseline no matter how many chips are below. */}
              <span className="flex shrink-0 items-center gap-4 sm:h-5">
                <button
                  type="button"
                  onClick={() => setAdding(credential.email)}
                  className="inline-flex min-h-11 items-center text-sm font-medium text-[var(--color-fg)] transition-colors hover:text-white sm:min-h-0 sm:text-xs"
                >
                  Replace
                </button>
                <RemoveCredential id={credential.id} />
              </span>
            </li>
          ))}
        </ul>
      )}

      {needingPassword.length > 0 && (
        <div className="mt-4">
          <p className="mb-2 text-xs text-[var(--color-muted)]">
            <span className="text-[var(--color-fg)]">{needingPassword.length}</span> address
            {needingPassword.length === 1 ? " has" : "es have"} nowhere to read a code from. Give
            each one its own app password, or — if its mail lands in an inbox you have already added
            — point it there instead.
          </p>
          {/* Scrolls rather than running the page long: a member can have dozens of these. */}
          <ul className="max-h-64 divide-y divide-[var(--color-edge)] overflow-y-auto overscroll-contain rounded-xl border border-[var(--color-edge)] bg-[var(--color-surface)]">
            {needingPassword.map((email) => (
              <li
                key={email}
                className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5 sm:px-5"
              >
                <span className="min-w-0 flex-1 truncate text-sm text-[var(--color-fg)]">
                  {email}
                </span>
                {credentials.length > 0 && (
                  <ForwardPicker email={email} credentials={credentials} />
                )}
                <button
                  type="button"
                  onClick={() => setAdding(email)}
                  className="inline-flex min-h-11 items-center text-sm font-medium text-[var(--color-fg)] transition-colors hover:text-white sm:min-h-0 sm:text-xs"
                >
                  Add password
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {adding === null ? (
        <button
          type="button"
          onClick={() => setAdding("")}
          className="mt-4 inline-flex min-h-11 items-center rounded-lg border border-[var(--color-edge)] px-3 py-1.5 text-sm font-medium text-[var(--color-fg)] transition-colors hover:border-[var(--color-brand)]/50 sm:min-h-0"
        >
          Add an app password
        </button>
      ) : (
        <form
          action={formAction}
          className="mt-4 flex flex-wrap items-end gap-3 rounded-xl border border-[var(--color-edge)] bg-[var(--color-surface)] p-4"
        >
          <div className="min-w-56 flex-1">
            <label
              htmlFor="credEmail"
              className="mb-1 block text-xs font-medium text-[var(--color-muted)]"
            >
              Email address
            </label>
            <input
              id="credEmail"
              name="email"
              type="email"
              defaultValue={adding}
              readOnly={adding !== ""}
              required
              autoComplete="off"
              className={field}
            />
          </div>
          <div className="min-w-56 flex-1">
            <label
              htmlFor="appPassword"
              className="mb-1 block text-xs font-medium text-[var(--color-muted)]"
            >
              App password
            </label>
            <input
              id="appPassword"
              name="appPassword"
              type="password"
              required
              autoComplete="off"
              placeholder="xxxx xxxx xxxx xxxx"
              className={field}
            />
          </div>
          <div className="flex items-center gap-3">
            <button
              type="submit"
              disabled={pending}
              className="inline-flex min-h-11 items-center rounded-lg bg-[var(--color-brand)] px-4 py-2 text-sm font-semibold text-[var(--color-on-brand)] transition-colors hover:bg-[var(--color-brand-dark)] disabled:opacity-60 sm:min-h-0"
            >
              {pending ? "Saving…" : "Save"}
            </button>
            <button
              type="button"
              onClick={() => setAdding(null)}
              className="inline-flex min-h-11 items-center text-sm text-[var(--color-muted)] hover:text-[var(--color-fg)] sm:min-h-0"
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      <AppPasswordGuide />
    </section>
  );
}

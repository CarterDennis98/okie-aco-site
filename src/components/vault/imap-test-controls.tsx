"use client";

import { useActionState } from "react";
import { sweepEmailCredentials, testEmailCredentialForAdmin } from "@/lib/vault/admin-actions";
import type { ImapTestOutcome } from "@/lib/vault/imap-test";
import type { SweepResult } from "@/lib/vault/admin-actions";

/**
 * The operator's half of the app-password checker.
 *
 * Two controls, deliberately separate. `TestMailbox` answers "is THIS one broken" from the
 * row you are already looking at; `SweepMailboxes` answers "whose codes are going to fail
 * tonight", which is the question at 8pm on drop night and is not answerable by clicking
 * sixty buttons.
 *
 * Neither decrypts anything into the page. The password exists only inside the IMAP login
 * on the server -- unlike a reveal, there is nothing here to audit, because nothing comes
 * back but a verdict.
 */

/**
 * The result, as a glyph and a word.
 *
 * THREE STATES, NOT TWO. A tick and a cross are the credential passing or failing, but a
 * cooldown and an unreachable mail server are neither -- they get muted text and no glyph,
 * because a red cross beside "Unreachable" reads as "your password is wrong" and sends
 * somebody off to regenerate a credential that was fine. `verdict` carries that from the
 * server rather than being guessed from `ok`.
 *
 * The full sentence moves to `title` and `aria-label`: it is what you want ONCE, and
 * rendering it inline pushed every control on the row sideways as results came in.
 */
function TestResult({ state }: { state: ImapTestOutcome }) {
  const tone = !state.verdict
    ? "text-[var(--color-muted)]"
    : state.ok
      ? "text-[var(--color-good)]"
      : "text-[var(--color-brand)]";

  return (
    <span
      role="status"
      title={state.message}
      aria-label={state.message}
      className={`inline-flex items-center gap-1 text-[11px] font-medium ${tone}`}
    >
      {state.verdict && <span aria-hidden>{state.ok ? "✓" : "✗"}</span>}
      {state.label}
    </span>
  );
}

/**
 * A fixed slot for the result, so nothing moves.
 *
 * Rendered whether or not there is a result: appearing from nothing is what made the row
 * reflow, and reserving the width means the button beside it never shifts under the cursor.
 * It sits BEFORE the button and right-aligns into it, so the button itself stays flush with
 * the controls above it and the label grows leftwards into space that was already spoken for.
 */
const RESULT_SLOT = "inline-flex min-w-[5.5rem] items-center justify-end";

/**
 * FILLED, not tinted. It stands out by being the only solid control in the row rather than
 * by carrying a hue.
 *
 * The first version wore a brand tint, and `--color-brand` is #e30613 -- so a button whose
 * whole job is "check this" read as an error before it had been pressed. Red in this palette
 * means brand or danger; it belongs on the ✗ below, not on the affordance above it.
 *
 * Metrics deliberately copied from the reveal button it sits beside on /admin/imap --
 * `px-3 py-1 text-[11px]`, `min-h-11` collapsing to `sm:min-h-0` -- so the two are the same
 * height on the same line. Change one and change the other.
 *
 * Fixed width because "Checking…" is wider than "Test", and a button that grows the instant
 * it is pressed moves out from under the pointer.
 */
const TEST_BUTTON =
  "inline-flex min-h-11 w-[5rem] shrink-0 items-center justify-center rounded-lg " +
  "border border-[var(--color-edge)] bg-[var(--color-elevated)] px-3 py-1 " +
  "text-[11px] font-semibold text-[var(--color-fg)] transition-colors " +
  "hover:border-[var(--color-brand)]/50 hover:text-white " +
  "disabled:opacity-50 sm:min-h-0 sm:px-2";

/**
 * Check one mailbox against its mail server.
 *
 * One component for both surfaces, with the action passed in -- the member's page hands it
 * `testOwnEmailCredential` and the operator's hands it `testEmailCredentialForAdmin`. Server
 * actions cross the boundary as props; `RevealAppPassword` beside it does the same thing.
 */
export function TestButton({
  email,
  action,
}: {
  email: string;
  action: (form: FormData) => Promise<ImapTestOutcome>;
}) {
  const [state, formAction, pending] = useActionState(
    async (_previous: ImapTestOutcome | null, formData: FormData) => action(formData),
    null,
  );

  return (
    <form action={formAction} className="flex items-center justify-end gap-2">
      <input type="hidden" name="email" value={email} />
      <span className={RESULT_SLOT}>{state && !pending && <TestResult state={state} />}</span>
      <button type="submit" disabled={pending} className={TEST_BUTTON}>
        {pending ? "Checking…" : "Test"}
      </button>
    </form>
  );
}

/**
 * Check every mailbox on file, or one member's.
 *
 * SLOW ON PURPOSE -- the action pauses between mailboxes, so a full sweep of sixty takes
 * the better part of a minute. Saying so up front is the difference between "it's working"
 * and "it's hung".
 */
export function SweepMailboxes({
  discordUserId,
  total,
}: {
  discordUserId?: string;
  total: number;
}) {
  const [state, formAction, pending] = useActionState(
    async (_previous: SweepResult | null, formData: FormData) => sweepEmailCredentials(formData),
    null,
  );

  return (
    <form action={formAction} className="flex flex-wrap items-center gap-x-3 gap-y-1">
      {discordUserId && <input type="hidden" name="discordUserId" value={discordUserId} />}
      <button
        type="submit"
        disabled={pending}
        className="inline-flex min-h-11 items-center rounded-lg border border-[var(--color-edge)] px-3 py-1.5 text-sm font-medium text-[var(--color-fg)] transition-colors hover:border-[var(--color-brand)]/50 disabled:opacity-60 sm:min-h-0"
      >
        {pending ? "Checking…" : `Test all ${total}`}
      </button>

      {pending && (
        <span className="text-xs text-[var(--color-muted)]">
          One at a time, with a pause between each — this takes a while on purpose, so the
          providers don&rsquo;t start throttling us before the drop.
        </span>
      )}

      {state && !pending && (
        <span role="status" className="text-xs text-[var(--color-muted)]">
          {!state.ok ? (
            state.error
          ) : (
            <>
              <span className="font-semibold text-[var(--color-good)]">{state.passed} working</span>
              {state.failed.length > 0 && (
                <>
                  {" · "}
                  <span className="font-semibold text-[var(--color-warn)]">
                    {state.failed.length} failing
                  </span>
                  {`: ${state.failed.slice(0, 5).join(", ")}`}
                  {state.failed.length > 5 && ` and ${state.failed.length - 5} more`}
                </>
              )}
              {/* Counted apart from the failures: a mail server we couldn't reach says
                  nothing about the password, and listing it as broken would send the
                  operator chasing a member whose credential is fine. */}
              {state.unreachable > 0 && ` · ${state.unreachable} unreachable`}
              {state.skipped > 0 && ` · ${state.skipped} checked too recently`}
            </>
          )}
        </span>
      )}
    </form>
  );
}

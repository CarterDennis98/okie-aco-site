"use client";

import { useActionState, useState } from "react";
import { assignProfiles, type AssignResult } from "@/lib/vault/assign-actions";

/**
 * Who runs one profile or login, with the control to move it -- full admins only, since
 * the page renders this for nobody else and `assignProfiles` refuses anybody else anyway.
 *
 * TWO STEPS, never a move on change: picking a name only arms the Move button. A select
 * that moved on change would send a member's card to the wrong bot on a mis-scroll, and the
 * pair of changes that writes lands in two runners' queues.
 */

export type RunnerOption = { id: string; name: string };

const control =
  "rounded-lg border border-[var(--color-edge)] bg-[var(--color-ink)] px-2 py-1 text-xs text-[var(--color-fg)] focus:border-[var(--color-brand)] focus:outline-none";

export function RunnerSelect({
  siteKey,
  accountId,
  current,
  runners,
  names,
}: {
  siteKey: string;
  accountId: string;
  /** Who holds it now. */
  current: string;
  /** Everyone who may hold profiles on this retailer, the operator first. */
  runners: RunnerOption[];
  names: Record<string, string>;
}) {
  const [choice, setChoice] = useState(current);
  const [state, action, pending] = useActionState(
    async (_previous: AssignResult | null, form: FormData) => assignProfiles(form),
    null,
  );

  // Someone who has since lost the role still holds what they held until it is moved, so
  // they stay listed -- as the current value, flagged -- rather than the select silently
  // showing the first runner instead.
  const listed = runners.some((r) => r.id === current)
    ? runners
    : [{ id: current, name: `${names[current] ?? current} (not a runner)` }, ...runners];

  return (
    <form action={action} className="flex flex-wrap items-center gap-1.5">
      <input type="hidden" name="siteKey" value={siteKey} />
      <input type="hidden" name="accountId" value={accountId} />
      <select
        name="assigneeId"
        value={choice}
        onChange={(event) => setChoice(event.currentTarget.value)}
        aria-label="Runner"
        disabled={pending}
        className={control}
      >
        {listed.map((runner) => (
          <option key={runner.id} value={runner.id}>
            {runner.name}
          </option>
        ))}
      </select>
      {choice !== current && (
        <button
          type="submit"
          disabled={pending}
          className="inline-flex min-h-11 items-center rounded-lg border border-[var(--color-brand)]/60 px-2.5 py-1 text-xs font-medium text-white transition-colors hover:bg-[var(--color-brand)]/10 disabled:opacity-60 sm:min-h-0"
        >
          {pending ? "Moving…" : "Move"}
        </button>
      )}
      {state && !state.ok && (
        <span role="alert" className="text-[11px] text-[var(--color-warn)]">
          {state.error}
        </span>
      )}
    </form>
  );
}

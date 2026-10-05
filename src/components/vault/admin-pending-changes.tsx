"use client";

import Link from "next/link";
import { useActionState, useEffect, useState, useTransition } from "react";
import type { PendingChangeGroup, PendingChangeRow } from "@/db/queries/admin-vault";
import { CHANGE_FILTER_PARAM, EMAIL_BUCKET } from "@/lib/vault/pending-filter";
import { relativeTime } from "@/lib/format";
import { confirmAllPendingChanges, markChangesApplied } from "@/lib/vault/site-admin-actions";

/**
 * Edits members have made that nobody has confirmed yet.
 *
 * The operator half of the pair described on `VaultChange.appliedAt`, and the same shape as
 * the payment queue: a member can only report, and only the operator can confirm. Confirming
 * these turns the amber "Pending confirmation" tag on the member's own profiles page into a
 * green tick, which is the whole reason the queue exists -- people were asking in the channel
 * whether their new card had taken effect.
 *
 * ONE ROW AT A TIME by default. Confirming is a claim that a specific edit is live, and the
 * column never unsets, so there is no undo. The exception is "Confirm all" on ONE
 * retailer's tab, for after its whole export is loaded -- and it takes two clicks, the
 * second deliberately slower than a double-click, so a stray one never confirms a queue.
 * Never on "All": a bot is loaded one retailer at a time, and so is confirmed one at a time.
 * The server holds the same line -- see confirmAllPendingChanges.
 *
 * The retailer chips FILTER the queue rather than acting on it -- same shape and behaviour
 * as the charges page's filter tabs. They live in the URL, so a filtered queue can be linked
 * and survives a reload.
 *
 * MOVES BETWEEN RUNNERS are the one exception to one-row-one-confirm. A full admin moving
 * forty profiles writes forty rows into each runner's queue, all stamped with the same
 * instant, and they are shown -- and confirmed -- as the single move they were: "take these
 * forty off your bot", once. Nothing about them reaches a member's page, so confirming a
 * move tells no member anything; it only clears the runner's own to-do.
 */

const ACTION_VERB: Record<string, string> = {
  CREATE: "added",
  UPDATE: "updated",
  DELETE: "removed",
  ACTIVATE: "enabled",
  DEACTIVATE: "disabled",
};

/** One line of the queue: a single change, or every row of one move between runners. */
type Entry =
  | { kind: "change"; row: PendingChangeRow }
  | { kind: "move"; key: string; rows: PendingChangeRow[] };

/**
 * Folds each move's rows into one entry, where its first row fell in the list.
 *
 * Keyed on everything one move shares -- direction, who did it, whose bot, which retailer,
 * and the instant it was stamped -- so two moves made a minute apart stay two lines.
 */
function entriesOf(rows: PendingChangeRow[]): Entry[] {
  const entries: Entry[] = [];
  const moves = new Map<string, Extract<Entry, { kind: "move" }>>();
  for (const row of rows) {
    if (row.action !== "ASSIGN" && row.action !== "UNASSIGN") {
      entries.push({ kind: "change", row });
      continue;
    }
    const key = [row.action, row.actorDiscordId, row.assigneeId, row.siteKey, +row.at].join("|");
    let move = moves.get(key);
    if (!move) {
      move = { kind: "move", key, rows: [] };
      moves.set(key, move);
      entries.push(move);
    }
    move.rows.push(row);
  }
  return entries;
}

const ENTITY_NOUN: Record<string, string> = {
  VAULT_PROFILE: "profile",
  VAULT_ACCOUNT: "account",
  EMAIL_CREDENTIAL: "app password",
  EMAIL_ALIAS: "forwarding",
};

/** One retailer tab. Same shape as the charges page's filters, for the same reason. */
function FilterTab({
  href,
  label,
  count,
  active,
}: {
  href: string;
  label: string;
  count: number;
  active: boolean;
}) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      // Same rule as every other control on this page: filtering something must not move
      // the page under you. The queue has its own scroll pane, so the row you were
      // reading is where you left it.
      scroll={false}
      className={
        "inline-flex min-h-11 items-center rounded-lg border px-2.5 py-1 text-xs font-medium transition-colors sm:min-h-0 " +
        (active
          ? "border-[var(--color-brand)] bg-[var(--color-brand)]/10 text-white"
          : "border-[var(--color-edge)] text-[var(--color-muted)] hover:text-[var(--color-fg)]")
      }
    >
      {label}
      <span className={"ml-1.5 " + (active ? "text-[var(--color-muted)]" : "")}>{count}</span>
    </Link>
  );
}

/**
 * Confirms exactly the changes it lists: one edit, or every row of one move. There is no
 * "confirm everything" variant -- see the note on the section.
 */
function ConfirmButton({ changeIds, label = "Confirm" }: { changeIds: string[]; label?: string }) {
  const [state, formAction, pending] = useActionState(
    async (_previous: Awaited<ReturnType<typeof markChangesApplied>> | null, formData: FormData) =>
      markChangesApplied(formData),
    null,
  );

  return (
    <form action={formAction} className="contents">
      {changeIds.map((id) => (
        <input key={id} type="hidden" name="changeId" value={id} />
      ))}
      <button
        type="submit"
        disabled={pending}
        title={state && !state.ok ? state.error : undefined}
        className="inline-flex min-h-11 shrink-0 items-center rounded-lg border border-[var(--color-edge)] px-3 py-1.5 text-xs font-medium text-[var(--color-fg)] transition-colors hover:border-[var(--color-brand)]/50 disabled:opacity-60 sm:min-h-0"
      >
        {pending ? "Confirming…" : label}
      </button>
      {state && !state.ok && (
        <span role="alert" className="text-[11px] text-[var(--color-warn)]">
          {state.error}
        </span>
      )}
    </form>
  );
}

/** How long the armed state waits for the second click, and how soon it may come. */
const ARMED_MS = 6000;
const DOUBLE_CLICK_MS = 400;

/**
 * "Confirm all N" for one tab. The first click only arms it -- it turns amber and says what a
 * second click will do -- and a second click inside a few seconds confirms. A second click
 * faster than a double-click is ignored: two clicks in one gesture are one click.
 */
function ConfirmAllButton({
  bucket,
  label,
  count,
  seenAt,
  runner,
}: {
  bucket: string;
  label: string;
  count: number;
  seenAt: string;
  runner: string | null;
}) {
  const [armedAt, setArmedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    if (armedAt === null) return;
    const timer = setTimeout(() => setArmedAt(null), ARMED_MS);
    return () => clearTimeout(timer);
  }, [armedAt]);

  function click() {
    const now = Date.now();
    if (armedAt === null) {
      setError(null);
      setArmedAt(now);
      return;
    }
    if (now - armedAt < DOUBLE_CLICK_MS) return;
    setArmedAt(null);
    const form = new FormData();
    form.set("bucket", bucket);
    form.set("seenAt", seenAt);
    form.set("expected", String(count));
    if (runner) form.set("runner", runner);
    startTransition(async () => {
      const result = await confirmAllPendingChanges(form);
      if (!result.ok) setError(result.error);
    });
  }

  const armed = armedAt !== null;
  return (
    <span className="ml-auto inline-flex flex-wrap items-center gap-2">
      <button
        type="button"
        onClick={click}
        // Leaving the button disarms it: an armed button left behind is a trap for later.
        onBlur={() => setArmedAt(null)}
        onKeyDown={(event) => event.key === "Escape" && setArmedAt(null)}
        disabled={pending}
        aria-describedby={armed ? `${bucket}-confirm-all-hint` : undefined}
        className={
          "inline-flex min-h-11 items-center rounded-lg border px-3 text-xs font-semibold transition-colors disabled:opacity-60 sm:min-h-0 sm:py-1 " +
          (armed
            ? "border-[var(--color-warn)] bg-[var(--color-warn)]/15 text-[var(--color-warn)]"
            : "border-[var(--color-edge)] text-[var(--color-fg)] hover:border-[var(--color-brand)]/50")
        }
      >
        {pending
          ? "Confirming…"
          : armed
            ? `Click again to confirm all ${count}`
            : `Confirm all ${count} ${label} change${count === 1 ? "" : "s"}`}
      </button>
      <span id={`${bucket}-confirm-all-hint`} role="status" className="sr-only">
        {armed ? `Click again to confirm all ${count} ${label} changes. There is no undo.` : ""}
      </span>
      {error && (
        <span role="alert" className="text-[11px] text-[var(--color-warn)]">
          {error}
        </span>
      )}
    </span>
  );
}

export function AdminPendingChanges({
  rows,
  groups,
  total,
  active,
  shown,
  siteKey,
  memberId,
  extraParams,
  viewerId,
  runnerNames,
  seenAt,
  runner,
}: {
  rows: PendingChangeRow[];
  groups: PendingChangeGroup[];
  total: number;
  /** The bucket in effect, or null for everything. */
  active: string | null;
  /** How many are in the active bucket. Equals `total` when nothing is filtered. */
  shown: number;
  /**
   * The page's current site and member, carried into every filter link.
   *
   * Passed as PLAIN STRINGS rather than an href-builder callback: a function cannot cross
   * the server/client boundary, and TypeScript does not model that -- it type-checks
   * cleanly and then throws "Functions cannot be passed directly to Client Components" at
   * render. Building the URL here keeps the only thing crossing the boundary serializable.
   *
   * Carried deliberately: the queue sits above the profile table, so filtering the queue
   * must not reset which retailer or member is open below it.
   */
  siteKey: string;
  memberId: string | null;
  /**
   * The page's other query params -- the profile search, the active/inactive filter, and
   * whose profiles are showing.
   *
   * A plain object for the same reason siteKey is a string: it has to cross the
   * server/client boundary, so it must be serializable. Carried for the same reason as
   * the member id -- filtering the queue must not clear the search below it.
   */
  extraParams?: Record<string, string>;
  /** Who is looking, so their own bot reads as "you" and anyone else's is named. */
  viewerId: string;
  /** Runner id -> name, for the changes that belong on somebody else's bot. */
  runnerNames: Record<string, string>;
  /** When the page was drawn: "Confirm all" covers nothing made after it. ISO, to cross the boundary. */
  seenAt: string;
  /** Whose queue a full admin has open (`?runner=`), so "Confirm all" covers that same one. */
  runner: string | null;
}) {
  const hrefFor = (bucket: string | null) => {
    const params = new URLSearchParams({ site: siteKey });
    if (memberId) params.set("member", memberId);
    for (const [key, value] of Object.entries(extraParams ?? {})) params.set(key, value);
    if (bucket) params.set(CHANGE_FILTER_PARAM, bucket);
    return `/admin/profiles?${params.toString()}`;
  };

  // "Confirm all" belongs to ONE bucket: the tab that is open, or the only one there is when
  // there are no tabs. On "All" there is nothing to offer -- pick the retailer you loaded.
  const bucket = active ?? (groups.length === 1 ? (groups[0].siteKey ?? EMAIL_BUCKET) : null);
  const bucketGroup = groups.find((g) => (g.siteKey ?? EMAIL_BUCKET) === bucket);
  const confirmAll =
    bucket && bucketGroup ? (
      <ConfirmAllButton
        // Remounted when the count moves, so a confirm that landed leaves nothing armed.
        key={`${bucket}-${bucketGroup.count}`}
        bucket={bucket}
        label={bucketGroup.siteLabel}
        count={bucketGroup.count}
        seenAt={seenAt}
        runner={runner}
      />
    ) : null;

  if (total === 0) {
    return (
      <p className="mt-4 rounded-xl border border-[var(--color-good)]/40 bg-[var(--color-good)]/5 px-4 py-3 text-xs text-[var(--color-fg)]">
        <span aria-hidden className="font-bold text-[var(--color-good)]">
          ✓{" "}
        </span>
        No pending profile changes.
      </p>
    );
  }

  return (
    <section className="mt-4 rounded-xl border border-[var(--color-warn)]/40 bg-[var(--color-warn)]/5 p-4">
      <h2 className="text-sm font-bold text-white">
        {total} change{total === 1 ? "" : "s"} pending confirmation
      </h2>

      <p className="mt-1 text-[11px] text-[var(--color-muted)]">
        Confirming turns the member&rsquo;s &ldquo;pending confirmation&rdquo; tag into a green
        tick. Do it after you have loaded the export, not before — row by row, or a whole
        retailer&rsquo;s tab with Confirm all. There is no undo.
      </p>

      {/* Filter tabs, plus the open tab's "Confirm all". The counts are unfiltered on purpose:
          a tab that renumbered itself depending on which tab was open would be unreadable.
          Tabs only when there is more than one bucket -- a single tab filters nothing. */}
      {(groups.length > 1 || confirmAll) && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {groups.length > 1 && (
            <FilterTab href={hrefFor(null)} label="All" count={total} active={active === null} />
          )}
          {groups.length > 1 &&
            groups.map((group) => {
              const key = group.siteKey ?? EMAIL_BUCKET;
              return (
                <FilterTab
                  key={key}
                  href={hrefFor(key)}
                  label={group.siteLabel}
                  count={group.count}
                  active={active === key}
                />
              );
            })}
          {confirmAll}
        </div>
      )}

      {/* Open, not collapsed. Confirming is per row now, so hiding the rows behind a toggle
          would hide the only control there is.

          The top margin lives HERE rather than on the tabs above, so the gap is the same
          whether the tabs render or not -- with one bucket they don't, and hanging the
          spacing off them left the list flush against the help text. */}
      <ul className="mt-3 max-h-96 divide-y divide-[var(--color-edge)] overflow-y-auto overscroll-contain rounded-lg border border-[var(--color-edge)] bg-[var(--color-surface)]">
        {entriesOf(rows).map((entry) => {
          // "Your bot" for the viewer's own queue; named for anyone else's, which only a
          // full admin looking past their own share ever sees.
          const first = entry.kind === "change" ? entry.row : entry.rows[0];
          const theirs =
            first.assigneeId && first.assigneeId !== viewerId
              ? (runnerNames[first.assigneeId] ?? first.assigneeId)
              : null;

          if (entry.kind === "change") {
            const { row } = entry;
            return (
              <li
                key={row.id}
                className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5 px-3 py-2"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-xs text-[var(--color-fg)]">
                    <span className="font-semibold text-white">{row.username}</span>{" "}
                    {ACTION_VERB[row.action] ?? row.action.toLowerCase()}{" "}
                    {ENTITY_NOUN[row.entity] ?? "record"}
                    {row.label && <span className="text-[var(--color-muted)]"> {row.label}</span>}
                  </p>
                  <p className="mt-0.5 text-[11px] text-[var(--color-muted)]">
                    {row.siteLabel} · {relativeTime(row.at)}
                    {row.fields.length > 0 && ` · ${row.fields.join(", ")}`}
                    {theirs && ` · ${theirs}'s bot`}
                  </p>
                </div>
                <ConfirmButton changeIds={[row.id]} />
              </li>
            );
          }

          const n = entry.rows.length;
          const arriving = first.action === "ASSIGN";
          const noun = first.entity === "VAULT_ACCOUNT" ? "login" : "profile";
          const what = `${n} ${first.siteLabel} ${noun}${n === 1 ? "" : "s"}`;
          return (
            <li key={entry.key} className="px-3 py-2">
              <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5">
                <div className="min-w-0 flex-1">
                  <p className="text-xs text-[var(--color-fg)]">
                    <span className="font-semibold text-white">{first.actorName}</span> moved {what}{" "}
                    {arriving
                      ? theirs
                        ? `to ${theirs}`
                        : "to you"
                      : theirs
                        ? `off ${theirs}'s bot`
                        : "off your bot"}
                  </p>
                  <p className="mt-0.5 text-[11px] text-[var(--color-muted)]">
                    {relativeTime(first.at)} ·{" "}
                    {arriving
                      ? `load ${n === 1 ? "it" : "them"} onto the bot, then confirm`
                      : `take ${n === 1 ? "it" : "them"} off the bot, then confirm`}
                  </p>
                </div>
                <ConfirmButton
                  changeIds={entry.rows.map((row) => row.id)}
                  label={n === 1 ? "Confirm" : `Confirm all ${n}`}
                />
              </div>
              {/* Collapsed: a move of forty is one decision, and the names are for checking
                  the bot against, not for reading every time the page opens. */}
              <details className="mt-1.5">
                <summary className="inline-flex min-h-11 cursor-pointer items-center text-[11px] text-[var(--color-muted)] hover:text-[var(--color-fg)] sm:min-h-0">
                  Which {noun}s
                </summary>
                <ul className="mt-1 space-y-0.5 pl-3 text-[11px] text-[var(--color-muted)]">
                  {entry.rows.map((row) => (
                    <li key={row.id}>
                      <span className="text-[var(--color-fg)]">{row.label}</span> · {row.username}
                    </li>
                  ))}
                </ul>
              </details>
            </li>
          );
        })}
        {shown > rows.length && (
          // Never silently short. Counted against the ACTIVE bucket, not the overall total,
          // or a filtered list of 12 would claim to be hiding hundreds.
          <li className="px-3 py-2 text-[11px] text-[var(--color-muted)]">
            Showing the {rows.length} most recent of {shown}. Confirm these to see the rest.
          </li>
        )}
      </ul>
    </section>
  );
}

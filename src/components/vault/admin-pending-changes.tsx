"use client";

import Link from "next/link";
import { useActionState } from "react";
import type { PendingChangeGroup, PendingChangeRow } from "@/db/queries/admin-vault";
import { CHANGE_FILTER_PARAM, EMAIL_BUCKET } from "@/lib/vault/pending-filter";
import { relativeTime } from "@/lib/format";
import { markChangesApplied } from "@/lib/vault/admin-actions";

/**
 * Edits members have made that nobody has confirmed yet.
 *
 * The operator half of the pair described on `VaultChange.appliedAt`, and the same shape as
 * the payment queue: a member can only report, and only the operator can confirm. Confirming
 * these turns the amber "Pending confirmation" tag on the member's own profiles page into a
 * green tick, which is the whole reason the queue exists -- people were asking in the channel
 * whether their new card had taken effect.
 *
 * ONE ROW AT A TIME, and no bulk control anywhere. Confirming is a claim that a specific
 * edit is live; a single mis-click on a "confirm everything" button would tell every member
 * their changes had landed when nothing had been loaded, and the column never unsets so
 * there is no undo. The same rule is enforced in markChangesApplied rather than only here.
 *
 * The retailer chips FILTER the queue rather than acting on it -- same shape and behaviour
 * as the charges page's filter tabs. They live in the URL, so a filtered queue can be linked
 * and survives a reload.
 */

const ACTION_VERB: Record<string, string> = {
  CREATE: "added",
  UPDATE: "updated",
  DELETE: "removed",
  ACTIVATE: "enabled",
  DEACTIVATE: "disabled",
};

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

/** Confirms exactly one change. There is no bulk variant -- see the note on the section. */
function ConfirmButton({ changeId }: { changeId: string }) {
  const [state, formAction, pending] = useActionState(
    async (_previous: Awaited<ReturnType<typeof markChangesApplied>> | null, formData: FormData) =>
      markChangesApplied(formData),
    null,
  );

  return (
    <form action={formAction} className="contents">
      <input type="hidden" name="changeId" value={changeId} />
      <button
        type="submit"
        disabled={pending}
        title={state && !state.ok ? state.error : undefined}
        className="inline-flex min-h-11 shrink-0 items-center rounded-lg border border-[var(--color-edge)] px-3 py-1.5 text-xs font-medium text-[var(--color-fg)] transition-colors hover:border-[var(--color-brand)]/50 disabled:opacity-60 sm:min-h-0"
      >
        {pending ? "Confirming…" : "Confirm"}
      </button>
      {state && !state.ok && (
        <span role="alert" className="text-[11px] text-[var(--color-warn)]">
          {state.error}
        </span>
      )}
    </form>
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
   * The page's other query params -- the profile search and the active/inactive filter.
   *
   * A plain object for the same reason siteKey is a string: it has to cross the
   * server/client boundary, so it must be serializable. Carried for the same reason as
   * the member id -- filtering the queue must not clear the search below it.
   */
  extraParams?: Record<string, string>;
}) {
  const hrefFor = (bucket: string | null) => {
    const params = new URLSearchParams({ site: siteKey });
    if (memberId) params.set("member", memberId);
    for (const [key, value] of Object.entries(extraParams ?? {})) params.set(key, value);
    if (bucket) params.set(CHANGE_FILTER_PARAM, bucket);
    return `/admin/profiles?${params.toString()}`;
  };

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
        tick. Do it after you have loaded the export, not before — one row at a time, and there is
        no undo.
      </p>

      {/* Filter tabs, not bulk actions. The counts are unfiltered on purpose: a tab that
          renumbered itself depending on which tab was open would be unreadable. Only shown
          when there is more than one bucket -- a single tab filters nothing. */}
      {groups.length > 1 && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <FilterTab href={hrefFor(null)} label="All" count={total} active={active === null} />
          {groups.map((group) => {
            const bucket = group.siteKey ?? EMAIL_BUCKET;
            return (
              <FilterTab
                key={bucket}
                href={hrefFor(bucket)}
                label={group.siteLabel}
                count={group.count}
                active={active === bucket}
              />
            );
          })}
        </div>
      )}

      {/* Open, not collapsed. Confirming is per row now, so hiding the rows behind a toggle
          would hide the only control there is.

          The top margin lives HERE rather than on the tabs above, so the gap is the same
          whether the tabs render or not -- with one bucket they don't, and hanging the
          spacing off them left the list flush against the help text. */}
      <ul className="mt-3 max-h-96 divide-y divide-[var(--color-edge)] overflow-y-auto overscroll-contain rounded-lg border border-[var(--color-edge)] bg-[var(--color-surface)]">
        {rows.map((row) => (
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
              </p>
            </div>
            <ConfirmButton changeId={row.id} />
          </li>
        ))}
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

"use client";

import Link from "next/link";
import { useActionState, useState } from "react";
import type { AdminMemberRow } from "@/db/queries/admin-vault";
import type { RunnerOption } from "@/components/vault/runner-select";
import { assignProfiles, type AssignResult } from "@/lib/vault/assign-actions";
import type { SiteStyle } from "@/lib/sites";

/**
 * The member roster, with a checkbox per member for bulk export -- and, for a full admin,
 * for moving those members to another runner.
 *
 * TWO SEPARATE GESTURES on one row, deliberately, and the same split the profile list
 * already uses: clicking the NAME opens that member's profiles, ticking the BOX includes
 * them in an export or a move. Conflating them would mean you could not look at someone
 * without changing what you were about to export, and could not export without navigating.
 *
 * Selection is client state and intentionally not in the URL. It would otherwise have to
 * survive the navigation that clicking a name performs, and a member list of sixty with
 * forty ticked makes the query string longer than the export's own.
 */

/** Matches the cap the export route enforces, so the UI can say so before you click. */
const MAX_MEMBERS = 200;

export function AdminMemberPicker({
  members,
  siteKey,
  style,
  selected,
  exportBase,
  filtering = false,
  extraParams,
  runnerNames,
  move,
}: {
  members: AdminMemberRow[];
  siteKey: string;
  style: SiteStyle;
  /** The member whose profiles are open, from the URL. Not the export selection. */
  selected: string | null;
  exportBase: string;
  /**
   * Whether the page's search or active/inactive filter is doing anything.
   *
   * The roster arrives WHOLE either way -- the page validates `?member=` against it -- so
   * the narrowing happens here. Members with no matching profile drop out of the list;
   * their counts are still what they own, not what matched.
   */
  filtering?: boolean;
  /** The page's search params, carried into every member link. Serializable on purpose. */
  extraParams?: Record<string, string>;
  /**
   * Runner id -> name, when each member's runner is worth showing: everywhere except a
   * runner's own view, where every row would say the same name.
   */
  runnerNames?: Record<string, string>;
  /**
   * Full admins only: who the ticked members can be moved to, and whose share of them moves
   * -- the runner the page is showing, or "all". See assignProfiles.
   */
  move?: { runners: RunnerOption[]; from: string };
}) {
  const [checked, setChecked] = useState<Set<string>>(new Set());
  // What the last move did, shown once the selection it acted on has cleared.
  const [moved, setMoved] = useState<string | null>(null);
  const noun = style.usesProfiles === false ? "logins" : "profiles";

  // What the filter left. The member currently open is kept even with no matches, so
  // clicking a name never makes the row you just clicked disappear from under you.
  const shown = filtering
    ? members.filter((m) => m.matchCount > 0 || m.discordUserId === selected)
    : members;

  const count = checked.size;
  const allChecked = count > 0 && count === shown.length;
  const overCap = count > MAX_MEMBERS;

  const hrefFor = (discordUserId: string) => {
    const params = new URLSearchParams({ site: siteKey, member: discordUserId });
    for (const [key, value] of Object.entries(extraParams ?? {})) params.set(key, value);
    return `/admin/profiles?${params.toString()}`;
  };

  // Repeatable `member` params -- see the export route. Built once and shared by the
  // format links so they cannot drift apart.
  const memberParams = [...checked].map((id) => `member=${encodeURIComponent(id)}`).join("&");
  const bulkHref = (extra: string) => `${exportBase}&${memberParams}&${extra}`;

  return (
    <div className="lg:sticky lg:top-6 lg:self-start">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
        <h2 className="text-sm font-semibold tracking-wide text-[var(--color-muted)] uppercase">
          Members ({filtering ? `${shown.length} of ${members.length}` : members.length})
        </h2>
        <label className="flex min-h-11 items-center gap-2 text-xs text-[var(--color-muted)] sm:min-h-0">
          <input
            type="checkbox"
            checked={allChecked}
            ref={(el) => {
              if (el) el.indeterminate = count > 0 && !allChecked;
            }}
            // Over what is VISIBLE, not the whole roster: ticking "select all" under a
            // search must not quietly queue up sixty members you cannot see.
            onChange={(e) => {
              setMoved(null);
              setChecked(
                e.currentTarget.checked ? new Set(shown.map((m) => m.discordUserId)) : new Set(),
              );
            }}
            className="size-4 accent-[var(--color-brand)]"
          />
          Select all
        </label>
      </div>

      {count > 0 && (
        <div className="mb-3 rounded-xl border border-[var(--color-brand)]/40 bg-[var(--color-brand)]/5 p-3">
          <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="text-xs font-semibold text-white">
              {count} member{count === 1 ? "" : "s"} selected
            </span>
            <button
              type="button"
              onClick={() => setChecked(new Set())}
              className="inline-flex min-h-11 items-center text-[11px] font-medium text-[var(--color-muted)] transition-colors hover:text-[var(--color-fg)] sm:min-h-0"
            >
              Clear
            </button>
          </div>

          {overCap ? (
            // Said before the click rather than after: the route refuses past this, and
            // finding that out from a failed download is a worse way to learn it.
            <p className="text-[11px] text-[var(--color-warn)]">
              Too many to export at once (max {MAX_MEMBERS}). Use the whole-{style.label} export
              above.
            </p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {/* The bot split is offered only where the retailer has a cap, matching the
                  site-wide row above. Without one, "main" and "all" are the same file.
                  A login-only retailer has no profiles at all, so it gets neither -- see
                  usesProfiles in sites.ts. */}
              {style.usesProfiles !== false &&
                (style.profileSoftCap !== undefined ? (
                  <>
                    <BulkLink
                      href={bulkHref(`bot=main`)}
                      label={`Profiles · main (${style.profileSoftCap})`}
                    />
                    <BulkLink href={bulkHref(`bot=backup`)} label="Profiles · backup" />
                  </>
                ) : (
                  <BulkLink href={bulkHref(`bot=all`)} label="Profiles (AYCD)" />
                ))}
              {/* No logins on a guest-checkout retailer, so no file. Same gating as the
                  site-wide row on the page.

                  The app-password export used to sit beside this one, scoped to the
                  retailer. It moved to /admin/imap: a mailbox serves whichever retailers a
                  member happens to use, so splitting it per site produced overlapping files
                  and left the operator guessing which one was current. */}
              {style.usesAccounts !== false && (
                <BulkLink href={bulkHref(`format=accounts`)} label="Accounts" />
              )}
            </div>
          )}

          {move && !overCap && (
            <MoveMembers
              siteKey={siteKey}
              memberIds={[...checked]}
              from={move.from}
              runners={move.runners}
              noun={noun}
              onMoved={(moved) => {
                // Said here rather than inside the bar, which closes with the selection.
                setMoved(
                  moved === 0 ? "Already there — nothing moved." : `Moved ${moved} ${noun}.`,
                );
                setChecked(new Set());
              }}
            />
          )}
        </div>
      )}

      {moved && count === 0 && (
        <p role="status" className="mb-3 text-[11px] text-[var(--color-muted)]">
          {moved}
        </p>
      )}

      {shown.length === 0 && (
        <p className="rounded-xl border border-[var(--color-edge)] bg-[var(--color-surface)] px-4 py-8 text-center text-xs text-[var(--color-muted)]">
          No {style.label} {style.usesProfiles === false ? "logins" : "profiles"} match.
        </p>
      )}

      <ul className="max-h-[min(32rem,calc(100vh-12rem))] divide-y divide-[var(--color-edge)] overflow-y-auto overscroll-contain rounded-xl border border-[var(--color-edge)] bg-[var(--color-surface)] empty:hidden">
        {shown.map((m) => (
          <li
            key={m.discordUserId}
            className={
              "flex items-center gap-2 pl-3 " +
              (m.discordUserId === selected ? "bg-[var(--color-elevated)]/60 " : "") +
              (checked.has(m.discordUserId) ? "bg-[var(--color-brand)]/5" : "")
            }
          >
            {/* Its own 44px box outside the link, so ticking never navigates. */}
            <label className="flex min-h-11 shrink-0 items-center">
              <input
                type="checkbox"
                checked={checked.has(m.discordUserId)}
                // The boolean is read SYNCHRONOUSLY, before setChecked. Reading
                // `e.currentTarget` inside the updater instead looks equivalent and isn't:
                // React nulls the field once the handler returns, the updater runs after
                // that, and it throws — leaving the box visually ticked while the selection
                // stayed empty. Same shape as onSelect in profile-manager.tsx.
                onChange={(e) => {
                  const isChecked = e.currentTarget.checked;
                  setMoved(null);
                  setChecked((prev) => {
                    const next = new Set(prev);
                    if (isChecked) next.add(m.discordUserId);
                    else next.delete(m.discordUserId);
                    return next;
                  });
                }}
                aria-label={`Include ${m.username} in the export`}
                className="size-4 accent-[var(--color-brand)]"
              />
            </label>
            <Link
              href={hrefFor(m.discordUserId)}
              // Stay where you are. The roster sits well down the page, so the default
              // scroll-to-top threw you back to the header on every name you clicked --
              // and the thing that changed, the profile table, is beside the row you just
              // clicked rather than at the top.
              scroll={false}
              className="min-w-0 flex-1 py-2.5 pr-4 transition-colors hover:bg-[var(--color-elevated)]/40"
            >
              <p className="truncate text-sm font-medium text-white">{m.username}</p>
              <p className="mt-0.5 text-xs text-[var(--color-muted)]">
                {/* The match count leads when filtering, because it is the number you are
                    looking at the list for -- the ownership counts stay beside it so a
                    search result never reads as the member's whole profile set. */}
                {filtering && (
                  <span className="font-medium text-[var(--color-brand)]">
                    {m.matchCount} match{m.matchCount === 1 ? "" : "es"} ·{" "}
                  </span>
                )}
                {m.activeCount}/{m.profileCount} active
                {m.onBackup > 0 && ` · ${m.onBackup} backup`}
                {m.expiredCards > 0 && ` · ${m.expiredCards} expired`}
                {m.missingAppPasswords > 0 && (
                  <span className="text-[var(--color-warn)]">
                    {" "}
                    · {m.missingAppPasswords} no app pw
                  </span>
                )}
                {/* Brand red, not warn: on a retailer that requires a phone these
                    profiles are not "worth a look", they are failing every order. */}
                {m.missingPhone > 0 && (
                  <span className="text-[var(--color-brand)]"> · {m.missingPhone} no phone</span>
                )}
                {/* Same red, same reason: an order that hits the CVV prompt with nothing
                    stored stalls in the operator's hands mid-drop. */}
                {m.missingCvv > 0 && (
                  <span className="text-[var(--color-brand)]"> · {m.missingCvv} no CVV</span>
                )}
              </p>
              {/* Who runs them. More than one name is a member split between bots, which is
                  worth seeing before exporting or moving them. */}
              {runnerNames && m.runners.length > 0 && (
                <p className="mt-0.5 truncate text-[11px] text-[var(--color-muted)]">
                  {m.runners.map((id) => runnerNames[id] ?? id).join(", ")}
                </p>
              )}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * "Move these members to …" -- every profile of theirs on this retailer in the share the
 * page is showing. Two steps like RunnerSelect: picking a runner arms the button.
 */
function MoveMembers({
  siteKey,
  memberIds,
  from,
  runners,
  noun,
  onMoved,
}: {
  siteKey: string;
  memberIds: string[];
  from: string;
  runners: RunnerOption[];
  noun: string;
  onMoved: (moved: number) => void;
}) {
  const [to, setTo] = useState("");
  const [state, action, pending] = useActionState(
    async (_previous: AssignResult | null, form: FormData) => {
      const result = await assignProfiles(form);
      if (result.ok) onMoved(result.moved);
      return result;
    },
    null,
  );

  return (
    <form
      action={action}
      className="mt-3 flex flex-wrap items-center gap-2 border-t border-[var(--color-edge)] pt-3"
    >
      <input type="hidden" name="siteKey" value={siteKey} />
      <input type="hidden" name="from" value={from} />
      {memberIds.map((id) => (
        <input key={id} type="hidden" name="memberId" value={id} />
      ))}
      <label className="text-[11px] font-medium text-[var(--color-muted)]" htmlFor="move-to">
        Move their {noun} to
      </label>
      <select
        id="move-to"
        name="assigneeId"
        value={to}
        onChange={(event) => setTo(event.currentTarget.value)}
        disabled={pending}
        className="rounded-lg border border-[var(--color-edge)] bg-[var(--color-ink)] px-2 py-1 text-[11px] text-[var(--color-fg)] focus:border-[var(--color-brand)] focus:outline-none"
      >
        <option value="">Pick a runner</option>
        {runners.map((runner) => (
          <option key={runner.id} value={runner.id}>
            {runner.name}
          </option>
        ))}
      </select>
      <button
        type="submit"
        disabled={!to || pending}
        className="inline-flex min-h-11 items-center rounded-lg border border-[var(--color-brand)]/60 px-2.5 py-1 text-[11px] font-medium text-white transition-colors hover:bg-[var(--color-brand)]/10 disabled:opacity-50 sm:min-h-0"
      >
        {pending ? "Moving…" : "Move"}
      </button>
      {/* A success closes this bar with the selection, so only a refusal is said here. */}
      {state && !state.ok && (
        <span role="alert" className="text-[11px] text-[var(--color-warn)]">
          {state.error}
        </span>
      )}
    </form>
  );
}

function BulkLink({ href, label }: { href: string; label: string }) {
  return (
    <a
      href={href}
      // Plain anchor with `download`, not a Link: this is a file, not a route transition.
      download
      className="inline-flex min-h-11 items-center rounded-lg border border-[var(--color-edge)] bg-[var(--color-surface)] px-2.5 py-1 text-[11px] font-medium text-[var(--color-fg)] transition-colors hover:border-[var(--color-brand)]/50 sm:min-h-0"
    >
      {label}
    </a>
  );
}

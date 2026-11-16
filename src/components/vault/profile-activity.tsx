"use client";

import { useEffect, useState } from "react";
import { relativeTime } from "@/lib/format";
import { loadProfileHistory } from "@/lib/vault/activity-actions";
import {
  ACTIVITY_SINCE,
  type ActivityEvent,
  type ActivityKind,
  type ProfileActivity,
  type ProfileHistory,
} from "@/lib/vault/profile-activity";

/**
 * The success/fail view: a count on each profile's row, and the history it opens.
 *
 * The count is the profile's own record since failure tracking began -- orders through, and
 * orders cancelled or failed -- so a member can see which profiles earn their slot. The history
 * is fetched when the count is first tapped (loadProfileHistory), not shipped with the page.
 * See lib/vault/profile-activity.ts for what is counted, and how.
 *
 * Dates are Central, like the drop cards: when a member reads "8:02 PM" it should be the time
 * the drop said.
 */

const ZONE = "America/Chicago";

/** "Nov 1" -- where the counts start, said wherever a count is. */
export const ACTIVITY_SINCE_LABEL = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  timeZone: ZONE,
}).format(ACTIVITY_SINCE);

const WHEN = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZone: ZONE,
});

const KIND: Record<ActivityKind, { icon: string; label: string; tone: string }> = {
  "checked-out": { icon: "✓", label: "Checked out", tone: "text-[var(--color-good)]" },
  cancelled: { icon: "✕", label: "Cancelled", tone: "text-[var(--color-risk)]" },
  failed: { icon: "✕", label: "Failed", tone: "text-[var(--color-risk)]" },
};

/**
 * "12 checked out · 2 cancelled · 1 failed" -- a profile's record since ACTIVITY_SINCE, which
 * opens its history. A chip like the others on the row, but a button: it is the way into the
 * detail. A zero cancelled or failed is left out; checked out is always said.
 *
 * Words rather than a ✓ and a count: the row already carries a bare ✓ meaning "your change is
 * confirmed", and a second ✓ meaning something else would be read as the first. And the same
 * words as the history and the retailer's total, so "cancelled" never turns into "failed"
 * between the row and the panel under it.
 */
export function ActivityCount({
  activity,
  open,
  onToggle,
  controls,
}: {
  activity: ProfileActivity;
  open: boolean;
  onToggle: () => void;
  /** The id of the history panel it shows and hides. */
  controls: string;
}) {
  const said =
    `Since ${ACTIVITY_SINCE_LABEL}: ${activity.checkedOut} checked out, ` +
    `${activity.cancelled} cancelled, ${activity.failed} failed`;

  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      aria-controls={controls}
      aria-label={`${said}. ${open ? "Hide" : "Show"} its history.`}
      title={`${said}. Tap for the history.`}
      className={
        // Wraps between its parts, never inside one: on a phone "2 checked out" broke as "2
        // checked / out" beside the name.
        "inline-flex min-h-6 flex-wrap items-center gap-x-1 gap-y-0.5 rounded-full px-2 py-1 text-[10px] leading-none font-medium tracking-wide uppercase tabular-nums transition-colors " +
        (open
          ? "bg-[var(--color-fg)]/15"
          : "bg-[var(--color-elevated)] hover:bg-[var(--color-fg)]/10")
      }
    >
      <span className="whitespace-nowrap text-[var(--color-good)]">
        {activity.checkedOut} checked out
      </span>
      {(
        [
          [activity.cancelled, "cancelled"],
          [activity.failed, "failed"],
        ] as const
      ).map(
        ([count, word]) =>
          count > 0 && (
            <span key={word} className="whitespace-nowrap text-[var(--color-risk)]">
              <span aria-hidden className="text-[var(--color-muted)]">
                ·{" "}
              </span>
              {count} {word}
            </span>
          ),
      )}
    </button>
  );
}

function EventRow({ event }: { event: ActivityEvent }) {
  const kind = KIND[event.kind];
  const details = [
    event.reason,
    // Said, so a cancel that leaves no flag doesn't read as a missed one.
    event.kind !== "checked-out" && !event.flags ? "doesn't count toward a flag" : null,
    event.checkedOutAt ? `checked out ${WHEN.format(event.checkedOutAt)}` : null,
    event.orderId ? `order ${event.orderId}` : null,
  ].filter(Boolean);

  return (
    <li className="flex items-baseline gap-2.5 py-1.5 text-xs">
      <span aria-hidden className={`w-3 shrink-0 text-center font-bold ${kind.tone}`}>
        {kind.icon}
      </span>
      <span className="min-w-0 flex-1 break-words">
        <span className={`font-medium ${kind.tone}`}>{kind.label}</span>
        {event.product && (
          <span className="text-[var(--color-fg)]">
            {" · "}
            {event.product}
            {event.quantity && event.quantity > 1 ? ` ×${event.quantity}` : ""}
          </span>
        )}
        {details.length > 0 && (
          <span className="block text-[11px] text-[var(--color-muted)]">{details.join(" · ")}</span>
        )}
      </span>
      <time
        dateTime={event.at.toISOString()}
        title={relativeTime(event.at)}
        className="shrink-0 text-[11px] text-[var(--color-muted)] tabular-nums"
      >
        {WHEN.format(event.at)}
      </time>
    </li>
  );
}

/**
 * One profile's history, newest first, fetched when it is first shown. `basis-full`, so inside
 * the row's wrapping flex it takes a line of its own under the profile.
 */
export function ProfileHistoryPanel({
  profileId,
  activity,
  id,
}: {
  profileId: string;
  activity: ProfileActivity;
  id: string;
}) {
  // undefined while loading; null when the profile has gone (removed in another tab).
  const [history, setHistory] = useState<ProfileHistory | null | undefined>(undefined);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let current = true;
    loadProfileHistory(profileId)
      .then((result) => {
        if (current) setHistory(result);
      })
      .catch(() => {
        if (current) setFailed(true);
      });
    return () => {
      current = false;
    };
  }, [profileId]);

  return (
    <div
      id={id}
      className="basis-full rounded-lg border border-[var(--color-edge)] bg-[var(--color-ink)]/40 px-3 py-2.5"
    >
      <p className="text-[11px] text-[var(--color-muted)]">
        Since {ACTIVITY_SINCE_LABEL}:{" "}
        <span className="text-[var(--color-good)]">{activity.checkedOut} checked out</span>
        {activity.units > activity.checkedOut && ` (${activity.units} units)`}
        {" · "}
        <span className={activity.cancelled ? "text-[var(--color-risk)]" : ""}>
          {activity.cancelled} cancelled
        </span>
        {" · "}
        <span className={activity.failed ? "text-[var(--color-risk)]" : ""}>
          {activity.failed} failed
        </span>
      </p>

      {failed ? (
        <p role="alert" className="mt-2 text-xs text-[var(--color-warn)]">
          Couldn&rsquo;t load this profile&rsquo;s history. Close it and try again.
        </p>
      ) : history === undefined ? (
        <p className="mt-2 text-xs text-[var(--color-muted)]">Loading…</p>
      ) : history === null ? (
        <p className="mt-2 text-xs text-[var(--color-muted)]">
          This profile isn&rsquo;t on file anymore. Reload the page.
        </p>
      ) : history.events.length === 0 ? (
        <p className="mt-2 text-xs text-[var(--color-muted)]">
          Nothing since {ACTIVITY_SINCE_LABEL}.
        </p>
      ) : (
        <>
          <ul className="mt-1.5 divide-y divide-[var(--color-edge)]">
            {history.events.map((event) => (
              <EventRow key={event.id} event={event} />
            ))}
          </ul>
          {history.total > history.events.length && (
            <p className="mt-1.5 text-[11px] text-[var(--color-muted)]">
              Showing the latest {history.events.length} of {history.total}.
            </p>
          )}
        </>
      )}
    </div>
  );
}

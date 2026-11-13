import { relativeTime } from "@/lib/format";
import type { FailureFlag, FailureRisk } from "@/lib/vault/failure-flags";

/**
 * How a failed-checkout flag looks, wherever a profile is listed: the profile list, the Flagged
 * tab, the dashboard. One place, so orange and red mean the same thing on every page.
 *
 * Orange for a profile that has failed; solid red, white text, once it has failed three times
 * without being changed -- red as text is too dark to read at this size (globals.css).
 *
 * No "use client" here on purpose: the dashboard is a server component, and a constant
 * imported from a client module reaches a server component as a reference, not as its value.
 * The chip that explains itself on tap is failure-flag.tsx.
 */

export const FAILURE_CHIP: Record<FailureRisk, string> = {
  flagged:
    "inline-flex min-h-6 items-center gap-1 rounded-full bg-[var(--color-risk)]/15 px-2 py-1 text-[10px] leading-none font-medium tracking-wide text-[var(--color-risk)] uppercase",
  high: "inline-flex min-h-6 items-center gap-1 rounded-full bg-[var(--color-brand)] px-2 py-1 text-[10px] leading-none font-semibold tracking-wide text-[var(--color-on-brand)] uppercase",
};

/**
 * A bar down the row's leading edge. An inset shadow rather than a border, so a flagged row
 * lines up with its neighbours to the pixel.
 */
export const FAILURE_ROW_ACCENT: Record<FailureRisk, string> = {
  flagged: "shadow-[inset_3px_0_0_var(--color-risk)]",
  high: "shadow-[inset_3px_0_0_var(--color-brand)]",
};

/** What happened, and what to do about it: a sentence a member can act on. */
export function failureDetail(flag: FailureFlag, now?: Date): string {
  const when = relativeTime(flag.lastAt, now);
  const why = flag.lastReason ? `: ${flag.lastReason}` : "";
  const what = flag.lastProduct ? ` (${flag.lastProduct})` : "";
  const fix = "Check its card, billing address and login, then save — saving a change clears this.";
  if (flag.risk === "high") {
    return `${flag.count} failed checkouts since this profile was last changed, the latest ${when}${why}${what}. ${fix}`;
  }
  return flag.count === 1
    ? `A checkout failed ${when}${why}${what}. ${fix}`
    : `${flag.count} checkouts failed since it was last changed, the latest ${when}${why}${what}. ${fix}`;
}

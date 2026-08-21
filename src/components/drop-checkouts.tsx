import { CheckoutsByProfile } from "@/components/checkouts-by-profile";
import type { MemberDropCheckouts } from "@/db/queries/drop-checkouts";
import { count, plural } from "@/lib/format";

/**
 * "What did I check out in each drop", per profile.
 *
 * The operator's replacement for the balance box. They check out on house profiles, which
 * are owned but never billed, so they have no charges -- and the per-drop breakdown every
 * other member reads off their charge pages simply did not exist for them.
 *
 * `<details>` rather than client state: this is a list that expands, it needs no JavaScript
 * to do that, and a server component keeps the whole thing out of the bundle. The newest
 * drop opens by default because it is the one being looked at.
 */

const DATE_FORMAT: Intl.DateTimeFormatOptions = {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "America/Chicago",
};

function formatDate(date: Date): string {
  return new Intl.DateTimeFormat("en-US", DATE_FORMAT).format(date);
}

export function DropCheckouts({ data }: { data: MemberDropCheckouts }) {
  if (data.drops.length === 0) {
    return (
      <p className="rounded-xl border border-[var(--color-edge)] bg-[var(--color-surface)] px-5 py-10 text-center text-sm text-[var(--color-muted)]">
        No checkouts on your profiles yet.
      </p>
    );
  }

  return (
    <>
      <ul className="divide-y divide-[var(--color-edge)] overflow-hidden rounded-xl border border-[var(--color-edge)] bg-[var(--color-surface)]">
        {data.drops.map((drop, index) => (
          <li key={drop.runId ?? "unbilled"}>
            <details className="group" open={index === 0}>
              <summary className="flex cursor-pointer list-none flex-wrap items-center gap-x-3 gap-y-1 px-5 py-4 transition-colors hover:bg-[var(--color-elevated)]/40">
                <span
                  aria-hidden
                  className="text-[var(--color-muted)] transition-transform group-open:rotate-90"
                >
                  ›
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-semibold text-white">
                    {drop.dropLabel}
                    {drop.runId === null && (
                      <span className="ml-2 rounded-full bg-[var(--color-elevated)] px-2 py-1 text-[10px] leading-none font-medium tracking-wide text-[var(--color-muted)] uppercase">
                        unbilled
                      </span>
                    )}
                  </span>
                  <span className="mt-1 block text-xs text-[var(--color-muted)]">
                    {/* A RANGE for the unbilled group, a single date for a real drop. A
                        billed drop happens on its night, but the unbilled group is whatever
                        fell outside every window -- showing only its earliest date read as
                        "this is old" when it holds the last two weeks. */}
                    {drop.runId === null &&
                    formatDate(drop.windowStart) !== formatDate(drop.windowEnd)
                      ? `${formatDate(drop.windowStart)} – ${formatDate(drop.windowEnd)}`
                      : formatDate(drop.windowStart)}{" "}
                    · {count(drop.unitCount)} {plural(drop.unitCount, "unit")} across{" "}
                    {count(drop.profiles.length)} {plural(drop.profiles.length, "profile")}
                  </span>
                </span>
                <span className="text-sm font-bold text-white tabular-nums">
                  {count(drop.checkoutCount)}
                </span>
              </summary>
              <div className="border-t border-[var(--color-edge)] bg-[var(--color-ink)]/40 px-5 py-4">
                <CheckoutsByProfile profiles={drop.profiles} />
              </div>
            </details>
          </li>
        ))}
      </ul>

      {/* Never silently short: a capped list read as "this is everything" would be off by
          hundreds on a heavy account, and it is the OLDEST drops that lose rows. */}
      {data.truncated && (
        <p className="mt-3 text-xs text-[var(--color-muted)]">
          Showing your {count(data.checkoutCount)} most recent checkouts, so the oldest drop here
          may be incomplete.
        </p>
      )}
    </>
  );
}

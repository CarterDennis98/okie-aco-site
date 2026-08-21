import Image from "next/image";
import type { ProfileCheckouts } from "@/db/queries/drop-checkouts";
import { count, plural, relativeTime } from "@/lib/format";
import { siteStyle } from "@/lib/sites";

/**
 * One drop's checkouts, under the profile each landed on.
 *
 * Deliberately has no "use client" of its own and no hooks: it renders inside the member
 * dashboard (a server component) AND inside the operator's charge row (a client one), and
 * the two must show the same thing. The only import from a `server-only` module is a TYPE,
 * which is erased at compile time -- a value import there would break the client build.
 *
 * PROFILE FIRST, product second. "Which of my profiles got what" is the question this
 * answers; a flat list of items already exists on the dashboard above it.
 */
export function CheckoutsByProfile({ profiles }: { profiles: ProfileCheckouts[] }) {
  if (profiles.length === 0) {
    return (
      <p className="px-1 py-3 text-xs text-[var(--color-muted)]">
        No checkouts recorded in this drop&rsquo;s window.
      </p>
    );
  }

  return (
    <ul className="flex flex-col gap-3">
      {profiles.map((profile) => (
        <li key={profile.profileName}>
          <p className="flex flex-wrap items-baseline gap-x-2 text-xs font-semibold text-white">
            {profile.profileName}
            <span className="font-normal text-[var(--color-muted)]">
              {count(profile.unitCount)} {plural(profile.unitCount, "unit")} ·{" "}
              {count(profile.checkoutCount)} {plural(profile.checkoutCount, "checkout")}
            </span>
          </p>

          <ul className="mt-1.5 flex flex-col gap-1.5">
            {profile.checkouts.map((checkout) => {
              const style = siteStyle(checkout.site);
              return (
                <li key={checkout.id} className="flex items-center gap-2.5">
                  {checkout.imageUrl ? (
                    <Image
                      src={checkout.imageUrl}
                      alt=""
                      width={28}
                      height={28}
                      className="size-7 shrink-0 rounded border border-[var(--color-edge)] bg-white object-contain"
                    />
                  ) : (
                    <div
                      aria-hidden
                      className="size-7 shrink-0 rounded border border-[var(--color-edge)] bg-[var(--color-elevated)]"
                    />
                  )}
                  <span className="min-w-0 flex-1 truncate text-xs text-[var(--color-fg)]">
                    <span className="font-semibold text-white">{checkout.quantity}×</span>{" "}
                    {checkout.label}
                  </span>
                  {/* Retailer as text, not a logo tile: these rows are 28px tall and nested
                      two lists deep, and the name is what tells them apart at that size. */}
                  <span className="shrink-0 text-[11px] text-[var(--color-muted)]">
                    {checkout.site ? `${style.label} · ` : ""}
                    <time dateTime={checkout.occurredAt.toISOString()}>
                      {relativeTime(checkout.occurredAt)}
                    </time>
                  </span>
                </li>
              );
            })}
          </ul>
        </li>
      ))}
    </ul>
  );
}

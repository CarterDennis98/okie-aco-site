import Image from "next/image";
import type { PublicCheckout } from "@/db/queries/public";
import { relativeTime } from "@/lib/format";
import { siteStyle } from "@/lib/sites";

/**
 * The public feed. Every row is anonymous by construction -- the query never selects a
 * member-identifying column, so there is nothing here to accidentally render.
 */

function Thumb({ src }: { src: string | null }) {
  if (!src) {
    return (
      <div
        aria-hidden
        className="grid size-11 shrink-0 place-items-center rounded-md border border-[var(--color-edge)] bg-[var(--color-elevated)] text-[var(--color-muted)]"
      >
        {/* Neutral placeholder rather than a broken frame: rows ingested before
            thumbnails were captured simply have no image. */}
        <svg
          viewBox="0 0 24 24"
          className="size-5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
        >
          <rect x="3" y="4" width="18" height="16" rx="2" />
          <path d="m3 15 5-4 4 3 3-2 6 5" />
        </svg>
      </div>
    );
  }

  return (
    <Image
      src={src}
      alt=""
      width={44}
      height={44}
      className="size-11 shrink-0 rounded-md border border-[var(--color-edge)] bg-white object-contain"
    />
  );
}

export function CheckoutFeed({ checkouts }: { checkouts: PublicCheckout[] }) {
  if (checkouts.length === 0) {
    return (
      <p className="rounded-xl border border-[var(--color-edge)] bg-[var(--color-surface)] px-5 py-10 text-center text-sm text-[var(--color-muted)]">
        No checkouts yet. The feed fills in after the next drop.
      </p>
    );
  }

  return (
    // Scrollable rather than paginated: the feed is for browsing, and a fixed-height
    // pane keeps the page from running to tens of thousands of pixels at 250 rows.
    <ul className="max-h-[32rem] divide-y divide-[var(--color-edge)] overflow-y-auto overscroll-contain rounded-xl border border-[var(--color-edge)] bg-[var(--color-surface)]">
      {checkouts.map((checkout, index) => (
        <li
          key={checkout.id}
          className="animate-rise flex items-center gap-3.5 px-4 py-3 transition-colors hover:bg-[var(--color-elevated)]/40 sm:px-5"
          style={{ animationDelay: `${Math.min(index, 8) * 35}ms` }}
        >
          <Thumb src={checkout.imageUrl} />

          <div className="min-w-0 flex-1">
            <p className="text-sm leading-snug text-[var(--color-fg)]">
              A member checked out{" "}
              <span className="font-semibold text-white">
                {checkout.quantity}× {checkout.label}
              </span>
            </p>
            <p className="mt-1 flex items-center gap-1.5 text-xs text-[var(--color-muted)]">
              {checkout.site && (
                <>
                  {checkout.siteLogo && (
                    <span
                      className={
                        "grid h-3.5 w-4 shrink-0 place-items-center overflow-hidden rounded-[2px] " +
                        (siteStyle(checkout.site).needsLightBacking ? "bg-white px-px" : "")
                      }
                    >
                      <Image
                        src={checkout.siteLogo}
                        alt=""
                        width={siteStyle(checkout.site).width}
                        height={siteStyle(checkout.site).height}
                        sizes="32px"
                        className="h-3 w-full object-contain"
                      />
                    </span>
                  )}
                  <span>{siteStyle(checkout.site).label}</span>
                  <span aria-hidden>·</span>
                </>
              )}
              <time dateTime={checkout.occurredAt.toISOString()}>
                {relativeTime(checkout.occurredAt)}
              </time>
            </p>
          </div>
        </li>
      ))}
    </ul>
  );
}

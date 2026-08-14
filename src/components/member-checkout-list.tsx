import Image from "next/image";
import { FeedScroller } from "@/components/feed-scroller";
import type { MemberCheckout } from "@/db/queries/member";
import { relativeTime } from "@/lib/format";
import { siteStyle } from "@/lib/sites";

/**
 * The member's own checkouts. Unlike the public feed this is named and undelayed --
 * it's their data, so there is nothing to anonymize and no reason to withhold it.
 *
 * Shares the public feed's scroll pane so both lists behave identically, including the
 * edge fades that signal there is more above or below.
 */
export function MemberCheckoutList({ checkouts }: { checkouts: MemberCheckout[] }) {
  if (checkouts.length === 0) {
    return (
      <p className="rounded-xl border border-[var(--color-edge)] bg-[var(--color-surface)] px-5 py-10 text-center text-sm text-[var(--color-muted)]">
        No checkouts on your profiles yet.
      </p>
    );
  }

  return (
    <FeedScroller className="max-h-[32rem] divide-y divide-[var(--color-edge)] overflow-y-auto overscroll-contain rounded-xl border border-[var(--color-edge)] bg-[var(--color-surface)]">
      {checkouts.map((checkout) => {
        const style = siteStyle(checkout.site);
        return (
          <li key={checkout.id} className="flex items-center gap-3.5 px-4 py-3 sm:px-5">
            {checkout.imageUrl ? (
              <Image
                src={checkout.imageUrl}
                alt=""
                width={44}
                height={44}
                className="size-11 shrink-0 rounded-md border border-[var(--color-edge)] bg-white object-contain"
              />
            ) : (
              <div
                aria-hidden
                className="size-11 shrink-0 rounded-md border border-[var(--color-edge)] bg-[var(--color-elevated)]"
              />
            )}

            <div className="min-w-0 flex-1">
              <p className="truncate text-sm leading-snug text-[var(--color-fg)]">
                <span className="font-semibold text-white">{checkout.quantity}×</span>{" "}
                {checkout.label}
              </p>
              <p className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-[var(--color-muted)]">
                {checkout.site && (
                  <>
                    {checkout.siteLogo && (
                      <span
                        className={
                          "grid h-3.5 w-4 shrink-0 place-items-center overflow-hidden rounded-[2px] " +
                          (style.needsLightBacking ? "bg-white px-px" : "")
                        }
                      >
                        <Image
                          src={checkout.siteLogo}
                          alt=""
                          width={style.width}
                          height={style.height}
                          sizes="32px"
                          className="h-3 w-full object-contain"
                        />
                      </span>
                    )}
                    <span>{style.label}</span>
                    <span aria-hidden>·</span>
                  </>
                )}
                <time dateTime={checkout.occurredAt.toISOString()}>
                  {relativeTime(checkout.occurredAt)}
                </time>
                {checkout.profileName && (
                  <>
                    <span aria-hidden>·</span>
                    <span className="truncate">{checkout.profileName}</span>
                  </>
                )}
              </p>
            </div>
          </li>
        );
      })}
    </FeedScroller>
  );
}

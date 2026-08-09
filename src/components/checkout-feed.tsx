import type { PublicCheckout } from "@/db/queries/public";
import { relativeTime } from "@/lib/format";

/**
 * The public feed. Every row is anonymous by construction -- the query never selects a
 * member-identifying column, so there is nothing here to accidentally render.
 */
export function CheckoutFeed({ checkouts }: { checkouts: PublicCheckout[] }) {
  if (checkouts.length === 0) {
    return (
      <p className="rounded-xl border border-[var(--color-edge)] bg-[var(--color-surface)] px-5 py-8 text-center text-sm text-[var(--color-muted)]">
        No checkouts yet. The feed fills in after the next drop.
      </p>
    );
  }

  return (
    <ul className="divide-y divide-[var(--color-edge)] overflow-hidden rounded-xl border border-[var(--color-edge)] bg-[var(--color-surface)]">
      {checkouts.map((checkout, index) => (
        <li
          key={checkout.id}
          className="animate-rise flex items-start gap-3 px-4 py-3.5 sm:px-5"
          style={{ animationDelay: `${Math.min(index, 8) * 35}ms` }}
        >
          <span
            aria-hidden
            className="mt-1.5 size-2 shrink-0 rounded-full bg-[var(--color-accent)] shadow-[0_0_8px_var(--color-accent)]"
          />
          <div className="min-w-0 flex-1">
            <p className="text-sm leading-snug text-[var(--color-fg)]">
              A member checked out{" "}
              <span className="font-semibold">
                {checkout.quantity}× {checkout.label}
              </span>
            </p>
            <p className="mt-0.5 text-xs text-[var(--color-muted)]">
              {checkout.site ? `${checkout.site} · ` : ""}
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

import Link from "next/link";
import { CheckoutFeed } from "@/components/checkout-feed";
import { SiteFooter, SiteHeader } from "@/components/site-shell";
import {
  getApprovedTestimonials,
  getPublicFeed,
  getPublicStats,
  getRecentProducts,
} from "@/db/queries/public";
import { count, plural } from "@/lib/format";

// ISR: the feed is delayed 30 minutes anyway, so a 60s window costs nothing in
// freshness and means a scraper hits cache rather than Postgres.
export const revalidate = 60;

const DISCORD_INVITE = process.env.DISCORD_INVITE_URL ?? "#";

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <div className="flex-1 px-5 py-4 text-center">
      <div className="text-2xl font-bold tabular-nums text-[var(--color-fg)] sm:text-3xl">
        {value}
      </div>
      <div className="mt-1 text-xs tracking-wide text-[var(--color-muted)] uppercase">{label}</div>
    </div>
  );
}

export default async function HomePage() {
  const [feed, stats, testimonials, products] = await Promise.all([
    getPublicFeed(),
    getPublicStats(),
    getApprovedTestimonials(),
    getRecentProducts(),
  ]);

  return (
    <>
      <SiteHeader />

      <main className="mx-auto max-w-5xl px-5">
        {/* Hero */}
        <section className="py-16 sm:py-24">
          <p className="text-sm font-medium text-[var(--color-accent)]">
            Oklahoma-run · Since 2026
          </p>
          <h1 className="mt-3 max-w-2xl text-4xl font-bold tracking-tight text-balance sm:text-5xl">
            We check out the cards you can&apos;t.
          </h1>
          <p className="mt-4 max-w-xl text-lg text-pretty text-[var(--color-muted)]">
            Okie ACO runs automated checkout for hard-to-find trading cards. You sleep, we hit the
            drop, you get a DM with exactly what you owe.
          </p>

          <div className="mt-8 flex flex-wrap items-center gap-3">
            <a
              href={DISCORD_INVITE}
              className="rounded-lg bg-[var(--color-accent)] px-5 py-2.5 font-medium text-[var(--color-ink)] transition-opacity hover:opacity-90"
            >
              Join the Discord
            </a>
            <Link
              href="/signin"
              className="rounded-lg border border-[var(--color-edge)] px-5 py-2.5 font-medium text-[var(--color-fg)] transition-colors hover:bg-[var(--color-surface)]"
            >
              Member sign in
            </Link>
          </div>
        </section>

        {/* Counters -- the actual social proof */}
        <section className="flex divide-x divide-[var(--color-edge)] rounded-xl border border-[var(--color-edge)] bg-[var(--color-surface)]">
          <Stat value={count(stats.checkouts)} label="Checkouts" />
          <Stat value={count(stats.units)} label="Items secured" />
          <Stat value={count(stats.membersServed)} label="Members served" />
        </section>
        <p className="mt-2 text-center text-xs text-[var(--color-muted)]">
          Last {stats.windowDays} days
        </p>

        {/* Feed */}
        <section className="mt-16">
          <div className="mb-4 flex items-baseline justify-between gap-4">
            <h2 className="text-xl font-semibold tracking-tight">Recent checkouts</h2>
            <span className="text-xs text-[var(--color-muted)]">
              Delayed · members stay anonymous
            </span>
          </div>
          <CheckoutFeed checkouts={feed} />
        </section>

        {/* What we hit */}
        {products.length > 0 && (
          <section className="mt-16">
            <h2 className="mb-4 text-xl font-semibold tracking-tight">
              What we&apos;ve been hitting
            </h2>
            <ul className="grid gap-3 sm:grid-cols-2">
              {products.map((product) => (
                <li
                  key={product.id}
                  className="rounded-xl border border-[var(--color-edge)] bg-[var(--color-surface)] px-4 py-3.5"
                >
                  <p className="text-sm leading-snug font-medium">{product.label}</p>
                  <p className="mt-1 text-xs text-[var(--color-muted)]">
                    {product.source ? `${product.source} · ` : ""}
                    {count(product.units)} {plural(product.units, "unit")} secured
                  </p>
                </li>
              ))}
            </ul>
          </section>
        )}

        {/* Testimonials */}
        {testimonials.length > 0 && (
          <section className="mt-16">
            <h2 className="mb-4 text-xl font-semibold tracking-tight">From the server</h2>
            <ul className="grid gap-3 sm:grid-cols-2">
              {testimonials.map((testimonial) => (
                <li
                  key={testimonial.id}
                  className="rounded-xl border border-[var(--color-edge)] bg-[var(--color-surface)] p-5"
                >
                  <p className="text-sm leading-relaxed text-pretty">
                    &ldquo;{testimonial.body}&rdquo;
                  </p>
                  {testimonial.attribution && (
                    <p className="mt-3 text-xs text-[var(--color-muted)]">
                      — {testimonial.attribution}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          </section>
        )}

        {/* Close */}
        <section className="mt-20 rounded-xl border border-[var(--color-edge)] bg-[var(--color-surface-2)] px-6 py-10 text-center">
          <h2 className="text-2xl font-semibold tracking-tight">Want in on the next drop?</h2>
          <p className="mx-auto mt-2 max-w-md text-[var(--color-muted)]">
            Membership runs through Discord. Fees are per item and you always see the math.
          </p>
          <a
            href={DISCORD_INVITE}
            className="mt-6 inline-block rounded-lg bg-[var(--color-accent)] px-5 py-2.5 font-medium text-[var(--color-ink)] transition-opacity hover:opacity-90"
          >
            Join the Discord
          </a>
        </section>
      </main>

      <SiteFooter />
    </>
  );
}

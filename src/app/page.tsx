import { CheckoutFeed } from "@/components/checkout-feed";
import { SiteFooter, SiteHeader } from "@/components/site-shell";
import { StatsPanel } from "@/components/stats-panel";
import { MemberSuccess } from "@/components/member-success";
import { SupportedSites } from "@/components/supported-sites";
import {
  getPublicFeed,
  getRangeStats,
  getRecentDrops,
} from "@/db/queries/public";
import { currentViewer } from "@/lib/auth/guard";

/**
 * Rendered per request, not ISR.
 *
 * ISR would prerender this page during `next build` -- which happens inside the Docker
 * build, where there is no database and must not be one. Giving CI a tunnel into Cloud
 * SQL just to produce an image is a far worse trade than six indexed queries per
 * request on a site serving a 66-person Discord.
 *
 * If traffic ever makes that untrue, the upgrade is `cacheComponents: true` plus
 * `"use cache"` on the query functions, which caches the data without making the route
 * a build-time artifact. Deliberately not done now: it changes rendering semantics
 * app-wide.
 */
export const dynamic = "force-dynamic";

const DISCORD_INVITE = process.env.DISCORD_INVITE_URL ?? "#";

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="mb-4 flex items-center gap-2.5 text-xl font-bold tracking-tight">
      <span aria-hidden className="h-5 w-1 rounded-full bg-[var(--color-brand)]" />
      {children}
    </h2>
  );
}

export default async function HomePage() {
  // Both ranges are computed server-side and handed to the panel, so switching
  // between them is instant and the page stays static.
  const [feed, recentStats, allStats, recentDrops, allDrops, viewer] =
    await Promise.all([
      getPublicFeed(),
      getRangeStats("recent"),
      getRangeStats("all"),
      getRecentDrops("recent"),
      getRecentDrops("all"),
      // Only flips the header between "Sign in" and "Dashboard". Costs nothing for a
      // signed-out visitor -- with no session cookie this never reaches the database.
      currentViewer(),
    ]);

  return (
    <>
      <SiteHeader signedIn={viewer !== null} />

      <main className="mx-auto max-w-5xl px-5">
        <section className="py-16 sm:py-24">
          <h1 className="max-w-3xl text-4xl leading-[1.05] font-black tracking-tight text-balance text-white sm:text-6xl">
            Automated checkout for{" "}
            <span className="text-[var(--color-brand)]">high-demand collectibles</span>
          </h1>
          <p className="mt-5 max-w-xl text-lg text-pretty text-[var(--color-muted)]">
            Okie ACO runs checkout bots for trading card products and other items that sell out in
            seconds. When a drop goes live we check out for you — you pay the retailer directly, and
            we charge a small fee per item.
          </p>
        </section>

        <StatsPanel
          recent={{ stats: recentStats, drops: recentDrops }}
          all={{ stats: allStats, drops: allDrops }}
        />

        <section className="mt-16">
          <SectionHeading>Recent checkouts</SectionHeading>
          <CheckoutFeed checkouts={feed} />
        </section>

        <SupportedSites />

        {/* Photos rather than quotes. The Testimonial table and its admin screen are left
            in place -- nothing is deleted, so text quotes can come back alongside these
            without rebuilding anything. */}
        <MemberSuccess />

        <section className="mt-20 rounded-xl border border-[var(--color-edge)] bg-[var(--color-surface)] px-6 py-10 text-center">
          <h2 className="text-2xl font-bold tracking-tight text-white">Join Okie ACO</h2>
          <p className="mx-auto mt-2.5 max-w-sm text-[var(--color-muted)]">
            Like what you see? Get set up before the next drop.
          </p>
          <a
            href={DISCORD_INVITE}
            className="mt-6 inline-block rounded-lg bg-[var(--color-brand)] px-6 py-3 font-semibold text-[var(--color-on-brand)] transition-colors hover:bg-[var(--color-brand-dark)]"
          >
            Discord invite
          </a>
        </section>
      </main>

      <SiteFooter />
    </>
  );
}

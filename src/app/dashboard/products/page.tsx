import Link from "next/link";
import { DropStatsPanel } from "@/components/products/drop-stats";
import { ProductPicker } from "@/components/products/product-picker";
import { SiteFooter, SiteHeader } from "@/components/site-shell";
import {
  getCatalog,
  getDropStats,
  getMemberChoices,
  getPickableProfiles,
  getSelectionCounts,
  getSetOrder,
} from "@/db/queries/products";
import { requireMember } from "@/lib/auth/guard";

/**
 * Target Products ("SKUs" in the dashboard's links): which Target products a member wants to
 * be run for.
 *
 * Replaces reacting ✅ to each SKU in the drops channel. What a member switches on here is
 * what the operator's export puts on their checkout tasks -- per profile, if they narrow it --
 * so a change made before the export is a change that counts.
 *
 * Full admins pick for their own profiles here like anyone else, and see the same page with
 * more on it: a summary (who is being run, on how many profiles, for what), the catalog
 * controls -- adding, arranging, editing and retiring products -- and how many members and
 * profiles each product would run on.
 */
export const dynamic = "force-dynamic";

/** The only retailer with a product list today. */
const SITE = "target";

export default async function ProductsPage() {
  const viewer = await requireMember();

  const [catalog, choices, profiles, setOrder, counts, stats] = await Promise.all([
    getCatalog(SITE, { includeRetired: viewer.isAdmin }),
    getMemberChoices(viewer.discordUserId, SITE),
    getPickableProfiles(viewer.discordUserId, SITE),
    getSetOrder(SITE),
    viewer.isAdmin ? getSelectionCounts(SITE) : Promise.resolve(null),
    viewer.isAdmin ? getDropStats(SITE) : Promise.resolve(null),
  ]);
  const products = catalog.filter((p) => p.active);
  const retired = catalog.filter((p) => !p.active);
  const sets = [...new Set(catalog.map((p) => p.setName))].sort();
  const running = profiles.filter((p) => p.active).length;

  return (
    <>
      <SiteHeader signedIn />

      <main className="mx-auto max-w-4xl px-5 py-10 sm:py-14">
        <Link
          href="/dashboard"
          className="text-sm text-[var(--color-muted)] transition-colors hover:text-[var(--color-fg)]"
        >
          ← Dashboard
        </Link>

        <h1 className="mt-5 text-3xl font-black tracking-tight text-white">Target Products</h1>
        <p className="mt-3 max-w-2xl text-[var(--color-muted)]">
          Switch on the products you want us to run for you. Only what you check is run, nothing
          more.
        </p>

        {running === 0 ? (
          <p className="mt-4 max-w-2xl rounded-xl border border-[var(--color-warn)]/40 bg-[var(--color-warn)]/5 px-4 py-3 text-sm text-[var(--color-fg)]">
            You don&rsquo;t have an active Target profile, so nothing here can run yet.{" "}
            <Link href="/dashboard/profiles" className="underline underline-offset-2">
              Add one on your profiles page
            </Link>
            .
          </p>
        ) : running === 1 ? (
          <p className="mt-4 max-w-2xl rounded-xl border border-[var(--color-edge)] bg-[var(--color-surface)] px-4 py-3 text-sm text-[var(--color-muted)]">
            A product you switch on runs on your Target profile, and on any you add later.
          </p>
        ) : (
          <p className="mt-4 max-w-2xl rounded-xl border border-[var(--color-edge)] bg-[var(--color-surface)] px-4 py-3 text-sm text-[var(--color-muted)]">
            A product you switch on runs on{" "}
            <strong className="text-[var(--color-fg)]">
              all {running} of your Target profiles
            </strong>
            , including any you add later. To run it on only some of them, choose &ldquo;Only
            some&rdquo; under it.
          </p>
        )}

        {stats && <DropStatsPanel stats={stats} />}

        <ProductPicker
          products={products}
          retired={retired}
          profiles={profiles}
          initialChoices={choices}
          admin={viewer.isAdmin}
          counts={counts}
          sets={sets}
          setOrder={setOrder}
        />
      </main>

      <SiteFooter />
    </>
  );
}

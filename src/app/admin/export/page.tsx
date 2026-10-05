import Link from "next/link";
import { notFound } from "next/navigation";
import { ShikariExport } from "@/components/export/shikari-export";
import { SiteFooter, SiteHeader } from "@/components/site-shell";
import { getCatalog } from "@/db/queries/products";
import { SHIKARI_SITE, getShikariInstances, getShikariMembers } from "@/db/queries/shikari";
import { operatorId } from "@/lib/auth/admin-scope";
import { requireAdmin } from "@/lib/auth/guard";
import { siteStyle } from "@/lib/sites";

/**
 * Quick exports: drop-day setup in one place.
 *
 * THE OPERATOR'S PAGE ALONE -- not every full admin's, and never a runner's. Everything here
 * loads the operator's own bots with the operator's own assignments; to anyone else the
 * route 404s, like the admin pages do for members, so it isn't there to probe.
 *
 * Shikari is the first: each instance's own backup goes in, the vault's profiles, logins,
 * mailboxes and drop picks are written into it in place, and the same file comes back out
 * after a review. The backup never leaves the browser -- see lib/shikari/sqlite.ts.
 */
export const dynamic = "force-dynamic";

export const metadata = { robots: { index: false, follow: false } };

export default async function ExportPage() {
  const viewer = await requireAdmin();
  if (viewer.discordUserId !== operatorId()) notFound();

  const [members, saved, catalog] = await Promise.all([
    getShikariMembers(viewer.discordUserId),
    getShikariInstances(),
    getCatalog(SHIKARI_SITE),
  ]);

  return (
    <>
      <SiteHeader signedIn />

      <main className="mx-auto max-w-6xl px-5 py-10 sm:py-14">
        <div className="flex flex-wrap items-center gap-4">
          <Link
            href="/dashboard"
            className="text-sm text-[var(--color-muted)] transition-colors hover:text-[var(--color-fg)]"
          >
            ← Dashboard
          </Link>
          <Link
            href="/admin/profiles"
            className="text-sm text-[var(--color-muted)] transition-colors hover:text-[var(--color-fg)]"
          >
            Admin
          </Link>
          <Link
            href="/dashboard/products"
            className="text-sm text-[var(--color-muted)] transition-colors hover:text-[var(--color-fg)]"
          >
            SKUs
          </Link>
        </div>

        <h1 className="mt-5 text-3xl font-black tracking-tight text-white">Export</h1>
        <p className="mt-2 max-w-3xl text-sm text-[var(--color-muted)]">
          Quick exports for your own bots, built from what&rsquo;s on the site. Exporting never
          confirms a pending change — do that on the Admin page once the export is loaded.
        </p>

        <section className="mt-8">
          <h2 className="mb-1 flex items-center gap-2.5 text-xl font-bold tracking-tight">
            <span aria-hidden className="h-5 w-1 rounded-full bg-[var(--color-brand)]" />
            Shikari
          </h2>
          <p className="mb-5 max-w-3xl text-sm text-[var(--color-muted)]">
            Add each instance&rsquo;s Shikari backup (the <code>.bak</code> file). It&rsquo;s read
            and rebuilt here in your browser — the file is never uploaded. Profiles, logins and
            mailboxes come from the vault, and products from{" "}
            <Link
              href="/dashboard/products"
              className="underline underline-offset-2 hover:text-[var(--color-fg)]"
            >
              {siteStyle(SHIKARI_SITE).label} Products
            </Link>{" "}
            ({catalog.length} listed).
          </p>
          <ShikariExport
            members={members}
            saved={saved}
            cap={siteStyle(SHIKARI_SITE).profileSoftCap ?? null}
            productCount={catalog.length}
          />
        </section>
      </main>

      <SiteFooter />
    </>
  );
}

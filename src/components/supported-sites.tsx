import { existsSync } from "node:fs";
import path from "node:path";
import Image from "next/image";
import { onTint, siteMonogram, supportedSites } from "@/lib/sites";

/**
 * The retailers Okie ACO can check out on.
 *
 * Driven by the site config rather than by checkout data, so a retailer we support but
 * haven't hit recently still advertises. Logos are resolved from disk at render time --
 * this is a server component, so the filesystem check is fine here (unlike SiteChip,
 * which renders inside the client carousel).
 */
export function SupportedSites() {
  const sites = supportedSites().map((site) => ({
    ...site,
    hasLogo: existsSync(path.join(process.cwd(), "public", site.logo.replace(/^\//, ""))),
  }));

  if (sites.length === 0) return null;

  return (
    <section className="mt-16">
      <h2 className="mb-4 flex items-center gap-2.5 text-xl font-bold tracking-tight">
        <span aria-hidden className="h-5 w-1 rounded-full bg-[var(--color-brand)]" />
        Supported sites
      </h2>

      <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {sites.map((site) => (
          <li
            key={site.key}
            className="flex flex-col items-center gap-3 rounded-xl border border-[var(--color-edge)] bg-[var(--color-surface)] px-4 py-5 transition-colors hover:border-[var(--color-brand)]/40"
          >
            {site.hasLogo ? (
              // Bare on the card surface -- the logos are transparent PNGs. Only marks
              // measured as illegible on dark get a plate (see lib/sites.ts).
              <span
                className={
                  "grid h-12 w-full place-items-center overflow-hidden rounded-lg px-3 " +
                  (site.needsLightBacking ? "bg-white" : "")
                }
              >
                <Image
                  src={site.logo}
                  alt=""
                  width={site.width}
                  height={site.height}
                  sizes="160px"
                  className="h-9 w-full object-contain"
                />
              </span>
            ) : (
              <span
                aria-hidden
                className="grid h-12 w-full place-items-center rounded-lg text-lg font-bold"
                style={{ backgroundColor: site.tint, color: onTint(site.tint) }}
              >
                {siteMonogram(site.label)}
              </span>
            )}
            <span className="text-center text-sm font-medium text-[var(--color-fg)]">
              {site.label}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

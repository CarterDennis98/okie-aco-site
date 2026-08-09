import Image from "next/image";
import { onTint, siteMonogram, siteStyle } from "@/lib/sites";

/**
 * Retailer chip: logo + name on a low-alpha tint of the retailer's brand colour.
 *
 * Identity comes from the logo and the label. The tint sits behind readable foreground
 * text at ~14% alpha, so it never has to clear a contrast threshold on its own -- which
 * matters, because several retailer brand colours can't (see lib/sites.ts).
 *
 * `logo` is resolved on the SERVER (resolveSiteLogo in db/queries/public.ts) and passed
 * in. This renders inside the client-side carousel, so it must not touch the
 * filesystem -- doing so pulls node:fs into the browser bundle and Turbopack hard-fails.
 */
export function SiteChip({ site, logo }: { site: string | null; logo?: string | null }) {
  if (!site) return null;
  const style = siteStyle(site);

  return (
    <span
      className="inline-flex shrink-0 items-center gap-1.5 rounded-full py-1 pr-2.5 pl-1 text-[11px] font-medium text-[var(--color-fg)]"
      style={{
        backgroundColor: `color-mix(in oklab, ${style.tint} 14%, transparent)`,
        boxShadow: `inset 0 0 0 1px color-mix(in oklab, ${style.tint} 35%, transparent)`,
      }}
    >
      {logo ? (
        // Bare by default -- these are transparent PNGs and a white plate behind every
        // one looked pasted on. Only marks measured as illegible on the dark surface
        // get a tile (see needsLightBacking in lib/sites.ts).
        <span
          className={
            "grid h-4 w-5 shrink-0 place-items-center overflow-hidden rounded-[3px] " +
            (style.needsLightBacking ? "bg-white px-px" : "")
          }
        >
          <Image
            src={logo}
            alt=""
            width={style.width}
            height={style.height}
            sizes="40px"
            // Fixed box, not w-auto: with auto width the element collapses to 0 until
            // the image loads, so the icon is invisible then shifts layout on arrival.
            className="h-3.5 w-full object-contain"
          />
        </span>
      ) : (
        <span
          aria-hidden
          className="grid h-4 w-5 place-items-center rounded-[3px] text-[8px] font-bold"
          style={{ backgroundColor: style.tint, color: onTint(style.tint) }}
        >
          {siteMonogram(style.label)}
        </span>
      )}
      {style.label}
    </span>
  );
}

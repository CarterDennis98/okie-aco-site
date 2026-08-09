import Image from "next/image";
import type { Drop } from "@/db/queries/public";
import { count, plural } from "@/lib/format";
import { SiteChip } from "@/components/site-chip";

/**
 * One drop, with its top items as a horizontal bar chart.
 *
 * Chart decisions follow the dataviz method: product names are nominal, so every bar
 * wears the SAME hue rather than being shaded by value -- bar length already encodes
 * magnitude, and colouring by it would spend the identity channel twice. One series,
 * so no legend. Values live in an aligned right-hand column instead of at the bar tip
 * so a 2-unit bar can never collide with or clip its own label next to a 288-unit one.
 */

const DATE_FORMAT: Intl.DateTimeFormatOptions = {
  month: "short",
  day: "numeric",
  timeZone: "America/Chicago",
};

function ItemThumb({ src }: { src: string | null }) {
  if (!src) {
    return (
      <div
        aria-hidden
        className="size-8 shrink-0 rounded border border-[var(--color-edge)] bg-[var(--color-elevated)]"
      />
    );
  }
  return (
    <Image
      src={src}
      alt=""
      width={32}
      height={32}
      className="size-8 shrink-0 rounded border border-[var(--color-edge)] bg-white object-contain"
    />
  );
}

export function DropCard({ drop }: { drop: Drop }) {
  const max = Math.max(...drop.topItems.map((i) => i.units), 1);
  const date = new Intl.DateTimeFormat("en-US", DATE_FORMAT).format(drop.startedAt);

  return (
    <article className="rounded-xl border border-[var(--color-edge)] bg-[var(--color-surface)] p-5">
      <header className="mb-4 flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <h3 className="text-base font-bold text-white">{date}</h3>
        <SiteChip site={drop.site} logo={drop.siteLogo} />
      </header>

      <dl className="mb-5 flex divide-x divide-[var(--color-edge)] rounded-lg bg-[var(--color-elevated)]/50">
        {[
          { label: "Checkouts", value: drop.checkouts },
          { label: "Units", value: drop.units },
          { label: "Members", value: drop.members },
        ].map((stat) => (
          <div key={stat.label} className="flex-1 px-3 py-2.5 text-center">
            <dd className="text-lg font-bold text-white">{count(stat.value)}</dd>
            <dt className="text-[10px] tracking-[0.12em] text-[var(--color-muted)] uppercase">
              {stat.label}
            </dt>
          </div>
        ))}
      </dl>

      <ul className="flex flex-col gap-3">
        {drop.topItems.map((item) => (
          <li key={item.id} className="flex items-center gap-3">
            <ItemThumb src={item.imageUrl} />
            <div className="min-w-0 flex-1">
              <p className="mb-1.5 truncate text-xs text-[var(--color-fg)]">{item.label}</p>
              <div
                className="h-2 overflow-hidden rounded-sm bg-[var(--color-elevated)]"
                role="img"
                aria-label={`${item.units} ${plural(item.units, "unit")}`}
              >
                <div
                  className="h-full rounded-r-[4px]"
                  style={{
                    // min-width keeps a tiny bar visible beside a dominant one
                    // without overstating it
                    width: `max(3px, ${(item.units / max) * 100}%)`,
                    backgroundColor: "var(--color-brand)",
                  }}
                />
              </div>
            </div>
            {/* Aligned column of numbers -- where tabular-nums belongs */}
            <span className="w-10 shrink-0 text-right text-sm font-semibold text-white tabular-nums">
              {count(item.units)}
            </span>
          </li>
        ))}
      </ul>

      {drop.otherItems > 0 && (
        <p className="mt-3 text-xs text-[var(--color-muted)]">
          + {drop.otherItems} more {plural(drop.otherItems, "product")}
        </p>
      )}
    </article>
  );
}

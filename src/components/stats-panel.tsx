"use client";

import { useState } from "react";
import type { Drop, RangeStats, StatsRange } from "@/db/queries/public";
import { DropsCarousel } from "@/components/drops-carousel";
import { count } from "@/lib/format";

/**
 * Headline numbers are STAT TILES, not a chart -- three values with no time dimension
 * is exactly the case the form heuristic says isn't a chart. Proportional figures
 * (not tabular) because tabular-nums gives every digit the width of a zero, which
 * reads loose at display sizes; tabular is for aligned columns.
 */
function StatTile({ value, label }: { value: number; label: string }) {
  return (
    <div className="flex-1 px-4 py-5 text-center sm:px-5">
      <div className="text-3xl font-bold text-white sm:text-4xl">{count(value)}</div>
      <div className="mt-1.5 text-[11px] font-medium tracking-[0.14em] text-[var(--color-muted)] uppercase">
        {label}
      </div>
    </div>
  );
}

export type StatsPanelData = { stats: RangeStats; drops: Drop[] };

export function StatsPanel({ recent, all }: { recent: StatsPanelData; all: StatsPanelData }) {
  const [range, setRange] = useState<StatsRange>("recent");
  const { stats, drops } = range === "recent" ? recent : all;

  const options: { value: StatsRange; label: string }[] = [
    { value: "recent", label: "Last 30 days" },
    { value: "all", label: "All time" },
  ];

  return (
    <section aria-label="Checkout activity">
      {/* Filters in one row above the data. */}
      <div
        role="group"
        aria-label="Time range"
        className="mb-3 inline-flex rounded-lg border border-[var(--color-edge)] bg-[var(--color-surface)] p-0.5"
      >
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            onClick={() => setRange(option.value)}
            aria-pressed={range === option.value}
            className={
              "rounded-md px-3 py-1.5 text-xs font-medium transition-colors " +
              (range === option.value
                ? "bg-[var(--color-brand)] text-[var(--color-on-brand)]"
                : "text-[var(--color-muted)] hover:text-[var(--color-fg)]")
            }
          >
            {option.label}
          </button>
        ))}
      </div>

      <div className="flex divide-x divide-[var(--color-edge)] rounded-xl border border-[var(--color-edge)] bg-[var(--color-surface)]">
        <StatTile value={stats.checkouts} label="Checkouts" />
        <StatTile value={stats.units} label="Units" />
        <StatTile value={stats.members} label="Members" />
      </div>

      <DropsCarousel drops={drops} />
    </section>
  );
}

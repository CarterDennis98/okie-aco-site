"use client";

import { useState } from "react";
import type { Drop } from "@/db/queries/public";
import { DropCard } from "@/components/drop-card";

const PER_PAGE = 3;

/**
 * Pages through recent drops three at a time.
 *
 * All drops are already on the client (the server sends up to 12), so paging is
 * instant and needs no extra request. Deliberately not an auto-advancing carousel:
 * this is reference data people read, not a hero banner, and self-moving content is
 * hostile to anyone reading slowly.
 */
export function DropsCarousel({ drops }: { drops: Drop[] }) {
  const [page, setPage] = useState(0);
  const pages = Math.ceil(drops.length / PER_PAGE);

  if (drops.length === 0) return null;

  // Clamped during render rather than corrected in an effect: if the range toggle
  // shrinks the list the view can't strand past the end, and there's no second
  // render pass to get there.
  // Functional updaters below, so two clicks landing in one React batch still
  // advance twice rather than collapsing into one.
  const safePage = Math.min(page, Math.max(0, pages - 1));
  const start = safePage * PER_PAGE;
  const visible = drops.slice(start, start + PER_PAGE);
  const multiPage = pages > 1;

  return (
    <section aria-labelledby="recent-drops-heading" className="mt-8">
      {/* The arrows live in the heading row rather than flanking the cards.
          Flanking them meant centring on a row whose height changes with the number
          of product rows per card, so the buttons jumped vertically on every page
          change. Anchoring to the heading is stable by construction -- no magic
          offset, no measuring card heights. */}
      <div className="mb-4 flex items-center justify-between gap-4">
        <h2
          id="recent-drops-heading"
          className="flex items-center gap-2.5 text-xl font-bold tracking-tight"
        >
          <span aria-hidden className="h-5 w-1 rounded-full bg-[var(--color-brand)]" />
          Recent drops
        </h2>

        {multiPage && (
          <div className="flex shrink-0 gap-2">
            <PageButton
              label="Previous drops"
              disabled={safePage === 0}
              onClick={() => setPage((p) => Math.max(0, Math.min(p, pages - 1) - 1))}
              direction="left"
            />
            <PageButton
              label="Next drops"
              disabled={safePage === pages - 1}
              onClick={() => setPage((p) => Math.min(pages - 1, Math.min(p, pages - 1) + 1))}
              direction="right"
            />
          </div>
        )}
      </div>

      {/* grid-cols-1 is load-bearing: without an explicit column the implicit track
          is auto-sized and the cards grow to their longest product name, overflowing
          the container. grid-cols-N compiles to minmax(0, 1fr), which doesn't. */}
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
        {visible.map((drop) => (
          <DropCard key={drop.id} drop={drop} />
        ))}
      </div>

      {/* The position readout is visual clutter, but a screen reader still needs to
          know the view moved. */}
      {multiPage && (
        <p aria-live="polite" className="sr-only">
          Showing drops {start + 1} to {Math.min(start + PER_PAGE, drops.length)} of {drops.length}
        </p>
      )}
    </section>
  );
}

function PageButton({
  label,
  disabled,
  onClick,
  direction,
}: {
  label: string;
  disabled: boolean;
  onClick: () => void;
  direction: "left" | "right";
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      className="grid size-9 shrink-0 place-items-center rounded-full border border-[var(--color-edge)] bg-[var(--color-surface)] text-[var(--color-fg)] transition-colors hover:bg-[var(--color-elevated)] disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-[var(--color-surface)]"
    >
      <svg
        viewBox="0 0 24 24"
        className="size-4"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        <path d={direction === "left" ? "m15 18-6-6 6-6" : "m9 18 6-6-6-6"} />
      </svg>
    </button>
  );
}

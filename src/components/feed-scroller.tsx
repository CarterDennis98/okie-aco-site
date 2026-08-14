"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Scroll pane for the checkout feed, with rows dissolving into the container edges.
 *
 * A thin client wrapper on purpose: it owns one passive scroll listener and renders
 * `children` untouched, so the 250 feed rows stay server-rendered rather than becoming
 * client-component payload.
 *
 * The fade is two gradient overlays whose OPACITY transitions, not a mask driven by
 * custom properties. Two earlier approaches failed in practice and are worth not
 * repeating:
 *
 *   1. Per-row `animation-timeline: view()`. Correctly wired -- right scroller, right
 *      ranges, playState running -- but every ViewTimeline reported currentTime null,
 *      so nothing animated, in view or out.
 *   2. A mask sized by @property custom properties with a transition. The rules
 *      compiled and matched, but the transitioned property froze at its start value;
 *      setting `transition: none` immediately resolved it to the correct 56px.
 *
 * Opacity is interpolable everywhere and needs no registration, so this just works.
 */

const FADE_HEIGHT = "3.5rem";

export function FeedScroller({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  const ref = useRef<HTMLUListElement>(null);
  const [edges, setEdges] = useState({ atTop: true, atBottom: false });

  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    // 2px tolerance: fractional scroll offsets mean scrollTop rarely lands exactly on
    // 0 or the maximum, which would leave an edge permanently faded.
    const atTop = el.scrollTop <= 2;
    const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 2;
    setEdges((prev) =>
      prev.atTop === atTop && prev.atBottom === atBottom ? prev : { atTop, atBottom },
    );
  }, []);

  useEffect(() => {
    measure();
    const el = ref.current;
    if (!el) return;
    // Resize matters too: a narrower viewport reflows rows and can change whether the
    // list overflows at all.
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [measure]);

  return (
    <div className="relative">
      <ul ref={ref} onScroll={measure} className={className}>
        {children}
      </ul>

      {/* Only fade an edge that actually has more content past it, so the first row is
          crisp at rest and the last row is crisp at the bottom. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-px top-px rounded-t-xl transition-opacity duration-300"
        style={{
          height: FADE_HEIGHT,
          opacity: edges.atTop ? 0 : 1,
          backgroundImage: "linear-gradient(to bottom, var(--color-surface) 0%, transparent 100%)",
        }}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-px bottom-px rounded-b-xl transition-opacity duration-300"
        style={{
          height: FADE_HEIGHT,
          opacity: edges.atBottom ? 0 : 1,
          backgroundImage: "linear-gradient(to top, var(--color-surface) 0%, transparent 100%)",
        }}
      />
    </div>
  );
}

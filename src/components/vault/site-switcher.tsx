"use client";

import { useState } from "react";
import Image from "next/image";
import type { VaultProfileSummary } from "@/db/queries/vault";
import { siteStyle } from "@/lib/sites";
import { ProfileManager } from "@/components/vault/profile-manager";

/**
 * One retailer at a time.
 *
 * Rendering every site stacked meant a member with profiles on three retailers scrolled
 * past a hundred rows to reach the third. The chips pick one; the rest stay mounted-free
 * rather than hidden, so a 700-row site costs nothing until it's selected.
 *
 * Client-side rather than a URL param: switching retailers is a view preference, not a
 * place, and a round trip to re-render a list the browser already has would be slower
 * for no benefit. The selection resets on reload, which is fine -- there is no wrong
 * retailer to land on.
 */
export function SiteSwitcher({
  siteKeys,
  profilesBySite,
  nextNames,
  logos,
}: {
  siteKeys: string[];
  profilesBySite: Record<string, VaultProfileSummary[]>;
  nextNames: Record<string, string>;
  logos: Record<string, string | null>;
}) {
  // Open the retailer they actually use, not whichever sorts first. Every self-serve
  // retailer is listed now, including ones they have nothing on, so keying off position
  // would greet a Target-only member with an empty Pokémon Center tab. Ties break on the
  // existing order, and a member with nothing anywhere still lands somewhere valid.
  const [active, setActive] = useState(() => {
    let best = siteKeys[0] ?? "";
    let most = -1;
    for (const key of siteKeys) {
      const count = profilesBySite[key]?.length ?? 0;
      if (count > most) {
        most = count;
        best = key;
      }
    }
    return best;
  });

  if (siteKeys.length === 0) return null;

  return (
    <section className="mt-10">
      <div className="flex flex-wrap items-center gap-2">
        {siteKeys.map((key) => {
          const style = siteStyle(key);
          const count = profilesBySite[key]?.length ?? 0;
          const isActive = key === active;
          const logo = logos[key];

          return (
            <button
              key={key}
              type="button"
              onClick={() => setActive(key)}
              aria-pressed={isActive}
              className={
                "inline-flex items-center gap-2 rounded-full py-1.5 pr-3.5 pl-1.5 text-sm font-medium transition-colors " +
                (isActive ? "text-white" : "text-[var(--color-muted)] hover:text-[var(--color-fg)]")
              }
              style={{
                backgroundColor: isActive
                  ? `color-mix(in oklab, ${style.tint} 20%, transparent)`
                  : "var(--color-surface)",
                boxShadow: isActive
                  ? `inset 0 0 0 1px color-mix(in oklab, ${style.tint} 55%, transparent)`
                  : "inset 0 0 0 1px var(--color-edge)",
              }}
            >
              {logo ? (
                <Image
                  src={logo}
                  alt=""
                  width={20}
                  height={20}
                  className="size-5 rounded-full object-contain"
                  style={
                    style.needsLightBacking ? { backgroundColor: "#fff", padding: 1 } : undefined
                  }
                />
              ) : (
                <span
                  aria-hidden
                  className="size-5 rounded-full"
                  style={{ backgroundColor: style.tint }}
                />
              )}
              {style.label}
              <span className={isActive ? "text-white/70" : "text-[var(--color-muted)]"}>
                {count}
              </span>
            </button>
          );
        })}
      </div>

      <ProfileManager
        key={active}
        siteKey={active}
        siteLogo={logos[active] ?? null}
        profiles={profilesBySite[active] ?? []}
        nextName={nextNames[active] ?? ""}
      />
    </section>
  );
}

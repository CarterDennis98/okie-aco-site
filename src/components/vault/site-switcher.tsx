"use client";

import { useState } from "react";
import Image from "next/image";
import type { VaultLoginSummary, VaultProfileSummary } from "@/db/queries/vault";
import type { AddressBook } from "@/lib/vault/address-book";
import { siteStyle, siteUsesProfiles } from "@/lib/sites";
import { FlaggedProfiles } from "@/components/vault/flagged-profiles";
import { LoginManager } from "@/components/vault/login-manager";
import { ProfileManager } from "@/components/vault/profile-manager";

/** The Flagged tab's key among the retailer keys. No retailer key starts with an underscore. */
const FLAGGED = "_flagged";

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
 *
 * A LOGIN-ONLY retailer gets LoginManager instead of ProfileManager -- a login there holds
 * an email and a password and no card or address at all, so the profile list would be five
 * empty columns. See `usesProfiles` in sites.ts; no retailer is login-only today.
 *
 * Everywhere else a login with no profile behind it is one WAITING TO BE FINISHED -- every
 * Costco login saved before Costco took full profiles -- and ProfileManager lists those
 * above the profiles. The chip counts both: a member whose only Costco row is a login to
 * finish should land on Costco, not on an empty Target tab.
 *
 * FLAGGED, first in the row whenever anything is: every profile with failed checkouts
 * counting against it, across retailers (FlaggedProfiles). Orange, or red when any of them is
 * high risk. It doesn't open by default -- a member with one flag among 700 profiles still
 * lands on their retailer -- but it sits where the eye starts, in the flag's own colour.
 */
export function SiteSwitcher({
  siteKeys,
  profilesBySite,
  loginsBySite,
  nextNames,
  renumbered,
  logos,
  addressBook,
}: {
  siteKeys: string[];
  profilesBySite: Record<string, VaultProfileSummary[]>;
  loginsBySite: Record<string, VaultLoginSummary[]>;
  nextNames: Record<string, string>;
  /** Each position's name after a reorder, per retailer. See getProfileNaming. */
  renumbered: Record<string, string[]>;
  logos: Record<string, string | null>;
  /** The member's saved addresses and cards, for the profile form's pickers. */
  addressBook: AddressBook;
}) {
  // What a chip counts, and what "most" means when picking which one opens. On a login-only
  // retailer the logins are the rows; elsewhere they are the ones still to be finished.
  const countFor = (key: string) =>
    (siteUsesProfiles(key) ? (profilesBySite[key]?.length ?? 0) : 0) +
    (loginsBySite[key]?.length ?? 0);

  // Open the retailer they actually use, not whichever sorts first. Every self-serve
  // retailer is listed now, including ones they have nothing on, so keying off position
  // would greet a Target-only member with an empty Pokémon Center tab. Ties break on the
  // existing order, and a member with nothing anywhere still lands somewhere valid.
  const [active, setActive] = useState(() => {
    let best = siteKeys[0] ?? "";
    let most = -1;
    for (const key of siteKeys) {
      const count = countFor(key);
      if (count > most) {
        most = count;
        best = key;
      }
    }
    return best;
  });

  if (siteKeys.length === 0) return null;

  const flagged = siteKeys.flatMap((key) => profilesBySite[key] ?? []).filter((p) => p.failures);
  const anyHigh = flagged.some((p) => p.failures?.risk === "high");
  const flagTint = anyHigh ? "var(--color-brand)" : "var(--color-risk)";
  const onFlagged = active === FLAGGED;

  return (
    <section className="mt-10">
      <div className="flex flex-wrap items-center gap-2">
        {/* Kept while it is open even once it empties, so fixing the last one doesn't yank
            the member to another tab mid-read: they see the all-clear instead. */}
        {(flagged.length > 0 || onFlagged) && (
          <button
            type="button"
            onClick={() => setActive(FLAGGED)}
            aria-pressed={onFlagged}
            className={
              "inline-flex items-center gap-2 rounded-full py-1.5 pr-3.5 pl-2.5 text-sm font-medium transition-colors " +
              (onFlagged ? "text-white" : "text-[var(--color-fg)] hover:text-white")
            }
            style={{
              backgroundColor: `color-mix(in oklab, ${flagTint} ${onFlagged ? 28 : 14}%, transparent)`,
              boxShadow: `inset 0 0 0 1px color-mix(in oklab, ${flagTint} ${onFlagged ? 70 : 45}%, transparent)`,
            }}
          >
            <span aria-hidden>⚠</span>
            Flagged
            <span className={onFlagged ? "text-white/70" : "text-[var(--color-muted)]"}>
              {flagged.length}
            </span>
          </button>
        )}
        {siteKeys.map((key) => {
          const style = siteStyle(key);
          const count = countFor(key);
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

      {onFlagged ? (
        <FlaggedProfiles
          profiles={flagged}
          profilesBySite={profilesBySite}
          logos={logos}
          addressBook={addressBook}
        />
      ) : siteUsesProfiles(active) ? (
        <ProfileManager
          key={active}
          siteKey={active}
          siteLogo={logos[active] ?? null}
          profiles={profilesBySite[active] ?? []}
          unfinished={loginsBySite[active] ?? []}
          nextName={nextNames[active] ?? ""}
          renumbered={renumbered[active] ?? []}
          addressBook={addressBook}
        />
      ) : (
        <LoginManager
          key={active}
          siteKey={active}
          siteLogo={logos[active] ?? null}
          logins={loginsBySite[active] ?? []}
        />
      )}
    </section>
  );
}

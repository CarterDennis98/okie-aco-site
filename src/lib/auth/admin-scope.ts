import { siteKey } from "@/lib/sites";

/**
 * Who administers what.
 *
 * Two allowlists, both read from the environment on every request, never from the
 * database and never from a Discord role:
 *
 *   ADMIN_DISCORD_IDS       full admins -- every retailer, every mailbox, every charge.
 *   SITE_ADMIN_DISCORD_IDS  site admins -- someone who runs ONE retailer's bot and
 *                           administers that retailer and nothing else:
 *                             SITE_ADMIN_DISCORD_IDS="crunchyroll:397045810996576266"
 *                           `site:id` pairs, comma-separated. The same id may appear more
 *                           than once to cover several retailers.
 *
 * An allowlist rather than a role for the reason the full one is: a site admin can download
 * that retailer's profiles, cards and security codes included, and a role assigned by
 * mistake -- or a database write -- must never be enough to hand that out. A redeploy is the
 * right amount of friction for giving someone members' card data.
 *
 * Pure, and kept apart from guard.ts, so the parsing can be tested without a database.
 */

/** Every retailer, for a full admin. */
export const ALL_SITES = "all" as const;

export type AdminSites = typeof ALL_SITES | readonly string[];

/** `process.env`, or a stand-in for it in a test. Only the two allowlists are read. */
type Env = Record<string, string | undefined>;

function fullAdminIds(env: Env): Set<string> {
  return new Set(
    (env.ADMIN_DISCORD_IDS ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean),
  );
}

/** Discord id -> the retailers they administer, keyed the way every other lookup is. */
function siteAdminMap(env: Env): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  for (const entry of (env.SITE_ADMIN_DISCORD_IDS ?? "").split(",")) {
    const separator = entry.indexOf(":");
    if (separator < 0) continue;
    const site = entry.slice(0, separator).trim();
    const id = entry.slice(separator + 1).trim();
    // An entry missing either half grants nothing, rather than guessing which half it meant.
    if (!site || !/^\d{15,25}$/.test(id)) continue;
    const sites = map.get(id) ?? new Set<string>();
    sites.add(siteKey(site));
    map.set(id, sites);
  }
  return map;
}

/**
 * What one member may administer: every retailer, a list of them, or none (empty).
 *
 * A full admin who is also listed as a site admin stays a full admin -- the narrower entry
 * never demotes the wider one.
 */
export function adminSitesFor(discordUserId: string, env: Env = process.env): AdminSites {
  if (fullAdminIds(env).has(discordUserId)) return ALL_SITES;
  return [...(siteAdminMap(env).get(discordUserId) ?? [])].sort();
}

/** Whether these sites include this retailer. Normalizes, like every other site lookup. */
export function coversSite(sites: AdminSites, site: string | null | undefined): boolean {
  if (!site) return false;
  return sites === ALL_SITES || sites.includes(siteKey(site));
}

/** Whether there is anything at all to administer -- what decides if the Admin tab shows. */
export function hasAdminArea(sites: AdminSites): boolean {
  return sites === ALL_SITES || sites.length > 0;
}

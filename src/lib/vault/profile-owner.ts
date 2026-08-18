/**
 * Working out whose profile an AYCD export row is.
 *
 * The Target import could lean on `profileMap.json` family matching. The Walmart and
 * Pokémon Center exports can't: their names use four different schemes, accumulated over
 * a year of the operator naming profiles however was convenient at the time.
 *
 *   "Walmart 12"                                    the operator's own house profile
 *   "368995917677723650 iboo_123 Walmart 1-#30"     owner's Discord id, right there
 *   "Walmart sahab #4"                              "<site> <member> #n"
 *   "mugiawara_sunny - 2"                           "<member> - n", the Target scheme
 *
 * Resolved in that order of confidence: an embedded Discord id needs no guessing at all,
 * a name match against the live guild roster is strong, and anything left goes to a map
 * file for the operator rather than being guessed at. Attributing a profile to the wrong
 * member hands them someone else's card.
 *
 * Pure: no database, no Discord. The caller supplies the roster and the known addresses.
 */

export type RosterEntry = {
  id: string;
  username: string;
  globalName?: string | null;
  nickname?: string | null;
};

export type OwnerResolution =
  | { kind: "house"; reason: string }
  | { kind: "member"; discordUserId: string; via: "id" | "email" | "name"; matched: string }
  | { kind: "unresolved"; base: string };

/**
 * "Walmart 12", "PKC 7", "Walmart Main" -- the operator's own, never billed.
 *
 * The trailing group allows AYCD's export noise: it renames colliding profiles to
 * "Walmart 82-!50" / "PKC 32-!5176", and without it those read as a member called "82-".
 */
const HOUSE =
  /^(walmart|pkc|target|best buy|sams? club)(\s+main)?(\s*\d+)?(\s*-\s*[!@#$%^&]?\w*)?\s*$/i;

/** A leading Discord snowflake is authoritative. */
const LEADING_ID = /^(\d{15,25})\b/;

/** "Walmart sahab #4" / "PKC sahab #4". */
const SITE_OWNER_HASH = /^(?:walmart|pkc|target|best buy|sams? club)\s+(.+?)\s*#\s*\d+\s*$/i;

/** A trailing " - 4" or AYCD's "-!50" / "-@27" junk suffix. */
const TRAILING_SUFFIX = /\s*-\s*[!@#$%^&]?\w*\d+\w*\s*$/;

export function houseName(name: string): boolean {
  return HOUSE.test(name.trim());
}

/**
 * The member-identifying part of a profile name, lowercased.
 *
 * Strips the site prefix, the "#n" or " - n" index, and AYCD's suffix noise, leaving
 * what should be a Discord username.
 */
export function memberBase(name: string): string {
  const trimmed = name.trim();

  const hashed = trimmed.match(SITE_OWNER_HASH);
  if (hashed) return hashed[1].trim().toLowerCase();

  // "<id> <username> Walmart 3-%62" -- drop the id and the trailing site+index.
  const withId = trimmed.match(LEADING_ID);
  if (withId) {
    const rest = trimmed.slice(withId[0].length).trim();
    const withoutSite = rest.replace(/\s+(walmart|pkc|target|best buy|sams? club)\b.*$/i, "");
    return withoutSite.trim().toLowerCase();
  }

  return trimmed.replace(TRAILING_SUFFIX, "").trim().toLowerCase();
}

export function buildRosterIndex(roster: RosterEntry[]): {
  ids: Set<string>;
  byName: Map<string, string>;
} {
  const ids = new Set<string>();
  const byName = new Map<string, string>();
  for (const entry of roster) {
    ids.add(entry.id);
    for (const candidate of [entry.username, entry.globalName, entry.nickname]) {
      if (!candidate) continue;
      const key = candidate.trim().toLowerCase();
      // First writer wins: two members sharing a display name must not silently
      // overwrite each other into one owner.
      if (key && !byName.has(key)) byName.set(key, entry.id);
    }
  }
  return { ids, byName };
}

export function resolveOwner(input: {
  name: string;
  email: string;
  /** Lowercased address -> the member who already owns an account on that address. */
  ownerByEmail: Map<string, string>;
  roster: { ids: Set<string>; byName: Map<string, string> };
  /** Lowercased name -> Discord id, filled in by hand for what nothing else resolves. */
  overrides: Map<string, string>;
}): OwnerResolution {
  const name = input.name.trim();

  // 1. An id embedded in the name. Nothing to guess.
  const withId = name.match(LEADING_ID);
  if (withId && input.roster.ids.has(withId[1])) {
    return { kind: "member", discordUserId: withId[1], via: "id", matched: withId[1] };
  }

  // 2. House profiles. Checked after the id so an id-prefixed name never reads as one.
  if (houseName(name)) return { kind: "house", reason: "house naming scheme" };

  // 3. An address we already know the owner of, from another site's accounts.
  const email = input.email.trim().toLowerCase();
  const byEmail = input.ownerByEmail.get(email);
  if (byEmail) return { kind: "member", discordUserId: byEmail, via: "email", matched: email };

  // 4. The name matches somebody currently in the guild.
  const base = memberBase(name);
  const override = input.overrides.get(base);
  if (override) return { kind: "member", discordUserId: override, via: "name", matched: base };

  const byName = input.roster.byName.get(base);
  if (byName) return { kind: "member", discordUserId: byName, via: "name", matched: base };

  return { kind: "unresolved", base };
}

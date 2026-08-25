/**
 * Which Discord member a checkout profile belongs to, when it is obvious.
 *
 * WHY THIS EXISTS. A checkout reaches the member it belongs to through exactly one
 * column, `profiles.discord_user_id`, and until this ran nothing in the app ever wrote
 * it -- only `prisma db seed`, from a snapshot of the bot's data/profileMap.json. The
 * ingest route creates an unseen profile as UNMAPPED and left it that way forever.
 *
 * The BOT resolves profiles through its own copy of that file plus a fuzzy match against
 * the guild roster (okie-aco-mirror/src/pas/profiles.js), so it happily bills a member
 * whose profile the site has never mapped. The result is a charge whose "Checkouts"
 * expansion on /admin/charges is empty, and a member dashboard missing orders they know
 * they got. `scripts/verify-attribution.ts` measures the gap.
 *
 * DELIBERATELY STRICTER THAN THE BOT. The bot auto-accepts at 0.95, which includes its
 * prefix and substring rules; this accepts only an EXACT match on the normalized name,
 * and only when exactly one member owns that name. Attributing someone's checkouts to
 * the wrong person is worse than leaving a profile unmapped, and unmapped is visible --
 * the verify script lists it, and the operator can map it in the bot.
 *
 * Pure: no database and no `server-only`, so the ingest route and the tests share it.
 */

/**
 * Port of `normalizeName` in okie-aco-mirror/src/pas/profiles.js.
 *
 * NOT the same thing as a profile key. `normalizeProfile` in lib/normalize.ts produces
 * keys, which keep spaces and punctuation ("target reseller 4"); this strips both, so it
 * is only ever a comparison form for matching a name against a Discord account. Keeping
 * the two apart matters: collapsing punctuation into a key would merge "n0va.1e" and
 * "n0va1e" into one profile.
 */
export function normalizeName(value: string | null | undefined): string {
  return String(value ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]/g, "");
}

export type MemberName = {
  discordUserId: string;
  username: string;
  globalName?: string | null;
};

/**
 * The one member whose name this profile key is, or null.
 *
 * Null covers three different situations on purpose -- no match, more than one member
 * with the name, and a key that is not a person's name at all (house profiles like
 * "target reseller 4"). All three mean the same thing here: leave it for a human.
 */
export function matchProfileOwner(
  profileKey: string | null | undefined,
  members: MemberName[],
): string | null {
  const target = normalizeName(profileKey);
  if (!target) return null;

  // Distinct MEMBERS, not distinct names: one member matching on both their username and
  // their global name is still one member, and must not read as ambiguous.
  const matched = new Set<string>();
  for (const member of members) {
    if (normalizeName(member.username) === target || normalizeName(member.globalName) === target) {
      matched.add(member.discordUserId);
    }
  }

  if (matched.size !== 1) return null;
  return [...matched][0];
}

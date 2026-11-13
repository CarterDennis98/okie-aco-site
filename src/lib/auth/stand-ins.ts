import { fullAdminIds } from "@/lib/auth/admin-scope";

/**
 * Discord accounts standing in for a member's own, while that member is locked out of it.
 *
 * A member who loses their Discord account loses the site with it: sign-in is Discord's, and
 * everything they hold here -- their profiles and charges, and as a runner the profiles
 * assigned to them and the fees owed to them -- is keyed by the old account's id. Moving all
 * of that to a new id would be thousands of writes to reverse the day they get the account
 * back, and every bill already sent names the old one.
 *
 * So the new account STANDS IN for the old one. Signed in with it, the guard
 * (lib/auth/guard.ts) hands every page and action the OLD id: the same dashboard, the same
 * profiles and charges, and as a runner the same assignments, queue and fees. Nothing in the
 * database moves, so ending it is deleting the line.
 *
 * What a stand-in does NOT inherit is the old account's AUTHORITY. Membership and roles are
 * read from the account actually signed in: it has to be in the server, and hold the runner
 * role itself, like anybody else. Taking the role off the stand-in still cuts it off in
 * seconds, and the old account -- which may be in someone else's hands -- keeps only the roles
 * it still holds itself.
 *
 * NEVER FOR A FULL ADMIN, on either side. ADMIN_DISCORD_IDS is the one grant no code change
 * alone may hand out, and a stand-in for a full admin would be exactly that; put the new
 * account in ADMIN_DISCORD_IDS instead. `standingInFor` ignores such an entry.
 *
 * In code rather than the environment for the reason RUNNER_ROLES gives: who can reach whose
 * cards belongs in the history, next to the change that did it.
 */

/** Stand-in account -> the member's own account it stands in for. */
export const STAND_INS: Readonly<Record<string, string>> = {
  // CrispHeinz (Topps runner and payee) lost access to his Discord account on 2026-11-13 and
  // is on his alt, "Hulk Logan", until he has it back. Delete this line then; nothing else
  // needs undoing.
  "1471194582153957409": "1099014657127223417",
};

/** `process.env`, or a stand-in for it in a test. Only ADMIN_DISCORD_IDS is read. */
type Env = Record<string, string | undefined>;

/**
 * The member this signed-in account stands in for, or null when it is nobody's stand-in --
 * including when the entry would make or unmake a full admin, which is refused.
 */
export function standingInFor(discordUserId: string, env: Env = process.env): string | null {
  // Own keys only: "constructor" is not a snowflake, but a plain object inherits one.
  const original = Object.hasOwn(STAND_INS, discordUserId) ? STAND_INS[discordUserId] : null;
  if (!original || original === discordUserId) return null;
  const admins = fullAdminIds(env);
  if (admins.includes(original) || admins.includes(discordUserId)) return null;
  return original;
}

/**
 * The accounts standing in for this member right now -- whose runner roles count as theirs
 * when the question is "who runs this retailer". See db/queries/runners.ts.
 */
export function standInsFor(original: string, env: Env = process.env): string[] {
  return Object.keys(STAND_INS).filter((id) => standingInFor(id, env) === original);
}

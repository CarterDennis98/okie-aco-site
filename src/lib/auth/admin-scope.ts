import { siteKey, siteStyle } from "@/lib/sites";

/**
 * Who administers what.
 *
 * Two kinds of admin:
 *
 *   FULL ADMINS  ADMIN_DISCORD_IDS, an environment allowlist read on every request. Every
 *                retailer, every mailbox, every charge -- and the only people who can move a
 *                profile from one runner to another.
 *   RUNNERS      anyone holding one of the Discord roles in RUNNER_ROLES: somebody who runs
 *                a retailer's bot. Chess on Crunchyroll and Mattel, peacemaker on Premium
 *                Bandai, CrispHeinz on Topps, and whoever else is given the Target role to
 *                share that one.
 *
 * A runner's reach is TWO facts, and it takes both. The role says which retailers they MAY
 * be given; a full admin's assignment (VaultAccount.assigneeId) says which profiles they
 * actually have. So a role handed out by mistake opens nothing by itself -- the new runner
 * can be assigned profiles, and until a full admin does, their slice of the retailer is
 * empty. Taking the role away is the fast way to cut someone off; moving their profiles to
 * another runner is the other.
 *
 * Roles are read from `discord_members.roles`, which sign-in writes and the bot keeps
 * current between sign-ins (see /api/bot/runner-roles), so a role change lands in seconds
 * rather than at somebody's next login.
 *
 * The FULL-admin tier stays an allowlist, never a role: a full admin decides who gets which
 * members' cards, and a database write or a mis-clicked role must never be enough to hand
 * that power out. A redeploy is still the friction for that.
 *
 * Pure, and kept apart from guard.ts, so the rules can be tested without a database.
 */

/** Every retailer, for a full admin. */
export const ALL_SITES = "all" as const;

export type AdminSites = typeof ALL_SITES | readonly string[];

/**
 * The Discord role that makes someone a runner on each retailer, keyed by site key.
 *
 * In code rather than the environment for the reason payees.ts gives for its handles: which
 * role reaches members' card data belongs in the history, next to the change that made it.
 * Kept in step with RUNNER_ROLE_IDS in the bot (okie-aco-mirror/src/config.js), which is
 * the list it reports holders of.
 *
 * A retailer missing here has no runners -- only full admins reach it.
 */
export const RUNNER_ROLES: Readonly<Record<string, string>> = {
  crunchyroll: "1552031494975914034",
  "premium-bandai": "1553548824817963008",
  target: "1553941817626730526",
  "pokemon-center": "1553941945045487646",
  walmart: "1553942026851196959",
  topps: "1554199946633158881",
  mattel: "1554259902925373471",
};

/** `process.env`, or a stand-in for it in a test. Only ADMIN_DISCORD_IDS is read. */
type Env = Record<string, string | undefined>;

/** Full admins, in the order they are listed. */
export function fullAdminIds(env: Env = process.env): string[] {
  return [
    ...new Set(
      (env.ADMIN_DISCORD_IDS ?? "")
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean),
    ),
  ];
}

/**
 * The operator: the FIRST full admin listed. Whoever a profile goes to when nothing else
 * claims it -- see pickDefaultAssignee -- and who is owed a fee no runner is.
 *
 * Null when no full admin is configured at all, which nothing can work around: there is
 * then nobody to hold an unclaimed profile.
 */
export function operatorId(env: Env = process.env): string | null {
  return fullAdminIds(env)[0] ?? null;
}

/** The role that makes someone a runner on this retailer, or null if nobody can be one. */
export function runnerRoleFor(site: string | null | undefined): string | null {
  return RUNNER_ROLES[siteKey(site)] ?? null;
}

/** The retailers these roles make someone a runner on, sorted. */
export function runnerSitesFor(roles: readonly string[]): string[] {
  const held = new Set(roles);
  return Object.entries(RUNNER_ROLES)
    .filter(([, role]) => held.has(role))
    .map(([site]) => site)
    .sort();
}

/**
 * What one member may administer: every retailer, a list of them, or none (empty).
 *
 * A full admin who also holds runner roles stays a full admin -- the narrower grant never
 * demotes the wider one.
 */
export function adminSitesFor(
  discordUserId: string,
  roles: readonly string[],
  env: Env = process.env,
): AdminSites {
  if (fullAdminIds(env).includes(discordUserId)) return ALL_SITES;
  return runnerSitesFor(roles);
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

/**
 * Whether this viewer may download an export at all -- the export route's first check,
 * made before anything is read.
 *
 * A full admin may ask for anything; what they get is narrowed later, by the request
 * itself. A RUNNER gets exactly one of their own retailers, their own share of it, and:
 *
 *   PROFILES AND LOGINS  on any retailer they run.
 *   APP PASSWORDS        only where a bot reads the emailed code, and only for the mailboxes
 *                        behind their own assigned profiles there -- what their bot needs to
 *                        sign those members in. CrispHeinz's Alpine reads Topps's codes, so
 *                        the file for Topps holds the mailboxes behind the Topps profiles
 *                        assigned to CrispHeinz, and nobody else's.
 *
 * App passwords were full-admin only before that, and the reason still holds: a mailbox
 * serves every retailer its owner uses, so the file hands a runner read access to those
 * members' whole inboxes, not a Topps-shaped slice of them. That is the accepted cost of a
 * bot someone else runs having to read the code. What bounds it is the scope -- never
 * site-less (every mailbox on file), never another retailer's, never another runner's --
 * and the `vault_exports` row each download writes. The reveals and the IMAP page stay a
 * full admin's.
 */
export function mayExport(
  viewer: { discordUserId: string; adminSites: AdminSites },
  request: { site: string; format: string; runner: string | null },
): boolean {
  if (viewer.adminSites === ALL_SITES) return true;
  if (!coversSite(viewer.adminSites, request.site)) return false;
  if (request.runner !== null && request.runner !== viewer.discordUserId) return false;
  if (request.format === "imap") return siteStyle(request.site).usesEmailCodes !== false;
  return true;
}

// ---------------------------------------------------------------------------
// Whose profiles an admin page is showing
// ---------------------------------------------------------------------------

/** The `?runner=` value that means every runner's, for a full admin. */
export const EVERYONE = "all";

/**
 * Whose rows a vault read covers.
 *
 * Built once per request by `vaultScopeFor` and handed to every admin read that spans
 * profiles, logins or their changes. Undefined fields mean "no restriction", so `{}` is a
 * full admin looking at everyone's.
 */
export type VaultScope = {
  /** Retailers in reach. Undefined: every retailer. */
  sites?: readonly string[];
  /** Only rows assigned to this runner. Undefined: anyone's. */
  assigneeId?: string;
  /**
   * The change queue only: also the changes no runner owns, which are mailbox edits. They
   * belong to full admins, so a full admin's own queue includes them and a runner's never
   * does.
   */
  withUnassigned?: boolean;
};

/**
 * Whose profiles a page shows, from the viewer and the `?runner=` they asked for.
 *
 *   RUNNER      their own assigned profiles, on their own retailers, always. `requested` is
 *               ignored rather than honoured -- the URL can never widen a runner's view.
 *   FULL ADMIN  their OWN by default (plus the unowned mailbox changes), which is the set
 *               they load onto their bot. `?runner=all` is everyone's; `?runner=<id>` is one
 *               other runner's, which is how the operator checks what chess is holding.
 *
 * `runner` is what the page should render as selected: EVERYONE, or a Discord id.
 */
export function vaultScopeFor(
  viewer: { discordUserId: string; adminSites: AdminSites },
  requested?: string | null,
): { scope: VaultScope; runner: string } {
  const self = viewer.discordUserId;
  if (viewer.adminSites !== ALL_SITES) {
    return { scope: { sites: [...viewer.adminSites], assigneeId: self }, runner: self };
  }
  if (requested === EVERYONE) return { scope: {}, runner: EVERYONE };
  if (requested && requested !== self && /^\d{15,25}$/.test(requested)) {
    return { scope: { assigneeId: requested }, runner: requested };
  }
  return { scope: { assigneeId: self, withUnassigned: true }, runner: self };
}

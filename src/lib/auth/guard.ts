import "server-only";

import { notFound, redirect } from "next/navigation";
import { prisma } from "@/db/client";
import { auth } from "@/lib/auth";
import { ALL_SITES, adminSitesFor, hasAdminArea, type AdminSites } from "@/lib/auth/admin-scope";
import { standingInFor } from "@/lib/auth/stand-ins";

/**
 * The authorization boundary.
 *
 * **Every page, route handler, and server action calls a guard inside itself** -- never
 * in a parent layout, and never in `proxy.ts`. Both are UX layers, not security ones:
 * layouts don't re-render on navigation and don't wrap server actions, and Next's own
 * CVE-2025-29927 was a crafted header skipping middleware entirely. A Server Action is
 * an individually-addressable POST endpoint, so being rendered on a guarded page
 * protects it exactly as much as nothing.
 *
 * Two rules make the common vulnerabilities structurally impossible rather than
 * something to remember:
 *
 *   1. Member-scoped queries take the Discord ID from the guard's RETURN VALUE, never
 *      from a route param, search param, or form field.
 *   2. Where a resource id is in the URL, the query carries both predicates
 *      (`where: { id, discordUserId }`). Never fetch-then-compare.
 */

export type Viewer = {
  discordUserId: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  /** Re-derived from the database on every request, never read from the session. */
  isOg: boolean;
  /**
   * A FULL admin: every retailer, every mailbox, every charge, and the only kind that can
   * move a profile between runners. Re-derived from the environment on every request.
   *
   * It still means exactly what it meant before runners existed. Every check written
   * before them is a full-admin check, so adding them opened nothing up; a runner is
   * `false` here and gets in only where a page asks for `requireAnyAdmin()`.
   */
  isAdmin: boolean;
  /**
   * The retailers this viewer administers: "all" for a full admin, a runner's own list
   * (from their Discord roles), empty for everyone else. See lib/auth/admin-scope.ts.
   * Re-derived on every request, like `isAdmin`. A runner sees only the profiles ASSIGNED
   * to them on these -- see vaultScopeFor.
   */
  adminSites: AdminSites;
  /**
   * Who is actually signed in, when it is a stand-in for this member's own account (see
   * lib/auth/stand-ins.ts); null otherwise. For SAYING so, and nothing else: every read and
   * write goes on using `discordUserId`, which is the member's own id either way.
   */
  signedInAs: { discordUserId: string; displayName: string } | null;
};

const MEMBER_SELECT = {
  discordUserId: true,
  username: true,
  globalName: true,
  avatarHash: true,
  isOg: true,
  roles: true,
  leftAt: true,
} as const;

function avatarUrl(discordUserId: string, hash: string | null): string | null {
  if (!hash) return null;
  const ext = hash.startsWith("a_") ? "gif" : "png";
  return `https://cdn.discordapp.com/avatars/${discordUserId}/${hash}.${ext}`;
}

/**
 * The signed-in member, or null.
 *
 * Returns null for someone who has left the guild even though their session cookie is
 * still valid -- membership is a live fact, not something settled at login. They get
 * bounced to /signin, where the OAuth membership check gives them the real answer.
 */
export async function currentViewer(): Promise<Viewer | null> {
  const session = await auth();
  const signedIn = session?.user?.discordUserId;
  if (!signedIn) return null;

  // A stand-in account is the member it stands in for (lib/auth/stand-ins.ts). Both rows in
  // one read; there is only ever the one when it is nobody's stand-in.
  const original = standingInFor(signedIn);
  const rows = await prisma.discordMember.findMany({
    where: { discordUserId: { in: original ? [signedIn, original] : [signedIn] } },
    select: MEMBER_SELECT,
  });
  const account = rows.find((row) => row.discordUserId === signedIn);
  if (!account || account.leftAt) return null;

  // The member whose dashboard, profiles and charges these are. A stand-in for someone with
  // no row at all has nothing to stand in for, and signs in as itself.
  const member = (original && rows.find((row) => row.discordUserId === original)) || account;
  const standIn = member !== account;

  // Full admin is an environment allowlist, never a database column or a Discord role: a
  // write to Postgres, or a role handed out by mistake, must never be enough to grant
  // control over what members are billed. RUNNERS come from Discord roles -- read from the
  // row just fetched, which the bot keeps current -- and reach only what a full admin has
  // assigned them. See lib/auth/admin-scope.ts.
  //
  // The ROLES are always the signed-in account's own, stand-in or not: membership and
  // authority belong to the account somebody actually holds, so taking a role off a
  // stand-in cuts it off as fast as anyone. Only the id the roles are applied to -- whose
  // assignments, whose fees -- is the member's.
  const adminSites = adminSitesFor(member.discordUserId, account.roles);

  return {
    discordUserId: member.discordUserId,
    username: member.username,
    displayName: member.globalName ?? member.username,
    avatarUrl: avatarUrl(member.discordUserId, member.avatarHash),
    // Read off the roles, so off the same account as them.
    isOg: account.isOg,
    isAdmin: adminSites === ALL_SITES,
    adminSites,
    signedInAs: standIn
      ? {
          discordUserId: account.discordUserId,
          displayName: account.globalName ?? account.username,
        }
      : null,
  };
}

/** Signed-in members only. Redirects to sign-in otherwise. */
export async function requireMember(): Promise<Viewer> {
  const viewer = await currentViewer();
  if (!viewer) redirect("/signin");
  return viewer;
}

/**
 * Admins only.
 *
 * Deliberately 404, not 403: a 403 confirms the admin routes exist and are worth
 * probing. To a non-admin the admin area simply isn't there.
 */
export async function requireAdmin(): Promise<Viewer> {
  const viewer = await currentViewer();
  if (!viewer?.isAdmin) notFound();
  return viewer;
}

/**
 * Full admins AND runners -- anyone with something to administer.
 *
 * Only on the pages and actions that scope what they show by `vaultScopeFor` (and, for
 * charges, by who a bill is owed to). Everything else stays on `requireAdmin()`, which is
 * why the IMAP page, the mailbox reveals, the app-password sweeps and moving profiles
 * between runners are untouched: a mailbox serves every retailer its owner uses, so there
 * is no one-runner slice of it, and assigning is how a full admin decides who reaches whose
 * cards. The one app-password door a runner has is the export, narrowed to the mailboxes
 * behind their own profiles where their bot reads codes -- see mayExport.
 */
export async function requireAnyAdmin(): Promise<Viewer> {
  const viewer = await currentViewer();
  if (!viewer || !hasAdminArea(viewer.adminSites)) notFound();
  return viewer;
}

/**
 * Whose charges this admin handles: everyone's (undefined) for a full admin, only their own
 * for a runner -- the money owed to them, which is the money they can see arrive.
 *
 * Returned as the payee id rather than a `where` fragment so the queries and the actions
 * spell the predicate the same way, and so "undefined means everyone" is decided here once.
 */
export function chargeScopeOf(viewer: Viewer): string | undefined {
  return viewer.isAdmin ? undefined : viewer.discordUserId;
}

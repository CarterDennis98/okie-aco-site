import "server-only";

import { notFound, redirect } from "next/navigation";
import { prisma } from "@/db/client";
import { auth } from "@/lib/auth";
import { ALL_SITES, adminSitesFor, hasAdminArea, type AdminSites } from "@/lib/auth/admin-scope";

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
   * A FULL admin: every retailer, every mailbox, every charge. Re-derived from the
   * environment on every request.
   *
   * It still means exactly what it meant before site admins existed. Every check written
   * before them is a full-admin check, so adding them opened nothing up; a site admin is
   * `false` here and gets in only where a page asks for `requireAnyAdmin()`.
   */
  isAdmin: boolean;
  /**
   * The retailers this viewer administers: "all" for a full admin, a site admin's own
   * list, empty for everyone else. See lib/auth/admin-scope.ts. Re-derived from the
   * environment on every request, like `isAdmin`.
   */
  adminSites: AdminSites;
};

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
  const discordUserId = session?.user?.discordUserId;
  if (!discordUserId) return null;

  const member = await prisma.discordMember.findUnique({
    where: { discordUserId },
    select: {
      discordUserId: true,
      username: true,
      globalName: true,
      avatarHash: true,
      isOg: true,
      leftAt: true,
    },
  });
  if (!member || member.leftAt) return null;

  // Admin is an environment allowlist, not a database column or a Discord role. A write to
  // Postgres, or a role handed out by mistake, must never be enough to grant control over
  // what members are billed -- a redeploy is the right amount of friction for that.
  const adminSites = adminSitesFor(member.discordUserId);

  return {
    discordUserId: member.discordUserId,
    username: member.username,
    displayName: member.globalName ?? member.username,
    avatarUrl: avatarUrl(member.discordUserId, member.avatarHash),
    isOg: member.isOg,
    isAdmin: adminSites === ALL_SITES,
    adminSites,
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
 * Full admins AND site admins -- anyone with something to administer.
 *
 * Only on the pages and actions that scope what they show by `viewer.adminSites` (and, for
 * charges, by who a bill is owed to). Everything else stays on `requireAdmin()`, which is
 * why the IMAP page, the mailbox reveals, and the app-password sweeps are untouched: a
 * mailbox serves every retailer its owner uses, so there is no one-retailer slice of it.
 */
export async function requireAnyAdmin(): Promise<Viewer> {
  const viewer = await currentViewer();
  if (!viewer || !hasAdminArea(viewer.adminSites)) notFound();
  return viewer;
}

/**
 * Whose charges this admin handles: everyone's (undefined) for a full admin, only their own
 * for a site admin -- the money owed to them, which is the money they can see arrive.
 *
 * Returned as the payee id rather than a `where` fragment so the queries and the actions
 * spell the predicate the same way, and so "undefined means everyone" is decided here once.
 */
export function chargeScopeOf(viewer: Viewer): string | undefined {
  return viewer.isAdmin ? undefined : viewer.discordUserId;
}

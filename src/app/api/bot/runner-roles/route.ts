import { prisma } from "@/db/client";
import { RUNNER_ROLES } from "@/lib/auth/admin-scope";
import { authorizeBot } from "@/lib/bot-auth";
import { runnerRolesInput } from "@/types/runner-roles";

/**
 * Runner roles, kept current by the bot.
 *
 * A runner's reach starts with a Discord role (see lib/auth/admin-scope.ts), and the site
 * reads roles from `discord_members.roles` -- which sign-in writes and nothing else did.
 * So a role given on Discord did nothing until that person next logged in, and a role TAKEN
 * AWAY kept working for up to a month of session. The bot sees every role change as it
 * happens, and posts here: on startup, whenever someone gains or loses a runner role, and on
 * a timer as a backstop.
 *
 * ONLY RUNNER ROLES ARE TOUCHED. Each post is a full snapshot of the roles it names, and
 * only roles in RUNNER_ROLES are applied: someone listed gains the role, and anyone holding
 * it here who isn't listed loses it. Every other role in the array -- the OG role, anything
 * sign-in wrote -- is left exactly as it was, and an unknown role id is reported back rather
 * than written, so the bot can't hand out a role the site doesn't know it grants.
 *
 * A holder with no member row yet gets a provisional one, named from the bot, so a full
 * admin can assign them profiles before they have ever signed in. Sign-in overwrites it.
 *
 * Idempotent: posting the same snapshot twice changes nothing the second time.
 */
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const auth = authorizeBot(request);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Body is not JSON" }, { status: 400 });
  }

  const parsed = runnerRolesInput.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      {
        error: "Invalid payload",
        issues: parsed.error.issues.slice(0, 10).map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      },
      { status: 400 },
    );
  }

  const known = new Set(Object.values(RUNNER_ROLES));
  const posted = Object.keys(parsed.data.roles);
  const applied = posted.filter((role) => known.has(role));
  const ignored = posted.filter((role) => !known.has(role));

  // Member -> the applied roles they hold, and the names the bot knows them by.
  const holds = new Map<string, Set<string>>();
  const identity = new Map<string, { username: string; globalName: string | null }>();
  for (const role of applied) {
    for (const holder of parsed.data.roles[role]) {
      holds.set(holder.id, (holds.get(holder.id) ?? new Set()).add(role));
      identity.set(holder.id, { username: holder.username, globalName: holder.globalName ?? null });
    }
  }

  // Everyone whose row might change: the holders the bot named, and whoever the database
  // still thinks holds one of these roles.
  const rows =
    applied.length > 0
      ? await prisma.discordMember.findMany({
          where: {
            OR: [{ discordUserId: { in: [...holds.keys()] } }, { roles: { hasSome: applied } }],
          },
          select: { discordUserId: true, roles: true },
        })
      : [];

  let added = 0;
  let removed = 0;
  const updates = [];
  for (const row of rows) {
    const held = holds.get(row.discordUserId) ?? new Set<string>();
    // Existing order kept, lost roles dropped, new ones appended.
    const kept = row.roles.filter((role) => !applied.includes(role) || held.has(role));
    const gained = [...held].filter((role) => !row.roles.includes(role));
    const lost = row.roles.length - kept.length;
    if (gained.length === 0 && lost === 0) continue;

    added += gained.length;
    removed += lost;
    updates.push(
      prisma.discordMember.update({
        where: { discordUserId: row.discordUserId },
        data: { roles: [...kept, ...gained], syncedAt: new Date() },
      }),
    );
  }

  const existing = new Set(rows.map((row) => row.discordUserId));
  const missing = [...holds.keys()].filter((id) => !existing.has(id));
  if (missing.length > 0) {
    updates.push(
      prisma.discordMember.createMany({
        data: missing.map((id) => ({
          discordUserId: id,
          username: identity.get(id)!.username,
          globalName: identity.get(id)!.globalName,
          roles: [...holds.get(id)!],
        })),
        // A sign-in landing between the read above and this write already made the row,
        // with every role it holds -- nothing here would improve on that.
        skipDuplicates: true,
      }),
    );
    added += missing.reduce((sum, id) => sum + holds.get(id)!.size, 0);
  }

  if (updates.length > 0) await prisma.$transaction(updates);

  return Response.json({ applied, ignored, added, removed, created: missing.length });
}

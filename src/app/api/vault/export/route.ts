import { prisma } from "@/db/client";
import { requireMember } from "@/lib/auth/guard";
import { isKnownSite, siteStyle, siteUsesProfiles } from "@/lib/sites";
import { aycdFile, fileResponse } from "@/lib/vault/export-file";

/**
 * A member's own profiles on one retailer, as an AYCD profile file.
 *
 *   /api/vault/export?site=target
 *
 * The member's side of the operator's export (api/admin/vault/export), and the same file:
 * the same AYCD shape, the same phone rule, the same audit trail. What it leaves out is what
 * only matters when loading one of our bots. There is no bot split, no membership split and
 * no runner -- it is EVERY profile they hold on the retailer, enabled or not, because this is
 * their own copy of their own data rather than a load for a bot.
 *
 * Scoped by the guard's id alone. There is no `member` parameter to edit, so the only
 * profiles this can ever return are the signed-in member's.
 *
 * It DECRYPTS: the file holds full card numbers and security codes, which no page shows,
 * so it is recorded in `vault_exports` before anything is decrypted, exactly like the
 * operator's (scope "self"). No account passwords: AYCD's profile file has nowhere to put
 * one, and nothing gives a member a retailer password back.
 */
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const viewer = await requireMember();

  const site = new URL(request.url).searchParams.get("site") ?? "";
  if (!isKnownSite(site)) return new Response("Unknown retailer.", { status: 400 });
  // Normalized, so a hand-typed "Target" reads the same rows the page's "target" does.
  const { key: siteKey, label } = siteStyle(site);
  // A login-only retailer has no cards or addresses to put in a file, and an empty one
  // would read as "you saved nothing" rather than "this retailer stores none".
  if (!siteUsesProfiles(siteKey)) {
    return new Response(
      `${label} stores a login only — there are no checkout profiles to export.`,
      {
        status: 400,
      },
    );
  }

  const rows = await prisma.vaultProfile.findMany({
    where: { siteKey, discordUserId: viewer.discordUserId },
    include: { account: { select: { email: true } } },
  });
  // The order their list shows, so the file reads the same way.
  const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });
  rows.sort((a, b) => collator.compare(a.name, b.name));

  await prisma.vaultExport.create({
    data: {
      actorDiscordId: viewer.discordUserId,
      siteKey,
      format: "aycd",
      scope: "self",
      targetDiscordId: viewer.discordUserId,
      profileCount: rows.length,
      accountCount: 0,
    },
  });

  const stamp = new Date().toISOString().slice(0, 10);
  return fileResponse(aycdFile(rows), `okie-profiles-${siteKey}-${stamp}.json`, "application/json");
}

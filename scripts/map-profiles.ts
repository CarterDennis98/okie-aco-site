/**
 * Attach the profiles nobody has claimed to the member whose name they obviously are.
 *
 *   npx tsx --conditions=react-server scripts/map-profiles.ts           # dry run
 *   npx tsx --conditions=react-server scripts/map-profiles.ts --apply   # writes
 *
 * DRY BY DEFAULT. Without `--apply` it prints what it would do and writes nothing, so
 * the safe thing is also the thing you get by forgetting the flag.
 *
 * The backfill half of the fix in `/api/bot/checkouts`, which claims a profile the next
 * time it checks out. That heals every profile that is still in use, but a member whose
 * charge is already on the site and whose profile has not hit since would keep reading an
 * empty breakdown until their next drop. This closes those out now.
 *
 * SAME RULE AS THE INGEST, from the same module: an exact match on the normalized name,
 * and only when exactly one member owns that name. It never moves a profile that already
 * has an owner, never touches an IGNORED one -- those are the operator's house profiles,
 * deliberately attached to nobody -- and never sets `billable`, which is the operator's
 * call and the thing standing between them and a phantom charge.
 *
 * Run `scripts/verify-attribution.ts` first to see the gap, and again afterwards to see
 * what is left. Whatever remains needs a human: it is either a name no member answers to
 * or a name two of them do.
 */
import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";
import { matchProfileOwner } from "../src/lib/ingest/profile-owner";

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

const apply = process.argv.includes("--apply");

async function main() {
  const unmapped = await prisma.profile.findMany({
    where: { discordUserId: null, status: "UNMAPPED" },
    select: { profileKey: true, _count: { select: { checkouts: true } } },
  });

  const members = await prisma.discordMember.findMany({
    select: { discordUserId: true, username: true, globalName: true },
  });
  const usernameById = new Map(members.map((m) => [m.discordUserId, m.username]));

  const claims = unmapped
    .map((profile) => ({
      profileKey: profile.profileKey,
      checkouts: profile._count.checkouts,
      discordUserId: matchProfileOwner(profile.profileKey, members),
    }))
    .filter((claim) => claim.discordUserId !== null)
    .sort((a, b) => b.checkouts - a.checkouts);

  const recovered = claims.reduce((sum, claim) => sum + claim.checkouts, 0);
  console.log(
    `${unmapped.length} unmapped profiles · ${claims.length} match exactly one member` +
      ` · ${recovered} checkouts would become visible`,
  );

  for (const claim of claims) {
    console.log(
      `  ${apply ? "MAP  " : "would"} ${claim.profileKey} → @${usernameById.get(claim.discordUserId!)}` +
        ` (${claim.checkouts} checkouts)`,
    );
    if (!apply) continue;

    // Conditional on still being unowned, so a concurrent ingest of a live drop wins
    // rather than being overwritten by a decision made before it ran.
    await prisma.profile.updateMany({
      where: { profileKey: claim.profileKey, discordUserId: null, status: "UNMAPPED" },
      data: {
        discordUserId: claim.discordUserId,
        status: "MAPPED",
        mappedAt: new Date(),
        // Distinct from the ingest's own tag, so an audit can tell a backfill from a
        // claim made as the checkout arrived.
        mappedBy: "backfill:name-match",
      },
    });
  }

  if (!apply) console.log("\nDry run. Nothing was written. Re-run with --apply.");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

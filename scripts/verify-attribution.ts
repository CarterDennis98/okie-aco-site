/**
 * Find the checkouts the site cannot show anybody.
 *
 *   npx tsx --conditions=react-server scripts/verify-attribution.ts
 *
 * READ ONLY. Writes nothing, so it is safe against production through the proxy.
 *
 * THE GAP IT LOOKS FOR. A checkout reaches a member through `profiles.discord_user_id`
 * and nothing else. The BOT bills through a different mapping entirely -- its own
 * data/profileMap.json plus a fuzzy auto-match against the guild roster -- and the two
 * are never reconciled. `/api/bot/checkouts` creates an unseen profile as UNMAPPED, and
 * no code path on the site ever fills that column in; only `prisma db seed` does, from a
 * snapshot of the bot's file.
 *
 * So a profile the bot resolves and the site doesn't produces a bill whose "Checkouts"
 * expansion on /admin/charges is empty or short, and a member dashboard missing rows the
 * member knows they got. This says how much of that there is and which profiles cause it.
 *
 * Three sections:
 *
 *   1. Bills whose drop window holds no checkouts the site can attribute. These are the
 *      empty expansions -- somebody was billed for orders the site cannot show.
 *   2. Unmapped profiles, with the checkouts stranded on each. This is the backlog.
 *   3. Which of those would map cleanly: profile key equal to a Discord member's
 *      username or global name, ignoring case and punctuation -- the bot's own
 *      auto-accept rule, at its strictest. Ambiguous ones are listed separately and
 *      must be decided by hand.
 */
import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

/**
 * The bot's `normalizeName` from src/pas/profiles.js, byte for byte.
 *
 * Deliberately not imported from src/lib/normalize.ts: that module produces profile KEYS,
 * which keep spaces and punctuation. This one is the comparison form used to match a name
 * against a Discord account, and the two must not be confused.
 */
function normalizeName(value: string | null | undefined): string {
  return String(value ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]/g, "");
}

async function main() {
  // --- 1. bills the site cannot break down -------------------------------
  const bills = await prisma.pasBill.findMany({
    where: { run: { dryRun: false } },
    select: {
      id: true,
      discordUserId: true,
      member: { select: { username: true } },
      lines: { select: { qty: true } },
      run: { select: { dropLabel: true, windowStart: true, windowEnd: true } },
    },
    orderBy: { run: { windowStart: "desc" } },
  });

  const empty: string[] = [];
  const short: string[] = [];

  for (const bill of bills) {
    const rows = await prisma.checkout.findMany({
      where: {
        profile: { discordUserId: bill.discordUserId },
        occurredAt: { gte: bill.run.windowStart, lte: bill.run.windowEnd },
      },
      select: { quantity: true },
    });

    const billed = bill.lines.reduce((sum, line) => sum + line.qty, 0);
    const shown = rows.reduce((sum, row) => sum + row.quantity, 0);
    const who = `${bill.member?.username ?? bill.discordUserId} · ${bill.run.dropLabel}`;

    if (rows.length === 0) empty.push(`${who} — billed for ${billed}, nothing to show`);
    // Short, not just empty: a member with two profiles where only one is mapped gets a
    // breakdown that looks complete and is missing half the orders.
    else if (shown < billed) short.push(`${who} — billed for ${billed}, showing ${shown}`);
  }

  console.log(`Bills on the site: ${bills.length}`);
  console.log(`  no checkouts at all : ${empty.length}`);
  console.log(`  fewer units than billed: ${short.length}`);
  for (const line of empty) console.log(`    EMPTY ${line}`);
  for (const line of short) console.log(`    SHORT ${line}`);

  // --- 2. what is stranded -----------------------------------------------
  // IGNORED is not a gap: those are the operator's house profiles, deliberately
  // attached to nobody.
  const unmapped = await prisma.profile.findMany({
    where: { discordUserId: null, status: { not: "IGNORED" } },
    select: {
      profileKey: true,
      displayName: true,
      createdAt: true,
      _count: { select: { checkouts: true } },
    },
  });
  unmapped.sort((a, b) => b._count.checkouts - a._count.checkouts);

  const stranded = unmapped.reduce((sum, p) => sum + p._count.checkouts, 0);
  const total = await prisma.checkout.count();
  console.log(
    `\nUnmapped profiles: ${unmapped.length}, holding ${stranded} of ${total} checkouts` +
      ` (${total ? ((stranded / total) * 100).toFixed(1) : "0"}%)`,
  );

  // --- 3. which would map cleanly ----------------------------------------
  const members = await prisma.discordMember.findMany({
    select: { discordUserId: true, username: true, globalName: true },
  });

  const byName = new Map<string, { discordUserId: string; username: string }[]>();
  for (const member of members) {
    for (const name of [member.username, member.globalName]) {
      const key = normalizeName(name);
      if (!key) continue;
      byName.set(key, [
        ...(byName.get(key) ?? []).filter((m) => m.discordUserId !== member.discordUserId),
        { discordUserId: member.discordUserId, username: member.username },
      ]);
    }
  }

  const clean: string[] = [];
  const ambiguous: string[] = [];
  const nobody: string[] = [];

  for (const profile of unmapped) {
    const matches = byName.get(normalizeName(profile.profileKey)) ?? [];
    const line = `${profile.profileKey} (${profile._count.checkouts} checkouts)`;
    if (matches.length === 1) clean.push(`${line} → @${matches[0].username}`);
    else if (matches.length > 1) ambiguous.push(`${line} → ${matches.length} members match`);
    else nobody.push(line);
  }

  console.log(`\n  exact single match  : ${clean.length}`);
  for (const line of clean) console.log(`    ${line}`);
  console.log(`  ambiguous (decide by hand): ${ambiguous.length}`);
  for (const line of ambiguous) console.log(`    ${line}`);
  console.log(`  no member with that name  : ${nobody.length}`);
  for (const line of nobody) console.log(`    ${line}`);

  // Checkouts with no profile row at all -- the parser's "no-profile" flag. Nothing can
  // ever attribute these; they are counted so the totals above are not read as complete.
  const noProfile = await prisma.checkout.count({ where: { profileKey: null } });
  if (noProfile > 0) console.log(`\n${noProfile} checkouts have no profile name at all.`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

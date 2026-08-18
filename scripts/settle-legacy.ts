/**
 * Settle everything billed before launch.
 *
 *   npx tsx --conditions=react-server scripts/settle-legacy.ts               # dry run
 *   npx tsx --conditions=react-server scripts/settle-legacy.ts --commit
 *   npx tsx --conditions=react-server scripts/settle-legacy.ts --before 2026-08-01 --commit
 *
 * DRY RUN BY DEFAULT. Nothing is written without --commit.
 *
 * The bills seeded from archived PAS sessions were settled in real life over Discord
 * long before this site existed. Left alone they would greet every member on day one
 * with an outstanding balance they already paid, which is the fastest possible way to
 * lose their trust in the numbers on this site.
 *
 * This does the same thing the admin "Mark received" button does, in bulk and through
 * the same two writes: a `payments` receipt per bill, then `paid_at` on the bill. The
 * bill's own amounts are never touched, so the itemised history a member can open stays
 * exactly as it was.
 *
 * Idempotent: only bills with `paid_at IS NULL` are considered, so a second run settles
 * nothing. Dry runs are excluded -- nobody was ever DMed for one.
 */
import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";

const args = process.argv.slice(2);
const COMMIT = args.includes("--commit");
const beforeArg = args.indexOf("--before") >= 0 ? args[args.indexOf("--before") + 1] : null;
const METHOD = "pre-launch";

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

function money(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

async function main() {
  const operator = (process.env.ADMIN_DISCORD_IDS ?? "").split(",")[0].replace(/["\s]/g, "");
  if (!/^\d{15,25}$/.test(operator)) {
    throw new Error(
      "ADMIN_DISCORD_IDS is not set to a Discord user id; nothing to record against.",
    );
  }

  const before = beforeArg ? new Date(beforeArg) : null;
  if (before && Number.isNaN(before.getTime())) {
    throw new Error(`--before ${beforeArg} is not a date.`);
  }

  const bills = await prisma.pasBill.findMany({
    where: {
      paidAt: null,
      run: { dryRun: false, ...(before ? { windowStart: { lt: before } } : {}) },
    },
    select: {
      id: true,
      totalCents: true,
      paidCents: true,
      discordUserId: true,
      member: { select: { username: true } },
      run: { select: { dropLabel: true } },
    },
    orderBy: { createdAt: "asc" },
  });

  // What is LEFT on each bill, not the original total. A part-paid charge must be
  // topped up, not paid twice -- and `payments` has to keep summing to `paid_cents`.
  const owed = (b: { totalCents: number; paidCents: number }) =>
    Math.max(0, b.totalCents - b.paidCents);
  const total = bills.reduce((sum, b) => sum + owed(b), 0);
  const byMember = new Map<string, number>();
  for (const b of bills) byMember.set(b.discordUserId, (byMember.get(b.discordUserId) ?? 0) + 1);

  console.log(`Mode   : ${COMMIT ? "COMMIT" : "DRY RUN"}`);
  console.log(
    `Cutoff : ${before ? before.toISOString().slice(0, 10) : "everything currently unpaid"}`,
  );
  console.log(`Bills  : ${bills.length} across ${byMember.size} members, ${money(total)}\n`);

  if (bills.length === 0) {
    console.log("Nothing outstanding. Already settled.");
    return;
  }

  const drops = new Map<string, number>();
  for (const b of bills) drops.set(b.run.dropLabel, (drops.get(b.run.dropLabel) ?? 0) + 1);
  for (const [label, n] of drops) console.log(`  ${String(n).padStart(3)} x ${label}`);

  if (!COMMIT) {
    console.log(`\nDRY RUN -- nothing written. Re-run with --commit to apply.`);
    return;
  }

  const at = new Date();
  // One transaction: a stamped bill with no receipt is the exact state the payments
  // table exists to make impossible, and a partial batch would leave a mix of both.
  await prisma.$transaction([
    prisma.payment.createMany({
      data: bills.map((b) => ({
        pasBillId: b.id,
        amountCents: owed(b),
        method: METHOD,
        note: "Settled before the site went live",
        recordedBy: operator,
        recordedAt: at,
      })),
    }),
    // paid_cents set to the total, matching the receipts written above: settling means
    // the bill is now fully covered, which is exactly when paid_at may be stamped.
    ...bills.map((b) =>
      prisma.pasBill.update({
        where: { id: b.id },
        data: { paidAt: at, markedPaidBy: operator, paidCents: b.totalCents },
      }),
    ),
    // One audit row, not 85: this was one decision by one person. The per-bill receipts
    // are the `payments` rows.
    prisma.adminAudit.create({
      data: {
        actorDiscordId: operator,
        action: "payment.settle_legacy",
        entity: "pas_bill",
        after: {
          bills: bills.length,
          members: byMember.size,
          totalCents: total,
          method: METHOD,
          before: before ? before.toISOString() : null,
        },
      },
    }),
  ]);

  const remaining = await prisma.pasBill.count({ where: { paidAt: null, run: { dryRun: false } } });
  console.log(
    `\nSettled ${bills.length} bills (${money(total)}). Still outstanding: ${remaining}.`,
  );
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

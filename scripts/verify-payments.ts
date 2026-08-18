/**
 * Assert the payment bookkeeping still holds.
 *
 *   npx tsx --conditions=react-server scripts/verify-payments.ts
 *
 * READ ONLY. Writes nothing, so it is safe against production through the proxy.
 *
 * `pas_bills.paid_cents` is a denormalized running total of that bill's `payments` rows.
 * It exists so "what is still owed" is a column comparison rather than an aggregate, which
 * keeps the balance queries on their indexes. The cost of that choice is exactly this: two
 * places holding the same number, and a way for them to disagree.
 *
 * Three things are checked:
 *
 *   1. paid_cents equals the sum of its payments. `payments` is the source of truth; a
 *      mismatch means a write updated one and not the other.
 *   2. paid_at IS NOT NULL exactly when paid_cents >= total_cents. Every balance filter
 *      leans on this -- if it breaks, a settled bill starts showing as owed, or worse, an
 *      unsettled one stops.
 *   3. No bill is in credit. paid_cents above total_cents means somebody was recorded as
 *      paying more than they were billed.
 */
import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

function money(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

async function main() {
  const bills = await prisma.pasBill.findMany({
    select: {
      id: true,
      discordUserId: true,
      totalCents: true,
      paidCents: true,
      paidAt: true,
      run: { select: { dropLabel: true, dryRun: true } },
      payments: { select: { amountCents: true } },
    },
  });

  const drift: string[] = [];
  const invariant: string[] = [];
  const credit: string[] = [];

  for (const bill of bills) {
    const net = bill.payments.reduce((sum, p) => sum + p.amountCents, 0);
    const where = `${bill.run.dropLabel} / ${bill.discordUserId} (${bill.id.slice(0, 8)})`;

    if (net !== bill.paidCents) {
      drift.push(`  ${where}: paid_cents ${money(bill.paidCents)}, payments ${money(net)}`);
    }
    const settled = bill.paidCents >= bill.totalCents;
    if ((bill.paidAt !== null) !== settled) {
      invariant.push(
        `  ${where}: paid_at ${bill.paidAt ? "set" : "null"} but ` +
          `${money(bill.paidCents)} of ${money(bill.totalCents)}`,
      );
    }
    if (bill.paidCents > bill.totalCents) {
      credit.push(`  ${where}: ${money(bill.paidCents)} against ${money(bill.totalCents)}`);
    }
  }

  const partial = bills.filter((b) => b.paidAt === null && b.paidCents > 0);
  const owed = bills
    .filter((b) => b.paidAt === null && !b.run.dryRun)
    .reduce((sum, b) => sum + Math.max(0, b.totalCents - b.paidCents), 0);

  console.log(`bills          : ${bills.length}`);
  console.log(`part-paid      : ${partial.length}`);
  console.log(`still owed     : ${money(owed)}`);
  console.log();

  const report = (label: string, rows: string[]) => {
    console.log(`${label.padEnd(15)}: ${rows.length === 0 ? "ok" : `${rows.length} PROBLEM(S)`}`);
    for (const row of rows.slice(0, 20)) console.log(row);
  };
  report("paid_cents", drift);
  report("paid_at rule", invariant);
  report("no credit", credit);

  const bad = drift.length + invariant.length + credit.length;
  console.log();
  if (bad === 0) {
    console.log("PASS -- receipts and running totals agree");
  } else {
    console.log(`FAIL -- ${bad} bill(s) need looking at`);
    process.exitCode = 1;
  }
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

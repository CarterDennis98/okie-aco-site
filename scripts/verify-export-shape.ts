/**
 * Find vault profiles a bot's importer will refuse.
 *
 *   npx tsx --conditions=react-server scripts/verify-export-shape.ts
 *
 * READ ONLY. Writes nothing and prints no secrets -- names and field shapes only, so it
 * is safe against production through the proxy.
 *
 * WHY THIS SHAPE AND NOT ANOTHER. Valor rejects a profile file WHOLE, with "invalid
 * profile list" and no indication of which row is at fault, so one bad value silently
 * costs an entire retailer's export. The checks below are the ones established by
 * bisecting a real failure against Valor's own profile store -- not a guess at what a
 * strict parser might dislike:
 *
 *   - A BLANK PHONE fails the import. `toAycdProfile` now substitutes the "0" sentinel,
 *     so this no longer breaks an export; it is still listed, because "0" tells the bot
 *     to invent a number and on some retailers a real one is wanted.
 *   - A POSTAL CODE that is neither 5-digit nor ZIP+4 is junk that nothing can fix
 *     automatically -- inventing the missing digits would ship an order to the wrong
 *     place -- so it needs a human and is reported as a failure.
 *
 * Deliberately NOT flagged, because Valor's live store proves they are fine: punctuated
 * phone numbers (173 profiles carry one) and ZIP+4 postal codes (2 do). Normalizing those
 * would be destroying good data to fix a problem they never caused.
 */
import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL, options: "-c timezone=UTC" }),
});

/** What a US postal code may look like. Anything else is a typo, not a format. */
const POSTCODE = /^\d{5}(-\d{4})?$/;

async function main() {
  const rows = await prisma.vaultProfile.findMany({
    select: {
      siteKey: true,
      name: true,
      active: true,
      phone: true,
      shipPostalCode: true,
      billPostalCode: true,
      shipState: true,
      billState: true,
      sameBillingAndShipping: true,
    },
    orderBy: [{ siteKey: "asc" }, { name: "asc" }],
  });

  const blankPhone: string[] = [];
  const badPostcode: string[] = [];
  const badState: string[] = [];

  for (const row of rows) {
    const where = `${row.siteKey} · ${row.name}${row.active ? "" : " (disabled)"}`;

    if (!row.phone?.trim()) blankPhone.push(where);

    // Billing columns are null when the member said billing matches shipping; that is
    // the flag doing its job, not a missing value.
    const codes: [string, string | null][] = [["ship", row.shipPostalCode]];
    const states: [string, string | null][] = [["ship", row.shipState]];
    if (!row.sameBillingAndShipping) {
      codes.push(["bill", row.billPostalCode]);
      states.push(["bill", row.billState]);
    }

    for (const [which, code] of codes) {
      if (code && !POSTCODE.test(code)) badPostcode.push(`${where} — ${which} "${code}"`);
    }
    for (const [which, state] of states) {
      if (state && !/^[A-Z]{2}$/.test(state)) badState.push(`${where} — ${which} "${state}"`);
    }
  }

  console.log(`Checked ${rows.length} vault profiles.\n`);
  console.log(`  no phone on file (exports as the "0" sentinel) : ${blankPhone.length}`);
  console.log(`  postal code that is not a US ZIP               : ${badPostcode.length}`);
  console.log(`  state that is not a two-letter code            : ${badState.length}`);

  if (blankPhone.length) {
    console.log(`\nNo phone on file — imports fine, but the bot will generate a number:`);
    for (const line of blankPhone.slice(0, 40)) console.log(`  ${line}`);
    if (blankPhone.length > 40) console.log(`  … and ${blankPhone.length - 40} more`);
  }
  if (badPostcode.length) {
    console.log(`\nPostal codes needing a human — these cannot be guessed:`);
    for (const line of badPostcode) console.log(`  ${line}`);
  }
  if (badState.length) {
    console.log(`\nStates needing a human:`);
    for (const line of badState) console.log(`  ${line}`);
  }

  // A blank phone is no longer fatal, so it does not fail the run. A junk postcode is
  // a wrong delivery address and does.
  const clean = badPostcode.length + badState.length === 0;
  console.log(`\n${clean ? "PASS -- nothing here will break an export." : "FAIL -- see above."}`);
  if (!clean) process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

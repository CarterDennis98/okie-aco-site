/**
 * Export every stored profile to AYCD format, read it straight back in, and assert the
 * two agree field for field.
 *
 *   npx tsx --conditions=react-server scripts/verify-aycd-roundtrip.ts
 *
 * The export and the import are separate code paths that have to stay inverses of each
 * other. They already drifted once -- the export spells states out ("Oklahoma") while
 * storage holds codes ("OK") -- and a member re-importing their own export would have
 * quietly forked the data. This is the check that catches the next one.
 *
 * Prints FIELD NAMES and COUNTS only, never a value: it decrypts real card numbers to
 * build the export, and this output goes to a terminal.
 */
import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";
import { toAycdProfile } from "../src/lib/vault/aycd";
import { parseAycdExport } from "../src/lib/vault/aycd-import";
import { decrypt } from "../src/lib/vault/crypto";

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

async function main() {
  const rows = await prisma.vaultProfile.findMany({
    include: { account: { select: { email: true } } },
  });

  const exported = rows.map((row) =>
    toAycdProfile({
      ...row,
      email: row.account.email,
      cardNumber: decrypt(row.cardNumberEnc, { entity: "vault_profile", field: "card_number" }),
      cardCvv: decrypt(row.cardCvvEnc, { entity: "vault_profile", field: "card_cvv" }),
    }),
  );

  const { profiles, issues } = parseAycdExport(JSON.stringify(exported.slice(0, 250)));
  const byEmail = new Map(profiles.map((p) => [p.email, p]));

  const mismatches = new Map<string, number>();
  const examples: string[] = [];
  let compared = 0;

  for (const row of rows.slice(0, 250)) {
    const parsed = byEmail.get(row.account.email.toLowerCase());
    if (!parsed) continue;
    compared++;

    const expected: Record<string, unknown> = {
      firstName: row.firstName,
      lastName: row.lastName,
      phone: row.phone,
      shipLine1: row.shipLine1,
      shipLine2: row.shipLine2,
      shipCity: row.shipCity,
      shipState: row.shipState,
      shipPostalCode: row.shipPostalCode,
      shipCountry: row.shipCountry,
      sameBillingAndShipping: row.sameBillingAndShipping,
      onlyCheckoutOnce: row.onlyCheckoutOnce,
      matchNameOnCardAndAddress: row.matchNameOnCardAndAddress,
      cardLast4: row.cardLast4,
      cardExpMonth: row.cardExpMonth,
      cardExpYear: row.cardExpYear,
      // Billing only when it is actually separate; the export mirrors shipping otherwise.
      ...(row.sameBillingAndShipping
        ? {}
        : {
            billLine1: row.billLine1,
            billLine2: row.billLine2,
            billCity: row.billCity,
            billState: row.billState,
            billPostalCode: row.billPostalCode,
            billCountry: row.billCountry,
          }),
    };

    for (const [field, value] of Object.entries(expected)) {
      const got = (parsed as unknown as Record<string, unknown>)[field];
      // Null and "" mean the same absence across the two representations.
      const same = (value ?? "") === (got ?? "");
      if (!same) {
        mismatches.set(field, (mismatches.get(field) ?? 0) + 1);
        if (examples.length < 8) examples.push(`${row.name} · ${field}`);
      }
    }
  }

  console.log(`Round-tripped ${compared} profiles through export -> import.\n`);
  const errors = issues.filter((i) => i.severity === "error");
  const warnings = issues.filter((i) => i.severity === "warning");
  console.log(`  parse errors  : ${errors.length}`);
  console.log(`  parse warnings: ${warnings.length}`);
  if (warnings.length) {
    const kinds = new Map<string, number>();
    for (const w of warnings) kinds.set(w.problem, (kinds.get(w.problem) ?? 0) + 1);
    for (const [problem, n] of kinds) console.log(`      ${n} x ${problem}`);
  }

  if (mismatches.size === 0) {
    console.log("\n  field mismatches: none");
  } else {
    console.log("\n  field mismatches:");
    for (const [field, n] of [...mismatches].sort((a, b) => b[1] - a[1])) {
      console.log(`      ${field.padEnd(28)} ${n}`);
    }
    console.log(`\n  examples: ${examples.join(", ")}`);
    process.exitCode = 1;
  }
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

/**
 * Post-import verification.
 *
 *   npx tsx --conditions=react-server scripts/verify-vault.ts
 *
 * Decrypts every stored secret and cross-checks it against the clear-text display
 * columns, which is the only way to prove the import round-trips. Prints COUNTS ONLY --
 * never a card number, CVV, or password.
 *
 * Worth re-running after any key rotation: it reads every row, so a row left behind
 * under a retired key fails here rather than during a drop.
 */
import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";
import { decrypt } from "../src/lib/vault/crypto";
import { detectBrand, isLuhnValid, isValidCvv, last4 } from "../src/lib/vault/card";

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL, options: "-c timezone=UTC" }),
});

async function main() {
  const rows = await prisma.vaultProfile.findMany({
    select: {
      name: true,
      cardBrand: true,
      cardLast4: true,
      cardNumberEnc: true,
      cardCvvEnc: true,
      account: { select: { passwordEnc: true } },
    },
  });

  let panMismatch = 0;
  let brandMismatch = 0;
  let luhnFail = 0;
  let cvvEmpty = 0;
  let cvvWrongLength = 0;
  let pwEmpty = 0;
  const problems: string[] = [];

  for (const row of rows) {
    const pan = decrypt(row.cardNumberEnc, { entity: "vault_profile", field: "card_number" });
    const cvv = decrypt(row.cardCvvEnc, { entity: "vault_profile", field: "card_cvv" });
    const password = decrypt(row.account.passwordEnc, {
      entity: "vault_account",
      field: "password",
    });

    if (last4(pan) !== row.cardLast4) {
      panMismatch++;
      problems.push(`${row.name}: stored last4 does not match the decrypted card`);
    }
    if (detectBrand(pan) !== row.cardBrand) {
      brandMismatch++;
      problems.push(`${row.name}: stored brand does not match the decrypted card`);
    }
    if (!isLuhnValid(pan)) luhnFail++;
    if (!cvv) cvvEmpty++;
    else if (!isValidCvv(cvv, detectBrand(pan))) cvvWrongLength++;
    if (!password) pwEmpty++;
  }

  console.log(`Decrypted ${rows.length} profiles and their accounts.\n`);
  console.log(`  last4 disagrees with decrypted card : ${panMismatch}`);
  console.log(`  brand disagrees with decrypted card : ${brandMismatch}`);
  console.log(`  cards failing Luhn                  : ${luhnFail}`);
  console.log(`  empty CVV after decrypt             : ${cvvEmpty}`);
  console.log(`  CVV implausible for its brand       : ${cvvWrongLength}`);
  console.log(`  empty password after decrypt        : ${pwEmpty}`);

  if (problems.length) {
    console.log(`\nProblems:`);
    for (const p of problems.slice(0, 20)) console.log(`  ${p}`);
  }

  const clean = panMismatch + brandMismatch + cvvEmpty + pwEmpty === 0;
  console.log(`\n${clean ? "PASS -- every secret round-trips." : "FAIL -- see above."}`);
  if (!clean) process.exitCode = 1;
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });

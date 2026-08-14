/**
 * Round-trip parity: does exporting from the vault reproduce the original AYCD files?
 *
 *   npx tsx --conditions=react-server scripts/verify-aycd-parity.ts
 *
 * This is the check that matters for the export. The bots consume these files; a field
 * that silently differs from what AYCD wrote is a failed checkout on drop night, not a
 * compile error. Compares every profile field by field against the source export.
 *
 * Prints field NAMES and counts only -- never a value, so a mismatch report is safe to
 * paste. Decrypts in memory to build the comparison and holds nothing.
 */
import "dotenv/config";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";
import { toAycdProfile, type AycdProfile } from "../src/lib/vault/aycd";
import { decrypt } from "../src/lib/vault/crypto";

const DIR = process.env.VAULT_EXPORT_DIR ?? "F:/Documents/Okie ACO";
const SOURCES = ["target_profiles_aycd.json", "macbook_target_profiles_aycd.json"];

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL, options: "-c timezone=UTC" }),
});

/** Flattens to `path -> value` so a diff can name the exact field. */
function flatten(value: unknown, prefix = ""): Map<string, unknown> {
  const out = new Map<string, unknown>();
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [key, child] of Object.entries(value)) {
      for (const [k, v] of flatten(child, prefix ? `${prefix}.${key}` : key)) out.set(k, v);
    }
  } else {
    out.set(prefix, value);
  }
  return out;
}

async function main() {
  const original = new Map<string, AycdProfile>();
  for (const file of SOURCES) {
    const full = path.join(DIR, file);
    if (!existsSync(full)) continue;
    for (const profile of JSON.parse(readFileSync(full, "utf8")) as AycdProfile[]) {
      // Keyed on email: the MacBook export's names carry suffixes nothing else uses.
      original.set(String(profile.shippingAddress?.email ?? "").toLowerCase(), profile);
    }
  }
  if (original.size === 0) {
    console.log(`No source exports found in ${DIR}; nothing to compare against.`);
    return;
  }

  const rows = await prisma.vaultProfile.findMany({
    where: { siteKey: "target" },
    include: { account: { select: { email: true } } },
  });

  const mismatches = new Map<string, number>();
  let compared = 0;
  let missing = 0;
  const examples: string[] = [];

  for (const row of rows) {
    const source = original.get(row.account.email.toLowerCase());
    if (!source) {
      missing++;
      continue;
    }
    compared++;

    const ours = toAycdProfile({
      ...row,
      email: row.account.email,
      cardNumber: decrypt(row.cardNumberEnc, { entity: "vault_profile", field: "card_number" }),
      cardCvv: decrypt(row.cardCvvEnc, { entity: "vault_profile", field: "card_cvv" }),
    });

    const mine = flatten(ours);
    const theirs = flatten(source);

    for (const [field, value] of theirs) {
      // `name` legitimately differs: the MacBook AYCD export appended suffixes like
      // "-!50" that no other file uses, and the Shikari name is canonical.
      if (field === "name") continue;
      if (mine.get(field) !== value) {
        mismatches.set(field, (mismatches.get(field) ?? 0) + 1);
        if (examples.length < 8) examples.push(`${row.name} · ${field}`);
      }
    }
  }

  console.log(`Compared ${compared} profiles against the original AYCD exports.`);
  if (missing) console.log(`  ${missing} profile(s) had no source entry (added since the export).`);

  if (mismatches.size === 0) {
    console.log(`\nPASS -- every field matches what AYCD wrote.`);
    return;
  }

  console.log(`\nField mismatches:`);
  for (const [field, count] of [...mismatches.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${field.padEnd(34)} ${count}`);
  }
  console.log(`\nExamples: ${examples.join(", ")}`);
  process.exitCode = 1;
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });

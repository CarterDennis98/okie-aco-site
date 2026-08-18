/**
 * Import a site's profiles from an AYCD export.
 *
 *   npx tsx --conditions=react-server scripts/import-aycd.ts --site walmart
 *   npx tsx --conditions=react-server scripts/import-aycd.ts --site walmart --commit
 *   npx tsx --conditions=react-server scripts/import-aycd.ts --site pokemon-center --commit
 *
 * DRY RUN BY DEFAULT. Nothing is written without --commit.
 *
 * The counterpart to import-vault.ts, which is Shikari-primary and only works for Target.
 * These exports have no Shikari profile CSV to join against, so AYCD is the whole story:
 * addresses, cards, and flags all come from it, and logins come from a separate accounts
 * file when the retailer needs one at all.
 *
 * Reuses `parseAycdExport` -- the same parser behind the members' own upload -- so there
 * is one implementation of "what does an AYCD row mean", tested by the same round-trip
 * suite. Ownership comes from `resolveOwner`; see profile-owner.ts for the four naming
 * schemes and why nothing is guessed at.
 *
 * Handles real cards and passwords and NEVER prints them: every line of output is a
 * count, a profile name, or a masked address.
 */
import "dotenv/config";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";
import { parseAccountList, parseAycdExport } from "../src/lib/vault/aycd-import";
import { encrypt } from "../src/lib/vault/crypto";
import { buildRosterIndex, resolveOwner, type RosterEntry } from "../src/lib/vault/profile-owner";

const args = process.argv.slice(2);
const flag = (name: string, fallback?: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? (args[i + 1] ?? "") : fallback;
};

const SITE = flag("site", "")!;
const DIR = flag("dir", "F:/Documents/Okie ACO")!;
const COMMIT = args.includes("--commit");
// Force through cards whose security code is the wrong length for the brand. They will
// fail at checkout until the member fixes them, so this is never the default.
const ALLOW_BAD_CVV = args.includes("--allow-bad-cvv");
const MAP_FILE = flag("map", path.join(process.cwd(), "data", "aycd-owner-map.json"))!;
const MIRROR = process.env.MIRROR_REPO_PATH ?? path.join(process.cwd(), "..", "okie-aco-mirror");

/** Which files carry each site, and whether the retailer needs a login at all. */
const BUNDLES: Record<string, { profiles: string; accounts: string | null }> = {
  walmart: { profiles: "walmart_profiles_aycd.json", accounts: "shikari_walmart_accounts.csv" },
  // Pokémon Center checks out as a guest; there is no login to store.
  "pokemon-center": { profiles: "valor_profiles_aycd.json", accounts: null },
};

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

/**
 * Logins, from either shape the bots export.
 *
 * Shikari writes a `username,password` CSV; the site's own accounts export writes
 * `email:password` lines. Both land here so a round trip works either way.
 */
const LINE_BREAK = /\r?\n/;

function loadAccounts(file: string): Map<string, string> {
  const text = readFileSync(file, "utf8");
  if (!file.toLowerCase().endsWith(".csv")) return parseAccountList(text);

  const map = new Map<string, string>();
  // Split on newlines only; every cell is trimmed below, so a trailing CR never survives.
  const lines = text.split(LINE_BREAK);
  const header = (lines[0] ?? "").split(",").map((h) => h.trim().toLowerCase());
  const emailAt = header.findIndex((h) => /user|email/.test(h));
  const passAt = header.findIndex((h) => /pass/.test(h));
  if (emailAt < 0 || passAt < 0) {
    throw new Error(`${file}: expected username and password columns, got: ${header.join(", ")}`);
  }

  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    // Passwords may contain commas, so take everything after the email column as the
    // password when the row has more cells than the header.
    const cells = line.split(",");
    const email = (cells[emailAt] ?? "").trim().toLowerCase();
    const password =
      cells.length > header.length
        ? cells.slice(passAt).join(",").trim()
        : (cells[passAt] ?? "").trim();
    if (email && password) map.set(email, password);
  }
  return map;
}

function loadOverrides(): Map<string, string> {
  if (!existsSync(MAP_FILE)) return new Map();
  const raw = JSON.parse(readFileSync(MAP_FILE, "utf8")) as Record<string, unknown>;

  const numeric = Object.entries(raw).filter(([, v]) => typeof v === "number");
  if (numeric.length) {
    throw new Error(
      `${MAP_FILE}: ${numeric.length} id(s) are unquoted numbers and have already lost ` +
        `precision. Discord ids exceed 2^53 -- quote every value as a string.`,
    );
  }

  const map = new Map<string, string>();
  for (const [key, value] of Object.entries(raw)) {
    if (value === null || value === "") continue;
    if (typeof value !== "string" || !/^\d{15,25}$/.test(value)) {
      throw new Error(`${MAP_FILE}: "${key}" is not a Discord user id string.`);
    }
    map.set(key.trim().toLowerCase(), value);
  }
  return map;
}

function writeTemplate(unresolved: string[], existing: Map<string, string>) {
  const merged: Record<string, string | null> = Object.fromEntries(existing);
  for (const base of unresolved) if (!(base in merged)) merged[base] = null;
  mkdirSync(path.dirname(MAP_FILE), { recursive: true });
  writeFileSync(MAP_FILE, `${JSON.stringify(merged, null, 2)}\n`);
}

async function main() {
  const bundle = BUNDLES[SITE];
  if (!bundle) {
    throw new Error(`--site must be one of: ${Object.keys(BUNDLES).join(", ")}`);
  }

  const operator = (process.env.ADMIN_DISCORD_IDS ?? "").split(",")[0].replace(/["\s]/g, "");
  if (!/^\d{15,25}$/.test(operator)) throw new Error("ADMIN_DISCORD_IDS is not a Discord user id.");

  console.log(`Site: ${SITE}   Source: ${DIR}   Mode: ${COMMIT ? "COMMIT" : "DRY RUN"}\n`);

  // --- parse ---------------------------------------------------------------
  // No practical cap here: this is the operator's own export of every member's profiles.
  const { profiles, issues } = parseAycdExport(
    readFileSync(path.join(DIR, bundle.profiles), "utf8"),
    {
      // No practical cap: this is the operator's own export of every member's profiles.
      maxProfiles: 100_000,
      allowInvalidCvv: ALLOW_BAD_CVV,
    },
  );
  const errors = issues.filter((i) => i.severity === "error");
  const warnings = issues.filter((i) => i.severity === "warning");
  console.log(`  parsed        : ${profiles.length} profiles`);
  console.log(`  parse errors  : ${errors.length}`);
  console.log(`  parse warnings: ${warnings.length}`);
  for (const issue of errors.slice(0, 10)) console.log(`      ${issue.name}: ${issue.problem}`);
  if (errors.length > 10) console.log(`      ...and ${errors.length - 10} more`);

  const passwords = bundle.accounts
    ? loadAccounts(path.join(DIR, bundle.accounts))
    : new Map<string, string>();
  if (bundle.accounts) console.log(`  logins loaded : ${passwords.size}`);
  else console.log(`  logins        : none needed for this retailer`);

  // --- ownership -----------------------------------------------------------
  const roster: RosterEntry[] = JSON.parse(
    readFileSync(path.join(MIRROR, "data", "fixtures", "guild-roster.json"), "utf8"),
  );
  const index = buildRosterIndex(roster);
  const overrides = loadOverrides();

  const accounts = await prisma.vaultAccount.findMany({
    select: { email: true, discordUserId: true },
  });
  const ownerByEmail = new Map(accounts.map((a) => [a.email.toLowerCase(), a.discordUserId]));

  const members = new Set(
    (await prisma.discordMember.findMany({ select: { discordUserId: true } })).map(
      (m) => m.discordUserId,
    ),
  );

  type Planned = { parsed: (typeof profiles)[number]; ownerId: string; house: boolean };
  const planned: Planned[] = [];
  const unresolved = new Map<string, number>();
  const counts = { house: 0, id: 0, email: 0, name: 0 };

  for (const parsed of profiles) {
    const owner = resolveOwner({
      name: parsed.sourceName,
      email: parsed.email,
      ownerByEmail,
      roster: index,
      overrides,
    });

    if (owner.kind === "unresolved") {
      unresolved.set(owner.base, (unresolved.get(owner.base) ?? 0) + 1);
      continue;
    }
    if (owner.kind === "house") {
      counts.house++;
      planned.push({ parsed, ownerId: operator, house: true });
      continue;
    }
    counts[owner.via]++;
    planned.push({ parsed, ownerId: owner.discordUserId, house: false });
  }

  console.log(`\n  operator house  : ${counts.house}`);
  console.log(`  by embedded id  : ${counts.id}`);
  console.log(`  by known address: ${counts.email}`);
  console.log(`  by guild name   : ${counts.name}`);
  console.log(`  to import       : ${planned.length} of ${profiles.length}`);
  console.log(`  unresolved      : ${[...unresolved.values()].reduce((a, b) => a + b, 0)}`);
  for (const [base, n] of unresolved) console.log(`      ${base} (${n})`);

  // A member row must exist before an account can point at it.
  const missingMembers = [...new Set(planned.map((p) => p.ownerId))].filter(
    (id) => !members.has(id),
  );
  if (missingMembers.length) {
    console.log(`\n  members needing a provisional row: ${missingMembers.length}`);
    if (COMMIT) {
      const byId = new Map(roster.map((r) => [r.id, r]));
      await prisma.discordMember.createMany({
        data: missingMembers.map((id) => ({
          discordUserId: id,
          username: byId.get(id)?.username ?? id,
          globalName: byId.get(id)?.globalName ?? null,
        })),
        skipDuplicates: true,
      });
    }
  }

  const needLogin = bundle.accounts
    ? planned.filter((p) => !passwords.has(p.parsed.email)).length
    : 0;
  if (needLogin) console.log(`  profiles with no login in the accounts file: ${needLogin}`);

  if (!COMMIT) {
    if (unresolved.size) writeTemplate([...unresolved.keys()], overrides);
    console.log(`\nDRY RUN -- nothing written. Re-run with --commit to apply.`);
    if (unresolved.size) console.log(`Unresolved names written to ${MAP_FILE}.`);
    return;
  }

  // --- write ---------------------------------------------------------------
  let created = 0;
  let updated = 0;
  let renames = 0;

  for (const { parsed, ownerId } of planned) {
    const password = passwords.get(parsed.email) ?? null;

    const account = await prisma.vaultAccount.upsert({
      where: { siteKey_email: { siteKey: SITE, email: parsed.email } },
      create: {
        siteKey: SITE,
        email: parsed.email,
        passwordEnc: password
          ? encrypt(password, { entity: "vault_account", field: "password" })
          : null,
        discordUserId: ownerId,
      },
      // Re-running with a corrected map must be able to move ownership.
      update: {
        discordUserId: ownerId,
        ...(password
          ? { passwordEnc: encrypt(password, { entity: "vault_account", field: "password" }) }
          : {}),
      },
      select: { id: true, profile: { select: { id: true, name: true } } },
    });

    const fields = {
      siteKey: SITE,
      discordUserId: ownerId,
      accountId: account.id,
      firstName: parsed.firstName,
      lastName: parsed.lastName,
      phone: parsed.phone,
      shipLine1: parsed.shipLine1,
      shipLine2: parsed.shipLine2,
      shipCity: parsed.shipCity,
      shipState: parsed.shipState,
      shipPostalCode: parsed.shipPostalCode,
      shipCountry: parsed.shipCountry,
      sameBillingAndShipping: parsed.sameBillingAndShipping,
      billFirstName: parsed.billFirstName,
      billLastName: parsed.billLastName,
      billLine1: parsed.billLine1,
      billLine2: parsed.billLine2,
      billCity: parsed.billCity,
      billState: parsed.billState,
      billPostalCode: parsed.billPostalCode,
      billCountry: parsed.billCountry,
      onlyCheckoutOnce: parsed.onlyCheckoutOnce,
      matchNameOnCardAndAddress: parsed.matchNameOnCardAndAddress,
      cardBrand: parsed.cardBrand,
      cardLast4: parsed.cardLast4,
      cardExpMonth: parsed.cardExpMonth,
      cardExpYear: parsed.cardExpYear,
      cardNumberEnc: encrypt(parsed.cardNumber, {
        entity: "vault_profile",
        field: "card_number",
      }),
      cardCvvEnc: encrypt(parsed.cardCvv, { entity: "vault_profile", field: "card_cvv" }),
    };

    if (account.profile) {
      // The name is carried through on update, not just on create: these are the
      // operator's own exports, and a re-export after tidying "PKC 32-!5176" back to
      // "PKC 32" should land. Nothing else in the system keys off this name -- checkout
      // attribution goes through the separate `profiles` table -- so a rename is safe.
      const renamed = account.profile.name !== parsed.sourceName;
      await prisma.vaultProfile.update({
        where: { id: account.profile.id },
        data: {
          ...fields,
          name: parsed.sourceName,
          profileKey: parsed.sourceName.toLowerCase(),
        },
      });
      updated++;
      if (renamed) renames++;
    } else {
      // The operator's own naming is kept verbatim here, unlike the members' upload:
      // these ARE the canonical names, and the bots' exports are keyed on them.
      await prisma.vaultProfile.create({
        data: { ...fields, name: parsed.sourceName, profileKey: parsed.sourceName.toLowerCase() },
      });
      created++;
    }
  }

  console.log(
    `\nWrote ${created} new and ${updated} updated ${SITE} profiles` +
      `${renames ? `, ${renames} renamed` : ""}.`,
  );
  if (unresolved.size) {
    writeTemplate([...unresolved.keys()], overrides);
    console.log(`${unresolved.size} unresolved name(s) written to ${MAP_FILE}.`);
  }
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

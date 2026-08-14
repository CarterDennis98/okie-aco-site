/**
 * One-time import of existing retailer accounts and checkout profiles into the vault.
 *
 *   npx tsx scripts/import-vault.ts --site target              # dry run (default)
 *   npx tsx scripts/import-vault.ts --site target --commit
 *   npx tsx scripts/import-vault.ts --site target --dir "F:/Documents/Okie ACO"
 *
 * DRY RUN BY DEFAULT. Nothing is written without --commit.
 *
 * This script handles real card numbers and real passwords. It NEVER prints them:
 * every line of output is a count, a profile name, or a masked email. Keep it that way
 * -- terminal scrollback and CI logs are exactly the places this data must not land.
 *
 * Idempotent: accounts upsert on (site, email) and profiles on (site, name), so a
 * re-run after fixing a mapping updates rather than duplicating.
 *
 * Facts the parsing depends on, all verified against the 269 real profiles:
 *   - Shikari names are canonical. 49 of 68 MacBook AYCD names carry suffixes like
 *     "-!50" that nothing else uses, so the two exports are joined on EMAIL, not name.
 *   - Every profile has exactly one account, matched by email.
 *   - nameOnCard always equalled the shipping name, so it is not stored.
 *   - sameBillingAndShipping disagreed with the addresses on 4 profiles -> the AYCD
 *     flag is authoritative and is copied verbatim.
 */
import "dotenv/config";
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";
import {
  detectBrand,
  last4,
  normalizeExpiry,
  normalizePan,
  isLuhnValid,
} from "../src/lib/vault/card";
import { encrypt } from "../src/lib/vault/crypto";

const require = createRequire(import.meta.url);

const MIRROR_REPO =
  process.env.MIRROR_REPO_PATH ?? path.join(process.cwd(), "..", "okie-aco-mirror");
// The bot's own normalizer, imported rather than reimplemented: a profile whose key
// differs by one character is attributed to the wrong member.
const scrape = require(path.join(MIRROR_REPO, "src/pas/scrape.js"));
const botProfiles = require(path.join(MIRROR_REPO, "src/pas/profiles.js"));

type Bundle = { label: string; accounts: string; shikari: string; aycd: string };

const SITE_BUNDLES: Record<string, Bundle[]> = {
  target: [
    {
      label: "main",
      accounts: "target_accounts.csv",
      shikari: "target_profiles_shikari.csv",
      aycd: "target_profiles_aycd.json",
    },
    {
      label: "macbook",
      accounts: "macbook_target_accounts_shikari.csv",
      shikari: "macbook_target_profiles_shikari.csv",
      aycd: "macbook_target_profiles_aycd.json",
    },
  ],
};

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const flag = (name: string, fallback?: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? (args[i + 1] ?? "") : fallback;
};
const has = (name: string) => args.includes(`--${name}`);

const SITE = flag("site", "target")!;
const DIR = flag("dir", "F:/Documents/Okie ACO")!;
const COMMIT = has("commit");
const MAP_FILE = flag("map", path.join(process.cwd(), "data", "vault-owner-map.json"))!;

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/** RFC4180 enough for these files: the accounts CSV quotes passwords containing commas. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (c !== "\r") field += c;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((v) => v !== ""));
}

function csvRows(file: string): Record<string, string>[] {
  const rows = parseCsv(readFileSync(path.join(DIR, file), "utf8"));
  const header = rows[0];
  return rows.slice(1).map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ""])));
}

type AycdProfile = {
  name: string;
  billingAddress: Record<string, string>;
  shippingAddress: Record<string, string>;
  paymentDetails: Record<string, string>;
  sameBillingAndShippingAddress: boolean;
  onlyCheckoutOnce: boolean;
  matchNameOnCardAndAddress: boolean;
};

const maskEmail = (email: string) => {
  const [user, domain] = String(email).split("@");
  return domain ? `${user.slice(0, 3)}***@${domain}` : "(none)";
};

const lower = (v: string) =>
  String(v ?? "")
    .trim()
    .toLowerCase();

// ---------------------------------------------------------------------------
// Load
// ---------------------------------------------------------------------------

type LoadedAccount = { email: string; password: string; source: string };
type LoadedProfile = {
  name: string;
  email: string;
  source: string;
  shikari: Record<string, string>;
  aycd: AycdProfile | null;
};

function load() {
  const bundles = SITE_BUNDLES[SITE];
  if (!bundles) throw new Error(`No import bundles configured for site "${SITE}".`);

  const accounts = new Map<string, LoadedAccount>();
  const accountConflicts: string[] = [];
  const profiles = new Map<string, LoadedProfile>();
  const profileConflicts: string[] = [];

  for (const bundle of bundles) {
    for (const file of [bundle.accounts, bundle.shikari, bundle.aycd]) {
      if (!existsSync(path.join(DIR, file)))
        throw new Error(`Missing export file: ${path.join(DIR, file)}`);
    }

    for (const row of csvRows(bundle.accounts)) {
      const email = lower(row.username);
      if (!email) continue;
      const existing = accounts.get(email);
      if (existing && existing.password !== row.password) {
        // Last wins, deliberately: the exports are append-ordered and the later row is
        // the corrected one. Always reported so it is never a silent choice.
        accountConflicts.push(
          `${maskEmail(email)} (${existing.source} -> ${bundle.label}, passwords differ)`,
        );
      }
      accounts.set(email, { email, password: row.password, source: bundle.label });
    }

    const aycdByEmail = new Map<string, AycdProfile>();
    for (const p of JSON.parse(
      readFileSync(path.join(DIR, bundle.aycd), "utf8"),
    ) as AycdProfile[]) {
      aycdByEmail.set(lower(p.shippingAddress?.email ?? ""), p);
    }

    for (const row of csvRows(bundle.shikari)) {
      const email = lower(row.email);
      const name = row.profile_name.trim();
      if (!email || !name) continue;

      const existing = profiles.get(email);
      if (existing) profileConflicts.push(`${maskEmail(email)}: "${existing.name}" and "${name}"`);

      profiles.set(email, {
        name,
        email,
        source: bundle.label,
        shikari: row,
        aycd: aycdByEmail.get(email) ?? null,
      });
    }
  }

  return { accounts, accountConflicts, profiles, profileConflicts };
}

// ---------------------------------------------------------------------------
// Owner resolution
// ---------------------------------------------------------------------------

/**
 * Owner overrides, read as STRINGS and refusing anything else.
 *
 * Discord snowflakes exceed 2^53, so an unquoted id here is silently mangled by
 * JSON.parse: 1466678173864296652 becomes ...296700, a user that does not exist. That
 * happened on the first real pass through this file and raised no error whatsoever,
 * which is why this is a hard failure rather than a coercion.
 */
function loadOwnerOverrides(): Record<string, string> {
  if (!existsSync(MAP_FILE)) return {};
  const raw = JSON.parse(readFileSync(MAP_FILE, "utf8")) as Record<string, unknown>;

  const numeric = Object.entries(raw)
    .filter(([, v]) => typeof v === "number")
    .map(([k]) => k);
  if (numeric.length) {
    throw new Error(
      `${MAP_FILE}: ${numeric.length} id(s) are unquoted numbers and have already lost precision ` +
        `(${numeric.slice(0, 3).join(", ")}${numeric.length > 3 ? ", ..." : ""}). ` +
        `Discord ids exceed 2^53 -- quote every value as a string.`,
    );
  }

  const entries: [string, string][] = [];
  for (const [key, value] of Object.entries(raw)) {
    if (value === null || value === "") continue;
    if (typeof value !== "string" || !/^\d{15,25}$/.test(value)) {
      throw new Error(`${MAP_FILE}: "${key}" is not a Discord user id string.`);
    }
    entries.push([key, value]);
  }
  return Object.fromEntries(entries);
}

function writeOwnerTemplate(unmapped: string[], existing: Record<string, string>) {
  const merged: Record<string, string | null> = { ...existing };
  for (const key of unmapped) if (!(key in merged)) merged[key] = null;
  mkdirSync(path.dirname(MAP_FILE), { recursive: true });
  writeFileSync(MAP_FILE, `${JSON.stringify(merged, null, 2)}\n`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const adapter = new PrismaPg({
  connectionString: process.env.DATABASE_URL,
  options: "-c timezone=UTC",
});
const prisma = new PrismaClient({ adapter });

async function main() {
  console.log(`Site: ${SITE}   Source: ${DIR}   Mode: ${COMMIT ? "COMMIT" : "DRY RUN"}\n`);

  const { accounts, accountConflicts, profiles, profileConflicts } = load();
  console.log(`Parsed ${accounts.size} accounts and ${profiles.size} profiles.`);

  if (accountConflicts.length) {
    console.log(`\nAccount collisions (later row kept):`);
    for (const c of accountConflicts) console.log(`  ${c}`);
  }
  if (profileConflicts.length) {
    console.log(`\n*** PROFILES SHARING AN EMAIL -- breaks the 1:1 rule, not importable:`);
    for (const c of profileConflicts) console.log(`  ${c}`);
  }

  // --- owner resolution -----------------------------------------------------
  const dbProfiles = new Map(
    (await prisma.profile.findMany({ select: { profileKey: true, discordUserId: true } })).map(
      (p) => [p.profileKey, p.discordUserId],
    ),
  );
  const members = new Set(
    (await prisma.discordMember.findMany({ select: { discordUserId: true } })).map(
      (m) => m.discordUserId,
    ),
  );
  const botMap =
    JSON.parse(readFileSync(path.join(MIRROR_REPO, "data", "profileMap.json"), "utf8")).map ?? {};
  const overrides = loadOwnerOverrides();

  type Resolved = LoadedProfile & {
    profileKey: string;
    profileIndex: number | null;
    owner: string | null;
    via: string;
  };
  const resolved: Resolved[] = [];
  const unmappedKeys = new Set<string>();
  // discordUserId -> the profile key that named them, used as a provisional username.
  const missingMember = new Map<string, string>();

  for (const profile of profiles.values()) {
    const parsed = scrape.normalizeProfile(profile.name);
    const profileKey: string = parsed?.profileKey ?? lower(profile.name);
    const profileIndex: number | null = parsed?.profileIndex ?? null;

    let owner: string | null = null;
    let via = "unmapped";

    if (overrides[profileKey]) {
      owner = overrides[profileKey];
      via = "override";
    } else if (dbProfiles.get(profileKey)) {
      owner = dbProfiles.get(profileKey)!;
      via = "db-profile";
    } else {
      const family = botProfiles.findMapping(profileKey, botMap);
      if (family?.userId) {
        owner = family.userId;
        via = "house-family";
      }
    }

    if (!owner) unmappedKeys.add(profileKey);
    else if (!members.has(owner)) {
      // These members exist in Discord but have never been billed, so nothing has
      // created a discord_members row for them yet. The vault's foreign key needs one.
      // Recorded here and created at commit time rather than skipped -- refusing to
      // import a member's own profiles because they happen not to owe money would be
      // the wrong outcome.
      missingMember.set(owner, profileKey);
      via = "needs-member-row";
    }

    resolved.push({ ...profile, profileKey, profileIndex, owner, via });
  }

  const byVia = new Map<string, number>();
  for (const r of resolved) byVia.set(r.via, (byVia.get(r.via) ?? 0) + 1);
  console.log(`\nOwner resolution:`);
  for (const [via, n] of [...byVia.entries()].sort((a, b) => b[1] - a[1]))
    console.log(`  ${via.padEnd(20)} ${n}`);

  if (unmappedKeys.size) {
    writeOwnerTemplate([...unmappedKeys], overrides);
    console.log(`\n${unmappedKeys.size} profile name(s) have no owner. Template written to:`);
    console.log(`  ${MAP_FILE}`);
    console.log(`  Fill in a Discord user id for each, then re-run.`);
    console.log(`  ${[...unmappedKeys].sort().join(", ")}`);
  }
  if (missingMember.size) {
    console.log(
      `\n${missingMember.size} owner(s) have no discord_members row yet (never billed).` +
        `\n  A minimal row will be created for each, with the profile name as a PROVISIONAL` +
        `\n  username. Their real Discord handle overwrites it on first sign-in.`,
    );
  }

  // --- validation -----------------------------------------------------------
  const problems: string[] = [];
  const importable = resolved.filter((r) => {
    if (!r.owner) return false;
    if (!accounts.has(r.email)) {
      problems.push(`${r.name}: no account for ${maskEmail(r.email)}`);
      return false;
    }
    const pan = normalizePan(r.shikari.cc_number);
    if (!pan) {
      problems.push(`${r.name}: no card number`);
      return false;
    }
    if (!isLuhnValid(pan)) problems.push(`${r.name}: card fails the Luhn check (importing anyway)`);
    if (!r.shikari.cc_cvv) problems.push(`${r.name}: no CVV`);
    if (!r.aycd)
      problems.push(
        `${r.name}: no AYCD row; billing flags fall back to Shikari's blank-billing rule`,
      );
    return true;
  });

  if (problems.length) {
    console.log(`\nData notes (${problems.length}):`);
    for (const p of problems.slice(0, 20)) console.log(`  ${p}`);
    if (problems.length > 20) console.log(`  ...and ${problems.length - 20} more`);
  }

  const orphanAccounts = [...accounts.values()].filter((a) => !profiles.has(a.email));
  console.log(
    `\nReady to import: ${importable.length} profiles, ${accounts.size} accounts (${orphanAccounts.length} with no profile).`,
  );

  const brands = new Map<string, number>();
  for (const r of importable)
    brands.set(
      detectBrand(r.shikari.cc_number),
      (brands.get(detectBrand(r.shikari.cc_number)) ?? 0) + 1,
    );
  console.log(`Card brands: ${[...brands.entries()].map(([b, n]) => `${b}=${n}`).join(", ")}`);

  if (!COMMIT) {
    console.log(`\nDRY RUN -- nothing written. Re-run with --commit to apply.`);
    return;
  }

  // --- write ----------------------------------------------------------------
  // Member rows first: everything below has a foreign key to them. Create-only, so a
  // re-run can never overwrite a real Discord username with the provisional one.
  let membersCreated = 0;
  for (const [discordUserId, provisionalName] of missingMember) {
    const existing = await prisma.discordMember.findUnique({
      where: { discordUserId },
      select: { discordUserId: true },
    });
    if (existing) continue;
    await prisma.discordMember.create({
      data: { discordUserId, username: provisionalName, roles: [] },
    });
    membersCreated++;
  }
  if (membersCreated) console.log(`\nCreated ${membersCreated} provisional member row(s).`);

  // Accounts first: a profile's accountId is required, and the unique (site, email)
  // pair is what makes the 1:1 rule structural.
  const accountIdByEmail = new Map<string, string>();
  let accountsWritten = 0;
  for (const account of accounts.values()) {
    const owner = resolved.find((r) => r.email === account.email && r.owner)?.owner;
    if (!owner) continue; // an orphan account has no member to attribute it to yet
    const passwordEnc = encrypt(account.password, { entity: "vault_account", field: "password" });
    const row = await prisma.vaultAccount.upsert({
      where: { siteKey_email: { siteKey: SITE, email: account.email } },
      create: { siteKey: SITE, email: account.email, passwordEnc, discordUserId: owner },
      update: { passwordEnc, discordUserId: owner },
      select: { id: true },
    });
    accountIdByEmail.set(account.email, row.id);
    accountsWritten++;
  }

  let profilesWritten = 0;
  for (const r of importable) {
    const accountId = accountIdByEmail.get(r.email);
    if (!accountId) continue;

    const s = r.shikari;
    const pan = normalizePan(s.cc_number);
    const { month, year } = normalizeExpiry(s.cc_exp_month, s.cc_exp_year);
    // AYCD's flag is authoritative -- it disagreed with the addresses on 4 profiles.
    const sameBilling = r.aycd
      ? r.aycd.sameBillingAndShippingAddress
      : s.billing_street.trim() === "";

    const data = {
      siteKey: SITE,
      discordUserId: r.owner!,
      name: r.name,
      profileKey: r.profileKey,
      profileIndex: r.profileIndex,
      accountId,
      firstName: s.first_name,
      lastName: s.last_name,
      phone: s.phone_num || null,
      shipLine1: s.shipping_street,
      shipLine2: s.shipping_street_2 || null,
      shipCity: s.shipping_city,
      shipState: s.shipping_state,
      shipPostalCode: s.shipping_zip_code,
      shipCountry: s.shipping_country || "US",
      sameBillingAndShipping: sameBilling,
      billFirstName: sameBilling ? null : s.billing_first_name || null,
      billLastName: sameBilling ? null : s.billing_last_name || null,
      billLine1: sameBilling ? null : s.billing_street || null,
      billLine2: sameBilling ? null : s.billing_street_2 || null,
      billCity: sameBilling ? null : s.billing_city || null,
      billState: sameBilling ? null : s.billing_state || null,
      billPostalCode: sameBilling ? null : s.billing_zip_code || null,
      billCountry: sameBilling ? null : s.billing_country || null,
      cardBrand: detectBrand(pan),
      cardLast4: last4(pan),
      cardExpMonth: month,
      cardExpYear: year,
      cardNumberEnc: encrypt(pan, { entity: "vault_profile", field: "card_number" }),
      cardCvvEnc: encrypt(s.cc_cvv, { entity: "vault_profile", field: "card_cvv" }),
      onlyCheckoutOnce: r.aycd?.onlyCheckoutOnce ?? false,
      matchNameOnCardAndAddress: r.aycd?.matchNameOnCardAndAddress ?? true,
      updatedBy: "import",
    };

    await prisma.vaultProfile.upsert({
      where: { siteKey_name: { siteKey: SITE, name: r.name } },
      create: data,
      update: data,
    });
    profilesWritten++;
  }

  console.log(`\nWrote ${accountsWritten} accounts and ${profilesWritten} profiles.`);
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });

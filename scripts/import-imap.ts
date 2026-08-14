/**
 * One-time import of email app passwords exported from Shikari.
 *
 *   npx tsx scripts/import-imap.ts                            # dry run (default)
 *   npx tsx scripts/import-imap.ts --commit
 *   npx tsx scripts/import-imap.ts --file "F:/path/to/export.csv"
 *
 * DRY RUN BY DEFAULT. Nothing is written without --commit.
 *
 * Like import-vault.ts, this handles live credentials and NEVER prints them. Every
 * line of output is a count or a masked address.
 *
 * ATTRIBUTION IS THE WHOLE PROBLEM. The CSV is a flat list of mailboxes with no
 * owner column, and `email_credentials.discord_user_id` says whose inbox this is --
 * get it wrong and one member holds another's mail password. So only two sources of
 * attribution are accepted:
 *
 *   1. The address is already a `vault_accounts.email`, which is owned.
 *   2. The address appears in data/imap-owner-map.json, filled in by hand.
 *
 * Anything else is skipped and written into that map as `null` for you to resolve.
 * Deliberately NO fuzzy matching: "bgloade6@gmail.com" looks like it belongs to
 * whoever owns "bgloade4@gmail.com", and it usually would -- but "usually" is not a
 * standard worth applying to someone's mailbox.
 *
 * Host and port come from the CSV, not from a domain lookup: the export knows about
 * self-hosted and vanity domains that a lookup table would guess wrong.
 *
 * Idempotent: upserts on the unique `email`, so a re-run after filling in the map
 * adds the newly-resolved rows and rotates any password that changed.
 */
import "dotenv/config";
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";
import { encrypt } from "../src/lib/vault/crypto";

const args = process.argv.slice(2);
const flag = (name: string, fallback?: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? (args[i + 1] ?? "") : fallback;
};
const has = (name: string) => args.includes(`--${name}`);

const FILE = flag("file", "F:/Chrome Downloads/shikari_imap_accounts.csv")!;
const COMMIT = has("commit");
const MAP_FILE = flag("map", path.join(process.cwd(), "data", "imap-owner-map.json"))!;

/** Enough of RFC4180 for this file; shares its shape with import-vault.ts. */
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

/** Never print an address in full. */
function mask(email: string): string {
  const [local = "", domain = ""] = email.split("@");
  return `${local.slice(0, 3)}${local.length > 3 ? "***" : ""}@${domain}`;
}

function loadOwnerOverrides(): Record<string, string> {
  if (!existsSync(MAP_FILE)) return {};
  const raw = JSON.parse(readFileSync(MAP_FILE, "utf8")) as Record<string, unknown>;

  // Same trap as the profile map: an unquoted snowflake has already lost precision by
  // the time JSON.parse returns, so refuse the file rather than import wrong owners.
  const numeric = Object.entries(raw)
    .filter(([, v]) => typeof v === "number")
    .map(([k]) => k);
  if (numeric.length) {
    throw new Error(
      `${MAP_FILE}: ${numeric.length} id(s) are unquoted numbers and have already lost ` +
        `precision. Discord ids exceed 2^53 -- quote every value as a string.`,
    );
  }

  const entries: [string, string][] = [];
  for (const [key, value] of Object.entries(raw)) {
    if (value === null || value === "") continue;
    if (typeof value !== "string" || !/^\d{15,25}$/.test(value)) {
      throw new Error(`${MAP_FILE}: "${mask(key)}" is not a Discord user id string.`);
    }
    entries.push([key.trim().toLowerCase(), value]);
  }
  return Object.fromEntries(entries);
}

function writeOwnerTemplate(unmapped: string[], existing: Record<string, string>) {
  const merged: Record<string, string | null> = { ...existing };
  for (const email of unmapped) if (!(email in merged)) merged[email] = null;
  mkdirSync(path.dirname(MAP_FILE), { recursive: true });
  writeFileSync(MAP_FILE, `${JSON.stringify(merged, null, 2)}\n`);
}

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

async function main() {
  console.log(`Source: ${FILE}   Mode: ${COMMIT ? "COMMIT" : "DRY RUN"}\n`);

  const rows = parseCsv(readFileSync(FILE, "utf8"));
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const need = ["imap_server", "port", "username", "password"];
  const missing = need.filter((c) => !header.includes(c));
  if (missing.length) throw new Error(`${FILE}: missing column(s) ${missing.join(", ")}`);

  const records = rows
    .slice(1)
    .map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ""])));

  // Owned addresses: a retailer account's email belongs to whoever holds the account.
  const accounts = await prisma.vaultAccount.findMany({
    select: { email: true, discordUserId: true },
  });
  const ownerByEmail = new Map(
    accounts.map((a) => [a.email.trim().toLowerCase(), a.discordUserId]),
  );
  const overrides = loadOwnerOverrides();

  // A credential can only hang off a member row that exists.
  const members = new Set(
    (await prisma.discordMember.findMany({ select: { discordUserId: true } })).map(
      (m) => m.discordUserId,
    ),
  );

  type Resolved = {
    email: string;
    password: string;
    host: string;
    port: number;
    ownerId: string;
    via: "account" | "map";
  };

  const resolved: Resolved[] = [];
  const unmapped: string[] = [];
  const orphaned: string[] = [];
  const seen = new Set<string>();
  let duplicates = 0;
  let blank = 0;

  for (const rec of records) {
    const email = rec.username.trim().toLowerCase();
    const password = rec.password.trim();
    if (!email || !password) {
      blank++;
      continue;
    }
    if (seen.has(email)) {
      duplicates++;
      continue;
    }
    seen.add(email);

    const ownerId = ownerByEmail.get(email) ?? overrides[email] ?? null;
    if (!ownerId) {
      unmapped.push(email);
      continue;
    }
    // An override naming a member who isn't in the guild would fail the foreign key
    // mid-run; catch it here where the message can say which address.
    if (!members.has(ownerId)) {
      orphaned.push(email);
      continue;
    }

    const port = Number.parseInt(rec.port, 10);
    resolved.push({
      email,
      password,
      host: rec.imap_server.trim(),
      port: Number.isFinite(port) ? port : 993,
      ownerId,
      via: ownerByEmail.has(email) ? "account" : "map",
    });
  }

  const viaAccount = resolved.filter((r) => r.via === "account").length;
  console.log(`  rows       : ${records.length}`);
  console.log(
    `  attributed : ${resolved.length} (${viaAccount} via account, ${resolved.length - viaAccount} via map)`,
  );
  console.log(`  unmapped   : ${unmapped.length}`);
  if (orphaned.length)
    console.log(`  no member  : ${orphaned.length} -> ${orphaned.map(mask).join(", ")}`);
  if (duplicates) console.log(`  duplicates : ${duplicates}`);
  if (blank) console.log(`  blank      : ${blank}`);

  const byOwner = new Map<string, number>();
  for (const r of resolved) byOwner.set(r.ownerId, (byOwner.get(r.ownerId) ?? 0) + 1);
  console.log(`  members    : ${byOwner.size} covered`);

  if (COMMIT) {
    let written = 0;
    for (const r of resolved) {
      const appPasswordEnc = encrypt(r.password, {
        entity: "email_credential",
        field: "app_password",
      });
      await prisma.emailCredential.upsert({
        where: { email: r.email },
        create: {
          discordUserId: r.ownerId,
          email: r.email,
          appPasswordEnc,
          imapHost: r.host,
          imapPort: r.port,
        },
        // Owner is re-asserted: if an address moved to a different member's account,
        // the account table is the truth and this row follows it.
        update: {
          discordUserId: r.ownerId,
          appPasswordEnc,
          imapHost: r.host,
          imapPort: r.port,
        },
      });
      written++;
    }
    console.log(`\nWrote ${written} credential(s).`);
  } else {
    console.log(`\nDRY RUN -- nothing written. Re-run with --commit to apply.`);
  }

  if (unmapped.length) {
    writeOwnerTemplate(unmapped, overrides);
    console.log(
      `\n${unmapped.length} address(es) could not be attributed and were skipped.\n` +
        `Fill in the Discord id (as a quoted string) for each in:\n  ${MAP_FILE}\n` +
        `then re-run. Leave one null to keep skipping it.`,
    );
  }
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

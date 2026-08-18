import { prisma } from "@/db/client";
import { requireAdmin } from "@/lib/auth/guard";
import { siteStyle } from "@/lib/sites";
import { loadMailboxCoverage, mailboxFor } from "@/db/queries/email-coverage";
import { toAccountList, toAycdProfile } from "@/lib/vault/aycd";
import { decrypt } from "@/lib/vault/crypto";

/**
 * Profile export — the ONLY place in the system that decrypts stored secrets.
 *
 *   /api/admin/vault/export?site=target                  every member, main bot
 *   /api/admin/vault/export?site=target&bot=backup       every member, past the cap
 *   /api/admin/vault/export?site=target&member=<id>      one member
 *   /api/admin/vault/export?site=target&format=accounts  username:password list
 *   /api/admin/vault/export?site=target&format=imap      mailbox app passwords, CSV
 *
 * Guarded by `requireAdmin`, which 404s rather than 403s, and every call writes a
 * `vault_exports` row before the body is produced. If credentials ever surface
 * somewhere they shouldn't, that table is the trail.
 *
 * BOT SPLIT: each retailer has a soft cap on how many of a member's profiles the main
 * bot runs. `bot=main` yields the first N active profiles per member, `bot=backup` the
 * rest, `bot=all` ignores the cap. Splitting here rather than by hand afterwards is the
 * point -- a mis-split file puts a member's profile on two bots at once.
 *
 * Inactive profiles are never exported: a disabled profile is one the member asked not
 * to run.
 */
export const dynamic = "force-dynamic";

type BotScope = "main" | "backup" | "all";

export async function GET(request: Request) {
  // Throws NEXT_NOT_FOUND for anyone who isn't an admin.
  const viewer = await requireAdmin();

  const url = new URL(request.url);
  const siteKey = url.searchParams.get("site") ?? "";
  const memberId = url.searchParams.get("member");
  const bot = (url.searchParams.get("bot") ?? "all") as BotScope;
  const format = url.searchParams.get("format") ?? "aycd";

  if (!siteKey) return new Response("Missing site", { status: 400 });
  if (!["main", "backup", "all"].includes(bot))
    return new Response("Bad bot scope", { status: 400 });
  if (!["aycd", "accounts", "imap"].includes(format))
    return new Response("Bad format", { status: 400 });

  const rows = await prisma.vaultProfile.findMany({
    where: { siteKey, active: true, ...(memberId ? { discordUserId: memberId } : {}) },
    include: { account: { select: { email: true, passwordEnc: true } } },
  });

  // Apply the soft cap PER MEMBER, in the same name order the UI shows.
  const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });
  const cap = siteStyle(siteKey).profileSoftCap;
  const byMember = new Map<string, typeof rows>();
  for (const row of rows) {
    const list = byMember.get(row.discordUserId) ?? [];
    list.push(row);
    byMember.set(row.discordUserId, list);
  }

  const selected: typeof rows = [];
  for (const list of byMember.values()) {
    list.sort((a, b) => collator.compare(a.name, b.name));
    if (bot === "all" || cap === undefined) {
      // No cap configured means the main bot runs everything; a backup export is empty.
      if (bot === "backup" && cap === undefined) continue;
      selected.push(...list);
    } else if (bot === "main") {
      selected.push(...list.slice(0, cap));
    } else {
      selected.push(...list.slice(cap));
    }
  }
  selected.sort((a, b) => collator.compare(a.name, b.name));

  // Mailboxes, not profiles. Ten accounts forwarding into one inbox need that inbox's
  // app password once, so each account email resolves through the forwarding map and the
  // DISTINCT destinations are what gets exported. Resolved here, above the audit row, so
  // the recorded count is the number of credentials actually handed over -- this reads
  // no ciphertext, so nothing is decrypted before the export is recorded.
  const mailboxes = new Set<string>();
  if (format === "imap") {
    const coverage = await loadMailboxCoverage();
    for (const row of selected) {
      const box = mailboxFor(coverage, row.account.email);
      if (box) mailboxes.add(box.toLowerCase());
    }
  }

  // Audited BEFORE the secrets are decrypted, so a crash mid-export still leaves the
  // record that an export was attempted.
  await prisma.vaultExport.create({
    data: {
      actorDiscordId: viewer.discordUserId,
      siteKey,
      format,
      scope: memberId ? "member" : "site",
      targetDiscordId: memberId,
      profileCount: format === "aycd" ? selected.length : 0,
      accountCount: format === "aycd" ? 0 : format === "imap" ? mailboxes.size : selected.length,
    },
  });

  const stamp = new Date().toISOString().slice(0, 10);
  const suffix = [siteKey, bot === "all" ? null : bot, memberId ? "member" : null, stamp]
    .filter(Boolean)
    .join("-");

  if (format === "imap") {
    // The bot split is deliberately ignored here: a mailbox can cover profiles on both
    // bots, and splitting it would hand the backup a file with holes in it.
    const credentials = await prisma.emailCredential.findMany({
      where: { email: { in: [...mailboxes] } },
      orderBy: { email: "asc" },
    });

    // Same column order as the Shikari export this data was imported from, so the file
    // drops straight back in without conversion.
    const lines = ["imap_server,port,username,password"];
    for (const credential of credentials) {
      const password = decrypt(credential.appPasswordEnc, {
        entity: "email_credential",
        field: "app_password",
      });
      lines.push(
        [
          credential.imapHost ?? "",
          String(credential.imapPort ?? 993),
          credential.email,
          // Gmail app passwords carry spaces; quote so a naive CSV reader keeps them.
          `"${password.replaceAll('"', '""')}"`,
        ].join(","),
      );
    }

    return fileResponse(
      `${lines.join("\n")}\n`,
      `okie-imap-${suffix}.csv`,
      "text/csv; charset=utf-8",
    );
  }

  if (format === "accounts") {
    // Accounts with no password are skipped rather than emitted with a blank one: on a
    // guest-checkout retailer there is no login to hand a bot, and "email:" with nothing
    // after it reads as a credential that failed to decrypt.
    const body = toAccountList(
      selected
        .filter((row) => row.account.passwordEnc)
        .map((row) => ({
          email: row.account.email,
          password: decrypt(row.account.passwordEnc!, {
            entity: "vault_account",
            field: "password",
          }),
        })),
    );
    return fileResponse(body, `okie-accounts-${suffix}.txt`, "text/plain; charset=utf-8");
  }

  const profiles = selected.map((row) =>
    toAycdProfile({
      ...row,
      email: row.account.email,
      cardNumber: decrypt(row.cardNumberEnc, { entity: "vault_profile", field: "card_number" }),
      cardCvv: decrypt(row.cardCvvEnc, { entity: "vault_profile", field: "card_cvv" }),
    }),
  );

  return fileResponse(
    JSON.stringify(profiles, null, 2),
    `okie-profiles-${suffix}.json`,
    "application/json",
  );
}

function fileResponse(body: string, filename: string, contentType: string): Response {
  return new Response(body, {
    headers: {
      "content-type": contentType,
      "content-disposition": `attachment; filename="${filename}"`,
      // Belt and braces: this body is plaintext credentials, so nothing may cache it.
      "cache-control": "no-store, no-cache, must-revalidate, private",
      pragma: "no-cache",
    },
  });
}

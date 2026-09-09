import { prisma } from "@/db/client";
import { requireAdmin } from "@/lib/auth/guard";
import { siteStyle, siteUsesAccounts, siteUsesProfiles } from "@/lib/sites";
import { loadMailboxCoverage, mailboxFor } from "@/db/queries/email-coverage";
import { toAccountList, toAycdProfile } from "@/lib/vault/aycd";
import { decrypt } from "@/lib/vault/crypto";

/**
 * Profile export — the ONLY place in the system that decrypts stored secrets.
 *
 *   /api/admin/vault/export?site=target                  every member, main bot
 *   /api/admin/vault/export?site=target&bot=backup       every member, past the cap
 *   /api/admin/vault/export?site=target&member=<id>      one member
 *   /api/admin/vault/export?site=target&member=<a>&member=<b>   several, one file
 *   /api/admin/vault/export?site=target&format=accounts  username:password list
 *   /api/admin/vault/export?format=imap                  EVERY mailbox app password, CSV
 *   /api/admin/vault/export?format=imap&member=<id>      one member's, CSV
 *
 * `site` is required by every format EXCEPT `imap`, which has no retailer in it: a mailbox
 * belongs to a person and its codes cover whichever retailers that person uses. Scoping the
 * app-password file per site produced overlapping files with no way to tell which was
 * current, so the site-less form is now the one the UI links to. `site` is still accepted
 * there for the old links.
 *
 * Guarded by `requireAdmin`, which 404s rather than 403s, and every call writes a
 * `vault_exports` row before the body is produced -- ONE PER MEMBER when several were
 * selected, so the table can still say whose credentials left. If credentials ever surface
 * somewhere they shouldn't, that table is the trail.
 *
 * LOGIN-ONLY RETAILERS (Costco) have accounts and no profiles, so `format=accounts` reads
 * the accounts directly and `format=aycd` is refused rather than answered with `[]`. No
 * bot split applies: a login does not belong to one bot instance. See usesProfiles.
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

/** Ceiling on `?member=` repeats. See the check in GET for why it refuses rather than trims. */
const MAX_MEMBERS = 200;

export async function GET(request: Request) {
  // Throws NEXT_NOT_FOUND for anyone who isn't an admin.
  const viewer = await requireAdmin();

  const url = new URL(request.url);
  const siteKey = url.searchParams.get("site") ?? "";
  // REPEATABLE: `&member=a&member=b` exports both in one file. Deduped, because the picker
  // can send the same id twice and `in: [x, x]` would be a silent no-op to debug.
  const memberIds = [
    ...new Set(
      url.searchParams
        .getAll("member")
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ];
  const bot = (url.searchParams.get("bot") ?? "all") as BotScope;
  const format = url.searchParams.get("format") ?? "aycd";

  if (!["main", "backup", "all"].includes(bot))
    return new Response("Bad bot scope", { status: 400 });
  if (!["aycd", "accounts", "imap"].includes(format))
    return new Response("Bad format", { status: 400 });
  // Every format but `imap` is a list OF PROFILES on one retailer, so it cannot mean
  // anything without a site. App passwords can, and that is the form the UI uses.
  if (!siteKey && format !== "imap") return new Response("Missing site", { status: 400 });

  // Site-less app passwords: the credentials are the subject, so this path never touches
  // the profile table or the per-retailer bot cap at all.
  const everyMailbox = format === "imap" && !siteKey;

  // Refused rather than answered with an empty file. On a guest-checkout retailer there are
  // no logins and no emailed codes, so both of these used to produce a valid-looking export
  // with nothing in it -- which reads as "this member has no credentials saved" rather than
  // "this retailer has none to save". The UI hides the buttons; this is the half that holds
  // for a hand-typed URL.
  if (format === "accounts" && !siteUsesAccounts(siteKey)) {
    return new Response(
      `${siteStyle(siteKey).label} checks out as a guest — there are no logins.`,
      {
        status: 400,
      },
    );
  }
  // Two reasons a retailer can be flagged that way -- guest checkout emails no code at
  // all, and a login we sign into by hand needs no stored password to read one -- so the
  // message says what holds for both rather than picking one and being wrong on the other.
  if (format === "imap" && siteKey && siteStyle(siteKey).usesEmailCodes === false) {
    return new Response(
      `Nothing reads mail for ${siteStyle(siteKey).label} — no app password applies.`,
      { status: 400 },
    );
  }
  // A login-only retailer holds accounts and no profiles, so its AYCD file would come out
  // as `[]` -- which reads as "nobody has saved anything" rather than "this retailer
  // stores no cards". `accounts` and `imap` both still work here: on Costco the login IS
  // the record, and the order is placed by hand from the member's own account.
  const loginOnly = Boolean(siteKey) && !siteUsesProfiles(siteKey);
  if (loginOnly && format === "aycd") {
    return new Response(
      `${siteStyle(siteKey).label} stores a login only — there are no checkout profiles to export.`,
      { status: 400 },
    );
  }
  // A hand-typed `bot=backup` here would otherwise hand back every login under a filename
  // saying "backup", which is the export failure that costs the most to find: a file whose
  // name says one thing and whose contents say another.
  if (loginOnly && bot !== "all") {
    return new Response(
      `${siteStyle(siteKey).label} logins aren't split between bots — drop the bot parameter.`,
      { status: 400 },
    );
  }
  // A bound rather than a guess: this is a GET, and past a few hundred ids the URL itself
  // starts getting truncated by something in the middle. Refuse loudly instead of
  // exporting a silently short list, which for an export is the dangerous failure.
  if (memberIds.length > MAX_MEMBERS) {
    return new Response(`Too many members (max ${MAX_MEMBERS}). Export the whole site instead.`, {
      status: 400,
    });
  }

  // Wrapped so the empty case can be typed as the same row array rather than `never[]`,
  // which nothing downstream could push into.
  const loadProfiles = () =>
    prisma.vaultProfile.findMany({
      where: {
        siteKey,
        active: true,
        ...(memberIds.length > 0 ? { discordUserId: { in: memberIds } } : {}),
      },
      include: { account: { select: { email: true, passwordEnc: true } } },
    });
  type ProfileRow = Awaited<ReturnType<typeof loadProfiles>>[number];

  const rows: ProfileRow[] = everyMailbox || loginOnly ? [] : await loadProfiles();

  // The whole record on a login-only retailer, straight off the accounts: there is no
  // profile to reach them through and no bot cap to split them by, because nothing about
  // a login belongs to one bot instance.
  //
  // Inactive logins are left out, for the same reason an inactive profile is: a member who
  // switched one off has asked us not to use it.
  const logins = loginOnly
    ? await prisma.vaultAccount.findMany({
        where: {
          siteKey,
          active: true,
          ...(memberIds.length > 0 ? { discordUserId: { in: memberIds } } : {}),
        },
        orderBy: { email: "asc" },
        select: { email: true, passwordEnc: true, discordUserId: true },
      })
    : [];

  const loginsByMember = new Map<string, typeof logins>();
  for (const login of logins) {
    loginsByMember.set(login.discordUserId, [
      ...(loginsByMember.get(login.discordUserId) ?? []),
      login,
    ]);
  }

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
  // Per member as well as overall, so a multi-member export can record what each person's
  // share of it actually was rather than attributing the whole file to all of them.
  const mailboxesByMember = new Map<string, Set<string>>();
  if (everyMailbox) {
    // Straight off the credentials: with no retailer in the request there is no profile
    // list to resolve through, and a mailbox with no active profile behind it is still a
    // live app password the bot needs.
    const credentials = await prisma.emailCredential.findMany({
      where: memberIds.length > 0 ? { discordUserId: { in: memberIds } } : {},
      select: { email: true, discordUserId: true },
    });
    for (const credential of credentials) {
      const box = credential.email.toLowerCase();
      mailboxes.add(box);
      const mine = mailboxesByMember.get(credential.discordUserId) ?? new Set<string>();
      mine.add(box);
      mailboxesByMember.set(credential.discordUserId, mine);
    }
  } else if (format === "imap") {
    const coverage = await loadMailboxCoverage();
    // The addresses in scope, from whichever table holds them on this retailer. A
    // login-only site has no profiles to resolve through, and its logins are exactly as
    // likely to need a code read out of an inbox -- the operator signs in by hand.
    const addresses = loginOnly
      ? logins.map((login) => ({ email: login.email, discordUserId: login.discordUserId }))
      : selected.map((row) => ({ email: row.account.email, discordUserId: row.discordUserId }));

    for (const { email, discordUserId } of addresses) {
      const box = mailboxFor(coverage, email);
      if (!box) continue;
      mailboxes.add(box.toLowerCase());
      const mine = mailboxesByMember.get(discordUserId) ?? new Set<string>();
      mine.add(box.toLowerCase());
      mailboxesByMember.set(discordUserId, mine);
    }
  }

  const selectedByMember = new Map<string, typeof selected>();
  for (const row of selected) {
    const list = selectedByMember.get(row.discordUserId) ?? [];
    list.push(row);
    selectedByMember.set(row.discordUserId, list);
  }

  // `accounts` is passed separately from `profiles` because on a login-only retailer the
  // two disagree: there are no profiles, and counting the file's credentials as 0 would
  // leave `vault_exports` claiming an empty export of the one thing that did leave.
  const countsFor = (profiles: typeof selected, accounts: number, boxes: number) => ({
    profileCount: format === "aycd" ? profiles.length : 0,
    accountCount: format === "aycd" ? 0 : format === "imap" ? boxes : accounts,
  });

  // Audited BEFORE the secrets are decrypted, so a crash mid-export still leaves the
  // record that an export was attempted.
  //
  // ONE ROW PER MEMBER when several were selected. `target_discord_id` holds a single id,
  // and the point of this table is answering "whose credentials left, and when" -- a lone
  // row with a null target and a total count cannot answer it for any of them. A
  // single-member export keeps the exact shape it always had, so nothing downstream that
  // reads scope='member' changes.
  //
  // Members with no active profiles here get no row: nothing of theirs was in the file.
  //
  // `vault_exports.site_key` is NOT NULL, so a site-less app-password export records the
  // literal "all" -- no retailer is called that, and the alternative would be a migration
  // to make the column nullable for a value that reads worse than the word does.
  const auditSite = everyMailbox ? "all" : siteKey;
  // On the site-less path the members are whoever holds a credential, not whoever has a
  // profile -- `selectedByMember` is empty there, and using it would write no audit row at
  // all for an export of everybody's passwords.
  // On a login-only retailer the members in the file are whoever holds a login, for the
  // same reason: `selectedByMember` is built from profiles and is empty there.
  const auditMembers: [string, ProfileRow[]][] = everyMailbox
    ? [...mailboxesByMember.keys()].map((id) => [id, []])
    : loginOnly
      ? [...loginsByMember.keys()].map((id) => [id, []])
      : [...selectedByMember.entries()];

  if (memberIds.length > 1) {
    await prisma.vaultExport.createMany({
      data: auditMembers.map(([discordUserId, profiles]) => ({
        actorDiscordId: viewer.discordUserId,
        siteKey: auditSite,
        format,
        scope: "members",
        targetDiscordId: discordUserId,
        ...countsFor(
          profiles,
          loginOnly ? (loginsByMember.get(discordUserId)?.length ?? 0) : profiles.length,
          mailboxesByMember.get(discordUserId)?.size ?? 0,
        ),
      })),
    });
  } else {
    await prisma.vaultExport.create({
      data: {
        actorDiscordId: viewer.discordUserId,
        siteKey: auditSite,
        format,
        scope: memberIds.length === 1 ? "member" : everyMailbox ? "all" : "site",
        targetDiscordId: memberIds[0] ?? null,
        ...countsFor(selected, loginOnly ? logins.length : selected.length, mailboxes.size),
      },
    });
  }

  const stamp = new Date().toISOString().slice(0, 10);
  const scopeLabel =
    memberIds.length === 1 ? "member" : memberIds.length > 1 ? `${memberIds.length}-members` : null;
  const suffix = [
    siteKey || (everyMailbox ? "all" : null),
    bot === "all" ? null : bot,
    scopeLabel,
    stamp,
  ]
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
    // One shape from either table: a login-only retailer's accounts stand alone, and
    // everywhere else they hang off the profile that was selected and split by bot.
    const accounts = loginOnly
      ? logins
      : selected.map((row) => ({ email: row.account.email, passwordEnc: row.account.passwordEnc }));

    // Accounts with no password are skipped rather than emitted with a blank one: on a
    // guest-checkout retailer there is no login to hand a bot, and "email:" with nothing
    // after it reads as a credential that failed to decrypt.
    const body = toAccountList(
      accounts
        .filter((account) => account.passwordEnc)
        .map((account) => ({
          email: account.email,
          password: decrypt(account.passwordEnc!, {
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

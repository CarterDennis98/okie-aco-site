"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/db/client";
import { defaultAssignee } from "@/db/queries/runners";
import { VaultAction, VaultEntity } from "@/generated/prisma/enums";
import { requireMember } from "@/lib/auth/guard";
import {
  isKnownSite,
  siteImportsValor,
  siteStoresPassword,
  siteStyle,
  siteUsesProfiles,
  supportedSites,
} from "@/lib/sites";
import { recordBulkChange, type ChangeRecord } from "@/lib/vault/audit";
import {
  parseAccountList,
  parseAycdExport,
  planImport,
  type ImportIssue,
  type ParsedProfile,
} from "@/lib/vault/aycd-import";
import { encrypt } from "@/lib/vault/crypto";
import { profileIdentity } from "@/lib/vault/profile-input";
import { isValorExport, parseValorExport } from "@/lib/vault/valor-import";

/**
 * Member-facing profile import. Every export here calls `requireMember()`.
 *
 * The counterpart to the admin AYCD export: a member keeps their profiles in AYCD
 * Toolbox, and this reads that file rather than making them retype fifteen addresses.
 * Where the retailer allows it (`importsValor` -- Pokémon Center), the file may be Valor's
 * own profile export instead. Which one it is is read from the file itself, and both go
 * through the same checks and the same writes below.
 *
 * What it does NOT do, deliberately:
 *
 *   - Trust the `name` in the file. Profile names are server-assigned, same rule as the
 *     add form: `<their base> - N`, filling gaps. A file naming a profile "carter - 3"
 *     when that name belongs to someone else would otherwise collide on (site, name).
 *   - Create an account without a retailer password. A profile export -- AYCD's or
 *     Valor's -- carries cards and addresses but no logins, so a genuinely new account
 *     needs one supplied, and a row without one is reported rather than half-written --
 *     except where the retailer keeps no password at all (Mattel, guest checkout), which
 *     neither asks nor stores.
 *   - Log or echo anything it decrypted or was handed. Failures name a profile, never a
 *     value.
 */

/** A JSON profile export is a few KB per profile; this is far past 250 of them. */
const MAX_BYTES = 4 * 1024 * 1024;

export type ImportSummary = {
  ok: true;
  created: number;
  updated: number;
  skipped: number;
  /** Addresses that would be new accounts but had no password supplied. */
  needPassword: string[];
  issues: ImportIssue[];
};

export type ImportResult = ImportSummary | { ok: false; error: string; issues?: ImportIssue[] };

/** The columns an imported profile sets, identical on create and update. */
function profileFields(parsed: ParsedProfile) {
  return {
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
    cardNumberEnc: encrypt(parsed.cardNumber, { entity: "vault_profile", field: "card_number" }),
    cardCvvEnc: encrypt(parsed.cardCvv, { entity: "vault_profile", field: "card_cvv" }),
  };
}

async function readUpload(form: FormData, key: string): Promise<string | null> {
  const file = form.get(key);
  if (!(file instanceof File) || file.size === 0) return null;
  if (file.size > MAX_BYTES) throw new Error(`${file.name} is too large.`);
  return file.text();
}

/** "Pokémon Center", or "Pokémon Center and Mattel" -- wherever a Valor file is taken. */
function valorRetailers(): string {
  const labels = supportedSites()
    .filter((site) => siteImportsValor(site.key))
    .map((site) => site.label);
  return new Intl.ListFormat("en", { type: "conjunction" }).format(labels);
}

export async function importProfileFile(form: FormData): Promise<ImportResult> {
  const viewer = await requireMember();

  const siteKey = String(form.get("siteKey") ?? "");
  if (!isKnownSite(siteKey)) return { ok: false, error: "Pick a retailer." };
  // A profile export is a file of cards and addresses, and a login-only retailer stores
  // neither -- so there is nothing here to import into. The picker already leaves those
  // out; this is the half that holds for a crafted POST. See usesProfiles in sites.ts.
  if (!siteUsesProfiles(siteKey)) {
    return { ok: false, error: `${siteStyle(siteKey).label} stores a login only.` };
  }

  let profilesText: string | null;
  let accountsText: string | null;
  try {
    profilesText = await readUpload(form, "profiles");
    accountsText = await readUpload(form, "accounts");
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Upload failed." };
  }
  if (!profilesText) return { ok: false, error: "Choose a profile export to import." };

  // Which bot wrote it, read from the file -- see isValorExport. Refused where the retailer
  // doesn't take Valor's format: the form only says where it does, and this is what a
  // crafted POST has to get past. See importsValor in sites.ts.
  const source = isValorExport(profilesText) ? "Valor" : "AYCD";
  if (source === "Valor" && !siteImportsValor(siteKey)) {
    return {
      ok: false,
      error: `That's a Valor profile export, which imports on ${valorRetailers()} only. For ${siteStyle(siteKey).label}, export your profiles from AYCD.`,
    };
  }

  const { profiles, issues } =
    source === "Valor" ? parseValorExport(profilesText) : parseAycdExport(profilesText);
  if (profiles.length === 0) {
    return { ok: false, error: "Nothing importable in that file.", issues };
  }
  const passwords = accountsText ? parseAccountList(accountsText) : new Map<string, string>();

  // Existing state, read once: every account on this site (to detect addresses held by
  // someone else) and every profile name (the unique is across all members).
  const [accounts, allProfiles] = await Promise.all([
    prisma.vaultAccount.findMany({
      where: { siteKey, email: { in: profiles.map((p) => p.email) } },
      select: {
        id: true,
        email: true,
        discordUserId: true,
        assigneeId: true,
        profile: { select: { id: true } },
      },
    }),
    prisma.vaultProfile.findMany({
      where: { siteKey },
      select: { name: true, discordUserId: true },
    }),
  ]);

  const plan = planImport({
    profiles,
    accounts: accounts.map((a) => ({
      id: a.id,
      email: a.email,
      discordUserId: a.discordUserId,
      profileId: a.profile?.id ?? null,
    })),
    takenNames: allProfiles.map((p) => p.name),
    myNames: allProfiles.filter((p) => p.discordUserId === viewer.discordUserId).map((p) => p.name),
    passwords,
    viewerDiscordId: viewer.discordUserId,
    viewerUsername: viewer.username,
    storesPassword: siteStoresPassword(siteKey),
  });
  issues.push(...plan.issues);

  const changes: ChangeRecord[] = [];

  // Who runs each row, so every change lands in that runner's queue. An existing login
  // keeps whoever holds it; a new one goes where the member's others do -- decided once,
  // before any are written, so one upload cannot split itself across runners.
  const assigneeOf = new Map(accounts.map((a) => [a.id, a.assigneeId]));
  const newAssignee = plan.creates.some((create) => !create.accountId)
    ? await defaultAssignee(siteKey, viewer.discordUserId)
    : null;

  for (const update of plan.updates) {
    const row = await prisma.vaultProfile.update({
      where: { id: update.profileId },
      data: profileFields(update.parsed),
      select: { id: true, name: true },
    });
    if (update.password) {
      await prisma.vaultAccount.update({
        where: { id: update.accountId },
        data: {
          passwordEnc: encrypt(update.password, { entity: "vault_account", field: "password" }),
        },
      });
    }
    changes.push({
      actorDiscordId: viewer.discordUserId,
      ownerDiscordId: viewer.discordUserId,
      entity: VaultEntity.VAULT_PROFILE,
      entityId: row.id,
      action: VaultAction.UPDATE,
      siteKey,
      assigneeId: assigneeOf.get(update.accountId) ?? null,
      label: row.name,
      fields: [`imported from ${source}`],
    });
  }

  for (const create of plan.creates) {
    let accountId = create.accountId;
    if (!accountId) {
      // `newAssignee` is set whenever a create has no account to hang off -- see above.
      const account = await prisma.vaultAccount.create({
        data: {
          siteKey,
          email: create.parsed.email,
          // Null only where the retailer keeps no password at all (Mattel, guest checkout);
          // everywhere else planImport has already held back any create without one.
          passwordEnc: create.password
            ? encrypt(create.password, { entity: "vault_account", field: "password" })
            : null,
          discordUserId: viewer.discordUserId,
          assigneeId: newAssignee!,
        },
        select: { id: true, assigneeId: true },
      });
      accountId = account.id;
      assigneeOf.set(account.id, account.assigneeId);
    }

    const row = await prisma.vaultProfile.create({
      data: {
        siteKey,
        discordUserId: viewer.discordUserId,
        name: create.name,
        // Derived from the assigned name with the bot's own normalizer, so a checkout
        // attributed to "carter - 3" still resolves to this member.
        ...profileIdentity(create.name),
        accountId,
        active: true,
        ...profileFields(create.parsed),
      },
      select: { id: true },
    });
    changes.push({
      actorDiscordId: viewer.discordUserId,
      ownerDiscordId: viewer.discordUserId,
      entity: VaultEntity.VAULT_PROFILE,
      entityId: row.id,
      action: VaultAction.CREATE,
      siteKey,
      assigneeId: assigneeOf.get(accountId) ?? null,
      label: create.name,
      fields: [`imported from ${source}`],
    });
  }

  const created = plan.creates.length;
  const updated = plan.updates.length;
  const skipped = plan.needPassword.length + plan.issues.length;

  // One notification for one upload, N rows in the trail. See recordBulkChange.
  await recordBulkChange(
    changes,
    viewer.displayName,
    `imported ${created} new and ${updated} updated ${siteKey} profile${
      created + updated === 1 ? "" : "s"
    } from ${source}`,
  );

  revalidatePath("/dashboard/profiles");
  return { ok: true, created, updated, skipped, needPassword: plan.needPassword, issues };
}

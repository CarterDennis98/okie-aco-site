"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/db/client";
import { VaultAction, VaultEntity } from "@/generated/prisma/enums";
import { requireMember } from "@/lib/auth/guard";
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

/**
 * Member-facing AYCD import. Every export here calls `requireMember()`.
 *
 * The counterpart to the admin AYCD export: a member keeps their profiles in AYCD
 * Toolbox, and this reads that file rather than making them retype fifteen addresses.
 *
 * What it does NOT do, deliberately:
 *
 *   - Trust the `name` in the file. Profile names are server-assigned, same rule as the
 *     add form: `<their base> - N`, filling gaps. A file naming a profile "carter - 3"
 *     when that name belongs to someone else would otherwise collide on (site, name).
 *   - Create an account without a retailer password. AYCD's profile export carries cards
 *     and addresses but no logins, so a genuinely new account needs one supplied, and a
 *     row without one is reported rather than half-written.
 *   - Log or echo anything it decrypted or was handed. Failures name a profile, never a
 *     value.
 */

const SITE_KEYS = new Set(["target", "walmart", "pokemon-center", "best-buy", "sams-club"]);

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

export async function importAycdProfiles(form: FormData): Promise<ImportResult> {
  const viewer = await requireMember();

  const siteKey = String(form.get("siteKey") ?? "");
  if (!SITE_KEYS.has(siteKey)) return { ok: false, error: "Pick a retailer." };

  let profilesText: string | null;
  let accountsText: string | null;
  try {
    profilesText = await readUpload(form, "profiles");
    accountsText = await readUpload(form, "accounts");
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Upload failed." };
  }
  if (!profilesText) return { ok: false, error: "Choose an AYCD profile export to import." };

  const { profiles, issues } = parseAycdExport(profilesText);
  if (profiles.length === 0) {
    return { ok: false, error: "Nothing importable in that file.", issues };
  }
  const passwords = accountsText ? parseAccountList(accountsText) : new Map<string, string>();

  // Existing state, read once: every account on this site (to detect addresses held by
  // someone else) and every profile name (the unique is across all members).
  const [accounts, allProfiles] = await Promise.all([
    prisma.vaultAccount.findMany({
      where: { siteKey, email: { in: profiles.map((p) => p.email) } },
      select: { id: true, email: true, discordUserId: true, profile: { select: { id: true } } },
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
  });
  issues.push(...plan.issues);

  const changes: ChangeRecord[] = [];

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
      label: row.name,
      fields: ["imported from AYCD"],
    });
  }

  for (const create of plan.creates) {
    const accountId =
      create.accountId ??
      (
        await prisma.vaultAccount.create({
          data: {
            siteKey,
            email: create.parsed.email,
            passwordEnc: encrypt(create.password!, {
              entity: "vault_account",
              field: "password",
            }),
            discordUserId: viewer.discordUserId,
          },
          select: { id: true },
        })
      ).id;

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
      label: create.name,
      fields: ["imported from AYCD"],
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
    } from AYCD`,
  );

  revalidatePath("/dashboard/profiles");
  return { ok: true, created, updated, skipped, needPassword: plan.needPassword, issues };
}

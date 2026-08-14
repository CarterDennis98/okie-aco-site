"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/db/client";
import { getMemberProfile, type VaultProfileDetail } from "@/db/queries/vault";
import { VaultAction, VaultEntity } from "@/generated/prisma/enums";
import { requireMember } from "@/lib/auth/guard";
import { changedFields, recordChange } from "@/lib/vault/audit";
import { detectBrand, last4, normalizePan } from "@/lib/vault/card";
import { encrypt } from "@/lib/vault/crypto";
import { revealCredential, type RevealResult } from "@/lib/vault/reveal";
import {
  bool,
  nextProfileName,
  profileBaseFor,
  profileFieldsFromForm,
  profileIdentity,
  text,
  validateProfileForm,
} from "@/lib/vault/profile-input";

/**
 * Every write to the vault.
 *
 * Rules that hold for all of them:
 *
 *   - `requireMember()` is called INSIDE each action. A Server Action is an
 *     individually-addressable POST endpoint; being rendered on a guarded page protects
 *     it exactly as much as nothing.
 *   - The owner id comes from the guard's return value, never from the form. Every
 *     lookup by id carries both predicates, so a member cannot touch another's row even
 *     by editing the hidden input.
 *   - Secrets are WRITE-ONLY. A blank secret field means "leave unchanged"; it can never
 *     mean "clear it", because nothing can read the value back to confirm the intent.
 *   - Nothing is logged. Not the values, not the form payload, not on error.
 */

export type ActionResult = { ok: true } | { ok: false; error: string };

// Not a full RFC 5322 grammar on purpose: this rejects typos, and the address is proved
// real by whether a verification code ever arrives.
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/**
 * Full detail for the edit form, fetched on demand.
 *
 * An action rather than a prop: the list page would otherwise have to ship every
 * address and flag for every profile to the browser just to open one form. Guarded and
 * ownership-scoped like every other entry point -- it returns null for a profile that
 * isn't theirs, never a 403 that would confirm the id exists.
 */
export async function loadProfileForEdit(profileId: string): Promise<VaultProfileDetail | null> {
  const viewer = await requireMember();
  return getMemberProfile(viewer.discordUserId, profileId);
}

/**
 * Show the member their own app password.
 *
 * The one read-back in the member surface. Scoped by BOTH the address and the owner id
 * from the guard, so a member cannot reveal a password on someone else's mailbox by
 * editing the form. Every call lands in `vault_reveals`.
 */
export async function revealOwnAppPassword(form: FormData): Promise<RevealResult> {
  const viewer = await requireMember();
  const email = String(form.get("email") ?? "")
    .trim()
    .toLowerCase();
  if (!email) return { ok: false, error: "Missing address." };

  // Matches the mailbox itself OR any address forwarding into it, so revealing from a
  // forwarded account row returns the password that actually opens the inbox.
  const credential = await prisma.emailCredential.findFirst({
    where: {
      discordUserId: viewer.discordUserId,
      OR: [{ email }, { aliases: { some: { email } } }],
    },
    select: { id: true, email: true, appPasswordEnc: true, discordUserId: true },
  });
  return revealCredential(credential, viewer.discordUserId);
}

const SITE_KEYS = new Set(["target", "walmart", "pokemon-center", "best-buy", "sams-club"]);

// ---------------------------------------------------------------------------

export async function saveProfile(form: FormData): Promise<ActionResult> {
  const viewer = await requireMember();

  const profileId = text(form, "profileId");
  const siteKey = text(form, "siteKey");
  if (!SITE_KEYS.has(siteKey)) return { ok: false, error: "Unknown retailer." };

  const problem = validateProfileForm(form, !profileId);
  if (problem) return { ok: false, error: problem };

  const email = text(form, "email").toLowerCase();
  if (!EMAIL_RE.test(email)) return { ok: false, error: "Enter a valid account email." };

  const pan = normalizePan(text(form, "cardNumber"));
  const cvv = text(form, "cardCvv");
  const password = text(form, "accountPassword");
  const fields = profileFieldsFromForm(form);

  // Secrets are only ever written when supplied. Absent means unchanged.
  const cardSecrets = pan
    ? {
        cardBrand: detectBrand(pan),
        cardLast4: last4(pan),
        cardNumberEnc: encrypt(pan, { entity: "vault_profile", field: "card_number" }),
        cardCvvEnc: encrypt(cvv, { entity: "vault_profile", field: "card_cvv" }),
      }
    : {};

  try {
    if (!profileId) {
      // --- create -----------------------------------------------------------
      const account = await prisma.vaultAccount.upsert({
        where: { siteKey_email: { siteKey, email } },
        create: {
          siteKey,
          email,
          discordUserId: viewer.discordUserId,
          passwordEnc: encrypt(password, { entity: "vault_account", field: "password" }),
        },
        // An existing account must belong to this member, or the email is taken.
        update: {},
        select: { id: true, discordUserId: true, profile: { select: { id: true } } },
      });

      if (account.discordUserId !== viewer.discordUserId) {
        return { ok: false, error: "That account email is already in use." };
      }
      if (account.profile) {
        // One account, one profile -- the rule the schema enforces.
        return { ok: false, error: "That email already has a profile. Edit it instead." };
      }
      if (!password) return { ok: false, error: "Enter the retailer account password." };

      // The name is GENERATED, never taken from the form. Members don't get to pick or
      // change it: the name is what ties a checkout back to a profile, and a free-text
      // rename would let history point at the wrong card and address.
      const siblings = await prisma.vaultProfile.findMany({
        where: { siteKey },
        select: { name: true, discordUserId: true },
      });
      const mine = siblings
        .filter((s) => s.discordUserId === viewer.discordUserId)
        .map((s) => s.name);
      const base = profileBaseFor(mine, viewer.username);
      const name = nextProfileName(
        base,
        // All names on the site, because (site, name) is unique across members.
        siblings.map((s) => s.name),
      );

      const created = await prisma.vaultProfile.create({
        data: {
          ...fields,
          ...(cardSecrets as Required<typeof cardSecrets>),
          siteKey,
          discordUserId: viewer.discordUserId,
          accountId: account.id,
          name,
          // The SAME normalizer the checkout pipeline uses, not a lookalike regex --
          // a key that differs by one character never joins to the member's checkouts.
          ...profileIdentity(name),
          updatedBy: viewer.discordUserId,
        },
        select: { id: true, name: true },
      });

      await recordChange(
        {
          actorDiscordId: viewer.discordUserId,
          ownerDiscordId: viewer.discordUserId,
          entity: VaultEntity.VAULT_PROFILE,
          entityId: created.id,
          action: VaultAction.CREATE,
          siteKey,
          label: created.name,
        },
        viewer.displayName,
      );
    } else {
      // --- update -----------------------------------------------------------
      const existing = await prisma.vaultProfile.findFirst({
        where: { id: profileId, discordUserId: viewer.discordUserId },
        select: {
          id: true,
          name: true,
          accountId: true,
          account: { select: { email: true } },
          ...ALL_PLAIN,
        },
      });
      if (!existing) return { ok: false, error: "Profile not found." };

      const changed = changedFields(existing as Record<string, unknown>, fields);
      if (pan) changed.push("card");
      if (password) changed.push("account password");
      if (email !== existing.account.email) changed.push("account email");

      // `fields` carries no name, so the existing one -- and its key -- are untouched.
      // Renaming is not offered at all; see the create branch for why.
      await prisma.vaultProfile.update({
        where: { id: existing.id },
        data: { ...fields, ...cardSecrets, updatedBy: viewer.discordUserId },
      });

      if (password || email !== existing.account.email) {
        await prisma.vaultAccount.update({
          where: { id: existing.accountId },
          data: {
            ...(email !== existing.account.email ? { email } : {}),
            ...(password
              ? { passwordEnc: encrypt(password, { entity: "vault_account", field: "password" }) }
              : {}),
          },
        });
      }

      if (changed.length) {
        await recordChange(
          {
            actorDiscordId: viewer.discordUserId,
            ownerDiscordId: viewer.discordUserId,
            entity: VaultEntity.VAULT_PROFILE,
            entityId: existing.id,
            action: VaultAction.UPDATE,
            siteKey,
            label: existing.name,
            fields: changed,
          },
          viewer.displayName,
        );
      }
    }
  } catch (error) {
    // Never surface the raw error: it can echo the submitted row back to the browser.
    console.error("vault: saveProfile failed", error instanceof Error ? error.message : "unknown");
    return { ok: false, error: "Couldn't save that. Check the profile name and email are unique." };
  }

  revalidatePath("/dashboard/profiles");
  return { ok: true };
}

/** The plain columns compared for the audit diff. Secrets are excluded by construction. */
const ALL_PLAIN = {
  firstName: true,
  lastName: true,
  phone: true,
  shipLine1: true,
  shipLine2: true,
  shipCity: true,
  shipState: true,
  shipPostalCode: true,
  shipCountry: true,
  sameBillingAndShipping: true,
  billFirstName: true,
  billLastName: true,
  billLine1: true,
  billLine2: true,
  billCity: true,
  billState: true,
  billPostalCode: true,
  billCountry: true,
  cardExpMonth: true,
  cardExpYear: true,
  matchNameOnCardAndAddress: true,
  onlyCheckoutOnce: true,
} as const;

export async function setProfileActive(form: FormData): Promise<ActionResult> {
  const viewer = await requireMember();
  const profileId = text(form, "profileId");
  const active = bool(form, "active");

  const profile = await prisma.vaultProfile.findFirst({
    where: { id: profileId, discordUserId: viewer.discordUserId },
    select: { id: true, name: true, siteKey: true, active: true },
  });
  if (!profile) return { ok: false, error: "Profile not found." };
  if (profile.active === active) return { ok: true };

  await prisma.vaultProfile.update({ where: { id: profile.id }, data: { active } });

  await recordChange(
    {
      actorDiscordId: viewer.discordUserId,
      ownerDiscordId: viewer.discordUserId,
      entity: VaultEntity.VAULT_PROFILE,
      entityId: profile.id,
      action: active ? VaultAction.ACTIVATE : VaultAction.DEACTIVATE,
      siteKey: profile.siteKey,
      label: profile.name,
    },
    viewer.displayName,
  );

  revalidatePath("/dashboard/profiles");
  return { ok: true };
}

export async function deleteProfile(form: FormData): Promise<ActionResult> {
  const viewer = await requireMember();
  const profileId = text(form, "profileId");

  const profile = await prisma.vaultProfile.findFirst({
    where: { id: profileId, discordUserId: viewer.discordUserId },
    select: { id: true, name: true, siteKey: true, accountId: true },
  });
  if (!profile) return { ok: false, error: "Profile not found." };

  // The account goes with it: one account serves exactly one profile, so leaving it
  // behind would strand a login nobody can see or reach.
  await prisma.vaultProfile.delete({ where: { id: profile.id } });
  await prisma.vaultAccount.delete({ where: { id: profile.accountId } });

  await recordChange(
    {
      actorDiscordId: viewer.discordUserId,
      ownerDiscordId: viewer.discordUserId,
      entity: VaultEntity.VAULT_PROFILE,
      entityId: profile.id,
      action: VaultAction.DELETE,
      siteKey: profile.siteKey,
      label: profile.name,
    },
    viewer.displayName,
  );

  revalidatePath("/dashboard/profiles");
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Email app passwords
// ---------------------------------------------------------------------------

/** Sensible IMAP defaults so a member never has to know what a host is. */
const IMAP_HOSTS: Record<string, { host: string; port: number }> = {
  "gmail.com": { host: "imap.gmail.com", port: 993 },
  "googlemail.com": { host: "imap.gmail.com", port: 993 },
  "icloud.com": { host: "imap.mail.me.com", port: 993 },
  "me.com": { host: "imap.mail.me.com", port: 993 },
  "yahoo.com": { host: "imap.mail.yahoo.com", port: 993 },
  "outlook.com": { host: "outlook.office365.com", port: 993 },
  "hotmail.com": { host: "outlook.office365.com", port: 993 },
  "live.com": { host: "outlook.office365.com", port: 993 },
  "aol.com": { host: "imap.aol.com", port: 993 },
};

export async function saveEmailCredential(form: FormData): Promise<ActionResult> {
  const viewer = await requireMember();

  const email = text(form, "email").toLowerCase();
  const appPassword = text(form, "appPassword");
  if (!EMAIL_RE.test(email)) return { ok: false, error: "Enter a valid email address." };
  if (!appPassword) return { ok: false, error: "Enter the app password." };

  const domain = email.split("@")[1] ?? "";
  const imap = IMAP_HOSTS[domain] ?? null;

  const existing = await prisma.emailCredential.findUnique({
    where: { email },
    select: { id: true, discordUserId: true },
  });
  if (existing && existing.discordUserId !== viewer.discordUserId) {
    // Deliberately the same wording as a success would not be -- but it must not
    // confirm that the address is registered to somebody else either.
    return { ok: false, error: "That address can't be added." };
  }

  const appPasswordEnc = encrypt(appPassword, {
    entity: "email_credential",
    field: "app_password",
  });

  const row = await prisma.emailCredential.upsert({
    where: { email },
    create: {
      email,
      discordUserId: viewer.discordUserId,
      appPasswordEnc,
      imapHost: imap?.host ?? null,
      imapPort: imap?.port ?? null,
    },
    // A new password invalidates whatever the last verification said.
    update: { appPasswordEnc, verifiedAt: null, lastError: null },
    select: { id: true },
  });

  // An address with its own password no longer forwards anywhere -- the two claims are
  // mutually exclusive, and leaving the alias behind would make coverage depend on the
  // order the two tables happen to be read in.
  await prisma.emailAlias.deleteMany({ where: { email, discordUserId: viewer.discordUserId } });

  await recordChange(
    {
      actorDiscordId: viewer.discordUserId,
      ownerDiscordId: viewer.discordUserId,
      entity: VaultEntity.EMAIL_CREDENTIAL,
      entityId: row.id,
      action: existing ? VaultAction.UPDATE : VaultAction.CREATE,
      label: email,
      fields: ["app password"],
    },
    viewer.displayName,
  );

  revalidatePath("/dashboard/profiles");
  return { ok: true };
}

/**
 * Mark an address as forwarding into a mailbox that already has an app password.
 *
 * Ten Target accounts on ten addresses that all land in one Gmail need one app password,
 * not ten. Rather than asking for the same password ten times -- which would mean ten
 * ciphertexts to rotate when the member revokes it -- the address points at the mailbox.
 *
 * Three rules, all enforced here rather than trusted from the form:
 *   - The destination credential must be the member's own.
 *   - An address that holds its own app password cannot also forward; that would be two
 *     answers to "where does this code arrive".
 *   - An address cannot forward to itself.
 */
export async function saveEmailAlias(form: FormData): Promise<ActionResult> {
  const viewer = await requireMember();
  const email = text(form, "email").toLowerCase();
  const credentialId = text(form, "credentialId");

  if (!email || !EMAIL_RE.test(email)) return { ok: false, error: "Enter a valid email address." };
  if (!credentialId) return { ok: false, error: "Pick the inbox it forwards to." };

  const credential = await prisma.emailCredential.findFirst({
    where: { id: credentialId, discordUserId: viewer.discordUserId },
    select: { id: true, email: true },
  });
  if (!credential) return { ok: false, error: "Not found." };

  if (credential.email.toLowerCase() === email) {
    return { ok: false, error: "That address already has its own app password." };
  }

  const ownPassword = await prisma.emailCredential.findFirst({
    where: { email, discordUserId: viewer.discordUserId },
    select: { id: true },
  });
  if (ownPassword) {
    return {
      ok: false,
      error: "That address has its own app password. Remove it first if it forwards instead.",
    };
  }

  // Unique on email globally, so a re-point is an update rather than a second row.
  const existing = await prisma.emailAlias.findUnique({
    where: { email },
    select: { id: true, discordUserId: true },
  });
  if (existing && existing.discordUserId !== viewer.discordUserId) {
    return { ok: false, error: "That address is already claimed." };
  }

  const row = await prisma.emailAlias.upsert({
    where: { email },
    create: { discordUserId: viewer.discordUserId, email, credentialId: credential.id },
    update: { credentialId: credential.id },
    select: { id: true },
  });

  await recordChange(
    {
      actorDiscordId: viewer.discordUserId,
      ownerDiscordId: viewer.discordUserId,
      entity: VaultEntity.EMAIL_ALIAS,
      entityId: row.id,
      action: existing ? VaultAction.UPDATE : VaultAction.CREATE,
      label: `${email} -> ${credential.email}`,
      fields: ["forwards to"],
    },
    viewer.displayName,
  );

  revalidatePath("/dashboard/profiles");
  return { ok: true };
}

export async function deleteEmailAlias(form: FormData): Promise<ActionResult> {
  const viewer = await requireMember();
  const id = text(form, "aliasId");

  const existing = await prisma.emailAlias.findFirst({
    where: { id, discordUserId: viewer.discordUserId },
    select: { id: true, email: true, credential: { select: { email: true } } },
  });
  if (!existing) return { ok: false, error: "Not found." };

  await prisma.emailAlias.delete({ where: { id: existing.id } });

  await recordChange(
    {
      actorDiscordId: viewer.discordUserId,
      ownerDiscordId: viewer.discordUserId,
      entity: VaultEntity.EMAIL_ALIAS,
      entityId: existing.id,
      action: VaultAction.DELETE,
      label: `${existing.email} -> ${existing.credential.email}`,
    },
    viewer.displayName,
  );

  revalidatePath("/dashboard/profiles");
  return { ok: true };
}

export async function deleteEmailCredential(form: FormData): Promise<ActionResult> {
  const viewer = await requireMember();
  const id = text(form, "credentialId");

  const existing = await prisma.emailCredential.findFirst({
    where: { id, discordUserId: viewer.discordUserId },
    select: { id: true, email: true },
  });
  if (!existing) return { ok: false, error: "Not found." };

  await prisma.emailCredential.delete({ where: { id: existing.id } });

  await recordChange(
    {
      actorDiscordId: viewer.discordUserId,
      ownerDiscordId: viewer.discordUserId,
      entity: VaultEntity.EMAIL_CREDENTIAL,
      entityId: existing.id,
      action: VaultAction.DELETE,
      label: existing.email,
    },
    viewer.displayName,
  );

  revalidatePath("/dashboard/profiles");
  return { ok: true };
}

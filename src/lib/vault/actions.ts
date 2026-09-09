"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/db/client";
import { getMemberProfile, type VaultProfileDetail } from "@/db/queries/vault";
import { VaultAction, VaultEntity } from "@/generated/prisma/enums";
import { requireMember } from "@/lib/auth/guard";
import { isKnownSite, siteStyle, siteUsesAccounts, siteUsesProfiles } from "@/lib/sites";
import { changedFields, recordBulkChange, recordChange } from "@/lib/vault/audit";
import { detectBrand, last4, normalizePan } from "@/lib/vault/card";
import { encrypt } from "@/lib/vault/crypto";
import { domainOf, unsupportedMessage } from "@/lib/vault/email-providers";
import { resolveMailProvider } from "@/lib/vault/email-mx";
import { revealCredential, type RevealResult } from "@/lib/vault/reveal";
import { testCredential, type ImapTestOutcome } from "@/lib/vault/imap-test";
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

/**
 * Check one of your own app passwords against the mail server.
 *
 * Scoped by owner in the query, so an id belonging to somebody else reads as missing --
 * same shape as the reveal above. The cooldown and the column writes live in imap-test.ts,
 * because the operator's sweep must behave identically.
 */
export async function testOwnEmailCredential(form: FormData): Promise<ImapTestOutcome> {
  const viewer = await requireMember();
  const email = String(form.get("email") ?? "")
    .trim()
    .toLowerCase();
  if (!email) return { ok: false, verdict: false, label: "Missing", message: "Missing address." };

  const credential = await prisma.emailCredential.findFirst({
    where: { discordUserId: viewer.discordUserId, email },
    select: {
      id: true,
      email: true,
      appPasswordEnc: true,
      imapHost: true,
      imapPort: true,
      lastCheckedAt: true,
    },
  });

  const outcome = await testCredential(credential);
  // Only when something was actually recorded: a throttled press changed nothing, and
  // re-rendering the page for it would make the button feel like it did something.
  if (!outcome.throttled) revalidatePath("/dashboard/profiles");
  return outcome;
}

// ---------------------------------------------------------------------------

export async function saveProfile(form: FormData): Promise<ActionResult> {
  const viewer = await requireMember();

  const profileId = text(form, "profileId");
  const siteKey = text(form, "siteKey");
  if (!isKnownSite(siteKey)) return { ok: false, error: "Unknown retailer." };
  // A login-only retailer has no card and no address to store, so a `vault_profile` row
  // here would be a row of invented placeholders. `saveLogin` is the write path for
  // those; this refusal is what holds when the form is bypassed. See usesProfiles.
  if (!siteUsesProfiles(siteKey)) {
    return { ok: false, error: `${siteStyle(siteKey).label} stores a login only.` };
  }

  // siteKey is passed only after the check above: the phone rule is per-retailer, and an
  // unknown key would silently mean "no rule".
  const problem = validateProfileForm(form, !profileId, siteKey);
  if (problem) return { ok: false, error: problem };

  const email = text(form, "email").toLowerCase();
  if (!EMAIL_RE.test(email)) return { ok: false, error: "Enter a valid account email." };

  const pan = normalizePan(text(form, "cardNumber"));
  const cvv = text(form, "cardCvv");
  const fields = profileFieldsFromForm(form);

  // Guest-checkout retailers have no login, so a password is not just optional here --
  // it is meaningless, and anything submitted for one is discarded rather than stored
  // against an account that cannot use it. `passwordEnc` stays null, which the schema
  // defines as "no login" rather than "password unknown".
  const usesAccounts = siteUsesAccounts(siteKey);
  const password = usesAccounts ? text(form, "accountPassword") : "";

  // Checked BEFORE the account is created. This used to sit after the upsert, so a
  // create with no password left an orphan vault_account holding an encrypted empty
  // string -- and because the upsert's `update` is empty, retrying with a real password
  // would never replace it.
  if (!profileId && usesAccounts && !password) {
    return { ok: false, error: "Enter the retailer account password." };
  }

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
          passwordEnc: password
            ? encrypt(password, { entity: "vault_account", field: "password" })
            : null,
        },
        // An existing account must belong to this member, or the email is taken.
        update: {},
        select: { id: true, discordUserId: true, profile: { select: { id: true, name: true } } },
      });

      if (account.discordUserId !== viewer.discordUserId) {
        return { ok: false, error: "That account email is already in use." };
      }
      if (account.profile) {
        // One account, one profile -- the rule the schema enforces. Named, so the member
        // can go straight to the profile holding the address instead of hunting for it.
        return {
          ok: false,
          error: `${account.profile.name} already uses that email on this retailer. Each profile needs its own.`,
        };
      }
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

      // One email per retailer, checked BEFORE the write. The (siteKey, email) unique
      // index already makes this impossible, but reaching it throws a constraint error
      // that surfaces as the generic "couldn't save that" -- which does not tell the
      // member the address is the problem, or which profile already holds it.
      if (email !== existing.account.email) {
        const taken = await prisma.vaultAccount.findUnique({
          where: { siteKey_email: { siteKey, email } },
          select: { discordUserId: true, profile: { select: { name: true } } },
        });
        if (taken) {
          const mine = taken.discordUserId === viewer.discordUserId;
          return {
            ok: false,
            error:
              mine && taken.profile
                ? `${taken.profile.name} already uses that email on this retailer. Each profile needs its own.`
                : "That account email is already in use.",
          };
        }
      }

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

/**
 * Enable or disable several profiles at once.
 *
 * Same ownership rule as everywhere else: ids come from the form, but the query carries
 * both predicates, so adding someone else's id to the POST selects nothing rather than
 * touching their row.
 *
 * Profiles ALREADY in the requested state are skipped, not rewritten. Bulk-disabling a
 * selection that happens to include three disabled rows should not stamp three audit
 * entries claiming a change that didn't happen -- the count returned is the number that
 * actually moved, which is also what the UI reports back.
 *
 * One notification for one action, matching `deleteProfiles`: a member switching off
 * twenty profiles is one decision, and twenty webhook lines would train the operator to
 * ignore the channel.
 */
export async function setProfilesActive(
  form: FormData,
): Promise<ActionResult & { changed?: number }> {
  const viewer = await requireMember();
  const ids = form.getAll("profileId").map(String).filter(Boolean);
  const active = bool(form, "active");
  if (ids.length === 0) return { ok: false, error: "Nothing selected." };

  const profiles = await prisma.vaultProfile.findMany({
    where: { id: { in: ids }, discordUserId: viewer.discordUserId, active: !active },
    select: { id: true, name: true, siteKey: true },
  });
  // Not an error: the selection was valid, there was just nothing left to do. The UI
  // phrases `changed: 0` rather than showing a failure for a no-op.
  if (profiles.length === 0) return { ok: true, changed: 0 };

  await prisma.vaultProfile.updateMany({
    where: { id: { in: profiles.map((p) => p.id) } },
    data: { active },
  });

  await recordBulkChange(
    profiles.map((profile) => ({
      actorDiscordId: viewer.discordUserId,
      ownerDiscordId: viewer.discordUserId,
      entity: VaultEntity.VAULT_PROFILE,
      entityId: profile.id,
      action: active ? VaultAction.ACTIVATE : VaultAction.DEACTIVATE,
      siteKey: profile.siteKey,
      label: profile.name,
    })),
    viewer.displayName,
    `${active ? "enabled" : "disabled"} ${profiles.length} profile${
      profiles.length === 1 ? "" : "s"
    }`,
  );

  revalidatePath("/dashboard/profiles");
  return { ok: true, changed: profiles.length };
}

/**
 * Remove several profiles at once.
 *
 * Ownership comes from the guard and the
 * query carries both predicates, so a member cannot delete another's row by adding an id
 * to the form. Ids that aren't theirs are silently absent from the result rather than
 * erroring -- the count that comes back says how many actually went.
 *
 * One notification for one action. Fifty separate webhook lines for a member tidying up
 * would train the operator to ignore the channel.
 */
export async function deleteProfiles(form: FormData): Promise<ActionResult & { removed?: number }> {
  const viewer = await requireMember();
  const ids = form.getAll("profileId").map(String).filter(Boolean);
  if (ids.length === 0) return { ok: false, error: "Nothing selected." };

  const profiles = await prisma.vaultProfile.findMany({
    where: { id: { in: ids }, discordUserId: viewer.discordUserId },
    select: { id: true, name: true, siteKey: true, accountId: true },
  });
  if (profiles.length === 0) return { ok: false, error: "Not found." };

  // The accounts go with them: one account serves exactly one profile, so leaving them
  // behind would strand logins nobody can see or reach.
  await prisma.$transaction([
    prisma.vaultProfile.deleteMany({ where: { id: { in: profiles.map((p) => p.id) } } }),
    prisma.vaultAccount.deleteMany({ where: { id: { in: profiles.map((p) => p.accountId) } } }),
  ]);

  await recordBulkChange(
    profiles.map((profile) => ({
      actorDiscordId: viewer.discordUserId,
      ownerDiscordId: viewer.discordUserId,
      entity: VaultEntity.VAULT_PROFILE,
      entityId: profile.id,
      action: VaultAction.DELETE,
      siteKey: profile.siteKey,
      label: profile.name,
    })),
    viewer.displayName,
    `removed ${profiles.length} profile${profiles.length === 1 ? "" : "s"}`,
  );

  revalidatePath("/dashboard/profiles");
  return { ok: true, removed: profiles.length };
}

// ---------------------------------------------------------------------------
// Retailer logins, on the sites where a login is all we hold
// ---------------------------------------------------------------------------

/** The stored row a login form is editing. Never carries the password ciphertext. */
type ExistingLogin = { id: string; email: string; active: boolean };

/**
 * The retailer and the row the form names, or a message saying why it can't apply.
 *
 * Shared by all three login actions so the "is this a login-only retailer" rule is
 * decided once. Every one of them is an individually-addressable POST, so each has to
 * check it -- and checking it three different ways is how they would drift.
 *
 * Returns the row itself rather than just its id, so the callers work from what is
 * actually stored: whether the email changed, and whether the toggle would be a no-op,
 * are both questions about the row they just loaded.
 */
async function loginTarget(
  form: FormData,
  discordUserId: string,
): Promise<
  { ok: true; siteKey: string; login: ExistingLogin | null } | { ok: false; error: string }
> {
  const siteKey = text(form, "siteKey");
  if (!isKnownSite(siteKey)) return { ok: false, error: "Unknown retailer." };
  // The mirror of the refusal in `saveProfile`: a retailer we hold full profiles for has
  // a card and an address that a login-only form would leave behind, so an account saved
  // through here would be half a profile with no way to finish it.
  if (siteUsesProfiles(siteKey)) {
    return { ok: false, error: `${siteStyle(siteKey).label} needs a full checkout profile.` };
  }

  const loginId = text(form, "loginId");
  if (!loginId) return { ok: true, siteKey, login: null };

  // Both predicates, as everywhere else: an id belonging to somebody else reads as
  // missing rather than as a refusal that would confirm it exists.
  const login = await prisma.vaultAccount.findFirst({
    where: { id: loginId, discordUserId, siteKey },
    select: { id: true, email: true, active: true },
  });
  if (!login) return { ok: false, error: "Login not found." };
  return { ok: true, siteKey, login };
}

/**
 * Add or update one retailer login.
 *
 * The whole record on a login-only retailer: an email and a password, and no card or
 * address because the order is placed by hand from the member's own account. See
 * `usesProfiles` in sites.ts.
 *
 * The password is WRITE-ONLY like every other secret -- blank on an edit means "leave it
 * alone", and can never mean "clear it", because nothing can read the stored value back
 * to confirm that was the intent.
 */
export async function saveLogin(form: FormData): Promise<ActionResult> {
  const viewer = await requireMember();

  const target = await loginTarget(form, viewer.discordUserId);
  if (!target.ok) return target;
  const { siteKey, login } = target;

  const email = text(form, "email").toLowerCase();
  if (!EMAIL_RE.test(email)) return { ok: false, error: "Enter a valid account email." };

  const password = text(form, "accountPassword");
  if (!login && !password) {
    return { ok: false, error: `Enter the password for that ${siteStyle(siteKey).label} account.` };
  }

  try {
    // Checked BEFORE the write, though `(site_key, email)` is unique in the database
    // anyway: reaching the constraint throws, and the generic "couldn't save that" it
    // surfaces as does not tell the member that the address is the problem.
    //
    // Their OWN row is not a collision -- an edit that leaves the email alone has to save.
    const taken = await prisma.vaultAccount.findUnique({
      where: { siteKey_email: { siteKey, email } },
      select: { id: true, discordUserId: true },
    });
    if (taken && taken.id !== login?.id) {
      return {
        ok: false,
        error:
          taken.discordUserId === viewer.discordUserId
            ? `You already have a ${siteStyle(siteKey).label} login for that email.`
            : "That account email is already in use.",
      };
    }

    if (!login) {
      const created = await prisma.vaultAccount.create({
        data: {
          siteKey,
          email,
          discordUserId: viewer.discordUserId,
          passwordEnc: encrypt(password, { entity: "vault_account", field: "password" }),
        },
        select: { id: true },
      });

      await recordChange(
        {
          actorDiscordId: viewer.discordUserId,
          ownerDiscordId: viewer.discordUserId,
          entity: VaultEntity.VAULT_ACCOUNT,
          entityId: created.id,
          action: VaultAction.CREATE,
          siteKey,
          label: email,
        },
        viewer.displayName,
      );
    } else {
      const changed = [
        ...(login.email !== email ? ["account email"] : []),
        ...(password ? ["account password"] : []),
      ];

      await prisma.vaultAccount.update({
        where: { id: login.id },
        data: {
          email,
          ...(password
            ? { passwordEnc: encrypt(password, { entity: "vault_account", field: "password" }) }
            : {}),
        },
      });

      // Nothing to record when the member reopened the form and saved it unchanged: an
      // audit row claiming an edit that didn't happen puts the login back in the
      // operator's queue and tells them to reload a password that never moved.
      if (changed.length) {
        await recordChange(
          {
            actorDiscordId: viewer.discordUserId,
            ownerDiscordId: viewer.discordUserId,
            entity: VaultEntity.VAULT_ACCOUNT,
            entityId: login.id,
            action: VaultAction.UPDATE,
            siteKey,
            label: email,
            fields: changed,
          },
          viewer.displayName,
        );
      }
    }
  } catch (error) {
    // Never the raw error: it can echo the submitted row back to the browser.
    console.error("vault: saveLogin failed", error instanceof Error ? error.message : "unknown");
    return { ok: false, error: "Couldn't save that. Check the email isn't already in use." };
  }

  revalidatePath("/dashboard/profiles");
  return { ok: true };
}

/** Park a login without deleting it, so the credentials survive a break from a retailer. */
export async function setLoginActive(form: FormData): Promise<ActionResult> {
  const viewer = await requireMember();

  const target = await loginTarget(form, viewer.discordUserId);
  if (!target.ok) return target;
  const login = target.login;
  if (!login) return { ok: false, error: "Login not found." };

  const active = bool(form, "active");
  // Already there: not an error, and not worth an audit row claiming a change either.
  if (login.active === active) return { ok: true };

  await prisma.vaultAccount.update({ where: { id: login.id }, data: { active } });

  await recordChange(
    {
      actorDiscordId: viewer.discordUserId,
      ownerDiscordId: viewer.discordUserId,
      entity: VaultEntity.VAULT_ACCOUNT,
      entityId: login.id,
      action: active ? VaultAction.ACTIVATE : VaultAction.DEACTIVATE,
      siteKey: target.siteKey,
      label: login.email,
    },
    viewer.displayName,
  );

  revalidatePath("/dashboard/profiles");
  return { ok: true };
}

/**
 * Remove one login for good.
 *
 * One at a time, unlike `deleteProfiles`: a member has a handful of logins on a
 * login-only retailer rather than the ninety profiles that made a bulk selection worth
 * building, and the row's own two-step confirm is the whole safeguard.
 */
export async function deleteLogin(form: FormData): Promise<ActionResult> {
  const viewer = await requireMember();

  const target = await loginTarget(form, viewer.discordUserId);
  if (!target.ok) return target;
  const login = target.login;
  if (!login) return { ok: false, error: "Login not found." };

  await prisma.vaultAccount.delete({ where: { id: login.id } });

  await recordChange(
    {
      actorDiscordId: viewer.discordUserId,
      ownerDiscordId: viewer.discordUserId,
      entity: VaultEntity.VAULT_ACCOUNT,
      entityId: login.id,
      action: VaultAction.DELETE,
      siteKey: target.siteKey,
      label: login.email,
    },
    viewer.displayName,
  );

  revalidatePath("/dashboard/profiles");
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Email app passwords
// ---------------------------------------------------------------------------

export async function saveEmailCredential(form: FormData): Promise<ActionResult> {
  const viewer = await requireMember();

  const email = text(form, "email").toLowerCase();
  const appPassword = text(form, "appPassword");
  if (!EMAIL_RE.test(email)) return { ok: false, error: "Enter a valid email address." };
  if (!appPassword) return { ok: false, error: "Enter the app password." };

  // WHO SERVES THE MAIL, not what the domain is called. A custom domain on Workspace or
  // Microsoft 365 takes an app password from its provider and reads over that provider's
  // IMAP host, so refusing it for not being @gmail.com turned away addresses that work
  // perfectly. The provider list stays closed -- an app password on an untested host is a
  // credential that silently never works, discovered mid-drop. See email-mx.ts.
  const { provider: imap, mailHost, lookupFailed } = await resolveMailProvider(email);
  if (lookupFailed) {
    // Distinguished from a rejection on purpose: DNS being briefly unreachable is not a
    // verdict about their address, and telling them it is sends them to change settings
    // that were never wrong.
    return {
      ok: false,
      error: `Couldn't check who handles mail for ${domainOf(email)} just now. Try again in a moment.`,
    };
  }
  if (!imap) return { ok: false, error: unsupportedMessage(email, mailHost) };

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
      imapHost: imap.imapHost,
      imapPort: imap.imapPort,
    },
    // A new password invalidates whatever the last verification said. The host is
    // re-derived too: it is a fact about who serves the domain today, and a domain that
    // has moved from Workspace to Microsoft 365 would otherwise keep reading over the
    // wrong IMAP host until somebody noticed by hand.
    update: {
      appPasswordEnc,
      imapHost: imap.imapHost,
      imapPort: imap.imapPort,
      verifiedAt: null,
      lastError: null,
      // Cleared with the rest: the cooldown guards a mailbox against repeated failed
      // logins, and a password that just changed is the one case where retrying
      // immediately is the RIGHT thing. Someone who just fixed a typo should not be told
      // to wait a minute before finding out whether it worked.
      lastCheckedAt: null,
    },
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

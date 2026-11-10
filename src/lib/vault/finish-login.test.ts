/**
 * Finishing a login into a profile, end to end.
 *
 * Costco took a login only until 2026-11-09, so every Costco signup before then is an
 * account with no profile behind it -- in no export, so never run. What only the action can
 * decide, pinned against the real database: the profile lands on THAT account, keeping its
 * password and its runner unless the member typed new ones; the security code the login
 * carried goes, because the card now has its own; someone else's login and one already
 * finished are refused; and a login with no password to reuse still asks for one. The member's
 * list of logins to finish shrinks as they are finished, and one can be dropped instead.
 *
 * Faked: who is signed in (the guard reads a session cookie that can't exist outside a
 * request), Next's cache revalidation, and the operator notification -- which would
 * otherwise post to the real vault webhook the local .env points at. The secrets are real
 * ciphertexts, so the keyring is needed as well as the database.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/db/client";
import { getMemberLogins } from "@/db/queries/vault";
import { deleteLogin, saveProfile } from "@/lib/vault/actions";
import { decrypt, encrypt } from "@/lib/vault/crypto";

const MEMBER = "999900000000000961";
const OTHER = "999900000000000962";
const RUNNER = "999900000000000963";
const SITE = "costco";
const DOMAIN = "finish-login-spec.example.com";

vi.mock("@/lib/auth/guard", () => ({
  requireMember: async () => ({
    discordUserId: "999900000000000961",
    username: "finishspec",
    displayName: "Finish Spec",
    avatarUrl: null,
    isOg: false,
    isAdmin: false,
    adminSites: [],
  }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

const recorded = vi.hoisted(() => ({ labels: [] as string[] }));
vi.mock("@/lib/vault/audit", () => ({
  recordChange: async (change: { label: string }) => {
    recorded.labels.push(change.label);
  },
  recordBulkChange: async () => {},
  changedFields: () => [],
}));

const canRun = Boolean(process.env.DATABASE_URL && process.env.VAULT_KEY_ACTIVE);

/** A Costco login of the kind saved before profiles: an email, a password, a CVV. */
async function oldLogin(
  owner: string,
  local: string,
  { password = "old-pass" as string | null, cvv = "321" as string | null } = {},
) {
  return prisma.vaultAccount.create({
    data: {
      siteKey: SITE,
      email: `${local}@${DOMAIN}`,
      discordUserId: owner,
      assigneeId: RUNNER,
      passwordEnc: password
        ? encrypt(password, { entity: "vault_account", field: "password" })
        : null,
      cardCvvEnc: cvv ? encrypt(cvv, { entity: "vault_account", field: "card_cvv" }) : null,
    },
    select: { id: true, email: true },
  });
}

/** The profile form as a member would submit it, minus whatever `over` changes. */
function form(over: Record<string, string>) {
  const data = new FormData();
  const fields: Record<string, string> = {
    siteKey: SITE,
    firstName: "Test",
    lastName: "Member",
    shipLine1: "1 Main St",
    shipCity: "Tulsa",
    shipState: "OK",
    shipPostalCode: "74103",
    sameBillingAndShipping: "on",
    cardNumber: "4242424242424242",
    cardCvv: "123",
    cardExpMonth: "12",
    cardExpYear: "2030",
    ...over,
  };
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

const account = (id: string) =>
  prisma.vaultAccount.findUniqueOrThrow({
    where: { id },
    select: {
      email: true,
      passwordEnc: true,
      cardCvvEnc: true,
      assigneeId: true,
      profile: { select: { name: true, cardLast4: true } },
    },
  });

const passwordOf = (enc: string | null) =>
  enc ? decrypt(enc, { entity: "vault_account", field: "password" }) : null;

const unfinishedEmails = async () =>
  (await getMemberLogins(MEMBER)).flatMap((group) =>
    group.siteKey === SITE ? group.logins.map((login) => login.email) : [],
  );

async function cleanup() {
  const owners = { in: [MEMBER, OTHER] };
  await prisma.vaultProfile.deleteMany({ where: { discordUserId: owners } });
  await prisma.vaultAccount.deleteMany({ where: { discordUserId: owners } });
  await prisma.discordMember.deleteMany({ where: { discordUserId: owners } });
}

describe.skipIf(!canRun)("finishing a login into a profile", () => {
  beforeEach(async () => {
    await cleanup();
    recorded.labels = [];
    await prisma.discordMember.createMany({
      data: [MEMBER, OTHER].map((discordUserId) => ({
        discordUserId,
        username: `finishspec-${discordUserId.slice(-3)}`,
        roles: [],
      })),
    });
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  it("puts the profile on that login, keeping its password and runner, dropping its CVV", async () => {
    const login = await oldLogin(MEMBER, "keep");
    expect(await unfinishedEmails()).toEqual([login.email]);

    const result = await saveProfile(form({ loginId: login.id, email: login.email }));
    expect(result).toEqual({ ok: true });

    const after = await account(login.id);
    expect(after.profile).toMatchObject({ cardLast4: "4242" });
    expect(passwordOf(after.passwordEnc)).toBe("old-pass");
    expect(after.assigneeId).toBe(RUNNER);
    // The card on the profile carries its own code now.
    expect(after.cardCvvEnc).toBeNull();
    // Finished, so no longer waiting -- and the runner's queue says what it was.
    expect(await unfinishedEmails()).toEqual([]);
    expect(recorded.labels).toEqual([`${after.profile!.name} (finished ${login.email})`]);
  });

  it("takes a new password and email typed while finishing", async () => {
    const login = await oldLogin(MEMBER, "change");

    const result = await saveProfile(
      form({ loginId: login.id, email: `changed@${DOMAIN}`, accountPassword: "new-pass" }),
    );
    expect(result).toEqual({ ok: true });

    const after = await account(login.id);
    expect(after.email).toBe(`changed@${DOMAIN}`);
    expect(passwordOf(after.passwordEnc)).toBe("new-pass");
  });

  /**
   * The same login reached without the button: "Add profile" with its email. This used to
   * attach the profile and silently keep the OLD password over the one just typed.
   */
  it("finishes the login its email names when the member adds a profile instead", async () => {
    const login = await oldLogin(MEMBER, "typed");

    const result = await saveProfile(form({ email: login.email, accountPassword: "typed-pass" }));
    expect(result).toEqual({ ok: true });

    const after = await account(login.id);
    expect(after.profile).not.toBeNull();
    expect(passwordOf(after.passwordEnc)).toBe("typed-pass");
    expect(await prisma.vaultAccount.count({ where: { discordUserId: MEMBER } })).toBe(1);
  });

  it("asks for a password when the login has none to reuse", async () => {
    const login = await oldLogin(MEMBER, "nopass", { password: null });

    const result = await saveProfile(form({ loginId: login.id, email: login.email }));
    expect(result).toEqual({ ok: false, error: "Enter the retailer account password." });
    // Nothing written: still a login, still waiting.
    expect((await account(login.id)).profile).toBeNull();
  });

  it("refuses someone else's login, and one already finished", async () => {
    const theirs = await oldLogin(OTHER, "theirs");
    expect(await saveProfile(form({ loginId: theirs.id, email: theirs.email }))).toEqual({
      ok: false,
      error: "Login not found.",
    });
    expect((await account(theirs.id)).profile).toBeNull();

    const mine = await oldLogin(MEMBER, "twice");
    expect((await saveProfile(form({ loginId: mine.id, email: mine.email }))).ok).toBe(true);
    const again = await saveProfile(form({ loginId: mine.id, email: mine.email }));
    expect(again.ok).toBe(false);
    expect(await prisma.vaultProfile.count({ where: { accountId: mine.id } })).toBe(1);
  });

  it("refuses finishing under an email another login already uses", async () => {
    const first = await oldLogin(MEMBER, "first");
    const second = await oldLogin(OTHER, "second");

    const result = await saveProfile(form({ loginId: first.id, email: second.email }));
    expect(result).toEqual({ ok: false, error: "That account email is already in use." });
    expect((await account(first.id)).email).toBe(first.email);
  });

  /**
   * Remove is the other way out of the list. Only for a login with no profile behind it --
   * one that has a profile goes with that profile, through deleteProfiles.
   */
  it("lets the member drop a login instead, but never one that has a profile", async () => {
    const drop = await oldLogin(MEMBER, "drop");
    const removal = new FormData();
    removal.set("siteKey", SITE);
    removal.set("loginId", drop.id);
    expect(await deleteLogin(removal)).toEqual({ ok: true });
    expect(await prisma.vaultAccount.count({ where: { id: drop.id } })).toBe(0);

    const kept = await oldLogin(MEMBER, "kept");
    expect((await saveProfile(form({ loginId: kept.id, email: kept.email }))).ok).toBe(true);
    removal.set("loginId", kept.id);
    expect(await deleteLogin(removal)).toEqual({ ok: false, error: "Login not found." });
    expect(await prisma.vaultAccount.count({ where: { id: kept.id } })).toBe(1);
  });
});

/**
 * The export route, for a runner.
 *
 * Two properties under test:
 *
 *   APP PASSWORDS  a runner whose bot reads emailed codes gets the app passwords of the
 *                  mailboxes behind THEIR OWN assigned profiles on that retailer, and nothing
 *                  else -- not another runner's members, not the same member's other
 *                  mailboxes, not every mailbox on file, not a retailer whose bot never reads
 *                  a code. Each refusal is a 404, the same answer the route gives a member.
 *   MEMBERSHIP     Mattel's profiles split into the accounts with Red Line Club and the ones
 *                  without, the two halves adding up to the whole, and neither reaching past
 *                  the runner's own share.
 *   HIDDEN         Costco's profiles as Hidden AIO's CSV: the runner's own share, decrypted,
 *                  filed under Hidden's Costco group, and recorded as the profile export it
 *                  is. Refused on any retailer Hidden doesn't run.
 *
 * The one thing faked is who is asking: requireAnyAdmin reads a session cookie that cannot
 * exist outside a request. Everything after that -- the scope, the profiles, the forwarding
 * map, the decryption, the audit row -- is the real code against the real database.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/admin/vault/export/route";
import { prisma } from "@/db/client";
import { ALL_SITES, type AdminSites } from "@/lib/auth/admin-scope";
import { encrypt } from "@/lib/vault/crypto";
import { HIDDEN_HEADER } from "@/lib/vault/hidden";

type FakeViewer = { discordUserId: string; adminSites: AdminSites; isAdmin: boolean };

const asking = vi.hoisted(() => ({ viewer: null as FakeViewer | null }));

// Hoisted above the imports, so the route above is built against this guard.
vi.mock("@/lib/auth/guard", () => ({
  requireAnyAdmin: async () => asking.viewer,
}));

// Needs a database AND the keyring: the fixtures hold real encrypted secrets, which the
// route decrypts.
const canRun = Boolean(process.env.DATABASE_URL && process.env.VAULT_KEY_ACTIVE);

const SITE = "topps";
const OPERATOR = "999900000000000230";
const RUNNER = "999900000000000231";
const OTHER_RUNNER = "999900000000000232";
const CR_RUNNER = "999900000000000233";
const MATTEL_RUNNER = "999900000000000234";
const COSTCO_RUNNER = "999900000000000235";
const MEMBER_A = "999900000000000211";
const MEMBER_B = "999900000000000212";

const PREFIX = "export-spec-";
const A_MAILBOX = `${PREFIX}a@example.com`;
// Forwards into A_MAILBOX: the runner needs that inbox once, not a second credential.
const A_ALIAS = `${PREFIX}a-alias@example.com`;
// Member A's, but behind no Topps profile -- it must never ride along.
const A_OTHER_MAILBOX = `${PREFIX}a-other@example.com`;
const B_MAILBOX = `${PREFIX}b@example.com`;

const operator: FakeViewer = { discordUserId: OPERATOR, adminSites: ALL_SITES, isAdmin: true };
const runner: FakeViewer = { discordUserId: RUNNER, adminSites: ["topps"], isAdmin: false };
const crRunner: FakeViewer = {
  discordUserId: CR_RUNNER,
  adminSites: ["crunchyroll"],
  isAdmin: false,
};
const mattelRunner: FakeViewer = {
  discordUserId: MATTEL_RUNNER,
  adminSites: ["mattel"],
  isAdmin: false,
};
const costcoRunner: FakeViewer = {
  discordUserId: COSTCO_RUNNER,
  adminSites: ["costco"],
  isAdmin: false,
};

async function exportAs(viewer: FakeViewer, query: string) {
  asking.viewer = viewer;
  const response = await GET(new Request(`http://localhost/api/admin/vault/export?${query}`));
  const disposition = response.headers.get("content-disposition") ?? "";
  return {
    status: response.status,
    body: await response.text(),
    filename: disposition.match(/filename="([^"]+)"/)?.[1] ?? null,
    contentType: response.headers.get("content-type"),
  };
}

/**
 * This test's mailbox addresses in an IMAP CSV, header dropped. Only its own: a full admin's
 * file also holds whatever real Topps profiles the local database has.
 */
function mailboxesIn(csv: string): string[] {
  return csv
    .trim()
    .split("\n")
    .slice(1)
    .map((line) => line.split(",")[2])
    .filter((address) => address.startsWith(PREFIX))
    .sort();
}

/** This test's profile names in an AYCD file, for the same reason. */
function profilesIn(json: string): string[] {
  return (JSON.parse(json) as { name: string }[])
    .map((profile) => profile.name)
    .filter((name) => name.startsWith(PREFIX))
    .sort();
}

async function profile(
  owner: string,
  assignee: string,
  name: string,
  email: string,
  {
    site = SITE,
    hasMembership = false,
    password,
  }: { site?: string; hasMembership?: boolean; password?: string } = {},
) {
  const account = await prisma.vaultAccount.create({
    data: {
      siteKey: site,
      email,
      discordUserId: owner,
      assigneeId: assignee,
      hasMembership,
      passwordEnc: password
        ? encrypt(password, { entity: "vault_account", field: "password" })
        : undefined,
    },
  });
  await prisma.vaultProfile.create({
    data: {
      siteKey: site,
      discordUserId: owner,
      name: `${PREFIX}${name}`,
      profileKey: `${PREFIX}${name}`,
      accountId: account.id,
      firstName: "Test",
      lastName: "Member",
      shipLine1: "1 Main St",
      shipCity: "Tulsa",
      shipState: "OK",
      shipPostalCode: "74103",
      cardBrand: "visa",
      cardLast4: "4242",
      cardExpMonth: "12",
      cardExpYear: "2030",
      cardNumberEnc: encrypt("4242424242424242", { entity: "vault_profile", field: "card_number" }),
      cardCvvEnc: encrypt("123", { entity: "vault_profile", field: "card_cvv" }),
    },
  });
}

async function credential(owner: string, email: string, password: string) {
  return prisma.emailCredential.create({
    data: {
      email,
      discordUserId: owner,
      appPasswordEnc: encrypt(password, { entity: "email_credential", field: "app_password" }),
      imapHost: "imap.gmail.com",
      imapPort: 993,
    },
  });
}

describe.skipIf(!canRun)("exports for a runner", () => {
  beforeAll(async () => {
    await cleanup();
    await prisma.discordMember.createMany({
      data: [MEMBER_A, MEMBER_B].map((discordUserId) => ({
        discordUserId,
        username: `export-spec-${discordUserId.slice(-3)}`,
        roles: [],
      })),
    });

    // Member A: two Topps profiles with the runner, one reading its own inbox and one
    // forwarding into it -- plus a second inbox nothing on Topps uses.
    const aBox = await credential(MEMBER_A, A_MAILBOX, "aaaa aaaa aaaa aaaa");
    await prisma.emailAlias.create({
      data: { email: A_ALIAS, discordUserId: MEMBER_A, credentialId: aBox.id },
    });
    await credential(MEMBER_A, A_OTHER_MAILBOX, "cccc cccc cccc cccc");
    // Each login's password holds a character another accounts shape splits on.
    await profile(MEMBER_A, RUNNER, "a1", A_MAILBOX, { password: "hunter:2" });
    await profile(MEMBER_A, RUNNER, "a2", A_ALIAS, { password: "semi;colon" });

    // Member B: another runner's.
    await credential(MEMBER_B, B_MAILBOX, "bbbb bbbb bbbb bbbb");
    await profile(MEMBER_B, OTHER_RUNNER, "b1", B_MAILBOX);

    // Mattel: one account with Red Line Club and one without on the Mattel runner, and one
    // more with it that sits with somebody else.
    const mattel = { site: "mattel" };
    await profile(MEMBER_A, MATTEL_RUNNER, "m-rlc", `${PREFIX}m-a@example.com`, {
      ...mattel,
      hasMembership: true,
    });
    await profile(MEMBER_B, MATTEL_RUNNER, "m-plain", `${PREFIX}m-b@example.com`, mattel);
    await profile(MEMBER_B, OTHER_RUNNER, "m-other", `${PREFIX}m-c@example.com`, {
      ...mattel,
      hasMembership: true,
    });

    // Costco: one profile with the Costco runner, and one with somebody else.
    await profile(MEMBER_A, COSTCO_RUNNER, "c-a", `${PREFIX}c-a@example.com`, { site: "costco" });
    await profile(MEMBER_B, OTHER_RUNNER, "c-b", `${PREFIX}c-b@example.com`, { site: "costco" });
  });

  afterAll(cleanup);

  describe("app passwords", () => {
    it("hands a runner the mailboxes behind their own profiles, once each, on the record", async () => {
      await prisma.vaultExport.deleteMany({ where: { actorDiscordId: RUNNER } });

      const { status, body } = await exportAs(runner, `site=${SITE}&format=imap`);
      expect(status).toBe(200);
      // The alias resolves to the inbox it forwards into, so one line, not two.
      expect(mailboxesIn(body)).toEqual([A_MAILBOX]);
      // Decrypted, and quoted for the spaces Gmail puts in them.
      expect(body).toContain(`imap.gmail.com,993,${A_MAILBOX},"aaaa aaaa aaaa aaaa"`);
      expect(body).not.toContain("bbbb");
      expect(body).not.toContain("cccc");

      // Whose credentials left, and how many -- the same row a full admin's export writes.
      const rows = await prisma.vaultExport.findMany({ where: { actorDiscordId: RUNNER } });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        siteKey: SITE,
        format: "imap",
        scope: "site",
        accountCount: 1,
      });
    });

    it("gives nothing of another runner's member, even asked for by id", async () => {
      const { status, body } = await exportAs(
        runner,
        `site=${SITE}&format=imap&member=${MEMBER_B}`,
      );
      expect(status).toBe(200);
      expect(mailboxesIn(body)).toEqual([]);
    });

    it("never hands a runner every mailbox on file", async () => {
      expect((await exportAs(runner, "format=imap")).status).toBe(404);
      expect((await exportAs(runner, `format=imap&member=${MEMBER_A}`)).status).toBe(404);
    });

    it("refuses another runner's share and another retailer", async () => {
      expect(
        (await exportAs(runner, `site=${SITE}&format=imap&runner=${OTHER_RUNNER}`)).status,
      ).toBe(404);
      expect((await exportAs(runner, `site=${SITE}&format=imap&runner=all`)).status).toBe(404);
      expect((await exportAs(runner, "site=target&format=imap")).status).toBe(404);
    });

    it("refuses app passwords where no bot reads a code", async () => {
      expect((await exportAs(crRunner, "site=crunchyroll&format=imap")).status).toBe(404);
      expect((await exportAs(mattelRunner, "site=mattel&format=imap")).status).toBe(404);
    });

    it("still gives a full admin every runner's mailboxes on the retailer", async () => {
      const { status, body } = await exportAs(operator, `site=${SITE}&format=imap`);
      expect(status).toBe(200);
      expect(mailboxesIn(body)).toEqual([A_MAILBOX, B_MAILBOX]);
    });
  });

  describe("Red Line Club split", () => {
    it("exports the accounts with it, named as that half", async () => {
      const { status, body, filename } = await exportAs(
        mattelRunner,
        "site=mattel&bot=all&membership=with",
      );
      expect(status).toBe(200);
      expect(profilesIn(body)).toEqual([`${PREFIX}m-rlc`]);
      expect(filename).toMatch(/^okie-profiles-mattel-rlc-\d{4}-\d{2}-\d{2}\.json$/);
    });

    it("exports the accounts without it as the other half", async () => {
      const { status, body, filename } = await exportAs(
        mattelRunner,
        "site=mattel&bot=all&membership=without",
      );
      expect(status).toBe(200);
      expect(profilesIn(body)).toEqual([`${PREFIX}m-plain`]);
      expect(filename).toMatch(/^okie-profiles-mattel-no-rlc-/);
    });

    it("adds up to the whole file, which is still there unsplit", async () => {
      const { body } = await exportAs(mattelRunner, "site=mattel&bot=all");
      expect(profilesIn(body)).toEqual([`${PREFIX}m-plain`, `${PREFIX}m-rlc`]);
    });

    it("never reaches past the runner's own share", async () => {
      // m-other has Red Line Club too, but sits with another runner.
      const mine = await exportAs(mattelRunner, "site=mattel&bot=all&membership=with");
      expect(profilesIn(mine.body)).not.toContain(`${PREFIX}m-other`);

      const everyone = await exportAs(operator, "site=mattel&bot=all&membership=with&runner=all");
      expect(profilesIn(everyone.body)).toEqual([`${PREFIX}m-other`, `${PREFIX}m-rlc`]);
    });

    it("refuses a split on a retailer with none, or one that isn't a half", async () => {
      expect((await exportAs(operator, `site=${SITE}&bot=all&membership=with`)).status).toBe(400);
      expect((await exportAs(mattelRunner, "site=mattel&bot=all&membership=maybe")).status).toBe(
        400,
      );
    });

    it("offers no user:pass file where only emails are kept", async () => {
      const { status, body } = await exportAs(mattelRunner, "site=mattel&format=accounts");
      expect(status).toBe(400);
      expect(body).toMatch(/don't keep Mattel passwords/);
    });
  });

  /**
   * The accounts list in each separator the team's bots read. The runner's two Topps logins,
   * in profile-name order, decrypted -- and nothing but the separator changes between them.
   */
  describe("accounts separator", () => {
    /** This test's lines in an accounts file, in file order. */
    const linesIn = (body: string) => body.split("\n").filter((line) => line.startsWith(PREFIX));

    it("writes email:password when none is asked for, under the name it always had", async () => {
      const { status, body, filename } = await exportAs(runner, `site=${SITE}&format=accounts`);
      expect(status).toBe(200);
      expect(linesIn(body)).toEqual([`${A_MAILBOX}:hunter:2`, `${A_ALIAS}:semi;colon`]);
      expect(filename).toMatch(/^okie-accounts-topps-\d{4}-\d{2}-\d{2}\.txt$/);

      // Asked for by name, the default is the same file.
      const named = await exportAs(runner, `site=${SITE}&format=accounts&sep=colon`);
      expect(named.body).toBe(body);
      expect(named.filename).toBe(filename);
    });

    it("writes email:::password, and says so in the file's name", async () => {
      const { status, body, filename } = await exportAs(
        runner,
        `site=${SITE}&format=accounts&sep=triple-colon`,
      );
      expect(status).toBe(200);
      expect(linesIn(body)).toEqual([`${A_MAILBOX}:::hunter:2`, `${A_ALIAS}:::semi;colon`]);
      expect(filename).toMatch(/^okie-accounts-triple-colon-topps-\d{4}-\d{2}-\d{2}\.txt$/);
    });

    it("writes email;password, and says so in the file's name", async () => {
      const { status, body, filename } = await exportAs(
        runner,
        `site=${SITE}&format=accounts&sep=semicolon`,
      );
      expect(status).toBe(200);
      expect(linesIn(body)).toEqual([`${A_MAILBOX};hunter:2`, `${A_ALIAS};semi;colon`]);
      expect(filename).toMatch(/^okie-accounts-semicolon-topps-\d{4}-\d{2}-\d{2}\.txt$/);
    });

    it("is recorded as the accounts export it is", async () => {
      await prisma.vaultExport.deleteMany({ where: { actorDiscordId: RUNNER } });
      await exportAs(runner, `site=${SITE}&format=accounts&sep=semicolon`);

      const rows = await prisma.vaultExport.findMany({ where: { actorDiscordId: RUNNER } });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        siteKey: SITE,
        format: "accounts",
        scope: "site",
        accountCount: 2,
      });
    });

    it("refuses a separator it doesn't know, or one on a file that has none", async () => {
      expect((await exportAs(runner, `site=${SITE}&format=accounts&sep=pipe`)).status).toBe(400);
      expect((await exportAs(runner, `site=${SITE}&format=accounts&sep=;`)).status).toBe(400);
      // The AYCD file is JSON and the IMAP one a CSV: neither has a separator to change.
      expect((await exportAs(runner, `site=${SITE}&bot=all&sep=semicolon`)).status).toBe(400);
      expect((await exportAs(runner, `site=${SITE}&format=imap&sep=semicolon`)).status).toBe(400);
    });
  });

  /** Costco's profiles in the file Hidden AIO loads. See hidden.ts for the format itself. */
  describe("Hidden CSV", () => {
    /** This test's rows in a Hidden CSV, each as column name -> value. */
    const rowsIn = (csv: string) =>
      csv
        .split("\n")
        .slice(1)
        .filter((line) => line.startsWith(PREFIX))
        .map((line) => {
          const cells = line.split(",");
          return Object.fromEntries(HIDDEN_HEADER.map((column, i) => [column, cells[i]]));
        });

    it("hands the Costco runner their own profiles, decrypted, under Hidden's Costco group", async () => {
      const { status, body, filename, contentType } = await exportAs(
        costcoRunner,
        "site=costco&bot=all&format=hidden",
      );
      expect(status).toBe(200);
      expect(contentType).toBe("text/csv; charset=utf-8");
      expect(filename).toMatch(/^okie-profiles-hidden-costco-\d{4}-\d{2}-\d{2}\.csv$/);
      expect(body.split("\n")[0]).toBe(HIDDEN_HEADER.join(","));

      // c-b sits with another runner, so only c-a is here.
      const rows = rowsIn(body);
      expect(rows.map((row) => row.profileName)).toEqual([`${PREFIX}c-a`]);
      expect(rows[0]).toMatchObject({
        shippingFirstName: "Test",
        shippingLastName: "Member",
        shippingEmail: `${PREFIX}c-a@example.com`,
        shippingCountry: "US",
        shippingState: "OK",
        cardType: "visa",
        cardNumber: "4242424242424242",
        cardCvv: "123",
        cardExpMonth: "12",
        cardExpYear: "2030",
        "profileId (do not edit)": "",
        groupName: "Costco",
        "groupId (do not edit)": "53815241-3f20-4e10-b987-33c26c671f80",
      });
      // No phone on file, and Costco's bot makes none up, so the file carries a generated one.
      expect(rows[0].shippingPhone).toMatch(/^\d{10}$/);
    });

    it("is recorded as the profile export it is, under its own format", async () => {
      await prisma.vaultExport.deleteMany({ where: { actorDiscordId: COSTCO_RUNNER } });
      await exportAs(costcoRunner, "site=costco&bot=all&format=hidden");

      const rows = await prisma.vaultExport.findMany({ where: { actorDiscordId: COSTCO_RUNNER } });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        siteKey: "costco",
        format: "hidden",
        scope: "site",
        profileCount: 1,
        accountCount: 0,
      });
    });

    it("gives a full admin every runner's, and one member's on its own", async () => {
      const everyone = await exportAs(operator, "site=costco&bot=all&format=hidden&runner=all");
      expect(rowsIn(everyone.body).map((row) => row.profileName)).toEqual([
        `${PREFIX}c-a`,
        `${PREFIX}c-b`,
      ]);

      const one = await exportAs(
        operator,
        `site=costco&bot=all&format=hidden&runner=all&member=${MEMBER_B}`,
      );
      expect(rowsIn(one.body).map((row) => row.profileName)).toEqual([`${PREFIX}c-b`]);
      expect(one.filename).toMatch(/^okie-profiles-hidden-costco-every-runner-member-/);
    });

    it("still writes AYCD's file on Costco when no format is asked for", async () => {
      const { status, body, filename } = await exportAs(costcoRunner, "site=costco&bot=all");
      expect(status).toBe(200);
      expect(profilesIn(body)).toEqual([`${PREFIX}c-a`]);
      expect(filename).toMatch(/^okie-profiles-costco-\d{4}-\d{2}-\d{2}\.json$/);
    });

    it("refuses Hidden on a retailer Hidden doesn't run", async () => {
      const topps = await exportAs(runner, `site=${SITE}&bot=all&format=hidden`);
      expect(topps.status).toBe(400);
      expect(topps.body).toBe("Topps profiles don't export as Hidden.");
      expect((await exportAs(operator, "site=target&bot=all&format=hidden")).status).toBe(400);
      // A separator means nothing to a profile file, Hidden's included.
      expect(
        (await exportAs(costcoRunner, "site=costco&bot=all&format=hidden&sep=semicolon")).status,
      ).toBe(400);
    });
  });
});

async function cleanup() {
  const members = [MEMBER_A, MEMBER_B];
  await prisma.vaultExport.deleteMany({
    where: {
      actorDiscordId: {
        in: [OPERATOR, RUNNER, OTHER_RUNNER, CR_RUNNER, MATTEL_RUNNER, COSTCO_RUNNER],
      },
    },
  });
  await prisma.vaultProfile.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await prisma.vaultAccount.deleteMany({ where: { email: { startsWith: PREFIX } } });
  await prisma.emailAlias.deleteMany({ where: { email: { startsWith: PREFIX } } });
  await prisma.emailCredential.deleteMany({ where: { email: { startsWith: PREFIX } } });
  await prisma.discordMember.deleteMany({ where: { discordUserId: { in: members } } });
}

/**
 * App passwords through the export route, for a runner.
 *
 * The property under test: a runner whose bot reads emailed codes gets the app passwords of
 * the mailboxes behind THEIR OWN assigned profiles on that retailer, and nothing else -- not
 * another runner's members, not the same member's other mailboxes, not every mailbox on
 * file, not a retailer whose bot never reads a code. Each refusal is a 404, the same answer
 * the route gives a member.
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

type FakeViewer = { discordUserId: string; adminSites: AdminSites; isAdmin: boolean };

const asking = vi.hoisted(() => ({ viewer: null as FakeViewer | null }));

// Hoisted above the imports, so the route above is built against this guard.
vi.mock("@/lib/auth/guard", () => ({
  requireAnyAdmin: async () => asking.viewer,
}));

// Needs a database AND the keyring: the credentials hold real encrypted passwords.
const canRun = Boolean(process.env.DATABASE_URL && process.env.VAULT_KEY_ACTIVE);

const SITE = "topps";
const OPERATOR = "999900000000000230";
const RUNNER = "999900000000000231";
const OTHER_RUNNER = "999900000000000232";
const CR_RUNNER = "999900000000000233";
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

async function exportAs(viewer: FakeViewer, query: string) {
  asking.viewer = viewer;
  const response = await GET(new Request(`http://localhost/api/admin/vault/export?${query}`));
  return { status: response.status, body: await response.text() };
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

async function profile(owner: string, assignee: string, name: string, email: string) {
  const account = await prisma.vaultAccount.create({
    data: { siteKey: SITE, email, discordUserId: owner, assigneeId: assignee },
  });
  await prisma.vaultProfile.create({
    data: {
      siteKey: SITE,
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
      cardNumberEnc: "not-a-real-ciphertext",
      cardCvvEnc: "not-a-real-ciphertext",
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

describe.skipIf(!canRun)("app-password export for a runner", () => {
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
    await profile(MEMBER_A, RUNNER, "a1", A_MAILBOX);
    await profile(MEMBER_A, RUNNER, "a2", A_ALIAS);

    // Member B: another runner's.
    await credential(MEMBER_B, B_MAILBOX, "bbbb bbbb bbbb bbbb");
    await profile(MEMBER_B, OTHER_RUNNER, "b1", B_MAILBOX);
  });

  afterAll(cleanup);

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
    const { status, body } = await exportAs(runner, `site=${SITE}&format=imap&member=${MEMBER_B}`);
    expect(status).toBe(200);
    expect(mailboxesIn(body)).toEqual([]);
  });

  it("never hands a runner every mailbox on file", async () => {
    expect((await exportAs(runner, "format=imap")).status).toBe(404);
    expect((await exportAs(runner, `format=imap&member=${MEMBER_A}`)).status).toBe(404);
  });

  it("refuses another runner's share and another retailer", async () => {
    expect((await exportAs(runner, `site=${SITE}&format=imap&runner=${OTHER_RUNNER}`)).status).toBe(
      404,
    );
    expect((await exportAs(runner, `site=${SITE}&format=imap&runner=all`)).status).toBe(404);
    expect((await exportAs(runner, "site=target&format=imap")).status).toBe(404);
  });

  it("refuses app passwords where no bot reads a code", async () => {
    expect((await exportAs(crRunner, "site=crunchyroll&format=imap")).status).toBe(404);
  });

  it("still gives a full admin every runner's mailboxes on the retailer", async () => {
    const { status, body } = await exportAs(operator, `site=${SITE}&format=imap`);
    expect(status).toBe(200);
    expect(mailboxesIn(body)).toEqual([A_MAILBOX, B_MAILBOX]);
  });
});

async function cleanup() {
  const members = [MEMBER_A, MEMBER_B];
  await prisma.vaultExport.deleteMany({
    where: { actorDiscordId: { in: [OPERATOR, RUNNER, OTHER_RUNNER, CR_RUNNER] } },
  });
  await prisma.vaultProfile.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await prisma.vaultAccount.deleteMany({ where: { email: { startsWith: PREFIX } } });
  await prisma.emailAlias.deleteMany({ where: { email: { startsWith: PREFIX } } });
  await prisma.emailCredential.deleteMany({ where: { email: { startsWith: PREFIX } } });
  await prisma.discordMember.deleteMany({ where: { discordUserId: { in: members } } });
}

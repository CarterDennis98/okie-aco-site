/**
 * Forwarding many addresses into one inbox at once, end to end.
 *
 * Pinned against the real database: every ticked address on the member's logins ends up
 * forwarding into the inbox, 250 of them in one go, with one notification; what can't be
 * forwarded is skipped and named rather than failing the rest; an address already forwarding
 * into another of the member's inboxes moves; and the page's "nowhere to read a code from"
 * list loses exactly the addresses forwarded.
 *
 * Faked: who is signed in (the guard reads a session cookie that can't exist outside a
 * request), Next's cache revalidation, and the operator notification -- which would otherwise
 * post to the real vault webhook the local .env points at. No password is ever read, so the
 * ciphertext columns hold placeholders.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/db/client";
import { getEmailsNeedingAppPassword } from "@/db/queries/vault";
import { forwardEmailAddresses } from "@/lib/vault/actions";

const ALICE = "999900000000001201";
const BOB = "999900000000001202";
const SITE = "target";
/** No real address is on it, so nothing here meets a real member's forwarding. */
const DOMAIN = "forward-spec.example.com";

vi.mock("@/lib/auth/guard", () => ({
  requireMember: async () => ({
    discordUserId: "999900000000001201",
    username: "forwardspec",
    displayName: "Forward Spec",
    avatarUrl: null,
    isOg: false,
    isAdmin: false,
    adminSites: [],
  }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

type Noted = { entityId: string; action: string; label: string; assigneeId: string | null };
type Options = { listed?: { label: string }[]; at?: Date };
const notified = vi.hoisted(() => ({
  calls: [] as ({ changes: Noted[]; summary: string } & Options)[],
}));
vi.mock("@/lib/vault/audit", () => ({
  recordBulkChange: async (
    changes: Noted[],
    _actor: string,
    summary: string,
    options: Options = {},
  ) => {
    notified.calls.push({ changes, summary, ...options });
  },
  recordChange: async () => {},
  changedFields: () => [],
}));

const canRun = Boolean(process.env.DATABASE_URL);

const at = (local: string) => `${local}@${DOMAIN}`;

function forward(credentialId: string, emails: string[]) {
  const form = new FormData();
  form.set("credentialId", credentialId);
  for (const email of emails) form.append("email", email);
  return forwardEmailAddresses(form);
}

async function inbox(owner: string, local: string) {
  const row = await prisma.emailCredential.create({
    data: { discordUserId: owner, email: at(local), appPasswordEnc: "not-a-real-ciphertext" },
    select: { id: true },
  });
  return row.id;
}

async function logins(owner: string, locals: string[]) {
  await prisma.vaultAccount.createMany({
    data: locals.map((local) => ({
      siteKey: SITE,
      email: at(local),
      discordUserId: owner,
      assigneeId: owner,
    })),
  });
}

const aliceForwards = () =>
  prisma.emailAlias.findMany({
    where: { discordUserId: ALICE },
    orderBy: { email: "asc" },
    select: { id: true, email: true, credentialId: true },
  });

async function cleanup() {
  await prisma.emailAlias.deleteMany({ where: { email: { endsWith: `@${DOMAIN}` } } });
  await prisma.emailCredential.deleteMany({ where: { email: { endsWith: `@${DOMAIN}` } } });
  await prisma.vaultAccount.deleteMany({ where: { discordUserId: { in: [ALICE, BOB] } } });
  await prisma.discordMember.deleteMany({ where: { discordUserId: { in: [ALICE, BOB] } } });
}

describe.skipIf(!canRun)("forwarding many addresses at once", () => {
  let main = "";
  let spare = "";
  let bobs = "";

  beforeEach(async () => {
    await cleanup();
    notified.calls = [];
    await prisma.discordMember.createMany({
      data: [ALICE, BOB].map((discordUserId) => ({
        discordUserId,
        username: `forwardspec-${discordUserId.slice(-1)}`,
        roles: [],
      })),
    });
    main = await inbox(ALICE, "main");
    spare = await inbox(ALICE, "spare");
    bobs = await inbox(BOB, "bob");
    // "spare" is both one of her logins and an inbox of her own: it has its own password.
    await logins(ALICE, ["d1", "d2", "d3", "taken", "spare"]);
    await logins(BOB, ["b1"]);
    // Bob already forwards an address that's also on Alice's list.
    await prisma.emailAlias.create({
      data: { discordUserId: BOB, email: at("taken"), credentialId: bobs },
    });
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  it("forwards every ticked address into the inbox, with one notification", async () => {
    expect(await forward(main, [at("d1"), at("d2").toUpperCase(), at("d3")])).toEqual({
      ok: true,
      forwarded: 3,
      to: at("main"),
      skipped: [],
    });
    expect((await aliceForwards()).map((row) => [row.email, row.credentialId])).toEqual([
      [at("d1"), main],
      [at("d2"), main],
      [at("d3"), main],
    ]);

    expect(notified.calls).toHaveLength(1);
    const [call] = notified.calls;
    expect(call.summary).toBe(`forwarded 3 addresses to \`${at("main")}\``);
    expect(call.changes.map((c) => [c.action, c.label, c.assigneeId]).sort()).toEqual([
      ["CREATE", `${at("d1")} -> ${at("main")}`, null],
      ["CREATE", `${at("d2")} -> ${at("main")}`, null],
      ["CREATE", `${at("d3")} -> ${at("main")}`, null],
    ]);
    expect(call.listed?.map((c) => c.label).sort()).toEqual([at("d1"), at("d2"), at("d3")]);
    expect(call.at).toBeInstanceOf(Date);

    // The page stops asking for a password for any of them; Bob forwarding "taken" covers
    // Bob, not Alice.
    expect(await getEmailsNeedingAppPassword(ALICE)).toEqual([at("taken")]);
  });

  it("skips what it can't forward and says why, and forwards the rest", async () => {
    const result = await forward(main, [
      at("taken"),
      at("spare"),
      at("b1"),
      "someone@elsewhere.example.com",
      at("d1"),
    ]);
    expect(result).toEqual({
      ok: true,
      forwarded: 1,
      to: at("main"),
      skipped: [
        { email: at("taken"), why: "is already claimed" },
        { email: at("spare"), why: "has its own app password" },
        { email: at("b1"), why: "isn't on any of your logins" },
        { email: "someone@elsewhere.example.com", why: "isn't on any of your logins" },
      ],
    });
    // Bob's forwarding is still Bob's.
    expect(
      await prisma.emailAlias.findUnique({
        where: { email: at("taken") },
        select: { discordUserId: true, credentialId: true },
      }),
    ).toEqual({ discordUserId: BOB, credentialId: bobs });
    expect((await aliceForwards()).map((row) => row.email)).toEqual([at("d1")]);
  });

  it("moves addresses forwarding into another of her inboxes, and does nothing twice", async () => {
    await forward(main, [at("d1"), at("d2")]);
    const before = await aliceForwards();
    notified.calls = [];

    expect(await forward(spare, [at("d1"), at("d2")])).toEqual({
      ok: true,
      forwarded: 2,
      to: at("spare"),
      skipped: [],
    });
    const after = await aliceForwards();
    // The same two rows, now pointing at the other inbox.
    expect(after.map((row) => row.id)).toEqual(before.map((row) => row.id));
    expect(after.every((row) => row.credentialId === spare)).toBe(true);
    expect(notified.calls[0].changes.map((c) => c.action)).toEqual(["UPDATE", "UPDATE"]);

    notified.calls = [];
    expect(await forward(spare, [at("d1")])).toEqual({
      ok: true,
      forwarded: 0,
      to: at("spare"),
      skipped: [{ email: at("d1"), why: "already forwards there" }],
    });
    expect(notified.calls).toEqual([]);
  });

  it("takes 250 addresses in one go", async () => {
    const many = Array.from({ length: 250 }, (_, i) => `bulk${i}`);
    await logins(ALICE, many);

    const result = await forward(main, many.map(at));
    expect(result).toMatchObject({ ok: true, forwarded: 250, skipped: [] });
    expect(
      await prisma.emailAlias.count({ where: { discordUserId: ALICE, credentialId: main } }),
    ).toBe(250);
    expect(notified.calls).toHaveLength(1);
    expect(notified.calls[0].changes).toHaveLength(250);
    expect(await getEmailsNeedingAppPassword(ALICE)).toEqual(
      [at("d1"), at("d2"), at("d3"), at("taken")].sort(),
    );
  });

  it("refuses somebody else's inbox, nothing ticked, no inbox, and too many at once", async () => {
    expect(await forward(bobs, [at("d1")])).toEqual({ ok: false, error: "Not found." });
    expect(await forward(main, [])).toEqual({ ok: false, error: "Tick the addresses to forward." });
    expect(await forward("", [at("d1")])).toEqual({
      ok: false,
      error: "Pick the inbox they forward to.",
    });
    const tooMany = Array.from({ length: 1001 }, (_, i) => at(`x${i}`));
    expect(await forward(main, tooMany)).toEqual({
      ok: false,
      error: "That's 1001 addresses. Forward up to 1000 at a time.",
    });
    expect(await aliceForwards()).toEqual([]);
    expect(notified.calls).toEqual([]);
  });
});

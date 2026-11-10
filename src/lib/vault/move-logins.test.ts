/**
 * Moving logins that are still waiting to be finished, several at once.
 *
 * On the day Costco took full profiles every Costco row was a login with no profile, held by
 * the operator, while new Costco members started going to chess (DEFAULT_RUNNERS). Those rows
 * are on no roster, so the admin page moves them by account id -- the "Move all" control on
 * its waiting list. What is pinned against the real database: every one of them moves in one
 * call, each move is queued for both runners as a login (there is no profile to name), a move
 * to where they already are is nothing, and a runner without the Costco role is refused.
 *
 * Faked: who is signed in, Next's cache revalidation, and the notification -- which would
 * otherwise post to the real vault webhook the local .env points at.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/db/client";
import { RUNNER_ROLES } from "@/lib/auth/admin-scope";
import { assignProfiles } from "@/lib/vault/assign-actions";

const ADMIN = "999900000000000981";
const MEMBER = "999900000000000982";
const RUNNER = "999900000000000983";
const HOLDER = "999900000000000984";
const SITE = "costco";
const DOMAIN = "move-logins-spec.example.com";

vi.mock("@/lib/auth/guard", () => ({
  requireAdmin: async () => ({
    discordUserId: "999900000000000981",
    username: "movespec",
    displayName: "Move Spec",
    avatarUrl: null,
    isOg: false,
    isAdmin: true,
    adminSites: "all",
  }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

type Queued = { entity: string; action: string; label: string; assigneeId: string | null };
const queued = vi.hoisted(() => ({ changes: [] as Queued[] }));
vi.mock("@/lib/vault/audit", () => ({
  recordBulkChange: async (changes: Queued[]) => {
    queued.changes.push(...changes);
  },
  recordChange: async () => {},
}));

const canRun = Boolean(process.env.DATABASE_URL);

function move(to: string, accountIds: string[]) {
  const form = new FormData();
  form.set("siteKey", SITE);
  form.set("assigneeId", to);
  for (const id of accountIds) form.append("accountId", id);
  return assignProfiles(form);
}

async function cleanup() {
  const ids = [ADMIN, MEMBER, RUNNER, HOLDER];
  await prisma.adminAudit.deleteMany({ where: { actorDiscordId: ADMIN } });
  await prisma.vaultAccount.deleteMany({ where: { discordUserId: { in: ids } } });
  await prisma.discordMember.deleteMany({ where: { discordUserId: { in: ids } } });
}

describe.skipIf(!canRun)("moving waiting logins all at once", () => {
  let waiting: string[];

  beforeEach(async () => {
    await cleanup();
    queued.changes = [];
    await prisma.discordMember.createMany({
      data: [
        { discordUserId: MEMBER, username: "movespec-member", roles: [] },
        // Holds the Costco runner role, as chess does.
        { discordUserId: RUNNER, username: "movespec-runner", roles: [RUNNER_ROLES.costco] },
        { discordUserId: HOLDER, username: "movespec-holder", roles: [] },
      ],
    });
    waiting = [];
    for (const local of ["one", "two"]) {
      const login = await prisma.vaultAccount.create({
        data: {
          siteKey: SITE,
          email: `${local}@${DOMAIN}`,
          discordUserId: MEMBER,
          assigneeId: HOLDER,
        },
        select: { id: true },
      });
      waiting.push(login.id);
    }
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  it("moves every one in a single call, queued for both runners as logins", async () => {
    expect(await move(RUNNER, waiting)).toEqual({ ok: true, moved: 2 });

    const held = await prisma.vaultAccount.findMany({
      where: { id: { in: waiting } },
      select: { assigneeId: true },
    });
    expect(held.map((row) => row.assigneeId)).toEqual([RUNNER, RUNNER]);

    // A pair per login: off the old runner's bot, onto the new one's. Named by email, since
    // there is no profile behind either.
    expect(
      queued.changes
        .map((c) => [c.entity, c.action, c.label, c.assigneeId])
        .sort((a, b) => String(a).localeCompare(String(b))),
    ).toEqual(
      [
        ["VAULT_ACCOUNT", "ASSIGN", `one@${DOMAIN}`, RUNNER],
        ["VAULT_ACCOUNT", "ASSIGN", `two@${DOMAIN}`, RUNNER],
        ["VAULT_ACCOUNT", "UNASSIGN", `one@${DOMAIN}`, HOLDER],
        ["VAULT_ACCOUNT", "UNASSIGN", `two@${DOMAIN}`, HOLDER],
      ].sort((a, b) => String(a).localeCompare(String(b))),
    );

    // Already there: nothing to move, and nothing queued for anybody to confirm.
    queued.changes = [];
    expect(await move(RUNNER, waiting)).toEqual({ ok: true, moved: 0 });
    expect(queued.changes).toEqual([]);
  });

  it("refuses someone without the Costco runner role, and moves nothing", async () => {
    expect(await move(MEMBER, waiting)).toEqual({
      ok: false,
      error: "They don't have the Costco runner role.",
    });
    const held = await prisma.vaultAccount.findMany({
      where: { id: { in: waiting } },
      select: { assigneeId: true },
    });
    expect(held.map((row) => row.assigneeId)).toEqual([HOLDER, HOLDER]);
  });
});

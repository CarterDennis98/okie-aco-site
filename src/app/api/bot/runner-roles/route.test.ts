/**
 * Runner roles, as the bot reports them.
 *
 * What matters is that a role change on Discord reaches the one column that decides who can
 * see members' profiles -- both directions, since taking a role away is how a runner is cut
 * off -- while leaving every other role a member holds exactly as sign-in wrote it.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/db/client";
import { RUNNER_ROLES } from "@/lib/auth/admin-scope";
import { POST } from "./route";

const canRun = Boolean(process.env.DATABASE_URL && process.env.BOT_INGEST_TOKEN);

const TARGET = RUNNER_ROLES.target;
const CRUNCHYROLL = RUNNER_ROLES.crunchyroll;
// Not a runner role: must survive every post untouched.
const OG = "1479215474926555178";

// Signed in before, holds Target on Discord now.
const JOINING = "999900000000000091";
// Held Target here, has lost it on Discord.
const LEAVING = "999900000000000092";
// Holds Crunchyroll; the posts below never mention that role.
const UNTOUCHED = "999900000000000093";
// Holds Target, has never signed in -- no row yet.
const NEWCOMER = "999900000000000094";

const IDS = [JOINING, LEAVING, UNTOUCHED, NEWCOMER];

function post(body: unknown, token = process.env.BOT_INGEST_TOKEN): Promise<Response> {
  return POST(
    new Request("http://localhost/api/bot/runner-roles", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    }),
  );
}

const rolesOf = async (id: string) =>
  (await prisma.discordMember.findUnique({ where: { discordUserId: id }, select: { roles: true } }))
    ?.roles;

const snapshot = {
  roles: {
    [TARGET]: [
      { id: JOINING, username: "joining-test" },
      { id: NEWCOMER, username: "newcomer-test", globalName: "Newcomer" },
    ],
  },
};

describe.skipIf(!canRun)("POST /api/bot/runner-roles", () => {
  beforeAll(async () => {
    await cleanup();
    await prisma.discordMember.createMany({
      data: [
        { discordUserId: JOINING, username: "joining-test", roles: [OG] },
        { discordUserId: LEAVING, username: "leaving-test", roles: [OG, TARGET] },
        { discordUserId: UNTOUCHED, username: "untouched-test", roles: [CRUNCHYROLL] },
      ],
    });
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  it("refuses a caller without the bot's token", async () => {
    expect((await post(snapshot, "not-the-token")).status).toBe(401);
  });

  it("refuses a payload that isn't a snapshot of role holders", async () => {
    expect((await post({ roles: { [TARGET]: [{ id: "chess" }] } })).status).toBe(400);
    expect((await post({ holders: [] })).status).toBe(400);
  });

  it("gives the role to everyone listed and takes it from everyone else", async () => {
    const response = await post(snapshot);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ applied: [TARGET], created: 1 });

    // Gained, with the OG role beside it left alone.
    expect(await rolesOf(JOINING)).toEqual([OG, TARGET]);
    // Lost -- and only that one.
    expect(await rolesOf(LEAVING)).toEqual([OG]);
  });

  it("gives a holder who has never signed in a named row to be assigned to", async () => {
    const row = await prisma.discordMember.findUnique({ where: { discordUserId: NEWCOMER } });
    expect(row).toMatchObject({
      username: "newcomer-test",
      globalName: "Newcomer",
      roles: [TARGET],
    });
  });

  it("leaves every role the post doesn't name exactly as it was", async () => {
    expect(await rolesOf(UNTOUCHED)).toEqual([CRUNCHYROLL]);
  });

  it("changes nothing when the same snapshot arrives again", async () => {
    const again = await (await post(snapshot)).json();
    expect(again).toMatchObject({ added: 0, removed: 0, created: 0 });
  });

  it("reports a role it doesn't grant rather than writing it", async () => {
    const response = await post({
      roles: { [OG]: [{ id: UNTOUCHED, username: "untouched-test" }] },
    });
    expect(await response.json()).toMatchObject({ applied: [], ignored: [OG], added: 0 });
    expect(await rolesOf(UNTOUCHED)).toEqual([CRUNCHYROLL]);
  });

  it("takes a role from its last holder when the snapshot is empty", async () => {
    await post({ roles: { [CRUNCHYROLL]: [] } });
    expect(await rolesOf(UNTOUCHED)).toEqual([]);
  });
});

async function cleanup() {
  await prisma.discordMember.deleteMany({ where: { discordUserId: { in: IDS } } });
}

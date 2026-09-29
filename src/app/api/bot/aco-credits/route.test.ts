/**
 * ACO credit balances, as the bot reads them before pricing a /pas run.
 *
 * What matters: only the bot can read them, and only balances there is something left of --
 * a member whose credit was all spent, or all taken back, has nothing for the bot to apply.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/db/client";
import { GET } from "./route";

const canRun = Boolean(process.env.DATABASE_URL && process.env.BOT_INGEST_TOKEN);

const OPERATOR = "999900000000000401";
// Given $10, spent $4 of it.
const HOLDER = "999900000000000411";
// Given $5, all taken back.
const EMPTIED = "999900000000000412";
const MEMBERS = [HOLDER, EMPTIED];
const SESSION = "test-aco-credits-read";

function get(token = process.env.BOT_INGEST_TOKEN): Promise<Response> {
  return GET(
    new Request("http://localhost/api/bot/aco-credits", {
      headers: { authorization: `Bearer ${token}` },
    }),
  );
}

describe.skipIf(!canRun)("GET /api/bot/aco-credits", () => {
  beforeAll(async () => {
    await cleanup();
    await prisma.discordMember.createMany({
      data: MEMBERS.map((discordUserId) => ({
        discordUserId,
        username: `credit-${discordUserId}`,
      })),
    });
    const grant = (discordUserId: string, amountCents: number) => ({
      discordUserId,
      amountCents,
      issuedBy: OPERATOR,
      requestKey: crypto.randomUUID(),
    });
    await prisma.acoCredit.createMany({
      data: [grant(HOLDER, 1000), grant(EMPTIED, 500), grant(EMPTIED, -500)],
    });
    await prisma.pasRun.create({
      data: {
        sessionId: SESSION,
        windowStart: new Date(),
        windowEnd: new Date(),
        dropLabel: "credit read",
        dryRun: false,
        operatorId: OPERATOR,
        bills: {
          create: {
            discordUserId: HOLDER,
            payeeId: OPERATOR,
            subtotalCents: 400,
            creditCents: 400,
            totalCents: 0,
          },
        },
      },
    });
  });

  afterAll(cleanup);

  it("refuses a caller without the bot's token", async () => {
    expect((await get("not-the-token")).status).toBe(401);
  });

  it("returns what is left to spend, and nobody with nothing left", async () => {
    const response = await get();
    expect(response.status).toBe(200);
    const { balances } = await response.json();
    expect(balances[HOLDER]).toBe(600);
    expect(balances).not.toHaveProperty(EMPTIED);
  });
});

async function cleanup() {
  await prisma.pasRun.deleteMany({ where: { sessionId: SESSION } });
  await prisma.acoCredit.deleteMany({ where: { discordUserId: { in: MEMBERS } } });
  await prisma.discordMember.deleteMany({ where: { discordUserId: { in: MEMBERS } } });
}

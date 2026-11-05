/**
 * The home page's "Recent drops" cards.
 *
 * What is pinned here is that a drop is split by RETAILER, not by how each bot spells it. On
 * 2026-11-04 one Topps drop showed as two cards: Makebot's "shop.topps.com" checkouts under
 * a grey "S" chip, and Alpine's "Topps US" one under Topps.
 *
 * The rows sit in 2001, hours from anything else, so they form drops of their own whatever
 * else the database holds.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/db/client";
import { getRecentDrops } from "@/db/queries/public";

const canConnect = Boolean(process.env.DATABASE_URL);

const AT = Date.parse("2001-01-01T03:00:00Z");
const CHANNEL = "999900000000000200";
const MESSAGES = ["999900000000000201", "999900000000000202", "999900000000000203"];

describe.skipIf(!canConnect)("getRecentDrops", () => {
  beforeAll(async () => {
    await cleanup();
    const rows: { site: string; quantity: number }[] = [
      { site: "shop.topps.com", quantity: 4 },
      { site: "Topps US", quantity: 2 },
      { site: "Target", quantity: 1 },
    ];
    await prisma.checkout.createMany({
      data: rows.map((row, i) => ({
        sourceBot: "test",
        discordMessageId: MESSAGES[i],
        discordChannelId: CHANNEL,
        occurredAt: new Date(AT + i * 60_000),
        site: row.site,
        productKey: "test-recent-drops",
        quantity: row.quantity,
      })),
    });
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  it("makes one card per retailer, however each bot spells it", async () => {
    const drops = (await getRecentDrops("all", Number.MAX_SAFE_INTEGER)).filter(
      (drop) => drop.startedAt.getUTCFullYear() === 2001,
    );

    const topps = drops.filter((drop) => drop.id.endsWith("-topps"));
    expect(topps).toHaveLength(1);
    expect(topps[0]).toMatchObject({ checkouts: 2, units: 6, siteLogo: "/topps-logo.png" });

    const target = drops.filter((drop) => drop.id.endsWith("-target"));
    expect(target).toHaveLength(1);
    expect(target[0]).toMatchObject({ checkouts: 1, units: 1 });

    expect(drops).toHaveLength(2);
  });
});

async function cleanup() {
  await prisma.checkout.deleteMany({ where: { discordMessageId: { in: MESSAGES } } });
}

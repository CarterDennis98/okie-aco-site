import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { checkoutBatch, checkoutInput } from "@/types/ingest";

/**
 * The bot's checkout contract.
 *
 * The failure worth pinning is a vendor the site doesn't know. The bot's outbox holds any
 * batch the server rejects and stops flushing until it is accepted, so a single checkout
 * from an unlisted vendor stalls every checkout queued behind it, whoever sent them.
 */

const FIXTURES = path.join(
  process.env.MIRROR_REPO_PATH ?? path.join(process.cwd(), "..", "okie-aco-mirror"),
  "data",
  "fixtures",
  "embeds.json",
);

/** Vendors the mirror has captured embeds for. Empty where its fixtures aren't present. */
function mirrorVendors(): string[] {
  try {
    const fixtures: { vendor: string }[] = JSON.parse(readFileSync(FIXTURES, "utf8"));
    return [...new Set(fixtures.map((f) => f.vendor))];
  } catch {
    return [];
  }
}

describe("checkoutInput", () => {
  it("accepts a Stellar checkout exactly as the mirror builds it", () => {
    // The shape toPayload produces from a real Crunchyroll success: no image (Stellar sends
    // no thumbnail), and a quantity the vendor stated rather than one assumed.
    const result = checkoutBatch.safeParse({
      checkouts: [
        {
          sourceBot: "stellar",
          discordMessageId: "1552094273829343316",
          discordChannelId: "1552094259942002728",
          orderId: "US00000001",
          occurredAt: "2026-09-22T23:08:31.398Z",
          site: "crunchyroll",
          productRaw: "Pokemon - 30th Celebration Trading Card Game Elite Trainer Box",
          sku: "196214158801",
          productUrl: "https://www.crunchyroll.com/store/products/p/196214158801",
          imageUrl: null,
          profileRaw: "carter - 3",
          quantity: 2,
          quantityAssumed: false,
          flags: [],
          rawEmbed: { title: "**Checked Out!**" },
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("accepts Alpine before the bot sends anything from it", () => {
    // Its parser waits on real samples, but the vendor name has to be deployed first --
    // see the note on sourceBot.
    expect(checkoutInput.shape.sourceBot.safeParse("alpine").success).toBe(true);
  });

  const vendors = mirrorVendors();
  it.runIf(vendors.length > 0)("accepts every vendor the mirror has fixtures for", () => {
    const known = checkoutInput.shape.sourceBot;
    for (const vendor of vendors) {
      expect(known.safeParse(vendor).success, `the site would reject "${vendor}"`).toBe(true);
    }
  });
});

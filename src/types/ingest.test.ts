import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { checkoutBatch, checkoutInput, failureBatch, failureInput } from "@/types/ingest";

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

  it("accepts an Alpine checkout exactly as the mirror builds it", () => {
    // The shape toPayload produces from a real Topps success: the product as text with its
    // page as the URL, the Shopify variant as the SKU, and the order NUMBER only -- Alpine's
    // order link carries a login key and never leaves the parser. The product URL keeps the
    // "®" Topps puts in its handles, which must not be what rejects a batch mid-drop.
    const result = checkoutBatch.safeParse({
      checkouts: [
        {
          sourceBot: "alpine",
          discordMessageId: "1554287227834466416",
          discordChannelId: "1554260403209637899",
          orderId: "6719874629789",
          occurredAt: "2026-09-26T17:42:03.000Z",
          site: "Topps US",
          productRaw: "2026 Bowman Chrome® Baseball - Mega Box",
          sku: "48758312665245",
          productUrl: "https://shop.topps.com/products/2026-bowman-chrome®-baseball-mega-box",
          imageUrl: "https://images-ext-1.discordapp.net/external/abc/https/cdn.shopify.com/x.png",
          profileRaw: "carter - 3",
          quantity: 4,
          quantityAssumed: false,
          flags: [],
          rawEmbed: { title: "AlpineAIO - Checked Out!" },
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("accepts a Sniped checkout exactly as the mirror builds it", () => {
    // The shape toPayload produces from a real Target success: the Store with Sniped's
    // "(Checkout)" mode taken off, the TCIN as the SKU, no product URL (Sniped sends none),
    // and the profile name alone -- the login email Sniped stacks under it in the same field
    // never leaves the parser.
    const result = checkoutBatch.safeParse({
      checkouts: [
        {
          sourceBot: "sniped",
          discordMessageId: "1555379159402938389",
          discordChannelId: "1555363461192482856",
          orderId: "912000000000001",
          occurredAt: "2026-10-02T00:41:29.061Z",
          site: "Target",
          productRaw: "2026 Topps NFL Flagship Football Trading Card Value Box",
          sku: "1012944733",
          productUrl: null,
          imageUrl: "https://images-ext-1.discordapp.net/external/abc/https/target.scene7.com/x",
          profileRaw: "Target 11",
          quantity: 2,
          quantityAssumed: false,
          flags: [],
          rawEmbed: { title: "Successful Checkout!" },
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("accepts a Makebot checkout exactly as the mirror builds it", () => {
    // The shape toPayload produces from a real Topps UK success, which Make spreads across
    // three embeds: the store as the domain Make names it, the Shopify variant out of its
    // cart link as the SKU, no product URL (that link is a cart permalink, not a page), and
    // the order NUMBER out of the third embed's title. The raw embed is the first of the
    // three, the one without the member's login and phone in it.
    const result = checkoutBatch.safeParse({
      checkouts: [
        {
          sourceBot: "makebot",
          discordMessageId: "1566525613240614925",
          discordChannelId: "1566492672007479456",
          orderId: "TESTORDR1",
          occurredAt: "2026-11-01T18:53:30.135Z",
          site: "shop-uk.topps.com",
          productRaw: "2026 Topps Chrome® Football - Mega Box",
          sku: "71615158681853",
          productUrl: null,
          imageUrl: "https://images-ext-1.discordapp.net/external/abc/https/cdn.shopify.com/x.png",
          profileRaw: "carter - 3",
          quantity: 1,
          quantityAssumed: false,
          flags: [],
          rawEmbed: { title: "Make Success" },
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("accepts a Hayha checkout exactly as the mirror builds it", () => {
    // The shape toPayload produces from chess's Hayha on Menards. Its posts name no product
    // -- no name, no SKU, no link -- so all three go up null and the route files the checkout
    // under "(no product listed)", as /pas run bills it. Its thumbnail is Hayha's own logo,
    // which the parser drops, and it sets no embed timestamp, so occurredAt is the post's.
    const result = checkoutBatch.safeParse({
      checkouts: [
        {
          sourceBot: "hayha",
          discordMessageId: "1568018653184655522",
          discordChannelId: "1568017350265933994",
          orderId: "USM00000001",
          occurredAt: "2026-11-05T21:46:19.297Z",
          site: "Menards",
          productRaw: null,
          sku: null,
          productUrl: null,
          imageUrl: null,
          profileRaw: "carter - 3",
          quantity: 10,
          quantityAssumed: false,
          flags: [],
          rawEmbed: { title: "Successful Checkout!" },
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("accepts a quantity of zero rather than stalling the outbox", () => {
    // Alpine sent "Quantity: 0" on 9 of 32 real Topps successes on 2026-10-16. The rejection
    // held every checkout behind them, from every vendor, for four days. The route reads
    // zero as no quantity.
    const result = checkoutBatch.safeParse({
      checkouts: [
        {
          sourceBot: "alpine",
          discordMessageId: "1554287227834466417",
          discordChannelId: "1554260403209637899",
          orderId: "6719874629790",
          occurredAt: "2026-10-16T16:04:05.000Z",
          site: "Topps US",
          productRaw: "2026 Topps Chrome Football - Hobby Box",
          productUrl: "https://shop.topps.com/products/2026-topps-chrome-football-hobby-box",
          profileRaw: "carter - 3",
          quantity: 0,
          quantityAssumed: false,
          flags: [],
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  const vendors = mirrorVendors();
  it.runIf(vendors.length > 0)("accepts every vendor the mirror has fixtures for", () => {
    const known = checkoutInput.shape.sourceBot;
    for (const vendor of vendors) {
      expect(known.safeParse(vendor).success, `the site would reject "${vendor}"`).toBe(true);
    }
  });
});

describe("failureInput", () => {
  // Shapes toFailurePayload (okie-aco-mirror/src/mirror/ingest.js) builds from real failures.
  const base = {
    discordMessageId: "1555378204364111974",
    discordChannelId: "1555363461192482856",
    occurredAt: "2026-10-02T00:37:41.335Z",
  };

  it("accepts a cancellation, a bare decline, and a decline that names no product", () => {
    const result = failureBatch.safeParse({
      failures: [
        // Sniped: Target cancelled a placed order, so it has a number and Target's reason.
        {
          ...base,
          sourceBot: "sniped",
          orderId: "912004567890",
          site: "Target",
          productRaw: "2026 Topps NFL Flagship Football Trading Card Value Box",
          profileRaw: "Target 46",
          reason: "Cancelled Checkout (Policy - Item Demand)",
        },
        // Valor: "Declined" and nothing else -- no order, no reason.
        {
          ...base,
          discordMessageId: "1493319989627846858",
          sourceBot: "valor",
          orderId: null,
          site: "Pokemon Center US",
          productRaw:
            "[(10-10403-109) Pokémon TCG: Booster Bundle](https://www.pokemoncenter.com/product/10-10403-109)",
          profileRaw: " devin24_ - 2 ",
          reason: null,
        },
        // Hayha: no product at all.
        {
          ...base,
          discordMessageId: "1568018721614602351",
          sourceBot: "hayha",
          orderId: null,
          site: "Menards",
          productRaw: "",
          profileRaw: "carter - 3",
          reason: "Payment Declined",
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("takes no raw embed: a failure's carries logins the flag has no use for", () => {
    const result = failureInput.safeParse({
      ...base,
      sourceBot: "valor",
      rawEmbed: { title: "Checkout Declined" },
    });
    expect(result.success).toBe(false);
  });

  it("takes only the vendors a checkout may come from", () => {
    expect(failureInput.shape.sourceBot.options).toEqual(checkoutInput.shape.sourceBot.options);
    expect(failureInput.safeParse({ ...base, sourceBot: "someone-new" }).success).toBe(false);
  });
});

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { sanitizeEmbed } from "@/lib/ingest/embed-allowlist";

/**
 * The property under test is one-directional: nothing outside the allowlist survives.
 *
 * Where the real captured vendor embeds are available these run against them, because
 * hand-written samples can't tell you that a vendor added a field last week.
 */

const FIXTURES = path.join(
  process.env.MIRROR_REPO_PATH ?? path.join(process.cwd(), "..", "okie-aco-mirror"),
  "data",
  "fixtures",
  "embeds.json",
);

function realEmbeds(): { vendor: string; kind: string; embed: Record<string, unknown> }[] {
  try {
    return JSON.parse(readFileSync(FIXTURES, "utf8"));
  } catch {
    return [];
  }
}

describe("sanitizeEmbed", () => {
  it("keeps the scalars the parsers and the backfill need", () => {
    const { embed } = sanitizeEmbed({
      title: "Successful Checkout",
      description: "a product",
      timestamp: "2026-08-01T00:00:00.000Z",
      author: { name: "Successful Checkout | Target", icon_url: "https://x/y.png" },
      footer: { text: "2026-Jun-30 02:41:21", icon_url: "https://x/z.png" },
      thumbnail: { url: "https://x/t.png", proxy_url: "https://p/t.png", width: 80 },
    });

    expect(embed).toMatchObject({
      title: "Successful Checkout",
      description: "a product",
      author: { name: "Successful Checkout | Target" },
      footer: { text: "2026-Jun-30 02:41:21" },
    });
    // Nested extras are dropped rather than carried along.
    expect(embed?.author).toEqual({ name: "Successful Checkout | Target" });
    expect(embed?.footer).toEqual({ text: "2026-Jun-30 02:41:21" });
    expect(embed?.thumbnail).toEqual({ url: "https://x/t.png", proxy_url: "https://p/t.png" });
  });

  it("keeps the allowlisted fields", () => {
    const { embed, dropped } = sanitizeEmbed({
      fields: [
        { name: "Site", value: "Target" },
        { name: "Product", value: "a thing" },
        { name: "Quantity", value: "2" },
        { name: "Profile", value: "carter - 3" },
        { name: "Price", value: "$19.99" },
        { name: "Size", value: "OS" },
      ],
    });
    expect((embed?.fields as unknown[]).length).toBe(6);
    expect(dropped).toEqual([]);
  });

  it("keeps Stellar's own spellings and drops its credentials", () => {
    // Stellar names quantity "Qty" and exposes a "SKU"; both were dropped before it was
    // added, which cost nothing but made the stored embed less recoverable than the rest.
    const { embed, dropped, droppedSensitive } = sanitizeEmbed({
      title: "**Checked Out!**",
      url: "https://www.crunchyroll.com/store/products/p/196214158801",
      fields: [
        { name: "Site", value: "crunchyroll" },
        { name: "Mode", value: "normal" },
        {
          name: "Product",
          value: "Pokemon - 30th Celebration Trading Card Game Elite Trainer Box",
        },
        { name: "SKU", value: "196214158801" },
        { name: "Qty", value: "2" },
        { name: "Price", value: "99.98 USD" },
        { name: "Profile", value: "||carter - 3||" },
        { name: "Order ID", value: "||US00000001||" },
        { name: "Account", value: "buyer@example.com:hunter2" },
        { name: "Proxy", value: "1.2.3.4:8080:user:pass" },
      ],
    });
    expect((embed?.fields as { name: string }[]).map((f) => f.name)).toEqual([
      "Site",
      "Mode",
      "Product",
      "SKU",
      "Qty",
      "Price",
      "Profile",
      "Order ID",
    ]);
    expect(dropped.sort()).toEqual(["Account", "Proxy"]);
    expect(droppedSensitive.sort()).toEqual(["Account", "Proxy"]);
  });

  it("keeps every spelling of the order field", () => {
    for (const name of ["Order Number", "Order ID", "Order #", "Order:"]) {
      const { embed, dropped } = sanitizeEmbed({ fields: [{ name, value: "4471983" }] });
      expect(dropped).toEqual([]);
      expect((embed?.fields as { name: string }[])[0].name).toBe(name);
    }
  });

  it("reads Alpine's colon-suffixed names, and drops its login and proxy", () => {
    // Shaped like a real AlpineAIO success, values replaced.
    const { embed, dropped, droppedSensitive } = sanitizeEmbed({
      title: "AlpineAIO - Checked Out!",
      fields: [
        { name: "Site:", value: "Topps US" },
        {
          name: "Product:",
          value: "[2026 Topps Heritage Football - Value Box](https://shop.topps.com/products/x)",
        },
        { name: "Variant:", value: "48926411194525" },
        { name: "Price:", value: "$37.1" },
        { name: "Quantity:", value: "1" },
        { name: "Profile:", value: "carter - 3" },
        { name: "Profile Email:", value: "buyer@example.com" },
        {
          name: "Order:",
          value:
            "[6719874629789](https://account.topps.com/orders/abc123/authenticate?key=shcct_secret&locale=en-US)",
        },
        { name: "Mode:", value: "SAFE" },
        { name: "Proxy:", value: "||1.2.3.4:8080:user:pass||" },
      ],
    });
    const fields = embed?.fields as { name: string; value: string }[];
    expect(fields.map((f) => f.name)).toEqual([
      "Site:",
      "Product:",
      "Variant:",
      "Price:",
      "Quantity:",
      "Profile:",
      "Order:",
      "Mode:",
    ]);
    expect(dropped.sort()).toEqual(["Profile Email:", "Proxy:"]);
    expect(droppedSensitive.sort()).toEqual(["Profile Email:", "Proxy:"]);
  });

  it("keeps Sniped's Store, and its Profile without the login email stacked inside it", () => {
    // Shaped like a real sniped.gg success, values replaced. Sniped puts the retailer login's
    // address on a second line of the Profile field itself, each line spoilered on its own,
    // so allowing "Profile" by name would store the address with it.
    const { embed, dropped, droppedSensitive } = sanitizeEmbed({
      title: "Successful Checkout!",
      fields: [
        { name: "Date", value: "<t:1759365689:f>" },
        { name: "Store", value: "Target (Checkout)" },
        { name: "Profile", value: "||Target 11||\n||buyer@example.com||" },
        { name: "Product", value: "2026 Topps NFL Flagship Football Trading Card Value Box" },
        { name: "SKU", value: "1012944733" },
        { name: "Price", value: "$24.99" },
        { name: "Quantity", value: "2" },
        { name: "Proxy", value: "||1.2.3.4:8080:user:pass||" },
        { name: "Order Number", value: "||912000000000001||" },
        { name: "Status", value: "Still placed" },
      ],
    });
    const fields = embed?.fields as { name: string; value: string }[];
    expect(fields.map((f) => f.name)).toEqual([
      "Store",
      "Profile",
      "Product",
      "SKU",
      "Price",
      "Quantity",
      "Order Number",
    ]);
    expect(fields.find((f) => f.name === "Profile")?.value).toBe("||Target 11||");
    expect(JSON.stringify(embed)).not.toContain("buyer@example.com");
    expect(dropped.sort()).toEqual(["Date", "Proxy", "Status"]);
    expect(droppedSensitive).toEqual(["Proxy"]);
  });

  it("stores no email address from any field it keeps", () => {
    // The whole line goes, not just the address: whatever shares a line with a login's
    // address is likelier to be the rest of that login than anything worth keeping.
    const { embed, dropped } = sanitizeEmbed({
      fields: [
        { name: "Profile", value: "carter - 3\nbuyer@example.com:hunter2" },
        { name: "Product", value: "a thing" },
        { name: "Site", value: "||buyer@example.com||" },
      ],
    });
    expect(embed?.fields).toEqual([
      { name: "Profile", value: "carter - 3" },
      { name: "Product", value: "a thing" },
    ]);
    // A field that was nothing but an address has nothing left worth storing.
    expect(dropped).toEqual(["Site"]);
  });

  /**
   * Alpine links each Topps order to Shopify's order-status page with an
   * `authenticate?key=` token in the URL, which opens the order -- address and all -- for
   * whoever holds it. The number is the part worth keeping.
   */
  it("keeps an order's number and never the link around it", () => {
    const { embed, dropped } = sanitizeEmbed({
      fields: [
        {
          name: "Order:",
          value:
            "[6719874629789](https://account.topps.com/orders/abc123/authenticate?key=shcct_secret&locale=en-US)",
        },
        { name: "Order Number", value: "[#4471983](https://www.target.com/orders/4471983)" },
        { name: "Order ID", value: "||US00000001||" },
        { name: "Order Link", value: "https://example.com/o/1?token=abc" },
      ],
    });
    const fields = embed?.fields as { name: string; value: string }[];
    expect(fields).toEqual([
      { name: "Order:", value: "6719874629789" },
      { name: "Order Number", value: "#4471983" },
      { name: "Order ID", value: "||US00000001||" },
    ]);
    // Nothing of any link survives, and a field that was only a link is reported as dropped.
    expect(JSON.stringify(embed)).not.toMatch(/https?:|authenticate|shcct_|token=/);
    expect(dropped).toEqual(["Order Link"]);
  });

  it("strips Swft's bold markers when matching names", () => {
    const { embed, dropped } = sanitizeEmbed({
      fields: [
        { name: "**Site**", value: "Target" },
        { name: "**Email**", value: "someone@example.com" },
      ],
    });
    expect((embed?.fields as { name: string }[]).map((f) => f.name)).toEqual(["**Site**"]);
    expect(dropped).toEqual(["**Email**"]);
  });

  it("drops credential-bearing fields and says which were sensitive", () => {
    const { embed, dropped, droppedSensitive } = sanitizeEmbed({
      fields: [
        { name: "Site", value: "Target" },
        { name: "Email", value: "buyer@example.com" },
        { name: "Account", value: "buyer@example.com:hunter2" },
        { name: "Proxy", value: "1.2.3.4:8080:user:pass" },
        { name: "Proxy Details", value: "1.2.3.4:8080:user:pass" },
        { name: "Checkout Proxy", value: "1.2.3.4:8080:user:pass" },
        { name: "Proxy Group", value: "residential" },
        { name: "Payment", value: "4111111111111111" },
        { name: "Share Link", value: "https://share.refractbot.com/setup/W3sic2l0ZSI6" },
      ],
    });

    expect((embed?.fields as { name: string }[]).map((f) => f.name)).toEqual(["Site"]);
    expect(dropped.sort()).toEqual(
      [
        "Account",
        "Checkout Proxy",
        "Email",
        "Payment",
        "Proxy",
        "Proxy Details",
        "Proxy Group",
        "Share Link",
      ].sort(),
    );
    expect(droppedSensitive.length).toBe(8);
  });

  it("drops a field nobody has thought about — allowlist, not denylist", () => {
    const { embed, dropped, droppedSensitive } = sanitizeEmbed({
      fields: [
        { name: "Site", value: "Target" },
        { name: "Some New Vendor Field", value: "who knows" },
      ],
    });
    expect((embed?.fields as { name: string }[]).map((f) => f.name)).toEqual(["Site"]);
    expect(dropped).toEqual(["Some New Vendor Field"]);
    // Unknown, so not flagged as a known credential -- but still not stored.
    expect(droppedSensitive).toEqual([]);
  });

  it("returns null for junk rather than an empty shell", () => {
    expect(sanitizeEmbed(null).embed).toBeNull();
    expect(sanitizeEmbed("nope").embed).toBeNull();
    expect(sanitizeEmbed({}).embed).toBeNull();
  });

  const embeds = realEmbeds();
  it.runIf(embeds.length > 0)("lets no known credential field through a real vendor embed", () => {
    const banned = /email|account|payment|proxy|share link/i;
    for (const { vendor, kind, embed } of embeds) {
      const { embed: safe } = sanitizeEmbed(embed);
      const names = ((safe?.fields as { name: string }[]) ?? []).map((f) => f.name);
      for (const name of names) {
        expect(banned.test(name), `${vendor}/${kind} kept "${name}"`).toBe(false);
      }
    }
  });

  it.runIf(embeds.length > 0)("keeps no email address anywhere in a real vendor embed", () => {
    // A boolean, not a toMatch: a failure must not print the embed, address and all.
    const email = /[^\s@"]+@[^\s@"]+\.[^\s@"]+/;
    for (const { vendor, kind, embed } of embeds) {
      const { embed: safe } = sanitizeEmbed(embed);
      expect(
        email.test(JSON.stringify(safe ?? {})),
        `${vendor}/${kind} kept an email address`,
      ).toBe(false);
    }
  });

  it.runIf(embeds.length > 0)("keeps no link inside an order field on a real embed", () => {
    for (const { vendor, kind, embed } of embeds) {
      const { embed: safe } = sanitizeEmbed(embed);
      for (const field of (safe?.fields as { name: string; value: unknown }[]) ?? []) {
        if (!/^(\*\*)?order/i.test(field.name)) continue;
        expect(String(field.value), `${vendor}/${kind} kept a link in "${field.name}"`).not.toMatch(
          /https?:\/\//,
        );
      }
    }
  });

  it.runIf(embeds.length > 0)("keeps the product and order fields on every real embed", () => {
    for (const { vendor, kind, embed } of embeds) {
      const { embed: safe } = sanitizeEmbed(embed);
      const names = ((safe?.fields as { name: string }[]) ?? []).map((f) =>
        f.name.replace(/\*\*/g, "").replace(/:\s*$/, "").toLowerCase(),
      );
      const hasIdentity =
        names.some((n) => n.startsWith("order")) ||
        names.includes("product") ||
        names.includes("item") ||
        names.includes("id");
      expect(hasIdentity, `${vendor}/${kind} kept none of order/product/item/id`).toBe(true);
    }
  });
});

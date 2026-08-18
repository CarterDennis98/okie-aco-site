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

  it("keeps every spelling of the order field", () => {
    for (const name of ["Order Number", "Order ID", "Order #"]) {
      const { embed, dropped } = sanitizeEmbed({ fields: [{ name, value: "4471983" }] });
      expect(dropped).toEqual([]);
      expect((embed?.fields as { name: string }[])[0].name).toBe(name);
    }
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

  it.runIf(embeds.length > 0)("keeps the product and order fields on every real embed", () => {
    for (const { vendor, kind, embed } of embeds) {
      const { embed: safe } = sanitizeEmbed(embed);
      const names = ((safe?.fields as { name: string }[]) ?? []).map((f) =>
        f.name.replace(/\*\*/g, "").toLowerCase(),
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

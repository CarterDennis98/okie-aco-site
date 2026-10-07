import { describe, expect, it } from "vitest";
import {
  nameFromTargetUrl,
  parsePastedLinks,
  parseProductInput,
  parseSetName,
  targetSku,
} from "@/lib/products/product-input";

const LINK =
  "https://www.target.com/p/pokemon-trading-card-game-mega-evolution-phantasmal-flames-elite-trainer-box/-/A-95082118?clkid=abc&lnk=sametab#lnk=sametab";

const fields = (over: Partial<Parameters<typeof parseProductInput>[0]> = {}) => ({
  setName: "Phantasmal Flames",
  name: "",
  url: LINK,
  sku: "",
  price: "",
  pasFee: "",
  imageUrl: "",
  ...over,
});

describe("reading a Target link", () => {
  it("finds the TCIN the way the bot's drop reader did", () => {
    expect(targetSku(LINK)).toBe("95082118");
    expect(targetSku("https://target.com/p/x/-/A-1004334525")).toBe("1004334525");
    expect(targetSku("https://www.walmart.com/ip/x/A-12345678")).toBeNull();
  });

  it("guesses a name from the slug", () => {
    expect(nameFromTargetUrl(LINK)).toBe(
      "Pokemon Trading Card Game Mega Evolution Phantasmal Flames Elite Trainer Box",
    );
  });

  it("puts back the é Target writes as a number, and leaves real numbers alone", () => {
    expect(
      nameFromTargetUrl(
        "https://www.target.com/p/pok-233-mon-trading-card-game-30th-celebration-booster-bundle-box/-/A-1011407490",
      ),
    ).toBe("Pokémon Trading Card Game 30th Celebration Booster Bundle Box");
    expect(nameFromTargetUrl("https://www.target.com/p/pokemon-233-card-binder/-/A-1")).toBe(
      "Pokemon 233 Card Binder",
    );
  });
});

describe("parseProductInput", () => {
  it("fills the SKU and name from the link, and trims its tracking", () => {
    const parsed = parseProductInput(fields({ price: "$49.99" }));
    expect(parsed).toEqual({
      ok: true,
      value: {
        setName: "Phantasmal Flames",
        name: "Pokemon Trading Card Game Mega Evolution Phantasmal Flames Elite Trainer Box",
        url: "https://www.target.com/p/pokemon-trading-card-game-mega-evolution-phantasmal-flames-elite-trainer-box/-/A-95082118",
        sku: "95082118",
        priceCents: 4999,
        pasFeeCents: null,
        imageUrl: null,
      },
    });
  });

  it("reads the PAS fee per unit, where $0 is a fee and blank is none", () => {
    const fee = (pasFee: string) => {
      const parsed = parseProductInput(fields({ pasFee }));
      return parsed.ok ? parsed.value.pasFeeCents : parsed.error;
    };
    expect(fee("$5")).toBe(500);
    expect(fee(" 12.50 ")).toBe(1250);
    expect(fee("0")).toBe(0);
    expect(fee("")).toBeNull();
    expect(fee("five")).toBe("That PAS fee isn't a number.");
  });

  it("refuses a SKU that disagrees with the link", () => {
    expect(parseProductInput(fields({ sku: "11111111" }))).toEqual({
      ok: false,
      error: "That SKU doesn't match the link, which is A-95082118.",
    });
  });

  it("accepts the variant a link preselects, and keeps that in the link", () => {
    const parsed = parseProductInput(
      fields({
        url: "https://www.target.com/p/x/-/A-90000000?preselect=90000001&lnk=x",
        sku: "90000001",
      }),
    );
    expect(parsed).toMatchObject({
      ok: true,
      value: { sku: "90000001", url: "https://www.target.com/p/x/-/A-90000000?preselect=90000001" },
    });
  });

  it.each([
    [{ setName: " " }, "Which set is it in?"],
    [{ url: "https://www.walmart.com/ip/1" }, "Paste the product's target.com link."],
    [{ url: "http://www.target.com/p/x/-/A-95082118" }, "Paste the product's target.com link."],
    [
      { url: "https://www.target.com/c/collectible-trading-cards" },
      "No SKU in that link — type the TCIN.",
    ],
    [{ url: `https://www.target.com/p/a/-${LINK}` }, "That looks like two links pasted together."],
    [{ price: "free" }, "That price isn't a number."],
    [{ imageUrl: "http://img.example/x.png" }, "The image needs an https:// link."],
  ])("says what's wrong with %o", (over, error) => {
    expect(parseProductInput(fields(over))).toEqual({ ok: false, error });
  });
});

describe("parseSetName", () => {
  it("collapses the spacing, so one set isn't two headings", () => {
    expect(parseSetName("  Phantasmal   Flames ")).toEqual({
      ok: true,
      value: "Phantasmal Flames",
    });
    expect(parseSetName("   ")).toEqual({ ok: false, error: "Which set is it in?" });
    expect(parseSetName("x".repeat(81))).toEqual({
      ok: false,
      error: "That set name is too long.",
    });
  });
});

describe("parsePastedLinks", () => {
  const link = (sku: string, slug = "pokemon-elite-trainer-box") =>
    `https://www.target.com/p/${slug}/-/A-${sku}`;

  it("reads every link in a paste, in order, each with its SKU, a name and a price beside it", () => {
    const pasted = [
      `Elite Trainer Box — $49.99 — ${link("95082118")}?lnk=sametab`,
      `${link("95093989", "pokemon-booster-display")}   29.99`,
      // Digits in a name are no price: only a "$" amount or one with cents is.
      `151 Booster Bundle ${link("95163306", "pokemon-151-booster-bundle")}`,
    ].join("\n");
    expect(parsePastedLinks(pasted)).toEqual({
      products: [
        {
          url: `${link("95082118")}?lnk=sametab`,
          sku: "95082118",
          name: "Pokemon Elite Trainer Box",
          price: "$49.99",
        },
        {
          url: link("95093989", "pokemon-booster-display"),
          sku: "95093989",
          name: "Pokemon Booster Display",
          price: "29.99",
        },
        {
          url: link("95163306", "pokemon-151-booster-bundle"),
          sku: "95163306",
          name: "Pokemon 151 Booster Bundle",
          price: "",
        },
      ],
      skipped: [],
    });
  });

  it("pulls links out of chat formatting, and apart when they were run together", () => {
    const { products } = parsePastedLinks(
      `<${link("90000001")}> and (${link("90000002")}).\n${link("90000003")}${link("90000004")}`,
    );
    expect(products.map((p) => [p.url, p.sku])).toEqual([
      [link("90000001"), "90000001"],
      [link("90000002"), "90000002"],
      [link("90000003"), "90000003"],
      [link("90000004"), "90000004"],
    ]);
  });

  it("gives a price to no link when a line has two to choose from", () => {
    const { products } = parsePastedLinks(`${link("90000001")} ${link("90000002")} $19.99`);
    expect(products.map((p) => p.price)).toEqual(["", ""]);
  });

  it("says which lines had no Target link instead of dropping them quietly", () => {
    const { products, skipped } = parsePastedLinks(
      `Restock tonight!\n\nhttps://www.walmart.com/ip/x/123\n${link("90000001")}`,
    );
    expect(products).toHaveLength(1);
    expect(skipped).toEqual(["Restock tonight!", "https://www.walmart.com/ip/x/123"]);
  });

  it("keeps a Target link with no TCIN, for the editor to ask for one", () => {
    const { products } = parsePastedLinks("https://www.target.com/c/trading-cards");
    expect(products).toEqual([
      { url: "https://www.target.com/c/trading-cards", sku: "", name: "", price: "" },
    ]);
  });
});

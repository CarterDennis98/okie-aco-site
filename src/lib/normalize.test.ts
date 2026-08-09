/**
 * Parity suite: the TypeScript port must agree with the bot's JavaScript byte for byte.
 *
 * Rather than restating expected values by hand (which would only test that I copied my
 * own assumptions consistently), this loads the ACTUAL bot module via createRequire and
 * runs both implementations over every distinct string in the real billing-run records.
 *
 * If the bot repo isn't present the parity tests skip, and the hand-written cases below
 * still run — so CI without the sibling checkout stays green but a local run is thorough.
 */
import { createRequire } from "node:module";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { normalizeProduct, normalizeProfile, parseQuantity } from "./normalize";
import { money, ogDiscountCents, safeLabel } from "./money";

const require = createRequire(import.meta.url);

const MIRROR_REPO =
  process.env.MIRROR_REPO_PATH ?? path.resolve(process.cwd(), "..", "okie-aco-mirror");
const BOT_SCRAPE = path.join(MIRROR_REPO, "src", "pas", "scrape.js");
const BOT_RENDER = path.join(MIRROR_REPO, "src", "pas", "render.js");
const SESSION_DIR = path.join(MIRROR_REPO, "data", "pas-sessions");

const botAvailable = existsSync(BOT_SCRAPE) && existsSync(BOT_RENDER);

type BotScrape = {
  normalizeProfile: (raw: unknown) => unknown;
  normalizeProduct: (raw: unknown, aliases?: Record<string, string>) => unknown;
  parseQuantity: (raw: unknown) => unknown;
};
type BotRender = { money: (cents: number) => string; safeLabel: (label: string) => string };

// ---------------------------------------------------------------------------
// Hand-written cases -- always run
// ---------------------------------------------------------------------------

describe("normalizeProfile", () => {
  it("collapses a numbered profile onto its base key", () => {
    expect(normalizeProfile("carter - 3")).toEqual({
      profileRaw: "carter - 3",
      profileKey: "carter",
      profileIndex: 3,
    });
  });

  it("strips spoiler bars and markdown", () => {
    expect(normalizeProfile("||`carter`||")?.profileKey).toBe("carter");
  });

  it("collapses runs of whitespace", () => {
    expect(normalizeProfile("  spaced   name  ")?.profileRaw).toBe("spaced name");
  });

  it("strips only the last numeric suffix", () => {
    expect(normalizeProfile("x - 2 - 3")?.profileKey).toBe("x - 2");
  });

  it("returns null for nullish and empty input", () => {
    expect(normalizeProfile(null)).toBeNull();
    expect(normalizeProfile(undefined)).toBeNull();
    expect(normalizeProfile("   ")).toBeNull();
  });
});

describe("normalizeProduct", () => {
  it("preserves non-ASCII exactly", () => {
    const label = "Pokémon Trading Card Game: First Partner Illustration Collection—Series 3";
    const result = normalizeProduct(label);
    expect(result.label).toBe(label);
    expect(result.productKey).toBe(label.toLowerCase());
    expect(result.productKey).toContain("é");
    expect(result.productKey).toContain("—");
  });

  it("flags a bare SKU as unreadable", () => {
    expect(normalizeProduct("95120834").unreadable).toBe(true);
    expect(normalizeProduct("Booster Bundle").unreadable).toBe(false);
  });

  it("applies aliases case-insensitively", () => {
    const aliases = { "95120834": "Prismatic Evolutions Booster Bundle" };
    const result = normalizeProduct("95120834", aliases);
    expect(result.label).toBe("Prismatic Evolutions Booster Bundle");
    expect(result.unreadable).toBe(false);
  });

  it("handles a missing product", () => {
    expect(normalizeProduct(null)).toEqual({
      productKey: "__unknown__",
      label: "(no product listed)",
      unreadable: true,
    });
  });
});

describe("parseQuantity", () => {
  it("flags an absent quantity as assumed", () => {
    expect(parseQuantity(undefined)).toEqual({ quantity: 1, assumed: true });
    expect(parseQuantity(null)).toEqual({ quantity: 1, assumed: true });
  });

  it("extracts digits from noisy values", () => {
    expect(parseQuantity("x3")).toEqual({ quantity: 3, assumed: false });
    expect(parseQuantity("2 units")).toEqual({ quantity: 2, assumed: false });
  });

  it("treats zero and garbage as assumed", () => {
    expect(parseQuantity("0")).toEqual({ quantity: 1, assumed: true });
    expect(parseQuantity("abc")).toEqual({ quantity: 1, assumed: true });
  });
});

describe("money", () => {
  it("omits cents when the amount is whole dollars", () => {
    expect(money(800)).toBe("$8");
    expect(money(0)).toBe("$0");
  });

  it("shows cents otherwise", () => {
    expect(money(250)).toBe("$2.50");
    expect(money(725)).toBe("$7.25");
  });

  it("handles negatives", () => {
    expect(money(-400)).toBe("-$4");
    expect(money(-363)).toBe("-$3.63");
  });
});

describe("ogDiscountCents", () => {
  it("halves the subtotal for OG members", () => {
    expect(ogDiscountCents(1400, true)).toBe(700);
  });

  it("rounds odd cents in the member's favour", () => {
    // $7.25 -> discount $3.63, leaving the member paying $3.62
    expect(ogDiscountCents(725, true)).toBe(363);
    expect(725 - ogDiscountCents(725, true)).toBe(362);
  });

  it("is zero for non-OG members", () => {
    expect(ogDiscountCents(1400, false)).toBe(0);
  });
});

describe("safeLabel", () => {
  it("neutralizes backticks and newlines that would break a code span", () => {
    expect(safeLabel("Weird`Name\nBroken")).toBe("Weird'Name Broken");
  });
});

// ---------------------------------------------------------------------------
// Parity against the bot's real implementation
// ---------------------------------------------------------------------------

describe.skipIf(!botAvailable)("parity with okie-aco-mirror", () => {
  const bot = require(BOT_SCRAPE) as BotScrape;
  const botRender = require(BOT_RENDER) as BotRender;

  /** Every distinct product and profile string in the real billing records. */
  function realStrings() {
    const products = new Set<string>();
    const profiles = new Set<string>();
    const quantities = new Set<string>();

    if (!existsSync(SESSION_DIR)) return { products, profiles, quantities };

    for (const file of readdirSync(SESSION_DIR).filter((f) => f.endsWith(".json"))) {
      const session = JSON.parse(readFileSync(path.join(SESSION_DIR, file), "utf8"));
      for (const checkout of session.checkouts ?? []) {
        if (checkout.productRaw) products.add(checkout.productRaw);
        if (checkout.profileRaw) profiles.add(checkout.profileRaw);
        if (checkout.quantity !== undefined) quantities.add(String(checkout.quantity));
      }
      for (const profile of Object.values(session.profiles ?? {}) as { rawNames?: string[] }[]) {
        for (const name of profile.rawNames ?? []) profiles.add(name);
      }
    }
    return { products, profiles, quantities };
  }

  const { products, profiles, quantities } = realStrings();

  it("found real strings to compare", () => {
    expect(products.size).toBeGreaterThan(0);
    expect(profiles.size).toBeGreaterThan(0);
  });

  it(`normalizeProfile agrees on all ${profiles.size} real profile names`, () => {
    for (const raw of profiles) {
      expect(normalizeProfile(raw), `profile: ${JSON.stringify(raw)}`).toEqual(
        bot.normalizeProfile(raw),
      );
    }
  });

  it(`normalizeProduct agrees on all ${products.size} real product names`, () => {
    for (const raw of products) {
      expect(normalizeProduct(raw), `product: ${JSON.stringify(raw)}`).toEqual(
        bot.normalizeProduct(raw),
      );
    }
  });

  it("normalizeProduct agrees when an alias applies", () => {
    const aliases = { "95120834": "Prismatic Evolutions Booster Bundle" };
    for (const raw of [...products, "95120834", "95120834 ", "  Mixed  Case  "]) {
      expect(normalizeProduct(raw, aliases), `product: ${JSON.stringify(raw)}`).toEqual(
        bot.normalizeProduct(raw, aliases),
      );
    }
  });

  it("agrees on edge-case inputs both implementations must handle", () => {
    const edges = [
      null,
      undefined,
      "",
      "   ",
      "||spoiler||",
      "`ticks`",
      "**bold**",
      "trailing - 12",
      "- 2",
      "a  b   c",
      "Pokémon Trading Card Game: First Partner Illustration Collection—Series 3",
      "95120834",
      "12345",
      "ALLCAPS NAME",
    ];
    for (const raw of edges) {
      expect(normalizeProfile(raw as string), `profile: ${JSON.stringify(raw)}`).toEqual(
        bot.normalizeProfile(raw),
      );
      expect(normalizeProduct(raw as string), `product: ${JSON.stringify(raw)}`).toEqual(
        bot.normalizeProduct(raw),
      );
    }
  });

  /**
   * The real-data and hand-picked cases above only exercise code paths the samples
   * happen to reach. Verified by mutation: dropping `~` from the markdown strip passed
   * every one of them, because no real profile name contains a tilde.
   *
   * This fuzzes both implementations over strings built from an alphabet covering every
   * construct either one branches on, so a drift in an unsampled path still fails.
   * Seeded, so a failure is reproducible.
   */
  it("agrees on 5000 generated strings covering every special construct", () => {
    // mulberry32 -- small deterministic PRNG
    let seed = 0x9e3779b9;
    const rand = () => {
      seed |= 0;
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };

    const atoms = [
      "a",
      "Z",
      "9",
      "0",
      " ",
      "  ",
      "\t",
      "\n",
      "\r\n",
      "`",
      "*",
      "_",
      "~",
      "|",
      "||",
      "-",
      " - ",
      "--",
      "é",
      "—",
      "ñ",
      "™",
      "🙂",
      ".",
      ":",
      "/",
      "\\",
      "'",
      '"',
      "1",
      "12",
      "123456",
      "1234567",
      "carter",
      "Target",
      "  ",
    ];

    for (let i = 0; i < 5000; i++) {
      const parts = 1 + Math.floor(rand() * 8);
      let s = "";
      for (let p = 0; p < parts; p++) s += atoms[Math.floor(rand() * atoms.length)];

      expect(normalizeProfile(s), `profile fuzz: ${JSON.stringify(s)}`).toEqual(
        bot.normalizeProfile(s),
      );
      expect(normalizeProduct(s), `product fuzz: ${JSON.stringify(s)}`).toEqual(
        bot.normalizeProduct(s),
      );
      expect(safeLabel(s), `safeLabel fuzz: ${JSON.stringify(s)}`).toBe(botRender.safeLabel(s));
      expect(parseQuantity(s), `quantity fuzz: ${JSON.stringify(s)}`).toEqual(bot.parseQuantity(s));
    }
  });

  it("agrees on every markdown and spoiler character individually", () => {
    // One case per character the strip regexes name, so removing any one from either
    // implementation fails here rather than silently passing.
    for (const char of ["`", "*", "_", "~", "|"]) {
      for (const shape of [
        `${char}carter${char}`,
        `${char}${char}carter${char}${char}`,
        `car${char}ter`,
      ]) {
        expect(normalizeProfile(shape), `profile: ${JSON.stringify(shape)}`).toEqual(
          bot.normalizeProfile(shape),
        );
        expect(normalizeProduct(shape), `product: ${JSON.stringify(shape)}`).toEqual(
          bot.normalizeProduct(shape),
        );
      }
    }
  });

  it("parseQuantity agrees on real and edge-case values", () => {
    const values = [...quantities, "0", "1", "x3", "2 units", "abc", "", undefined, null];
    for (const raw of values) {
      expect(parseQuantity(raw as string), `quantity: ${JSON.stringify(raw)}`).toEqual(
        bot.parseQuantity(raw),
      );
    }
  });

  it("money agrees across the full cent range that matters", () => {
    const values = [0, 1, 50, 99, 100, 200, 250, 725, 800, 1400, 52800, -1, -363, -400];
    for (const cents of values) {
      expect(money(cents), `cents: ${cents}`).toBe(botRender.money(cents));
    }
    // Exhaustive over a realistic bill range, since this is what members read
    for (let cents = 0; cents <= 5000; cents++) {
      expect(money(cents)).toBe(botRender.money(cents));
    }
  });

  it("safeLabel agrees on all real product names plus hostile input", () => {
    for (const raw of [...products, "back`tick", "new\nline", "  padded  ", "a\r\nb"]) {
      expect(safeLabel(raw), `label: ${JSON.stringify(raw)}`).toBe(botRender.safeLabel(raw));
    }
  });

  it("reproduces the real billed totals from the session records", () => {
    // Guards the discount rule against the actual money that was calculated.
    for (const file of readdirSync(SESSION_DIR).filter((f) => f.endsWith(".json"))) {
      const session = JSON.parse(readFileSync(path.join(SESSION_DIR, file), "utf8"));
      for (const bill of Object.values(session.bills ?? {}) as {
        subtotalCents: number;
        isOg: boolean;
        discountCents: number;
        totalCents: number;
      }[]) {
        expect(ogDiscountCents(bill.subtotalCents, bill.isOg)).toBe(bill.discountCents);
        expect(bill.subtotalCents - ogDiscountCents(bill.subtotalCents, bill.isOg)).toBe(
          bill.totalCents,
        );
      }
    }
  });
});

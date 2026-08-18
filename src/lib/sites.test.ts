/**
 * Retailer key normalization.
 *
 * Vendor bots each spell the same store differently, and a key that misses its entry
 * doesn't throw — it silently degrades to a grey "unknown" chip with no logo. That
 * failure is invisible in code review and only shows up as a wrong-looking chip, which
 * is exactly the kind of thing worth pinning down.
 *
 * `src/pas/sites.js` in the bot repo is a port of this and must stay in step.
 */
import { describe, expect, it } from "vitest";
import {
  siteKey,
  siteMonogram,
  siteStyle,
  onTint,
  selfServeSiteKeys,
  supportedSites,
  siteUsesAccounts,
} from "@/lib/sites";

describe("siteKey", () => {
  it("matches the plain retailer names the bots report", () => {
    expect(siteKey("Target")).toBe("target");
    expect(siteKey("Walmart")).toBe("walmart");
  });

  it("strips the US/USA region suffix", () => {
    expect(siteKey("Pokemon Center US")).toBe("pokemon-center");
    expect(siteKey("Best Buy US")).toBe("best-buy");
    expect(siteKey("Best Buy USA")).toBe("best-buy");
  });

  it("handles a bare URL, which is what Hidden puts in its Site field", () => {
    expect(siteKey("https://www.target.com")).toBe("target");
    expect(siteKey("https://www.target.com/p/-/A-1004334525")).toBe("target");
  });

  it("drops apostrophes rather than treating them as separators", () => {
    // Regression: replacing every non-alphanumeric run with a space turned "Sam's Club"
    // into "sam-s-club", which matches no entry and fell through to the unknown chip.
    expect(siteKey("Sam's Club")).toBe("sams-club");
    expect(siteKey("Sam’s Club")).toBe("sams-club"); // curly apostrophe
  });

  it("returns a usable key for a retailer we've never seen", () => {
    expect(siteKey("Some New Store")).toBe("some-new-store");
    expect(siteKey(null)).toBe("unknown");
    expect(siteKey(undefined)).toBe("unknown");
  });
});

describe("siteStyle", () => {
  it("resolves every configured retailer to its logo", () => {
    for (const name of ["Target", "Walmart", "Pokemon Center US", "Best Buy US", "Sam's Club"]) {
      expect(siteStyle(name).logo, `${name} should have a logo`).not.toBe("");
    }
  });

  it("degrades to a labelled neutral chip instead of a broken image", () => {
    const style = siteStyle("Some New Store");
    expect(style.logo).toBe("");
    expect(style.label).toBe("Some New Store");
    expect(siteMonogram(style.label)).toBe("SN");
  });
});

describe("onTint", () => {
  it("picks ink or white per fill, since neither works for all of them", () => {
    // Hardcoding ink fails on Target and Walmart; hardcoding white fails on the yellows.
    expect(onTint("#CC0000")).toBe("#FFFFFF"); // Target red
    expect(onTint("#0071CE")).toBe("#FFFFFF"); // Walmart blue
    expect(onTint("#FFCB05")).toBe("#121212"); // Pokemon Center yellow
    expect(onTint("#FFE000")).toBe("#121212"); // Best Buy yellow
  });
});

describe("selfServeSiteKeys", () => {
  /**
   * The bug this pins: the profiles page built its retailer picker from the retailers a
   * member already had, plus a hardcoded ["target"]. Walmart and Pokemon Center went
   * live and that list was never updated, so a member with no Walmart profile saw no
   * Walmart chip -- and the chip is the only way to add one.
   */
  it("offers the retailers whose bots read stored profiles", () => {
    expect(selfServeSiteKeys().sort()).toEqual(["pokemon-center", "target", "walmart"]);
  });

  it("never goes empty, which would strand every member with no profiles", () => {
    expect(selfServeSiteKeys().length).toBeGreaterThan(0);
  });

  it("only names retailers that actually exist in the registry", () => {
    const known = new Set(supportedSites().map((s) => s.key));
    for (const key of selfServeSiteKeys()) expect(known).toContain(key);
  });
});

describe("siteUsesAccounts", () => {
  /**
   * Pokemon Center checks out as a guest. The form required an account password anyway,
   * so a member could not save a PKC profile at all without inventing a credential that
   * does not exist -- and all 312 imported PKC accounts correctly store none.
   */
  it("is false for guest checkout", () => {
    expect(siteUsesAccounts("pokemon-center")).toBe(false);
  });

  it("is true for retailers with real logins", () => {
    expect(siteUsesAccounts("target")).toBe(true);
    expect(siteUsesAccounts("walmart")).toBe(true);
  });

  it("defaults to true for an unknown retailer", () => {
    // Better to ask for a password that isn't needed than to silently skip one that is.
    expect(siteUsesAccounts("some-new-store")).toBe(true);
  });

  it("accepts the raw vendor spelling, not just the key", () => {
    expect(siteUsesAccounts("Pokemon Center US")).toBe(false);
  });
});

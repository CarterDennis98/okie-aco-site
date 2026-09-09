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
  isKnownSite,
  loginOnlySiteKeys,
  siteChangesApplyImmediately,
  siteKey,
  siteMonogram,
  siteStyle,
  onTint,
  selfServeSiteKeys,
  supportedSites,
  siteRequiresPhone,
  siteUsesAccounts,
  siteUsesProfiles,
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
    for (const name of [
      "Target",
      "Walmart",
      "Pokemon Center US",
      "Best Buy US",
      "Sam's Club",
      "Costco",
    ]) {
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
  it("offers the retailers whose bots read stored credentials", () => {
    expect(selfServeSiteKeys().sort()).toEqual(["costco", "pokemon-center", "target", "walmart"]);
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

describe("siteUsesProfiles", () => {
  /**
   * Costco is login-only: the bot takes queue spots without signing in and the order is
   * placed by hand from the member's own account, so the card and the address live at
   * Costco rather than here. A `vault_profile` row for one would be invented placeholders,
   * and the AYCD export of it would be a file of them.
   */
  it("is false for a login-only retailer", () => {
    expect(siteUsesProfiles("costco")).toBe(false);
  });

  it("is true for retailers we check out on ourselves", () => {
    expect(siteUsesProfiles("target")).toBe(true);
    expect(siteUsesProfiles("walmart")).toBe(true);
    // Guest checkout still needs the whole profile -- no login, but a card and an address.
    expect(siteUsesProfiles("pokemon-center")).toBe(true);
  });

  it("defaults to true for an unknown retailer", () => {
    // The safe direction: a new site treated as login-only would quietly stop collecting
    // the card its bot cannot run without.
    expect(siteUsesProfiles("some-new-store")).toBe(true);
  });

  it("accepts the raw vendor spelling", () => {
    expect(siteUsesProfiles("https://www.costco.com")).toBe(false);
  });
});

describe("usesEmailCodes", () => {
  /**
   * Two different reasons to be false, and the flag has to serve both: Pokemon Center
   * sends no code at all, and Costco is signed into by hand -- the operator can read a
   * code with the member, so a stored app password buys nothing and asking for one is a
   * chore invented for them.
   */
  it("is false where nothing of ours reads the mailbox", () => {
    expect(siteStyle("pokemon-center").usesEmailCodes).toBe(false);
    expect(siteStyle("costco").usesEmailCodes).toBe(false);
  });

  it("is unset -- and therefore true -- where a bot reads the code", () => {
    for (const key of ["target", "walmart", "best-buy", "sams-club"]) {
      expect(siteStyle(key).usesEmailCodes, `${key} should read codes`).not.toBe(false);
    }
  });
});

describe("siteChangesApplyImmediately", () => {
  /**
   * Costco is loaded onto nothing: the operator reads the login at order time, so a saved
   * edit is in use at once and there is nothing for anyone to confirm. Everywhere else a
   * change waits for an export, which is what the member's "pending confirmation" chip and
   * the operator's queue are both about.
   */
  it("is true only where no bot has to be loaded", () => {
    expect(siteChangesApplyImmediately("costco")).toBe(true);
    for (const key of ["target", "walmart", "pokemon-center", "best-buy", "sams-club"]) {
      expect(siteChangesApplyImmediately(key), `${key} must wait`).toBe(false);
    }
  });

  it("is false with no retailer, which is how app-password changes arrive", () => {
    // Those do reach the bot, and they are the ones members most need confirmed.
    expect(siteChangesApplyImmediately(null)).toBe(false);
    expect(siteChangesApplyImmediately(undefined)).toBe(false);
    expect(siteChangesApplyImmediately("")).toBe(false);
  });

  it("defaults to false for an unknown retailer", () => {
    // The safe direction: claiming a change is live when it is sitting in a queue tells a
    // member their new card is in use when it is not.
    expect(siteChangesApplyImmediately("some-new-store")).toBe(false);
  });

  it("accepts the raw vendor spelling", () => {
    expect(siteChangesApplyImmediately("Costco")).toBe(true);
  });
});

describe("loginOnlySiteKeys", () => {
  it("is the complement of siteUsesProfiles, not a second list", () => {
    for (const key of supportedSites().map((s) => s.key)) {
      expect(loginOnlySiteKeys().includes(key)).toBe(!siteUsesProfiles(key));
    }
  });

  /**
   * A site with no profile AND no login would store nothing at all -- the login-only form
   * collects exactly an email and a password, so a retailer flagged both ways would render
   * a form with one field and save a row with no credential in it.
   */
  it("only names retailers that have logins", () => {
    for (const key of loginOnlySiteKeys()) expect(siteUsesAccounts(key)).toBe(true);
  });
});

describe("isKnownSite", () => {
  /**
   * The bug this pins: `saveProfile` and the AYCD import each kept their own hardcoded set
   * of five keys. A retailer added to the table but not to both of them renders a chip the
   * member can fill in and then refuses the save as an "Unknown retailer".
   */
  it("accepts every retailer the picker can offer", () => {
    for (const key of [...selfServeSiteKeys(), ...supportedSites().map((s) => s.key)]) {
      expect(isKnownSite(key), `${key} should be writable`).toBe(true);
    }
  });

  it("normalizes before matching, like every other lookup here", () => {
    expect(isKnownSite("Sam's Club")).toBe(true);
    expect(isKnownSite("Pokemon Center US")).toBe(true);
    expect(isKnownSite("https://www.costco.com")).toBe(true);
  });

  it("rejects anything not in the table", () => {
    // siteStyle answers for every string on purpose, so this cannot be a property probe.
    expect(isKnownSite("some-new-store")).toBe(false);
    expect(isKnownSite("")).toBe(false);
    expect(isKnownSite(null)).toBe(false);
    // Not a key, and not reachable through Object.hasOwn on a plain object literal.
    expect(isKnownSite("toString")).toBe(false);
  });
});

describe("siteRequiresPhone", () => {
  /**
   * Walmart checkout does not complete without a phone number. A profile saved without one
   * exported cleanly and then failed every order, which is invisible until a drop.
   */
  it("is true only for Walmart", () => {
    expect(siteRequiresPhone("walmart")).toBe(true);
    expect(siteRequiresPhone("target")).toBe(false);
    expect(siteRequiresPhone("pokemon-center")).toBe(false);
  });

  it("defaults to false for an unknown retailer", () => {
    // The opposite default from siteUsesAccounts, deliberately: demanding a field a new
    // retailer does not need would block the save outright over an invented rule.
    expect(siteRequiresPhone("some-new-store")).toBe(false);
  });

  it("accepts the raw vendor spelling", () => {
    expect(siteRequiresPhone("https://www.walmart.com")).toBe(true);
  });
});

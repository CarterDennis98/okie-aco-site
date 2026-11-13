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
  groupBySite,
  isKnownSite,
  loginOnlySiteKeys,
  siteChangesApplyImmediately,
  siteKey,
  siteMonogram,
  siteStyle,
  onTint,
  selfServeSiteKeys,
  supportedSites,
  siteBotGeneratesPhone,
  siteFlaggedCancellations,
  siteImportsValor,
  siteMembership,
  siteRequiresPhone,
  siteStoresCardCvv,
  siteStoresPassword,
  siteUsesAccounts,
  siteUsesProfiles,
} from "@/lib/sites";

describe("siteKey", () => {
  it("matches the plain retailer names the bots report", () => {
    expect(siteKey("Target")).toBe("target");
    expect(siteKey("Walmart")).toBe("walmart");
    expect(siteKey("Crunchyroll")).toBe("crunchyroll");
    expect(siteKey("Premium Bandai")).toBe("premium-bandai");
    expect(siteKey("Topps")).toBe("topps");
    expect(siteKey("Mattel")).toBe("mattel");
    expect(siteKey("Menards")).toBe("menards");
    expect(siteKey("Menard's")).toBe("menards");
    expect(siteKey("https://www.menards.com")).toBe("menards");
  });

  /**
   * Valor names Mattel's store "Mattel Creations". Normalized as-is that is its own key, which
   * matches no retailer -- a grey chip, and a checkout the bot bills to the operator instead
   * of chess, whose payee entry is keyed "mattel".
   */
  it("folds a vendor's longer name for a store onto the retailer's key", () => {
    expect(siteKey("Mattel Creations")).toBe("mattel");
    expect(siteKey("mattel creations")).toBe("mattel");
    expect(siteStyle("Mattel Creations").label).toBe("Mattel");
    expect(isKnownSite("Mattel Creations")).toBe(true);
  });

  /**
   * Makebot names each Topps store by its domain. The UK one was aliased by hand and the US
   * one was not, so the 2026-11-04 drop's "shop.topps.com" checkouts normalized to
   * "shop-topps": a grey "S" chip on a drop card of their own, outside CrispHeinz's runner
   * scope, and his fees billed as the operator's. A domain now loses its subdomains instead,
   * so every storefront reaches the retailer without an entry each.
   */
  it("folds a store's subdomain onto the retailer, as Makebot names Topps's stores", () => {
    for (const domain of ["shop.topps.com", "shop-uk.topps.com", "https://shop.topps.com/"]) {
      expect(siteKey(domain), domain).toBe("topps");
      expect(siteStyle(domain).label, domain).toBe("Topps");
      expect(isKnownSite(domain), domain).toBe(true);
    }
    expect(siteKey("shop-uk.topps.com/cart/71615158681853:2?storefront=true")).toBe("topps");
  });

  it("folds only a domain, never a store's name", () => {
    // A name with a space in it is not a domain, wherever the dots are.
    expect(siteKey("Some Shop.Topps.com")).toBe("some-shop-topps");
    // A path is not a subdomain.
    expect(siteKey("https://www.target.com/p/a.b.com")).toBe("target");
  });

  it("never resolves an alias lookup through the object prototype", () => {
    expect(siteKey("toString")).toBe("tostring");
    expect(siteKey("constructor")).toBe("constructor");
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
      "Crunchyroll",
      "Premium Bandai",
      "Topps",
      "Mattel Creations",
      "Menards",
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
    expect(onTint("#FF8D0E")).toBe("#121212"); // Crunchyroll orange
    expect(onTint("#F4C646")).toBe("#121212"); // Premium Bandai gold
    expect(onTint("#D71921")).toBe("#FFFFFF"); // Topps red
    expect(onTint("#E3000B")).toBe("#FFFFFF"); // Mattel red
    expect(onTint("#F58220")).toBe("#121212"); // Menards orange
  });
});

describe("groupBySite", () => {
  const row = (site: string | null, n: number) => ({ site, n });

  /**
   * The bug this pins: the home page split each drop by the raw site string, so the
   * 2026-11-04 Topps drop showed as two cards -- Alpine's "Topps US" and Makebot's
   * "shop.topps.com" -- one of them under a grey chip.
   */
  it("puts every spelling of one retailer in one group", () => {
    const groups = groupBySite([
      row("shop.topps.com", 1),
      row("Topps US", 2),
      row("shop-uk.topps.com", 3),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].key).toBe("topps");
    expect(groups[0].rows.map((r) => r.n)).toEqual([1, 2, 3]);
    // The first row's spelling, which siteStyle reads as Topps like any other.
    expect(groups[0].site).toBe("shop.topps.com");
    expect(siteStyle(groups[0].site).label).toBe("Topps");
  });

  it("keeps different retailers apart, in the order they first appear", () => {
    const groups = groupBySite([
      row("Target", 1),
      row("Walmart", 2),
      row("https://www.target.com", 3),
    ]);
    expect(groups.map((g) => g.key)).toEqual(["target", "walmart"]);
    expect(groups[0].rows.map((r) => r.n)).toEqual([1, 3]);
  });

  it("groups rows with no site together, under no retailer", () => {
    const groups = groupBySite([row(null, 1), row("Target", 2), row("", 3)]);
    expect(groups.map((g) => [g.key, g.site])).toEqual([
      ["", null],
      ["target", "Target"],
    ]);
    expect(groups[0].rows.map((r) => r.n)).toEqual([1, 3]);
  });

  it("returns nothing for nothing", () => {
    expect(groupBySite([])).toEqual([]);
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
    expect(selfServeSiteKeys().sort()).toEqual([
      "costco",
      "crunchyroll",
      "mattel",
      "menards",
      "pokemon-center",
      "premium-bandai",
      "target",
      "topps",
      "walmart",
    ]);
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
    // Menards wants only the email the order goes to.
    expect(siteUsesAccounts("menards")).toBe(false);
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

describe("siteStoresPassword", () => {
  /**
   * Mattel has accounts, but chess's Valor needs only the email one is registered to --
   * so the form asks for no password and the save action keeps none, while the account
   * row (and the profile's 1:1 link to it) stays exactly as it is everywhere else.
   */
  it("is false where only the account's email is needed", () => {
    expect(siteStoresPassword("mattel")).toBe(false);
    expect(siteStoresPassword("Mattel Creations")).toBe(false);
    // Still an account, not guest checkout: the form asks for the account's email.
    expect(siteUsesAccounts("mattel")).toBe(true);
  });

  it("is false with no login at all", () => {
    expect(siteStoresPassword("pokemon-center")).toBe(false);
    expect(siteStoresPassword("menards")).toBe(false);
  });

  it("is true wherever a bot signs in with the password", () => {
    for (const key of [
      "target",
      "walmart",
      "best-buy",
      "sams-club",
      "costco",
      "crunchyroll",
      "premium-bandai",
      "topps",
    ]) {
      expect(siteStoresPassword(key), `${key} keeps its password`).toBe(true);
    }
  });

  it("defaults to true for an unknown retailer", () => {
    // Same direction as siteUsesAccounts: asking for a password that isn't needed beats
    // silently not keeping one the bot signs in with.
    expect(siteStoresPassword("some-new-store")).toBe(true);
  });
});

describe("siteMembership", () => {
  it("is Red Line Club on Mattel, under Valor's name for it too", () => {
    expect(siteMembership("mattel")).toMatchObject({ name: "Red Line Club", short: "RLC" });
    expect(siteMembership("Mattel Creations")?.short).toBe("RLC");
  });

  it("is absent everywhere else, which asks nothing and splits nothing", () => {
    for (const key of supportedSites().map((s) => s.key)) {
      if (key !== "mattel") expect(siteMembership(key), key).toBeNull();
    }
    expect(siteMembership("some-new-store")).toBeNull();
  });

  /**
   * The split is of the PROFILE export -- a login-only retailer has no AYCD file to split,
   * and no exported set its accounts would sort into.
   */
  it("only applies where there are profiles to split", () => {
    for (const key of supportedSites().map((s) => s.key)) {
      if (siteMembership(key)) expect(siteUsesProfiles(key), key).toBe(true);
    }
  });
});

describe("siteUsesProfiles", () => {
  /**
   * Costco was login-only until 2026-11-09: its bot took queue spots without signing in and
   * the order was placed by hand from the member's own account, so the card and the address
   * lived at Costco. Its bot places the whole order now, so it needs both from us -- and a
   * Costco still flagged login-only would refuse every address and card a member typed.
   */
  it("is true on Costco, now that its bot checks out", () => {
    expect(siteUsesProfiles("costco")).toBe(true);
    expect(siteUsesProfiles("https://www.costco.com")).toBe(true);
  });

  it("is true for retailers we check out on ourselves", () => {
    expect(siteUsesProfiles("target")).toBe(true);
    expect(siteUsesProfiles("walmart")).toBe(true);
    // Guest checkout still needs the whole profile -- no login, but a card and an address.
    expect(siteUsesProfiles("pokemon-center")).toBe(true);
  });

  it("names no retailer login-only today", () => {
    // Turning one back on is a deliberate edit to sites.ts, and should be one to this too.
    expect(loginOnlySiteKeys()).toEqual([]);
  });

  it("defaults to true for an unknown retailer", () => {
    // The safe direction: a new site treated as login-only would quietly stop collecting
    // the card its bot cannot run without.
    expect(siteUsesProfiles("some-new-store")).toBe(true);
  });
});

describe("usesEmailCodes", () => {
  /**
   * Two different reasons to be false, and the flag has to serve both: Pokemon Center and
   * Menards send no code at all, and the Crunchyroll, Premium Bandai, Mattel and Costco bots
   * have a login but never open the inbox. Costco's reason used to be that it was signed
   * into by hand; it kept the flag when its bot took over the checkout, because nothing
   * reads a Costco code yet.
   */
  it("is false where nothing of ours reads the mailbox", () => {
    expect(siteStyle("pokemon-center").usesEmailCodes).toBe(false);
    expect(siteStyle("costco").usesEmailCodes).toBe(false);
    expect(siteStyle("crunchyroll").usesEmailCodes).toBe(false);
    expect(siteStyle("premium-bandai").usesEmailCodes).toBe(false);
    expect(siteStyle("Mattel Creations").usesEmailCodes).toBe(false);
    expect(siteStyle("menards").usesEmailCodes).toBe(false);
  });

  it("is unset -- and therefore true -- where a bot reads the code", () => {
    // Topps: Alpine reads the code Topps emails at login.
    for (const key of ["target", "walmart", "best-buy", "sams-club", "topps"]) {
      expect(siteStyle(key).usesEmailCodes, `${key} should read codes`).not.toBe(false);
    }
  });
});

describe("siteStoresCardCvv", () => {
  /**
   * For a login-only retailer that asks for the security code at checkout even on a card
   * already saved to the account. Costco was that retailer until 2026-11-09; its profiles
   * carry a whole card now, CVV included, so a code on the login as well would be a second
   * copy nothing reads.
   */
  it("is false everywhere since Costco took full profiles", () => {
    for (const key of [
      "costco",
      "https://www.costco.com",
      "target",
      "walmart",
      "pokemon-center",
      "best-buy",
      "sams-club",
      "crunchyroll",
      "premium-bandai",
      "topps",
      "mattel",
      "menards",
    ]) {
      expect(siteStoresCardCvv(key), `${key} stores no account CVV`).toBe(false);
    }
  });

  it("defaults to false for an unknown retailer", () => {
    // The safe direction by a wide margin: asking every new retailer for a card code we
    // have no use for is the one default that cannot be undone once members have typed it.
    expect(siteStoresCardCvv("some-new-store")).toBe(false);
    expect(siteStoresCardCvv(null)).toBe(false);
  });

  /**
   * A code on a site we hold full profiles for would be the SECOND place a CVV lives for
   * the same member, with nothing keeping the two in step. The profile's own card owns
   * that field; this flag is for retailers where no card is stored at all.
   */
  it("only ever applies to a login-only retailer", () => {
    for (const key of supportedSites().map((s) => s.key)) {
      if (siteStoresCardCvv(key)) expect(siteUsesProfiles(key)).toBe(false);
    }
  });
});

describe("siteChangesApplyImmediately", () => {
  /**
   * For a retailer loaded onto nothing, where the operator reads the login at order time: a
   * saved edit is in use at once and there is nothing for anyone to confirm. Costco was that
   * retailer until 2026-11-09. Its bot loads exported profiles now, so a Costco edit waits
   * for an export like every other -- which is what the member's "pending confirmation" chip
   * and the runner's queue are both about.
   */
  it("is false everywhere a bot loads the export, which is everywhere today", () => {
    for (const key of [
      "costco",
      "Costco",
      "target",
      "walmart",
      "pokemon-center",
      "best-buy",
      "sams-club",
      "crunchyroll",
      "premium-bandai",
      "topps",
      "mattel",
      "menards",
    ]) {
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
    // Profiled like Target: optional, with the die, and filled in on export if left blank.
    expect(siteRequiresPhone("crunchyroll")).toBe(false);
    expect(siteRequiresPhone("premium-bandai")).toBe(false);
    expect(siteRequiresPhone("topps")).toBe(false);
    expect(siteRequiresPhone("mattel")).toBe(false);
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

describe("siteBotGeneratesPhone", () => {
  /**
   * The bug this pins: the export wrote Valor's "0" for a missing phone on EVERY retailer,
   * so a Target profile saved without one reached a bot that isn't Valor with "0" as its
   * phone number. Only Valor reads that as "make one up".
   */
  it("is true only on the retailers Valor runs", () => {
    expect(siteBotGeneratesPhone("pokemon-center")).toBe(true);
    expect(siteBotGeneratesPhone("best-buy")).toBe(true);
    // chess's Valor, not the operator's -- the convention is the bot's, whoever runs it.
    expect(siteBotGeneratesPhone("mattel")).toBe(true);
    for (const key of [
      "target",
      "crunchyroll",
      "premium-bandai",
      "topps",
      "walmart",
      "sams-club",
      // Not known to be Valor, so a missing phone exports as a generated number, which
      // works on Valor too.
      "menards",
    ]) {
      expect(siteBotGeneratesPhone(key), `${key} needs a real number`).toBe(false);
    }
  });

  it("defaults to false for an unknown retailer", () => {
    // The direction that works on any bot: a generated number imports on Valor too, while
    // a "0" anywhere else is a phone number that isn't one.
    expect(siteBotGeneratesPhone("some-new-store")).toBe(false);
    expect(siteBotGeneratesPhone(null)).toBe(false);
  });

  it("accepts the raw vendor spelling", () => {
    expect(siteBotGeneratesPhone("Pokemon Center US")).toBe(true);
    expect(siteBotGeneratesPhone("Best Buy USA")).toBe(true);
    expect(siteBotGeneratesPhone("Mattel Creations")).toBe(true);
  });
});

describe("siteImportsValor", () => {
  /**
   * Where a member may upload Valor's own profile file. Pokémon Center only: it is where
   * members run their own Valor. Best Buy and Mattel are Valor too, but nobody's file from
   * either has been checked, so they stay AYCD-only until someone asks.
   */
  it("is true only on Pokémon Center", () => {
    expect(siteImportsValor("pokemon-center")).toBe(true);
    for (const site of supportedSites().filter((s) => s.key !== "pokemon-center")) {
      expect(siteImportsValor(site.key), `${site.key} takes AYCD only`).toBe(false);
    }
  });

  it("only applies where there are profiles to import", () => {
    for (const site of supportedSites().filter((s) => siteImportsValor(s.key))) {
      expect(siteUsesProfiles(site.key), site.key).toBe(true);
    }
  });

  it("defaults to false for an unknown retailer", () => {
    expect(siteImportsValor("some-new-store")).toBe(false);
    expect(siteImportsValor(null)).toBe(false);
  });

  it("accepts the raw vendor spelling", () => {
    expect(siteImportsValor("Pokemon Center US")).toBe(true);
  });
});

describe("siteFlaggedCancellations", () => {
  it("flags only Target's Item Demand and Reseller cancels, never Quantity Limit", () => {
    expect(siteFlaggedCancellations("target")).toEqual(["item demand", "reseller"]);
    expect(siteFlaggedCancellations("Target")).toEqual(["item demand", "reseller"]);
    expect(siteFlaggedCancellations("target")).not.toContain("quantity limit");
  });

  it("leaves every other retailer flagging on every failure, a new one included", () => {
    for (const key of ["walmart", "pokemon-center", "topps", "costco", "crunchyroll"]) {
      expect(siteFlaggedCancellations(key)).toBeNull();
    }
    expect(siteFlaggedCancellations("Some New Store")).toBeNull();
  });

  it("is never an empty list, and every policy in one is lowercase", () => {
    // Empty would stop every cancellation on the retailer flagging -- unset is how to say "all".
    for (const site of supportedSites()) {
      const policies = site.flaggedCancellations;
      if (policies === undefined) continue;
      expect(policies.length, site.key).toBeGreaterThan(0);
      for (const policy of policies) expect(policy).toBe(policy.toLowerCase().trim());
    }
  });
});

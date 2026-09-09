/**
 * Per-retailer chip styling and the supported-sites list.
 *
 * Colour is deliberately NOT the identity channel. Validated against the dataviz six
 * checks on the chip surface (#2D2D2D, dark mode):
 *
 *   - Target #CC0000 sits ΔE 4.9 from Okie's own brand red #E30613 under normal
 *     vision — below the 15 floor, i.e. genuinely hard to tell apart.
 *   - Costco #E31837 is a third red: ΔE2000 7.3 from #E30613 and 10.6 from Target's
 *     #CC0000, measured on the raw tints. Below floor against both, so red now marks
 *     the brand, one retailer we ship to, and another we only hold logins for.
 *   - Pokémon Center yellow and Best Buy yellow are ΔE 10.6 apart. Also below floor.
 *   - Walmart and Sam's Club are both corporate blue, and deliberately so.
 *   - Target red (2.34:1) and Walmart blue (2.79:1) don't even clear 3:1 as UI shapes
 *     on a dark surface, so they can't be chip fills or chip text.
 *
 * No arrangement of these hues passes. The LOGO and the site NAME carry identity; the
 * tint is decorative reinforcement used at low alpha behind readable text, so it gates
 * nothing.
 */

export type SiteStyle = {
  key: string;
  label: string;
  /** Decorative tint, applied at low alpha. Never the sole identity channel. */
  tint: string;
  logo: string;
  /** Intrinsic size, so next/image gets the aspect right. These vary a lot -- Target
   *  is square, Walmart and Sam's Club are 16:9 -- which is why logos sit in a
   *  rounded rectangle with object-contain rather than a circle that would crop them. */
  width: number;
  height: number;
  /**
   * Whether the mark needs a light tile behind it.
   *
   * Measured by compositing each logo over the dark surface (#1F1F1F) and counting
   * pixels below 3:1. Target 0.3%, Walmart 0.0%, Best Buy 1.0% -- all fine bare.
   * Sam's Club is 100%: a monochrome dark mark that disappears entirely, and it hits
   * 0% on white, so it gets a tile.
   *
   * Pokémon Center measures ~38% on dark but ~43% on white -- it is a multi-tone
   * colour mark, and per-pixel 3:1 is a UI-shape rule that doesn't apply to a picture.
   * It reads fine bare, so no tile.
   */
  needsLightBacking?: boolean;
  /**
   * How many of a member's profiles the main bot runs for this retailer.
   *
   * A SOFT cap, not a limit: profiles beyond it still work, they just run on a backup
   * bot instance. Nothing blocks a member from adding more, so this only ever changes
   * what the UI tells them and how an export is split. `undefined` means unlimited.
   *
   * Counted across ACTIVE profiles in name order -- a disabled profile isn't running,
   * so it shouldn't hold a slot on the main bot.
   */
  profileSoftCap?: number;

  /**
   * Whether WE need to read an emailed verification code here.
   *
   * Two different reasons it can be false, and both end in the same place -- no app
   * password is wanted, so nothing should nag a member for one:
   *
   *   - Pokémon Center checks out as a guest. There is no login, so no code is ever sent
   *     and an app password would do nothing.
   *   - Costco is signed into BY HAND. If Costco asks for a code, the operator is sitting
   *     at the login and can read it out of the member's inbox with them -- there is no
   *     bot mid-drop that has to open the mailbox unattended, which is the only thing a
   *     stored app password buys.
   *
   * Defaults to true: a new retailer almost certainly mails a code to something automated,
   * and being nagged about a password you don't need is a smaller failure than silently
   * not asking for one you do.
   */
  usesEmailCodes?: boolean;

  /**
   * Whether a login here carries the card's security code.
   *
   * Costco prompts for the CVV at checkout even when the card on the account is already
   * saved -- not every time, which is exactly what makes a missing one expensive: it
   * surfaces mid-order, by hand, with a queue pass running down. Nothing else about the
   * card is stored for such a retailer, because nothing else has to be; the member's own
   * account supplies the number, the expiry and the address, and this is the one field it
   * cannot fill in for them.
   *
   * The code is 3 digits, or 4 on Amex -- and unlike a profile, there is no card number
   * here to detect the brand from, so both lengths are accepted. See `isPlausibleCvv`.
   *
   * Defaults to false. Somewhere between "PCI says don't store this" and "the order fails
   * without it" there is a line, and it is drawn per retailer that genuinely asks rather
   * than collected everywhere by default.
   */
  storesCardCvv?: boolean;

  /**
   * Whether an edit here is live the moment it is saved.
   *
   * Everywhere else a change has to be exported and loaded onto a bot before it takes
   * effect, which is what `VaultChange.appliedAt` records and what the member's "pending
   * confirmation" chip is about. Costco has no such step: nothing loads these credentials
   * anywhere, and the operator reads the login at order time, so an edit is in use as soon
   * as it is written and there is nothing for anyone to confirm.
   *
   * Changes on such a retailer are stamped applied on arrival -- see recordChange. They
   * still notify, because a new signup is worth knowing about; they just never sit in the
   * operator's queue asking to be actioned.
   *
   * Defaults to false, which is the safe direction: a retailer wrongly marked this way
   * would tell a member their new card was in use while it sat in a queue nobody was
   * looking at any more.
   */
  changesApplyImmediately?: boolean;

  /**
   * Whether a member can add their FIRST profile here on their own.
   *
   * The retailer picker is built from the retailers a member already has profiles on.
   * That alone is circular -- with no Walmart profile there is no Walmart chip, and no
   * chip means no way to create one. So every retailer flagged here is offered whether
   * or not they have anything on it yet.
   *
   * Deliberately NOT every retailer in this table. `supportedSites()` is the public
   * "we check out here" list, which runs ahead of what the bots actually load stored
   * profiles for; offering one of those would invite a member to type card details that
   * nothing reads yet. Turn this on for a retailer when its bot genuinely consumes the
   * vault -- that is the same moment the chip should appear.
   */
  selfServe?: boolean;

  /**
   * Whether checking out here needs a retailer login at all.
   *
   * Pokémon Center checks out as a GUEST: there is no account, so there is no password
   * to store and asking for one invents a credential that does not exist. The account
   * row still exists for those profiles -- it carries the email and holds the 1:1 link
   * -- it just has a null `passwordEnc`, which the schema documents as "no login" rather
   * than "password unknown".
   *
   * Defaults to true, matching `usesEmailCodes`: a new retailer almost certainly has
   * logins, and being asked for a password you have is a smaller failure than being
   * unable to save a profile because the form demands one you don't.
   */
  usesAccounts?: boolean;

  /**
   * Whether we hold a full checkout profile here, or only a login.
   *
   * Costco is the first retailer where the answer is no, and the reason is how its bot
   * works: it takes spots in the queue without signing in, and once a queue pass lands the
   * order is placed BY HAND from the member's own account. The card and the address come
   * from what the member has saved at Costco, so this site never sees either -- there is
   * nothing to encrypt, nothing to export as AYCD, and no address for a `vault_profile`
   * row to carry.
   *
   * A login-only retailer stores exactly one row per member per login: a `vault_account`
   * with no `vault_profile` behind it. That shape was already legal -- `VaultProfile` is
   * optional on the account, and 11 accounts in the original import have no profile -- so
   * nothing about the schema had to change to admit one.
   *
   * Defaults to true, and every other retailer relies on that: a new site that checks out
   * for us needs the whole profile, and a retailer wrongly treated as login-only would
   * quietly stop collecting the card its bot cannot run without.
   *
   * Implies `usesAccounts`: a site with no profile AND no login would store nothing at
   * all. Pinned by a test rather than expressed in the type, because the two flags are
   * independent facts that happen to constrain each other.
   */
  usesProfiles?: boolean;

  /**
   * Whether a profile here is unusable without a phone number.
   *
   * Walmart's checkout will not complete without one. `phone` is nullable and the AYCD
   * export writes a missing one as `""`, so a Walmart profile saved without it exports
   * cleanly, loads into the bot, and then fails every order -- silently, and only during
   * a drop. Required at the form and in the save action, not just hinted at.
   *
   * Defaults to false: everywhere else a phone is useful and not load-bearing, and
   * blocking a save over a field the retailer doesn't need would be inventing a rule.
   */
  requiresPhone?: boolean;
};

const SITES: Record<string, Omit<SiteStyle, "key">> = {
  target: {
    label: "Target",
    tint: "#CC0000",
    logo: "/target-logo.png",
    width: 5400,
    height: 5400,
    profileSoftCap: 5,
    selfServe: true,
  },
  walmart: {
    label: "Walmart",
    tint: "#0071CE",
    logo: "/walmart-logo.png",
    width: 3840,
    height: 2160,
    selfServe: true,
    // Checkout does not complete without one. See requiresPhone.
    requiresPhone: true,
  },
  "pokemon-center": {
    label: "Pokémon Center",
    tint: "#FFCB05",
    logo: "/pokemon-center-logo.png",
    width: 897,
    height: 900,
    profileSoftCap: 10,
    // Guest checkout: no account, so no password and no verification code to read.
    usesAccounts: false,
    usesEmailCodes: false,
    selfServe: true,
  },
  "best-buy": {
    label: "Best Buy",
    tint: "#FFE000",
    logo: "/best-buy-logo.png",
    width: 1573,
    height: 1008,
  },
  "sams-club": {
    label: "Sam's Club",
    tint: "#0067A0",
    logo: "/sams-club-logo.png",
    width: 3840,
    height: 2160,
    needsLightBacking: true,
  },
  costco: {
    label: "Costco",
    tint: "#E31837",
    logo: "/costco-logo.png",
    width: 1571,
    height: 1519,
    // No tile: the mark measures 0.2% of pixels below 3:1 on the dark surface and 31.9%
    // on white -- the counter of the C is opaque white, so a white plate is the one
    // backing that would eat half of it.
    //
    // Login only. See usesProfiles: the order is placed by hand from the member's own
    // Costco account, so we hold the credentials and nothing else.
    usesProfiles: false,
    // Nothing here reads a mailbox unattended -- the operator is at the login when a code
    // is needed -- so an app password buys nothing and asking for one is a chore invented
    // for a member. See usesEmailCodes.
    usesEmailCodes: false,
    // Costco asks for the security code at checkout even on a card it already has saved.
    // See storesCardCvv.
    storesCardCvv: true,
    // No bot loads these, so there is no gap between saving and being in use, and nothing
    // for the operator to confirm. See changesApplyImmediately.
    changesApplyImmediately: true,
    selfServe: true,
  },
};

/** Every retailer we can check out on, for the supported-sites section. */
export function supportedSites(): SiteStyle[] {
  return Object.entries(SITES).map(([key, value]) => ({ key, ...value }));
}

/**
 * Whether this is a retailer we know about at all.
 *
 * THE ONE ALLOWLIST every write path checks. `saveProfile` and the AYCD import each kept
 * their own hardcoded `Set` of five keys, which is the shape of duplication this file
 * exists to avoid: adding Costco to the table would have left both of them rejecting it,
 * and the failure is a member being told "Unknown retailer" about a chip the same code
 * had just rendered for them.
 *
 * Deliberately NOT `siteStyle(site).logo !== ""` or any other property probe --
 * `siteStyle` answers for every string on purpose, so a probe would accept anything.
 */
export function isKnownSite(site: string | null | undefined): boolean {
  return Object.hasOwn(SITES, siteKey(site));
}

/**
 * Whether this retailer has logins, and therefore passwords.
 *
 * Read by BOTH the profile form and the save action. The action is the one that
 * matters -- the form only decides what to render, and a crafted POST doesn't care.
 */
export function siteUsesAccounts(site: string | null | undefined): boolean {
  return siteStyle(site).usesAccounts !== false;
}

/**
 * Whether this retailer stores a full checkout profile, or only a login.
 *
 * Read by every surface that assumes a card and an address exist: the member's profile
 * form and save action, the AYCD export and import, and the admin table. See
 * `usesProfiles` for what a login-only retailer stores instead.
 */
export function siteUsesProfiles(site: string | null | undefined): boolean {
  return siteStyle(site).usesProfiles !== false;
}

/**
 * Whether a login on this retailer carries the card's security code.
 *
 * Read by BOTH the login form and the save action, for the reason every other flag here
 * says twice: the form decides what to render, and the action is the one a crafted POST
 * has to get past. See `storesCardCvv`.
 */
export function siteStoresCardCvv(site: string | null | undefined): boolean {
  return siteStyle(site).storesCardCvv === true;
}

/**
 * Whether a change on this retailer is in use the moment it is saved.
 *
 * Read by `recordChange`, which stamps such a change applied on arrival rather than
 * leaving it in the operator's queue. Declared on the retailer rather than passed in by
 * each caller so a new write path cannot forget it -- see `changesApplyImmediately`.
 *
 * A null site (an app password, a forwarding rule) is NOT immediate: those do reach the
 * bot, and they are the changes members most need to see confirmed.
 */
export function siteChangesApplyImmediately(site: string | null | undefined): boolean {
  if (!site) return false;
  return siteStyle(site).changesApplyImmediately === true;
}

/**
 * Whether a profile on this retailer must carry a phone number.
 *
 * Read by BOTH the profile form and the save action, for the same reason as
 * `siteUsesAccounts`: the form decides what to render, the action is what actually holds.
 */
export function siteRequiresPhone(site: string | null | undefined): boolean {
  return siteStyle(site).requiresPhone === true;
}

/**
 * Retailers to offer a member who has no profile there yet.
 *
 * Read by the profiles page so the retailer picker is never limited to what a member
 * already owns. Declared on the retailer itself rather than listed in the page, so
 * bringing one online is a single edit next to its label instead of a second list
 * somewhere else that quietly falls out of step.
 */
export function selfServeSiteKeys(): string[] {
  return Object.entries(SITES)
    .filter(([, value]) => value.selfServe)
    .map(([key]) => key);
}

/**
 * Retailers where we hold a login and nothing else.
 *
 * The complement of "has profiles", derived from the same flag rather than listed
 * separately, so a retailer cannot end up in one list and not the other. Read by the
 * queries that go looking for accounts with no profile behind them.
 */
export function loginOnlySiteKeys(): string[] {
  return Object.entries(SITES)
    .filter(([, value]) => value.usesProfiles === false)
    .map(([key]) => key);
}

/**
 * Vendor bots spell the same retailer differently ("Pokemon Center US" vs
 * "Pokemon Center", "https://www.target.com" from Hidden's Site field), so match on a
 * normalized key rather than the raw string.
 */
export function siteKey(site: string | null | undefined): string {
  if (!site) return "unknown";
  return (
    String(site)
      .toLowerCase()
      .replace(/^https?:\/\//, "")
      .replace(/^www\./, "")
      .replace(/\.(com|net|org)\b.*$/, "")
      // Apostrophes are dropped, not treated as separators: "Sam's Club" has to reach
      // "sams-club", and turning the apostrophe into a space yields "sam-s-club", which
      // matches no entry and silently falls through to the unknown-retailer chip.
      .replace(/['’]/g, "")
      .replace(/[^a-z0-9]+/g, " ")
      .trim()
      .replace(/\s+(us|usa)$/, "")
      .trim()
      .replace(/\s+/g, "-")
  );
}

export function siteStyle(site: string | null | undefined): SiteStyle {
  const key = siteKey(site);
  const known = SITES[key];
  if (known) return { key, ...known };

  // Unknown retailer: neutral chip, still labelled. New sites appear without warning
  // when a vendor bot adds one, and that must never render as a broken image.
  return { key, label: site ?? "Unknown", tint: "#A6A6A6", logo: "", width: 1, height: 1 };
}

/** First letter of each word, max 2 — the fallback when no logo file exists. */
export function siteMonogram(label: string): string {
  return label
    .split(/\s+/)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? "")
    .join("");
}

/**
 * Ink or white for a label sitting INSIDE a coloured fill, chosen by the fill's
 * luminance. Measured on the actual tints: hardcoding ink would fail on Target
 * (3.18:1) and Walmart (3.79:1), while white fails on both yellows (1.5:1, 1.3:1).
 * Picking per-fill clears 4.5:1 on all of them.
 */
export function onTint(hex: string): "#121212" | "#FFFFFF" {
  const rgb = hex.replace("#", "");
  const channel = (i: number) => {
    const v = parseInt(rgb.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  const luminance = 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
  // Cross-over is where contrast against black and white are equal.
  return luminance > 0.179 ? "#121212" : "#FFFFFF";
}

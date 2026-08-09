/**
 * Per-retailer chip styling and the supported-sites list.
 *
 * Colour is deliberately NOT the identity channel. Validated against the dataviz six
 * checks on the chip surface (#2D2D2D, dark mode):
 *
 *   - Target #CC0000 sits ΔE 4.9 from Okie's own brand red #E30613 under normal
 *     vision — below the 15 floor, i.e. genuinely hard to tell apart.
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
};

const SITES: Record<string, Omit<SiteStyle, "key">> = {
  target: {
    label: "Target",
    tint: "#CC0000",
    logo: "/target-logo.png",
    width: 5400,
    height: 5400,
  },
  walmart: {
    label: "Walmart",
    tint: "#0071CE",
    logo: "/walmart-logo.png",
    width: 3840,
    height: 2160,
  },
  "pokemon-center": {
    label: "Pokémon Center",
    tint: "#FFCB05",
    logo: "/pokemon-center-logo.png",
    width: 897,
    height: 900,
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
};

/** Every retailer we can check out on, for the supported-sites section. */
export function supportedSites(): SiteStyle[] {
  return Object.entries(SITES).map(([key, value]) => ({ key, ...value }));
}

/**
 * Vendor bots spell the same retailer differently ("Pokemon Center US" vs
 * "Pokemon Center", "https://www.target.com" from Hidden's Site field), so match on a
 * normalized key rather than the raw string.
 */
export function siteKey(site: string | null | undefined): string {
  if (!site) return "unknown";
  return String(site)
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\.(com|net|org)\b.*$/, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+(us|usa)$/, "")
    .trim()
    .replace(/\s+/g, "-");
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

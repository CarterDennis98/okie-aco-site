import { parseCents } from "@/lib/money";

/**
 * What the operator types into "Add product", checked.
 *
 * Pure, and shared: the dialog runs it to show a problem before anything is sent, and the
 * Server Action runs it again on what actually arrived, since a crafted POST skips the form.
 */

/**
 * Target product URLs carry the TCIN in a trailing "A-<digits>" segment:
 *   https://www.target.com/p/some-product-slug/-/A-1004334525?preselect=123#lnk=sametab
 *
 * Ported from the bot's own reader (okie-aco-mirror/src/drops/reactions.js), which is what
 * pulled SKUs out of the drop channel before this page existed -- kept in step with it, so
 * a link that worked there works here.
 */
const TARGET_SKU_RE = /^https?:\/\/(?:www\.)?target\.com\/[^\s<>()[\]"'|]*?\bA-(\d{5,})/i;

/** The TCIN in a Target product link, or null when there isn't one. */
export function targetSku(url: string): string | null {
  return TARGET_SKU_RE.exec(url.trim())?.[1] ?? null;
}

/**
 * A readable name from a Target link's slug, for pre-filling the name field:
 * ".../p/pokemon-trading-card-game-elite-trainer-box/-/A-95082118" -> "Pokemon Trading Card
 * Game Elite Trainer Box". A starting point to correct, never stored without being shown.
 */
export function nameFromTargetUrl(url: string): string {
  const slug = /target\.com\/p\/([^/?#]+)/i.exec(url)?.[1] ?? "";
  return (
    decodeURIComponent(slug)
      // Target writes the title's "é" as its character code between dashes, so "Pokémon"
      // is "pok-233-mon" and would come out as "Pok 233 Mon". Only that word: in general a
      // 233 between two words is just a number ("pokemon-233-card-binder").
      .replace(/\bpok-233-mon/gi, "pokémon")
      .split("-")
      .filter(Boolean)
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(" ")
  );
}

export const SET_NAME_LIMIT = 80;
export const PRODUCT_NAME_LIMIT = 120;

export type ProductInput = {
  setName: string;
  name: string;
  url: string;
  sku: string;
  priceCents: number | null;
  imageUrl: string | null;
};

export type ProductFields = {
  setName: string;
  name: string;
  url: string;
  sku: string;
  price: string;
  imageUrl: string;
};

function httpsUrl(raw: string): URL | null {
  try {
    const url = new URL(raw.trim());
    return url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

/** A set name as stored: spaces collapsed, so " Phantasmal  Flames" is the set it looks like. */
export function parseSetName(
  raw: string,
): { ok: true; value: string } | { ok: false; error: string } {
  const value = raw.trim().replace(/\s+/g, " ");
  if (!value) return { ok: false, error: "Which set is it in?" };
  if (value.length > SET_NAME_LIMIT) return { ok: false, error: "That set name is too long." };
  return { ok: true, value };
}

/** One product found in pasted text: its link, what the link says, and a price beside it. */
export type PastedProduct = { url: string; sku: string; name: string; price: string };

/**
 * Every Target product link in a paste -- a list, a drop announcement, links run together --
 * in the order they appear, each with what its link says: the TCIN and a name from the slug.
 *
 * A price on the same line is picked up when the line has one link to give it to, so
 * "Elite Trainer Box $49.99 https://…" fills the price too. Only a "$" amount or one with
 * cents counts: the bare numbers in a product name ("151") never do. Lines with no Target
 * link come back in `skipped`, to be said back to the admin rather than silently dropped.
 */
export function parsePastedLinks(text: string): { products: PastedProduct[]; skipped: string[] } {
  // Up to whitespace, a quote or bracket, or the next link: links pasted with nothing
  // between them come apart into two.
  const LINK_RE = /https?:\/\/(?:www\.)?target\.com\/(?:(?!https?:\/\/)[^\s<>"'|])+/gi;
  const products: PastedProduct[] = [];
  const skipped: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    // Chat punctuation after a link isn't part of it: "(…/A-95082118)."
    const links = (line.match(LINK_RE) ?? []).map((link) => link.replace(/[),.;!]+$/, ""));
    if (links.length === 0) {
      skipped.push(line);
      continue;
    }
    const rest = links.reduce((left, link) => left.replace(link, " "), line);
    const price =
      links.length === 1
        ? (/\$\s?\d{1,5}(?:\.\d{1,2})?/.exec(rest)?.[0] ??
          /\b\d{1,5}\.\d{2}\b/.exec(rest)?.[0] ??
          "")
        : "";
    for (const url of links) {
      products.push({ url, sku: targetSku(url) ?? "", name: nameFromTargetUrl(url), price });
    }
  }
  return { products, skipped };
}

/**
 * The product, or the first thing wrong with it.
 *
 * The SKU can be left blank -- it comes out of the link -- but when both are given they must
 * agree: a link to one product with another's TCIN would show members one thing and watch
 * for another, and nobody would notice until the wrong item checked out.
 */
export function parseProductInput(
  fields: ProductFields,
): { ok: true; value: ProductInput } | { ok: false; error: string } {
  const set = parseSetName(fields.setName);
  if (!set.ok) return set;
  const setName = set.value;

  const url = httpsUrl(fields.url);
  if (!url || !/^(www\.)?target\.com$/i.test(url.hostname)) {
    return { ok: false, error: "Paste the product's target.com link." };
  }
  // A path may legally hold "https://", so a link pasted onto the end of another parses as
  // one URL -- and would show members a broken link. Never a real product URL.
  if (fields.url.split("://").length > 2) {
    return { ok: false, error: "That looks like two links pasted together." };
  }
  const fromUrl = targetSku(url.href);
  // A product with variants links the parent and preselects the child; either TCIN is one
  // the link really shows.
  const preselect = url.searchParams.get("preselect");
  const typed = fields.sku.trim();
  if (typed && !/^\d{5,12}$/.test(typed)) return { ok: false, error: "A TCIN is digits only." };
  if (typed && fromUrl && typed !== fromUrl && typed !== preselect) {
    return { ok: false, error: `That SKU doesn't match the link, which is A-${fromUrl}.` };
  }
  const sku = typed || fromUrl;
  if (!sku) return { ok: false, error: "No SKU in that link — type the TCIN." };

  const name = (fields.name.trim() || nameFromTargetUrl(url.href)).replace(/\s+/g, " ");
  if (!name) return { ok: false, error: "Give it a name." };
  if (name.length > PRODUCT_NAME_LIMIT) return { ok: false, error: "That name is too long." };

  let priceCents: number | null = null;
  if (fields.price.trim()) {
    priceCents = parseCents(fields.price);
    if (priceCents === null || priceCents === 0)
      return { ok: false, error: "That price isn't a number." };
  }

  let imageUrl: string | null = null;
  if (fields.imageUrl.trim()) {
    const image = httpsUrl(fields.imageUrl);
    if (!image) return { ok: false, error: "The image needs an https:// link." };
    imageUrl = image.href;
  }

  // Tracking params and fragments trimmed: the link is shown to members, and the copy they
  // click should be the product page, not someone's campaign. `preselect` stays -- it is
  // which variant the page opens on.
  url.hash = "";
  url.search = preselect ? `?preselect=${encodeURIComponent(preselect)}` : "";
  return { ok: true, value: { setName, name, url: url.href, sku, priceCents, imageUrl } };
}

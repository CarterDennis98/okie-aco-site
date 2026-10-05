/**
 * How Target Products orders what it lists. Pure, so the page, the editors and the tests all
 * sort by the one rule.
 *
 *   - Sets: as an admin arranged them (DropSet). A set not placed yet is new, and goes above
 *     the placed ones, newest first among themselves -- the drop coming up sits at the top
 *     until someone puts it somewhere else.
 *   - Within a set: as an admin arranged it in the set editor (`sortOrder`), and among
 *     equals -- a product restored from retirement, say -- the older first.
 *
 * Display only. Exports watch products in the order they were added (getCatalog), so that
 * arranging never reshuffles the lists in a backup.
 */

type Listed = { setName: string; sortOrder: number; createdAt: Date | string };

const time = (value: Date | string) => new Date(value).getTime();

/** Compare two products of one set by where they sit in it. */
export function bySetOrder(a: Listed, b: Listed): number {
  return a.sortOrder - b.sortOrder || time(a.createdAt) - time(b.createdAt);
}

/** Lowercased with accents taken off, so "pokemon" finds "Pokémon". */
const fold = (text: string) => text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

/** A search box's text as the words to find: "Pokémon  ETB" -> ["pokemon", "etb"]. */
export function searchTerms(query: string): string[] {
  return fold(query).split(/\s+/).filter(Boolean);
}

/** Whether a product has every word somewhere in its name, SKU or set. */
export function matchesSearch(
  product: { name: string; sku: string; setName: string },
  terms: string[],
): boolean {
  const haystack = fold(`${product.name} ${product.sku} ${product.setName}`);
  return terms.every((term) => haystack.includes(term));
}

/** Groups narrowed to what a search finds, dropping a set with nothing left. No words, no narrowing. */
export function searchGroups<T extends { name: string; sku: string; setName: string }>(
  groups: { setName: string; products: T[] }[],
  terms: string[],
): { setName: string; products: T[] }[] {
  if (terms.length === 0) return groups;
  return groups
    .map((group) => ({ ...group, products: group.products.filter((p) => matchesSearch(p, terms)) }))
    .filter((group) => group.products.length > 0);
}

/**
 * Products grouped under their sets, sets and products each in page order. `setOrder` is the
 * sets' names as arranged; a set it doesn't name hasn't been placed yet.
 */
export function groupBySet<T extends Listed>(
  products: T[],
  setOrder: string[] = [],
): { setName: string; products: T[] }[] {
  const sets = new Map<string, T[]>();
  for (const product of products) {
    const list = sets.get(product.setName);
    if (list) list.push(product);
    else sets.set(product.setName, [product]);
  }
  const place = new Map(setOrder.map((name, index) => [name, index]));
  const newest = (list: T[]) => Math.max(...list.map((p) => time(p.createdAt)));
  return [...sets.entries()]
    .map(([setName, list]) => ({ setName, products: [...list].sort(bySetOrder) }))
    .sort((a, b) => {
      const [pa, pb] = [place.get(a.setName), place.get(b.setName)];
      if (pa !== undefined && pb !== undefined) return pa - pb;
      // Not placed yet goes first; two of those, the newest first.
      if (pa !== undefined) return 1;
      if (pb !== undefined) return -1;
      return newest(b.products) - newest(a.products);
    });
}

import { parseProductInput } from "@/lib/products/product-input";
import { fromZonedInput } from "@/lib/raffles/time";

/**
 * What an admin types into "New raffle" or "Edit raffle", checked.
 *
 * Pure, and shared: the dialog runs it to show a problem before anything is sent, and the
 * Server Action runs it again on what actually arrived, since a crafted POST skips the form.
 *
 * The product half is a product's own check (parseProductInput) -- the same Target link, the
 * same TCIN pulled out of it and held to it, the same name, price and image rules -- so a
 * raffle's product is never looser than one listed on Target Products. Picking a listed
 * product only fills these fields in; what's saved is what they say.
 */

export type RaffleFields = {
  url: string;
  sku: string;
  name: string;
  price: string;
  imageUrl: string;
  /** When the raffle starts on Target, as a datetime-local input has it, Central time. */
  startsAt: string;
  /** When entries are due, likewise. */
  dueAt: string;
};

export type RaffleInput = {
  sku: string;
  name: string;
  url: string;
  imageUrl: string | null;
  priceCents: number | null;
  startsAt: Date;
  dueAt: Date;
};

export const EMPTY_RAFFLE: RaffleFields = {
  url: "",
  sku: "",
  name: "",
  price: "",
  imageUrl: "",
  startsAt: "",
  dueAt: "",
};

/**
 * The raffle, or the first thing wrong with it.
 *
 * Entries must be due after the raffle starts. A NEW raffle must also still be taking entries
 * -- one already due is a typo, most likely the wrong month. An edit may set a due date that
 * has passed: that's how an admin closes entries early.
 */
export function parseRaffleInput(
  fields: RaffleFields,
  { now = new Date(), isNew }: { now?: Date; isNew: boolean },
): { ok: true; value: RaffleInput } | { ok: false; error: string } {
  const product = parseProductInput({
    // A product's own check, less the parts a raffle doesn't have: no set, fee or limit.
    setName: "Raffle",
    name: fields.name,
    url: fields.url,
    sku: fields.sku,
    price: fields.price,
    pasFee: "",
    imageUrl: fields.imageUrl,
    maxQty: "",
  });
  if (!product.ok) return product;

  if (!fields.startsAt.trim()) return { ok: false, error: "When does the raffle start?" };
  const startsAt = fromZonedInput(fields.startsAt);
  if (!startsAt) return { ok: false, error: "That start isn't a real date and time." };
  if (!fields.dueAt.trim()) return { ok: false, error: "When are entries due?" };
  const dueAt = fromZonedInput(fields.dueAt);
  if (!dueAt) return { ok: false, error: "That due date isn't a real date and time." };
  if (dueAt <= startsAt) {
    return { ok: false, error: "Entries have to be due after the raffle starts." };
  }
  if (isNew && dueAt <= now) {
    return { ok: false, error: "Entries for that would already be due. Check the date." };
  }

  const { sku, name, url, imageUrl, priceCents } = product.value;
  return { ok: true, value: { sku, name, url, imageUrl, priceCents, startsAt, dueAt } };
}

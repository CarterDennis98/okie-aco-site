"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { prisma } from "@/db/client";
import { Prisma } from "@/generated/prisma/client";
import { requireAdmin } from "@/lib/auth/guard";
import { parseProductInput, parseSetName, type ProductInput } from "@/lib/products/product-input";

/**
 * Adding, editing, arranging, retiring and deleting Target products, and arranging their
 * sets. FULL ADMINS ONLY: the catalog is the list of what every member can be run for, on
 * every runner's bot, so a retailer's runner doesn't get to change it -- the same reason fees
 * are a full admin's.
 *
 * Every change writes an `admin_audit` row, like every other admin mutation.
 */

export type ProductResult = { ok: true; id: string } | { ok: false; error: string };
export type SetResult = { ok: true; added: number } | { ok: false; error: string };
export type DeleteSetResult = { ok: true; deleted: number } | { ok: false; error: string };
export type OrderResult = { ok: true } | { ok: false; error: string };

/** Only Target has a product page today; the column exists for the next retailer. */
const SITE = "target";

/** More than any drop has had, and a bound on what one request can ask for. */
const MAX_SET = 100;

const text = (form: FormData, key: string) => String(form.get(key) ?? "");

/** "SKU 95082118 is already listed as “Elite Trainer Box” in “Phantasmal Flames”." */
function listedAlready(product: { sku: string; name: string; setName: string; active: boolean }) {
  return (
    `SKU ${product.sku} is already listed as “${product.name}” in “${product.setName}”` +
    (product.active ? "." : " (retired — restore it instead).")
  );
}

/** The next place at the end of a set. */
async function endOf(tx: Prisma.TransactionClient, setName: string): Promise<number> {
  const last = await tx.dropProduct.aggregate({
    where: { siteKey: SITE, setName },
    _max: { sortOrder: true },
  });
  return (last._max.sortOrder ?? -1) + 1;
}

/**
 * Edits one product. Adding is the set editor's (saveDropSet), which lists any number at
 * once. A product moved to another set goes to the end of it.
 */
export async function updateDropProduct(form: FormData): Promise<ProductResult> {
  const viewer = await requireAdmin();
  const id = text(form, "id");

  const parsed = parseProductInput({
    setName: text(form, "setName"),
    name: text(form, "name"),
    url: text(form, "url"),
    sku: text(form, "sku"),
    price: text(form, "price"),
    imageUrl: text(form, "imageUrl"),
  });
  if (!parsed.ok) return parsed;
  const value = parsed.value;

  try {
    const before = await prisma.dropProduct.findUnique({
      where: { id },
      select: {
        setName: true,
        name: true,
        url: true,
        sku: true,
        priceCents: true,
        imageUrl: true,
      },
    });
    if (!before) return { ok: false, error: "That product is gone. Reload the page." };

    await prisma.$transaction(async (tx) => {
      const moved = before.setName !== value.setName;
      await tx.dropProduct.update({
        where: { id },
        data: { ...value, ...(moved ? { sortOrder: await endOf(tx, value.setName) } : {}) },
      });
      // Its old set's last product moved out: that set is gone, and so is its place.
      if (
        moved &&
        !(await tx.dropProduct.findFirst({
          where: { siteKey: SITE, setName: before.setName },
          select: { id: true },
        }))
      ) {
        await tx.dropSet.deleteMany({ where: { siteKey: SITE, name: before.setName } });
      }
      await tx.adminAudit.create({
        data: {
          actorDiscordId: viewer.discordUserId,
          action: "drop_product.update",
          entity: "drop_product",
          entityId: id,
          before,
          after: value,
        },
      });
    });

    revalidatePath("/dashboard/products");
    return { ok: true, id };
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const existing = await prisma.dropProduct.findUnique({
        where: { siteKey_sku: { siteKey: SITE, sku: value.sku } },
        select: { sku: true, name: true, setName: true, active: true },
      });
      return {
        ok: false,
        error: existing ? listedAlready(existing) : `SKU ${value.sku} is already listed.`,
      };
    }
    console.error("products: save failed", error instanceof Error ? error.message : "unknown");
    return { ok: false, error: "Couldn't save that. Nothing changed — try again." };
  }
}

/**
 * Retire or restore. Retiring takes a product off the page and out of every export, and
 * keeps what members picked: restoring it brings their choices back exactly as they were.
 */
export async function setDropProductActive(form: FormData): Promise<ProductResult> {
  const viewer = await requireAdmin();
  const id = text(form, "id");
  const active = text(form, "active") === "true";

  const product = await prisma.dropProduct.findUnique({ where: { id }, select: { active: true } });
  if (!product) return { ok: false, error: "That product is gone. Reload the page." };
  if (product.active === active) return { ok: true, id };

  await prisma.$transaction([
    prisma.dropProduct.update({ where: { id }, data: { active } }),
    prisma.adminAudit.create({
      data: {
        actorDiscordId: viewer.discordUserId,
        action: active ? "drop_product.restore" : "drop_product.retire",
        entity: "drop_product",
        entityId: id,
        before: { active: product.active },
        after: { active },
      },
    }),
  ]);

  revalidatePath("/dashboard/products");
  return { ok: true, id };
}

// ---------------------------------------------------------------------------
// The set editor
// ---------------------------------------------------------------------------

const newProduct = z
  .object({
    name: z.string().max(400),
    url: z.string().max(2000),
    sku: z.string().max(40),
    price: z.string().max(40),
    imageUrl: z.string().max(2000),
  })
  .strict();

const setRequest = z
  .object({
    setName: z.string().max(400),
    /** The set being edited, as stored. Null when adding: then `setName` picks the set. */
    previousName: z.string().max(400).nullable(),
    /** The set's products in their new order: ones already listed by id, new ones in full. */
    items: z
      .array(z.union([z.object({ id: z.uuid() }).strict(), z.object({ add: newProduct }).strict()]))
      .max(MAX_SET),
  })
  .strict();

/** A refusal decided inside the transaction, which rolls it back. */
class SetRefused extends Error {}

/**
 * Saves a set as the set editor left it -- in ONE transaction, so a set is never left half
 * added or half arranged:
 *
 *   - new products are added where they were placed, each checked as the single-product
 *     form checks one, and refused as a batch if any is wrong or already listed;
 *   - every product is given its place, in the order the editor sent. One somebody else
 *     added while the editor was open isn't lost: it keeps its place at the end;
 *   - editing a set can rename it, retired products and all -- but not onto another set's
 *     name, which would quietly merge the two.
 */
export async function saveDropSet(raw: unknown): Promise<SetResult> {
  const viewer = await requireAdmin();
  const request = setRequest.safeParse(raw);
  if (!request.success)
    return { ok: false, error: "That set didn't arrive whole. Reload the page." };
  const { previousName, items } = request.data;
  const set = parseSetName(request.data.setName);
  if (!set.ok) return set;
  const setName = set.value;

  const added: { index: number; value: ProductInput }[] = [];
  const firstAt = new Map<string, number>();
  for (const [index, item] of items.entries()) {
    if (!("add" in item)) continue;
    const checked = parseProductInput({ ...item.add, setName });
    if (!checked.ok) return { ok: false, error: `Product ${index + 1}: ${checked.error}` };
    const first = firstAt.get(checked.value.sku);
    if (first !== undefined) {
      return {
        ok: false,
        error: `Products ${first + 1} and ${index + 1} are the same SKU (${checked.value.sku}).`,
      };
    }
    firstAt.set(checked.value.sku, index);
    added.push({ index, value: checked.value });
  }
  const listedIds = items.flatMap((item) => ("id" in item ? [item.id] : []));
  if (previousName === null && added.length === 0) {
    return { ok: false, error: "Paste at least one product link." };
  }

  // Where the products listed in the editor live now: the set being edited, or, when
  // adding, the set the name picks -- which may not exist yet.
  const home = previousName ?? setName;
  const renaming = previousName !== null && previousName !== setName;

  try {
    const saved = await prisma.$transaction(async (tx) => {
      const current = await tx.dropProduct.findMany({
        where: { siteKey: SITE, setName: home, active: true },
        orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
        select: { id: true, sortOrder: true },
      });
      const place = new Map(current.map((p) => [p.id, p.sortOrder]));
      if (listedIds.some((id) => !place.has(id))) {
        throw new SetRefused(
          "That set changed since you opened it. Reload the page and try again.",
        );
      }
      if (renaming) {
        const taken = await tx.dropProduct.findFirst({
          where: { siteKey: SITE, setName },
          select: { id: true },
        });
        if (taken) throw new SetRefused(`There's already a set called “${setName}”.`);
      }
      if (added.length > 0) {
        const clashes = await tx.dropProduct.findMany({
          where: { siteKey: SITE, sku: { in: added.map((a) => a.value.sku) } },
          select: { sku: true, name: true, setName: true, active: true },
        });
        if (clashes.length > 0) throw new SetRefused(clashes.map(listedAlready).join(" "));
      }

      if (renaming) {
        await tx.dropProduct.updateMany({
          where: { siteKey: SITE, setName: home },
          data: { setName },
        });
        // The set keeps its place among the others under its new name. A place left under
        // the new name by a set long gone goes first: no products use that name (above).
        await tx.dropSet.deleteMany({ where: { siteKey: SITE, name: setName } });
        await tx.dropSet.updateMany({
          where: { siteKey: SITE, name: home },
          data: { name: setName },
        });
      }

      // A product already listed, by id, or a new one, by where it was in the request.
      const listed = new Set(listedIds);
      const order: ({ id: string } | { index: number })[] = [
        ...items.map((item, index) => ("id" in item ? { id: item.id } : { index })),
        ...current.filter((p) => !listed.has(p.id)).map((p) => ({ id: p.id })),
      ];
      const audits: Prisma.AdminAuditCreateManyInput[] = [];
      const finalIds: string[] = [];
      let moved = false;
      for (const [position, entry] of order.entries()) {
        if ("id" in entry) {
          if (place.get(entry.id) !== position) {
            moved = true;
            await tx.dropProduct.update({
              where: { id: entry.id },
              data: { sortOrder: position },
            });
          }
          finalIds.push(entry.id);
          continue;
        }
        const value = added.find((a) => a.index === entry.index)?.value;
        if (!value) continue;
        const row = await tx.dropProduct.create({
          data: {
            ...value,
            siteKey: SITE,
            createdBy: viewer.discordUserId,
            sortOrder: position,
          },
          select: { id: true },
        });
        finalIds.push(row.id);
        audits.push({
          actorDiscordId: viewer.discordUserId,
          action: "drop_product.create",
          entity: "drop_product",
          entityId: row.id,
          after: value,
        });
      }
      if (moved || renaming) {
        audits.push({
          actorDiscordId: viewer.discordUserId,
          action: "drop_set.update",
          entity: "drop_set",
          entityId: setName,
          before: { setName: home, order: current.map((p) => p.id) },
          after: { setName, order: finalIds },
        });
      }
      if (audits.length > 0) await tx.adminAudit.createMany({ data: audits });
      return added.length;
    });

    revalidatePath("/dashboard/products");
    return { ok: true, added: saved };
  } catch (error) {
    if (error instanceof SetRefused) return { ok: false, error: error.message };
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return {
        ok: false,
        error: "One of those SKUs was listed by someone else just now. Reload the page.",
      };
    }
    console.error("products: set save failed", error instanceof Error ? error.message : "unknown");
    return { ok: false, error: "Couldn't save that. Nothing changed — try again." };
  }
}

const deleteRequest = z
  .object({
    setName: z.string().max(400),
    /** How many products the page showed in the set, retired ones included. */
    expected: z.number().int().min(1).max(10_000),
  })
  .strict();

/**
 * Deletes a set: every product in it, retired ones too, and every member's pick of them.
 * Unlike retiring, there's no bringing it back -- which is why the button takes two clicks,
 * and why it deletes exactly the products the page showed: if the count has moved (someone
 * added one since), nothing is deleted and the admin looks again.
 */
export async function deleteDropSet(raw: unknown): Promise<DeleteSetResult> {
  const viewer = await requireAdmin();
  const request = deleteRequest.safeParse(raw);
  if (!request.success)
    return { ok: false, error: "That request didn't arrive whole. Reload the page." };
  const { setName, expected } = request.data;

  const products = await prisma.dropProduct.findMany({
    where: { siteKey: SITE, setName },
    select: { id: true, sku: true, name: true, active: true },
  });
  if (products.length === 0)
    return { ok: false, error: "That set is already gone. Reload the page." };
  if (products.length !== expected) {
    return {
      ok: false,
      error:
        "That set changed since the page loaded. Reload the page and check it before deleting.",
    };
  }
  const ids = products.map((p) => p.id);
  const picks = await prisma.productSelection.count({ where: { productId: { in: ids } } });

  await prisma.$transaction([
    // By id, not by name: a product added since the count was taken is not deleted unseen.
    prisma.dropProduct.deleteMany({ where: { id: { in: ids } } }),
    // Its place among the sets: a set made later under the same name is a new one.
    prisma.dropSet.deleteMany({ where: { siteKey: SITE, name: setName } }),
    prisma.adminAudit.create({
      data: {
        actorDiscordId: viewer.discordUserId,
        action: "drop_set.delete",
        entity: "drop_set",
        entityId: setName,
        before: { setName, products, picks },
      },
    }),
  ]);

  revalidatePath("/dashboard/products");
  return { ok: true, deleted: products.length };
}

const orderRequest = z
  .object({
    /** Every set on the page, by name, in the order they should show. */
    names: z.array(z.string().max(400)).max(500),
  })
  .strict();

/**
 * Arranges the sets: each named set gets its place, in the order given. A name that's no
 * longer a set is skipped, and a place kept for a set that's gone is cleared, so the table
 * holds the sets there are.
 *
 * A set the list doesn't name loses nothing. One that had a place keeps it, after the named
 * ones and in its old order -- a page loaded before it was placed can't undo that -- and one
 * that never had a place (made since the page loaded) stays new, at the top.
 */
export async function saveSetOrder(raw: unknown): Promise<OrderResult> {
  const viewer = await requireAdmin();
  const request = orderRequest.safeParse(raw);
  if (!request.success)
    return { ok: false, error: "That order didn't arrive whole. Reload the page." };
  const { names } = request.data;
  if (new Set(names).size !== names.length) {
    return { ok: false, error: "A set is listed twice. Reload the page." };
  }

  try {
    await prisma.$transaction(async (tx) => {
      const sets = new Set(
        (
          await tx.dropProduct.findMany({
            where: { siteKey: SITE },
            distinct: ["setName"],
            select: { setName: true },
          })
        ).map((p) => p.setName),
      );
      const before = (
        await tx.dropSet.findMany({
          where: { siteKey: SITE },
          orderBy: { sortOrder: "asc" },
          select: { name: true },
        })
      ).map((row) => row.name);
      const named = names.filter((name) => sets.has(name));
      const placed = [
        ...named,
        ...before.filter((name) => sets.has(name) && !named.includes(name)),
      ];

      await tx.dropSet.deleteMany({ where: { siteKey: SITE, name: { notIn: placed } } });
      for (const [index, name] of placed.entries()) {
        await tx.dropSet.upsert({
          where: { siteKey_name: { siteKey: SITE, name } },
          create: { siteKey: SITE, name, sortOrder: index },
          update: { sortOrder: index },
        });
      }
      await tx.adminAudit.create({
        data: {
          actorDiscordId: viewer.discordUserId,
          action: "drop_set.order",
          entity: "drop_set",
          before: { order: before },
          after: { order: placed },
        },
      });
    });
  } catch (error) {
    console.error("products: set order failed", error instanceof Error ? error.message : "unknown");
    return { ok: false, error: "Couldn't save that order. Nothing changed — try again." };
  }

  revalidatePath("/dashboard/products");
  return { ok: true };
}

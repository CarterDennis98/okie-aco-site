/**
 * The set editor's actions: adding many products at once, arranging a set, renaming it, and
 * deleting it with everything in it.
 *
 * The properties with something behind them: a batch is all or nothing, with the problem
 * named by its place; the order saved is the order sent, without losing a product someone
 * added meanwhile; a rename takes retired products along and never merges two sets; and a
 * delete takes exactly what the page showed -- picks included -- or nothing at all.
 *
 * Faked: who is signed in, and Next's cache revalidation. Everything else is the real
 * database.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/db/client";
import { getSetOrder } from "@/db/queries/products";
import {
  deleteDropSet,
  saveDropSet,
  saveSetOrder,
  updateDropProduct,
} from "@/lib/products/admin-actions";

const asking = vi.hoisted(() => ({
  viewer: { discordUserId: "999900000000000801", isAdmin: true },
}));
vi.mock("@/lib/auth/guard", () => ({ requireAdmin: async () => asking.viewer }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

const canRun = Boolean(process.env.DATABASE_URL);

const SITE = "target";
const ADMIN = "999900000000000801";
const MEMBER = "999900000000000811";
const PREFIX = "set-editor-spec-";
const SET = `${PREFIX}Phantasmal Flames`;
const OTHER = `${PREFIX}Surging Sparks`;

type NewOver = Partial<{
  name: string;
  sku: string;
  price: string;
  pasFee: string;
  imageUrl: string;
}>;

/** A new product as the editor sends one: its link, and whatever was filled in. */
const added = (sku: string, over: NewOver = {}) => ({
  add: {
    name: `${PREFIX}${sku}`,
    url: `https://www.target.com/p/x/-/A-${sku}`,
    sku: "",
    price: "",
    pasFee: "",
    imageUrl: "",
    ...over,
  },
});

/** A set's products, in their order. */
const inSet = (setName: string) =>
  prisma.dropProduct.findMany({
    where: { siteKey: SITE, setName },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    select: {
      id: true,
      sku: true,
      sortOrder: true,
      active: true,
      priceCents: true,
      pasFeeCents: true,
    },
  });

const skus = async (setName: string) => (await inSet(setName)).map((p) => p.sku);

/** A set listed in one go, for the tests that start from one. */
async function listed(setName: string, ...tcins: string[]) {
  const result = await saveDropSet({
    setName,
    previousName: null,
    items: tcins.map((sku) => added(sku)),
  });
  expect(result).toEqual({ ok: true, added: tcins.length });
  return inSet(setName);
}

describe.skipIf(!canRun)("the set editor", () => {
  beforeEach(cleanup);
  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  it("adds many products at once to a new set, in the order given", async () => {
    const result = await saveDropSet({
      setName: `  ${SET} `,
      previousName: null,
      items: [
        added("98000001", { price: "$49.99", pasFee: "$5" }),
        added("98000002", { pasFee: "0" }),
        added("98000003"),
      ],
    });
    expect(result).toEqual({ ok: true, added: 3 });
    expect(
      (await inSet(SET)).map((p) => [p.sku, p.sortOrder, p.priceCents, p.pasFeeCents]),
    ).toEqual([
      ["98000001", 0, 4999, 500],
      ["98000002", 1, null, 0],
      ["98000003", 2, null, null],
    ]);
    expect(
      await prisma.adminAudit.count({
        where: { actorDiscordId: ADMIN, action: "drop_product.create" },
      }),
    ).toBe(3);
  });

  it("refuses the whole batch when any of it is wrong, naming which", async () => {
    await listed(SET, "98000001");
    const send = (...items: ReturnType<typeof added>[]) =>
      saveDropSet({ setName: SET, previousName: null, items });

    expect(await send(added("98000002"), added("98000001"))).toEqual({
      ok: false,
      error: `SKU 98000001 is already listed as “${PREFIX}98000001” in “${SET}”.`,
    });
    expect(await send(added("98000002"), added("98000002"))).toEqual({
      ok: false,
      error: "Products 1 and 2 are the same SKU (98000002).",
    });
    expect(await send(added("98000002"), added("98000003", { price: "free" }))).toEqual({
      ok: false,
      error: "Product 2: That price isn't a number.",
    });
    expect(await send(added("98000002", { pasFee: "a lot" }))).toEqual({
      ok: false,
      error: "Product 1: That PAS fee isn't a number.",
    });
    expect(await send()).toEqual({ ok: false, error: "Paste at least one product link." });
    // None of the good ones in those batches went in on their own.
    expect(await skus(SET)).toEqual(["98000001"]);
  });

  it("arranges a set, with new products in among its own", async () => {
    const [p1, p2, p3] = await listed(SET, "98000001", "98000002", "98000003");
    const result = await saveDropSet({
      setName: SET,
      previousName: SET,
      items: [{ id: p3.id }, added("98000004"), { id: p1.id }, { id: p2.id }],
    });
    expect(result).toEqual({ ok: true, added: 1 });
    expect((await inSet(SET)).map((p) => [p.sku, p.sortOrder])).toEqual([
      ["98000003", 0],
      ["98000004", 1],
      ["98000001", 2],
      ["98000002", 3],
    ]);
    expect(
      await prisma.adminAudit.count({
        where: { actorDiscordId: ADMIN, action: "drop_set.update" },
      }),
    ).toBe(1);
  });

  it("keeps a product added while the editor was open, at the end", async () => {
    const [p1, p2] = await listed(SET, "98000001", "98000002", "98000003");
    // Saved by an editor that opened before the third was listed.
    expect(
      await saveDropSet({ setName: SET, previousName: SET, items: [{ id: p2.id }, { id: p1.id }] }),
    ).toEqual({ ok: true, added: 0 });
    expect(await skus(SET)).toEqual(["98000002", "98000001", "98000003"]);
  });

  it("refuses an order that has another set's product in it", async () => {
    const [p1] = await listed(SET, "98000001");
    const [q1] = await listed(OTHER, "98000009");
    expect(
      await saveDropSet({ setName: SET, previousName: SET, items: [{ id: q1.id }, { id: p1.id }] }),
    ).toEqual({
      ok: false,
      error: "That set changed since you opened it. Reload the page and try again.",
    });
  });

  it("renames a set, retired products and all, but never onto another set", async () => {
    const [p1, p2] = await listed(SET, "98000001", "98000002");
    await prisma.dropProduct.update({ where: { id: p2.id }, data: { active: false } });
    await listed(OTHER, "98000009");

    expect(
      await saveDropSet({ setName: OTHER, previousName: SET, items: [{ id: p1.id }] }),
    ).toEqual({ ok: false, error: `There's already a set called “${OTHER}”.` });

    const renamed = `${PREFIX}Renamed`;
    expect(
      await saveDropSet({ setName: renamed, previousName: SET, items: [{ id: p1.id }] }),
    ).toEqual({ ok: true, added: 0 });
    expect((await inSet(renamed)).map((p) => [p.sku, p.active])).toEqual([
      ["98000001", true],
      ["98000002", false],
    ]);
    expect(await inSet(SET)).toEqual([]);
  });

  it("moves a product edited into another set to the end of it", async () => {
    await listed(SET, "98000001", "98000002");
    const [q1] = await listed(OTHER, "98000009");
    const form = new FormData();
    for (const [key, value] of Object.entries({
      id: q1.id,
      setName: SET,
      name: `${PREFIX}moved`,
      url: "https://www.target.com/p/x/-/A-98000009",
      sku: "98000009",
      price: "",
      imageUrl: "",
    }))
      form.set(key, value);
    expect(await updateDropProduct(form)).toEqual({ ok: true, id: q1.id });
    expect((await inSet(SET)).map((p) => [p.sku, p.sortOrder])).toEqual([
      ["98000001", 0],
      ["98000002", 1],
      ["98000009", 2],
    ]);
  });

  it("sets and clears a product's PAS fee, and audits the change", async () => {
    const [p1] = await listed(SET, "98000001");
    const edit = (pasFee: string) => {
      const form = new FormData();
      for (const [key, value] of Object.entries({
        id: p1.id,
        setName: SET,
        name: `${PREFIX}98000001`,
        url: "https://www.target.com/p/x/-/A-98000001",
        sku: "98000001",
        price: "$49.99",
        pasFee,
        imageUrl: "",
      }))
        form.set(key, value);
      return updateDropProduct(form);
    };

    expect(await edit("7.50")).toEqual({ ok: true, id: p1.id });
    expect((await inSet(SET))[0]).toMatchObject({ priceCents: 4999, pasFeeCents: 750 });
    expect(
      await prisma.adminAudit.findFirst({
        where: { actorDiscordId: ADMIN, action: "drop_product.update", entityId: p1.id },
        select: { before: true, after: true },
      }),
    ).toMatchObject({ before: { pasFeeCents: null }, after: { pasFeeCents: 750 } });

    expect(await edit("")).toEqual({ ok: true, id: p1.id });
    expect((await inSet(SET))[0].pasFeeCents).toBeNull();
    expect(await edit("free")).toEqual({ ok: false, error: "That PAS fee isn't a number." });
  });

  it("deletes a set with its retired products and members' picks, only as the page showed it", async () => {
    const [p1, p2] = await listed(SET, "98000001", "98000002");
    await prisma.dropProduct.update({ where: { id: p2.id }, data: { active: false } });
    await prisma.discordMember.create({
      data: { discordUserId: MEMBER, username: `${PREFIX}member`, roles: [] },
    });
    await prisma.productSelection.create({
      data: { productId: p1.id, discordUserId: MEMBER, allProfiles: true },
    });

    // The page showed one product, but the set holds two: nothing is deleted.
    expect(await deleteDropSet({ setName: SET, expected: 1 })).toEqual({
      ok: false,
      error:
        "That set changed since the page loaded. Reload the page and check it before deleting.",
    });
    expect(await inSet(SET)).toHaveLength(2);

    expect(await deleteDropSet({ setName: SET, expected: 2 })).toEqual({ ok: true, deleted: 2 });
    expect(await inSet(SET)).toEqual([]);
    expect(await prisma.productSelection.count({ where: { discordUserId: MEMBER } })).toBe(0);
    expect(
      await prisma.adminAudit.findFirst({
        where: { actorDiscordId: ADMIN, action: "drop_set.delete" },
        select: { entityId: true, before: true },
      }),
    ).toMatchObject({ entityId: SET, before: { setName: SET, picks: 1 } });

    expect(await deleteDropSet({ setName: SET, expected: 2 })).toEqual({
      ok: false,
      error: "That set is already gone. Reload the page.",
    });
  });

  // Only this file's sets: the database may hold real ones, placed or not.
  const ours = async () => (await getSetOrder(SITE)).filter((name) => name.startsWith(PREFIX));
  const THIRD = `${PREFIX}Paldean Fates`;

  it("arranges the sets, keeping any the page didn't list after them, in their old order", async () => {
    await listed(SET, "98000001");
    await listed(OTHER, "98000009");
    await listed(THIRD, "98000005");
    expect(await saveSetOrder({ names: [OTHER, SET, THIRD] })).toEqual({ ok: true });
    expect(await ours()).toEqual([OTHER, SET, THIRD]);

    // A page that loaded before the other two were placed only knows the third.
    expect(await saveSetOrder({ names: [THIRD] })).toEqual({ ok: true });
    expect(await ours()).toEqual([THIRD, OTHER, SET]);

    // A name that's no set any more places nothing; a set named twice is a stale page.
    expect(await saveSetOrder({ names: [`${PREFIX}Gone`, SET] })).toEqual({ ok: true });
    expect(await ours()).toEqual([SET, THIRD, OTHER]);
    expect(await saveSetOrder({ names: [SET, SET] })).toEqual({
      ok: false,
      error: "A set is listed twice. Reload the page.",
    });
    expect(
      await prisma.adminAudit.count({ where: { actorDiscordId: ADMIN, action: "drop_set.order" } }),
    ).toBe(3);
  });

  it("keeps a set's place through a rename, and takes it away with the set", async () => {
    const [p1] = await listed(SET, "98000001");
    await listed(OTHER, "98000009");
    await saveSetOrder({ names: [OTHER, SET] });

    const renamed = `${PREFIX}Renamed`;
    expect(
      await saveDropSet({ setName: renamed, previousName: SET, items: [{ id: p1.id }] }),
    ).toEqual({ ok: true, added: 0 });
    expect(await ours()).toEqual([OTHER, renamed]);

    expect(await deleteDropSet({ setName: renamed, expected: 1 })).toEqual({
      ok: true,
      deleted: 1,
    });
    expect(await ours()).toEqual([OTHER]);
  });

  it("forgets a set's place once its last product is edited into another set", async () => {
    await listed(SET, "98000001");
    const [q1] = await listed(OTHER, "98000009");
    await saveSetOrder({ names: [OTHER, SET] });
    const form = new FormData();
    for (const [key, value] of Object.entries({
      id: q1.id,
      setName: SET,
      name: `${PREFIX}moved`,
      url: "https://www.target.com/p/x/-/A-98000009",
      sku: "98000009",
      price: "",
      imageUrl: "",
    }))
      form.set(key, value);
    expect(await updateDropProduct(form)).toEqual({ ok: true, id: q1.id });
    expect(await ours()).toEqual([SET]);
  });
});

async function cleanup() {
  await prisma.dropProduct.deleteMany({
    where: { OR: [{ createdBy: ADMIN }, { setName: { startsWith: PREFIX } }] },
  });
  await prisma.dropSet.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await prisma.adminAudit.deleteMany({ where: { actorDiscordId: ADMIN } });
  await prisma.discordMember.deleteMany({ where: { discordUserId: MEMBER } });
}

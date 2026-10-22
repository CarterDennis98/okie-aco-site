import { describe, expect, it } from "vitest";
import { groupByLine, groupBySet, searchGroups, searchTerms } from "@/lib/products/sets";

const product = (name: string, setName: string, sortOrder: number, day: number) => ({
  name,
  setName,
  sortOrder,
  createdAt: new Date(Date.UTC(2026, 9, day)),
});

describe("groupBySet", () => {
  it("lists the set with the newest product first, each set in the order it was arranged", () => {
    const groups = groupBySet([
      product("Booster Bundle", "Older Set", 1, 1),
      product("Elite Trainer Box", "Older Set", 0, 2),
      product("Booster Display", "Newer Set", 2, 3),
      product("Tin", "Newer Set", 0, 4),
      product("Binder", "Newer Set", 1, 5),
    ]);
    expect(groups.map((g) => [g.setName, g.products.map((p) => p.name)])).toEqual([
      ["Newer Set", ["Tin", "Binder", "Booster Display"]],
      ["Older Set", ["Elite Trainer Box", "Booster Bundle"]],
    ]);
  });

  it("puts the older first between two that share a place, as a restored product may", () => {
    const groups = groupBySet([product("Later", "Set", 0, 9), product("Earlier", "Set", 0, 3)]);
    expect(groups[0].products.map((p) => p.name)).toEqual(["Earlier", "Later"]);
  });

  it("takes dates as the page receives them, as strings too", () => {
    const groups = groupBySet([
      { name: "A", setName: "S", sortOrder: 1, createdAt: "2026-10-01T00:00:00.000Z" },
      { name: "B", setName: "S", sortOrder: 0, createdAt: "2026-10-02T00:00:00.000Z" },
    ]);
    expect(groups[0].products.map((p) => p.name)).toEqual(["B", "A"]);
  });
});

describe("searching the products", () => {
  const listed = (name: string, sku: string, setName: string) => ({
    name,
    sku,
    setName,
    sortOrder: 0,
    createdAt: new Date(Date.UTC(2026, 9, 1)),
  });
  const groups = groupBySet([
    listed("Pokémon Elite Trainer Box", "1010892076", "30th Celebration"),
    listed("Booster Bundle", "1011407490", "30th Celebration"),
    listed("Tech Sticker - Gastly", "95120822", "Ascended Heroes"),
  ]);
  const found = (query: string) =>
    searchGroups(groups, searchTerms(query)).map((g) => [g.setName, g.products.map((p) => p.name)]);

  it("finds every word in a name, a SKU or a set, ignoring case and accents", () => {
    expect(found("pokemon etb")).toEqual([]);
    expect(found("POKEMON trainer")).toEqual([["30th Celebration", ["Pokémon Elite Trainer Box"]]]);
    expect(found("95120822")).toEqual([["Ascended Heroes", ["Tech Sticker - Gastly"]]]);
    expect(found("30th bundle")).toEqual([["30th Celebration", ["Booster Bundle"]]]);
  });

  it("drops a set with nothing left, and narrows nothing for an empty search", () => {
    expect(found("gastly").map(([set]) => set)).toEqual(["Ascended Heroes"]);
    expect(found("   ")).toHaveLength(2);
  });
});

describe("arranging the sets", () => {
  const product = (name: string, setName: string, day: number) => ({
    name,
    setName,
    sortOrder: 0,
    createdAt: new Date(Date.UTC(2026, 9, day)),
  });
  const products = [
    product("a", "Oldest", 1),
    product("b", "Middle", 2),
    product("c", "Newest", 3),
    product("d", "Brand New", 4),
  ];
  const order = (setOrder?: string[]) => groupBySet(products, setOrder).map((g) => g.setName);

  it("lists sets newest first until they're arranged", () => {
    expect(order()).toEqual(["Brand New", "Newest", "Middle", "Oldest"]);
  });

  it("lists placed sets as arranged, with any not placed yet above them, newest first", () => {
    expect(order(["Oldest", "Newest", "Middle"])).toEqual([
      "Brand New",
      "Oldest",
      "Newest",
      "Middle",
    ]);
    // A name that's no set any more places nothing.
    expect(order(["Gone", "Middle", "Oldest", "Newest", "Brand New"])).toEqual([
      "Middle",
      "Oldest",
      "Newest",
      "Brand New",
    ]);
  });
});

describe("grouping sets under product lines", () => {
  const lines = [
    { id: "pokemon", name: "Pokémon" },
    { id: "topps", name: "Topps" },
    { id: "onepiece", name: "One Piece" },
  ];
  const sets = ["Chrome", "Surging Sparks", "Loose", "Phantasmal Flames", "Orphaned"].map(
    (setName) => ({ setName }),
  );
  const lineOf = (setName: string) =>
    ({
      Chrome: "topps",
      "Surging Sparks": "pokemon",
      "Phantasmal Flames": "pokemon",
      Orphaned: "deleted-line",
    })[setName] ?? null;

  it("lists the lines in their order, each set in the order given, and Other last", () => {
    expect(
      groupByLine(sets, lines, lineOf).map((g) => [
        g.line?.name ?? null,
        g.sets.map((s) => s.setName),
      ]),
    ).toEqual([
      ["Pokémon", ["Surging Sparks", "Phantasmal Flames"]],
      ["Topps", ["Chrome"]],
      [null, ["Loose", "Orphaned"]],
    ]);
  });

  it("is one group under no line when no set is in one", () => {
    expect(groupByLine(sets, [], lineOf)).toEqual([{ line: null, sets }]);
  });

  it("finds a set by its line's name", () => {
    const groups = groupBySet([
      {
        name: "Elite Trainer Box",
        sku: "1",
        setName: "Surging Sparks",
        sortOrder: 0,
        createdAt: "2026-10-01",
      },
      { name: "Hobby Box", sku: "2", setName: "Chrome", sortOrder: 0, createdAt: "2026-10-01" },
    ]);
    const lineName = (setName: string) => lines.find((l) => l.id === lineOf(setName))?.name ?? "";
    expect(searchGroups(groups, searchTerms("pokemon"), lineName).map((g) => g.setName)).toEqual([
      "Surging Sparks",
    ]);
    expect(
      searchGroups(groups, searchTerms("topps hobby"), lineName).map((g) => g.setName),
    ).toEqual(["Chrome"]);
  });
});

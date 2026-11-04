import { describe, expect, it } from "vitest";
import { qtysByProfile, skusByProfile } from "@/lib/products/selection";

const catalog = [
  { id: "p1", sku: "100" },
  { id: "p2", sku: "200" },
  { id: "p3", sku: "300" },
];
const profiles = [
  { id: "a1", discordUserId: "alice" },
  { id: "a2", discordUserId: "alice" },
  { id: "b1", discordUserId: "bob" },
];

describe("skusByProfile", () => {
  it("runs a pick of all profiles on every one, and a narrowed pick on the ones listed", () => {
    const skus = skusByProfile(
      profiles,
      [
        { productId: "p3", discordUserId: "alice", allProfiles: true, profileIds: [] },
        { productId: "p1", discordUserId: "alice", allProfiles: false, profileIds: ["a2"] },
        { productId: "p2", discordUserId: "bob", allProfiles: true, profileIds: [] },
      ],
      catalog,
    );
    // In catalog order, whatever order the picks were made in.
    expect(Object.fromEntries(skus)).toEqual({ a1: ["300"], a2: ["100", "300"], b1: ["200"] });
  });

  it("matches nothing for a product that isn't in the catalog any more", () => {
    const skus = skusByProfile(
      profiles,
      [{ productId: "retired", discordUserId: "bob", allProfiles: true, profileIds: [] }],
      catalog,
    );
    expect(skus.get("b1")).toEqual([]);
  });

  it("never lets one member's narrowed pick reach another member's profile", () => {
    const skus = skusByProfile(
      profiles,
      [{ productId: "p1", discordUserId: "bob", allProfiles: false, profileIds: ["a1"] }],
      catalog,
    );
    expect(skus.get("a1")).toEqual([]);
    expect(skus.get("b1")).toEqual([]);
  });
});

describe("qtysByProfile", () => {
  it("gives a profile its own qty, else the pick's, and leaves the standard ones out", () => {
    const qty = qtysByProfile(
      profiles,
      [
        // Alice: 1 of p1 everywhere but a2, which buys 3.
        {
          productId: "p1",
          discordUserId: "alice",
          allProfiles: true,
          profileIds: [],
          qty: 1,
          profileQty: { a2: 3 },
        },
        // The standard qty of p2, but 4 on a1.
        {
          productId: "p2",
          discordUserId: "alice",
          allProfiles: true,
          profileIds: [],
          qty: null,
          profileQty: { a1: 4 },
        },
        // Bob never picked a qty.
        { productId: "p3", discordUserId: "bob", allProfiles: true, profileIds: [] },
      ],
      catalog,
    );
    expect(Object.fromEntries(qty)).toEqual({
      a1: { "100": 1, "200": 4 },
      a2: { "100": 3 },
      b1: {},
    });
  });

  it("puts no qty on a product the profile doesn't run, or another member's profile", () => {
    const qty = qtysByProfile(
      profiles,
      [
        // Narrowed to a2: a1's own qty for it runs nothing.
        {
          productId: "p1",
          discordUserId: "alice",
          allProfiles: false,
          profileIds: ["a2"],
          qty: 1,
          profileQty: { a1: 5 },
        },
        // Retired: not in the catalog.
        {
          productId: "retired",
          discordUserId: "alice",
          allProfiles: true,
          profileIds: [],
          qty: 2,
        },
        // Bob's pick, with a qty for alice's profile.
        {
          productId: "p2",
          discordUserId: "bob",
          allProfiles: true,
          profileIds: [],
          profileQty: { a1: 3 },
        },
      ],
      catalog,
    );
    expect(Object.fromEntries(qty)).toEqual({ a1: {}, a2: { "100": 1 }, b1: {} });
  });
});

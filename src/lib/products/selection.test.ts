import { describe, expect, it } from "vitest";
import { skusByProfile } from "@/lib/products/selection";

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

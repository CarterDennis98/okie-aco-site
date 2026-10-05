import { describe, expect, it } from "vitest";
import { countDrops } from "@/lib/products/stats";

const product = (id: string, sku: string) => ({ id, sku, name: `${id} name`, setName: "Set" });
const pick = (productId: string, discordUserId: string, profileIds: string[] | "all") => ({
  productId,
  discordUserId,
  allProfiles: profileIds === "all",
  profileIds: profileIds === "all" ? [] : profileIds,
});

describe("countDrops", () => {
  it("counts who runs what by the rule the export builds tasks with", () => {
    const { stats, idleIds } = countDrops(
      [product("p1", "1001"), product("p2", "1002"), product("p3", "1003")],
      [
        pick("p1", "alice", "all"),
        pick("p2", "alice", ["a2"]),
        pick("p1", "bob", "all"),
        // A pick narrowed to a profile that isn't active runs on nothing.
        pick("p2", "carol", ["c-switched-off"]),
      ],
      [
        { id: "a1", discordUserId: "alice" },
        { id: "a2", discordUserId: "alice" },
        { id: "b1", discordUserId: "bob" },
        { id: "c1", discordUserId: "carol" },
      ],
    );
    expect(idleIds).toEqual(["carol"]);
    expect(stats).toEqual({
      members: 3,
      running: 2,
      profiles: 4,
      profilesRunning: 3,
      // Alice runs two products, Bob one.
      selections: 3,
      // a1: p1; a2: p1, p2; b1: p1.
      runs: 4,
      products: 3,
      // p3 is listed but nobody runs it, so no watchdog watches it.
      watched: 2,
      top: [
        { id: "p1", name: "p1 name", setName: "Set", members: 2, profiles: 3 },
        { id: "p2", name: "p2 name", setName: "Set", members: 1, profiles: 1 },
      ],
    });
  });

  it("counts a member with active profiles and no picks as idle", () => {
    const { stats, idleIds } = countDrops(
      [product("p1", "1001")],
      [],
      [{ id: "a1", discordUserId: "alice" }],
    );
    expect(idleIds).toEqual(["alice"]);
    expect(stats).toMatchObject({ members: 1, running: 0, watched: 0, top: [] });
  });
});

import { describe, expect, it } from "vitest";
import { FIRST_INSTANCE_CAP, splitPkc } from "@/lib/valor/split";

/** `count` members with `each` profiles apiece, named the way the vault names them. */
function members(count: number, each: number) {
  return Array.from({ length: count }, (_, m) =>
    Array.from({ length: each }, (_, i) => ({
      name:
        i === 0
          ? `member${String(m).padStart(3, "0")}`
          : `member${String(m).padStart(3, "0")} - ${i + 1}`,
      discordUserId: String(1000 + m),
    })),
  ).flat();
}

describe("splitPkc", () => {
  it("runs each member's first five on the main bot, the rest on the backup", () => {
    const split = splitPkc(members(2, 7), 5);
    expect(split[1].main.map((p) => p.name)).toEqual([
      "member000",
      "member000 - 2",
      "member000 - 3",
      "member000 - 4",
      "member000 - 5",
      "member001",
      "member001 - 2",
      "member001 - 3",
      "member001 - 4",
      "member001 - 5",
    ]);
    expect(split[1].backup.map((p) => p.name)).toEqual([
      "member000 - 6",
      "member000 - 7",
      "member001 - 6",
      "member001 - 7",
    ]);
    expect(split[2]).toEqual({ main: [], backup: [] });
  });

  it("puts the first 250 of each, by name, on the first instance and the rest on the second", () => {
    // 60 members x 7: 300 main-bot profiles and 120 backup-bot ones.
    const split = splitPkc(members(60, 7), 5);
    expect(split[1].main).toHaveLength(FIRST_INSTANCE_CAP);
    expect(split[2].main).toHaveLength(50);
    expect(split[1].backup).toHaveLength(120);
    expect(split[2].backup).toHaveLength(0);
    // The line falls between member049's fifth and member050's first: in name order, always.
    expect(split[1].main.at(-1)?.name).toBe("member049 - 5");
    expect(split[2].main[0].name).toBe("member050");
  });

  it("splits a member across the instances when the line falls inside their profiles", () => {
    // 248 main-bot profiles ahead of zed's five: two of zed's fit on the first, three don't.
    const zed = Array.from({ length: 5 }, (_, i) => ({
      name: i === 0 ? "zed" : `zed - ${i + 1}`,
      discordUserId: "9999",
    }));
    const split = splitPkc([...members(62, 4), ...zed], 5);
    expect(split[1].main.slice(-2).map((p) => p.name)).toEqual(["zed", "zed - 2"]);
    expect(split[2].main.map((p) => p.name)).toEqual(["zed - 3", "zed - 4", "zed - 5"]);
  });

  it("orders names the way the instances do: numbers as numbers, case aside", () => {
    const split = splitPkc(
      [
        { name: "jirei - 10", discordUserId: "1" },
        { name: "jirei - 2", discordUserId: "2" },
        { name: "Jirei", discordUserId: "3" },
        { name: "_alecazam_", discordUserId: "4" },
        { name: ".jocro", discordUserId: "5" },
      ],
      5,
    );
    expect(split[1].main.map((p) => p.name)).toEqual([
      "_alecazam_",
      ".jocro",
      "Jirei",
      "jirei - 2",
      "jirei - 10",
    ]);
  });
});

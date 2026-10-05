import { describe, expect, it } from "vitest";
import { buildInstance } from "@/lib/shikari/build";
import { openBackup } from "@/lib/shikari/sqlite";
import { headline, summaryText } from "@/lib/shikari/summary";
import type { DesiredProfile } from "@/lib/shikari/types";
import {
  ALL_SECTIONS,
  SKU_B,
  TASKS,
  desiredInstance,
  fixtureBackup,
  seeded,
  sqljs,
  vaultProfiles,
} from "../../../tests/shikari/fixture";

/** A first export of the fixture with one of each kind of change in it. */
async function report() {
  const carol: DesiredProfile = {
    ...vaultProfiles()[2],
    key: "vault-carol-1",
    ownerName: "carol",
    name: "carol - 1",
    email: "carol1@example.com",
    skus: [SKU_B],
  };
  const list = vaultProfiles();
  list[0].card = { ...list[0].card, cvv: "321" };
  list[2].skus = [];
  const { bytes } = await fixtureBackup();
  const open = openBackup(await sqljs(), bytes);
  return buildInstance(open.db, desiredInstance([...list, carol]), {
    sections: ALL_SECTIONS,
    removeProfileGroups: [],
    proxyLists: [],
    tasks: TASKS,
    now: new Date("2026-10-05T12:00:00.000Z"),
    random: seeded(),
  });
}

describe("the export summary", () => {
  it("says which profiles are new, updated, deactivated and removed, and why", async () => {
    const text = summaryText(1, "okie-shikari-instance-1.bak", await report());
    expect(text).toBe(
      [
        "Instance 1 · okie-shikari-instance-1.bak",
        "1 new · 1 updated · 2 deactivated · 1 removed · 1 unchanged",
        "",
        "New (1)",
        "- carol - 1 (carol)",
        "",
        "Updated (1)",
        "- alice - 1 (alice): CVV",
        "",
        "Deactivated (2)",
        "- picked no products: bob - 1",
        "- not on the site: stranger - 1",
        "",
        "Removed (1)",
        "- from “Target Paused”: Target 11 (switched off)",
        "",
        // stranger's, Target 11's, and one nobody has had in years.
        "Also taken out: 3 logins, 1 old wipe task, groups “Target Paused”, “Target Wipe”.",
      ].join("\n"),
    );
    // Names and reasons only: nothing a member would mind being pasted somewhere.
    expect(text).not.toMatch(/4111|alice-pass|@example\.com|app pass/);
  });

  it("says so when nothing about the profiles changed", async () => {
    const r = await report();
    r.profiles = {
      ...r.profiles,
      added: [],
      updated: [],
      deactivated: [],
      removed: [],
      unchanged: 0,
    };
    expect(headline(r)).toBe("no profile changes");
  });
});

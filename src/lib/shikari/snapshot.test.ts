import { describe, expect, it } from "vitest";
import { STANDARD_QTY } from "@/lib/products/qty";
import { checkShikariSchema } from "@/lib/shikari/schema";
import {
  currentTaskSettings,
  groupsToClear,
  ispAllGroup,
  readSnapshot,
  summarize,
  userOf,
} from "@/lib/shikari/snapshot";
import {
  SKU_A,
  SKU_B,
  fixtureBackup,
  legacy,
  mainInstanceBackup,
} from "../../../tests/shikari/fixture";

describe("userOf", () => {
  it.each([
    ["azndeptrai - 6", "azndeptrai"],
    ["Target 11", "Target"],
    ["kennethm321 - 6", "kennethm321"],
    // Digits that are part of the name stay with it.
    ["kennethm321", "kennethm321"],
    ["ichigosensei", "ichigosensei"],
  ])("%s belongs to %s", (name, user) => {
    expect(userOf(name)).toBe(user);
  });
});

describe("ispAllGroup", () => {
  const group = (name: string, proxies = 1) => ({ name, proxies: Array(proxies).fill(null) });

  it.each(["ISP - All", "ISP All", "isp-all", "All ISP", "ISPAll", "ISPs - All"])(
    "finds %s",
    (name) => {
      expect(ispAllGroup([group("Checkout"), group(name)])?.name).toBe(name);
    },
  );

  it.each(["ISP Harvest 1", "ISP Small", "Resi All", "Checkout", "localhost"])(
    "doesn't take %s for it",
    (name) => {
      expect(ispAllGroup([group(name)])).toBeUndefined();
    },
  );

  it("prefers one with proxies in it, then Shikari's order", () => {
    expect(ispAllGroup([group("ISP All", 0), group("ISP - All", 3)])?.name).toBe("ISP - All");
    expect(ispAllGroup([group("ISP All", 0)])?.name).toBe("ISP All");
  });
});

describe("reading a backup", () => {
  it("summarizes what the upload holds, without a secret in it", async () => {
    const { db } = await fixtureBackup();
    const summary = summarize(readSnapshot(db));
    expect(summary.counts).toEqual({
      profiles: 5,
      accounts: 6,
      signedIn: 1,
      imap: 1,
      proxies: 10,
      tasks: 9,
    });
    expect(summary.users.map((u) => [u.name, u.profiles.length])).toEqual([
      ["alice", 2],
      ["bob", 1],
      ["stranger", 1],
      ["Target", 1],
    ]);
    // Shikari's built-in localhost group isn't a list anyone uploaded.
    expect(summary.proxyGroups.map((g) => [g.name, g.count])).toEqual([
      ["ISP - All", 4],
      ["Resi", 6],
    ]);
    const target = summary.taskGroups.find((g) => g.name === "Target");
    expect(target?.kinds).toEqual([
      { kind: "Remote watchdog", count: 1 },
      { kind: "Watchdog", count: 3 },
      { kind: "Checkout", count: 4 },
    ]);
    expect(target?.checkoutSkus).toBe(2);
    expect(JSON.stringify(summary)).not.toMatch(
      /4111111111111111|alice-pass-1|app pass alic|isp-pass/,
    );
  });

  it("says what an export does with each profile group, and what nothing runs", async () => {
    const { db } = await mainInstanceBackup();
    const summary = summarize(readSnapshot(db));
    expect(summary.profileGroups.map((g) => [g.name, g.role, g.count, g.tasks])).toEqual([
      // Its profiles' checkout tasks, one of them in "NO IMAP", and alice's old wipe.
      ["Target", "target", 4, 5],
      ["Target - Paused", "paused", 1, 0],
      ["Walmart", "outside", 1, 1],
      ["Target - Secondary", "other", 1, 0],
      ["Crisp Target", "other", 1, 1],
    ]);
    const id = (name: string) => summary.profileGroups.find((g) => g.name === name)?.id;

    // By default: the parked group nothing runs is cleared, the other runner's is kept.
    expect(groupsToClear(summary, {})).toEqual([id("Target - Secondary")]);
    // The operator's own choice wins, by name...
    expect(groupsToClear(summary, { targetsecondary: "keep", crisptarget: "remove" })).toEqual([
      id("Crisp Target"),
    ]);
    // ...but only for another Target group: Walmart, and Target itself, aren't the choice's.
    expect(groupsToClear(summary, { walmart: "remove", target: "remove" })).toEqual([
      id("Target - Secondary"),
    ]);
  });

  it("never takes the Miscellaneous line's group for the one rebuilt as Target", async () => {
    const { db } = await mainInstanceBackup();
    // More of the Target profiles' checkout tasks than any other group holds.
    db.run(
      "INSERT INTO task_group (id, created_at, name, color, order_index) VALUES (6, NULL, 'Target - Miscellaneous', '#039BE5', 5)",
    );
    db.run("UPDATE task SET task_group_id = 6 WHERE id IN (5, 7)");
    expect(summarize(readSnapshot(db)).target.taskGroup).toBe("Target - All Products");
  });

  it("reads the task settings the backup runs on now, with the standard watchdog layout", async () => {
    const { db } = await fixtureBackup();
    expect(currentTaskSettings(readSnapshot(db))).toEqual({
      checkoutQty: 2,
      checkoutProxyGroupId: 1,
      // "ISP - All", wherever the Miscellaneous line's checkout tasks are now.
      miscCheckoutProxyGroupId: 0,
      watchdogProxyGroupId: 0,
      // Not the 3333/4444/5555 the fixture still has: the third comes out on export.
      watchdogIntervals: [3333, 4444],
      skusPerWatchdog: 30,
      remoteWatchdogs: 1,
    });
    // Sanity on the fixture itself: the watchdogs watch what the checkout tasks run.
    expect(
      readSnapshot(db)
        .products.filter((p) => p.taskId === 2)
        .map((p) => p.data),
    ).toEqual([SKU_A, SKU_B]);
  });

  it("starts at the site's standard qty, whatever qty most of the backup runs at", async () => {
    const { db } = await fixtureBackup();
    // Members who picked 1 are most of the backup now: still not the standard.
    db.run("UPDATE target_product SET qty = 1 WHERE qty IS NOT NULL");
    expect(currentTaskSettings(readSnapshot(db)).checkoutQty).toBe(STANDARD_QTY);
  });

  it("puts the Miscellaneous line's checkout tasks on the checkout group with no ISP - All", async () => {
    const { db } = await fixtureBackup();
    db.run("UPDATE proxy_group SET name = 'ISP - Monitor' WHERE id = 0");
    expect(currentTaskSettings(readSnapshot(db))).toMatchObject({
      checkoutProxyGroupId: 1,
      miscCheckoutProxyGroupId: 1,
    });
  });

  it("knows the Shikari version, and flags one newer than it was built against", async () => {
    const { db } = await fixtureBackup();
    expect(checkShikariSchema(db)).toEqual({
      ok: true,
      version: "f2b6d8e4a1c9",
      newerVersion: false,
    });
    // The two before it, with their tables, are known too.
    for (const version of ["e5b1c9d3a7f2", "d4e8b21c7f05"]) {
      db.run("UPDATE alembic_version SET version_num = ?", [version]);
      expect(checkShikariSchema(db)).toMatchObject({ ok: true, newerVersion: false });
    }
    db.run("UPDATE alembic_version SET version_num = 'ffffffffffff'");
    expect(checkShikariSchema(db)).toMatchObject({ ok: true, newerVersion: true });
  });

  it("takes a backup from before tasks had drag-and-drop order", async () => {
    const { db } = await legacy(fixtureBackup)();
    expect(checkShikariSchema(db)).toEqual({
      ok: true,
      version: "d4e8b21c7f05",
      newerVersion: false,
    });
    expect(readSnapshot(db).taskOrder).toBe(false);
    expect(readSnapshot((await fixtureBackup()).db).taskOrder).toBe(true);
  });

  it("takes a new column with a default in its stride", async () => {
    const { db } = await fixtureBackup();
    db.run("ALTER TABLE task ADD COLUMN priority INTEGER NOT NULL DEFAULT 0");
    expect(checkShikariSchema(db).ok).toBe(true);
  });

  it("refuses a missing table, or a new required column it couldn't fill", async () => {
    const { db } = await fixtureBackup();
    db.run("DROP TABLE target_product");
    db.run("DROP TABLE cookie_jar");
    db.run(
      "CREATE TABLE cookie_jar (id INTEGER NOT NULL PRIMARY KEY, created_at DATETIME, updated_at DATETIME, cookies JSON NOT NULL, owner TEXT NOT NULL)",
    );
    expect(checkShikariSchema(db)).toMatchObject({
      ok: false,
      problems: [
        "no target_product table",
        "cookie_jar.owner is required and the export doesn't know how to fill it",
      ],
    });
  });
});

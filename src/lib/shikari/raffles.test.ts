/**
 * The Shikari export's raffle groups, against a synthetic backup on Shikari's real schema.
 *
 * The properties with something behind them:
 *   - each raffle anyone here is entered in gets ONE task group, "Target Raffle <TCIN>", with
 *     ONE Draw task per profile entered, in member order, shaped like the Draw tasks Shikari
 *     makes -- and a backup exported twice is unchanged the second time;
 *   - a raffle group made by hand ("Target - Raffle") is taken over and renamed, and an entry
 *     kept keeps its browser, session and state;
 *   - an entry nobody needs comes out, and so does a raffle group nobody needs, once empty --
 *     never another runner's entries, never Walmart's raffle tasks, never with the section off.
 */
import { describe, expect, it } from "vitest";
import { buildInstance } from "@/lib/shikari/build";
import { diffTables, tableHashes, type TableDiff } from "@/lib/shikari/diff";
import { openBackup, type ShikariDb } from "@/lib/shikari/sqlite";
import type {
  BuildOptions,
  DesiredProfile,
  DesiredRaffle,
  KnownProfile,
} from "@/lib/shikari/types";
import {
  ALL_SECTIONS,
  SKU_A,
  SKU_R,
  SKU_S,
  TASKS,
  cleanBackup,
  desiredInstance,
  legacy,
  mainInstanceBackup,
  seeded,
  sqljs,
  vaultProfiles,
  withRaffleGroup,
} from "../../../tests/shikari/fixture";

const RAFFLE_R: DesiredRaffle = { sku: SKU_R, name: "Product R" };
const RAFFLE_S: DesiredRaffle = { sku: SKU_S, name: "Product S" };
const GROUP_R = `Target Raffle ${SKU_R}`;
const GROUP_S = `Target Raffle ${SKU_S}`;

function options(over: Partial<BuildOptions> = {}): BuildOptions {
  return {
    sections: ALL_SECTIONS,
    removeProfileGroups: [],
    proxyLists: [],
    tasks: TASKS,
    now: new Date("2026-11-19T12:00:00.000Z"),
    random: seeded(),
    ...over,
  };
}

/** The vault's three profiles, entered as `entries` says: profile name -> raffle TCINs. */
function entered(entries: Record<string, string[]>): DesiredProfile[] {
  return vaultProfiles().map((p) => ({ ...p, raffles: entries[p.name] ?? [] }));
}

async function build(
  profiles: DesiredProfile[],
  {
    raffles = [RAFFLE_R],
    opts = {},
    fixture = cleanBackup,
    bytes,
    absent = {},
  }: {
    raffles?: DesiredRaffle[];
    opts?: Partial<BuildOptions>;
    fixture?: () => Promise<{ bytes: Uint8Array }>;
    /** A file to build on instead of a fresh fixture. */
    bytes?: Uint8Array;
    absent?: Record<string, KnownProfile["why"]>;
  } = {},
) {
  const SQL = await sqljs();
  const open = openBackup(SQL, bytes ?? (await fixture()).bytes);
  const baseline = tableHashes(open.db);
  const report = buildInstance(
    open.db,
    { ...desiredInstance(profiles, absent), raffles },
    options(opts),
  );
  const diff = diffTables(baseline, tableHashes(open.db));
  return { db: open.db, report, diff };
}

const touched = (diff: TableDiff[]) =>
  Object.fromEntries(
    diff
      .filter((d) => d.added + d.removed + d.changed > 0)
      .map((d) => [d.table, { added: d.added, removed: d.removed, changed: d.changed }]),
  );

type Entry = {
  id: number;
  profile: string;
  type: string;
  flow_key: string;
  target_kind: string | null;
  options: string;
  generic_data: string;
  state: string;
  imap_account_id: number | null;
  proxy_group_id: number | null;
  pinned: number;
  fingerprint_name: string;
  method: string;
  sku: string;
  qty: number | null;
  min_price: number | null;
  max_price: number | null;
};

/** A group's tasks as Shikari lists them -- by place, or by id before tasks had one. */
function entries(db: ShikariDb, group: string): Entry[] {
  const ordered = db
    .all<{ name: string }>('PRAGMA table_info("task")')
    .some((c) => c.name === "order_index");
  return db.all<Entry>(
    `SELECT t.id, p.name AS profile, t.type, t.flow_key, t.target_kind, t.options, t.generic_data,
            t.state, t.imap_account_id, b.proxy_group_id, (b.proxy_id IS NOT NULL) AS pinned,
            b.fingerprint_name, tp.target_method AS method, tp.target_data AS sku, tp.qty,
            tp.min_price, tp.max_price
       FROM task t JOIN task_group g ON g.id = t.task_group_id
       JOIN profile p ON p.id = t.profile_id JOIN browser b ON b.id = t.browser_id
       LEFT JOIN target_product tp ON tp.task_id = t.id
      WHERE g.name = ? ORDER BY ${ordered ? "t.order_index, " : ""}t.id`,
    [group],
  );
}

const groupNames = (db: ShikariDb) =>
  db.all<{ name: string }>("SELECT name FROM task_group ORDER BY id").map((g) => g.name);

describe("raffle groups", () => {
  it("gives each raffle a group of its own, with an entry per profile in member order", async () => {
    const { db, report, diff } = await build(
      entered({
        "alice - 1": [SKU_R, SKU_S],
        "alice - 2": [SKU_R],
        "bob - 1": [SKU_R],
      }),
      { raffles: [RAFFLE_R, RAFFLE_S] },
    );

    const r = entries(db, GROUP_R);
    expect(r.map((e) => e.profile)).toEqual(["alice - 1", "alice - 2", "bob - 1"]);
    expect(entries(db, GROUP_S).map((e) => e.profile)).toEqual(["alice - 1"]);
    // Shaped like the Draw tasks Shikari makes: the TCIN entered, nothing bought, no limits.
    for (const e of r) {
      expect(e).toMatchObject({
        type: "Draw",
        flow_key: "draw",
        target_kind: "drawing_entry",
        options: '{"login_method": "password"}',
        generic_data: "{}",
        state: "{}",
        method: "drawing_entry",
        sku: SKU_R,
        qty: null,
        min_price: null,
        max_price: null,
        // The checkout proxy group, pinned, as the entries made in Shikari are.
        proxy_group_id: TASKS.checkoutProxyGroupId,
        pinned: 1,
      });
      // A checkout task's fingerprint: there were no entries to go by.
      expect(["macOS-Chrome-c1.json", "macOS-Chrome-c2.json"]).toContain(e.fingerprint_name);
    }
    // Each reads its own profile's mailbox, as its checkout task does; bob has none.
    expect(r.map((e) => e.imap_account_id)).toEqual([1, 1, null]);
    expect(db.get("SELECT color FROM task_group WHERE name = ?", [GROUP_R])).toEqual({
      color: "#F09300",
    });

    expect(report.raffles).toEqual({
      groups: [
        {
          sku: SKU_R,
          product: "Product R",
          name: GROUP_R,
          created: true,
          renamedFrom: null,
          added: ["alice - 1", "alice - 2", "bob - 1"],
          removed: [],
          changed: [],
          unchanged: 0,
          untouched: [],
        },
        {
          sku: SKU_S,
          product: "Product S",
          name: GROUP_S,
          created: true,
          renamedFrom: null,
          added: ["alice - 1"],
          removed: [],
          changed: [],
          unchanged: 0,
          untouched: [],
        },
      ],
      removed: [],
      missingProfile: [],
      template: "built-in",
    });
    // Nothing else moved: the checkout tasks and watchdogs are as they were.
    expect(report.checkout.unchanged).toBe(3);
    expect(touched(diff)).toEqual({
      task_group: { added: 2, removed: 0, changed: 0 },
      task: { added: 4, removed: 0, changed: 0 },
      browser: { added: 4, removed: 0, changed: 0 },
      cookie_jar: { added: 4, removed: 0, changed: 0 },
      target_product: { added: 4, removed: 0, changed: 0 },
    });
  });

  it("changes nothing the second time", async () => {
    const profiles = entered({ "alice - 1": [SKU_R], "bob - 1": [SKU_R] });
    const first = await build(profiles);
    const again = await build(profiles, { bytes: first.db.bytes() });
    expect(touched(again.diff)).toEqual({});
    expect(again.report.raffles.groups).toMatchObject([
      { name: GROUP_R, created: false, added: [], removed: [], changed: [], unchanged: 2 },
    ]);
  });

  it("gives a raffle nobody here entered no group, and a profile in no raffle no entry", async () => {
    const { db, report, diff } = await build(entered({}), { raffles: [RAFFLE_R, RAFFLE_S] });
    expect(groupNames(db).filter((name) => name.startsWith("Target Raffle"))).toEqual([]);
    expect(report.raffles.groups).toEqual([]);
    expect(touched(diff)).toEqual({});
  });

  it("takes over a raffle group made by hand, keeping each entry's browser and state", async () => {
    const before = await withRaffleGroup(cleanBackup)();
    const kept = entries(before.db, "Target - Raffle").find((e) => e.profile === "alice - 1")!;

    const { db, report } = await build(entered({ "alice - 1": [SKU_R], "alice - 2": [SKU_R] }), {
      bytes: before.bytes,
    });

    expect(groupNames(db)).toContain(GROUP_R);
    expect(groupNames(db)).not.toContain("Target - Raffle");
    const r = entries(db, GROUP_R);
    expect(r.map((e) => e.profile)).toEqual(["alice - 1", "alice - 2"]);
    // alice - 1's is the one she had -- same task, browser, fingerprint and Shikari's state --
    // now reading her mailbox.
    expect(r[0]).toMatchObject({
      id: kept.id,
      fingerprint_name: kept.fingerprint_name,
      state: kept.state,
      imap_account_id: 1,
    });
    // alice - 2's is new, a copy of the backup's own entries.
    expect(r[1]).toMatchObject({
      options: '{"login_method": "password"}',
      fingerprint_name: "macOS-Chrome-d1.json",
      state: "{}",
    });
    expect(report.raffles).toMatchObject({
      groups: [
        {
          name: GROUP_R,
          created: false,
          renamedFrom: "Target - Raffle",
          added: ["alice - 2"],
          // bob isn't entered any more.
          removed: ["bob - 1"],
          changed: [{ profile: "alice - 1", what: ["mailbox"] }],
          unchanged: 0,
        },
      ],
      template: "copied",
    });
  });

  it("finds a raffle's group by its name before the TCIN its entries are for", async () => {
    const { db } = await withRaffleGroup(cleanBackup)();
    // A group already named for Product R, empty, beside the hand-made one.
    db.run(
      `INSERT INTO task_group (created_at, name, color, order_index) VALUES ('2026-11-19', ?, '#F09300', 99)`,
      [GROUP_R],
    );
    const { db: out, report } = await build(entered({ "alice - 1": [SKU_R] }), {
      bytes: db.bytes(),
    });
    // Its entry moved into the group named for it; the hand-made one, emptied, came out.
    expect(entries(out, GROUP_R).map((e) => e.profile)).toEqual(["alice - 1"]);
    expect(report.raffles.groups[0]).toMatchObject({
      renamedFrom: null,
      changed: [{ profile: "alice - 1", what: ['moved in from "Target - Raffle"', "mailbox"] }],
    });
    expect(report.raffles.removed).toEqual([
      { name: "Target - Raffle", why: `its raffle's entries are in "${GROUP_R}"`, tasks: 1 },
    ]);
    expect(groupNames(out)).not.toContain("Target - Raffle");
  });

  it("takes a raffle's group out when nobody on this instance is entered", async () => {
    const { db, report } = await build(entered({}), { fixture: withRaffleGroup(cleanBackup) });
    expect(groupNames(db)).not.toContain("Target - Raffle");
    expect(report.raffles.removed).toEqual([
      { name: "Target - Raffle", why: "nobody on this instance is entered", tasks: 2 },
    ]);
  });

  it("takes a raffle group out once its raffle is off the site, and says so once", async () => {
    const { db, report, diff } = await build(entered({}), {
      raffles: [],
      fixture: withRaffleGroup(cleanBackup),
    });
    expect(groupNames(db)).not.toContain("Target - Raffle");
    expect(report.raffles.removed).toEqual([
      { name: "Target - Raffle", why: "its raffle isn't on the site", tasks: 2 },
    ]);
    // The raffle section said it; the generic clean-up doesn't say it again.
    expect(report.groupsRemoved.task).toEqual([]);
    expect(touched(diff)).toEqual({
      task_group: { added: 0, removed: 1, changed: 0 },
      task: { added: 0, removed: 2, changed: 0 },
      browser: { added: 0, removed: 2, changed: 0 },
      cookie_jar: { added: 0, removed: 2, changed: 0 },
      target_product: { added: 0, removed: 2, changed: 0 },
    });
  });

  it("keeps one entry per profile per raffle, and takes a second copy out", async () => {
    const { db } = await withRaffleGroup(cleanBackup)();
    // A second entry for alice - 1 in Product R, in another group of the same kind.
    const group = db.insert(
      "INSERT INTO task_group (created_at, name, color, order_index) VALUES ('2026-11-19', 'Target Raffle copy', '#F09300', 98)",
    );
    const browser = db.insert(
      "INSERT INTO browser (created_at, proxy_group_id, proxy_id, fingerprint_name) VALUES ('2026-11-19', 1, NULL, 'macOS-Chrome-d1.json')",
    );
    const task = db.insert(
      `INSERT INTO task (created_at, task_group_id, running, preloaded, type, website_id, profile_id, generic_data,
                         browser_id, flow_key, options, state, target_kind, order_index)
       VALUES ('2026-11-19', ?, 0, 0, 'Draw', 5, 1, '{}', ?, 'draw', '{}', '{}', 'drawing_entry', 0)`,
      [group, browser],
    );
    db.run(
      "INSERT INTO target_product (created_at, task_id, target_method, target_data, miscellaneous_data) VALUES ('2026-11-19', ?, 'drawing_entry', ?, '{}')",
      [task, SKU_R],
    );

    const { db: out, report } = await build(entered({ "alice - 1": [SKU_R], "bob - 1": [SKU_R] }), {
      bytes: db.bytes(),
    });
    expect(entries(out, GROUP_R).map((e) => e.profile)).toEqual(["alice - 1", "bob - 1"]);
    expect(out.get("SELECT 1 FROM task WHERE id = ?", [task])).toBeNull();
    expect(report.raffles.groups[0].removed).toEqual(["alice - 1 (a second copy)"]);
    expect(report.raffles.removed).toEqual([
      { name: "Target Raffle copy", why: `its raffle's entries are in "${GROUP_R}"`, tasks: 1 },
    ]);
  });

  it("takes a profile's entry out with the profile, under its raffle, without a warning", async () => {
    // bob runs on another instance now, so he comes out of this backup with his entry.
    const { db, report } = await build(
      entered({ "alice - 1": [SKU_R] }).filter((p) => p.name !== "bob - 1"),
      { fixture: withRaffleGroup(cleanBackup), absent: { "bob - 1": "member" } },
    );
    expect(entries(db, GROUP_R).map((e) => e.profile)).toEqual(["alice - 1"]);
    expect(report.raffles.groups[0].removed).toEqual(["bob - 1"]);
    expect(report.warnings.filter((w) => /Draw/.test(w))).toEqual([]);
  });

  it("says when a profile is in raffles only, and gives it no checkout task", async () => {
    const list = entered({ "bob - 1": [SKU_R] });
    list[2].skus = [];
    const { report } = await build(list);
    expect(report.profiles.deactivated).toEqual([
      { name: "bob - 1", owner: "bob", why: "entered in raffles only" },
    ]);
    expect(report.raffles.groups[0].added).toEqual(["bob - 1"]);
  });

  it("names a profile entered that isn't in the backup, and gives it no entry", async () => {
    const carol: DesiredProfile = {
      ...vaultProfiles()[2],
      key: "vault-carol-1",
      name: "carol - 1",
      email: "carol1@example.com",
      raffles: [SKU_R],
    };
    const { report } = await build([...entered({ "alice - 1": [SKU_R] }), carol], {
      opts: { sections: { ...ALL_SECTIONS, profiles: false } },
    });
    expect(report.raffles.missingProfile).toEqual(["carol - 1 (Product R)"]);
    expect(report.raffles.groups[0].added).toEqual(["alice - 1"]);
  });

  it("lays a group out by id in a backup from before tasks had a place", async () => {
    // bob - 1's entry has a lower id than the one alice - 2 is about to get.
    const { db, report } = await build(
      entered({ "alice - 1": [SKU_R], "alice - 2": [SKU_R], "bob - 1": [SKU_R] }),
      { fixture: legacy(withRaffleGroup(cleanBackup)) },
    );
    expect(entries(db, GROUP_R).map((e) => e.profile)).toEqual([
      "alice - 1",
      "alice - 2",
      "bob - 1",
    ]);
    expect(report.raffles.groups[0].added).toEqual(["alice - 2"]);
  });

  it("leaves raffle groups exactly as they are with the section off", async () => {
    const { diff, report } = await build(entered({ "alice - 2": [SKU_R] }), {
      raffles: [RAFFLE_R, RAFFLE_S],
      fixture: withRaffleGroup(cleanBackup),
      opts: { sections: { ...ALL_SECTIONS, raffles: false } },
    });
    expect(touched(diff)).toEqual({});
    expect(report.raffles).toEqual({
      groups: [],
      removed: [],
      missingProfile: [],
      template: null,
    });
  });

  describe("on a main instance", () => {
    const fixture = withRaffleGroup(mainInstanceBackup);
    const main = (profiles: DesiredProfile[], raffles: DesiredRaffle[]) =>
      build(profiles, {
        raffles,
        fixture,
        absent: { "alice - 6": "backup" },
      });

    it("leaves another runner's entry in the group alone", async () => {
      const { db, report } = await main(entered({ "alice - 1": [SKU_R] }), [RAFFLE_R]);
      expect(entries(db, GROUP_R).map((e) => e.profile)).toEqual(["alice - 1", "crisp 81"]);
      expect(report.raffles.groups[0]).toMatchObject({
        added: [],
        removed: ["bob - 1"],
        untouched: ["crisp 81"],
      });
    });

    it("keeps a group still holding another runner's entry, and says why", async () => {
      const { db, report } = await main(entered({}), []);
      expect(entries(db, "Target - Raffle").map((e) => e.profile)).toEqual(["crisp 81"]);
      expect(report.raffles.removed).toEqual([]);
      expect(report.warnings).toContain(
        `"Target - Raffle" holds 1 task the export leaves alone, so it was kept, though its raffle isn't on the site.`,
      );
    });

    it("never touches Walmart's raffle tasks", async () => {
      const before = await fixture();
      const walmart = (db: ShikariDb) =>
        JSON.stringify(db.values("SELECT * FROM task WHERE website_id <> 5 ORDER BY id"));
      const { db } = await main(entered({ "alice - 1": [SKU_R, SKU_A] }), [RAFFLE_R]);
      expect(walmart(db)).toBe(walmart(before.db));
      expect(groupNames(db)).toContain("Walmart Raffle Entry");
    });
  });
});

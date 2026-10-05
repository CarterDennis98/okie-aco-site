/**
 * The Shikari export's builder, against a synthetic backup on Shikari's real schema.
 *
 * The properties with something behind them:
 *   - an export leaves the Target side CLEAN: this instance's active profiles, their logins,
 *     mailboxes and tasks, and nothing else -- and a clean backup exported again is unchanged,
 *     row for row;
 *   - what changes is updated where it stands -- ids survive, so do sessions, browsers and
 *     sticky proxies -- and nothing that isn't Target is touched;
 *   - every profile is sorted into new, activated, updated, deactivated or removed, with why;
 *   - watchdogs split at 30 products, three per list, plus the remote one;
 *   - a swapped proxy list keeps its ids and re-pins what lost its proxy;
 *   - wipes are copied from the backup's own Wipe Account task, or built in Shikari's shape.
 */
import { describe, expect, it } from "vitest";
import { BuildError, buildInstance } from "@/lib/shikari/build";
import { diffTables, forbiddenChanges, tableHashes, type TableDiff } from "@/lib/shikari/diff";
import { backupBytes, openBackup, type ShikariDb } from "@/lib/shikari/sqlite";
import type { BuildOptions, DesiredProfile, KnownProfile } from "@/lib/shikari/types";
import {
  ALL_SECTIONS,
  SKU_A,
  SKU_B,
  TASKS,
  aliceSix,
  cleanBackup,
  desiredInstance,
  fixtureBackup,
  mainInstanceBackup,
  seeded,
  sqljs,
  vaultProfiles,
} from "../../../tests/shikari/fixture";

function options(over: Partial<BuildOptions> = {}): BuildOptions {
  return {
    sections: ALL_SECTIONS,
    removeProfileGroups: [],
    proxyLists: [],
    tasks: TASKS,
    now: new Date("2026-10-05T12:00:00.000Z"),
    random: seeded(),
    ...over,
  };
}

/** Builds against a fresh fixture; returns the edited database and the table-level diff. */
async function build(
  profiles: DesiredProfile[] = vaultProfiles(),
  opts: Partial<BuildOptions> = {},
  fixture: () => Promise<{ bytes: Uint8Array }> = cleanBackup,
  absent: Record<string, KnownProfile["why"]> = {},
) {
  const { bytes } = await fixture();
  const SQL = await sqljs();
  const open = openBackup(SQL, bytes);
  const baseline = tableHashes(open.db);
  const report = buildInstance(open.db, desiredInstance(profiles, absent), options(opts));
  const diff = diffTables(baseline, tableHashes(open.db));
  return { db: open.db, report, diff, open };
}

const changesIn = (diff: TableDiff[], table: string) => {
  const row = diff.find((d) => d.table === table);
  return row ? { added: row.added, removed: row.removed, changed: row.changed } : null;
};

const touched = (diff: TableDiff[]) =>
  Object.fromEntries(
    diff
      .filter((d) => d.added + d.removed + d.changed > 0)
      .map((d) => [d.table, { added: d.added, removed: d.removed, changed: d.changed }]),
  );

const profiles = (mutate: (list: DesiredProfile[]) => void) => {
  const list = vaultProfiles();
  mutate(list);
  return list;
};

describe("buildInstance", () => {
  it("cleans out everything on the Target side that isn't this instance's, and says why", async () => {
    const { db, report, diff } = await build(undefined, {}, fixtureBackup);
    expect(report.profiles).toEqual({
      added: [],
      updated: [],
      activated: [],
      // Running before -- its checkout task had a product -- so deactivated, not just removed.
      deactivated: [{ name: "stranger - 1", why: "not on the site", group: "Target" }],
      removed: [{ name: "Target 11", why: "switched off", group: "Target Paused" }],
      unchanged: 3,
      duplicates: [],
      kept: [],
    });
    // Its login went with it, and so did the house profile's, and one nobody has had in years.
    expect(report.accounts).toMatchObject({ removed: 3, unchanged: 3 });
    expect(db.all("SELECT username FROM account ORDER BY id")).toEqual([
      { username: "alice1@example.com" },
      { username: "alice2@example.com" },
      { username: "bob1@example.com" },
    ]);
    // Alice's old hand-made wipe, and the two groups left empty.
    expect(report.wipes).toMatchObject({ removed: 1, added: [] });
    expect(report.groupsRemoved).toEqual({ profile: ["Target Paused"], task: ["Target Wipe"] });
    expect(report.checkout.removed).toEqual([{ profile: "stranger - 1", skus: 1 }]);
    expect(touched(diff)).toEqual({
      profile: { added: 0, removed: 2, changed: 0 },
      address: { added: 0, removed: 2, changed: 0 },
      credit_card: { added: 0, removed: 2, changed: 0 },
      account: { added: 0, removed: 3, changed: 0 },
      // stranger's checkout task and alice's old wipe, with their browsers and cookie jars.
      task: { added: 0, removed: 2, changed: 0 },
      browser: { added: 0, removed: 2, changed: 0 },
      cookie_jar: { added: 0, removed: 2, changed: 0 },
      target_product: { added: 0, removed: 1, changed: 0 },
      task_group: { added: 0, removed: 1, changed: 0 },
      profile_group: { added: 0, removed: 1, changed: 0 },
    });
    // The mailbox stays: alice reads her codes there.
    expect(report.imap).toMatchObject({ removed: 0, unchanged: 1 });
  });

  it("changes nothing at all in a backup that is already clean", async () => {
    const { report, diff } = await build();
    expect(touched(diff)).toEqual({});
    expect(report.profiles).toMatchObject({
      added: [],
      updated: [],
      activated: [],
      deactivated: [],
      removed: [],
      unchanged: 3,
    });
    expect(report.checkout).toMatchObject({ added: [], removed: [], changed: [], unchanged: 3 });
    expect(report.accounts).toMatchObject({ unchanged: 3, removed: 0 });
    expect(report.imap).toMatchObject({ unchanged: 1, removed: 0 });
    expect(report.strays).toBe(0);
    expect(report.groupsRemoved).toEqual({ profile: [], task: [] });
    expect(report.watchdogs.after).toEqual(
      [3333, 4444, 5555].map((interval) => ({ interval, skus: [SKU_A, SKU_B] })),
    );
  });

  it("sorts every profile into new, activated, updated, deactivated or removed", async () => {
    // The house profile parked in "Target Paused", exactly as the backup has it.
    const house: DesiredProfile = {
      ...vaultProfiles()[2],
      key: "vault-house-11",
      ownerName: "Carter",
      name: "Target 11",
      email: "house11@example.com",
      shipping: {
        firstName: "House",
        lastName: "Tester",
        street: "5 Pine St",
        street2: "",
        city: "Oklahoma City",
        state: "OK",
        zip: "73170",
        country: "US",
        phone: "4055550105",
      },
      card: { number: "4242424242424242", expMonth: 6, expYear: 2032, cvv: "999" },
      password: "house-pass",
      skus: [SKU_A],
    };
    const carol: DesiredProfile = {
      ...vaultProfiles()[2],
      key: "vault-carol-1",
      ownerName: "carol",
      name: "carol - 1",
      email: "carol1@example.com",
      password: "carol-pass",
      skus: [SKU_B],
    };
    const list = profiles((all) => {
      all[0].card = { ...all[0].card, cvv: "321" };
      all[2].skus = [];
    });
    const { report } = await build([...list, house, carol], {}, fixtureBackup);
    expect(report.profiles).toMatchObject({
      added: [{ name: "carol - 1", owner: "carol" }],
      // Parked, now picked: back in "Target" with a task, which says activated -- not
      // "updated" with a move, since that is what the move means.
      activated: [{ name: "Target 11", owner: "Carter", why: 'was in "Target Paused"' }],
      updated: [{ name: "alice - 1", owner: "alice", fields: ["CVV"] }],
      deactivated: [
        { name: "bob - 1", owner: "bob", why: "picked no products" },
        { name: "stranger - 1", why: "not on the site", group: "Target" },
      ],
      removed: [],
      unchanged: 1,
    });
  });

  it("says where a profile went when another instance of the same export runs it", async () => {
    const desired = desiredInstance(vaultProfiles().filter((p) => p.name !== "bob - 1"));
    const bob = desired.known.find((k) => k.name === "bob - 1");
    Object.assign(bob!, { why: "member", instance: 2 });
    const { bytes } = await cleanBackup();
    const open = openBackup(await sqljs(), bytes);
    const report = buildInstance(open.db, desired, options());
    expect(report.profiles.deactivated).toEqual([
      { name: "bob - 1", why: "runs on Instance 2", group: "Target" },
    ]);
  });

  it("takes a profile this instance no longer runs out, with its task, login and rows", async () => {
    const { db, report, diff } = await build(
      vaultProfiles().filter((p) => p.name !== "bob - 1"),
      {},
      cleanBackup,
      { "bob - 1": "backup" },
    );
    expect(report.profiles.deactivated).toEqual([
      { name: "bob - 1", why: "runs on a backup bot", group: "Target" },
    ]);
    expect(report.checkout.removed).toEqual([{ profile: "bob - 1", skus: 1 }]);
    expect(report.accounts.removed).toBe(1);
    expect(db.get("SELECT 1 FROM profile WHERE id = 3")).toBeNull();
    expect(touched(diff)).toEqual({
      profile: { added: 0, removed: 1, changed: 0 },
      address: { added: 0, removed: 1, changed: 0 },
      credit_card: { added: 0, removed: 1, changed: 0 },
      account: { added: 0, removed: 1, changed: 0 },
      task: { added: 0, removed: 1, changed: 0 },
      browser: { added: 0, removed: 1, changed: 0 },
      cookie_jar: { added: 0, removed: 1, changed: 0 },
      target_product: { added: 0, removed: 1, changed: 0 },
    });
    // Bob's SKU B is still watched -- alice - 1 runs it too.
    expect(report.watchdogs.after[0].skus).toEqual([SKU_A, SKU_B]);
  });

  it("leaves a profile another site's task uses where it is, and says so", async () => {
    const { bytes } = await cleanBackup();
    const open = openBackup(await sqljs(), bytes);
    open.db.run(
      "INSERT INTO browser (id, created_at, proxy_group_id, proxy_id, fingerprint_name, cookie_jar_id) VALUES (90, NULL, 1, NULL, 'x.json', NULL)",
    );
    open.db.run(
      "INSERT INTO task (id, created_at, task_group_id, running, preloaded, type, website_id, profile_id, generic_data, browser_id, flow_key, options, state, target_kind) VALUES (90, NULL, 1, 0, 0, 'Draw Joiner', 3, 3, '{}', 90, 'draw_joiner', '{}', '{}', 'pid')",
    );
    const report = buildInstance(
      open.db,
      desiredInstance(vaultProfiles().filter((p) => p.name !== "bob - 1")),
      options(),
    );
    expect(report.warnings.join(" ")).toMatch(
      /Used by a task for another site, so left where they are: bob - 1 \(in "Target"\)/,
    );
    expect(open.db.get("SELECT 1 AS kept FROM profile WHERE id = 3")).toEqual({ kept: 1 });
    expect(open.db.get("SELECT 1 AS kept FROM task WHERE id = 90")).toEqual({ kept: 1 });
    // Its Target checkout task still came off, so it isn't running: deactivated, not removed.
    expect(report.profiles.deactivated.map((p) => p.name)).toEqual(["bob - 1"]);
    expect(report.profiles.removed).toEqual([]);
  });

  it("updates a changed card and address in the rows they already had", async () => {
    const { db, report, diff } = await build(
      profiles((list) => {
        list[0].shipping.street = "100 New Rd";
        list[0].card = { number: "4012888888881881", expMonth: 10, expYear: 2033, cvv: "999" };
      }),
    );
    expect(report.profiles.updated).toEqual([
      { name: "alice - 1", owner: "alice", fields: ["street", "card", "card expiry", "CVV"] },
    ]);
    const row = db.get<{
      shipping_address_id: number;
      billing_address_id: number;
      credit_card_id: number;
    }>("SELECT shipping_address_id, billing_address_id, credit_card_id FROM profile WHERE id = 1");
    // Same rows, new values -- and billing still shares the shipping row.
    expect(row).toEqual({ shipping_address_id: 1, billing_address_id: 1, credit_card_id: 1 });
    expect(db.get("SELECT street FROM address WHERE id = 1")).toEqual({ street: "100 New Rd" });
    expect(
      db.get("SELECT card_number, expire_month, expire_year, cvv FROM credit_card WHERE id = 1"),
    ).toEqual({
      card_number: "4012888888881881",
      expire_month: 10,
      expire_year: 2033,
      cvv: "999",
    });
    expect(touched(diff)).toEqual({
      address: { added: 0, removed: 0, changed: 1 },
      credit_card: { added: 0, removed: 0, changed: 1 },
      profile: { added: 0, removed: 0, changed: 1 },
    });
  });

  it("changes a password without touching the session beside it", async () => {
    const { db, report, diff } = await build(
      profiles((list) => (list[0].password = "brand-new-pass")),
    );
    expect(report.accounts.updated).toEqual(["alice1@example.com"]);
    expect(
      db.get(
        "SELECT password, session_data, cookie_jar_id, mobile_cookie_jar_id FROM account WHERE username = 'alice1@example.com'",
      ),
    ).toEqual({
      password: "brand-new-pass",
      session_data: '{"mobile_session": {"token": "live"}}',
      cookie_jar_id: expect.any(Number),
      mobile_cookie_jar_id: expect.any(Number),
    });
    expect(changesIn(diff, "account")).toEqual({ added: 0, removed: 0, changed: 1 });
    expect(changesIn(diff, "cookie_jar")).toEqual({ added: 0, removed: 0, changed: 0 });
  });

  it("keeps the login a profile signs in with when it is on file twice, and drops the other", async () => {
    // The main instance's pattern: an older login with the session, a newer one in lower
    // case an import added beside it.
    const { bytes } = await cleanBackup();
    const SQL = await sqljs();
    const twin = openBackup(SQL, bytes);
    twin.db.run(
      "INSERT INTO account (id, created_at, username, password, website_id, generic_data, session_data) VALUES (50, NULL, 'Alice1@Example.com', 'alice-pass-1', 5, '{}', '{}')",
    );
    const report = buildInstance(
      twin.db,
      desiredInstance(profiles((list) => (list[0].password = "brand-new-pass"))),
      options(),
    );
    expect(report.accounts).toMatchObject({ updated: ["alice1@example.com"], removed: 1 });
    expect(
      twin.db.get("SELECT id, password FROM account WHERE lower(username) = 'alice1@example.com'"),
    ).toEqual({
      id: 1,
      password: "brand-new-pass",
    });

    // And the other way round: when only the newer one holds a session, that one is kept.
    const flipped = openBackup(SQL, bytes);
    flipped.db.run(
      "INSERT INTO account (id, created_at, username, password, website_id, generic_data, session_data) VALUES (50, NULL, 'BOB1@example.com', 'bob-pass-1', 5, '{}', '{\"mobile_session\": {}}')",
    );
    buildInstance(flipped.db, desiredInstance(), options());
    expect(
      flipped.db.all("SELECT id FROM account WHERE lower(username) = 'bob1@example.com'"),
    ).toEqual([{ id: 50 }]);
  });

  it("splits shipping and billing into two rows, and joins them back", async () => {
    // alice - 1 shares one row; giving her a billing address needs a second.
    const split = await build(
      profiles((list) => (list[0].billing = { ...list[0].shipping, street: "77 Billing Way" })),
    );
    expect(split.report.profiles.updated[0].fields).toEqual(["billing address"]);
    const row = split.db.get<{ shipping_address_id: number; billing_address_id: number }>(
      "SELECT shipping_address_id, billing_address_id FROM profile WHERE id = 1",
    );
    expect(row?.billing_address_id).not.toBe(row?.shipping_address_id);

    // alice - 2 has two; making billing her shipping drops the spare row.
    const joined = await build(profiles((list) => (list[1].billing = null)));
    expect(joined.report.profiles.updated[0].fields).toEqual([
      "billing address (now the shipping address)",
    ]);
    expect(
      joined.db.get(
        "SELECT shipping_address_id = billing_address_id AS same FROM profile WHERE id = 2",
      ),
    ).toEqual({
      same: 1,
    });
    expect(changesIn(joined.diff, "address")).toEqual({ added: 0, removed: 1, changed: 0 });
  });

  it("adds a new member's profile, account, mailbox and checkout task", async () => {
    const carol: DesiredProfile = {
      ...vaultProfiles()[2],
      key: "vault-carol-1",
      ownerName: "carol",
      name: "carol - 1",
      email: "carol1@example.com",
      password: "carol-pass",
      mailbox: {
        server: "imap.mail.yahoo.com",
        port: 993,
        username: "carol@yahoo.com",
        password: "carol app",
      },
      skus: [SKU_B],
    };
    const { db, report } = await build([...vaultProfiles(), carol]);
    expect(report.profiles.added).toEqual([{ name: "carol - 1", owner: "carol" }]);
    expect(report.accounts.added).toEqual(["carol1@example.com"]);
    expect(report.imap.added).toEqual(["carol@yahoo.com"]);
    expect(report.checkout.added).toEqual([{ profile: "carol - 1", skus: 1 }]);

    const task = db.get<Record<string, unknown>>(
      `SELECT t.*, b.proxy_group_id, b.proxy_id, b.fingerprint_name, i.username AS mailbox
         FROM task t JOIN profile p ON p.id = t.profile_id JOIN browser b ON b.id = t.browser_id
         LEFT JOIN imap_account i ON i.id = t.imap_account_id
        WHERE p.name = 'carol - 1'`,
    );
    expect(task).toMatchObject({
      task_group_id: 1,
      type: "Checkout",
      flow_key: "checkout",
      target_kind: "tcins",
      website_id: 5,
      preloaded: 0,
      state: "{}",
      proxy_group_id: 1,
      mailbox: "carol@yahoo.com",
      created_at: "2026-10-05 12:00:00.000000",
    });
    // Copied from the backup's own checkout tasks, Python-formatted as Shikari writes it.
    expect(String(task?.options)).toContain('"login_method": "password"');
    // Pinned to a Resi proxy nobody else uses, wearing a fingerprint a checkout task wears.
    expect([8, 9, 10]).toContain(task?.proxy_id);
    expect(["macOS-Chrome-c1.json", "macOS-Chrome-c2.json"]).toContain(task?.fingerprint_name);
    expect(
      db.all("SELECT target_data, qty FROM target_product WHERE task_id = ?", [Number(task?.id)]),
    ).toEqual([{ target_data: SKU_B, qty: 2 }]);
  });

  it("moves a picked product onto a task in place, and drops one that was unpicked", async () => {
    const { report, db } = await build(profiles((list) => (list[2].skus = [SKU_A])));
    expect(report.checkout.changed).toEqual([
      { profile: "bob - 1", added: [SKU_A], removed: [SKU_B], other: [] },
    ]);
    // Same task, same browser: its preload state is the thing an export must not cost it.
    expect(db.get("SELECT preloaded, browser_id FROM task WHERE id = 7")).toEqual({
      preloaded: 1,
      browser_id: 8,
    });
  });

  it("gives a profile that picked nothing no checkout task, but keeps the profile", async () => {
    const { report, db } = await build(profiles((list) => (list[2].skus = [])));
    expect(report.checkout.noProducts).toEqual(["bob - 1"]);
    expect(report.checkout.removed).toEqual([{ profile: "bob - 1", skus: 1 }]);
    expect(db.get("SELECT 1 FROM task WHERE id = 7")).toBeNull();
    expect(report.profiles.deactivated).toEqual([
      { name: "bob - 1", owner: "bob", why: "picked no products" },
    ]);
    // Still one of this instance's: profile and login stay, ready for the next drop.
    expect(db.get("SELECT 1 AS kept FROM profile WHERE id = 3")).toEqual({ kept: 1 });
    expect(report.accounts.removed).toBe(0);
  });

  it("splits watchdogs at 30 products, three per list, each new one on a fresh device", async () => {
    const skus = Array.from({ length: 35 }, (_, i) => String(91000000 + i));
    const list = profiles((all) => (all[0].skus = skus));
    const { db, report } = await build(list);
    expect(report.watchdogs.after.map((w) => [w.interval, w.skus.length])).toEqual([
      [3333, 30],
      [4444, 30],
      [5555, 30],
      [3333, 7],
      [4444, 7],
      [5555, 7],
    ]);
    // 35 of the new ones plus A and B, which the other two profiles still run.
    expect(new Set(report.watchdogs.after.flatMap((w) => w.skus)).size).toBe(37);
    expect(report.watchdogs.remote).toEqual({ before: 1, after: 1 });

    const devices = db
      .all<{ generic_data: string; state: string }>(
        "SELECT generic_data, state FROM task WHERE flow_key = 'watchdog' AND target_kind = 'tcins'",
      )
      .map((t) => {
        const generic = JSON.parse(t.generic_data).ios_device_data.device_id;
        expect(JSON.parse(t.state).ios_device_data.device_id).toBe(generic);
        return generic;
      });
    expect(devices).toHaveLength(6);
    expect(new Set(devices).size).toBe(6);
  });

  it("removes surplus watchdogs, and their browsers, when the list shrinks", async () => {
    const skus = Array.from({ length: 35 }, (_, i) => String(91000000 + i));
    const { bytes } = await fixtureBackup();
    const SQL = await sqljs();
    const grown = openBackup(SQL, bytes);
    buildInstance(grown.db, desiredInstance(profiles((all) => (all[0].skus = skus))), options());
    const bigger = backupBytes(grown);

    const shrunk = openBackup(SQL, bigger);
    const report = buildInstance(shrunk.db, desiredInstance(), options());
    expect(report.watchdogs.before).toHaveLength(6);
    expect(report.watchdogs.after).toHaveLength(3);
    expect(
      shrunk.db.get(
        "SELECT COUNT(*) AS n FROM task WHERE flow_key = 'watchdog' AND target_kind = 'tcins'",
      ),
    ).toEqual({ n: 3 });
    expect(
      shrunk.db.get(
        "SELECT COUNT(*) AS n FROM browser WHERE id NOT IN (SELECT browser_id FROM task UNION SELECT browser_id FROM harvester)",
      ),
    ).toEqual({ n: 0 });
  });

  it("swaps a proxy list position by position, re-pinning browsers whose proxy went away", async () => {
    const replacement = Array.from({ length: 2 }, (_, i) => ({
      host: "new-resi.example.net",
      port: 9000 + i,
      username: `n${i}`,
      password: `p${i}`,
    }));
    const { db, report, diff } = await build(undefined, {
      proxyLists: [{ groupId: 1, proxies: replacement }],
    });
    // Bob's browser was pinned to the third.
    expect(report.proxies).toEqual([
      { group: "Resi", before: 6, after: 2, changed: 6, browsersMoved: 1 },
    ]);
    // Ids 5 and 6 kept, rewritten; 7-10 gone.
    expect(db.all("SELECT id, port FROM proxy WHERE proxy_group_id = 1 ORDER BY id")).toEqual([
      { id: 5, port: 9000 },
      { id: 6, port: 9001 },
    ]);
    // Every browser in the group points at a proxy that exists.
    expect(
      db.get(
        "SELECT COUNT(*) AS n FROM browser WHERE proxy_group_id = 1 AND proxy_id NOT IN (SELECT id FROM proxy WHERE proxy_group_id = 1)",
      ),
    ).toEqual({ n: 0 });
    expect(changesIn(diff, "proxy")).toEqual({ added: 0, removed: 4, changed: 2 });
  });

  it("copies the backup's own Wipe Account task for each pending change, and clears old ones", async () => {
    const { db, report } = await build(
      profiles((list) => {
        list[1].pending = { fields: ["card"] };
        list[2].pending = { fields: ["shipLine1"] };
      }),
      {},
      fixtureBackup,
    );
    // Alice - 1's hand-made one is the template, and then goes: her change was long ago.
    expect(report.wipes).toMatchObject({ template: "copied", removed: 1 });
    expect(report.wipes.added.map((w) => w.name)).toEqual(["alice - 2", "bob - 1"]);
    const wipes = db.all<Record<string, unknown>>(
      `SELECT t.type, t.flow_key, t.options, p.name, g.name AS grp, t.imap_account_id
         FROM task t JOIN profile p ON p.id = t.profile_id JOIN task_group g ON g.id = t.task_group_id
        WHERE t.flow_key = 'wipe_account' ORDER BY p.name`,
    );
    expect(wipes).toEqual([
      {
        type: "Wipe Account",
        flow_key: "wipe_account",
        options: '{"login_method": "password"}',
        name: "alice - 2",
        grp: "Target - Profile Updates",
        imap_account_id: 1,
      },
      {
        type: "Wipe Account",
        flow_key: "wipe_account",
        options: '{"login_method": "password"}',
        name: "bob - 1",
        grp: "Target - Profile Updates",
        imap_account_id: null,
      },
    ]);

    // The next export starts the group over: what's still pending is copied from last
    // time's, and what was confirmed since needs none.
    const again = buildInstance(
      db,
      desiredInstance(profiles((list) => (list[2].pending = { fields: ["shipLine1"] }))),
      options(),
    );
    expect(again.wipes).toMatchObject({
      template: "copied",
      removed: 2,
      added: [{ name: "bob - 1" }],
    });
  });

  it("builds wipes in Shikari's own shape when the backup has none to copy", async () => {
    const { db, report } = await build(
      profiles((list) => (list[0].pending = { fields: ["card"] })),
    );
    expect(report.wipes).toMatchObject({ template: "built-in", added: [{ name: "alice - 1" }] });
    expect(report.warnings).toEqual([]);
    expect(
      db.get(
        `SELECT t.type, t.flow_key, t.target_kind, t.options, t.generic_data, t.state, t.imap_account_id,
                b.proxy_group_id, b.proxy_id
           FROM task t JOIN browser b ON b.id = t.browser_id WHERE t.flow_key = 'wipe_account'`,
      ),
    ).toEqual({
      type: "Wipe Account",
      flow_key: "wipe_account",
      target_kind: null,
      options: "{}",
      generic_data: "{}",
      state: "{}",
      imap_account_id: null,
      proxy_group_id: 1,
      proxy_id: null,
    });
  });

  it("leaves every section that is switched off alone", async () => {
    const { diff } = await build(
      profiles((list) => {
        list[0].password = "changed";
        list[0].card.cvv = "000";
        list[2].skus = [SKU_A];
      }),
      {
        sections: {
          profiles: false,
          accounts: false,
          imap: false,
          proxies: false,
          tasks: false,
          wipes: false,
        },
      },
      fixtureBackup,
    );
    // Not even the clean-up: that is each section's own.
    expect(touched(diff)).toEqual({});
  });

  it("never touches the tables no export has any business changing", async () => {
    const carol = { ...vaultProfiles()[2], key: "c", name: "carol - 1", email: "c@example.com" };
    const { diff } = await build(
      [...vaultProfiles().slice(1), carol],
      {
        proxyLists: [
          { groupId: 0, proxies: [{ host: "1.2.3.4", port: 1, username: null, password: null }] },
        ],
      },
      fixtureBackup,
    );
    expect(forbiddenChanges(diff)).toEqual([]);
    expect(changesIn(diff, "harvester")).toEqual({ added: 0, removed: 0, changed: 0 });
  });

  it("refuses a backup that is missing something it needs, before changing anything", async () => {
    const { bytes } = await fixtureBackup();
    const SQL = await sqljs();
    const open = openBackup(SQL, bytes);
    open.db.run("ALTER TABLE task DROP COLUMN flow_key");
    expect(() => buildInstance(open.db, desiredInstance(), options())).toThrow(BuildError);
  });

  it("round-trips a WAL-mode backup and hands it back in WAL mode", async () => {
    const { bytes } = await fixtureBackup();
    const wal = new Uint8Array(bytes);
    wal[18] = 2;
    wal[19] = 2;
    const SQL = await sqljs();
    const open = openBackup(SQL, wal);
    expect(open.wal).toBe(true);
    buildInstance(
      open.db,
      desiredInstance(profiles((list) => (list[0].password = "x"))),
      options(),
    );
    const out = backupBytes(open);
    expect([out[18], out[19]]).toEqual([2, 2]);
    // And the input was never modified.
    expect([wal[18], wal[19]]).toEqual([2, 2]);
    const reread: ShikariDb = openBackup(await sqljs(), out).db;
    expect(
      reread.get("SELECT password FROM account WHERE username = 'alice1@example.com'"),
    ).toEqual({ password: "x" });
  });
});

/**
 * The main instance's arrangement (see mainInstanceBackup): Walmart and another runner's
 * members in the same database, the Target tasks under another group name and split across
 * two groups, parked profiles in groups of their own, and a real Wipe Account template.
 */
describe("buildInstance on a main instance", () => {
  const main = (list: DesiredProfile[] = vaultProfiles(), opts: Partial<BuildOptions> = {}) =>
    build(list, opts, mainInstanceBackup);

  /** One profile row, as stored. */
  const row = (db: ShikariDb, id: number) => db.get("SELECT * FROM profile WHERE id = ?", [id]);

  it("rebuilds its Target task group in place and renames it, gathering in tasks from other groups", async () => {
    const { db, report } = await main();
    expect(report.taskGroup).toEqual({
      name: "Target",
      renamedFrom: "Target - All Products",
      created: false,
    });
    expect(db.get("SELECT name FROM task_group WHERE id = 1")).toEqual({ name: "Target" });
    // alice - 2's task is the same task -- same browser, same preload -- now in "Target".
    expect(db.get("SELECT task_group_id, browser_id, preloaded FROM task WHERE id = 6")).toEqual({
      task_group_id: 1,
      browser_id: 7,
      preloaded: 1,
    });
    expect(report.checkout.changed).toEqual([
      {
        profile: "alice - 2",
        added: [],
        removed: [],
        // Its browser came out of the deleted proxy group too. It wasn't pinned, and isn't now.
        other: ['moved in from "NO IMAP"', "proxy group"],
      },
    ]);
    expect(db.get("SELECT proxy_group_id, proxy_id FROM browser WHERE id = 7")).toEqual({
      proxy_group_id: 1,
      proxy_id: null,
    });
    expect(report.checkout.added).toEqual([]);
    // Emptied by the move, and by clearing alice's old wipe: both gone.
    expect(report.groupsRemoved.task).toEqual(["Target Wipe Account", "NO IMAP"]);
  });

  it("leaves everything that isn't Target, and Target groups kept, exactly as they were", async () => {
    const { db: before } = await mainInstanceBackup();
    const { db, report } = await main(
      profiles((list) => {
        list[0].card = { number: "4012888888881881", expMonth: 2, expYear: 2034, cvv: "222" };
      }),
    );
    // Walmart's alice - 1 shares Target alice - 1's name and email; the card change went to
    // the Target one only.
    expect(row(db, 6)).toEqual(row(before, 6));
    expect(
      db.get(
        "SELECT card_number FROM credit_card WHERE id = (SELECT credit_card_id FROM profile WHERE id = 1)",
      ),
    ).toEqual({
      card_number: "4012888888881881",
    });
    // Parked (kept this time) and other runners' profiles, and the other runner's tasks.
    expect(row(db, 7)).toEqual(row(before, 7));
    expect(row(db, 8)).toEqual(row(before, 8));
    for (const id of [20, 21, 22]) {
      expect(db.get("SELECT * FROM task WHERE id = ?", [id])).toEqual(
        before.get("SELECT * FROM task WHERE id = ?", [id]),
      );
    }
    expect(db.all("SELECT * FROM target_product WHERE task_id IN (21, 22) ORDER BY id")).toEqual(
      before.all("SELECT * FROM target_product WHERE task_id IN (21, 22) ORDER BY id"),
    );
    // Alice's Walmart login, though her Target one shares its username.
    expect(db.get("SELECT * FROM account WHERE website_id = 3")).toEqual(
      before.get("SELECT * FROM account WHERE website_id = 3"),
    );
    expect(report.profiles.kept).toEqual([
      { group: "Walmart", count: 1, why: "not Target" },
      { group: "Target - Secondary", count: 1, why: "kept by choice" },
      { group: "Crisp Target", count: 1, why: "in use" },
    ]);
  });

  it("clears another Target group when asked, and never one that isn't Target", async () => {
    const { db: before } = await mainInstanceBackup();
    const { db, report } = await main(vaultProfiles(), { removeProfileGroups: [4, 3] });
    expect(report.profiles.removed).toContainEqual({
      name: "alice - 6",
      why: "not on the site",
      group: "Target - Secondary",
    });
    expect(row(db, 7)).toBeNull();
    expect(report.groupsRemoved.profile).toContain("Target - Secondary");
    expect(report.warnings.join(" ")).toMatch(/"Walmart" isn't a Target group/);
    expect(row(db, 6)).toEqual(row(before, 6));
  });

  it("keeps another runner's logins, and every mailbox a profile here could read from", async () => {
    const { bytes } = await mainInstanceBackup();
    const open = openBackup(await sqljs(), bytes);
    for (const [id, username] of [
      [60, "crisp81@example.com"],
      [61, "Crisp81@example.com"],
    ] as const) {
      open.db.run(
        "INSERT INTO account (id, created_at, username, password, website_id, generic_data, session_data) VALUES (?, NULL, ?, 'p', 5, '{}', '{}')",
        [id, username],
      );
    }
    for (const [id, username] of [
      [60, "crisp81@example.com"],
      [61, "stale@example.com"],
    ] as const) {
      open.db.run(
        "INSERT INTO imap_account (id, created_at, imap_server, port, username, password, is_enabled) VALUES (?, NULL, 'imap.gmail.com', 993, ?, 'x', 1)",
        [id, username],
      );
    }
    const report = buildInstance(open.db, desiredInstance(), options());
    // Both of Crisp's -- which one Shikari signs in with isn't the export's to judge.
    expect(open.db.all("SELECT id FROM account WHERE id IN (60, 61) ORDER BY id")).toEqual([
      { id: 60 },
      { id: 61 },
    ]);
    expect(open.db.all("SELECT id FROM imap_account ORDER BY id")).toEqual([{ id: 1 }, { id: 60 }]);
    expect(report.imap.removed).toBe(1);
  });

  it("adds a Target profile rather than taking a Walmart one with the same name and email", async () => {
    const { bytes } = await mainInstanceBackup();
    const SQL = await sqljs();
    const open = openBackup(SQL, bytes);
    // No Target alice - 1 at all now: only Walmart's is left by that name and email.
    open.db.run("DELETE FROM target_product WHERE task_id IN (5, 9)");
    open.db.run("DELETE FROM task WHERE id IN (5, 9)");
    open.db.run("DELETE FROM profile WHERE id = 1");
    const before = row(open.db, 6);
    const report = buildInstance(open.db, desiredInstance(), options());
    expect(report.profiles.added.map((p) => p.name)).toEqual(["alice - 1"]);
    expect(row(open.db, 6)).toEqual(before);
    expect(
      open.db.get(
        "SELECT COUNT(*) AS n FROM profile WHERE name = 'alice - 1' AND profile_group_id = 1",
      ),
    ).toEqual({ n: 1 });
  });

  it("says so when a vault profile is only in another Target group being kept", async () => {
    const kept = await main([...vaultProfiles(), aliceSix()]);
    expect(kept.report.profiles.added.map((p) => p.name)).toEqual(["alice - 6"]);
    expect(kept.report.warnings.join(" ")).toMatch(/alice - 6 \(in "Target - Secondary"\)/);
    expect(kept.db.get("SELECT profile_group_id FROM profile WHERE id = 7")).toEqual({
      profile_group_id: 4,
    });

    // One in a group being cleared goes either way, so there is nothing to check.
    const cleared = await main([...vaultProfiles(), aliceSix()], { removeProfileGroups: [4] });
    expect(cleared.report.profiles.added.map((p) => p.name)).toEqual(["alice - 6"]);
    expect(cleared.report.warnings).toEqual([]);
    expect(row(cleared.db, 7)).toBeNull();
  });

  it("takes a stopped profile's task off wherever it is, and the group it leaves empty", async () => {
    const { db, report } = await main(vaultProfiles().filter((p) => p.name !== "alice - 2"));
    expect(report.profiles.deactivated).toContainEqual({
      name: "alice - 2",
      why: "switched off",
      group: "Target",
    });
    // Its task was in "NO IMAP", not "Target", and it still came off -- and the group with it.
    expect(report.checkout.removed).toContainEqual({ profile: "alice - 2", skus: 1 });
    expect(db.get("SELECT 1 FROM task WHERE id = 6")).toBeNull();
    expect(report.groupsRemoved.task).toContain("NO IMAP");
    // Target, Walmart, Secondary, Crisp: the paused group, emptied, is gone.
    expect(db.get("SELECT COUNT(*) AS n FROM profile_group")).toEqual({ n: 4 });
  });

  it("copies the real Wipe Account shape, NULLs and all, into a proxy group that exists", async () => {
    const { db, report } = await main(
      profiles((list) => (list[2].pending = { fields: ["card", "shipLine1"] })),
    );
    expect(report.wipes).toMatchObject({ template: "copied", added: [{ name: "bob - 1" }] });
    expect(
      db.get(
        `SELECT t.type, t.flow_key, t.target_kind, t.options, t.generic_data, t.state, t.imap_account_id,
                b.proxy_group_id, b.proxy_id
           FROM task t JOIN browser b ON b.id = t.browser_id JOIN task_group g ON g.id = t.task_group_id
          WHERE g.name = 'Target - Profile Updates'`,
      ),
    ).toEqual({
      type: "Wipe Account",
      flow_key: "wipe_account",
      target_kind: null,
      options: "{}",
      generic_data: "{}",
      state: "{}",
      // The template reads no mailbox, so neither does the copy.
      imap_account_id: null,
      // The template's group (28) is gone; the checkout group stands in. Unpinned, like it.
      proxy_group_id: 1,
      proxy_id: null,
    });
    // The template itself was alice's old wipe, cleared: only the new one is left.
    expect(db.get("SELECT COUNT(*) AS n FROM task WHERE flow_key = 'wipe_account'")).toEqual({
      n: 1,
    });
  });
});

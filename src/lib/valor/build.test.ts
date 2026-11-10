/**
 * The Valor export's builder, against a synthetic backup shaped like the real instances.
 *
 * The properties with something behind them:
 *   - a backup the vault already matches comes out byte for byte as it went in;
 *   - "ACO Main" and "ACO Backup" hold exactly the profiles sent, in name order, each with one
 *     task in each of its task groups -- kept as it was, or copied from the group's own;
 *   - a profile keeps its id when it is updated, renamed or moved between the two, so its
 *     tasks keep pointing at it;
 *   - the Target side holds only the Miscellaneous line's pickers that can run, their logins
 *     and their mailboxes, one task per qty with its TCINs comma-separated, on "Target ISP";
 *   - nothing else in the file -- the operator's own groups, other sites, proxies, settings,
 *     and on the first instance the logins and IMAP list -- changes at all.
 */
import { describe, expect, it } from "vitest";
import { ValorBuildError, buildValorInstance, tasksFor } from "@/lib/valor/build";
import { serializeValorBackup, type ValorBackup, type ValorTask } from "@/lib/valor/format";
import type { DesiredMiscProfile, DesiredValorInstance } from "@/lib/valor/types";
import {
  IDS,
  desiredInstance,
  picker,
  profile,
  sequence,
  valorBackup,
  vaultOf,
} from "../../../tests/valor/fixture";

const build = (desired: DesiredValorInstance, b: ValorBackup = valorBackup()) =>
  buildValorInstance(b, desired, { uuid: sequence() });

const tasks = (b: ValorBackup, group: string): ValorTask[] =>
  Object.values(b.tasks.lists[group].Default);
const names = (b: ValorBackup, group: string) =>
  Object.values(b.profiles.lists[group]).map((p) => p.name);

/** Everything but the groups an instance without the misc line rewrites, as one string. */
const untouchedPkc = (b: ValorBackup) =>
  JSON.stringify([
    b.settings,
    b.proxies,
    b.accounts,
    b.imap,
    b.captchaHarvesters,
    b.automations,
    [IDS.personal, IDS.target, IDS.walmart].map((id) => [
      b.profiles.groups[id],
      b.profiles.lists[id],
    ]),
    [IDS.personalTasks, IDS.targetTasks, IDS.walmartTasks].map((id) => [
      b.tasks.groups[id],
      b.tasks.lists[id],
    ]),
  ]);

describe("buildValorInstance: Pokémon Center", () => {
  it("changes nothing at all in a backup the vault already matches", () => {
    const source = valorBackup();
    const { backup, report } = build(desiredInstance(source), source);
    expect(serializeValorBackup(backup)).toBe(serializeValorBackup(source));
    expect(report.pkc.profiles).toEqual({
      added: [],
      updated: [],
      moved: [],
      removed: [],
      unchanged: 5,
    });
    expect(
      report.pkc.taskGroups.map((g) => [g.name, g.kept, g.added.length, g.removed.length]),
    ).toEqual([
      ["PKC ACO - ISP", 3, 0, 0],
      ["PKC ACO - Resi", 3, 0, 0],
      ["PKC ACO (backup) - Resi", 2, 0, 0],
    ]);
    expect(report.misc).toBeNull();
    expect(report.warnings).toEqual([]);
  });

  it("never writes to the backup it was given", () => {
    const source = valorBackup();
    const before = serializeValorBackup(source);
    const desired = desiredInstance(source);
    desired.main.pop();
    build(desired, source);
    expect(serializeValorBackup(source)).toBe(before);
  });

  it("adds a new main-bot profile, with a task in both main groups copied from each group's own", () => {
    const desired = desiredInstance();
    desired.main.push({
      ...vaultOf(profile("x", "dan - 1", "dan1@example.com")),
      key: "vault-dan",
    });
    const { backup, report } = build(desired);
    expect(report.pkc.profiles.added).toEqual([{ name: "dan - 1", owner: "dan" }]);
    const dan = Object.values(backup.profiles.lists[IDS.main]).find((p) => p.name === "dan - 1")!;
    expect(dan.id).toBe("00000000-0000-4000-8000-000000000001");
    expect(backup.profiles.groups[IDS.main].totalAmount).toBe(4);
    // In name order: carol, then dan.
    expect(names(backup, IDS.main)).toEqual(["alice - 1", "bob - 1", "carol - 1", "dan - 1"]);
    for (const [group, proxy] of [
      [IDS.isp, IDS.pkcIsp],
      [IDS.resi, IDS.pkcResi],
    ]) {
      const mine = tasks(backup, group).filter((t) => t.profile?.id === dan.id);
      expect(mine).toHaveLength(1);
      expect(mine[0]).toMatchObject({
        profile: { name: "dan - 1", id: dan.id },
        profileGroupID: IDS.main,
        proxyGroupID: proxy,
        running: false,
        status: "Idle",
        config: { startOnQueue: true, loopCheckout: true },
        products: [{ monitorInput: "placeholder", productQuantity: 1, skipIfOOS: true }],
      });
      // The copy keeps Valor's own key order.
      expect(Object.keys(mine[0])).toEqual(Object.keys(tasks(valorBackup(), group)[0]));
      expect(backup.tasks.groups[group]).toMatchObject({
        totalAmount: 4,
        taskCounts: { Default: 4 },
      });
    }
    expect(tasks(backup, IDS.backupResi).some((t) => t.profile?.id === dan.id)).toBe(false);
  });

  it("takes a profile the vault no longer sends out, with its tasks, and says why", () => {
    const desired = desiredInstance();
    desired.main = desired.main.filter((d) => d.name !== "bob - 1");
    desired.known.find((k) => k.name === "bob - 1")!.why = "switched off";
    const { backup, report } = build(desired);
    expect(report.pkc.profiles.removed).toEqual([{ name: "bob - 1", why: "switched off" }]);
    expect(names(backup, IDS.main)).toEqual(["alice - 1", "carol - 1"]);
    for (const group of [IDS.isp, IDS.resi]) {
      expect(tasks(backup, group).map((t) => t.profile?.name)).toEqual(["alice - 1", "carol - 1"]);
    }
    expect(report.pkc.taskGroups[0].removed).toEqual(["bob - 1"]);
  });

  it("says a profile the site has never heard of is not on the site", () => {
    const b = valorBackup();
    b.profiles.lists[IDS.main]["p-zed"] = profile("p-zed", "zed - 1", "zed@example.com");
    b.profiles.groups[IDS.main].totalAmount = 4;
    const { report } = build(desiredInstance(valorBackup()), b);
    expect(report.pkc.profiles.removed).toEqual([{ name: "zed - 1", why: "not on the site" }]);
  });

  it("moves a profile from backup to main keeping its id, its tasks following it", () => {
    const desired = desiredInstance();
    const [aliceSix] = desired.backup.splice(0, 1);
    desired.main.push(aliceSix);
    const { backup, report } = build(desired);
    expect(report.pkc.profiles.moved).toEqual([
      { name: "alice - 6", owner: "alice", why: 'from "ACO Backup"' },
    ]);
    expect(backup.profiles.lists[IDS.main]["p-alice-6"]).toBeDefined();
    expect(backup.profiles.lists[IDS.backup]["p-alice-6"]).toBeUndefined();
    expect(tasks(backup, IDS.backupResi).map((t) => t.profile?.name)).toEqual(["bob - 6"]);
    expect(tasks(backup, IDS.isp).find((t) => t.profile?.id === "p-alice-6")?.profileGroupID).toBe(
      IDS.main,
    );
  });

  it("updates a changed card and address in place, keeping the name on the card", () => {
    const desired = desiredInstance();
    const alice = desired.main[0];
    alice.card = { ...alice.card, number: "5555555555554444", expYear: "2033" };
    alice.shipping = { ...alice.shipping, street: "77 New St", zip: "73101" };
    const { backup, report } = build(desired);
    expect(report.pkc.profiles.updated).toEqual([
      {
        name: "alice - 1",
        owner: "alice",
        fields: [
          "card",
          "card expiry",
          "card type",
          "street",
          "ZIP",
          "billing street",
          "billing ZIP",
        ],
      },
    ]);
    const stored = backup.profiles.lists[IDS.main]["p-alice-1"];
    expect(stored.card).toEqual({
      holder: "Alice Tester",
      number: "5555 5555 5555 4444",
      expiration: "09/33",
      cvv: "123",
      type: "mastercard",
    });
    // Billing is shipping: written out again in full, as Valor holds it.
    expect(stored.billing).toEqual(stored.shipping);
    expect(stored.shipping.addressLine1).toBe("77 New St");
    // Its tasks still point at it, untouched.
    expect(tasks(backup, IDS.isp)[0]).toEqual(tasks(valorBackup(), IDS.isp)[0]);
  });

  it("renames a profile and the name its tasks show", () => {
    const desired = desiredInstance();
    desired.main[2].name = "carol - 2";
    const { backup, report } = build(desired);
    expect(report.pkc.profiles.updated).toEqual([
      { name: "carol - 2", owner: "carol", fields: ["profile name"] },
    ]);
    for (const group of [IDS.isp, IDS.resi]) {
      expect(tasks(backup, group).find((t) => t.profile?.id === "p-carol-1")?.profile?.name).toBe(
        "carol - 2",
      );
    }
    expect(report.pkc.taskGroups.map((g) => g.renamed)).toEqual([1, 1, 0]);
  });

  it("matches every email before any name, so a name never takes another's profile", () => {
    const desired = desiredInstance();
    // bob - 1's email now belongs to a profile renamed "zed - 1", and a new member took the
    // name "bob - 1". Matched by name first, the new one would take bob's profile and its id.
    const bob = desired.main.find((d) => d.name === "bob - 1")!;
    desired.main = [
      ...desired.main.filter((d) => d !== bob),
      { ...bob, key: "vault-zed", name: "zed - 1" },
      { ...vaultOf(profile("x", "bob - 1", "bob-new@example.com")), key: "vault-new-bob" },
    ];
    const { backup, report } = build(desired);
    expect(backup.profiles.lists[IDS.main]["p-bob-1"]).toMatchObject({
      name: "zed - 1",
      email: "bob1@example.com",
    });
    expect(report.pkc.profiles.added).toEqual([{ name: "bob - 1", owner: "bob" }]);
  });

  it("matches a profile whose email changed by its name", () => {
    const desired = desiredInstance();
    desired.main[0].email = "alice-new@example.com";
    const { backup, report } = build(desired);
    expect(report.pkc.profiles.updated).toEqual([
      { name: "alice - 1", owner: "alice", fields: ["email"] },
    ]);
    expect(backup.profiles.lists[IDS.main]["p-alice-1"].email).toBe("alice-new@example.com");
  });

  it("leaves every group it doesn't own, and the Target side, logins and IMAP, exactly as they were", () => {
    const desired = desiredInstance();
    desired.main = [];
    desired.backup = desired.backup.slice(1);
    const { backup } = build(desired);
    expect(untouchedPkc(backup)).toBe(untouchedPkc(valorBackup()));
  });

  it("warns when most of the backup's profiles run on another instance", () => {
    const desired = desiredInstance();
    desired.main = [];
    desired.backup = [];
    for (const k of desired.known) k.why = "runs on Instance 2";
    const { report } = build(desired);
    expect(report.warnings).toEqual([
      "5 of this backup's 5 Pokémon Center profiles run on another instance — check this is Instance 1's backup before loading it.",
    ]);
  });

  it("refuses a backup without a group it needs, or with two of one", () => {
    const missing = valorBackup();
    delete missing.profiles.groups[IDS.backup];
    expect(() => build(desiredInstance(valorBackup()), missing)).toThrow(
      'This backup has no profile group named "ACO Backup"',
    );
    const twice = valorBackup();
    twice.tasks.groups["t-extra"] = {
      ...twice.tasks.groups[IDS.isp],
      id: "t-extra",
      name: "PKC ACO ISP",
    };
    twice.tasks.lists["t-extra"] = { Default: {} };
    expect(() => build(desiredInstance(valorBackup()), twice)).toThrow(
      '2 task groups named "PKC ACO - ISP"',
    );
    const wrong = valorBackup();
    wrong.tasks.groups[IDS.resi].siteModule = "Shopify";
    expect(() => build(desiredInstance(valorBackup()), wrong)).toThrow(ValorBuildError);
  });

  it("refuses to add a task to a group with none to copy", () => {
    const b = valorBackup();
    b.tasks.lists[IDS.backupResi].Default = {};
    expect(() => build(desiredInstance(valorBackup()), b)).toThrow(
      'Task group "PKC ACO (backup) - Resi" has no task to copy its settings from.',
    );
  });

  it("refuses to leave another group's task pointing at a profile it takes out", () => {
    const b = valorBackup();
    // A personal task borrowing an ACO profile: the export must not delete it from under it.
    b.tasks.lists[IDS.personalTasks].Default["k-personal"].profile = {
      name: "bob - 1",
      id: "p-bob-1",
    };
    b.tasks.lists[IDS.personalTasks].Default["k-personal"].profileGroupID = IDS.main;
    const desired = desiredInstance(valorBackup());
    desired.main = desired.main.filter((d) => d.name !== "bob - 1");
    expect(() => build(desired, b)).toThrow(
      'in "PKC Personal - ISP" would point at a profile or login',
    );
  });
});

describe("buildValorInstance: the Miscellaneous line on Target", () => {
  const ONE = "91000001";
  const TWO = "91000002";
  const THREE = "91000003";

  const misc = (b: ValorBackup = valorBackup()): DesiredMiscProfile[] => [
    // dave keeps his signed-in login, with a new password; two qtys, so two tasks.
    picker(
      b,
      "p-t-dave-1",
      [
        { sku: ONE, qty: 2 },
        { sku: TWO, qty: 1 },
        { sku: THREE, qty: 2 },
      ],
      {
        password: "dave-new-pass",
        mailbox: { server: "imap.gmail.com", email: "catchall@example.com", password: "catch-app" },
      },
    ),
    // alice: no password on file and no login in Valor -- skipped.
    picker(b, "p-t-alice-1", [{ sku: ONE, qty: 2 }], { password: null }),
    // A new member: new profile, login and mailbox.
    {
      ...vaultOf(profile("x", "fay - 1", "fay1@example.com")),
      key: "vault-fay",
      password: "fay-pass",
      mailbox: { server: "imap.mail.me.com", email: "fay.box@icloud.com", password: "fay-app" },
      products: [{ sku: TWO, qty: 2 }],
    },
  ];

  it("rebuilds Target from the line's pickers, and only them", () => {
    const source = valorBackup();
    const { backup, report } = build(desiredInstance(source, misc(source)), source);
    expect(names(backup, IDS.target)).toEqual(["dave - 1", "fay - 1"]);
    expect(backup.profiles.groups[IDS.target].totalAmount).toBe(2);
    expect(report.misc?.profiles).toEqual({
      added: [{ name: "fay - 1", owner: "fay" }],
      updated: [],
      removed: [
        { name: "alice - 1", why: "no Target password on file" },
        { name: "erin - 1", why: "not on the site" },
      ],
      unchanged: 1,
    });
    expect(report.misc?.skipped).toEqual([
      { name: "alice - 1", owner: "alice", why: "no Target password on file" },
    ]);
    expect(report.warnings).toContain(
      "No Target password on file for alice - 1, so they get no Target task. Add the password on the site and export again.",
    );
  });

  it("keeps a signed-in login, changing only its password, and drops the rest", () => {
    const source = valorBackup();
    const { backup, report } = build(desiredInstance(source, misc(source)), source);
    const logins = Object.values(backup.accounts.lists[IDS.targetLogins]);
    expect(logins).toEqual([
      {
        id: "l-dave",
        email: "dave1@example.com",
        password: "dave-new-pass",
        proxy: null,
        session: true,
        selected: true,
      },
      {
        id: expect.any(String),
        email: "fay1@example.com",
        password: "fay-pass",
        proxy: null,
        session: false,
        selected: false,
      },
    ]);
    expect(backup.accounts.groups[IDS.targetLogins].totalAmount).toBe(2);
    expect(report.misc?.accounts).toEqual({
      added: ["fay1@example.com"],
      updated: ["dave1@example.com"],
      removed: 1,
      unchanged: 0,
    });
    // Walmart's logins aren't Target's to clean.
    expect(backup.accounts.lists[IDS.walmartLogins]).toEqual(
      valorBackup().accounts.lists[IDS.walmartLogins],
    );
  });

  it("cuts IMAP to the mailboxes the pickers' codes arrive at", () => {
    const source = valorBackup();
    const { backup, report } = build(desiredInstance(source, misc(source)), source);
    expect(Object.values(backup.imap).map((m) => m.email)).toEqual([
      "catchall@example.com",
      "fay.box@icloud.com",
    ]);
    // The one kept is as it was, counters and all; the new one starts fresh.
    expect(backup.imap["m-catchall"]).toEqual(valorBackup().imap["m-catchall"]);
    expect(Object.values(backup.imap)[1]).toMatchObject({
      server: "imap.mail.me.com",
      password: "fay-app",
      readEmails: 0,
      codesReceived: 0,
      connected: false,
      enabled: true,
      status: "Idle",
    });
    expect(report.misc?.imap).toEqual({
      added: ["fay.box@icloud.com"],
      updated: [],
      removed: 2,
      unchanged: 1,
      missing: [],
    });
  });

  it("keeps a profile's own inbox when the site doesn't know where its codes go", () => {
    const source = valorBackup();
    const { backup, report } = build(
      desiredInstance(source, [picker(source, "p-t-dave-1", [{ sku: ONE, qty: 2 }])]),
      source,
    );
    expect(Object.keys(backup.imap)).toEqual(["m-dave"]);
    expect(report.misc?.imap.missing).toEqual([]);
  });

  it("gives each picker one task per qty, its TCINs comma-separated, on Target ISP, not running", () => {
    const source = valorBackup();
    const { backup, report } = build(desiredInstance(source, misc(source)), source);
    const list = tasks(backup, IDS.targetTasks);
    expect(
      list.map((t) => [
        t.profile?.name,
        t.products[0].monitorInput,
        t.products[0].displayedItem,
        t.products[0].productQuantity,
      ]),
    ).toEqual([
      ["dave - 1", `${ONE}, ${THREE}`, `${ONE}, ${THREE}`, 2],
      ["dave - 1", TWO, TWO, 1],
      ["fay - 1", TWO, TWO, 2],
    ]);
    const logins = Object.values(backup.accounts.lists[IDS.targetLogins]);
    for (const t of list) {
      expect(t).toMatchObject({
        selected: false,
        running: false,
        status: "Idle",
        color: "neutral",
        currentProxy: null,
        proxyGroupID: IDS.targetIsp,
        monitorProxyGroupID: IDS.targetIsp,
        profileGroupID: IDS.target,
        accountGroupID: IDS.targetLogins,
        config: { startOnQueue: false, loopCheckout: false },
      });
      expect(t.products).toHaveLength(1);
      expect(t.products[0]).toMatchObject({ skipIfOOS: false, minPrice: 0, maxPrice: null });
      expect(logins.some((l) => l.id === t.account?.id && l.email === t.account?.name)).toBe(true);
    }
    // dave's first task is his old one, kept by id; his second and fay's are new.
    expect(list[0].id).toBe("k-t-dave");
    expect(backup.tasks.groups[IDS.targetTasks]).toMatchObject({
      totalAmount: 3,
      taskCounts: { Default: 3 },
      selected: true,
    });
    expect(report.misc?.tasks).toMatchObject({ after: 3, unchanged: 0, untouched: 0 });
    expect(report.misc?.tasks.changed).toEqual([
      {
        profile: "dave - 1",
        before: [{ skus: ["placeholder"], qty: 3 }],
        after: [
          { skus: [ONE, THREE], qty: 2 },
          { skus: [TWO], qty: 1 },
        ],
      },
      { profile: "fay - 1", before: [], after: [{ skus: [TWO], qty: 2 }] },
      { profile: "erin - 1", before: [{ skus: ["placeholder"], qty: 3 }], after: [] },
    ]);
  });

  it("builds tasks in the example's shape when Target has none to copy", () => {
    const source = valorBackup();
    source.tasks.lists[IDS.targetTasks].Default = {};
    source.tasks.groups[IDS.targetTasks].totalAmount = 0;
    source.tasks.groups[IDS.targetTasks].taskCounts = { Default: 0 };
    const { backup } = build(
      desiredInstance(source, [picker(source, "p-t-erin-1", [{ sku: ONE, qty: 2 }])]),
      source,
    );
    const [t] = tasks(backup, IDS.targetTasks);
    expect(t).toMatchObject({
      mode: "Default",
      monitorDelay: 3500,
      retryDelay: 3500,
      proxyGroupID: IDS.targetIsp,
      monitorProxyGroupID: IDS.targetIsp,
    });
    expect(t.products[0]).toMatchObject({
      monitorInput: ONE,
      productQuantity: 2,
      skipIfOOS: false,
      maxPrice: null,
    });
  });

  it("is the same file when built again", () => {
    const source = valorBackup();
    const desired = desiredInstance(source, misc(source));
    const first = build(desired, source).backup;
    const second = buildValorInstance(first, desired, { uuid: sequence() });
    expect(serializeValorBackup(second.backup)).toBe(serializeValorBackup(first));
    expect(second.report.misc?.tasks).toMatchObject({ changed: [], unchanged: 2 });
  });

  it("touches nothing outside Target, its logins and IMAP", () => {
    const source = valorBackup();
    const { backup } = build(desiredInstance(source, misc(source)), source);
    const outside = (b: ValorBackup) =>
      JSON.stringify([
        b.settings,
        b.proxies,
        b.accounts.lists[IDS.walmartLogins],
        [IDS.personal, IDS.walmart].map((id) => b.profiles.lists[id]),
        [IDS.personalTasks, IDS.walmartTasks].map((id) => b.tasks.lists[id]),
      ]);
    expect(outside(backup)).toBe(outside(valorBackup()));
  });

  it("warns when Target ISP has no proxies", () => {
    const source = valorBackup();
    source.proxies.lists[IDS.targetIsp] = [];
    const { report } = build(desiredInstance(source, misc(source)), source);
    expect(report.warnings).toContain(
      'Proxy group "Target ISP" has no proxies, so the Target tasks have none to run on.',
    );
  });
});

describe("tasksFor", () => {
  it("puts a profile's picks in one task per qty, in catalog order", () => {
    expect(
      tasksFor([
        { sku: "1", qty: 2 },
        { sku: "2", qty: 2 },
      ]),
    ).toEqual([{ skus: ["1", "2"], qty: 2 }]);
    expect(
      tasksFor([
        { sku: "1", qty: 1 },
        { sku: "2", qty: 2 },
        { sku: "3", qty: 1 },
      ]),
    ).toEqual([
      { skus: ["1", "3"], qty: 1 },
      { skus: ["2"], qty: 2 },
    ]);
  });

  it("never runs a product at none, or past the most a member can pick", () => {
    expect(
      tasksFor([
        { sku: "1", qty: 0 },
        { sku: "2", qty: 14 },
      ]),
    ).toEqual([
      { skus: ["1"], qty: 2 },
      { skus: ["2"], qty: 10 },
    ]);
  });
});

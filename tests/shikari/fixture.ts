/**
 * A small, synthetic Shikari instance, shaped like the real ones.
 *
 * Built on the schema copied verbatim from a real backup (schema.sql), with rows modelled
 * on what that backup held -- not its data: every name, card and password here is made up.
 * The real file can't live in the repo; it carries members' cards and live sessions.
 *
 *   Profiles (group "Target")         alice - 1  shipping is billing, one shared row
 *                                     alice - 2  separate billing row
 *                                     bob - 1
 *                                     stranger - 1   the site has never heard of it
 *   Profiles (group "Target Paused")  Target 11      a house profile the site knows
 *   Task group "Target"     a checkout task per profile above but Target 11 (SKUs A and B
 *                           in various mixes), one remote watchdog, and three TCIN
 *                           watchdogs on A and B at 3333/4444/5555
 *   Task group "Target Wipe"  one old Wipe Account task, alice - 1's: what wipes are copied
 *                           from, and what a clean export clears
 *   Proxy groups            "ISP - Monitor" (4) for watchdogs, "Resi" (6) for checkouts,
 *                           every task browser pinned to one of them
 *   Accounts                one per profile, alice's signed in with cookie jars, plus an
 *                           old account with no profile
 *   Everything else         a licence row, notification settings, a harvester -- the
 *                           things an export must never touch
 *
 * So a first export cleans: stranger - 1 and Target 11 come out, with their tasks and logins,
 * the old login, alice's old wipe, and the two groups that leaves empty. `cleanBackup` is the
 * file after that, for tests about one change at a time.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { buildInstance } from "@/lib/shikari/build";
import { ShikariDb } from "@/lib/shikari/sqlite";
import type {
  DesiredInstance,
  DesiredProfile,
  KnownProfile,
  Sections,
  TaskSettings,
} from "@/lib/shikari/types";

let engine: Promise<SqlJsStatic> | null = null;
export function sqljs(): Promise<SqlJsStatic> {
  engine ??= initSqlJs();
  return engine;
}

const SCHEMA = readFileSync(fileURLToPath(new URL("./schema.sql", import.meta.url)), "utf8");

export const SKU_A = "90000001";
export const SKU_B = "90000002";
export const T0 = "2026-09-25 03:03:10.934300";

/** The fixture's profiles as the vault has them: identical to the backup, to the digit. */
export function vaultProfiles(): DesiredProfile[] {
  const address = (first: string, street: string, zip: string, phone: string) => ({
    firstName: first,
    lastName: "Tester",
    street,
    street2: "",
    city: "Oklahoma City",
    state: "OK",
    zip,
    country: "US",
    phone,
  });
  return [
    {
      key: "vault-alice-1",
      ownerId: "999900000000000501",
      ownerName: "alice",
      name: "alice - 1",
      email: "alice1@example.com",
      shipping: address("Alice", "1 Main St", "73170", "4055550101"),
      billing: null,
      card: { number: "4111111111111111", expMonth: 9, expYear: 2031, cvv: "123" },
      password: "alice-pass-1",
      mailbox: {
        server: "imap.gmail.com",
        port: 993,
        username: "alice.mail@gmail.com",
        password: "app pass alic",
      },
      skus: [SKU_A, SKU_B],
      pending: null,
    },
    {
      key: "vault-alice-2",
      ownerId: "999900000000000501",
      ownerName: "alice",
      name: "alice - 2",
      email: "alice2@example.com",
      shipping: address("Alice", "2 Main St", "73170", "4055550102"),
      billing: address("Alice", "9 Bill Rd", "73101", "4055550102"),
      card: { number: "5555555555554444", expMonth: 1, expYear: 2030, cvv: "456" },
      password: "alice-pass-2",
      mailbox: {
        server: "imap.gmail.com",
        port: 993,
        username: "alice.mail@gmail.com",
        password: "app pass alic",
      },
      skus: [SKU_A],
      pending: null,
    },
    {
      key: "vault-bob-1",
      ownerId: "999900000000000502",
      ownerName: "bob",
      name: "bob - 1",
      email: "bob1@example.com",
      shipping: address("Bob", "3 Oak Ave", "74103", "9185550103"),
      billing: null,
      card: { number: "378282246310005", expMonth: 12, expYear: 2029, cvv: "7890" },
      password: "bob-pass-1",
      mailbox: null,
      skus: [SKU_B],
      pending: null,
    },
  ];
}

/**
 * What the export is sent for one instance. Every fixture profile the site knows is in
 * `known` -- the three vault profiles and the house profile "Target 11" -- and one that isn't
 * among `profiles` is said to be switched off, unless `absent` gives another reason.
 * "stranger - 1" is the one the site has never heard of.
 */
export function desiredInstance(
  profiles: DesiredProfile[] = vaultProfiles(),
  absent: Record<string, KnownProfile["why"]> = {},
): DesiredInstance {
  const here = new Set(profiles.map((p) => p.name));
  const known = [
    ...vaultProfiles(),
    ...profiles.filter((p) => !vaultProfiles().some((v) => v.name === p.name)),
    { name: "Target 11", email: "house11@example.com" },
  ].map((p) => ({
    name: p.name,
    email: p.email,
    why: here.has(p.name) ? null : (absent[p.name] ?? ("inactive" as const)),
  }));
  return {
    position: 1,
    profiles,
    known,
    products: [
      { sku: SKU_A, name: "Product A", setName: "Set One" },
      { sku: SKU_B, name: "Product B", setName: "Set One" },
    ],
  };
}

const WATCHDOG_DATA = (deviceId: string) =>
  JSON.stringify({
    atc_method: null,
    save_cc_to_account: true,
    ios_device_data: {
      device_model: "iPhone18,2",
      ios_version: "26.5.1",
      device_id: deviceId,
      total_storage: 512,
      gpu_registry_id: 4294967669,
      ipv4_addresses: ["169.254.141.169 : en2", "192.168.3.28 : en0"],
      ipv6_addresses: ["fe80::5eb6:9281:5707:e9bc : en0", "fe80::8c:e3dc:52c5:2a3a : utun1"],
      user_interface_style: "Light",
      local_storage_uuid: `${deviceId}-ls`,
      boot_timestamp: 1789887130,
      app_install_timestamp: 1790307130,
    },
  });

const CHECKOUT_OPTIONS =
  '{"auto_loop_checkout": false, "login_method": "password", "apply_circle_offers": false, "bypass_threshold": false, "save_cc_to_account": true, "ignore_low_stock": false}';

/** A fresh in-memory backup. Each call is independent, so tests can't leak into each other. */
export async function fixtureBackup(): Promise<{ db: ShikariDb; bytes: Uint8Array }> {
  const SQL = await sqljs();
  const raw = new SQL.Database();
  raw.exec(SCHEMA);
  const db = new ShikariDb(raw);
  const run = (sql: string, params: (string | number | null)[] = []) => db.run(sql, params);

  run("INSERT INTO alembic_version VALUES ('d4e8b21c7f05')");
  run(
    "INSERT INTO config (id, created_at, license_key, stealth_browser_headless, cookie_lifetime) VALUES (1, NULL, 'SH-TEST-LICENCE', 1, 400)",
  );
  run(
    "INSERT INTO notification_config (in_bot__enabled, webhook__discord_url) VALUES (1, 'https://example.invalid/hook')",
  );
  run(
    "INSERT INTO custom_browser (name, path, is_default) VALUES ('Google Chrome', '/Applications/Google Chrome.app', 1)",
  );

  // Proxy groups: Shikari's built-in localhost, then the two the tasks use.
  run(
    "INSERT INTO proxy_group (id, created_at, name, order_index) VALUES (-1, NULL, 'localhost', 0)",
  );
  run(
    `INSERT INTO proxy_group (id, created_at, name, order_index) VALUES (0, '${T0}', 'ISP - Monitor', 1)`,
  );
  run(`INSERT INTO proxy_group (id, created_at, name, order_index) VALUES (1, '${T0}', 'Resi', 2)`);
  for (let i = 1; i <= 4; i++) {
    run(
      "INSERT INTO proxy (created_at, proxy_group_id, host, port, username, password) VALUES (?, 0, ?, 8022, ?, ?)",
      [T0, `10.0.0.${i}`, `isp${i}`, `isp-pass-${i}`],
    );
  }
  for (let i = 1; i <= 6; i++) {
    run(
      "INSERT INTO proxy (created_at, proxy_group_id, host, port, username, password) VALUES (?, 1, ?, 7777, ?, ?)",
      [T0, `resi.example.net`, `resi-user-${i}`, `resi-pass-${i}`],
    );
  }
  const ispProxy = (n: number) => n; // ids 1-4
  const resiProxy = (n: number) => 4 + n; // ids 5-10

  let jar = 0;
  const cookieJar = (cookies = "[]") => {
    jar += 1;
    run("INSERT INTO cookie_jar (id, created_at, cookies) VALUES (?, ?, ?)", [jar, T0, cookies]);
    return jar;
  };
  let browserId = 0;
  const browser = (groupId: number | null, proxyId: number | null, fingerprint: string) => {
    browserId += 1;
    run(
      "INSERT INTO browser (id, created_at, proxy_group_id, proxy_id, fingerprint_name, cookie_jar_id) VALUES (?, ?, ?, ?, ?, ?)",
      [browserId, T0, groupId, proxyId, fingerprint, cookieJar()],
    );
    return browserId;
  };

  // A harvester and its browser: shares nothing with tasks, and must survive every export.
  run(
    `INSERT INTO harvester_group (id, created_at, name, order_index) VALUES (1, '${T0}', 'Target', 0)`,
  );
  const harvesterBrowser = browser(0, ispProxy(4), "macOS-Chrome-harvester.json");
  run(
    "INSERT INTO harvester (id, created_at, harvester_group_id, type, browser_id, generic_data, custom_browser_id) VALUES (1, ?, 1, 'target-atc-harvester', ?, '{}', 1)",
    [T0, harvesterBrowser],
  );

  run(
    `INSERT INTO profile_group (id, created_at, name, order_index) VALUES (1, '${T0}', 'Target', 0)`,
  );
  run(
    `INSERT INTO profile_group (id, created_at, name, order_index) VALUES (2, '${T0}', 'Target Paused', 1)`,
  );

  const address = (
    first: string,
    street: string,
    zip: string,
    phone: string,
    city = "Oklahoma City",
  ) =>
    db.insert(
      "INSERT INTO address (created_at, first_name, last_name, street, street_2, city, state, zip_code, country, phone_number) VALUES (?, ?, 'Tester', ?, '', ?, 'OK', ?, 'US', ?)",
      [T0, first, street, city, zip, phone],
    );
  const card = (number: string, month: number, year: number, cvv: string) =>
    db.insert(
      "INSERT INTO credit_card (created_at, card_number, expire_month, expire_year, cvv) VALUES (?, ?, ?, ?, ?)",
      [T0, number, month, year, cvv],
    );
  const profile = (
    id: number,
    name: string,
    email: string,
    ship: number,
    bill: number,
    cardId: number,
    group: number,
  ) =>
    run(
      "INSERT INTO profile (id, created_at, name, email, shipping_address_id, billing_address_id, credit_card_id, profile_group_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [id, T0, name, email, ship, bill, cardId, group],
    );

  const a1 = address("Alice", "1 Main St", "73170", "4055550101");
  profile(
    1,
    "alice - 1",
    "alice1@example.com",
    a1,
    a1,
    card("4111111111111111", 9, 2031, "123"),
    1,
  );
  const a2 = address("Alice", "2 Main St", "73170", "4055550102");
  const a2b = address("Alice", "9 Bill Rd", "73101", "4055550102");
  profile(
    2,
    "alice - 2",
    "alice2@example.com",
    a2,
    a2b,
    card("5555555555554444", 1, 2030, "456"),
    1,
  );
  const b1 = address("Bob", "3 Oak Ave", "74103", "9185550103");
  profile(3, "bob - 1", "bob1@example.com", b1, b1, card("378282246310005", 12, 2029, "7890"), 1);
  const s1 = address("Stan", "4 Elm St", "73170", "4055550104");
  profile(
    4,
    "stranger - 1",
    "stranger@example.com",
    s1,
    s1,
    card("4000056655665556", 3, 2028, "321"),
    1,
  );
  const h1 = address("House", "5 Pine St", "73170", "4055550105");
  profile(
    5,
    "Target 11",
    "house11@example.com",
    h1,
    h1,
    card("4242424242424242", 6, 2032, "999"),
    2,
  );

  // Accounts. Alice's first is signed in: a session and both cookie jars.
  const account = (username: string, password: string, signedIn = false) =>
    run(
      "INSERT INTO account (created_at, username, password, website_id, generic_data, session_data, cookie_jar_id, mobile_cookie_jar_id) VALUES (?, ?, ?, 5, ?, ?, ?, ?)",
      [
        T0,
        username,
        password,
        signedIn ? '{"cookies": [], "device_idfv": "IDFV-1"}' : "{}",
        signedIn ? '{"mobile_session": {"token": "live"}}' : "{}",
        signedIn ? cookieJar('[{"name": "sid", "value": "web"}]') : null,
        signedIn ? cookieJar('[{"name": "sid", "value": "mobile"}]') : null,
      ],
    );
  account("alice1@example.com", "alice-pass-1", true);
  account("alice2@example.com", "alice-pass-2");
  account("bob1@example.com", "bob-pass-1");
  account("stranger@example.com", "stranger-pass");
  account("house11@example.com", "house-pass");
  account("old@example.com", "old-pass");

  run(
    "INSERT INTO imap_account (id, created_at, imap_server, port, username, password, is_enabled) VALUES (1, ?, 'imap.gmail.com', 993, 'alice.mail@gmail.com', 'app pass alic', 1)",
    [T0],
  );

  run(
    `INSERT INTO task_group (id, created_at, name, color, order_index) VALUES (1, '${T0}', 'Target', '#D81B60', 0)`,
  );
  run(
    `INSERT INTO task_group (id, created_at, name, color, order_index) VALUES (2, '${T0}', 'Target Wipe', '#0B8043', 1)`,
  );

  let taskId = 0;
  const task = (t: {
    group: number;
    type: string;
    flow: string;
    kind: string;
    profile: number | null;
    browser: number;
    imap?: number | null;
    generic?: string;
    options?: string;
    state?: string;
    preloaded?: number;
  }) => {
    taskId += 1;
    run(
      "INSERT INTO task (id, created_at, task_group_id, running, preloaded, type, website_id, profile_id, generic_data, browser_id, imap_account_id, flow_key, options, state, target_kind) VALUES (?, ?, ?, 0, ?, ?, 5, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        taskId,
        T0,
        t.group,
        t.preloaded ?? 0,
        t.type,
        t.profile,
        t.generic ?? "{}",
        t.browser,
        t.imap ?? null,
        t.flow,
        t.options ?? "{}",
        t.state ?? "{}",
        t.kind,
      ],
    );
    return taskId;
  };
  const watch = (id: number, skus: string[], qty: number | null) => {
    for (const sku of skus) {
      run(
        "INSERT INTO target_product (created_at, task_id, target_method, target_data, qty, miscellaneous_data) VALUES (?, ?, 'tcins', ?, ?, '{}')",
        [T0, id, sku, qty],
      );
    }
  };

  // Watchdogs: one remote, three on TCINs.
  task({
    group: 1,
    type: "Watchdog",
    flow: "watchdog",
    kind: "remote",
    profile: null,
    browser: browser(null, null, "macOS-Chrome-w0.json"),
    generic: WATCHDOG_DATA("remote-device"),
    state: WATCHDOG_DATA("remote-device"),
  });
  [3333, 4444, 5555].forEach((interval, i) => {
    const id = task({
      group: 1,
      type: "Watchdog",
      flow: "watchdog",
      kind: "tcins",
      profile: null,
      browser: browser(0, ispProxy(i + 1), `macOS-Chrome-w${i + 1}.json`),
      generic: WATCHDOG_DATA(`tcins-device-${i + 1}`),
      options: `{"check_interval": ${interval}}`,
      state: WATCHDOG_DATA(`tcins-device-${i + 1}`),
    });
    watch(id, [SKU_A, SKU_B], null);
  });

  // Checkout tasks, each with its own browser pinned to a Resi proxy.
  const checkout = (
    profileId: number,
    skus: string[],
    proxy: number,
    fingerprint: string,
    imap: number | null = null,
  ) => {
    const id = task({
      group: 1,
      type: "Checkout",
      flow: "checkout",
      kind: "tcins",
      profile: profileId,
      browser: browser(1, resiProxy(proxy), fingerprint),
      imap,
      options: CHECKOUT_OPTIONS,
      state: '{"platform": "mobile", "ffid": "FFID"}',
      preloaded: 1,
    });
    watch(id, skus, 2);
    return id;
  };
  checkout(1, [SKU_A, SKU_B], 1, "macOS-Chrome-c1.json", 1);
  checkout(2, [SKU_A], 2, "macOS-Chrome-c1.json", 1);
  checkout(3, [SKU_B], 3, "macOS-Chrome-c2.json");
  checkout(4, [SKU_A], 4, "macOS-Chrome-c2.json");

  // The template a wipe is copied from. This one reads a mailbox (alice's), so its copies
  // read their own profile's; mainInstanceBackup turns it into the real shape, which reads
  // none.
  task({
    group: 2,
    type: "Wipe Account",
    flow: "wipe_account",
    kind: "",
    profile: 1,
    browser: browser(1, resiProxy(5), "macOS-Chrome-c1.json"),
    imap: 1,
    options: '{"login_method": "password"}',
  });

  return { db, bytes: db.bytes() };
}

/**
 * The same instance, arranged the way the operator's MAIN instance is (2026-10-05 backup):
 *
 *   Task group "Target - All Products"   the Target tasks, under another name
 *   Task group "NO IMAP"                 alice - 2's checkout task, its browser in a proxy
 *                                        group that has been deleted (id 19), unpinned
 *   Task group "Target Wipe Account"     the wipe template, in Shikari's real shape: target
 *                                        kind NULL, options and data "{}", no mailbox, its
 *                                        browser in another deleted group (28), unpinned
 *   Profile group "Target - Paused"      spelled with a dash
 *   Profile group "Walmart"              a Walmart "alice - 1" with alice's Target email, and
 *                                        a Walmart task -- members reuse both across retailers
 *   Profile group "Target - Secondary"   "alice - 6", parked, known to the vault
 *   Profile group "Crisp Target"         another runner's member, run from "MNs Target" with
 *                                        its own checkout task and watchdog
 */
export async function mainInstanceBackup(): Promise<{ db: ShikariDb; bytes: Uint8Array }> {
  const { db } = await fixtureBackup();
  const run = (sql: string, params: (string | number | null)[] = []) => db.run(sql, params);

  run("UPDATE task_group SET name = 'Target - All Products' WHERE id = 1");
  run("UPDATE task_group SET name = 'Target Wipe Account' WHERE id = 2");
  run("UPDATE profile_group SET name = 'Target - Paused' WHERE id = 2");

  run(
    `INSERT INTO task_group (id, created_at, name, color, order_index) VALUES (3, ?, 'NO IMAP', '#B39DDB', 2)`,
    [T0],
  );
  run("UPDATE task SET task_group_id = 3 WHERE id = 6");
  run("UPDATE browser SET proxy_group_id = 19, proxy_id = NULL WHERE id = 7");

  run(
    `UPDATE task SET target_kind = NULL, options = '{}', generic_data = '{}',
                     state = '{"ffid": "FFID", "platform": "mobile"}', imap_account_id = NULL
      WHERE flow_key = 'wipe_account'`,
  );
  run(
    "UPDATE browser SET proxy_group_id = 28, proxy_id = NULL WHERE id = (SELECT browser_id FROM task WHERE flow_key = 'wipe_account')",
  );

  const address = (first: string, street: string) =>
    db.insert(
      "INSERT INTO address (created_at, first_name, last_name, street, street_2, city, state, zip_code, country, phone_number) VALUES (?, ?, 'Tester', ?, '', 'Tulsa', 'OK', '74103', 'US', '9185550199')",
      [T0, first, street],
    );
  const card = (number: string) =>
    db.insert(
      "INSERT INTO credit_card (created_at, card_number, expire_month, expire_year, cvv) VALUES (?, ?, 1, 2032, '111')",
      [T0, number],
    );
  const profile = (id: number, name: string, email: string, group: number, street: string) => {
    const a = address("Other", street);
    run(
      "INSERT INTO profile (id, created_at, name, email, shipping_address_id, billing_address_id, credit_card_id, profile_group_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [id, T0, name, email, a, a, card("6011000990139424"), group],
    );
  };
  const browser = (id: number, group: number | null) => {
    run("INSERT INTO cookie_jar (id, created_at, cookies) VALUES (?, ?, '[]')", [100 + id, T0]);
    run(
      "INSERT INTO browser (id, created_at, proxy_group_id, proxy_id, fingerprint_name, cookie_jar_id) VALUES (?, ?, ?, NULL, 'macOS-Chrome-other.json', ?)",
      [id, T0, group, 100 + id],
    );
  };

  // Walmart: the same person, the same name and email, another retailer entirely.
  run(`INSERT INTO profile_group (id, created_at, name, order_index) VALUES (3, ?, 'Walmart', 2)`, [
    T0,
  ]);
  profile(6, "alice - 1", "alice1@example.com", 3, "77 Walmart Way");
  run(
    "INSERT INTO account (created_at, username, password, website_id, generic_data, session_data) VALUES (?, 'alice1@example.com', 'walmart-pass', 3, '{}', '{}')",
    [T0],
  );
  run(
    `INSERT INTO task_group (id, created_at, name, color, order_index) VALUES (4, ?, 'Walmart Raffle Entry', '#795548', 3)`,
    [T0],
  );
  browser(20, 1);
  run(
    "INSERT INTO task (id, created_at, task_group_id, running, preloaded, type, website_id, profile_id, generic_data, browser_id, flow_key, options, state, target_kind) VALUES (20, ?, 4, 0, 0, 'Draw Joiner', 3, 6, '{}', 20, 'draw_joiner', '{}', '{}', 'pid')",
    [T0],
  );

  // Parked past-the-cap profile the vault knows.
  run(
    `INSERT INTO profile_group (id, created_at, name, order_index) VALUES (4, ?, 'Target - Secondary', 4)`,
    [T0],
  );
  profile(7, "alice - 6", "alice6@example.com", 4, "6 Secondary St");

  // Another runner's member, with their own tasks and watchdog.
  run(
    `INSERT INTO profile_group (id, created_at, name, order_index) VALUES (5, ?, 'Crisp Target', 5)`,
    [T0],
  );
  profile(8, "crisp 81", "crisp81@example.com", 5, "81 Crisp Ct");
  run(
    `INSERT INTO task_group (id, created_at, name, color, order_index) VALUES (5, ?, 'MNs Target', '#F6BF26', 4)`,
    [T0],
  );
  browser(21, 1);
  browser(22, 0);
  run(
    "INSERT INTO task (id, created_at, task_group_id, running, preloaded, type, website_id, profile_id, generic_data, browser_id, flow_key, options, state, target_kind) VALUES (21, ?, 5, 0, 1, 'Checkout', 5, 8, '{}', 21, 'checkout', '{}', '{}', 'tcins')",
    [T0],
  );
  run(
    "INSERT INTO task (id, created_at, task_group_id, running, preloaded, type, website_id, profile_id, generic_data, browser_id, flow_key, options, state, target_kind) VALUES (22, ?, 5, 0, 0, 'Watchdog', 5, NULL, '{}', 22, 'watchdog', '{\"check_interval\": 3333}', '{}', 'tcins')",
    [T0],
  );
  for (const taskId of [21, 22]) {
    run(
      "INSERT INTO target_product (created_at, task_id, target_method, target_data, qty, miscellaneous_data) VALUES (?, ?, 'tcins', ?, ?, '{}')",
      [T0, taskId, SKU_A, taskId === 21 ? 2 : null],
    );
  }

  return { db, bytes: db.bytes() };
}

/** The task settings the tests build with: the fixture's own, as currentTaskSettings reads them. */
export const TASKS: TaskSettings = {
  checkoutQty: 2,
  checkoutProxyGroupId: 1,
  watchdogProxyGroupId: 0,
  watchdogIntervals: [3333, 4444, 5555],
  skusPerWatchdog: 30,
  remoteWatchdogs: 1,
};

export const ALL_SECTIONS: Sections = {
  profiles: true,
  accounts: true,
  imap: true,
  proxies: true,
  tasks: true,
  wipes: true,
};

/**
 * The fixture after one export of the vault as it stands, so holding exactly what's ours:
 * stranger - 1, Target 11, the old login, alice's old wipe and the two groups that left
 * empty are gone. Ids of everything kept are the fixture's own.
 */
export async function cleanBackup(): Promise<{ db: ShikariDb; bytes: Uint8Array }> {
  const { db } = await fixtureBackup();
  buildInstance(db, desiredInstance(), {
    sections: ALL_SECTIONS,
    removeProfileGroups: [],
    proxyLists: [],
    tasks: TASKS,
    now: new Date("2026-10-04T12:00:00.000Z"),
    random: seeded(9),
  });
  return { db, bytes: db.bytes() };
}

/** The vault's view of "alice - 6", parked in "Target - Secondary" in the main instance. */
export function aliceSix(): DesiredProfile {
  return {
    ...vaultProfiles()[0],
    key: "vault-alice-6",
    name: "alice - 6",
    email: "alice6@example.com",
    password: null,
    mailbox: null,
    skus: [SKU_B],
  };
}

/** A deterministic stand-in for Math.random. */
export function seeded(seed = 1): () => number {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

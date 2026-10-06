/**
 * Runs the Shikari export's builder against a REAL backup, with no database.
 *
 *   npx tsx scripts/verify-shikari.ts --file "F:/Documents/Okie ACO/shikari-example-backup.bak"
 *   npx tsx scripts/verify-shikari.ts --file <path> --out <path>   # also write the edited copy
 *
 * The backup itself is never written to; the edited copy goes only where --out says.
 *
 * Three passes:
 *
 *   1. ROUND TRIP. A desired state is read back OUT of the backup -- every profile in its
 *      "Target" profile group, with the card, address, password, mailbox and products it
 *      already has -- and built back in, with every other group at its default choice. What
 *      the vault drives must not change for any profile kept: its row, address, card, login
 *      and mailbox. What may go is the CLEAN-UP, and each part is checked to have gone only
 *      where it should: profiles that aren't "Target"'s, their logins, mailboxes nothing
 *      uses, old wipes, emptied groups. Nothing outside the Target side may change at all.
 *
 *   2. A DROP. The same state with the edits a real export makes -- a changed card, a new
 *      member, a profile moved to another instance, one with no products, 35 products, a
 *      swapped proxy list -- checked for what the summary must say, the references SQLite
 *      enforces, its own integrity check, and the tables no export may touch.
 *
 *   3. AGAIN. The drop's output exported once more with the same state: a clean backup must
 *      stay as it is -- nothing more to remove, nothing activated or deactivated.
 *
 * This file reads members' cards and passwords. It NEVER prints them: every line of output
 * is a count, a table name or a profile name. Keep it that way.
 */
import { readFileSync, writeFileSync } from "node:fs";
import initSqlJs from "sql.js";
import { buildInstance } from "../src/lib/shikari/build";
import { diffTables, forbiddenChanges, tableHashes, type TableDiff } from "../src/lib/shikari/diff";
import {
  PAUSED_PROFILE_GROUP,
  TARGET_GROUP,
  UPDATES_GROUP,
  currentTaskSettings,
  findGroup,
  groupsToClear,
  isCheckout,
  isTargetGroupName,
  isWatchdog,
  readSnapshot,
  summarize,
  targetGroups,
  type ShikariSnapshot,
} from "../src/lib/shikari/snapshot";
import { backupBytes, openBackup, ShikariDb } from "../src/lib/shikari/sqlite";
import type {
  BuildOptions,
  BuildReport,
  DesiredInstance,
  DesiredProfile,
  ShikariAddress,
} from "../src/lib/shikari/types";

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const FILE = flag("file") ?? "F:/Documents/Okie ACO/shikari-example-backup.bak";
const OUT = flag("out");

let failures = 0;
function check(ok: boolean, label: string) {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}`);
  if (!ok) failures += 1;
}

const lower = (value: string | null | undefined) => String(value ?? "").toLowerCase();

/** The login a profile signs in with, by the builder's rule: one with a session, then the oldest. */
function loginFor(s: ShikariSnapshot, email: string) {
  return s.accounts
    .filter((a) => a.websiteId === s.targetWebsiteId && lower(a.username) === lower(email))
    .sort((a, b) => Number(b.signedIn) - Number(a.signedIn) || a.id - b.id)[0];
}

/** The desired state the backup already describes, for the profiles the export may touch. */
function desiredFromBackup(s: ShikariSnapshot): DesiredInstance {
  const groups = targetGroups(s);
  const tasks = new Map(
    s.tasks
      .filter((t) => isCheckout(t) && t.websiteId === s.targetWebsiteId && t.profileId !== null)
      .map((t) => [t.profileId, t]),
  );
  const imap = new Map(s.imap.map((m) => [m.id, m]));
  const toAddress = (id: number | null): ShikariAddress | null => {
    const a = id === null ? undefined : s.addresses.get(id);
    return a
      ? {
          firstName: a.firstName,
          lastName: a.lastName,
          street: a.street,
          street2: a.street2,
          city: a.city,
          state: a.state,
          zip: a.zip,
          country: a.country,
          phone: a.phone,
        }
      : null;
  };

  // The running profiles: the "Target" group, not the parked ones. The vault holds one
  // profile per email, so of two with one email only the one the builder would claim counts:
  // the one with a checkout task, then the older.
  const byEmail = new Map<string, (typeof s.profiles)[number]>();
  for (const p of s.profiles) {
    if (p.groupId !== groups.profiles?.id) continue;
    const held = byEmail.get(lower(p.email));
    if (!held || (!tasks.has(held.id) && tasks.has(p.id))) byEmail.set(lower(p.email), p);
  }
  const profiles: DesiredProfile[] = [];
  for (const p of [...byEmail.values()].sort((x, y) => x.id - y.id)) {
    const card = s.cards.get(p.cardId);
    const task = tasks.get(p.id);
    const box = task?.imapId != null ? imap.get(task.imapId) : undefined;
    // Members are told apart by the name their profiles start with ("shockereyes - 6").
    const member = p.name.replace(/\s*-\s*\d+$/, "");
    profiles.push({
      key: `backup-${p.id}`,
      ownerId: lower(member),
      ownerName: member,
      name: p.name,
      email: p.email,
      shipping: toAddress(p.shippingId)!,
      billing: p.billingId === p.shippingId ? null : toAddress(p.billingId),
      card: {
        number: card?.number ?? "",
        expMonth: card?.expMonth ?? 0,
        expYear: card?.expYear ?? 0,
        cvv: card?.cvv ?? "",
      },
      password: loginFor(s, p.email)?.password ?? null,
      mailbox: box
        ? {
            server: box.server,
            port: box.port ?? 993,
            username: box.username,
            password: box.password,
          }
        : null,
      skus: task ? s.products.filter((x) => x.taskId === task.id).map((x) => x.data) : [],
      pending: null,
    });
  }
  const skus = [...new Set(profiles.flatMap((p) => p.skus))];
  const wanted = new Set(profiles.map((p) => p.key));
  return {
    position: 1,
    profiles,
    // Everything in a Target group, as the site would know it: ours, or switched off.
    known: s.profiles
      .filter((p) => isTargetGroupName(s.profileGroups.find((g) => g.id === p.groupId)?.name))
      .map((p) => ({
        name: p.name,
        email: p.email,
        why: wanted.has(`backup-${p.id}`) ? null : ("inactive" as const),
      })),
    products: skus.map((sku) => ({ sku, name: sku, setName: "" })),
  };
}

function seeded(seed = 7) {
  let state = seed;
  return () => (state = (state * 1664525 + 1013904223) % 4294967296) / 4294967296;
}

function printDiff(diffs: TableDiff[]) {
  for (const d of diffs.filter((x) => x.added + x.removed + x.changed > 0)) {
    console.log(
      `    ${d.table.padEnd(16)} ${d.before} -> ${d.after}   +${d.added} ~${d.changed} -${d.removed}`,
    );
  }
}

/** Rows as JSON, for "exactly the same before and after". */
function rows(db: ShikariDb, sql: string, params: (string | number)[] = []): string {
  return JSON.stringify(db.values(sql, params));
}

/**
 * Everything the export must not touch, as one string: profiles in groups that aren't
 * Target or are kept, every other site's login, and every non-Target task.
 */
function untouchable(db: ShikariDb, s: ShikariSnapshot, keptGroups: number[]): string {
  const outside = s.profileGroups
    .filter((g) => !isTargetGroupName(g.name) || keptGroups.includes(g.id))
    .map((g) => g.id);
  const list = outside.length > 0 ? outside.join(",") : "-1";
  return [
    rows(db, `SELECT * FROM profile WHERE profile_group_id IN (${list}) ORDER BY id`),
    rows(db, "SELECT * FROM account WHERE website_id <> ? ORDER BY id", [s.targetWebsiteId]),
    rows(db, "SELECT * FROM task WHERE website_id <> ? ORDER BY id", [s.targetWebsiteId]),
  ].join("\n");
}

function buildFrom(
  SQL: Awaited<ReturnType<typeof initSqlJs>>,
  bytes: Uint8Array,
  desired: DesiredInstance,
  options: BuildOptions,
) {
  const open = openBackup(SQL, bytes);
  const baseline = tableHashes(open.db);
  const started = Date.now();
  const report = buildInstance(open.db, desired, options);
  const ms = Date.now() - started;
  return { open, report, ms, diff: diffTables(baseline, tableHashes(open.db)) };
}

function describe(report: BuildReport) {
  if (report.taskGroup) {
    console.log(
      `  task group: "${report.taskGroup.name}"` +
        (report.taskGroup.renamedFrom ? ` (renamed from "${report.taskGroup.renamedFrom}")` : "") +
        (report.taskGroup.created ? " (created)" : ""),
    );
  }
  const p = report.profiles;
  const moved = report.checkout.changed.filter((c) =>
    c.other.some((o) => o.startsWith("moved in")),
  );
  console.log(
    `  profiles: ${p.added.length} new, ${p.activated.length} activated, ${p.updated.length} updated, ` +
      `${p.deactivated.length} deactivated, ${p.removed.length} removed, ${p.unchanged} unchanged`,
  );
  const reasons = new Map<string, number>();
  for (const line of [...p.deactivated, ...p.removed]) {
    const key = `${line.group} / ${line.why}`;
    reasons.set(key, (reasons.get(key) ?? 0) + 1);
  }
  for (const [reason, count] of reasons) console.log(`    out: ${reason} × ${count}`);
  console.log(`  kept: ${p.kept.map((k) => `${k.group} (${k.count}, ${k.why})`).join("; ")}`);
  console.log(
    `  logins -${report.accounts.removed} ~${report.accounts.updated.length} +${report.accounts.added.length}; ` +
      `mailboxes -${report.imap.removed}; strays -${report.strays}; ` +
      `groups removed: ${[...report.groupsRemoved.profile, ...report.groupsRemoved.task].join(", ") || "none"}`,
  );
  console.log(
    `  checkout +${report.checkout.added.length} ~${report.checkout.changed.length} (${moved.length} moved in) ` +
      `-${report.checkout.removed.length} =${report.checkout.unchanged} untouched ${report.checkout.untouched.length}; ` +
      `watchdogs ${report.watchdogs.before.length} -> ${report.watchdogs.after.length}, remote ${report.watchdogs.remote.after}; ` +
      `wipes +${report.wipes.added.length} -${report.wipes.removed} (template: ${report.wipes.template})`,
  );
  for (const warning of report.warnings) console.log(`  warning: ${warning}`);
}

/** The checks every rebuilt file must pass, whatever went into it. */
function checkFile(
  SQL: Awaited<ReturnType<typeof initSqlJs>>,
  original: { db: ShikariDb; wal: boolean },
  built: ReturnType<typeof buildFrom>,
  desired: DesiredInstance,
) {
  const db = built.open.db;
  check(forbiddenChanges(built.diff).length === 0, "untouchable tables untouched");

  // Clean: "Target" holds this instance's profiles and nothing else, and no paused group.
  const s = readSnapshot(db);
  const target = findGroup(s.profileGroups, TARGET_GROUP);
  const inTarget = s.profiles.filter((p) => p.groupId === target?.id);
  const wanted = new Set(desired.profiles.map((d) => lower(d.email)));
  check(
    inTarget.length === desired.profiles.length &&
      inTarget.every((p) => wanted.has(lower(p.email))),
    `"${TARGET_GROUP}" holds exactly the ${desired.profiles.length} desired profiles`,
  );
  const paused = findGroup(s.profileGroups, PAUSED_PROFILE_GROUP);
  check(
    !paused || !s.profiles.some((p) => p.groupId === paused.id),
    "nothing left parked in a paused group",
  );

  // Logins: one per profile of ours; none for a profile that is gone.
  const remaining = new Set(
    s.profiles
      .filter((p) => {
        const group = s.profileGroups.find((g) => g.id === p.groupId);
        const runsTarget = s.tasks.some(
          (t) => t.profileId === p.id && t.websiteId === s.targetWebsiteId,
        );
        return isTargetGroupName(group?.name) || runsTarget;
      })
      .map((p) => lower(p.email)),
  );
  const strayLogins = s.accounts.filter(
    (a) => a.websiteId === s.targetWebsiteId && !remaining.has(lower(a.username)),
  );
  check(strayLogins.length === 0, "no Target login without a Target profile to use it");
  const twins = inTarget.filter(
    (p) =>
      s.accounts.filter(
        (a) => a.websiteId === s.targetWebsiteId && lower(a.username) === lower(p.email),
      ).length > 1,
  );
  check(twins.length === 0, "each desired profile has one Target login, not two");

  // Mailboxes: none that nothing could use.
  const used = new Set(s.tasks.map((t) => t.imapId).filter((id) => id !== null));
  const emails = new Set(s.profiles.map((p) => lower(p.email)));
  const strayBoxes = s.imap.filter((m) => !used.has(m.id) && !emails.has(lower(m.username)));
  const ours = new Set(
    desired.profiles.flatMap((d) => (d.mailbox ? [lower(d.mailbox.username)] : [])),
  );
  check(
    strayBoxes.every((m) => ours.has(lower(m.username))),
    "no mailbox left that nothing uses",
  );

  // Old wipes: none for our profiles outside "Target - Profile Updates".
  const updates = findGroup(s.taskGroups, UPDATES_GROUP);
  const ids = new Set(inTarget.map((p) => p.id));
  check(
    !s.tasks.some(
      (t) =>
        /wipe/i.test(`${t.type} ${t.flowKey}`) &&
        t.profileId !== null &&
        ids.has(t.profileId) &&
        t.groupId !== updates?.id,
    ),
    "no old wipe left for a profile of ours",
  );

  check(
    built.report.watchdogs.after.every((w) => w.skus.length <= 30),
    "no watchdog over 30 products",
  );

  // In order, as Shikari lists the group (by id): the watchdogs at the top, then each
  // member's checkout tasks together.
  const taskGroup = findGroup(s.taskGroups, TARGET_GROUP);
  const listed = s.tasks.filter(
    (t) => t.groupId === taskGroup?.id && t.websiteId === s.targetWebsiteId,
  );
  const lastWatchdog = listed.map(isWatchdog).lastIndexOf(true);
  check(
    lastWatchdog < listed.findIndex(isCheckout) || !listed.some(isCheckout),
    `the ${listed.filter(isWatchdog).length} watchdogs at the top of "${TARGET_GROUP}"`,
  );
  const ownerOf = new Map(desired.profiles.map((d) => [lower(d.email), d.ownerId]));
  const emailOf = new Map(s.profiles.map((p) => [p.id, lower(p.email)]));
  const owners = listed
    .filter(isCheckout)
    .map((t) => ownerOf.get(emailOf.get(t.profileId ?? -1) ?? "") ?? "?");
  const runs = owners.filter((owner, i) => i === 0 || owners[i - 1] !== owner).length;
  check(
    runs === new Set(owners).size,
    `each member's checkout tasks together (${new Set(owners).size} members)`,
  );

  const out = backupBytes(built.open);
  check(out[18] === 2 && out[19] === 2 ? original.wal : !original.wal, "journal mode preserved");
  // Reopened exactly as the export page would open it -- a copy, never `out` itself.
  const reopened = openBackup(SQL, out).db;
  check(
    reopened.get<{ integrity_check: string }>("PRAGMA integrity_check")?.integrity_check === "ok",
    "integrity_check ok",
  );
  const fkBefore = original.db.all("PRAGMA foreign_key_check").length;
  check(
    reopened.all("PRAGMA foreign_key_check").length <= fkBefore,
    `no new broken references (${fkBefore} were already there)`,
  );
  check(
    readSnapshot(reopened).profileGroups.filter((g) => findGroup([g], TARGET_GROUP)).length === 1,
    `exactly one "${TARGET_GROUP}" profile group`,
  );
  reopened.close();
  return out;
}

async function main() {
  const SQL = await initSqlJs();
  const bytes = new Uint8Array(readFileSync(FILE));

  const original = openBackup(SQL, bytes);
  const snapshot = readSnapshot(original.db);
  const summary = summarize(snapshot);
  console.log(`Backup: ${FILE}`);
  console.log(`  Shikari ${summary.version}, ${original.wal ? "WAL" : "rollback"} journal`);
  console.log(
    `  ${summary.counts.profiles} profiles, ${summary.counts.accounts} accounts (${summary.counts.signedIn} signed in), ` +
      `${summary.counts.imap} mailboxes, ${summary.counts.proxies} proxies, ${summary.counts.tasks} tasks, ${summary.users.length} users`,
  );
  console.log(
    `  export works in: profiles "${summary.target.profileGroup}" + "${summary.target.pausedGroup}" (${summary.target.candidates}), tasks "${summary.target.taskGroup}"`,
  );
  const clear = groupsToClear(summary, {});
  console.log(
    `  groups: ${summary.profileGroups
      .map(
        (g) =>
          `${g.name} [${g.role}${clear.includes(g.id) ? ", clear" : ""}] ${g.count}p/${g.tasks}t`,
      )
      .join("; ")}`,
  );
  const settings = currentTaskSettings(snapshot);
  console.log(`  current settings: ${JSON.stringify(settings)}`);
  const kept = summary.profileGroups
    .filter((g) => g.role === "other" && !clear.includes(g.id))
    .map((g) => g.id);
  const before = untouchable(original.db, snapshot, kept);

  const desired = desiredFromBackup(snapshot);
  console.log(
    `  desired (read back): ${desired.profiles.length} profiles, ${desired.products.length} products`,
  );

  const base: BuildOptions = {
    sections: {
      profiles: true,
      accounts: true,
      imap: true,
      proxies: true,
      tasks: true,
      wipes: true,
    },
    removeProfileGroups: clear,
    proxyLists: [],
    tasks: settings,
    now: new Date(),
    random: seeded(),
  };

  // What must come through a round trip untouched: our profiles' rows, addresses, cards and
  // logins, and the mailboxes their tasks use.
  const ids = desired.profiles.map((d) => Number(d.key.replace("backup-", "")));
  const list = ids.join(",") || "-1";
  const vaultRows = (db: ShikariDb) =>
    [
      rows(db, `SELECT * FROM profile WHERE id IN (${list}) ORDER BY id`),
      rows(
        db,
        `SELECT * FROM address WHERE id IN (SELECT shipping_address_id FROM profile WHERE id IN (${list})
           UNION SELECT billing_address_id FROM profile WHERE id IN (${list})) ORDER BY id`,
      ),
      rows(
        db,
        `SELECT * FROM credit_card WHERE id IN (SELECT credit_card_id FROM profile WHERE id IN (${list})) ORDER BY id`,
      ),
      rows(
        db,
        `SELECT * FROM account WHERE id IN (${desired.profiles.map((d) => loginFor(snapshot, d.email)?.id ?? -1).join(",") || "-1"}) ORDER BY id`,
      ),
      rows(
        db,
        `SELECT * FROM imap_account WHERE id IN (SELECT imap_account_id FROM task WHERE profile_id IN (${list})) ORDER BY id`,
      ),
    ].join("\n");
  const vaultBefore = vaultRows(original.db);

  // --- 1. round trip -------------------------------------------------------
  console.log("\n1. Round trip");
  const trip = buildFrom(SQL, bytes, desired, base);
  console.log(`  built in ${trip.ms} ms`);
  printDiff(trip.diff);
  describe(trip.report);
  check(
    vaultRows(trip.open.db) === vaultBefore,
    "our profiles, addresses, cards, logins, mailboxes unchanged",
  );
  check(
    trip.report.profiles.updated.length === 0 &&
      trip.report.profiles.added.length === 0 &&
      trip.report.profiles.activated.length === 0,
    "no profile reported new, updated or activated",
  );
  check(trip.report.accounts.updated.length === 0, "no password reported changed");
  check(trip.report.checkout.added.length === 0, "no checkout task added");
  check(
    trip.report.checkout.changed.every((c) => c.added.length === 0 && c.removed.length === 0),
    `no checkout task's products changed (${trip.report.checkout.changed.length} only moved or re-grouped)`,
  );
  check(
    trip.report.profiles.deactivated.every((l) => l.why?.startsWith("a second copy")),
    `only second copies deactivated (${trip.report.profiles.deactivated.length})`,
  );
  check(
    untouchable(trip.open.db, snapshot, kept) === before,
    "nothing outside the Target side touched",
  );
  checkFile(SQL, original, trip, desired);
  trip.open.db.close();

  // --- 2. a drop -----------------------------------------------------------
  console.log("\n2. A drop");
  const edited = structuredClone(desired);
  const [first, second] = edited.profiles;
  if (first) {
    first.card = { ...first.card, number: "4012888888881881", expYear: first.card.expYear + 1 };
    first.pending = { fields: ["card"] };
  }
  const idle = second && second.skus.length > 0 ? second.name : null;
  if (second) second.skus = []; // switched everything off
  const extra = Array.from({ length: 35 }, (_, i) => String(96000000 + i));
  edited.products.push(...extra.map((sku) => ({ sku, name: sku, setName: "Synthetic" })));
  for (const p of edited.profiles.slice(2, 12)) p.skus = [...p.skus, ...extra];
  // One profile taken off this instance -- Instance 2 runs it now.
  const [moved] = edited.profiles.splice(3, 1);
  if (moved) {
    const entry = edited.known.find((k) => k.name === moved.name);
    if (entry) Object.assign(entry, { why: "member", instance: 2 });
  }
  if (first) {
    edited.profiles.push({
      ...structuredClone(first),
      key: "new-member",
      name: "verify-new - 1",
      email: "verify-new-1@example.invalid",
      mailbox: {
        server: "imap.example.invalid",
        port: 993,
        username: "verify-new@example.invalid",
        password: "x",
      },
      pending: null,
    });
    edited.known.push({ name: "verify-new - 1", email: "verify-new-1@example.invalid", why: null });
  }

  // The list the checkout tasks use, swapped for one 10% shorter.
  const swapped =
    snapshot.proxyGroups.find((g) => g.id === settings.checkoutProxyGroupId) ??
    snapshot.proxyGroups.find((g) => g.proxies.length > 1000) ??
    snapshot.proxyGroups.at(-1)!;
  const swap = Array.from({ length: Math.floor(swapped.proxies.length * 0.9) }, (_, i) => ({
    host: "proxy.example.invalid",
    port: 10000 + (i % 50000),
    username: `u${i}`,
    password: `p${i}`,
  }));

  const dropOptions = { ...base, proxyLists: [{ groupId: swapped.id, proxies: swap }] };
  const drop = buildFrom(SQL, bytes, edited, dropOptions);
  console.log(`  built in ${drop.ms} ms`);
  printDiff(drop.diff);
  describe(drop.report);
  console.log(
    `  proxies ${swapped.name} ${drop.report.proxies[0]?.before} -> ${drop.report.proxies[0]?.after}, ${drop.report.proxies[0]?.browsersMoved} browsers re-pinned`,
  );
  const p = drop.report.profiles;
  check(
    p.updated.some((l) => l.name === first?.name && l.fields?.includes("card")),
    "changed card reported as updated",
  );
  check(
    p.added.some((l) => l.name === "verify-new - 1"),
    "new profile reported as new",
  );
  check(
    !moved ||
      p.deactivated.some((l) => l.name === moved.name && l.why === "runs on Instance 2") ||
      p.removed.some((l) => l.name === moved.name && l.why === "runs on Instance 2"),
    "profile moved to another instance taken out, with where it went",
  );
  check(
    !moved || drop.report.checkout.removed.some((t) => t.profile === moved.name),
    "and its checkout task removed",
  );
  check(
    !idle || p.deactivated.some((l) => l.name === idle && l.why === "picked no products"),
    "profile with no products reported as deactivated",
  );
  check(
    !moved ||
      !drop.open.db.get("SELECT 1 FROM account WHERE website_id = ? AND lower(username) = ?", [
        snapshot.targetWebsiteId,
        lower(moved.email),
      ]),
    "its login removed with it",
  );
  check(
    untouchable(drop.open.db, snapshot, kept) === before,
    "nothing outside the Target side touched",
  );
  if (drop.report.wipes.added.length > 0) {
    const wipe = drop.open.db.get<{
      type: string | null;
      flow_key: string | null;
      target_kind: string | null;
      proxy_group_id: number | null;
    }>(
      `SELECT t.type, t.flow_key, t.target_kind, b.proxy_group_id
         FROM task t JOIN task_group g ON g.id = t.task_group_id JOIN browser b ON b.id = t.browser_id
        WHERE g.name = ? LIMIT 1`,
      [UPDATES_GROUP],
    );
    check(Boolean(wipe), `a wipe was made in "${UPDATES_GROUP}" (${drop.report.wipes.template})`);
    check(
      wipe?.type === "Wipe Account" &&
        wipe.flow_key === "wipe_account" &&
        wipe.target_kind === null,
      "the wipe has Shikari's shape (target_kind NULL, not '')",
    );
    check(
      wipe?.proxy_group_id === null ||
        snapshot.proxyGroups.some((g) => g.id === wipe?.proxy_group_id),
      "the wipe's browser is in a proxy group that exists",
    );
  }
  const out = checkFile(SQL, original, drop, edited);
  drop.open.db.close();

  // --- 3. again --------------------------------------------------------------
  console.log("\n3. Again, on the drop's output");
  const again = buildFrom(SQL, out, edited, { ...dropOptions, proxyLists: [] });
  printDiff(again.diff);
  describe(again.report);
  const a = again.report;
  check(
    a.profiles.added.length +
      a.profiles.updated.length +
      a.profiles.activated.length +
      a.profiles.deactivated.length +
      a.profiles.removed.length ===
      0,
    "no profile changes the second time",
  );
  check(
    a.accounts.removed + a.imap.removed + a.strays === 0 &&
      a.groupsRemoved.profile.length + a.groupsRemoved.task.length === 0,
    "nothing left to clean up",
  );
  check(
    a.wipes.added.length === drop.report.wipes.added.length &&
      a.wipes.removed === drop.report.wipes.added.length &&
      (a.wipes.added.length === 0 || a.wipes.template === "copied"),
    "the pending wipe is rebuilt from the last one",
  );
  again.open.db.close();

  if (OUT) {
    writeFileSync(OUT, out);
    console.log(`\nEdited copy written to ${OUT}`);
  }

  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

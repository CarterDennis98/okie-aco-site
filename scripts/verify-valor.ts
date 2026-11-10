/**
 * Runs the Valor export's builder against REAL backups, with no database.
 *
 *   npx tsx scripts/verify-valor.ts --main "F:/Documents/Okie ACO/valor-setup-main.json" \
 *                                   --second "F:/Documents/Okie ACO/valor-setup.json"
 *   ... --out-dir <dir>    # also write the drop's rebuilt copies there
 *
 * The backups are never written to. Three passes per instance:
 *
 *   1. ROUND TRIP. The desired state is read back OUT of the two files: every Pokémon Center
 *      profile in either instance's "ACO Main" or "ACO Backup", split again by the export's
 *      own rule (the first 250 of each, by name, on the first instance) -- and, for the
 *      second, the Target tasks it holds, with their logins and mailboxes. Built back in,
 *      Pokémon Center must come out BYTE FOR BYTE as it went in: no profile moved, updated or
 *      removed, no task added or removed -- the proof that the export writes a profile
 *      exactly as Valor holds it, and splits exactly as the instances are split now. On the
 *      second instance, Target is cut down to those tasks' profiles, logins and mailboxes,
 *      and nothing else changes.
 *
 *   2. A DROP. The same state with the edits a real export makes: a changed card and
 *      address, a new member, a profile switched off, one moved from backup to main and one
 *      renamed; on Target, picks with mixed qtys, a new profile, and one with no password.
 *      Checked for what the review must say and for every rule the file must keep.
 *
 *   3. AGAIN. The drop's output built once more with the same state: nothing changes.
 *
 * This file reads members' cards and passwords. It NEVER prints them: every line of output
 * is a count, a group name or a profile name. Keep it that way.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildValorInstance, type ValorBuild } from "../src/lib/valor/build";
import {
  ACO_BACKUP,
  ACO_MAIN,
  DEFAULT_CATEGORY,
  PKC_TASK_GROUPS,
  TARGET_ACCOUNT_GROUP,
  TARGET_PROFILE_GROUP,
  TARGET_PROXY_GROUP,
  TARGET_TASK_GROUP,
  groupsNamed,
  parseValorBackup,
  serializeValorBackup,
  type ValorAddress,
  type ValorBackup,
  type ValorProfile,
  type VaultAddress,
} from "../src/lib/valor/format";
import { FIRST_INSTANCE_CAP } from "../src/lib/valor/split";
import type {
  DesiredMiscProfile,
  DesiredValorInstance,
  DesiredValorProfile,
  KnownValorProfile,
  ValorReport,
} from "../src/lib/valor/types";
import { stateCode } from "../src/lib/vault/aycd";
import { normalizePhone } from "../src/lib/vault/profile-input";

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const FILES: Record<1 | 2, string> = {
  1: flag("main") ?? "F:/Documents/Okie ACO/valor-setup-main.json",
  2: flag("second") ?? "F:/Documents/Okie ACO/valor-setup.json",
};
const OUT_DIR = flag("out-dir");

let failures = 0;
function check(ok: boolean, label: string) {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}`);
  if (!ok) failures += 1;
}

const lower = (value: string | null | undefined) =>
  String(value ?? "")
    .trim()
    .toLowerCase();
const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

let counter = 0;
const uuid = () => {
  counter += 1;
  return `00000000-0000-4000-8000-${String(counter).padStart(12, "0")}`;
};

function group<T extends { name: string; id: string }>(groups: Record<string, T>, name: string): T {
  const [found] = groupsNamed(groups, name);
  if (!found) throw new Error(`no group "${name}"`);
  return found;
}
const profilesIn = (b: ValorBackup, name: string) =>
  Object.values(b.profiles.lists[group(b.profiles.groups, name).id] ?? {});
const tasksIn = (b: ValorBackup, name: string) =>
  Object.values(b.tasks.lists[group(b.tasks.groups, name).id]?.[DEFAULT_CATEGORY] ?? {});

/** A Valor profile as the vault would hold it: two-letter codes, bare digits, a 4-digit year. */
function vaultSide(p: ValorProfile): DesiredValorProfile {
  const address = (a: ValorAddress): VaultAddress => ({
    firstName: a.firstName,
    lastName: a.lastName,
    street: a.addressLine1,
    street2: a.addressLine2,
    city: a.city,
    state: stateCode(a.state),
    zip: a.zipCode,
    country: a.countryCode || "US",
  });
  const [month = "", year = ""] = p.card.expiration.split("/");
  // Members are told apart by the name their profiles start with ("shockereyes - 6").
  const owner = p.name.replace(/(?:\s*-\s*|\s+)\d+$/, "").trim() || p.name;
  return {
    key: `valor-${p.id}`,
    ownerId: lower(owner),
    ownerName: owner,
    name: p.name,
    email: p.email,
    phone: normalizePhone(p.phoneNumber) ?? p.phoneNumber.trim(),
    shipping: address(p.shipping),
    billing: p.billingSameAsShipping ? null : address(p.billing),
    card: {
      number: p.card.number.replace(/\D/g, ""),
      expMonth: month.padStart(2, "0"),
      expYear: year.length === 2 ? `20${year}` : year,
      cvv: p.card.cvv,
    },
    onlyCheckoutOnce: p.oneCheckout,
  };
}

/** The second instance's Target tasks, read back as the picks that would build them. */
function miscFrom(b: ValorBackup): DesiredMiscProfile[] {
  const profiles = b.profiles.lists[group(b.profiles.groups, TARGET_PROFILE_GROUP).id] ?? {};
  const accounts = b.accounts.lists[group(b.accounts.groups, TARGET_ACCOUNT_GROUP).id] ?? {};
  const imap = new Map(Object.values(b.imap).map((m) => [lower(m.email), m]));
  const byProfile = new Map<string, DesiredMiscProfile>();
  for (const task of tasksIn(b, TARGET_TASK_GROUP)) {
    const profile = task.profile ? profiles[task.profile.id] : undefined;
    if (!profile) continue;
    const account = task.account ? accounts[task.account.id] : undefined;
    const box = imap.get(lower(profile.email));
    const entry =
      byProfile.get(profile.id) ??
      ({
        ...vaultSide(profile),
        password: account?.password ?? null,
        mailbox: box ? { server: box.server, email: box.email, password: box.password } : null,
        products: [],
      } satisfies DesiredMiscProfile);
    for (const product of task.products) {
      for (const sku of product.monitorInput
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean))
        entry.products.push({ sku, qty: product.productQuantity });
    }
    byProfile.set(profile.id, entry);
  }
  return [...byProfile.values()];
}

/**
 * The desired state of both instances, read back from the two files: every ACO profile in
 * either, main and backup kept apart as they are, split between the instances by the
 * export's rule.
 */
function desiredFrom(files: Record<1 | 2, ValorBackup>): Record<1 | 2, DesiredValorInstance> {
  const side = (name: string) =>
    [...profilesIn(files[1], name), ...profilesIn(files[2], name)]
      .map(vaultSide)
      .sort((a, b) => collator.compare(a.name, b.name));
  const main = side(ACO_MAIN);
  const backup = side(ACO_BACKUP);
  const share = {
    1: { main: main.slice(0, FIRST_INSTANCE_CAP), backup: backup.slice(0, FIRST_INSTANCE_CAP) },
    2: { main: main.slice(FIRST_INSTANCE_CAP), backup: backup.slice(FIRST_INSTANCE_CAP) },
  };
  const known = (position: 1 | 2): KnownValorProfile[] =>
    ([1, 2] as const).flatMap((on) =>
      [...share[on].main, ...share[on].backup].map((d) => ({
        site: "pkc" as const,
        name: d.name,
        email: d.email,
        why: on === position ? null : `runs on Instance ${on}`,
      })),
    );
  const misc = miscFrom(files[2]);
  return {
    1: { position: 1, ...share[1], misc: null, products: [], known: known(1) },
    2: {
      position: 2,
      ...share[2],
      misc,
      products: [...new Set(misc.flatMap((d) => d.products.map((p) => p.sku)))].map((sku) => ({
        sku,
        name: sku,
      })),
      known: known(2),
    },
  };
}

function describe(r: ValorReport) {
  const p = r.pkc.profiles;
  console.log(
    `  PKC: ${r.pkc.main} main, ${r.pkc.backup} backup -- ${p.added.length} new, ${p.updated.length} updated, ` +
      `${p.moved.length} moved, ${p.removed.length} removed, ${p.unchanged} unchanged`,
  );
  const fields = new Map<string, number>();
  for (const line of p.updated)
    for (const f of line.fields ?? []) fields.set(f, (fields.get(f) ?? 0) + 1);
  if (fields.size > 0)
    console.log(`    updated fields: ${[...fields].map(([f, c]) => `${f} x${c}`).join(", ")}`);
  const reasons = new Map<string, number>();
  for (const line of p.removed)
    reasons.set(line.why ?? "?", (reasons.get(line.why ?? "?") ?? 0) + 1);
  for (const [why, c] of reasons) console.log(`    removed: ${why} x${c}`);
  for (const g of r.pkc.taskGroups) {
    console.log(
      `  "${g.name}": +${g.added.length} -${g.removed.length} kept ${g.kept} (renamed ${g.renamed}) untouched ${g.untouched} -> ${g.after}`,
    );
  }
  if (r.misc) {
    const m = r.misc;
    console.log(
      `  Target profiles: +${m.profiles.added.length} ~${m.profiles.updated.length} -${m.profiles.removed.length} =${m.profiles.unchanged}, skipped ${m.skipped.length}`,
    );
    console.log(
      `  Target logins: +${m.accounts.added.length} ~${m.accounts.updated.length} -${m.accounts.removed} =${m.accounts.unchanged}; ` +
        `IMAP: +${m.imap.added.length} ~${m.imap.updated.length} -${m.imap.removed} =${m.imap.unchanged}, missing ${m.imap.missing.length}`,
    );
    console.log(
      `  Target tasks: ${m.tasks.after} after, ${m.tasks.changed.length} profiles changed, ${m.tasks.unchanged} unchanged, untouched ${m.tasks.untouched}`,
    );
  }
  for (const w of r.warnings) console.log(`  warning: ${w}`);
}

/** Every part of the file outside the export's groups, as one string. */
function outside(b: ValorBackup, misc: boolean): string {
  const ours = {
    profiles: new Set(
      [ACO_MAIN, ACO_BACKUP, ...(misc ? [TARGET_PROFILE_GROUP] : [])].map(
        (n) => group(b.profiles.groups, n).id,
      ),
    ),
    tasks: new Set(
      [...PKC_TASK_GROUPS.map((g) => g.name), ...(misc ? [TARGET_TASK_GROUP] : [])].map(
        (n) => group(b.tasks.groups, n).id,
      ),
    ),
    accounts: new Set(misc ? [group(b.accounts.groups, TARGET_ACCOUNT_GROUP).id] : []),
  };
  const not = <T>(map: Record<string, T>, mine: Set<string>) =>
    Object.entries(map).filter(([id]) => !mine.has(id));
  return JSON.stringify([
    Object.entries(b).filter(([k]) => !["tasks", "profiles", "accounts", "imap"].includes(k)),
    not(b.profiles.groups, ours.profiles),
    not(b.profiles.lists, ours.profiles),
    not(b.tasks.groups, ours.tasks),
    not(b.tasks.lists, ours.tasks),
    not(b.accounts.groups, ours.accounts),
    not(b.accounts.lists, ours.accounts),
    misc ? null : b.imap,
  ]);
}

/** The rules every rebuilt file keeps, whatever went in. */
function checkFile(before: ValorBackup, built: ValorBuild, desired: DesiredValorInstance) {
  const b = built.backup;
  const text = serializeValorBackup(b);
  const reread = parseValorBackup(text);
  check(JSON.stringify(reread) === JSON.stringify(b), "the file reads back as written");
  check(
    !text.endsWith("\n") && text.startsWith('{\n  "version"'),
    "written as Valor writes it: two-space indent, no trailing newline",
  );
  check(
    outside(before, Boolean(desired.misc)) === outside(b, Boolean(desired.misc)),
    "nothing outside the export's groups changed",
  );

  const names = (list: { name: string }[]) =>
    list
      .map((x) => x.name)
      .sort(collator.compare)
      .join("\n");
  check(
    names(profilesIn(b, ACO_MAIN)) === names(desired.main),
    `"${ACO_MAIN}" holds exactly the ${desired.main.length} main-bot profiles`,
  );
  check(
    names(profilesIn(b, ACO_BACKUP)) === names(desired.backup),
    `"${ACO_BACKUP}" holds exactly the ${desired.backup.length} backup-bot profiles`,
  );
  for (const name of [ACO_MAIN, ACO_BACKUP]) {
    const list = profilesIn(b, name).map((p) => p.name);
    check(
      list.every((x, i) => i === 0 || collator.compare(list[i - 1], x) <= 0),
      `"${name}" in name order`,
    );
  }

  for (const { name, profiles } of PKC_TASK_GROUPS) {
    const home = group(b.profiles.groups, profiles === "main" ? ACO_MAIN : ACO_BACKUP);
    const list = b.profiles.lists[home.id] ?? {};
    const tasks = tasksIn(b, name);
    const perProfile = new Map<string, number>();
    for (const t of tasks)
      if (t.profile) perProfile.set(t.profile.id, (perProfile.get(t.profile.id) ?? 0) + 1);
    check(
      Object.keys(list).every((id) => perProfile.get(id) === 1) &&
        tasks.every(
          (t) =>
            t.profileGroupID === home.id &&
            t.profile &&
            list[t.profile.id]?.name === t.profile.name,
        ),
      `"${name}": one task for each of the ${Object.keys(list).length} profiles in "${home.name}", and no other`,
    );
    const g = group(b.tasks.groups, name);
    check(
      g.totalAmount === tasks.length && g.taskCounts[DEFAULT_CATEGORY] === tasks.length,
      `"${name}" counts its ${tasks.length} tasks`,
    );
  }

  // Ids: unique, keyed by themselves.
  const ids = [
    ...Object.values(b.profiles.lists).flatMap((l) => Object.entries(l)),
    ...Object.values(b.tasks.lists).flatMap((ls) =>
      Object.values(ls).flatMap((l) => Object.entries(l)),
    ),
    ...Object.values(b.accounts.lists).flatMap((l) => Object.entries(l)),
    ...Object.entries(b.imap),
  ];
  check(
    ids.every(([key, v]) => (v as { id: string }).id === key) &&
      new Set(ids.map(([k]) => k)).size === ids.length,
    `every one of ${ids.length} ids unique and keyed by itself`,
  );

  if (!desired.misc) {
    check(
      JSON.stringify(b.imap) === JSON.stringify(before.imap) &&
        JSON.stringify(b.accounts) === JSON.stringify(before.accounts),
      "logins and IMAP untouched",
    );
    return;
  }
  // The Target side: only the pickers that can run, their logins and their mailboxes.
  const running = desired.misc.filter(
    (d) =>
      d.products.length > 0 &&
      (d.password !== null ||
        Object.values(
          before.accounts.lists[group(before.accounts.groups, TARGET_ACCOUNT_GROUP).id] ?? {},
        ).some((a) => lower(a.email) === lower(d.email))),
  );
  const targetProfiles = profilesIn(b, TARGET_PROFILE_GROUP);
  check(
    names(targetProfiles) === names(running),
    `"${TARGET_PROFILE_GROUP}" holds exactly the ${running.length} pickers that can run`,
  );
  const accounts = Object.values(
    b.accounts.lists[group(b.accounts.groups, TARGET_ACCOUNT_GROUP).id] ?? {},
  );
  check(
    accounts.length === running.length &&
      running.every((d) => accounts.some((a) => lower(a.email) === lower(d.email))),
    `one login for each of them (${accounts.length})`,
  );
  const boxes = new Set(Object.values(b.imap).map((m) => lower(m.email)));
  const wanted = new Set(
    running.flatMap((d) =>
      d.mailbox ? [lower(d.mailbox.email)] : boxes.has(lower(d.email)) ? [lower(d.email)] : [],
    ),
  );
  check(
    boxes.size === wanted.size && [...wanted].every((m) => boxes.has(m)),
    `IMAP holds exactly their ${wanted.size} mailboxes`,
  );
  const proxy = group(b.proxies.groups, TARGET_PROXY_GROUP);
  const tasks = tasksIn(b, TARGET_TASK_GROUP);
  const accountIds = new Set(accounts.map((a) => a.id));
  check(
    tasks.every((t) => t.proxyGroupID === proxy.id && t.monitorProxyGroupID === proxy.id),
    `every Target task checks out and monitors on "${proxy.name}"`,
  );
  check(
    tasks.every(
      (t) =>
        t.account &&
        accountIds.has(t.account.id) &&
        t.profile &&
        targetProfiles.some((p) => p.id === t.profile?.id),
    ),
    "every Target task on a profile and login of its own",
  );
  check(
    tasks.every((t) => !t.running && t.status === "Idle" && t.currentProxy === null),
    "every Target task idle",
  );
  let rightTasks = true;
  for (const d of running) {
    const profile = targetProfiles.find((p) => lower(p.email) === lower(d.email));
    const mine = tasks.filter((t) => t.profile?.id === profile?.id);
    const qtys = new Set(d.products.map((p) => p.qty));
    const want = new Map<number, string[]>();
    for (const p of d.products) want.set(p.qty, [...(want.get(p.qty) ?? []), p.sku]);
    if (
      mine.length !== qtys.size ||
      !mine.every(
        (t) =>
          t.products.length === 1 &&
          want.get(t.products[0].productQuantity)?.join(", ") === t.products[0].monitorInput &&
          t.products[0].displayedItem === t.products[0].monitorInput,
      )
    )
      rightTasks = false;
  }
  check(rightTasks, "each picker: one task per qty, its TCINs comma-separated at that qty");
}

function main() {
  const files = {
    1: parseValorBackup(readFileSync(FILES[1], "utf8")),
    2: parseValorBackup(readFileSync(FILES[2], "utf8")),
  };
  for (const position of [1, 2] as const) {
    const b = files[position];
    console.log(`Instance ${position}: ${FILES[position]}`);
    console.log(
      `  Valor ${b.version}: ${Object.keys(b.profiles.groups).length} profile groups, ${Object.keys(b.tasks.groups).length} task groups, ` +
        `${Object.keys(b.imap).length} mailboxes; ${ACO_MAIN} ${profilesIn(b, ACO_MAIN).length}, ${ACO_BACKUP} ${profilesIn(b, ACO_BACKUP).length}`,
    );
  }
  const desired = desiredFrom(files);
  for (const position of [1, 2] as const) {
    console.log(
      `  desired for Instance ${position}: ${desired[position].main.length} main, ${desired[position].backup.length} backup` +
        (desired[position].misc ? `, ${desired[position].misc!.length} Target pickers` : ""),
    );
  }

  for (const position of [1, 2] as const) {
    const source = files[position];
    const want = desired[position];

    // --- 1. round trip ---
    console.log(`\nInstance ${position} -- 1. Round trip`);
    const started = Date.now();
    const trip = buildValorInstance(source, want, { uuid });
    console.log(`  built in ${Date.now() - started} ms`);
    describe(trip.report);
    const pkcSame = (x: ValorBackup) =>
      JSON.stringify([
        [ACO_MAIN, ACO_BACKUP].map((n) => [
          group(x.profiles.groups, n),
          x.profiles.lists[group(x.profiles.groups, n).id],
        ]),
        PKC_TASK_GROUPS.map((g) => [
          group(x.tasks.groups, g.name),
          x.tasks.lists[group(x.tasks.groups, g.name).id],
        ]),
      ]);
    check(
      pkcSame(trip.backup) === pkcSame(source),
      "Pokémon Center groups and tasks byte for byte as they were",
    );
    const p = trip.report.pkc.profiles;
    check(
      p.added.length + p.updated.length + p.moved.length + p.removed.length === 0,
      "no Pokémon Center profile new, updated, moved or removed",
    );
    check(
      trip.report.pkc.taskGroups.every((g) => g.added.length + g.removed.length + g.renamed === 0),
      "no Pokémon Center task added, removed or renamed",
    );
    if (position === 1) {
      check(
        serializeValorBackup(trip.backup) === serializeValorBackup(source),
        "the whole file byte for byte as it was",
      );
    } else {
      const m = trip.report.misc!;
      check(
        m.profiles.added.length === 0 && m.profiles.updated.length === 0,
        "no Target profile new or updated",
      );
      check(
        m.accounts.added.length + m.accounts.updated.length === 0,
        "no Target login new or changed",
      );
      check(m.imap.added.length + m.imap.updated.length === 0, "no mailbox new or changed");
      check(m.tasks.changed.length === 0, "every Target task runs what it ran");
    }
    checkFile(source, trip, want);

    // --- 2. a drop ---
    console.log(`\nInstance ${position} -- 2. A drop`);
    const edited = structuredClone(want);
    const [first, second, third, fourth] = edited.main;
    if (first) {
      first.card = {
        ...first.card,
        number: "4012888888881881",
        expYear: String(Number(first.card.expYear) + 1),
      };
    }
    if (second) second.shipping = { ...second.shipping, street: "1 Verify Way", zip: "73170" };
    if (third) {
      // Switched off: out of the file, with its tasks.
      edited.main = edited.main.filter((d) => d !== third);
      const k = edited.known.find((x) => x.name === third.name);
      if (k) k.why = "switched off";
    }
    if (fourth) fourth.name = `${fourth.name} (renamed)`;
    const promoted = edited.backup.shift();
    if (promoted) edited.main.push(promoted);
    if (first) {
      edited.main.push({
        ...structuredClone(first),
        key: "verify-new",
        name: "verify-new - 1",
        email: "verify-new-1@example.invalid",
      });
    }
    let target: { mixed?: string; none?: string; fresh?: string } = {};
    if (edited.misc) {
      const pool = profilesIn(source, TARGET_PROFILE_GROUP).slice(0, 8).map(vaultSide);
      const picks = ["91000001", "91000002", "91000003"];
      edited.misc = pool.slice(0, 6).map((d, i) => ({
        ...d,
        password: i === 5 ? null : `verify-pass-${i}`,
        mailbox:
          i % 2 === 0
            ? { server: "imap.gmail.com", email: `verify-box-${i}@example.invalid`, password: "x" }
            : null,
        // Mixed qty on the first: two tasks. The rest: one.
        products:
          i === 0
            ? [
                { sku: picks[0], qty: 2 },
                { sku: picks[1], qty: 1 },
                { sku: picks[2], qty: 2 },
              ]
            : picks.slice(0, 1 + (i % 3)).map((sku) => ({ sku, qty: 2 })),
      }));
      edited.misc.push({
        ...edited.misc[1],
        key: "verify-target-new",
        name: "verify-target - 1",
        email: "verify-target-1@example.invalid",
        password: "verify-pass-new",
        mailbox: null,
      });
      edited.products = picks.map((sku) => ({ sku, name: `Product ${sku}` }));
      target = {
        mixed: edited.misc[0]?.name,
        none: edited.misc[5]?.name,
        fresh: "verify-target - 1",
      };
    }
    const drop = buildValorInstance(source, edited, { uuid });
    describe(drop.report);
    const d = drop.report.pkc.profiles;
    check(
      !first ||
        d.updated.some(
          (l) =>
            l.name === first.name && l.fields?.includes("card") && l.fields.includes("card expiry"),
        ),
      "changed card reported, with its expiry",
    );
    check(
      !second ||
        d.updated.some(
          (l) => l.name === second.name && l.fields?.includes("street") && l.fields.includes("ZIP"),
        ),
      "changed address reported",
    );
    check(
      !third || d.removed.some((l) => l.name === third.name && l.why === "switched off"),
      "switched-off profile removed, with why",
    );
    check(
      !fourth ||
        d.updated.some((l) => l.name === fourth.name && l.fields?.includes("profile name")),
      "renamed profile reported",
    );
    check(
      !fourth ||
        drop.report.pkc.taskGroups
          .filter((g) => PKC_TASK_GROUPS.find((x) => x.name === g.name)?.profiles === "main")
          .every((g) => g.renamed >= 1),
      "its tasks show the new name",
    );
    check(
      !promoted || d.moved.some((l) => l.name === promoted.name),
      "backup-bot profile moved to main reported",
    );
    check(
      d.added.some((l) => l.name === "verify-new - 1"),
      "new profile reported",
    );
    if (edited.misc) {
      const m = drop.report.misc!;
      check(
        m.skipped.some((l) => l.name === target.none),
        "picker with no password and no login skipped, and named",
      );
      check(
        m.profiles.added.some((l) => l.name === target.fresh) &&
          m.accounts.added.includes("verify-target-1@example.invalid"),
        "new picker added with a new login",
      );
      check(
        m.tasks.changed.some((c) => c.profile === target.mixed && c.after.length === 2),
        "mixed-qty picker gets a task per qty",
      );
    }
    checkFile(source, drop, edited);
    if (OUT_DIR)
      writeFileSync(
        join(OUT_DIR, `verify-valor-instance-${position}.json`),
        serializeValorBackup(drop.backup),
      );

    // --- 3. again ---
    console.log(`\nInstance ${position} -- 3. Again, on the drop's output`);
    const again = buildValorInstance(drop.backup, edited, { uuid });
    describe(again.report);
    check(
      serializeValorBackup(again.backup) === serializeValorBackup(drop.backup),
      "the second build changes nothing",
    );
  }

  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}

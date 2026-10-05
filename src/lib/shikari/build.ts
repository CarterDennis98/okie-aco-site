import { freshDeviceData } from "@/lib/shikari/device";
import { jsonObject, pyJson, shikariTime } from "@/lib/shikari/format";
import { checkShikariSchema } from "@/lib/shikari/schema";
import {
  TARGET_GROUP,
  UPDATES_GROUP,
  checkInterval,
  findGroup,
  groupKey,
  isCheckout,
  isRemoteWatchdog,
  isTargetGroupName,
  isWatchdog,
  isWipe,
  lower,
  mostCommon,
  readSnapshot,
  targetGroups,
  type SAccount,
  type SAddress,
  type SProfile,
  type STask,
  type ShikariSnapshot,
  type TargetGroups,
} from "@/lib/shikari/snapshot";
import type { ShikariDb, SqlParam } from "@/lib/shikari/sqlite";
import type {
  AbsentReason,
  BuildOptions,
  BuildReport,
  DesiredInstance,
  DesiredProfile,
  KnownProfile,
  ShikariAddress,
  TaskChange,
  WatchList,
} from "@/lib/shikari/types";

/**
 * Rewrites one Shikari instance's backup from the vault: IN PLACE, and CLEAN.
 *
 * IN PLACE. Every row the vault has an opinion about is updated where it stands, keeping
 * its id, so everything that hangs off it survives the export:
 *
 *   - an ACCOUNT keeps its logged-in session and cookie jars -- only its password moves;
 *   - a CHECKOUT TASK keeps its browser, fingerprint, sticky proxy, preload state and
 *     mailbox -- only its product list moves;
 *   - a PROXY keeps its id when its list is swapped, so every browser pinned to "the 23rd
 *     proxy in Resi" is pinned to the new 23rd one, not left pointing at nothing.
 *
 * CLEAN. On the Target side the file comes out holding this instance's active profiles and
 * what they need, and nothing else:
 *
 *   - the "Target" profile group keeps only the profiles this instance runs. Everything else
 *     in it and in its paused group -- switched off, on the other bot, another runner's,
 *     never heard of -- is deleted, with its tasks;
 *   - other Target groups go too when the operator says so ("Target - Secondary");
 *   - Target logins no remaining profile signs in with are deleted, with their sessions, and
 *     mailboxes no profile or task reads codes from;
 *   - so are old Wipe Account tasks, addresses and cards nothing points at, and groups the
 *     export emptied.
 *
 * The report names every one of those, with the reason, before anything is downloaded.
 *
 * WHAT IS NEVER TOUCHED: anything that isn't Target. One instance runs Walmart from the same
 * database, and 131 of its emails and 141 of its names are also a Target profile's -- so a
 * profile outside the Target groups is never matched or deleted, no other site's login or
 * task is, and a profile any other site's task uses stays wherever it is. Other Target groups
 * something is running ("Crisp Target", another runner's) are kept unless the operator says
 * otherwise. Harvesters, the licence and settings are never read.
 *
 * New rows copy the shape of rows the backup already has -- a new checkout task copies the
 * instance's own checkout tasks, a new watchdog its own watchdogs, a wipe its own Wipe
 * Account tasks -- rather than a shape written down here, because the backup is the
 * authority on what this Shikari version expects. The built-in shapes (from the reference
 * backups) are only the fallback for an instance that has none to copy.
 *
 * Runs in ONE TRANSACTION on a copy of the uploaded file: it either all applies or the copy
 * is thrown away, and the original bytes are never written to. The returned report is what
 * the operator reviews before anything is downloaded -- and since it is the log of what
 * this exact run did to this exact copy, the review cannot disagree with the file.
 */

export class BuildError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BuildError";
  }
}

export function buildInstance(
  db: ShikariDb,
  desired: DesiredInstance,
  options: BuildOptions,
): BuildReport {
  const schema = checkShikariSchema(db);
  if (!schema.ok) {
    throw new BuildError(
      `This backup isn't in a format the export knows (${schema.problems.slice(0, 4).join("; ")}). ` +
        "Shikari may have updated -- nothing was changed.",
    );
  }
  return db.transaction(() => new InstanceBuilder(db, desired, options).run());
}

// ---------------------------------------------------------------------------
// Built-in shapes, for an instance with nothing to copy. From the reference backups.
// ---------------------------------------------------------------------------

const DEFAULT_CHECKOUT_OPTIONS = {
  auto_loop_checkout: false,
  login_method: "password",
  apply_circle_offers: false,
  bypass_threshold: false,
  save_cc_to_account: true,
  ignore_low_stock: false,
};

/** A watchdog's settings, every one unset but the card rule -- as Shikari writes them. */
const DEFAULT_WATCHDOG_DATA: Record<string, unknown> = {
  atc_method: null,
  solve_method: null,
  checkout_flow: null,
  "site-password": null,
  "continuous-captcha-solving": null,
  apply_circle_offers: null,
  allow_third_party_sellers: null,
  save_cc_to_account: true,
  use_saved_paypal: null,
  require_sms_verified: null,
  ignore_low_stock: null,
  bypass_threshold: null,
  fallback_proxy_group_id: null,
  membership_type: null,
  login_method: null,
  phone_verification_method: null,
};

const DEFAULT_WATCHDOG_STATE_KEYS = [
  "atc_method",
  "solve_method",
  "checkout_flow",
  "site-password",
  "continuous-captcha-solving",
  "allow_third_party_sellers",
  "use_saved_paypal",
  "require_sms_verified",
  "fallback_proxy_group_id",
  "phone_verification_method",
];

/**
 * A Wipe Account task as Shikari writes one -- all 38 on the main instance are this: no
 * settings, no target kind, no products, no mailbox. Used when the backup has none to copy,
 * which after one export is every backup with nothing pending: the old ones are cleared.
 */
const DEFAULT_WIPE = {
  type: "Wipe Account",
  flowKey: "wipe_account",
  targetKind: null,
  genericData: "{}",
  options: "{}",
};

/** Why a profile the site knows isn't on this instance, as the report says it. */
const ABSENT: Record<AbsentReason, string> = {
  inactive: "switched off",
  runner: "another runner's",
  main: "runs on the main bot",
  backup: "runs on a backup bot",
  member: "member not on this instance",
};

/** Shikari's own colours for its groups; the new one matches the old "Target Wipe" green. */
const TARGET_COLOR = "#D81B60";
const UPDATES_COLOR = "#0B8043";

/** Products are watched by TCIN, the only method any Target task in a backup has used. */
const TARGET_METHOD = "tcins";

/** SQLite's bound-parameter ceiling is far above this; batches keep each statement modest. */
const BATCH = 500;

/** Names, listed in a warning, before "and N more". */
const LISTED = 5;

// ---------------------------------------------------------------------------

type ProfileMatch = {
  /** Desired profile key -> the Shikari profile that becomes it. */
  matched: Map<string, SProfile>;
  /**
   * Every other profile the export answers for -- the rest of "Target" and its paused group,
   * and everything in a group being cleared -- with why it isn't this instance's.
   */
  others: { profile: SProfile; why: string }[];
  /** The ones in `others` that are a second copy of a profile already claimed. */
  duplicates: Set<number>;
  /** Shikari ids of every profile the export answers for: claimed, or in `others`. */
  managed: Set<number>;
};

/** A profile of ours that isn't this instance's, and what became of it. */
type Departure = { profile: SProfile; why: string; deleted: boolean };

class InstanceBuilder {
  private readonly s: ShikariSnapshot;
  private readonly groups: TargetGroups;
  private readonly now: string;
  private readonly report: BuildReport;
  /** Desired profile key -> its Shikari profile id, once matched or created. */
  private readonly profileIdByKey = new Map<string, number>();
  /** Lowercased mailbox address -> its imap_account id. */
  private readonly imapIdByMailbox = new Map<string, number>();
  private readonly sticky: StickyProxies;
  private readonly addressRefs = new Map<number, Set<number>>();
  private readonly cardRefs = new Map<number, Set<number>>();
  private readonly fkBefore: Set<string>;
  /**
   * Proxy groups that exist. Browsers can point at deleted ones -- 71 do on the main
   * instance, all 38 of its Wipe Account browsers among them -- and copying one of those
   * onto a new browser would be a broken reference the export introduced.
   */
  private readonly liveProxyGroups: Set<number>;
  /** Other Target profile groups being cleared out, by id. */
  private readonly removing: Set<number>;
  /** Profiles with a Target checkout task, before: the ones set up to run. */
  private readonly withCheckout = new Set<number>();
  /** Profiles with a Target checkout task that had products, before: the ones running. */
  private readonly runningBefore = new Set<number>();
  private readonly knownByEmail: Map<string, KnownProfile>;
  private readonly knownByName: Map<string, KnownProfile>;
  /** The Target login each of this instance's profiles signs in with, by account id. */
  private readonly logins = new Set<number>();
  // What happened to each profile, sorted into the report's lists once the build is done:
  // whether a profile was activated or deactivated depends on its tasks, which come later.
  private readonly created = new Set<string>();
  private readonly changed = new Map<string, string[]>();
  private readonly movedFrom = new Map<string, string>();
  private readonly departures: Departure[] = [];
  /** Target tasks other than checkouts and wipes that went with a deleted profile, by type. */
  private readonly otherTasks: string[] = [];
  /** The "Target" profile group, once found or made. */
  private targetProfileGroupId: number | null = null;
  /** The task group this export rebuilds as "Target", once claimed. */
  private targetTaskGroupId: number | null = null;

  constructor(
    private readonly db: ShikariDb,
    private readonly desired: DesiredInstance,
    private readonly options: BuildOptions,
  ) {
    this.s = readSnapshot(db);
    this.groups = targetGroups(this.s);
    this.now = shikariTime(options.now);
    this.sticky = new StickyProxies(db);
    this.fkBefore = foreignKeyProblems(db);
    this.liveProxyGroups = new Set(this.s.proxyGroups.map((g) => g.id));
    for (const p of this.s.profiles) {
      for (const id of [p.shippingId, p.billingId])
        if (id !== null) ref(this.addressRefs, id, p.id);
      ref(this.cardRefs, p.cardId, p.id);
    }
    const stocked = new Set(this.s.products.map((p) => p.taskId));
    for (const task of this.s.tasks) {
      if (!this.isTargetCheckout(task) || task.profileId === null) continue;
      this.withCheckout.add(task.profileId);
      if (stocked.has(task.id)) this.runningBefore.add(task.profileId);
    }
    this.knownByEmail = new Map(desired.known.map((k) => [lower(k.email), k]));
    this.knownByName = new Map(desired.known.map((k) => [lower(k.name), k]));
    this.report = {
      version: this.s.version,
      taskGroup: null,
      profiles: {
        added: [],
        updated: [],
        activated: [],
        deactivated: [],
        removed: [],
        unchanged: 0,
        duplicates: [],
        kept: [],
      },
      accounts: { added: [], updated: [], unchanged: 0, noPassword: [], removed: 0 },
      imap: { added: [], updated: [], unchanged: 0, removed: 0 },
      strays: 0,
      groupsRemoved: { profile: [], task: [] },
      proxies: [],
      checkout: {
        added: [],
        removed: [],
        changed: [],
        unchanged: 0,
        untouched: [],
        noProducts: [],
        missingProfile: [],
      },
      watchdogs: { before: [], after: [], remote: { before: 0, after: 0 } },
      wipes: { added: [], removed: 0, template: null },
      warnings: [],
    };
    this.removing = this.groupsToClear();
  }

  /** Desired profiles in name order, so every list in the report reads the same way. */
  private get people(): DesiredProfile[] {
    const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });
    return [...this.desired.profiles].sort((a, b) => collator.compare(a.name, b.name));
  }

  /** A Target checkout task -- website matters: Walmart has checkout tasks too. */
  private isTargetCheckout(task: STask): boolean {
    return isCheckout(task) && task.websiteId === this.s.targetWebsiteId;
  }

  private groupName(id: number | null | undefined): string {
    return this.s.profileGroups.find((g) => g.id === id)?.name ?? `group ${id}`;
  }

  run(): BuildReport {
    const { sections } = this.options;
    const match = this.matchProfiles();

    if (sections.profiles) {
      this.syncProfiles(match);
    } else {
      for (const [key, profile] of match.matched) this.profileIdByKey.set(key, profile.id);
      for (const other of match.others) this.departures.push({ ...other, deleted: false });
    }
    if (sections.accounts) this.syncAccounts();
    this.syncImap(sections.imap);
    if (sections.proxies) this.syncProxies();
    if (sections.tasks) this.syncTargetTasks(match);
    if (sections.wipes) this.syncWipes();

    // The clean-up: what nothing on the Target side uses any more, now that the rest is done.
    if (sections.accounts) this.pruneLogins();
    if (sections.imap) this.pruneMailboxes();
    if (sections.profiles) this.pruneStrays();
    this.dropEmptiedGroups();

    this.sortProfiles();
    this.checkIntegrity();
    return this.report;
  }

  private warnList(names: string[], say: (list: string) => string) {
    if (names.length === 0) return;
    const shown = names.slice(0, LISTED).join(", ");
    this.report.warnings.push(
      say(names.length > LISTED ? `${shown} and ${names.length - LISTED} more` : shown),
    );
  }

  // -------------------------------------------------------------------------
  // Profiles
  // -------------------------------------------------------------------------

  /**
   * The other Target groups the operator chose to clear, checked: the export's own two are
   * cleared regardless, and a group that isn't Target is refused -- a Walmart group can't be
   * emptied from a Target export, whatever the request says. Only with the profiles section
   * on, since clearing a group is deleting its profiles.
   */
  private groupsToClear(): Set<number> {
    const ids = new Set<number>();
    if (!this.options.sections.profiles) return ids;
    for (const id of this.options.removeProfileGroups) {
      const group = this.s.profileGroups.find((g) => g.id === id);
      if (!group || id === this.groups.profiles?.id || id === this.groups.paused?.id) continue;
      if (!isTargetGroupName(group.name)) {
        this.report.warnings.push(`"${group.name}" isn't a Target group, so it was left as it is.`);
        continue;
      }
      ids.add(id);
    }
    return ids;
  }

  /**
   * Which Shikari profile each vault profile is -- looking ONLY in the "Target" profile
   * group and its paused group. See targetGroups for why nothing else is ever a candidate.
   *
   * By EMAIL first: it is unique per retailer in the vault, and it is what the profile's
   * account is keyed on in Shikari too. By NAME as the fallback, which is what catches a
   * member who changed their Target email -- the profile keeps its row and takes the new
   * address. Where two Shikari profiles claim one vault profile, the one with a Target
   * checkout task wins (it is the one being run), then one not parked, then the older.
   *
   * Everything else in those two groups is not this instance's, and is listed with the
   * reason: the site says why for every profile it holds, and one it has never heard of is
   * said to be that.
   */
  private matchProfiles(): ProfileMatch {
    const { candidates, paused } = this.groups;
    const inScope = this.s.profiles.filter((p) => candidates.has(p.id));
    const byEmail = new Map<string, SProfile[]>();
    const byName = new Map<string, SProfile[]>();
    for (const profile of inScope) {
      push(byEmail, lower(profile.email), profile);
      push(byName, lower(profile.name), profile);
    }
    const claimed = new Set<number>();
    const rank = (p: SProfile) =>
      (this.withCheckout.has(p.id) ? 0 : 2) + (paused && p.groupId === paused.id ? 1 : 0);
    const pick = (list: SProfile[] | undefined) =>
      (list ?? [])
        .filter((p) => !claimed.has(p.id))
        .sort((a, b) => rank(a) - rank(b) || a.id - b.id)[0];

    const matched = new Map<string, SProfile>();
    const unmatched: DesiredProfile[] = [];
    for (const d of this.people) {
      const profile = pick(byEmail.get(lower(d.email))) ?? pick(byName.get(lower(d.name)));
      if (!profile) {
        unmatched.push(d);
        continue;
      }
      claimed.add(profile.id);
      matched.set(d.key, profile);
    }

    // A vault profile that only exists in some other Target group being kept -- another
    // runner's, say -- gets a new profile in "Target", and that is worth saying: it may mean
    // the member is now set up twice. One in a group being cleared is gone either way.
    const elsewhere = this.s.profiles.filter(
      (p) =>
        !candidates.has(p.id) &&
        !this.removing.has(p.groupId) &&
        isTargetGroupName(this.groupName(p.groupId)),
    );
    this.warnList(
      unmatched.flatMap((d) => {
        const other = elsewhere.find(
          (p) => lower(p.email) === lower(d.email) || lower(p.name) === lower(d.name),
        );
        return other ? [`${d.name} (in "${this.groupName(other.groupId)}")`] : [];
      }),
      (list) =>
        `Not in "${TARGET_GROUP}" but in another Target group, so added to "${TARGET_GROUP}" as new: ${list}. ` +
        "Check the old one isn't running too.",
    );

    const wantedByEmail = new Map(this.desired.profiles.map((d) => [lower(d.email), d]));
    const wantedByName = new Map(this.desired.profiles.map((d) => [lower(d.name), d]));
    const others: ProfileMatch["others"] = [];
    const duplicates = new Set<number>();
    const managed = new Set<number>(claimed);
    for (const profile of inScope) {
      if (claimed.has(profile.id)) continue;
      managed.add(profile.id);
      const copyOf =
        wantedByEmail.get(lower(profile.email)) ?? wantedByName.get(lower(profile.name));
      if (copyOf) {
        duplicates.add(profile.id);
        others.push({ profile, why: `a second copy of ${copyOf.name}` });
      } else {
        others.push({ profile, why: this.whyNotHere(profile) });
      }
    }
    for (const profile of this.s.profiles) {
      if (!this.removing.has(profile.groupId)) continue;
      managed.add(profile.id);
      others.push({ profile, why: this.whyNotHere(profile) });
    }
    return { matched, others, duplicates, managed };
  }

  /** Why a profile in the backup isn't one this instance runs, in the report's words. */
  private whyNotHere(profile: SProfile): string {
    const known =
      this.knownByEmail.get(lower(profile.email)) ?? this.knownByName.get(lower(profile.name));
    if (!known) return "not on the site";
    if (known.instance !== undefined && known.instance !== this.desired.position)
      return `runs on Instance ${known.instance}`;
    return known.why ? ABSENT[known.why] : "not on this instance";
  }

  private syncProfiles(match: ProfileMatch) {
    const groupId = this.targetProfileGroup();
    for (const d of this.people) {
      const existing = match.matched.get(d.key);
      if (!existing) {
        this.profileIdByKey.set(d.key, this.insertProfile(d, groupId));
        this.created.add(d.key);
        continue;
      }
      this.profileIdByKey.set(d.key, existing.id);
      const { fields, movedFrom } = this.updateProfile(existing, d, groupId);
      if (fields.length > 0) this.changed.set(d.key, fields);
      if (movedFrom) this.movedFrom.set(d.key, movedFrom);
    }

    const blocked: string[] = [];
    for (const { profile, why } of match.others) {
      if (match.duplicates.has(profile.id)) this.report.profiles.duplicates.push(profile.name);
      const deleted = this.removeProfile(profile);
      if (!deleted) blocked.push(`${profile.name} (in "${this.groupName(profile.groupId)}")`);
      this.departures.push({ profile, why, deleted });
    }
    this.warnList(
      blocked,
      (list) => `Used by a task for another site, so left where they are: ${list}.`,
    );
  }

  private targetProfileGroup(): number {
    this.targetProfileGroupId ??=
      this.groups.profiles?.id ?? this.ensureGroup("profile_group", TARGET_GROUP);
    return this.targetProfileGroupId;
  }

  /**
   * Deletes a profile that isn't this instance's, with every Target task that uses it --
   * checkout, wipe, whatever group it sits in -- and the address and card rows it leaves
   * unused. Not when a task for ANOTHER site uses it: deleting the profile would leave that
   * task pointing at nothing, and the export never touches another site's tasks. Answers
   * whether it was deleted.
   */
  private removeProfile(profile: SProfile): boolean {
    const tasks = this.db.all<{
      id: number;
      type: string | null;
      flow_key: string | null;
      website_id: number;
    }>("SELECT id, type, flow_key, website_id FROM task WHERE profile_id = ?", [profile.id]);
    if (tasks.some((t) => Number(t.website_id) !== this.s.targetWebsiteId)) return false;

    for (const task of tasks) {
      const kind = { type: task.type, flowKey: task.flow_key } as STask;
      if (!this.deleteTask(task.id)) continue;
      if (isWipe(kind)) this.report.wipes.removed += 1;
      else if (!isCheckout(kind)) this.otherTasks.push(task.type || task.flow_key || "task");
    }
    this.db.run("DELETE FROM profile WHERE id = ?", [profile.id]);
    this.dropAddressIfUnused(profile.shippingId, profile.id);
    if (profile.billingId !== null && profile.billingId !== profile.shippingId)
      this.dropAddressIfUnused(profile.billingId, profile.id);
    this.dropCardIfUnused(profile.cardId, profile.id);
    return true;
  }

  /**
   * Sorts every profile into the report's lists, once nothing else will change: whether a
   * profile is RUNNING -- has a Target checkout task with products to check out -- is the
   * difference between activated and updated, and deactivated and removed.
   */
  private sortProfiles() {
    const report = this.report.profiles;
    const running = new Set(
      this.db
        .all<{ id: number }>(
          `SELECT DISTINCT t.profile_id AS id FROM task t
            WHERE t.website_id = ? AND t.profile_id IS NOT NULL
              AND (lower(t.type) = 'checkout' OR lower(t.flow_key) = 'checkout')
              AND EXISTS (SELECT 1 FROM target_product p WHERE p.task_id = t.id)`,
          [this.s.targetWebsiteId],
        )
        .map((r) => Number(r.id)),
    );
    const idle = (d: DesiredProfile) => (d.skus.length === 0 ? "picked no products" : "no task");

    for (const d of this.people) {
      const id = this.profileIdByKey.get(d.key);
      if (id === undefined) continue;
      const line = { name: d.name, owner: d.ownerName };
      const now = running.has(id);
      if (this.created.has(d.key)) {
        report.added.push(now ? line : { ...line, why: idle(d) });
        continue;
      }
      const was = this.runningBefore.has(id);
      const moved = this.movedFrom.get(d.key);
      const fields = [...(this.changed.get(d.key) ?? [])];
      if (!was && now) {
        report.activated.push({
          ...line,
          why: moved
            ? `was in "${moved}"`
            : this.withCheckout.has(id)
              ? "had no products"
              : "had no checkout task",
        });
      } else if (moved) {
        fields.push(`moved from "${moved}"`);
      }
      if (was && !now) report.deactivated.push({ ...line, why: idle(d) });
      if (fields.length > 0) report.updated.push({ ...line, fields });
      else if (was === now) report.unchanged += 1;
    }

    for (const { profile, why, deleted } of this.departures) {
      const line = { name: profile.name, why, group: this.groupName(profile.groupId) };
      const was = this.runningBefore.has(profile.id);
      if (deleted) (was ? report.deactivated : report.removed).push(line);
      else if (was && !running.has(profile.id)) report.deactivated.push(line);
    }

    // The groups left as they were, so the review can say why each one was.
    const before = new Map<number, number>();
    for (const profile of this.s.profiles)
      before.set(profile.groupId, (before.get(profile.groupId) ?? 0) + 1);
    const groupOf = new Map(this.s.profiles.map((p) => [p.id, p.groupId]));
    const used = new Set(
      this.s.tasks.flatMap((t) => {
        const group = t.profileId === null ? undefined : groupOf.get(t.profileId);
        return group === undefined ? [] : [group];
      }),
    );
    for (const group of this.s.profileGroups) {
      const count = before.get(group.id) ?? 0;
      if (count === 0 || this.removing.has(group.id)) continue;
      if (group.id === this.groups.profiles?.id || group.id === this.groups.paused?.id) continue;
      report.kept.push({
        group: group.name,
        count,
        why: !isTargetGroupName(group.name)
          ? "not Target"
          : used.has(group.id)
            ? "in use"
            : "kept by choice",
      });
    }

    const tally = new Map<string, number>();
    for (const type of this.otherTasks) tally.set(type, (tally.get(type) ?? 0) + 1);
    if (tally.size > 0) {
      this.report.warnings.push(
        `Also took out ${this.otherTasks.length} other Target task${this.otherTasks.length === 1 ? "" : "s"} ` +
          `of profiles that came out: ${[...tally].map(([type, n]) => `${type} ×${n}`).join(", ")}.`,
      );
    }
  }

  private insertProfile(d: DesiredProfile, groupId: number): number {
    const shippingId = this.insertAddress(d.shipping);
    const billingId = d.billing ? this.insertAddress(d.billing) : shippingId;
    const cardId = this.db.insert(
      `INSERT INTO credit_card (created_at, updated_at, card_number, expire_month, expire_year, cvv)
       VALUES (?, NULL, ?, ?, ?, ?)`,
      [this.now, d.card.number, d.card.expMonth, d.card.expYear, d.card.cvv],
    );
    const id = this.db.insert(
      `INSERT INTO profile (created_at, updated_at, name, email, shipping_address_id,
                            billing_address_id, credit_card_id, profile_group_id)
       VALUES (?, NULL, ?, ?, ?, ?, ?, ?)`,
      [this.now, d.name, d.email, shippingId, billingId, cardId, groupId],
    );
    ref(this.addressRefs, shippingId, id);
    ref(this.addressRefs, billingId, id);
    ref(this.cardRefs, cardId, id);
    return id;
  }

  /**
   * Brings one Shikari profile in line with the vault. Answers what changed, by name, and
   * the group it was moved out of -- kept apart, since a profile moved back from the paused
   * group is ACTIVATED, which the report says on its own line rather than as an edit.
   */
  private updateProfile(
    profile: SProfile,
    d: DesiredProfile,
    groupId: number,
  ): { fields: string[]; movedFrom: string | null } {
    const fields: string[] = [];
    let shippingId = profile.shippingId;
    let billingId = profile.billingId;
    let cardId = profile.cardId;
    // Rows this profile stops pointing at, checked for orphaning only once the profile row
    // itself has been rewritten -- before that, the database still says it uses them.
    const released: number[] = [];

    // --- shipping ---
    const shipping = this.s.addresses.get(shippingId);
    const shipChanges = shipping ? addressChanges(shipping, d.shipping) : ["shipping address"];
    if (shipChanges.length > 0) {
      fields.push(...shipChanges);
      // Shared with ANOTHER profile -- never seen, but a row two profiles point at must not
      // be edited out from under the other one. Its own billing pointing here is fine.
      if (!shipping || this.sharedWithOthers(this.addressRefs, shippingId, profile.id)) {
        const next = this.insertAddress(d.shipping);
        if (billingId === shippingId && !d.billing) billingId = next;
        this.moveRef(this.addressRefs, shippingId, next, profile.id);
        shippingId = next;
      } else {
        this.updateAddress(shippingId, d.shipping);
      }
    }

    // --- billing ---
    // Shikari stores "billing is shipping" as both columns pointing at one row.
    if (!d.billing) {
      if (billingId !== shippingId) {
        fields.push("billing address (now the shipping address)");
        const old = billingId;
        billingId = shippingId;
        if (old !== null) {
          this.moveRef(this.addressRefs, old, shippingId, profile.id);
          released.push(old);
        }
      }
    } else if (billingId === null || billingId === shippingId) {
      fields.push("billing address");
      billingId = this.insertAddress(d.billing);
      ref(this.addressRefs, billingId, profile.id);
    } else {
      const billing = this.s.addresses.get(billingId);
      const billChanges = billing ? addressChanges(billing, d.billing) : ["address"];
      if (billChanges.length > 0) {
        fields.push(...billChanges.map((field) => `billing ${field}`));
        if (!billing || this.sharedWithOthers(this.addressRefs, billingId, profile.id)) {
          const next = this.insertAddress(d.billing);
          this.moveRef(this.addressRefs, billingId, next, profile.id);
          billingId = next;
        } else {
          this.updateAddress(billingId, d.billing);
        }
      }
    }

    // --- card ---
    const card = this.s.cards.get(cardId);
    const cardChanges: string[] = [];
    if (!card || card.number.replace(/\D/g, "") !== d.card.number) cardChanges.push("card");
    if (!card || card.expMonth !== d.card.expMonth || card.expYear !== d.card.expYear)
      cardChanges.push("card expiry");
    if (!card || card.cvv.trim() !== d.card.cvv) cardChanges.push("CVV");
    if (cardChanges.length > 0) {
      fields.push(...cardChanges);
      const values = [d.card.number, d.card.expMonth, d.card.expYear, d.card.cvv];
      if (!card || this.sharedWithOthers(this.cardRefs, cardId, profile.id)) {
        const next = this.db.insert(
          `INSERT INTO credit_card (created_at, updated_at, card_number, expire_month, expire_year, cvv)
           VALUES (?, NULL, ?, ?, ?, ?)`,
          [this.now, ...values],
        );
        this.moveRef(this.cardRefs, cardId, next, profile.id);
        cardId = next;
      } else {
        this.db.run(
          `UPDATE credit_card SET card_number = ?, expire_month = ?, expire_year = ?, cvv = ?, updated_at = ?
           WHERE id = ?`,
          [...values, this.now, cardId],
        );
      }
    }

    // --- the profile row itself ---
    if (profile.name !== d.name) fields.push("profile name");
    if (lower(profile.email) !== lower(d.email)) fields.push("email");
    const movedFrom = profile.groupId === groupId ? null : this.groupName(profile.groupId);

    if (fields.length > 0 || movedFrom) {
      this.db.run(
        `UPDATE profile SET name = ?, email = ?, shipping_address_id = ?, billing_address_id = ?,
                            credit_card_id = ?, profile_group_id = ?, updated_at = ?
         WHERE id = ?`,
        [d.name, d.email, shippingId, billingId, cardId, groupId, this.now, profile.id],
      );
    }
    for (const id of released) this.dropAddressIfUnused(id, profile.id);
    return { fields, movedFrom };
  }

  private insertAddress(a: ShikariAddress): number {
    return this.db.insert(
      `INSERT INTO address (created_at, updated_at, first_name, last_name, street, street_2,
                            city, state, zip_code, country, phone_number)
       VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [this.now, ...addressValues(a)],
    );
  }

  private updateAddress(id: number, a: ShikariAddress) {
    this.db.run(
      `UPDATE address SET first_name = ?, last_name = ?, street = ?, street_2 = ?, city = ?,
                          state = ?, zip_code = ?, country = ?, phone_number = ?, updated_at = ?
       WHERE id = ?`,
      [...addressValues(a), this.now, id],
    );
  }

  private sharedWithOthers(refs: Map<number, Set<number>>, id: number, profileId: number) {
    return [...(refs.get(id) ?? [])].some((owner) => owner !== profileId);
  }

  private moveRef(refs: Map<number, Set<number>>, from: number, to: number, profileId: number) {
    refs.get(from)?.delete(profileId);
    ref(refs, to, profileId);
  }

  private dropAddressIfUnused(id: number, profileId: number) {
    this.addressRefs.get(id)?.delete(profileId);
    const inUse = this.db.get(
      "SELECT 1 FROM profile WHERE shipping_address_id = ? OR billing_address_id = ? LIMIT 1",
      [id, id],
    );
    if (!inUse) this.db.run("DELETE FROM address WHERE id = ?", [id]);
  }

  private dropCardIfUnused(id: number, profileId: number) {
    this.cardRefs.get(id)?.delete(profileId);
    if (!this.db.get("SELECT 1 FROM profile WHERE credit_card_id = ? LIMIT 1", [id])) {
      this.db.run("DELETE FROM credit_card WHERE id = ?", [id]);
    }
  }

  // -------------------------------------------------------------------------
  // Accounts and mailboxes
  // -------------------------------------------------------------------------

  /**
   * One Target login per profile, with the vault's password.
   *
   * A login can be on file twice, differing only in capitals: 57 profiles on the main
   * instance have an older "Name@..." beside a newer "name@..." that an import added. The
   * older one is the one Shikari signs in with -- all 57 hold their session there, and not
   * one on the newer -- so the login a profile keeps, and whose password is updated, is the
   * one with a session, then the oldest. The other is left for pruneLogins.
   */
  private syncAccounts() {
    const report = this.report.accounts;
    const website = this.s.targetWebsiteId;
    const byUser = new Map<string, SAccount[]>();
    for (const account of this.s.accounts)
      if (account.websiteId === website) push(byUser, lower(account.username), account);
    for (const list of byUser.values())
      list.sort((a, b) => Number(b.signedIn) - Number(a.signedIn) || a.id - b.id);

    for (const d of this.people) {
      const account = byUser.get(lower(d.email))?.[0];
      if (account) this.logins.add(account.id);
      if (d.password === null) {
        report.noPassword.push(d.name);
        continue;
      }
      if (!account) {
        const id = this.db.insert(
          `INSERT INTO account (created_at, updated_at, username, password, website_id,
                                generic_data, session_data, cookie_jar_id, mobile_cookie_jar_id)
           VALUES (?, NULL, ?, ?, ?, '{}', '{}', NULL, NULL)`,
          [this.now, d.email, d.password, website],
        );
        byUser.set(lower(d.email), [
          { id, username: d.email, password: d.password, websiteId: website, signedIn: false },
        ]);
        this.logins.add(id);
        report.added.push(d.email);
      } else if (account.password !== d.password) {
        // The password column and nothing else: the session beside it is the account's
        // whole value to the bot, and Shikari logs back in with the new password on its own
        // if the old session dies.
        this.db.run("UPDATE account SET password = ?, updated_at = ? WHERE id = ?", [
          d.password,
          this.now,
          account.id,
        ]);
        account.password = d.password;
        report.updated.push(d.email);
      } else {
        report.unchanged += 1;
      }
    }
  }

  /**
   * Deletes every Target login no profile left on the Target side signs in with, and the
   * saved session that goes with it -- a login for a profile that came out, or for one
   * deleted long ago (336 on the main instance), or the unused twin of a profile's own.
   *
   * Kept: the login of each of this instance's profiles (see syncAccounts), and EVERY login
   * whose address is a remaining Target profile's that the export doesn't run -- another
   * runner's, in a group being kept -- capitals and all, since which of those Shikari signs
   * in with is not the export's to judge. Other sites' logins are never looked at.
   */
  private pruneLogins() {
    const website = this.s.targetWebsiteId;
    const ours = new Set(this.profileIdByKey.values());
    const onTarget = new Set(
      this.db
        .all<{ id: number }>(
          "SELECT DISTINCT profile_id AS id FROM task WHERE website_id = ? AND profile_id IS NOT NULL",
          [website],
        )
        .map((r) => Number(r.id)),
    );
    const theirs = new Set<string>();
    for (const p of this.db.all<{ id: number; email: string | null; group_name: string | null }>(
      `SELECT p.id, p.email, g.name AS group_name
         FROM profile p LEFT JOIN profile_group g ON g.id = p.profile_group_id`,
    )) {
      if (ours.has(Number(p.id))) continue;
      if (isTargetGroupName(p.group_name) || onTarget.has(Number(p.id))) theirs.add(lower(p.email));
    }

    for (const account of this.db.all<{
      id: number;
      username: string;
      cookie_jar_id: number | null;
      mobile_cookie_jar_id: number | null;
    }>(
      "SELECT id, username, cookie_jar_id, mobile_cookie_jar_id FROM account WHERE website_id = ?",
      [website],
    )) {
      if (this.logins.has(Number(account.id)) || theirs.has(lower(account.username))) continue;
      this.db.run("DELETE FROM account WHERE id = ?", [account.id]);
      for (const jar of [account.cookie_jar_id, account.mobile_cookie_jar_id])
        if (jar !== null) this.dropJarIfUnused(Number(jar));
      this.report.accounts.removed += 1;
    }
  }

  /**
   * Deletes every mailbox nothing reads codes from: not one of this instance's profiles'
   * (from the vault), not set on any task that is left, and not the inbox of any profile
   * left in the backup, on any site. That last is deliberately broad -- Shikari may read a
   * profile's own inbox without a task naming it -- so a mailbox only goes when nothing at
   * all could be using it.
   */
  private pruneMailboxes() {
    const used = new Set(
      this.db
        .all<{ id: number }>(
          "SELECT DISTINCT imap_account_id AS id FROM task WHERE imap_account_id IS NOT NULL",
        )
        .map((r) => Number(r.id)),
    );
    for (const id of this.imapIdByMailbox.values()) used.add(id);
    const inboxes = new Set(
      this.db.all<{ email: string | null }>("SELECT email FROM profile").map((r) => lower(r.email)),
    );
    for (const row of this.db.all<{ id: number; username: string | null }>(
      "SELECT id, username FROM imap_account",
    )) {
      if (used.has(Number(row.id)) || inboxes.has(lower(row.username))) continue;
      this.report.imap.removed += this.db.run("DELETE FROM imap_account WHERE id = ?", [row.id]);
    }
  }

  /**
   * Mailboxes behind this instance's profiles. Always resolves which imap_account row each
   * one is -- the checkout tasks point at it -- and writes only when the section is on.
   */
  private syncImap(write: boolean) {
    const report = this.report.imap;
    const rows = this.s.imap.map((row) => ({ ...row }));
    const seen = new Set<string>();

    for (const d of this.people) {
      const box = d.mailbox;
      if (!box) continue;
      const user = lower(box.username);
      if (seen.has(user)) continue;
      seen.add(user);

      const existing =
        rows.find((r) => lower(r.username) === user && lower(r.server) === lower(box.server)) ??
        rows.find((r) => lower(r.username) === user);

      if (!write) {
        if (existing) this.imapIdByMailbox.set(user, existing.id);
        continue;
      }
      if (!existing) {
        const id = this.db.insert(
          `INSERT INTO imap_account (created_at, updated_at, imap_server, port, username, password, is_enabled)
           VALUES (?, NULL, ?, ?, ?, ?, 1)`,
          [this.now, box.server, box.port, box.username, box.password],
        );
        rows.push({
          id,
          server: box.server,
          port: box.port,
          username: box.username,
          password: box.password,
          enabled: true,
        });
        this.imapIdByMailbox.set(user, id);
        report.added.push(box.username);
        continue;
      }
      this.imapIdByMailbox.set(user, existing.id);
      // The server is only rewritten when no other row already holds that (server,
      // username) pair -- the table's unique key -- so a fix can never collide with a copy.
      const serverMoves =
        lower(existing.server) !== lower(box.server) &&
        !rows.some(
          (r) =>
            r.id !== existing.id &&
            lower(r.username) === user &&
            lower(r.server) === lower(box.server),
        );
      const changed =
        existing.password !== box.password ||
        existing.port !== box.port ||
        !existing.enabled ||
        serverMoves;
      if (!changed) {
        report.unchanged += 1;
        continue;
      }
      this.db.run(
        `UPDATE imap_account SET imap_server = ?, port = ?, password = ?, is_enabled = 1, updated_at = ?
         WHERE id = ?`,
        [serverMoves ? box.server : existing.server, box.port, box.password, this.now, existing.id],
      );
      Object.assign(existing, {
        server: serverMoves ? box.server : existing.server,
        password: box.password,
        port: box.port,
        enabled: true,
      });
      report.updated.push(box.username);
    }
  }

  // -------------------------------------------------------------------------
  // Proxies
  // -------------------------------------------------------------------------

  /**
   * Swaps a group's list POSITION BY POSITION: the first new proxy goes into the first
   * existing row, and so on. Ids survive, so browsers pinned to a proxy stay pinned to the
   * same slot. A longer list adds rows; a shorter one removes the tail, and any browser that
   * was pinned to a removed row is moved to the least-used proxy left in the group.
   */
  private syncProxies() {
    for (const list of this.options.proxyLists) {
      const group = this.s.proxyGroups.find((g) => g.id === list.groupId);
      if (!group) {
        this.report.warnings.push(
          `Proxy group ${list.groupId} isn't in this backup; its list was skipped.`,
        );
        continue;
      }
      const old = group.proxies;
      const next = list.proxies;
      let changed = 0;

      const update = this.db.prepare(
        "UPDATE proxy SET host = ?, port = ?, username = ?, password = ?, updated_at = ? WHERE id = ?",
      );
      try {
        for (let i = 0; i < Math.min(old.length, next.length); i++) {
          const [a, b] = [old[i], next[i]];
          if (
            a.host === b.host &&
            a.port === b.port &&
            a.username === b.username &&
            a.password === b.password
          ) {
            continue;
          }
          update.run([b.host, b.port, b.username, b.password, this.now, a.id]);
          changed += 1;
        }
      } finally {
        update.free();
      }

      const insert = this.db.prepare(
        `INSERT INTO proxy (created_at, updated_at, proxy_group_id, host, port, username, password)
         VALUES (?, NULL, ?, ?, ?, ?, ?)`,
      );
      try {
        for (const proxy of next.slice(old.length)) {
          insert.run([this.now, group.id, proxy.host, proxy.port, proxy.username, proxy.password]);
          changed += 1;
        }
      } finally {
        insert.free();
      }

      const removed = old.slice(next.length).map((p) => p.id);
      let browsersMoved = 0;
      if (removed.length > 0) {
        const orphaned: { id: number; proxy_group_id: number | null }[] = [];
        for (const batch of batches(removed)) {
          orphaned.push(
            ...this.db.all<{ id: number; proxy_group_id: number | null }>(
              `SELECT id, proxy_group_id FROM browser WHERE proxy_id IN (${batch.map(() => "?").join(",")})`,
              batch,
            ),
          );
          this.db.run(`DELETE FROM proxy WHERE id IN (${batch.map(() => "?").join(",")})`, batch);
        }
        changed += removed.length;
        this.sticky.reset(group.id);
        for (const browser of orphaned) {
          const home = this.liveGroup(browser.proxy_group_id) ?? group.id;
          this.db.run("UPDATE browser SET proxy_id = ?, updated_at = ? WHERE id = ?", [
            this.sticky.take(home),
            this.now,
            browser.id,
          ]);
          browsersMoved += 1;
        }
      }
      this.sticky.reset(group.id);

      this.report.proxies.push({
        group: group.name,
        before: old.length,
        after: next.length,
        changed,
        browsersMoved,
      });
    }
  }

  // -------------------------------------------------------------------------
  // The "Target" task group: checkout tasks and watchdogs
  // -------------------------------------------------------------------------

  /**
   * The task group rebuilt as "Target", renamed to it if it isn't already: the group
   * targetGroups found -- the one already called "Target", or the one holding most of the
   * Target profiles' checkout tasks ("Target - All Products" on the main instance) -- or a
   * new one when there is neither.
   */
  private claimTargetTaskGroup(): number {
    if (this.targetTaskGroupId !== null) return this.targetTaskGroupId;
    const found = this.groups.tasks;
    if (!found) {
      this.targetTaskGroupId = this.ensureGroup("task_group", TARGET_GROUP, TARGET_COLOR);
      this.report.taskGroup = { name: TARGET_GROUP, renamedFrom: null, created: true };
      return this.targetTaskGroupId;
    }
    const renamed = groupKey(found.name) !== groupKey(TARGET_GROUP);
    if (renamed) {
      this.db.run("UPDATE task_group SET name = ?, updated_at = ? WHERE id = ?", [
        TARGET_GROUP,
        this.now,
        found.id,
      ]);
    }
    this.report.taskGroup = {
      name: renamed ? TARGET_GROUP : found.name,
      renamedFrom: renamed ? found.name : null,
      created: false,
    };
    this.targetTaskGroupId = found.id;
    return found.id;
  }

  /**
   * Every profile of ours gets exactly ONE Target checkout task, in the "Target" group.
   *
   * A profile's existing task is used wherever it sits -- the main instance keeps some in
   * "NO IMAP" -- and moved into "Target", keeping its browser, session and preload state.
   * Building a second one beside it would run the member twice. A profile of ours that this
   * instance isn't running loses its Target checkout tasks wherever they are; a profile the
   * site doesn't know keeps its tasks exactly as they are.
   */
  private syncTargetTasks(match: ProfileMatch) {
    const groupId = this.claimTargetTaskGroup();
    const inGroup = this.s.tasks.filter((t) => t.groupId === groupId);
    const report = this.report.checkout;
    const names = new Map(this.s.profiles.map((p) => [p.id, p.name]));
    const groupNames = new Map(this.s.taskGroups.map((g) => [g.id, g.name]));
    const productsOf = (taskId: number) =>
      this.s.products.filter((p) => p.taskId === taskId).map((p) => p.data);

    // --- checkout ---
    const ours = this.s.tasks.filter(
      (t) => this.isTargetCheckout(t) && t.profileId !== null && match.managed.has(t.profileId),
    );
    const byProfile = new Map<number, STask[]>();
    for (const task of ours) push(byProfile, task.profileId as number, task);
    // The one already in "Target" is the one to keep; otherwise the oldest.
    for (const list of byProfile.values()) {
      list.sort(
        (a, b) => Number(b.groupId === groupId) - Number(a.groupId === groupId) || a.id - b.id,
      );
    }
    // Tasks already dealt with: synced, created, or removed as a duplicate.
    const handled = new Set<number>();
    const running: string[] = [];

    for (const d of this.people) {
      const profileId = this.profileIdByKey.get(d.key);
      if (profileId === undefined) {
        if (d.skus.length > 0) report.missingProfile.push(d.name);
        continue;
      }
      if (d.skus.length === 0) {
        report.noProducts.push(d.name);
        continue;
      }
      running.push(...d.skus);
      const [task, ...extra] = byProfile.get(profileId) ?? [];
      for (const copy of extra) {
        this.deleteTask(copy.id);
        report.removed.push({
          profile: `${d.name} (a second copy)`,
          skus: productsOf(copy.id).length,
        });
        handled.add(copy.id);
      }
      if (!task) {
        handled.add(this.createCheckoutTask(groupId, profileId, d));
        report.added.push({ profile: d.name, skus: d.skus.length });
        continue;
      }
      handled.add(task.id);
      const change = this.syncCheckoutTask(task, d, groupId, groupNames.get(task.groupId ?? -1));
      if (change) report.changed.push(change);
      else report.unchanged += 1;
    }

    // What's left of ours belongs to profiles this instance isn't running: they come off,
    // which is what not being selected means. A profile deleted above has already taken its
    // tasks with it, and is listed here all the same, since its task is gone either way.
    for (const task of ours) {
      if (handled.has(task.id)) continue;
      const label = names.get(task.profileId as number) ?? `profile ${task.profileId}`;
      report.removed.push({
        profile: match.duplicates.has(task.profileId as number)
          ? `${label} (a second copy)`
          : label,
        skus: productsOf(task.id).length,
      });
      this.deleteTask(task.id);
    }
    // Other people's checkout tasks in the group stay as they are.
    for (const task of inGroup) {
      if (!this.isTargetCheckout(task) || handled.has(task.id)) continue;
      if (task.profileId !== null && match.managed.has(task.profileId)) continue;
      report.untouched.push(
        task.profileId === null
          ? `task ${task.id}`
          : (names.get(task.profileId) ?? `task ${task.id}`),
      );
    }

    // --- watchdogs ---
    const settings = this.options.tasks;
    const order = new Map(this.desired.products.map((p, i) => [p.sku, i]));
    const watched = [...new Set(running)].sort(
      (a, b) => (order.get(a) ?? Infinity) - (order.get(b) ?? Infinity) || a.localeCompare(b),
    );
    const perList = Math.max(1, settings.watchdogIntervals.length);
    const size = Math.max(1, Math.min(30, settings.skusPerWatchdog));
    const lists: string[][] = [];
    for (let i = 0; i < watched.length; i += size) lists.push(watched.slice(i, i + size));

    const watchdogs = inGroup.filter((t) => isWatchdog(t) && !isRemoteWatchdog(t));
    const remotes = inGroup.filter(isRemoteWatchdog);
    const template = watchdogs[0] ?? null;

    this.report.watchdogs.before = watchdogs.map((w) => ({
      interval: checkInterval(w),
      skus: productsOf(w.id),
    }));
    const after: WatchList[] = [];
    let slot = 0;
    for (const skus of lists) {
      for (const interval of settings.watchdogIntervals.slice(0, perList)) {
        const existing = watchdogs[slot];
        if (existing) this.syncWatchdog(existing, skus, interval);
        else this.createWatchdog(groupId, skus, interval, template, false);
        after.push({ interval, skus });
        slot += 1;
      }
    }
    for (const extra of watchdogs.slice(slot)) this.deleteTask(extra.id);
    this.report.watchdogs.after = after;

    const wantRemote = Math.max(0, settings.remoteWatchdogs);
    for (let i = remotes.length; i < wantRemote; i++)
      this.createWatchdog(groupId, [], null, remotes[0] ?? template, true);
    for (const extra of remotes.slice(wantRemote)) this.deleteTask(extra.id);
    this.report.watchdogs.remote = { before: remotes.length, after: wantRemote };
  }

  private syncCheckoutTask(
    task: STask,
    d: DesiredProfile,
    groupId: number,
    fromGroup: string | undefined,
  ): TaskChange | null {
    const products = this.syncProducts(task.id, d.skus, this.options.tasks.checkoutQty);
    const other: string[] = [];
    if (task.groupId !== groupId) {
      this.db.run("UPDATE task SET task_group_id = ? WHERE id = ?", [groupId, task.id]);
      other.push(fromGroup ? `moved in from "${fromGroup}"` : "moved in");
    }
    if (products.qtyChanged) other.push(`qty ${this.options.tasks.checkoutQty}`);

    const imapId = d.mailbox ? this.imapIdByMailbox.get(lower(d.mailbox.username)) : undefined;
    if (imapId !== undefined && imapId !== task.imapId) {
      this.db.run("UPDATE task SET imap_account_id = ? WHERE id = ?", [imapId, task.id]);
      other.push("mailbox");
    }
    if (this.moveBrowser(task.browserId, this.options.tasks.checkoutProxyGroupId))
      other.push("proxy group");

    if (products.added.length === 0 && products.removed.length === 0 && other.length === 0)
      return null;
    this.db.run("UPDATE task SET updated_at = ? WHERE id = ?", [this.now, task.id]);
    return { profile: d.name, added: products.added, removed: products.removed, other };
  }

  private createCheckoutTask(groupId: number, profileId: number, d: DesiredProfile): number {
    const template = this.checkoutTemplate();
    const browserId = this.createBrowser(
      this.options.tasks.checkoutProxyGroupId ?? template.proxyGroupId,
      this.fingerprintFor("checkout"),
    );
    const imapId = d.mailbox ? (this.imapIdByMailbox.get(lower(d.mailbox.username)) ?? null) : null;
    const id = this.insertTask({
      groupId,
      type: template.type,
      flowKey: template.flowKey,
      targetKind: template.targetKind,
      profileId,
      browserId,
      imapId,
      genericData: "{}",
      options: template.options,
      state: "{}",
    });
    this.syncProducts(id, d.skus, this.options.tasks.checkoutQty);
    return id;
  }

  /** The shape a new checkout task copies: the most common one in the Target task group. */
  private checkoutTemplate() {
    const groupId = this.targetTaskGroupId;
    const all = this.s.tasks.filter((t) => this.isTargetCheckout(t));
    const pool = all.filter((t) => t.groupId === groupId);
    const tasks = pool.length > 0 ? pool : all;
    const options = mostCommon(
      tasks.map((t) => t.options).filter((o): o is string => Boolean(o?.trim().startsWith("{"))),
    );
    const first = tasks[0];
    return {
      type: first?.type ?? "Checkout",
      flowKey: first?.flowKey ?? "checkout",
      targetKind: first ? first.targetKind : TARGET_METHOD,
      options: options ?? pyJson(DEFAULT_CHECKOUT_OPTIONS),
      proxyGroupId: mostCommon(
        tasks
          .map((t) => this.liveGroup(this.s.browsers.get(t.browserId)?.proxyGroupId ?? null))
          .filter((id) => id !== null),
      ),
    };
  }

  private syncWatchdog(task: STask, skus: string[], interval: number) {
    const options = jsonObject(task.options);
    let touched = false;
    if (options.check_interval !== interval) {
      options.check_interval = interval;
      this.db.run("UPDATE task SET options = ? WHERE id = ?", [pyJson(options), task.id]);
      touched = true;
    }
    const products = this.syncProducts(task.id, skus, null);
    if (products.added.length || products.removed.length || products.qtyChanged) touched = true;
    if (this.moveBrowser(task.browserId, this.options.tasks.watchdogProxyGroupId)) touched = true;
    if (touched) this.db.run("UPDATE task SET updated_at = ? WHERE id = ?", [this.now, task.id]);
  }

  private createWatchdog(
    groupId: number,
    skus: string[],
    interval: number | null,
    template: STask | null,
    remote: boolean,
  ) {
    const generic = template ? jsonObject(template.genericData) : { ...DEFAULT_WATCHDOG_DATA };
    const state = template
      ? jsonObject(template.state)
      : Object.fromEntries(DEFAULT_WATCHDOG_STATE_KEYS.map((key) => [key, null]));
    // A new phone for every watchdog -- see device.ts.
    const device = freshDeviceData(generic.ios_device_data, this.options.random, this.options.now);
    generic.ios_device_data = device;
    if (!template || "ios_device_data" in state) state.ios_device_data = device;

    const options = remote ? {} : { ...jsonObject(template?.options), check_interval: interval };
    const browserId = remote
      ? this.createBrowser(null, this.fingerprintFor("watchdog"))
      : this.createBrowser(
          this.options.tasks.watchdogProxyGroupId ??
            (template ? (this.s.browsers.get(template.browserId)?.proxyGroupId ?? null) : null),
          this.fingerprintFor("watchdog"),
        );
    const id = this.insertTask({
      groupId,
      type: template?.type ?? "Watchdog",
      flowKey: template?.flowKey ?? "watchdog",
      targetKind: remote ? "remote" : TARGET_METHOD,
      profileId: null,
      browserId,
      imapId: null,
      genericData: pyJson(generic),
      options: pyJson(options),
      state: pyJson(state),
    });
    if (skus.length > 0) this.syncProducts(id, skus, null);
  }

  // -------------------------------------------------------------------------
  // "Target - Profile Updates": a Wipe Account task per profile with pending changes
  // -------------------------------------------------------------------------

  /**
   * Rebuilt from scratch on every export: the group only ever holds this drop's wipes.
   *
   * Every OLD wipe of this instance's profiles goes first, wherever it is -- last export's in
   * this group, and the ones made by hand before there was one ("Target Wipe Account" on the
   * main instance). A change confirmed since needs no wipe; one still pending gets a new one.
   *
   * Each new one is a COPY of a Wipe Account task the backup has -- on the main instance,
   * type "Wipe Account", flow "wipe_account", target_kind NULL, options and generic data
   * "{}", no mailbox, no products -- so a Shikari update that changes the shape is picked up
   * from the backup itself. Whatever the template leaves unset (its mailbox, its pinned
   * proxy) the copy leaves unset too, and a browser group that no longer exists is swapped
   * for the checkout one. With nothing to copy -- every export clears the old ones, so a
   * backup whose last export had nothing pending has none -- the built-in shape is the same.
   */
  private syncWipes() {
    const report = this.report.wipes;
    const owned = findGroup(this.s.taskGroups, UPDATES_GROUP);
    const target = this.s.targetWebsiteId;
    const wipes = this.s.tasks.filter((t) => isWipe(t) && t.websiteId === target);
    const outside = wipes.filter((t) => !owned || t.groupId !== owned.id);
    const template =
      outside.find((t) =>
        groupKey(this.s.taskGroups.find((g) => g.id === t.groupId)?.name).includes("wipe"),
      ) ??
      outside[0] ??
      wipes[0] ??
      null;

    const ours = new Set(this.profileIdByKey.values());
    for (const task of this.s.tasks) {
      const old =
        (owned !== undefined && task.groupId === owned.id) ||
        (isWipe(task) &&
          task.websiteId === target &&
          task.profileId !== null &&
          ours.has(task.profileId));
      if (old && this.deleteTask(task.id)) report.removed += 1;
    }

    const pending = this.people.filter((d) => d.pending);
    // Nothing pending and no group yet: the backup isn't given an empty group it never had.
    if (pending.length === 0 && !owned) return;
    const groupId = owned?.id ?? this.ensureGroup("task_group", UPDATES_GROUP, UPDATES_COLOR);
    if (pending.length === 0) return;
    report.template = template ? "copied" : "built-in";

    const shape = template ?? DEFAULT_WIPE;
    const templateBrowser = template ? this.s.browsers.get(template.browserId) : undefined;
    const browserGroup =
      this.liveGroup(templateBrowser?.proxyGroupId ?? null) ??
      this.liveGroup(this.options.tasks.checkoutProxyGroupId) ??
      this.checkoutTemplate().proxyGroupId;
    const templateProducts = template
      ? this.s.products.filter((p) => p.taskId === template.id)
      : [];
    const generic = jsonObject(shape.genericData);
    for (const d of pending) {
      const profileId = this.profileIdByKey.get(d.key);
      if (profileId === undefined) {
        this.report.warnings.push(
          `${d.name} has pending changes but isn't a profile in this backup, so it got no wipe.`,
        );
        continue;
      }
      const data = { ...generic };
      if ("ios_device_data" in data) {
        data.ios_device_data = freshDeviceData(
          data.ios_device_data,
          this.options.random,
          this.options.now,
        );
      }
      const id = this.insertTask({
        groupId,
        type: shape.type,
        flowKey: shape.flowKey,
        targetKind: shape.targetKind,
        profileId,
        browserId: this.createBrowser(browserGroup, this.fingerprintFor("wipe"), {
          pin: templateBrowser?.proxyId != null,
        }),
        // Only where the template reads a mailbox, and then the profile's own -- never the
        // template's, which belongs to whoever the copied task was for.
        imapId:
          !template || template.imapId === null || !d.mailbox
            ? null
            : (this.imapIdByMailbox.get(lower(d.mailbox.username)) ?? null),
        genericData: "ios_device_data" in data ? pyJson(data) : shape.genericData,
        options: shape.options,
        state: "{}",
      });
      if (templateProducts.length > 0) {
        this.syncProducts(
          id,
          templateProducts.map((p) => p.data),
          templateProducts[0].qty,
        );
      }
      report.added.push({ name: d.name, owner: d.ownerName, fields: d.pending?.fields });
    }
  }

  // -------------------------------------------------------------------------
  // Tasks, browsers, products
  // -------------------------------------------------------------------------

  private insertTask(t: {
    groupId: number;
    type: string | null;
    flowKey: string | null;
    targetKind: string | null;
    profileId: number | null;
    browserId: number;
    imapId: number | null;
    genericData: string | null;
    options: string | null;
    state: string;
  }): number {
    return this.db.insert(
      `INSERT INTO task (created_at, updated_at, task_group_id, running, preloaded, start_time, type,
                         website_id, profile_id, generic_data, captcha_service_id, browser_id,
                         sms_service_id, imap_account_id, flow_key, options, state, target_kind)
       VALUES (?, NULL, ?, 0, 0, NULL, ?, ?, ?, ?, NULL, ?, NULL, ?, ?, ?, ?, ?)`,
      [
        this.now,
        t.groupId,
        t.type,
        this.s.targetWebsiteId,
        t.profileId,
        t.genericData,
        t.browserId,
        t.imapId,
        t.flowKey,
        t.options,
        t.state,
        t.targetKind,
      ],
    );
  }

  /** Makes a task's product rows exactly `skus`, at `qty`, keeping rows that already match. */
  private syncProducts(taskId: number, skus: string[], qty: number | null) {
    const rows = this.db.all<{ id: number; target_data: string; qty: number | null }>(
      "SELECT id, target_data, qty FROM target_product WHERE task_id = ? ORDER BY id",
      [taskId],
    );
    const want = new Set(skus);
    const have = new Set<string>();
    const removed: string[] = [];
    let qtyChanged = false;
    for (const row of rows) {
      const sku = String(row.target_data);
      if (!want.has(sku) || have.has(sku)) {
        this.db.run("DELETE FROM target_product WHERE id = ?", [row.id]);
        if (!want.has(sku)) removed.push(sku);
        continue;
      }
      have.add(sku);
      if ((row.qty ?? null) !== qty) {
        this.db.run("UPDATE target_product SET qty = ?, updated_at = ? WHERE id = ?", [
          qty,
          this.now,
          row.id,
        ]);
        qtyChanged = true;
      }
    }
    const added = skus.filter((sku) => !have.has(sku));
    for (const sku of added) {
      this.db.run(
        `INSERT INTO target_product (created_at, updated_at, task_id, target_method, target_data,
                                     min_price, max_price, qty, miscellaneous_data)
         VALUES (?, NULL, ?, ?, ?, NULL, NULL, ?, '{}')`,
        [this.now, taskId, TARGET_METHOD, sku, qty],
      );
      have.add(sku);
    }
    return { added, removed, qtyChanged };
  }

  /**
   * Deletes a task, its products, and its browser and cookie jar once nothing else uses
   * them. Answers whether there was a task to delete -- one may already have gone with its
   * profile.
   */
  private deleteTask(taskId: number): boolean {
    const task = this.db.get<{ browser_id: number }>("SELECT browser_id FROM task WHERE id = ?", [
      taskId,
    ]);
    if (!task) return false;
    this.db.run("DELETE FROM target_product WHERE task_id = ?", [taskId]);
    this.db.run("DELETE FROM task WHERE id = ?", [taskId]);

    const browserId = task.browser_id;
    const inUse = this.db.get(
      "SELECT 1 FROM task WHERE browser_id = ? UNION ALL SELECT 1 FROM harvester WHERE browser_id = ? LIMIT 1",
      [browserId, browserId],
    );
    if (inUse) return true;
    const browser = this.db.get<{
      proxy_group_id: number | null;
      proxy_id: number | null;
      cookie_jar_id: number | null;
    }>("SELECT proxy_group_id, proxy_id, cookie_jar_id FROM browser WHERE id = ?", [browserId]);
    if (!browser) return true;
    this.db.run("DELETE FROM browser WHERE id = ?", [browserId]);
    this.sticky.release(browser.proxy_id);
    if (browser.cookie_jar_id !== null) this.dropJarIfUnused(Number(browser.cookie_jar_id));
    return true;
  }

  /**
   * Deletes a cookie jar once no browser or login holds it. Only ever called on the jar of
   * something the export just deleted: a jar nothing holds that the export didn't free is
   * left alone, in case it is a cookie Shikari banked for later.
   */
  private dropJarIfUnused(jar: number) {
    const inUse = this.db.get(
      `SELECT 1 FROM browser WHERE cookie_jar_id = ?
       UNION ALL SELECT 1 FROM account WHERE cookie_jar_id = ? OR mobile_cookie_jar_id = ? LIMIT 1`,
      [jar, jar, jar],
    );
    if (!inUse) this.db.run("DELETE FROM cookie_jar WHERE id = ?", [jar]);
  }

  /** A proxy group id if that group exists, otherwise null -- never a dangling reference. */
  private liveGroup(id: number | null | undefined): number | null {
    return id !== null && id !== undefined && this.liveProxyGroups.has(id) ? id : null;
  }

  /**
   * A fresh browser: its own empty cookie jar and, unless told otherwise, the least-used
   * proxy in its group. A group that no longer exists becomes no group at all.
   */
  private createBrowser(
    proxyGroupId: number | null,
    fingerprint: string,
    { pin = true }: { pin?: boolean } = {},
  ): number {
    const group = this.liveGroup(proxyGroupId);
    const jar = this.db.insert(
      "INSERT INTO cookie_jar (created_at, updated_at, cookies) VALUES (?, NULL, '[]')",
      [this.now],
    );
    const proxyId = group !== null && pin ? this.sticky.take(group) : null;
    return this.db.insert(
      `INSERT INTO browser (created_at, updated_at, proxy_group_id, proxy_id, fingerprint_name, cookie_jar_id)
       VALUES (?, NULL, ?, ?, ?, ?)`,
      [this.now, group, proxyId, fingerprint, jar],
    );
  }

  /**
   * Points a browser at another proxy group. Null, or a group that doesn't exist, means
   * leave it. A browser pinned to a proxy is re-pinned in the new group; one that wasn't
   * stays unpinned, and Shikari keeps picking for it from the group as before.
   */
  private moveBrowser(browserId: number, proxyGroupId: number | null): boolean {
    const group = this.liveGroup(proxyGroupId);
    if (group === null) return false;
    const browser = this.db.get<{ proxy_group_id: number | null; proxy_id: number | null }>(
      "SELECT proxy_group_id, proxy_id FROM browser WHERE id = ?",
      [browserId],
    );
    if (!browser || browser.proxy_group_id === group) return false;
    this.sticky.release(browser.proxy_id);
    this.db.run(
      "UPDATE browser SET proxy_group_id = ?, proxy_id = ?, updated_at = ? WHERE id = ?",
      [group, browser.proxy_id === null ? null : this.sticky.take(group), this.now, browserId],
    );
    return true;
  }

  private fingerprints = new Map<string, Map<string, number>>();

  /**
   * A fingerprint for a new browser: the least-used one among browsers doing the same job.
   * Shikari ships these as files on the operator's machine, so only names a backup already
   * uses can be trusted to exist -- an invented one would point at nothing.
   */
  private fingerprintFor(kind: "checkout" | "watchdog" | "wipe"): string {
    let counts = this.fingerprints.get(kind);
    if (!counts) {
      const doing =
        kind === "checkout"
          ? (t: STask) => this.isTargetCheckout(t)
          : kind === "watchdog"
            ? isWatchdog
            : isWipe;
      let names = this.s.tasks
        .filter(doing)
        .map((t) => this.s.browsers.get(t.browserId)?.fingerprint)
        .filter(Boolean) as string[];
      if (names.length === 0)
        names = [...this.s.browsers.values()].map((b) => b.fingerprint).filter(Boolean);
      if (names.length === 0) {
        throw new BuildError(
          "This backup has no browsers to copy a fingerprint from, so no task can be added to it.",
        );
      }
      counts = new Map();
      for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
      this.fingerprints.set(kind, counts);
    }
    const [name] = [...counts.entries()].sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))[0];
    counts.set(name, (counts.get(name) ?? 0) + 1);
    return name;
  }

  /**
   * A profile or task group by name, matched the way targetGroups matches ("Target -
   * Paused" is "Target Paused"), or a new one at the end of the list.
   */
  private ensureGroup(table: "profile_group" | "task_group", name: string, color?: string): number {
    const existing = this.db
      .all<{ id: number; name: string }>(`SELECT id, name FROM ${table} ORDER BY id`)
      .find((g) => groupKey(g.name) === groupKey(name));
    if (existing) return Number(existing.id);
    return table === "task_group"
      ? this.db.insert(
          `INSERT INTO task_group (created_at, updated_at, name, color, avatar, order_index)
           VALUES (?, NULL, ?, ?, NULL, (SELECT COALESCE(MAX(order_index), -1) + 1 FROM task_group))`,
          [this.now, name, color ?? TARGET_COLOR],
        )
      : this.db.insert(
          `INSERT INTO profile_group (created_at, updated_at, name, order_index)
           VALUES (?, NULL, ?, (SELECT COALESCE(MAX(order_index), -1) + 1 FROM profile_group))`,
          [this.now, name],
        );
  }

  /**
   * Addresses and cards no profile points at, left behind by profiles deleted long ago (7
   * addresses on the main instance). Only a profile can use either, so nothing can miss them.
   */
  private pruneStrays() {
    this.report.strays += this.db.run(
      `DELETE FROM address WHERE NOT EXISTS (
         SELECT 1 FROM profile p WHERE p.shipping_address_id = address.id OR p.billing_address_id = address.id)`,
    );
    this.report.strays += this.db.run(
      `DELETE FROM credit_card WHERE NOT EXISTS (
         SELECT 1 FROM profile p WHERE p.credit_card_id = credit_card.id)`,
    );
  }

  /**
   * Takes out the groups the export emptied -- "NO IMAP" once its tasks are moved into
   * "Target", "Target Wipe Account" once its old wipes are gone, the paused group once what
   * was parked there is -- and the groups the operator chose to clear, once they are empty.
   * Never "Target" or "Target - Profile Updates", the export's own, and never a group that
   * was already empty before it: that one somebody made on purpose.
   */
  private dropEmptiedGroups() {
    const report = this.report.groupsRemoved;
    const ownTasks = new Set([
      this.targetTaskGroupId ?? this.groups.tasks?.id,
      findGroup(this.s.taskGroups, UPDATES_GROUP)?.id,
    ]);
    const hadTasks = new Set(this.s.tasks.map((t) => t.groupId));
    for (const group of this.s.taskGroups) {
      if (!hadTasks.has(group.id) || ownTasks.has(group.id)) continue;
      if (this.db.get("SELECT 1 FROM task WHERE task_group_id = ? LIMIT 1", [group.id])) continue;
      this.db.run("DELETE FROM task_group WHERE id = ?", [group.id]);
      report.task.push(group.name);
    }

    if (!this.options.sections.profiles) return;
    const hadProfiles = new Set(this.s.profiles.map((p) => p.groupId));
    for (const group of this.s.profileGroups) {
      const clearing =
        this.removing.has(group.id) ||
        (group.id === this.groups.paused?.id && hadProfiles.has(group.id));
      if (!clearing || group.id === this.targetProfileGroupId) continue;
      if (this.db.get("SELECT 1 FROM profile WHERE profile_group_id = ? LIMIT 1", [group.id]))
        continue;
      this.db.run("DELETE FROM profile_group WHERE id = ?", [group.id]);
      report.profile.push(group.name);
    }
  }

  /**
   * The last line of defence: no reference the export left may point at nothing. Compared
   * against what the backup already had, so a dangling row Shikari itself left behind is
   * not blamed on -- or allowed to block -- the export.
   */
  private checkIntegrity() {
    const after = foreignKeyProblems(this.db);
    const introduced = [...after].filter((problem) => !this.fkBefore.has(problem));
    if (introduced.length > 0) {
      throw new BuildError(
        `The rebuilt backup would have broken references (${introduced.slice(0, 3).join(", ")}). Nothing was exported.`,
      );
    }
    const check = this.db.get<{ quick_check: string }>("PRAGMA quick_check");
    if (check?.quick_check !== "ok") {
      throw new BuildError(
        "SQLite's own check failed on the rebuilt backup. Nothing was exported.",
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function push<K, V>(map: Map<K, V[]>, key: K, value: V) {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

function ref(refs: Map<number, Set<number>>, id: number, profileId: number) {
  const set = refs.get(id) ?? new Set<number>();
  set.add(profileId);
  refs.set(id, set);
}

function* batches<T>(list: T[]): Generator<T[]> {
  for (let i = 0; i < list.length; i += BATCH) yield list.slice(i, i + BATCH);
}

function addressValues(a: ShikariAddress): SqlParam[] {
  return [a.firstName, a.lastName, a.street, a.street2, a.city, a.state, a.zip, a.country, a.phone];
}

/** Which parts of an address differ, named for the review. Case and spacing don't count. */
export function addressChanges(current: SAddress, next: ShikariAddress): string[] {
  const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
  const changes: string[] = [];
  if (!same(current.firstName, next.firstName) || !same(current.lastName, next.lastName))
    changes.push("name");
  if (!same(current.street, next.street)) changes.push("street");
  if (!same(current.street2, next.street2)) changes.push("apt/unit");
  if (!same(current.city, next.city)) changes.push("city");
  if (!same(current.state, next.state)) changes.push("state");
  if (!same(current.zip, next.zip)) changes.push("ZIP");
  if (!same(current.country, next.country)) changes.push("country");
  if (current.phone.replace(/\D/g, "") !== next.phone) changes.push("phone");
  return changes;
}

/** Every broken reference in the file, as comparable strings. */
function foreignKeyProblems(db: ShikariDb): Set<string> {
  return new Set(
    db
      .all<{ table: string; rowid: number; parent: string; fkid: number }>(
        "PRAGMA foreign_key_check",
      )
      .map((row) => `${row.table}#${row.rowid}->${row.parent}`),
  );
}

/**
 * Which proxy a new browser is pinned to: the least-used one in its group, so a list is
 * spread across browsers rather than piled onto its first entry. Counts are kept as
 * browsers come and go during the build, and dropped when a group's list is swapped.
 */
class StickyProxies {
  private groups = new Map<number, { ids: number[]; uses: Map<number, number> }>();

  constructor(private readonly db: ShikariDb) {}

  private load(groupId: number) {
    let group = this.groups.get(groupId);
    if (group) return group;
    const ids = this.db
      .all<{ id: number }>("SELECT id FROM proxy WHERE proxy_group_id = ? ORDER BY id", [groupId])
      .map((r) => Number(r.id));
    const uses = new Map(ids.map((id) => [id, 0]));
    for (const row of this.db.all<{ proxy_id: number; n: number }>(
      "SELECT proxy_id, COUNT(*) AS n FROM browser WHERE proxy_group_id = ? AND proxy_id IS NOT NULL GROUP BY proxy_id",
      [groupId],
    )) {
      if (uses.has(Number(row.proxy_id))) uses.set(Number(row.proxy_id), Number(row.n));
    }
    group = { ids, uses };
    this.groups.set(groupId, group);
    return group;
  }

  take(groupId: number): number | null {
    const group = this.load(groupId);
    let best: number | null = null;
    let fewest = Infinity;
    for (const id of group.ids) {
      const n = group.uses.get(id) ?? 0;
      if (n < fewest) {
        fewest = n;
        best = id;
        if (n === 0) break;
      }
    }
    if (best !== null) group.uses.set(best, fewest + 1);
    return best;
  }

  release(proxyId: number | null) {
    if (proxyId === null) return;
    for (const group of this.groups.values()) {
      const n = group.uses.get(proxyId);
      if (n !== undefined) group.uses.set(proxyId, Math.max(0, n - 1));
    }
  }

  reset(groupId: number) {
    this.groups.delete(groupId);
  }
}

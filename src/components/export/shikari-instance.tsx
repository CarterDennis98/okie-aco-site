"use client";

import { useId, useState } from "react";
import type { ShikariMember } from "@/db/queries/shikari";
import { scopesOverlap, type GroupChoice, type ShikariInstanceConfig } from "@/lib/shikari/config";
import type { ParsedProxyList } from "@/lib/shikari/proxies";
import {
  TARGET_GROUP,
  defaultGroupChoice,
  groupChoice,
  groupKey,
  type BackupSummary,
  type SummaryProfileGroup,
} from "@/lib/shikari/snapshot";
import type { Sections, TaskSettings } from "@/lib/shikari/types";
import type { BotScope } from "@/lib/vault/bot-split";

/**
 * One Shikari instance's setup: its backup, whose profiles it runs, what the export may
 * rewrite in it, and -- pre-filled from the backup itself -- how its tasks are set up.
 */

export type LoadedBackup = {
  name: string;
  size: number;
  /** The file as uploaded. Never modified: every build starts again from these bytes. */
  bytes: Uint8Array;
  summary: BackupSummary;
  newerVersion: boolean;
};

export type ProxyUpload = ParsedProxyList & { fileName: string };

export type InstanceDraft = {
  key: string;
  config: ShikariInstanceConfig;
  backup: LoadedBackup | null;
  /** As the backup has them, until the operator changes one. */
  settings: TaskSettings | null;
  /** Replacement lists by proxy group id. */
  proxyLists: Record<number, ProxyUpload>;
  loading: boolean;
  error: string | null;
};

const SECTIONS: { key: keyof Sections; label: string; hint: string }[] = [
  {
    key: "profiles",
    label: "Profiles",
    hint: "Cards, addresses and names from the vault, edited in place. Every other Target profile comes out.",
  },
  {
    key: "accounts",
    label: "Logins",
    hint: "Target passwords, sessions kept. Logins no profile here uses come out.",
  },
  {
    key: "imap",
    label: "IMAP",
    hint: "The mailboxes behind these profiles' codes. Ones nothing uses come out.",
  },
  { key: "proxies", label: "Proxies", hint: "Only the groups you give a new list below." },
  {
    key: "tasks",
    label: "Target tasks",
    hint: "Watchdogs and checkout tasks, from Target Products.",
  },
  {
    key: "wipes",
    label: "Profile updates",
    hint: "A Wipe Account task for each profile with a pending change; old ones are cleared.",
  },
];

const field =
  "rounded-lg border border-[var(--color-edge)] bg-[var(--color-ink)] px-2.5 py-1.5 text-base sm:text-sm text-[var(--color-fg)] focus:border-[var(--color-brand)] focus:outline-none";
const chip = (on: boolean) =>
  "inline-flex min-h-11 items-center rounded-lg border px-3 text-sm font-medium transition-colors sm:min-h-0 sm:py-1.5 " +
  (on
    ? "border-[var(--color-brand)] bg-[var(--color-brand)]/10 text-white"
    : "border-[var(--color-edge)] text-[var(--color-muted)] hover:text-[var(--color-fg)]");

function megabytes(bytes: number) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function InstanceCard({
  position,
  draft,
  others,
  members,
  cap,
  onChange,
  onBackup,
  onProxies,
  onRemove,
}: {
  position: number;
  draft: InstanceDraft;
  others: { position: number; config: ShikariInstanceConfig }[];
  members: ShikariMember[];
  cap: number | null;
  onChange: (patch: Partial<InstanceDraft>) => void;
  onBackup: (file: File) => void;
  onProxies: (groupId: number, file: File) => void;
  onRemove?: () => void;
}) {
  const { config, backup, settings } = draft;
  const setConfig = (patch: Partial<ShikariInstanceConfig>) =>
    onChange({ config: { ...config, ...patch } });
  // Not the draft's key: that comes from a counter, which the server and the browser's first
  // render don't agree on.
  const titleId = useId();

  return (
    <section
      aria-labelledby={titleId}
      className="rounded-2xl border border-[var(--color-edge)] bg-[var(--color-surface)] p-5 sm:p-6"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 id={titleId} className="text-lg font-bold text-white">
          Instance {position}
        </h3>
        {onRemove && (
          <button
            type="button"
            onClick={onRemove}
            className="inline-flex min-h-11 items-center rounded-lg px-2 text-xs font-medium text-[var(--color-muted)] hover:text-[var(--color-fg)] sm:min-h-0"
          >
            Remove instance
          </button>
        )}
      </div>

      {/* --- the backup --- */}
      <div className="mt-4">
        <label
          className={
            "flex cursor-pointer flex-wrap items-center gap-3 rounded-xl border border-dashed px-4 py-3 text-sm transition-colors " +
            (backup
              ? "border-[var(--color-edge)] text-[var(--color-muted)]"
              : "border-[var(--color-brand)]/50 text-[var(--color-fg)] hover:bg-[var(--color-brand)]/5")
          }
        >
          <input
            type="file"
            accept=".bak,application/octet-stream"
            className="sr-only"
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              if (file) onBackup(file);
              event.currentTarget.value = "";
            }}
          />
          <span className="font-semibold text-white">
            {draft.loading
              ? "Reading…"
              : backup
                ? "Replace backup"
                : "Choose this instance's backup (.bak)"}
          </span>
          {backup && (
            <span>
              {backup.name} · {megabytes(backup.size)} · Shikari{" "}
              {backup.summary.version ?? "unknown version"}
            </span>
          )}
        </label>
        {draft.error && (
          <p role="alert" className="mt-2 text-sm text-[var(--color-warn)]">
            {draft.error}
          </p>
        )}
        {backup?.newerVersion && (
          <p className="mt-2 text-xs text-[var(--color-warn)]">
            This backup is from a newer Shikari than the export was built against. Its tables check
            out, but read the review closely.
          </p>
        )}
        {backup && <BackupDetails summary={backup.summary} />}
      </div>

      {/* --- whose profiles --- */}
      <div className="mt-6">
        <h4 className="text-sm font-bold text-white">Profiles to run</h4>
        <div role="radiogroup" aria-label="Which profiles" className="mt-2 flex flex-wrap gap-2">
          {(
            [
              { key: "main", label: cap ? `Main (first ${cap})` : "Main" },
              { key: "backup", label: cap ? `Backup (past ${cap})` : "Backup" },
              { key: "all", label: "All" },
            ] as { key: BotScope; label: string }[]
          ).map((option) => (
            <button
              key={option.key}
              type="button"
              role="radio"
              aria-checked={config.bot === option.key}
              onClick={() => setConfig({ bot: option.key })}
              className={chip(config.bot === option.key)}
            >
              {option.label}
            </button>
          ))}
        </div>
        <MemberList
          members={members}
          config={config}
          others={others}
          cap={cap}
          onChange={(memberIds) => setConfig({ memberIds })}
        />
      </div>

      {/* --- what to rewrite --- */}
      <div className="mt-6">
        <h4 className="text-sm font-bold text-white">Update in this backup</h4>
        <ul className="mt-2 grid gap-2 sm:grid-cols-2">
          {SECTIONS.map((section) => (
            <li key={section.key}>
              <label className="flex cursor-pointer items-start gap-2.5 text-sm">
                <input
                  type="checkbox"
                  checked={config.sections[section.key]}
                  onChange={(event) =>
                    setConfig({
                      sections: { ...config.sections, [section.key]: event.currentTarget.checked },
                    })
                  }
                  className="mt-0.5 size-4 accent-[var(--color-brand)]"
                />
                <span>
                  <span className="font-medium text-white">{section.label}</span>
                  <span className="block text-xs text-[var(--color-muted)]">{section.hint}</span>
                </span>
              </label>
            </li>
          ))}
        </ul>

        {backup && config.sections.profiles && (
          <GroupChoices
            groups={backup.summary.profileGroups}
            saved={config.groups}
            onChange={(groups) => setConfig({ groups })}
          />
        )}
      </div>

      {/* --- proxies --- */}
      {backup && config.sections.proxies && (
        <div className="mt-6">
          <h4 className="text-sm font-bold text-white">Proxy lists</h4>
          <p className="mt-1 text-xs text-[var(--color-muted)]">
            A new list replaces a group&rsquo;s proxies in place, line for line; browsers pinned to
            a proxy that goes away are moved to one that&rsquo;s left.
          </p>
          <ul className="mt-2 divide-y divide-[var(--color-edge)] rounded-xl border border-[var(--color-edge)]">
            {backup.summary.proxyGroups.map((group) => {
              const upload = draft.proxyLists[group.id];
              return (
                <li
                  key={group.id}
                  className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm"
                >
                  <span>
                    <span className="font-medium text-white">{group.name}</span>{" "}
                    <span className="text-[var(--color-muted)]">
                      · {group.count.toLocaleString("en-US")}
                    </span>
                    {upload && (
                      <span className="block text-xs text-[var(--color-fg)]">
                        → {upload.proxies.length.toLocaleString("en-US")} from {upload.fileName}
                        {upload.invalid.length > 0 &&
                          ` · ${upload.invalid.length} unreadable line${upload.invalid.length === 1 ? "" : "s"} skipped (line ${upload.invalid.slice(0, 5).join(", ")}${upload.invalid.length > 5 ? ", …" : ""})`}
                        {upload.duplicates > 0 &&
                          ` · ${upload.duplicates} repeat${upload.duplicates === 1 ? "" : "s"} dropped`}
                      </span>
                    )}
                  </span>
                  <span className="flex items-center gap-1">
                    <label className="inline-flex min-h-11 cursor-pointer items-center rounded-lg border border-[var(--color-edge)] px-2.5 text-xs font-medium text-[var(--color-fg)] hover:border-[var(--color-brand)]/50 sm:min-h-0 sm:py-1">
                      <input
                        type="file"
                        accept=".txt,text/plain"
                        className="sr-only"
                        onChange={(event) => {
                          const file = event.currentTarget.files?.[0];
                          if (file) onProxies(group.id, file);
                          event.currentTarget.value = "";
                        }}
                      />
                      {upload ? "Another .txt" : "Replace from .txt"}
                    </label>
                    {upload && (
                      <button
                        type="button"
                        onClick={() => {
                          const next = { ...draft.proxyLists };
                          delete next[group.id];
                          onChange({ proxyLists: next });
                        }}
                        className="inline-flex min-h-11 items-center rounded-lg px-2 text-xs text-[var(--color-muted)] hover:text-[var(--color-fg)] sm:min-h-0"
                      >
                        Keep current
                      </button>
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
          {Object.values(draft.proxyLists).some((list) => list.proxies.length === 0) && (
            <p className="mt-2 text-xs text-[var(--color-warn)]">
              A list with no readable proxies would empty its group. Check the file.
            </p>
          )}
        </div>
      )}

      {/* --- task settings --- */}
      {backup && settings && config.sections.tasks && (
        <TaskSettingsForm
          settings={settings}
          groups={backup.summary.proxyGroups}
          onChange={(next) => onChange({ settings: next })}
        />
      )}
    </section>
  );
}

function BackupDetails({ summary }: { summary: BackupSummary }) {
  const c = summary.counts;
  const t = summary.target;
  return (
    <div className="mt-3 text-sm">
      <p className="text-[var(--color-fg)]">
        {c.profiles} profiles · {c.accounts} logins ({c.signedIn} signed in) · {c.imap} mailboxes ·{" "}
        {c.proxies.toLocaleString("en-US")} proxies · {c.tasks} tasks
      </p>
      {/* Said up front because it bounds everything the export does: these groups and
          nothing else. Walmart's profiles and other runners' share names and emails with
          ours, and stay exactly as they are. */}
      <p className="mt-1 text-xs text-[var(--color-muted)]">
        Works in profile group{" "}
        <span className="text-[var(--color-fg)]">&ldquo;{t.profileGroup ?? "Target"}&rdquo;</span>
        {t.profileGroup ? "" : " (new)"}
        {t.pausedGroup && (
          <>
            {" "}
            and <span className="text-[var(--color-fg)]">&ldquo;{t.pausedGroup}&rdquo;</span>
          </>
        )}{" "}
        ({t.candidates} profiles) and task group{" "}
        <span className="text-[var(--color-fg)]">&ldquo;{t.taskGroup ?? "Target"}&rdquo;</span>
        {!t.taskGroup
          ? " (new)"
          : groupKey(t.taskGroup) !== groupKey(TARGET_GROUP)
            ? `, renamed “${TARGET_GROUP}”`
            : ""}
        . Other Target groups as chosen under Clean-up; groups that aren&rsquo;t Target are never
        touched.
      </p>
      <div className="mt-2 grid gap-2 lg:grid-cols-3">
        <details className="rounded-lg border border-[var(--color-edge)] px-3 py-2">
          <summary className="cursor-pointer text-xs font-medium text-[var(--color-muted)] hover:text-[var(--color-fg)]">
            Users and their profiles ({summary.users.length})
          </summary>
          <ul className="mt-2 max-h-64 space-y-1.5 overflow-y-auto text-xs">
            {summary.users.map((user) => (
              <li key={user.name}>
                <span className="font-medium text-white">{user.name}</span>
                <span className="block text-[var(--color-muted)]">
                  {user.profiles
                    .map((p) => `${p.name}${p.group === "Target" ? "" : ` (${p.group})`}`)
                    .join(", ")}
                </span>
              </li>
            ))}
          </ul>
        </details>
        <details className="rounded-lg border border-[var(--color-edge)] px-3 py-2">
          <summary className="cursor-pointer text-xs font-medium text-[var(--color-muted)] hover:text-[var(--color-fg)]">
            Proxy lists ({summary.proxyGroups.length})
          </summary>
          <ul className="mt-2 space-y-1 text-xs">
            {summary.proxyGroups.map((g) => (
              <li key={g.id}>
                <span className="text-white">{g.name}</span>{" "}
                <span className="text-[var(--color-muted)]">{g.count.toLocaleString("en-US")}</span>
              </li>
            ))}
          </ul>
        </details>
        <details className="rounded-lg border border-[var(--color-edge)] px-3 py-2">
          <summary className="cursor-pointer text-xs font-medium text-[var(--color-muted)] hover:text-[var(--color-fg)]">
            Task groups ({summary.taskGroups.length})
          </summary>
          <ul className="mt-2 space-y-2 text-xs">
            {summary.taskGroups.map((g) => (
              <li key={g.id}>
                <span className="font-medium text-white">{g.name}</span>
                <span className="block text-[var(--color-muted)]">
                  {g.kinds.length === 0
                    ? "empty"
                    : g.kinds.map((k) => `${k.count} ${k.kind}`).join(", ")}
                  {g.checkoutSkus > 0 && ` · ${g.checkoutSkus} products across checkout tasks`}
                </span>
                {g.watchdogs.some((w) => !w.remote) && (
                  <span className="block text-[var(--color-muted)]">
                    Watchdogs:{" "}
                    {g.watchdogs
                      .filter((w) => !w.remote)
                      .map((w) => `${w.skus} products${w.interval ? ` @ ${w.interval}ms` : ""}`)
                      .join(", ")}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </details>
      </div>
    </div>
  );
}

/**
 * What the export does with each profile group: "Target" ends up holding exactly this
 * instance's active profiles, its paused group is emptied, every other Target group is kept
 * or cleared -- by default cleared when nothing runs its profiles -- and a group that isn't
 * Target is never touched.
 */
function GroupChoices({
  groups,
  saved,
  onChange,
}: {
  groups: SummaryProfileGroup[];
  saved: Record<string, GroupChoice>;
  onChange: (saved: Record<string, GroupChoice>) => void;
}) {
  const target = groups.find((g) => g.role === "target");
  const paused = groups.find((g) => g.role === "paused");
  const others = groups.filter((g) => g.role === "other");
  const outside = groups.filter((g) => g.role === "outside" && g.count > 0);

  const choose = (group: SummaryProfileGroup, choice: GroupChoice) => {
    const next = { ...saved };
    // Only a choice that differs from the default is remembered, so a group that starts
    // being run is kept next time unless it was cleared on purpose.
    if (choice === defaultGroupChoice(group)) delete next[groupKey(group.name)];
    else next[groupKey(group.name)] = choice;
    onChange(next);
  };

  return (
    <div className="mt-5">
      <h4 className="text-sm font-bold text-white">Clean-up</h4>
      <p className="mt-1 text-xs text-[var(--color-muted)]">
        &ldquo;{target?.name ?? TARGET_GROUP}&rdquo; ends up holding exactly this instance&rsquo;s
        active profiles
        {paused && paused.count > 0 && <>, and &ldquo;{paused.name}&rdquo; is emptied</>}.
        Everything else there comes out with its tasks, logins and mailboxes &mdash; the review
        names each one, and why, before anything downloads.
      </p>
      {others.length > 0 && (
        <ul className="mt-2 divide-y divide-[var(--color-edge)] rounded-xl border border-[var(--color-edge)]">
          {others.map((group) => {
            const choice = groupChoice(group, saved);
            return (
              <li
                key={group.id}
                className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm"
              >
                <span className="min-w-0">
                  <span className="font-medium text-white">{group.name}</span>{" "}
                  <span className="text-xs text-[var(--color-muted)]">
                    · {group.count} profile{group.count === 1 ? "" : "s"} ·{" "}
                    {group.tasks > 0
                      ? `${group.tasks} task${group.tasks === 1 ? " uses" : "s use"} them`
                      : "nothing runs them"}
                  </span>
                  {choice === "remove" && group.tasks > 0 && (
                    <span className="block text-[11px] text-[var(--color-warn)]">
                      Their Target tasks come out too.
                    </span>
                  )}
                </span>
                <span
                  role="radiogroup"
                  aria-label={`What to do with ${group.name}`}
                  className="flex gap-1.5"
                >
                  {(
                    [
                      ["keep", "Keep"],
                      ["remove", "Clear out"],
                    ] as const
                  ).map(([key, label]) => (
                    <button
                      key={key}
                      type="button"
                      role="radio"
                      aria-checked={choice === key}
                      onClick={() => choose(group, key)}
                      className={chip(choice === key)}
                    >
                      {label}
                    </button>
                  ))}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {outside.length > 0 && (
        <p className="mt-2 text-xs text-[var(--color-muted)]">
          Not Target, never touched: {outside.map((g) => `${g.name} (${g.count})`).join(", ")}.
        </p>
      )}
    </div>
  );
}

function MemberList({
  members,
  config,
  others,
  cap,
  onChange,
}: {
  members: ShikariMember[];
  config: ShikariInstanceConfig;
  others: { position: number; config: ShikariInstanceConfig }[];
  cap: number | null;
  onChange: (memberIds: string[]) => void;
}) {
  const [filter, setFilter] = useState("");
  const [showEmpty, setShowEmpty] = useState(false);
  const chosen = new Set(config.memberIds);
  const countFor = (m: ShikariMember) =>
    config.bot === "main" ? m.main : config.bot === "backup" ? m.backup : m.active;
  // A member with no profiles in this scope runs nothing here -- most members, on a backup,
  // which only gets what is past the main bot's five -- so they aren't listed unless asked
  // for. Their ticks are kept: switching back to "Main" finds them as they were.
  const inScope = members.filter((m) => countFor(m) > 0);
  const empty = members.length - inScope.length;
  const where = config.bot === "backup" && cap ? `past ${cap}` : "here";
  const none = `no profiles ${where}`;
  const terms = filter.trim().toLowerCase().split(/\s+/).filter(Boolean);
  // Shown on request, the ones not included come after the ones that are, not among them.
  const shown = [...inScope, ...(showEmpty ? members.filter((m) => countFor(m) === 0) : [])].filter(
    (m) => terms.every((t) => `${m.username} ${m.displayName}`.toLowerCase().includes(t)),
  );
  const picked = inScope.filter((m) => chosen.has(m.discordUserId));
  const profiles = picked.reduce((sum, m) => sum + countFor(m), 0);

  return (
    <div className="mt-3">
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="search"
          value={filter}
          onChange={(event) => setFilter(event.currentTarget.value)}
          placeholder="Filter members"
          aria-label="Filter members"
          className={`${field} w-56`}
        />
        <button
          type="button"
          onClick={() =>
            onChange([...new Set([...config.memberIds, ...shown.map((m) => m.discordUserId)])])
          }
          className="inline-flex min-h-11 items-center rounded-lg px-2 text-xs font-medium text-[var(--color-muted)] hover:text-[var(--color-fg)] sm:min-h-0"
        >
          Select {terms.length ? "shown" : "all"}
        </button>
        <button
          type="button"
          onClick={() => {
            const hide = new Set(shown.map((m) => m.discordUserId));
            onChange(config.memberIds.filter((id) => !hide.has(id)));
          }}
          className="inline-flex min-h-11 items-center rounded-lg px-2 text-xs font-medium text-[var(--color-muted)] hover:text-[var(--color-fg)] sm:min-h-0"
        >
          Clear {terms.length ? "shown" : "all"}
        </button>
        <span className="text-xs text-[var(--color-muted)]">
          {picked.length} of {inScope.length} members · {profiles} profile
          {profiles === 1 ? "" : "s"}
        </span>
      </div>
      <ul className="mt-2 grid max-h-72 gap-x-4 overflow-y-auto rounded-xl border border-[var(--color-edge)] px-3 py-2 sm:grid-cols-2 lg:grid-cols-3">
        {shown.map((member) => {
          const n = countFor(member);
          // Another instance running the same profiles of this member: the review refuses that,
          // so it is flagged here first.
          const clash =
            n > 0 &&
            others.find(
              (o) =>
                o.config.memberIds.includes(member.discordUserId) &&
                scopesOverlap(o.config.bot, config.bot),
            );
          return (
            <li key={member.discordUserId} className={n === 0 ? "opacity-60" : undefined}>
              <label className="flex min-h-11 cursor-pointer items-center gap-2.5 text-sm sm:min-h-0 sm:py-1">
                <input
                  type="checkbox"
                  checked={chosen.has(member.discordUserId)}
                  onChange={(event) =>
                    onChange(
                      event.currentTarget.checked
                        ? [...config.memberIds, member.discordUserId]
                        : config.memberIds.filter((id) => id !== member.discordUserId),
                    )
                  }
                  className="size-4 accent-[var(--color-brand)]"
                />
                <span className="min-w-0">
                  <span
                    className={n === 0 ? "text-[var(--color-muted)] line-through" : "text-white"}
                  >
                    {member.displayName}
                  </span>{" "}
                  <span className="text-xs text-[var(--color-muted)]">
                    {n === 0 ? `not included — ${none}` : `${n} profile${n === 1 ? "" : "s"}`}
                  </span>
                  {clash && chosen.has(member.discordUserId) && (
                    <span className="block text-[11px] text-[var(--color-warn)]">
                      Also on Instance {clash.position}
                    </span>
                  )}
                </span>
              </label>
            </li>
          );
        })}
        {shown.length === 0 && (
          <li className="py-2 text-xs text-[var(--color-muted)]">
            {terms.length > 0 || inScope.length > 0
              ? "Nobody matches."
              : `No member has profiles ${where}.`}
          </li>
        )}
      </ul>
      {empty > 0 && (
        <p className="mt-1.5 flex flex-wrap items-center gap-x-2 text-xs text-[var(--color-muted)]">
          {showEmpty
            ? `Showing the ${empty} member${empty === 1 ? "" : "s"} with ${none}, crossed out: they aren't included.`
            : `${empty} member${empty === 1 ? "" : "s"} with ${none} ${empty === 1 ? "isn't" : "aren't"} listed or included.`}
          <button
            type="button"
            onClick={() => setShowEmpty((on) => !on)}
            className="inline-flex min-h-11 items-center font-medium text-[var(--color-fg)] underline underline-offset-2 sm:min-h-0"
          >
            {showEmpty ? "Hide them" : "Show them"}
          </button>
        </p>
      )}
    </div>
  );
}

/**
 * "3333, 4444, 5555": one watchdog per number, in each list. Typed freely and read when the
 * field is left -- read on every keystroke, the comma before the next number would vanish.
 */
function IntervalsInput({
  intervals,
  onChange,
}: {
  intervals: number[];
  onChange: (intervals: number[]) => void;
}) {
  const [text, setText] = useState(intervals.join(", "));
  const commit = () => {
    const parsed = text
      .split(/[\s,]+/)
      .map((v) => Math.floor(Number(v)))
      .filter((v) => Number.isFinite(v) && v > 0)
      .slice(0, 6);
    const next = parsed.length > 0 ? parsed : intervals;
    onChange(next);
    setText(next.join(", "));
  };
  return (
    <label className="text-xs text-[var(--color-muted)]">
      Watchdog intervals (ms, one per watchdog)
      <input
        value={text}
        onChange={(event) => setText(event.currentTarget.value)}
        onBlur={commit}
        className={`${field} mt-1 block w-full`}
      />
    </label>
  );
}

function TaskSettingsForm({
  settings,
  groups,
  onChange,
}: {
  settings: TaskSettings;
  groups: { id: number; name: string }[];
  onChange: (settings: TaskSettings) => void;
}) {
  const number = (value: string, fallback: number) => {
    const n = Math.floor(Number(value));
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  };
  const groupSelect = (value: number | null, set: (id: number | null) => void, label: string) => (
    <label className="text-xs text-[var(--color-muted)]">
      {label}
      <select
        value={value ?? ""}
        onChange={(event) =>
          set(event.currentTarget.value === "" ? null : Number(event.currentTarget.value))
        }
        className={`${field} mt-1 block w-full`}
      >
        <option value="">Leave as each task has it</option>
        {groups.map((g) => (
          <option key={g.id} value={g.id}>
            {g.name}
          </option>
        ))}
      </select>
    </label>
  );

  return (
    <details className="mt-6 rounded-xl border border-[var(--color-edge)] px-4 py-3">
      <summary className="cursor-pointer text-sm font-bold text-white">
        Task settings{" "}
        <span className="text-xs font-normal text-[var(--color-muted)]">
          — as this backup has them: qty {settings.checkoutQty}, {settings.watchdogIntervals.length}{" "}
          watchdogs per {settings.skusPerWatchdog} products, {settings.remoteWatchdogs} remote
        </span>
      </summary>
      <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <label className="text-xs text-[var(--color-muted)]">
          Qty per product (checkout)
          <input
            type="number"
            min={1}
            max={10}
            value={settings.checkoutQty}
            onChange={(event) =>
              onChange({
                ...settings,
                checkoutQty: Math.max(1, number(event.currentTarget.value, settings.checkoutQty)),
              })
            }
            className={`${field} mt-1 block w-full`}
          />
        </label>
        {groupSelect(
          settings.checkoutProxyGroupId,
          (id) => onChange({ ...settings, checkoutProxyGroupId: id }),
          "Checkout proxy group",
        )}
        {groupSelect(
          settings.watchdogProxyGroupId,
          (id) => onChange({ ...settings, watchdogProxyGroupId: id }),
          "Watchdog proxy group",
        )}
        <IntervalsInput
          intervals={settings.watchdogIntervals}
          onChange={(watchdogIntervals) => onChange({ ...settings, watchdogIntervals })}
        />
        <label className="text-xs text-[var(--color-muted)]">
          Products per watchdog (Shikari&rsquo;s limit is 30)
          <input
            type="number"
            min={1}
            max={30}
            value={settings.skusPerWatchdog}
            onChange={(event) =>
              onChange({
                ...settings,
                skusPerWatchdog: Math.min(30, Math.max(1, number(event.currentTarget.value, 30))),
              })
            }
            className={`${field} mt-1 block w-full`}
          />
        </label>
        <label className="text-xs text-[var(--color-muted)]">
          Remote watchdogs
          <input
            type="number"
            min={0}
            max={3}
            value={settings.remoteWatchdogs}
            onChange={(event) =>
              onChange({
                ...settings,
                remoteWatchdogs: Math.min(3, number(event.currentTarget.value, 1)),
              })
            }
            className={`${field} mt-1 block w-full`}
          />
        </label>
      </div>
    </details>
  );
}

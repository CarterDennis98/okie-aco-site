"use client";

import { useState, type ReactNode } from "react";
import type { ValorOverview } from "@/db/queries/valor";
import { MISC_LINE } from "@/lib/products/misc-line";
import { prepareValorExport } from "@/lib/valor/actions";
import { buildValorInstance } from "@/lib/valor/build";
import {
  ACO_BACKUP,
  ACO_MAIN,
  TARGET_PROXY_GROUP,
  parseValorBackup,
  serializeValorBackup,
  type ValorBackup,
} from "@/lib/valor/format";
import {
  FIRST_INSTANCE_CAP,
  MISC_POSITION,
  VALOR_POSITIONS,
  type ValorPosition,
} from "@/lib/valor/split";
import { summarizeValorBackup, type ValorGroupLine, type ValorSummary } from "@/lib/valor/summary";
import type { MiscTaskLine, ValorProfileLine, ValorReport } from "@/lib/valor/types";

/**
 * The Valor export, start to finish, like the Shikari one beside it: add each instance's
 * backup, review what the export would change in it, then download.
 *
 * The backups are read and rebuilt HERE, in the browser, and never uploaded: only which
 * instances to build goes to the server, which answers with what the vault says each should
 * hold. Who runs where is a fixed rule (valor/split.ts), so there is nothing to set up.
 */

type Slot = { name: string; size: number; backup: ValorBackup; summary: ValorSummary };

type Built = {
  position: ValorPosition;
  sourceName: string;
  fileName: string;
  productNames: Record<string, string>;
  report: ValorReport | null;
  /** The rebuilt file, or null when it must not be downloaded. */
  text: string | null;
  error: string | null;
};

const primary =
  "rounded-lg bg-[var(--color-brand)] px-4 py-2 text-sm font-semibold text-[var(--color-on-brand)] transition-colors hover:bg-[var(--color-brand-dark)] disabled:opacity-60";
const secondary =
  "rounded-lg border border-[var(--color-edge)] px-4 py-2 text-sm font-medium text-[var(--color-fg)] transition-colors hover:border-[var(--color-brand)]/50 disabled:opacity-60";

const n = (count: number, one: string, many = `${one}s`) =>
  `${count.toLocaleString("en-US")} ${count === 1 ? one : many}`;
const megabytes = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/** "3 added · 12 updated", leaving out the zeroes; "no changes" when everything is. */
function tally(parts: [number, string][]): string {
  const said = parts.filter(([count]) => count > 0).map(([count, label]) => `${count} ${label}`);
  return said.length > 0 ? said.join(" · ") : "no changes";
}

/** Names listed in full before a list is said by reason instead. */
const LISTED = 25;

/** Gives the browser a frame to paint "Building…" before the main thread goes heads-down. */
const nextFrame = () => new Promise((resolve) => setTimeout(resolve, 30));

export function ValorExport({ overview }: { overview: ValorOverview }) {
  const [slots, setSlots] = useState<Partial<Record<ValorPosition, Slot>>>({});
  const [loading, setLoading] = useState<ValorPosition | null>(null);
  const [slotError, setSlotError] = useState<Partial<Record<ValorPosition, string>>>({});
  const [step, setStep] = useState<"setup" | "review" | "done">("setup");
  const [built, setBuilt] = useState<Built[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load(position: ValorPosition, file: File) {
    setLoading(position);
    setSlotError((e) => ({ ...e, [position]: undefined }));
    try {
      const backup = parseValorBackup(await file.text());
      const summary = summarizeValorBackup(backup, position);
      setSlots((s) => ({
        ...s,
        [position]: { name: file.name, size: file.size, backup, summary },
      }));
    } catch (failure) {
      setSlots((s) => ({ ...s, [position]: undefined }));
      setSlotError((e) => ({
        ...e,
        [position]: failure instanceof Error ? failure.message : "That file couldn't be read.",
      }));
    } finally {
      setLoading(null);
    }
  }

  async function review() {
    setError(null);
    const positions = VALOR_POSITIONS.filter((p) => slots[p]);
    if (positions.length === 0) return setError("Add at least one instance's backup first.");
    const refused = positions.filter((p) => (slots[p]?.summary.problems.length ?? 0) > 0);
    if (refused.length > 0) {
      return setError(
        `Instance ${refused.join(" and ")}'s backup can't be exported as it is — see what's missing above.`,
      );
    }

    setBusy("Reading the vault…");
    const payload = await prepareValorExport({ instances: positions }).catch(() => ({
      ok: false as const,
      error: "The site couldn't be reached. Nothing was exported.",
    }));
    if (!payload.ok) {
      setBusy(null);
      return setError(payload.error);
    }

    setBusy("Building the backups…");
    await nextFrame();
    const stamp = new Date().toISOString().slice(0, 10);
    const results = positions.map((position): Built => {
      const slot = slots[position]!;
      const desired = payload.instances.find((i) => i.position === position)!;
      const base = {
        position,
        sourceName: slot.name,
        fileName: `okie-valor-instance-${position}-${stamp}.json`,
        productNames: Object.fromEntries(desired.products.map((p) => [p.sku, p.name])),
      };
      try {
        const { backup, report } = buildValorInstance(slot.backup, desired, {
          uuid: () => crypto.randomUUID(),
        });
        return { ...base, report, text: serializeValorBackup(backup), error: null };
      } catch (failure) {
        return {
          ...base,
          report: null,
          text: null,
          error: failure instanceof Error ? failure.message : "This backup couldn't be rebuilt.",
        };
      }
    });
    setBuilt(results);
    setBusy(null);
    setStep("review");
  }

  function download(instance: Built) {
    if (!instance.text) return;
    const url = URL.createObjectURL(new Blob([instance.text], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = instance.fileName;
    document.body.append(link);
    link.click();
    link.remove();
    // Long enough for the browser to have started the save; then the plaintext goes.
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }

  function confirm() {
    for (const instance of built) download(instance);
    setStep("done");
  }

  function startOver() {
    // The rebuilt files hold every card in clear. Dropping them is the point.
    setBuilt([]);
    setSlots({});
    setStep("setup");
  }

  if (step !== "setup") {
    const ready = built.filter((b) => b.text);
    return (
      <div className="space-y-6">
        {built.map((b) => (
          <InstanceReview
            key={b.position}
            built={b}
            done={step === "done"}
            onDownload={() => download(b)}
          />
        ))}
        <div className="flex flex-wrap items-center gap-3">
          {step === "review" ? (
            <>
              <button type="button" onClick={() => setStep("setup")} className={secondary}>
                Back
              </button>
              <button
                type="button"
                onClick={confirm}
                disabled={ready.length === 0}
                className={primary}
              >
                {ready.length === 0
                  ? "Nothing to download"
                  : `Download ${n(ready.length, "backup")}`}
              </button>
            </>
          ) : (
            <button type="button" onClick={startOver} className={secondary}>
              Start over
            </button>
          )}
          <p className="basis-full text-xs text-[var(--color-muted)]">
            {step === "review"
              ? "Nothing is downloaded until you confirm. Each file holds cards and passwords in clear: load it into Valor, then delete it."
              : "Downloaded. Load each file into its own Valor instance, then delete the files."}
          </p>
        </div>
      </div>
    );
  }

  const share = (position: ValorPosition) =>
    overview.instances.find((i) => i.position === position) ?? { main: 0, backup: 0 };

  return (
    <div className="space-y-6">
      {VALOR_POSITIONS.map((position) => {
        const counts = share(position);
        return (
          <section
            key={position}
            className="rounded-2xl border border-[var(--color-edge)] bg-[var(--color-surface)] p-5 sm:p-6"
          >
            <h3 className="text-lg font-bold text-white">Instance {position}</h3>
            <p className="mt-1 text-sm text-[var(--color-muted)]">
              {position === 1
                ? `Pokémon Center: the first ${FIRST_INSTANCE_CAP} main-bot and first ${FIRST_INSTANCE_CAP} backup-bot profiles, by name.`
                : `Pokémon Center: every profile past the first ${FIRST_INSTANCE_CAP} of each. Target: the ${MISC_LINE} line's picks.`}
            </p>
            <p className="mt-1 text-sm text-[var(--color-fg)]">
              Runs {n(counts.main, "main-bot profile")} in &ldquo;{ACO_MAIN}&rdquo; and{" "}
              {n(counts.backup, "backup-bot profile")} in &ldquo;{ACO_BACKUP}&rdquo;
              {position === MISC_POSITION &&
                `, and ${n(overview.misc.profiles, "Target profile")} of ${n(overview.misc.members, "member")} for the ${MISC_LINE} line’s ${n(overview.misc.products, "product")}, on “${TARGET_PROXY_GROUP}”`}
              .
            </p>

            <div className="mt-4">
              <label
                className={
                  "flex cursor-pointer flex-wrap items-center gap-3 rounded-xl border border-dashed px-4 py-3 text-sm transition-colors " +
                  (slots[position]
                    ? "border-[var(--color-edge)] text-[var(--color-muted)]"
                    : "border-[var(--color-brand)]/50 text-[var(--color-fg)] hover:bg-[var(--color-brand)]/5")
                }
              >
                <input
                  type="file"
                  accept=".json,application/json"
                  className="sr-only"
                  onChange={(event) => {
                    const file = event.currentTarget.files?.[0];
                    if (file) load(position, file);
                    event.currentTarget.value = "";
                  }}
                />
                <span className="font-semibold text-white">
                  {loading === position
                    ? "Reading…"
                    : slots[position]
                      ? "Replace backup"
                      : "Choose this instance's Valor backup (.json)"}
                </span>
                {slots[position] && (
                  <span>
                    {slots[position]!.name} · {megabytes(slots[position]!.size)} · Valor format{" "}
                    {slots[position]!.summary.version}
                  </span>
                )}
              </label>
              {slotError[position] && (
                <p role="alert" className="mt-2 text-sm text-[var(--color-warn)]">
                  {slotError[position]}
                </p>
              )}
              {slots[position] && <BackupSummary summary={slots[position]!.summary} />}
            </div>
          </section>
        );
      })}

      {overview.own > 0 && (
        <p className="text-xs text-[var(--color-muted)]">
          Your own {n(overview.own, "Pokémon Center profile")} {overview.own === 1 ? "is" : "are"}{" "}
          left out: they stay in their own groups in Valor, as you keep them.
        </p>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <button type="button" onClick={review} disabled={busy !== null} className={primary}>
          {busy ?? "Review changes"}
        </button>
        {error && (
          <p role="alert" className="basis-full text-sm text-[var(--color-warn)]">
            {error}
          </p>
        )}
        <p className="basis-full text-xs text-[var(--color-muted)]">
          Add one backup or both: each is built on its own. Nothing downloads until you confirm.
        </p>
      </div>
    </div>
  );
}

function BackupSummary({ summary }: { summary: ValorSummary }) {
  const groups = (title: string, lines: ValorGroupLine[]) =>
    lines.length > 0 && (
      <div>
        <p className="font-medium text-[var(--color-muted)]">{title}</p>
        <ul className="mt-0.5 space-y-0.5">
          {lines.map((g) => (
            <li key={g.name} className={g.managed ? "text-white" : "text-[var(--color-muted)]"}>
              {g.name} · {g.count.toLocaleString("en-US")}
              {g.managed ? " · rebuilt" : " · left as it is"}
            </li>
          ))}
        </ul>
      </div>
    );
  return (
    <div className="mt-3 space-y-3 text-xs">
      {summary.problems.length > 0 && (
        <p
          role="alert"
          className="rounded-lg border border-[var(--color-warn)]/40 bg-[var(--color-warn)]/5 px-3 py-2 text-sm text-[var(--color-warn)]"
        >
          This backup can&rsquo;t be exported as it is: {summary.problems.join("; ")}.
        </p>
      )}
      {summary.otherVersion && (
        <p className="text-[var(--color-warn)]">
          Valor format {summary.version} — the export was built against 3.0. Check the rebuilt file
          in a spare Valor first.
        </p>
      )}
      <div className="grid gap-3 sm:grid-cols-3">
        {groups("Profile groups", summary.profileGroups)}
        {groups("Task groups", summary.taskGroups)}
        {groups("Login groups", summary.loginGroups)}
      </div>
      <p className="text-[var(--color-muted)]">
        {n(summary.mailboxes, "IMAP mailbox", "IMAP mailboxes")}
      </p>
    </div>
  );
}

function Block({
  title,
  summary,
  changed,
  children,
}: {
  title: string;
  summary: string;
  changed: boolean;
  children?: ReactNode;
}) {
  return (
    <details open={changed} className="border-t border-[var(--color-edge)] py-2.5">
      <summary className="flex cursor-pointer flex-wrap items-baseline gap-x-2 text-sm">
        <span className="font-semibold text-white">{title}</span>
        <span className={changed ? "text-[var(--color-fg)]" : "text-[var(--color-muted)]"}>
          {summary}
        </span>
      </summary>
      {children && <div className="mt-2 space-y-2 pl-1 text-xs">{children}</div>}
    </details>
  );
}

function Lines({
  label,
  lines,
  tone = "fg",
}: {
  label: string;
  lines: ValorProfileLine[];
  tone?: "fg" | "warn" | "muted";
}) {
  if (lines.length === 0) return null;
  const color =
    tone === "warn"
      ? "text-[var(--color-warn)]"
      : tone === "muted"
        ? "text-[var(--color-muted)]"
        : "text-[var(--color-fg)]";
  const list = (
    <ul className="mt-0.5 space-y-0.5">
      {lines.map((line, i) => (
        <li key={`${line.name}-${i}`}>
          <span className="text-white">{line.name}</span>
          {line.owner && <span className="text-[var(--color-muted)]"> · {line.owner}</span>}
          {line.fields && line.fields.length > 0 && (
            <span className="text-[var(--color-muted)]"> — {line.fields.join(", ")}</span>
          )}
          {line.why && <span className="text-[var(--color-muted)]"> — {line.why}</span>}
        </li>
      ))}
    </ul>
  );
  if (lines.length <= LISTED) {
    return (
      <div>
        <p className={`font-medium ${color}`}>
          {label} ({lines.length})
        </p>
        {list}
      </div>
    );
  }
  // A long list -- the first export takes hundreds of profiles out of Target -- is said by
  // reason, or by what changed, with every name one click away.
  const counts = new Map<string, number>();
  for (const line of lines) {
    for (const key of line.why ? [line.why] : (line.fields ?? []))
      counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return (
    <div>
      <p className={`font-medium ${color}`}>
        {label} ({lines.length})
        {counts.size > 0 && (
          <span className="font-normal text-[var(--color-muted)]">
            {" "}
            — {[...counts].map(([key, count]) => `${key} ×${count}`).join(" · ")}
          </span>
        )}
      </p>
      <details className="mt-0.5">
        <summary className="cursor-pointer text-[var(--color-muted)]">Every name</summary>
        {list}
      </details>
    </div>
  );
}

function Names({
  label,
  items,
  tone = "fg",
}: {
  label: string;
  items: string[];
  tone?: "fg" | "warn" | "muted";
}) {
  if (items.length === 0) return null;
  const color =
    tone === "warn"
      ? "text-[var(--color-warn)]"
      : tone === "muted"
        ? "text-[var(--color-muted)]"
        : "text-[var(--color-fg)]";
  return (
    <p className={color}>
      <span className="font-medium">{label}:</span> {items.join(", ")}
    </p>
  );
}

function InstanceReview({
  built,
  done,
  onDownload,
}: {
  built: Built;
  done: boolean;
  onDownload: () => void;
}) {
  const r = built.report;
  const name = (sku: string) => built.productNames[sku] ?? sku;
  const tasks = (lines: MiscTaskLine[]) =>
    lines.length === 0
      ? "no task"
      : lines.map((t) => `${t.skus.map(name).join(", ")} ×${t.qty}`).join(" · ");

  return (
    <section className="rounded-2xl border border-[var(--color-edge)] bg-[var(--color-surface)] p-5 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-lg font-bold text-white">Instance {built.position}</h3>
          <p className="text-xs text-[var(--color-muted)]">
            From {built.sourceName}
            {r ? ` · Valor format ${r.version}` : ""}
            {r
              ? ` · ${n(r.pkc.main, "main-bot profile")}, ${n(r.pkc.backup, "backup-bot profile")}`
              : ""}
            {r?.misc ? ` · ${n(r.misc.tasks.after, "Target task")}` : ""}
          </p>
        </div>
        {done && built.text && (
          <button type="button" onClick={onDownload} className={secondary}>
            Download again
          </button>
        )}
      </div>

      {built.error && (
        <p
          role="alert"
          className="mt-3 rounded-lg border border-[var(--color-brand)]/50 bg-[var(--color-brand)]/10 px-3 py-2 text-sm"
        >
          {built.error} This backup won&rsquo;t be exported.
        </p>
      )}

      {r && (
        <div className="mt-4">
          {r.warnings.length > 0 && (
            <ul className="mb-3 space-y-1 rounded-lg border border-[var(--color-warn)]/40 bg-[var(--color-warn)]/5 px-3 py-2 text-sm text-[var(--color-warn)]">
              {r.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          )}

          <Block
            title="Pokémon Center profiles"
            changed={
              r.pkc.profiles.added.length +
                r.pkc.profiles.updated.length +
                r.pkc.profiles.moved.length +
                r.pkc.profiles.removed.length >
              0
            }
            summary={tally([
              [r.pkc.profiles.added.length, "new"],
              [r.pkc.profiles.updated.length, "updated"],
              [r.pkc.profiles.moved.length, "moved"],
              [r.pkc.profiles.removed.length, "removed"],
              [r.pkc.profiles.unchanged, "unchanged"],
            ])}
          >
            <Lines label="New" lines={r.pkc.profiles.added} />
            <Lines label="Updated" lines={r.pkc.profiles.updated} />
            <Lines label="Moved between main and backup" lines={r.pkc.profiles.moved} />
            <Lines label="Removed" lines={r.pkc.profiles.removed} tone="warn" />
          </Block>

          {r.pkc.taskGroups.map((g) => (
            <Block
              key={g.name}
              title={g.name}
              changed={g.added.length + g.removed.length + g.renamed > 0}
              summary={`${tally([
                [g.added.length, "added"],
                [g.removed.length, "removed"],
                [g.renamed, "renamed"],
                [g.kept - g.renamed, "kept"],
              ])} → ${n(g.after, "task")}`}
            >
              <Names label="Added for" items={g.added} />
              <Names label="Removed" items={g.removed} tone="warn" />
              {g.untouched > 0 && (
                <p className="text-[var(--color-muted)]">
                  {n(g.untouched, "task")} for profiles in other groups, left as they are.
                </p>
              )}
            </Block>
          ))}

          {r.misc && (
            <>
              <Block
                title="Target profiles"
                changed={
                  r.misc.profiles.added.length +
                    r.misc.profiles.updated.length +
                    r.misc.profiles.removed.length +
                    r.misc.skipped.length >
                  0
                }
                summary={tally([
                  [r.misc.profiles.added.length, "new"],
                  [r.misc.profiles.updated.length, "updated"],
                  [r.misc.profiles.removed.length, "removed"],
                  [r.misc.profiles.unchanged, "unchanged"],
                  [r.misc.skipped.length, "skipped"],
                ])}
              >
                <Lines label="New" lines={r.misc.profiles.added} />
                <Lines label="Updated" lines={r.misc.profiles.updated} />
                <Lines label="Skipped" lines={r.misc.skipped} tone="warn" />
                <Lines label="Removed" lines={r.misc.profiles.removed} tone="muted" />
              </Block>
              <Block
                title="Target logins"
                changed={
                  r.misc.accounts.added.length +
                    r.misc.accounts.updated.length +
                    r.misc.accounts.removed >
                  0
                }
                summary={tally([
                  [r.misc.accounts.added.length, "new"],
                  [r.misc.accounts.updated.length, "password changed"],
                  [r.misc.accounts.removed, "removed"],
                  [r.misc.accounts.unchanged, "unchanged"],
                ])}
              >
                <Names label="New" items={r.misc.accounts.added} />
                <Names label="Password changed" items={r.misc.accounts.updated} />
              </Block>
              <Block
                title="IMAP"
                changed={
                  r.misc.imap.added.length +
                    r.misc.imap.updated.length +
                    r.misc.imap.removed +
                    r.misc.imap.missing.length >
                  0
                }
                summary={tally([
                  [r.misc.imap.added.length, "new"],
                  [r.misc.imap.updated.length, "updated"],
                  [r.misc.imap.removed, "removed"],
                  [r.misc.imap.unchanged, "unchanged"],
                ])}
              >
                <Names label="New" items={r.misc.imap.added} />
                <Names label="Updated" items={r.misc.imap.updated} />
                <Names label="No mailbox on file" items={r.misc.imap.missing} tone="warn" />
              </Block>
              <Block
                title={`Target tasks (${MISC_LINE})`}
                changed={r.misc.tasks.changed.length > 0}
                summary={`${tally([
                  [r.misc.tasks.changed.length, "profiles changed"],
                  [r.misc.tasks.unchanged, "unchanged"],
                ])} → ${n(r.misc.tasks.after, "task")}`}
              >
                {r.misc.tasks.changed.length > 0 && (
                  <ul className="space-y-0.5">
                    {r.misc.tasks.changed.map((c) => (
                      <li key={c.profile}>
                        <span className="text-white">{c.profile}</span>
                        <span className="text-[var(--color-muted)]"> {tasks(c.before)}</span>
                        <span className="text-[var(--color-fg)]"> → {tasks(c.after)}</span>
                      </li>
                    ))}
                  </ul>
                )}
                {r.misc.tasks.untouched > 0 && (
                  <p className="text-[var(--color-muted)]">
                    {n(r.misc.tasks.untouched, "task")} for profiles outside &ldquo;Target&rdquo;,
                    left as they are.
                  </p>
                )}
              </Block>
            </>
          )}
        </div>
      )}
    </section>
  );
}

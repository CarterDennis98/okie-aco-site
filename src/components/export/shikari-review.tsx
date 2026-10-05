"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { ChangeSummary, CopyButton } from "@/components/export/shikari-summary";
import type { TableDiff } from "@/lib/shikari/diff";
import { summaryText } from "@/lib/shikari/summary";
import type { BuildReport, ProfileLine, WatchList } from "@/lib/shikari/types";

/**
 * What each rebuilt backup holds that the uploaded one didn't -- read before anything is
 * downloaded, and summed up again after.
 *
 * Two views of the same change, deliberately: the builder's own account of what it did, in
 * words, and underneath it a table-by-table count taken by comparing the two FILES, which
 * knows nothing about what the builder meant to do. If the two ever disagree, the file is
 * the truth -- and a file that touched a table no export may touch is not offered at all.
 *
 * Above both, the short version (shikari-summary.tsx): which profiles are new, activated,
 * updated, deactivated or removed. It is what stays on screen once the files are downloaded,
 * with the full review folded away beneath it.
 */

export type BuiltInstance = {
  position: number;
  sourceName: string;
  fileName: string;
  /** Profiles the vault says this instance runs. */
  profiles: number;
  productNames: Record<string, string>;
  report: BuildReport | null;
  diff: TableDiff[];
  forbidden: string[];
  /** The rebuilt file, or null when it must not be downloaded. */
  bytes: Uint8Array | null;
  error: string | null;
};

const primary =
  "rounded-lg bg-[var(--color-brand)] px-4 py-2 text-sm font-semibold text-[var(--color-on-brand)] transition-colors hover:bg-[var(--color-brand-dark)] disabled:opacity-60";
const secondary =
  "rounded-lg border border-[var(--color-edge)] px-4 py-2 text-sm font-medium text-[var(--color-fg)] transition-colors hover:border-[var(--color-brand)]/50 disabled:opacity-60";

const n = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

/** "3 added · 12 updated", leaving out the zeroes; "no changes" when everything is. */
function tally(parts: [number, string][]): string {
  const said = parts.filter(([count]) => count > 0).map(([count, label]) => `${count} ${label}`);
  return said.length > 0 ? said.join(" · ") : "no changes";
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

function profileLines(lines: ProfileLine[]) {
  return lines.map((line) => (
    <li key={line.name}>
      <span className="text-white">{line.name}</span>
      {line.owner && <span className="text-[var(--color-muted)]"> · {line.owner}</span>}
      {line.fields && line.fields.length > 0 && (
        <span className="text-[var(--color-muted)]"> — {line.fields.join(", ")}</span>
      )}
    </li>
  ));
}

function watchSummary(lists: WatchList[], names: Record<string, string>) {
  if (lists.length === 0) return <p className="text-[var(--color-muted)]">none</p>;
  return (
    <ol className="list-inside list-decimal space-y-0.5">
      {lists.map((list, i) => (
        <li key={i}>
          {list.interval ? `${list.interval}ms` : "—"} · {n(list.skus.length, "product")}
          <span className="text-[var(--color-muted)]">
            {" "}
            (
            {list.skus
              .slice(0, 4)
              .map((sku) => names[sku] ?? sku)
              .join(", ")}
            {list.skus.length > 4 ? ", …" : ""})
          </span>
        </li>
      ))}
    </ol>
  );
}

function InstanceReview({
  built,
  done,
  onDownload,
}: {
  built: BuiltInstance;
  done: boolean;
  onDownload: () => void;
}) {
  const r = built.report;

  return (
    <section className="rounded-2xl border border-[var(--color-edge)] bg-[var(--color-surface)] p-5 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-lg font-bold text-white">Instance {built.position}</h3>
          <p className="text-xs text-[var(--color-muted)]">
            From {built.sourceName} · {n(built.profiles, "profile")} from the vault
            {r?.version ? ` · Shikari ${r.version}` : ""}
          </p>
          {r?.taskGroup?.renamedFrom && (
            <p className="mt-0.5 text-xs text-[var(--color-fg)]">
              Task group &ldquo;{r.taskGroup.renamedFrom}&rdquo; is rebuilt and renamed &ldquo;
              {r.taskGroup.name}&rdquo;.
            </p>
          )}
          {r?.taskGroup?.created && (
            <p className="mt-0.5 text-xs text-[var(--color-fg)]">
              Task group &ldquo;{r.taskGroup.name}&rdquo; is new in this backup.
            </p>
          )}
        </div>
        {done && built.bytes && (
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
      {built.forbidden.length > 0 && (
        <p
          role="alert"
          className="mt-3 rounded-lg border border-[var(--color-brand)]/50 bg-[var(--color-brand)]/10 px-3 py-2 text-sm"
        >
          The rebuilt file changed {built.forbidden.join(", ")}, which no export may touch, so it
          won&rsquo;t be offered. This is a bug — nothing was downloaded.
        </p>
      )}

      {r && (
        <div className="mt-4 space-y-3">
          {r.warnings.length > 0 && (
            <ul className="space-y-1 rounded-lg border border-[var(--color-warn)]/40 bg-[var(--color-warn)]/5 px-3 py-2 text-xs text-[var(--color-fg)]">
              {r.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          )}
          <ChangeSummary position={built.position} fileName={built.fileName} report={r} />
          {done ? (
            // Downloaded: the summary is the point now, and the rest is there if it's wanted.
            <details>
              <summary className="cursor-pointer text-xs font-medium text-[var(--color-muted)] hover:text-[var(--color-fg)]">
                Full review
              </summary>
              <ReviewDetails built={built} report={r} />
            </details>
          ) : (
            <ReviewDetails built={built} report={r} />
          )}
        </div>
      )}
    </section>
  );
}

function ReviewDetails({ built, report: r }: { built: BuiltInstance; report: BuildReport }) {
  const name = (sku: string) => built.productNames[sku] ?? `SKU ${sku}`;
  const changedTables = built.diff.filter((d) => d.added + d.removed + d.changed > 0);
  const groupsRemoved = r.groupsRemoved.profile.length + r.groupsRemoved.task.length;
  return (
    <div>
      <Block
        title="Groups"
        changed={groupsRemoved > 0}
        summary={tally([
          [groupsRemoved, "removed"],
          [r.profiles.kept.length, "other profile groups left as they were"],
        ])}
      >
        <Names label="Profile groups removed" items={r.groupsRemoved.profile} tone="warn" />
        <Names label="Task groups emptied by this export, removed" items={r.groupsRemoved.task} />
        <Names
          label="Left as they were"
          items={r.profiles.kept.map((g) => `${g.group} (${g.count}, ${g.why})`)}
          tone="muted"
        />
        <Names
          label="Second copies of a profile above, removed"
          items={r.profiles.duplicates}
          tone="warn"
        />
      </Block>

      <Block
        title="Logins"
        changed={r.accounts.added.length + r.accounts.updated.length + r.accounts.removed > 0}
        summary={tally([
          [r.accounts.added.length, "added"],
          [r.accounts.updated.length, "passwords changed"],
          [r.accounts.removed, "removed"],
          [r.accounts.unchanged, "unchanged"],
        ])}
      >
        <Names label="Added" items={r.accounts.added} />
        <Names label="New password" items={r.accounts.updated} />
        {r.accounts.removed > 0 && (
          <p className="text-[var(--color-muted)]">
            {n(r.accounts.removed, "Target login")} no profile left here uses, with
            {r.accounts.removed === 1 ? " its" : " their"} saved session, removed.
          </p>
        )}
        <Names
          label="No password on the site, login left as it is"
          items={r.accounts.noPassword}
          tone="muted"
        />
      </Block>

      <Block
        title="IMAP"
        changed={r.imap.added.length + r.imap.updated.length + r.imap.removed > 0}
        summary={tally([
          [r.imap.added.length, "added"],
          [r.imap.updated.length, "updated"],
          [r.imap.removed, "removed"],
          [r.imap.unchanged, "unchanged"],
        ])}
      >
        <Names label="Added" items={r.imap.added} />
        <Names label="Updated" items={r.imap.updated} />
        {r.imap.removed > 0 && (
          <p className="text-[var(--color-muted)]">
            {n(r.imap.removed, "mailbox", "mailboxes")} no profile or task here uses, removed.
          </p>
        )}
      </Block>

      {r.proxies.length > 0 && (
        <Block title="Proxies" changed summary={n(r.proxies.length, "list") + " replaced"}>
          <ul className="space-y-0.5">
            {r.proxies.map((p) => (
              <li key={p.group}>
                <span className="text-white">{p.group}</span>: {p.before.toLocaleString("en-US")} →{" "}
                {p.after.toLocaleString("en-US")} ({p.changed.toLocaleString("en-US")} rows
                rewritten, added or removed
                {p.browsersMoved > 0 && `; ${n(p.browsersMoved, "browser")} re-pinned`})
              </li>
            ))}
          </ul>
        </Block>
      )}

      <Block
        title="Checkout tasks"
        changed={
          r.checkout.added.length + r.checkout.changed.length + r.checkout.removed.length > 0
        }
        summary={tally([
          [r.checkout.added.length, "added"],
          [r.checkout.changed.length, "changed"],
          [r.checkout.removed.length, "removed"],
          [r.checkout.unchanged, "unchanged"],
        ])}
      >
        {r.checkout.added.length > 0 && (
          <Names
            label="Added"
            items={r.checkout.added.map((t) => `${t.profile} (${n(t.skus, "product")})`)}
          />
        )}
        {r.checkout.changed.length > 0 && (
          <div>
            <p className="font-medium text-[var(--color-fg)]">Changed</p>
            <ul className="mt-0.5 space-y-0.5">
              {r.checkout.changed.map((t) => (
                <li key={t.profile}>
                  <span className="text-white">{t.profile}</span>
                  {t.added.length > 0 && (
                    <span className="text-[var(--color-good)]">
                      {" "}
                      + {t.added.map(name).join(", ")}
                    </span>
                  )}
                  {t.removed.length > 0 && (
                    <span className="text-[var(--color-warn)]">
                      {" "}
                      − {t.removed.map(name).join(", ")}
                    </span>
                  )}
                  {t.other.length > 0 && (
                    <span className="text-[var(--color-muted)]"> · {t.other.join(", ")}</span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
        <Names label="Removed" items={r.checkout.removed.map((t) => t.profile)} tone="warn" />
        <Names label="Picked no products, so no task" items={r.checkout.noProducts} tone="muted" />
        <Names
          label="Not a profile in this backup, so no task"
          items={r.checkout.missingProfile}
          tone="warn"
        />
        <Names
          label="Tasks for profiles in other groups, left alone"
          items={r.checkout.untouched}
          tone="muted"
        />
      </Block>

      <Block
        title="Watchdogs"
        changed={
          JSON.stringify(r.watchdogs.before) !== JSON.stringify(r.watchdogs.after) ||
          r.watchdogs.remote.before !== r.watchdogs.remote.after
        }
        summary={`${r.watchdogs.before.length} → ${r.watchdogs.after.length} on products, remote ${r.watchdogs.remote.before} → ${r.watchdogs.remote.after}`}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <p className="font-medium text-[var(--color-muted)]">Before</p>
            {watchSummary(r.watchdogs.before, built.productNames)}
          </div>
          <div>
            <p className="font-medium text-[var(--color-fg)]">After</p>
            {watchSummary(r.watchdogs.after, built.productNames)}
          </div>
        </div>
      </Block>

      <Block
        title="Profile updates"
        changed={r.wipes.added.length + r.wipes.removed > 0}
        summary={tally([
          [r.wipes.added.length, "wipe tasks"],
          [r.wipes.removed, "old ones cleared"],
        ])}
      >
        {r.wipes.added.length > 0 && <ul className="space-y-0.5">{profileLines(r.wipes.added)}</ul>}
        {r.wipes.template === "built-in" && (
          <p className="text-[var(--color-muted)]">
            No Wipe Account task in this backup to copy, so these use Shikari&rsquo;s standard one.
          </p>
        )}
      </Block>

      <details className="border-t border-[var(--color-edge)] pt-2.5">
        <summary className="cursor-pointer text-sm">
          <span className="font-semibold text-white">The file itself</span>{" "}
          <span className="text-[var(--color-muted)]">
            {changedTables.length === 0
              ? "identical"
              : `${n(changedTables.length, "table")} differ`}
          </span>
        </summary>
        <div className="mt-2 overflow-x-auto">
          <table className="w-full min-w-[28rem] text-xs tabular-nums">
            <thead>
              <tr className="text-left text-[var(--color-muted)]">
                <th className="py-1 pr-3 font-medium">Table</th>
                <th className="py-1 pr-3 font-medium">Rows</th>
                <th className="py-1 pr-3 font-medium">Added</th>
                <th className="py-1 pr-3 font-medium">Changed</th>
                <th className="py-1 font-medium">Removed</th>
              </tr>
            </thead>
            <tbody>
              {built.diff.map((d) => {
                const touched = d.added + d.removed + d.changed > 0;
                return (
                  <tr
                    key={d.table}
                    className={touched ? "text-[var(--color-fg)]" : "text-[var(--color-muted)]/70"}
                  >
                    <td className="py-0.5 pr-3">{d.table}</td>
                    <td className="py-0.5 pr-3">
                      {d.before.toLocaleString("en-US")}
                      {d.after !== d.before && ` → ${d.after.toLocaleString("en-US")}`}
                    </td>
                    <td className="py-0.5 pr-3">{d.added || ""}</td>
                    <td className="py-0.5 pr-3">{d.changed || ""}</td>
                    <td className="py-0.5">{d.removed || ""}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}

export function ShikariReview({
  built,
  done,
  onBack,
  onConfirm,
  onDownload,
  onStartOver,
}: {
  built: BuiltInstance[];
  done: boolean;
  onBack: () => void;
  onConfirm: () => void;
  onDownload: (instance: BuiltInstance) => void;
  onStartOver: () => void;
}) {
  const ready = built.filter((b) => b.bytes);
  const blocked = built.length - ready.length;

  return (
    <div className="space-y-6">
      {done ? (
        <div
          role="status"
          className="rounded-xl border border-[var(--color-good)]/40 bg-[var(--color-good)]/5 px-4 py-3 text-sm"
        >
          <div className="flex flex-wrap items-baseline justify-between gap-x-3">
            <p className="font-semibold text-white">
              {n(ready.length, "backup")} downloaded. Restore each one into its Shikari instance.
            </p>
            <CopyButton
              label={built.length === 1 ? "Copy summary" : "Copy all summaries"}
              text={built
                .flatMap((b) => (b.report ? [summaryText(b.position, b.fileName, b.report)] : []))
                .join("\n\n")}
            />
          </div>
          <p className="mt-1 text-[var(--color-muted)]">
            Pending profile changes are still pending — once the backups are loaded, confirm them on
            the{" "}
            <Link
              href="/admin/profiles"
              className="underline underline-offset-2 hover:text-[var(--color-fg)]"
            >
              Admin page
            </Link>
            . If a download didn&rsquo;t start, use its Download again button.
          </p>
        </div>
      ) : (
        <div className="rounded-xl border border-[var(--color-warn)]/40 bg-[var(--color-warn)]/5 px-4 py-3 text-sm">
          <p className="font-semibold text-white">Review before anything downloads.</p>
          <p className="mt-1 text-[var(--color-muted)]">
            This is exactly what each backup will hold. Nothing has been saved anywhere yet, and
            exporting won&rsquo;t confirm any pending changes.
          </p>
        </div>
      )}

      {built.map((b) => (
        <InstanceReview key={b.position} built={b} done={done} onDownload={() => onDownload(b)} />
      ))}

      <div className="flex flex-wrap items-center gap-3">
        {done ? (
          <button type="button" onClick={onStartOver} className={secondary}>
            Start over
          </button>
        ) : (
          <>
            <button type="button" onClick={onBack} className={secondary}>
              Back to setup
            </button>
            <button
              type="button"
              onClick={onConfirm}
              disabled={ready.length === 0}
              className={primary}
            >
              Confirm and download {n(ready.length, "backup")}
            </button>
            {blocked > 0 && (
              <p className="text-xs text-[var(--color-warn)]">
                {n(blocked, "instance")} can&rsquo;t be exported — see above.
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}

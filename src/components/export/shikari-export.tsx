"use client";

import { useState } from "react";
import type { ShikariMember } from "@/db/queries/shikari";
import { prepareShikariExport } from "@/lib/shikari/actions";
import { buildInstance } from "@/lib/shikari/build";
import {
  defaultInstanceConfig,
  MAX_INSTANCES,
  type ShikariInstanceConfig,
} from "@/lib/shikari/config";
import { diffTables, forbiddenChanges, tableHashes } from "@/lib/shikari/diff";
import { loadSqlJs } from "@/lib/shikari/load-sqljs";
import { parseProxyList } from "@/lib/shikari/proxies";
import { checkShikariSchema } from "@/lib/shikari/schema";
import {
  currentTaskSettings,
  groupsToClear,
  readSnapshot,
  summarize,
} from "@/lib/shikari/snapshot";
import { backupBytes, openBackup } from "@/lib/shikari/sqlite";
import { InstanceCard, type InstanceDraft } from "@/components/export/shikari-instance";
import { ShikariReview, type BuiltInstance } from "@/components/export/shikari-review";

/**
 * The Shikari export, start to finish: set up each instance, review what the export would
 * change in each backup, then download them.
 *
 * Everything heavy happens HERE, in the browser: the backups are opened, read and rebuilt
 * with SQLite compiled to WebAssembly, and only the instances' settings go to the server --
 * which answers with what the vault says each instance should hold. The rebuilt files exist
 * nowhere but this page until they are downloaded.
 *
 * Nothing is downloaded until the review is confirmed, and the review is of the very files
 * that will download: each is built once, its report and its table-by-table diff are what
 * the review shows, and the same bytes are what the button saves.
 */

let nextKey = 0;
const key = () => `instance-${(nextKey += 1)}`;

function draft(config: ShikariInstanceConfig): InstanceDraft {
  return {
    key: key(),
    config,
    backup: null,
    settings: null,
    proxyLists: {},
    loading: false,
    error: null,
  };
}

const primary =
  "rounded-lg bg-[var(--color-brand)] px-4 py-2 text-sm font-semibold text-[var(--color-on-brand)] transition-colors hover:bg-[var(--color-brand-dark)] disabled:opacity-60";
const secondary =
  "rounded-lg border border-[var(--color-edge)] px-4 py-2 text-sm font-medium text-[var(--color-fg)] transition-colors hover:border-[var(--color-brand)]/50 disabled:opacity-60";

/** Gives the browser a frame to paint "Building…" before the main thread goes heads-down. */
const nextFrame = () => new Promise((resolve) => setTimeout(resolve, 30));

export function ShikariExport({
  members,
  saved,
  cap,
  productCount,
}: {
  members: ShikariMember[];
  saved: ShikariInstanceConfig[];
  cap: number | null;
  productCount: number;
}) {
  const [drafts, setDrafts] = useState<InstanceDraft[]>(() => {
    // First time: one instance running everybody's main-bot profiles.
    if (saved.length === 0)
      return [draft(defaultInstanceConfig(members.map((m) => m.discordUserId)))];
    // Last time's setup, less anyone who no longer has a profile on your bot: they would
    // count as chosen while showing nowhere in the list.
    const current = new Set(members.map((m) => m.discordUserId));
    return saved.map((config) =>
      draft({ ...config, memberIds: config.memberIds.filter((id) => current.has(id)) }),
    );
  });
  const [step, setStep] = useState<"setup" | "review" | "done">("setup");
  const [built, setBuilt] = useState<BuiltInstance[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const update = (index: number, patch: Partial<InstanceDraft>) =>
    setDrafts((current) => current.map((d, i) => (i === index ? { ...d, ...patch } : d)));

  async function loadBackup(index: number, file: File) {
    update(index, { loading: true, error: null });
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const SQL = await loadSqlJs();
      const open = openBackup(SQL, bytes);
      try {
        const schema = checkShikariSchema(open.db);
        if (!schema.ok) {
          throw new Error(
            `This backup isn't in a format the export knows (${schema.problems.slice(0, 3).join("; ")}). Shikari may have updated.`,
          );
        }
        const snapshot = readSnapshot(open.db);
        update(index, {
          loading: false,
          backup: {
            name: file.name,
            size: file.size,
            bytes,
            summary: summarize(snapshot),
            newerVersion: schema.newerVersion,
          },
          settings: currentTaskSettings(snapshot),
          proxyLists: {},
        });
      } finally {
        open.db.close();
      }
    } catch (failure) {
      update(index, {
        loading: false,
        backup: null,
        settings: null,
        error: failure instanceof Error ? failure.message : "That file couldn't be read.",
      });
    }
  }

  async function loadProxies(index: number, groupId: number, file: File) {
    const parsed = parseProxyList(await file.text());
    setDrafts((current) =>
      current.map((d, i) =>
        i === index
          ? { ...d, proxyLists: { ...d.proxyLists, [groupId]: { fileName: file.name, ...parsed } } }
          : d,
      ),
    );
  }

  async function review() {
    setError(null);
    const missing = drafts.flatMap((d, i) => (d.backup ? [] : [`Instance ${i + 1}`]));
    if (missing.length > 0) return setError(`Add a backup for ${missing.join(" and ")} first.`);
    const nobody = drafts.flatMap((d, i) =>
      d.config.memberIds.length ? [] : [`Instance ${i + 1}`],
    );
    if (nobody.length > 0) return setError(`Pick members for ${nobody.join(" and ")}.`);

    setBusy("Reading the vault…");
    const payload = await prepareShikariExport({
      instances: drafts.map((d, i) => ({ position: i + 1, config: d.config })),
    }).catch(() => ({
      ok: false as const,
      error: "The site couldn't be reached. Nothing was exported.",
    }));
    if (!payload.ok) {
      setBusy(null);
      return setError(payload.error);
    }

    setBusy("Building the backups…");
    await nextFrame();
    const SQL = await loadSqlJs();
    const results: BuiltInstance[] = drafts.map((d, i) => {
      const position = i + 1;
      const desired = payload.instances.find((x) => x.position === position)!;
      const base = {
        position,
        sourceName: d.backup!.name,
        fileName: `okie-shikari-instance-${position}-${new Date().toISOString().slice(0, 10)}.bak`,
        profiles: desired.profiles.length,
        productNames: Object.fromEntries(desired.products.map((p) => [p.sku, p.name])),
      };
      const open = openBackup(SQL, d.backup!.bytes);
      try {
        // Hashed before and after in the one copy, rather than a second copy kept to compare
        // against: a main instance's backup is 170 MB, and the browser holds it twice already.
        const baseline = tableHashes(open.db);
        const report = buildInstance(open.db, desired, {
          sections: d.config.sections,
          removeProfileGroups: groupsToClear(d.backup!.summary, d.config.groups),
          proxyLists: Object.entries(d.proxyLists).map(([groupId, list]) => ({
            groupId: Number(groupId),
            proxies: list.proxies,
          })),
          tasks: d.settings!,
          now: new Date(),
          random: Math.random,
        });
        const diff = diffTables(baseline, tableHashes(open.db));
        const forbidden = forbiddenChanges(diff);
        return {
          ...base,
          report,
          diff,
          forbidden,
          // A file that touched something no export may touch is never offered at all.
          bytes: forbidden.length === 0 ? backupBytes(open) : null,
          error: null,
        };
      } catch (failure) {
        return {
          ...base,
          report: null,
          diff: [],
          forbidden: [],
          bytes: null,
          error: failure instanceof Error ? failure.message : "This backup couldn't be rebuilt.",
        };
      } finally {
        open.db.close();
      }
    });
    setBuilt(results);
    setBusy(null);
    setStep("review");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function download(instance: BuiltInstance) {
    if (!instance.bytes) return;
    const url = URL.createObjectURL(
      new Blob([instance.bytes as BlobPart], { type: "application/octet-stream" }),
    );
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
    setDrafts((current) =>
      current.map((d) => ({ ...d, backup: null, settings: null, proxyLists: {}, error: null })),
    );
    setStep("setup");
  }

  if (step !== "setup") {
    return (
      <ShikariReview
        built={built}
        done={step === "done"}
        onBack={() => setStep("setup")}
        onConfirm={confirm}
        onDownload={download}
        onStartOver={startOver}
      />
    );
  }

  return (
    <div className="space-y-6">
      {members.length === 0 && (
        <p className="rounded-xl border border-[var(--color-warn)]/40 bg-[var(--color-warn)]/5 px-4 py-3 text-sm">
          No member has an active Target profile assigned to you, so there is nothing to export.
        </p>
      )}
      {productCount === 0 && (
        <p className="rounded-xl border border-[var(--color-warn)]/40 bg-[var(--color-warn)]/5 px-4 py-3 text-sm">
          No products are listed on Target Products yet, so checkout tasks would be built with
          nothing to run. Add them there first.
        </p>
      )}

      {drafts.map((d, index) => (
        <InstanceCard
          key={d.key}
          position={index + 1}
          draft={d}
          others={drafts
            .filter((_, i) => i !== index)
            .map((o, i) => ({
              position: i >= index ? i + 2 : i + 1,
              config: o.config,
            }))}
          members={members}
          cap={cap}
          onChange={(patch) => update(index, patch)}
          onBackup={(file) => loadBackup(index, file)}
          onProxies={(groupId, file) => loadProxies(index, groupId, file)}
          onRemove={
            drafts.length > 1 ? () => setDrafts((c) => c.filter((_, i) => i !== index)) : undefined
          }
        />
      ))}

      <div className="flex flex-wrap items-center gap-3">
        {drafts.length < MAX_INSTANCES && (
          <button
            type="button"
            onClick={() =>
              setDrafts((c) => [...c, draft({ ...defaultInstanceConfig(), bot: "backup" })])
            }
            className={secondary}
          >
            Add instance
          </button>
        )}
        <button type="button" onClick={review} disabled={busy !== null} className={primary}>
          {busy ?? "Review changes"}
        </button>
        {error && (
          <p role="alert" className="basis-full text-sm text-[var(--color-warn)]">
            {error}
          </p>
        )}
        <p className="basis-full text-xs text-[var(--color-muted)]">
          Reviewing saves each instance&rsquo;s setup for next time. Nothing downloads until you
          confirm.
        </p>
      </div>
    </div>
  );
}

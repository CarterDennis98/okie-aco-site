"use client";

import { useRef, useState, useTransition } from "react";
import type { ProductLine } from "@/db/queries/products";
import { saveProductLines } from "@/lib/products/admin-actions";
import { LINE_NAME_LIMIT, parseLineName, parseLogo } from "@/lib/products/product-input";
import { useReorder } from "@/components/products/use-reorder";

/**
 * "Product lines": the lines sets are listed under -- Pokémon, Topps, One Piece -- each a name
 * and an optional logo, in the order members see them. Add, rename, arrange and remove, all
 * saved together. A native <dialog>, built like the set arranger: the list scrolls, the
 * heading and the buttons stay put.
 *
 * Which line a set is in is the set editor's. Removing a line here removes no set: its sets
 * go back under "Other".
 */

type Row = { key: string; id: string | null; name: string; logoUrl: string };

let nextKey = 0;
const newKey = () => `line-${(nextKey += 1)}`;

const field =
  "w-full rounded-lg border border-[var(--color-edge)] bg-[var(--color-ink)] px-2.5 py-1.5 text-base sm:text-sm text-[var(--color-fg)] placeholder:text-[var(--color-muted)]/60 focus:border-[var(--color-brand)] focus:outline-none";
const primary =
  "rounded-lg bg-[var(--color-brand)] px-4 py-2 text-sm font-semibold text-[var(--color-on-brand)] transition-colors hover:bg-[var(--color-brand-dark)] disabled:opacity-60";
const secondary =
  "rounded-lg border border-[var(--color-edge)] px-4 py-2 text-sm font-medium text-[var(--color-fg)] transition-colors hover:border-[var(--color-brand)]/50 disabled:opacity-60";
const iconButton =
  "inline-flex size-11 items-center justify-center rounded-lg text-sm text-[var(--color-muted)] transition-colors hover:text-[var(--color-fg)] disabled:opacity-30 sm:size-7";

function Logo({ src }: { src: string }) {
  const link = src.trim();
  if (!link.startsWith("https://")) {
    return <span aria-hidden className="h-8 w-12 shrink-0 rounded-md bg-[var(--color-elevated)]" />;
  }
  return (
    // A plain <img>, as on the page: see ProductEditor for why not next/image.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={link}
      alt=""
      referrerPolicy="no-referrer"
      className="h-8 w-12 shrink-0 object-contain"
    />
  );
}

export function LineEditor({
  lines,
  setCounts,
}: {
  lines: ProductLine[];
  /** How many sets each line has, by line id. */
  setCounts: Record<string, number>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, startSaving] = useTransition();
  const { move, handle, row, dragging, over } = useReorder(
    setRows,
    rows.map((r) => r.key),
  );

  const asRows = (): Row[] =>
    lines.map((line) => ({
      key: line.id,
      id: line.id,
      name: line.name,
      logoUrl: line.logoUrl ?? "",
    }));

  function open() {
    setRows(asRows());
    setError(null);
    dialog.current?.showModal();
  }

  function edit(key: string, patch: Partial<Row>) {
    setRows((current) => current.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  }

  function add() {
    setRows((current) => [...current, { key: newKey(), id: null, name: "", logoUrl: "" }]);
  }

  const shape = (list: Row[]) =>
    JSON.stringify(list.map((r) => [r.id, r.name.trim(), r.logoUrl.trim()]));

  function save() {
    setError(null);
    for (const r of rows) {
      const name = parseLineName(r.name);
      if (!name.ok) return setError(name.error);
      const logo = parseLogo(r.logoUrl, "product line");
      if (!logo.ok) return setError(`${name.value}: ${logo.error}`);
    }
    if (shape(rows) === shape(asRows())) return dialog.current?.close();
    const kept = new Set(rows.map((r) => r.id));
    startSaving(async () => {
      const result = await saveProductLines({
        lines: rows.map((r) => ({ id: r.id, name: r.name, logoUrl: r.logoUrl })),
        removed: lines.filter((line) => !kept.has(line.id)).map((line) => line.id),
      }).catch(() => ({ ok: false as const, error: "That didn't save. Check your connection." }));
      if (!result.ok) return setError(result.error);
      dialog.current?.close();
    });
  }

  const removing = lines.filter((line) => !rows.some((r) => r.id === line.id));
  const orphaned = removing.reduce((sum, line) => sum + (setCounts[line.id] ?? 0), 0);

  return (
    <>
      <button type="button" onClick={open} className={secondary}>
        Product lines
      </button>

      <dialog
        ref={dialog}
        aria-labelledby="product-lines-title"
        className="m-auto max-h-[calc(100dvh-2rem)] w-[min(40rem,calc(100vw-2rem))] overflow-hidden rounded-2xl border border-[var(--color-edge)] bg-[var(--color-surface)] p-0 text-[var(--color-fg)] backdrop:bg-black/60 open:flex open:flex-col"
      >
        <form
          method="dialog"
          onSubmit={(event) => {
            event.preventDefault();
            save();
          }}
          className="flex min-h-0 flex-1 flex-col"
        >
          <div className="flex shrink-0 items-start justify-between gap-4 border-b border-[var(--color-edge)] px-5 py-4 sm:px-6">
            <div>
              <h2 id="product-lines-title" className="text-lg font-bold text-white">
                Product lines
              </h2>
              <p className="mt-1 text-xs text-[var(--color-muted)]">
                Sets are listed under these, in this order. Put a set in one with its &ldquo;Edit
                set&rdquo;. Sets in no line show last, under &ldquo;Other&rdquo;.
              </p>
            </div>
            <button
              type="button"
              onClick={() => dialog.current?.close()}
              aria-label="Close"
              className="-mt-1 -mr-1 inline-flex size-11 shrink-0 items-center justify-center rounded-lg text-[var(--color-muted)] hover:text-[var(--color-fg)] sm:size-8"
            >
              ✕
            </button>
          </div>

          <div className="relative min-h-0 flex-1 space-y-3 overflow-y-auto px-5 py-4 sm:px-6">
            {rows.length === 0 ? (
              <p className="rounded-lg border border-dashed border-[var(--color-edge)] px-3 py-4 text-center text-xs text-[var(--color-muted)]">
                No product lines yet. Every set shows on its own, as it always has.
              </p>
            ) : (
              <ol className="space-y-1.5">
                {rows.map((r, index) => {
                  const title = r.name.trim() || "New product line";
                  const sets = r.id ? (setCounts[r.id] ?? 0) : 0;
                  return (
                    <li
                      key={r.key}
                      {...row(r.key, index)}
                      className={
                        "rounded-lg border px-2 py-2 transition-colors " +
                        (over === r.key && dragging !== r.key
                          ? "border-[var(--color-brand)] bg-[var(--color-brand)]/5"
                          : "border-[var(--color-edge)]") +
                        (dragging === r.key ? " opacity-50" : "")
                      }
                    >
                      <div className="flex items-center gap-2">
                        <span
                          {...handle(r.key)}
                          title="Drag to reorder"
                          aria-hidden
                          className="hidden cursor-grab touch-none px-1 text-[var(--color-muted)] select-none hover:text-[var(--color-fg)] sm:block"
                        >
                          ⠿
                        </span>
                        <span className="w-5 shrink-0 text-right text-xs text-[var(--color-muted)] tabular-nums">
                          {index + 1}
                        </span>
                        <Logo src={r.logoUrl} />
                        <div className="min-w-0 flex-1">
                          <input
                            aria-label={`Name of product line ${index + 1}`}
                            value={r.name}
                            onChange={(event) => edit(r.key, { name: event.currentTarget.value })}
                            maxLength={LINE_NAME_LIMIT}
                            placeholder="Pokémon"
                            className={field}
                          />
                        </div>
                        <div className="flex shrink-0 items-center">
                          <button
                            type="button"
                            onClick={() => move(index, index - 1)}
                            disabled={index === 0}
                            aria-label={`Move ${title} up`}
                            className={iconButton}
                          >
                            ↑
                          </button>
                          <button
                            type="button"
                            onClick={() => move(index, index + 1)}
                            disabled={index === rows.length - 1}
                            aria-label={`Move ${title} down`}
                            className={iconButton}
                          >
                            ↓
                          </button>
                          <button
                            type="button"
                            onClick={() =>
                              setRows((current) => current.filter((x) => x.key !== r.key))
                            }
                            aria-label={`Remove ${title}`}
                            className={iconButton}
                          >
                            ✕
                          </button>
                        </div>
                      </div>
                      <div className="mt-2 flex items-center gap-2 sm:ml-[6.75rem]">
                        <input
                          aria-label={`Logo link of product line ${index + 1}`}
                          value={r.logoUrl}
                          onChange={(event) => edit(r.key, { logoUrl: event.currentTarget.value })}
                          inputMode="url"
                          placeholder="Logo link (optional)"
                          className={field}
                        />
                        <span className="w-14 shrink-0 text-right text-xs text-[var(--color-muted)]">
                          {r.id ? `${sets} set${sets === 1 ? "" : "s"}` : "New"}
                        </span>
                      </div>
                    </li>
                  );
                })}
              </ol>
            )}
            <button type="button" onClick={add} className={`${secondary} py-1.5`}>
              Add a product line
            </button>
          </div>

          <div className="shrink-0 space-y-2 border-t border-[var(--color-edge)] px-5 py-4 sm:px-6">
            {removing.length > 0 && (
              <p role="status" className="text-xs text-[var(--color-muted)]">
                Removing {removing.map((line) => `“${line.name}”`).join(", ")}
                {orphaned > 0 &&
                  ` — ${removing.length === 1 ? "its" : "their"} ${orphaned} set${orphaned === 1 ? "" : "s"} will show under “Other”`}
                .
              </p>
            )}
            {error && (
              <p role="alert" className="text-sm text-[var(--color-warn)]">
                {error}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => dialog.current?.close()} className={secondary}>
                Cancel
              </button>
              <button type="submit" disabled={saving} className={primary}>
                {saving ? "Saving…" : "Save"}
              </button>
            </div>
          </div>
        </form>
      </dialog>
    </>
  );
}

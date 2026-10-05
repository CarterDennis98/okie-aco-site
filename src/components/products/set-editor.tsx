"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import type { CatalogProduct } from "@/db/queries/products";
import { money } from "@/lib/money";
import { deleteDropSet, saveDropSet } from "@/lib/products/admin-actions";
import {
  PRODUCT_NAME_LIMIT,
  SET_NAME_LIMIT,
  parsePastedLinks,
  parseProductInput,
  parseSetName,
  targetSku,
} from "@/lib/products/product-input";
import { bySetOrder } from "@/lib/products/sets";
import { useReorder } from "@/components/products/use-reorder";

/**
 * One set, all at once: "Add products" and each set's "Edit set". A native <dialog>, like
 * the single-product editor.
 *
 *   - ADD: paste any number of Target links -- a list, a drop announcement -- and each comes
 *     in as a row with the SKU and a name read from its link, and a price if one was beside
 *     it. Fill in what's missing, or leave it.
 *   - ARRANGE: the set's products in the order members will see them, new ones included.
 *     Drag a row by its handle, or use its arrows.
 *   - RENAME and DELETE, when editing a set that exists: the name field renames it, and
 *     "Delete set" takes every product in it, retired ones too, and the picks members made.
 *
 * Opened to add, the set field picks the set: an existing set's products are listed, so new
 * ones can go in among them; a new name starts a new set.
 *
 * Nothing is saved until Save, and then all of it in one go -- or none of it, with what was
 * wrong. Each row is checked here as it's typed, and again by the action, which is the
 * check that holds.
 */

type NewFields = { url: string; sku: string; name: string; price: string; imageUrl: string };
type Row =
  | { key: string; kind: "listed"; product: CatalogProduct }
  | { key: string; kind: "new"; fields: NewFields };

let nextKey = 0;
const newKey = () => `new-${(nextKey += 1)}`;

/** Two clicks to delete, as with "Confirm all": the first arms, the second within 6 s acts. */
const ARMED_MS = 6000;
/** A second click this soon after the first is a double-click, not a decision. */
const DOUBLE_CLICK_MS = 400;

const field =
  "w-full rounded-lg border border-[var(--color-edge)] bg-[var(--color-ink)] px-2.5 py-1.5 text-base sm:text-sm text-[var(--color-fg)] placeholder:text-[var(--color-muted)]/60 focus:border-[var(--color-brand)] focus:outline-none";
const label = "mb-1 block text-xs font-medium text-[var(--color-muted)]";
const primary =
  "rounded-lg bg-[var(--color-brand)] px-4 py-2 text-sm font-semibold text-[var(--color-on-brand)] transition-colors hover:bg-[var(--color-brand-dark)] disabled:opacity-60";
const secondary =
  "rounded-lg border border-[var(--color-edge)] px-4 py-2 text-sm font-medium text-[var(--color-fg)] transition-colors hover:border-[var(--color-brand)]/50 disabled:opacity-60";
const iconButton =
  "inline-flex size-11 items-center justify-center rounded-lg text-sm text-[var(--color-muted)] transition-colors hover:text-[var(--color-fg)] disabled:opacity-30 sm:size-7";

/** Rows are checked before the set has a name; the name is checked on its own, at Save. */
const ANY_SET = "set";

/** A row's SKU as Save would read it: the product's, or a new row's typed or from its link. */
const skuOf = (row: Row) =>
  row.kind === "listed"
    ? row.product.sku
    : row.fields.sku.trim() || targetSku(row.fields.url) || "";

function Thumb({ src }: { src: string | null }) {
  if (!src || !src.startsWith("https://")) {
    return <span aria-hidden className="size-10 shrink-0 rounded-md bg-[var(--color-elevated)]" />;
  }
  return (
    // A plain <img>, as on the page: see ProductEditor for why not next/image.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt=""
      referrerPolicy="no-referrer"
      className="size-10 shrink-0 rounded-md bg-white object-contain p-0.5"
    />
  );
}

export function SetEditor({
  setName,
  products,
  retired,
  sets,
}: {
  /** The set to edit. Absent for "Add products". */
  setName?: string;
  /** Every live product: the set's own, and every SKU a new one mustn't repeat. */
  products: CatalogProduct[];
  /** Retired ones: SKUs a new one mustn't repeat either, and part of a set being deleted. */
  retired: CatalogProduct[];
  /** Set names already in use, offered as suggestions. */
  sets: string[];
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const editing = setName !== undefined;
  const id = editing ? `set-${encodeURIComponent(setName)}` : "set-new";
  const [name, setNameField] = useState(setName ?? "");
  const [rows, setRows] = useState<Row[]>([]);
  const [paste, setPaste] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, startSaving] = useTransition();
  const {
    move,
    handle,
    row: dragRow,
    dragging,
    over,
  } = useReorder(
    setRows,
    rows.map((r) => r.key),
  );

  /** The live products of a set, in its order, as rows. */
  const listedIn = (set: string): Row[] => {
    const wanted = parseSetName(set);
    if (!wanted.ok) return [];
    return products
      .filter((p) => p.setName === wanted.value)
      .sort(bySetOrder)
      .map((product) => ({ key: product.id, kind: "listed" as const, product }));
  };

  function open() {
    setNameField(setName ?? "");
    setRows(editing ? listedIn(setName) : []);
    setPaste("");
    setNote(null);
    setError(null);
    dialog.current?.showModal();
  }

  /** When adding, the set field picks the set: its products come in, new rows stay put. */
  function changeName(value: string) {
    setNameField(value);
    if (!editing)
      setRows((current) => [...listedIn(value), ...current.filter((r) => r.kind === "new")]);
  }

  function addLinks() {
    const { products: found, skipped } = parsePastedLinks(paste);
    const inList = new Set(rows.map(skuOf).filter(Boolean));
    let repeats = 0;
    const fresh: Row[] = [];
    for (const product of found) {
      if (product.sku && inList.has(product.sku)) {
        repeats += 1;
        continue;
      }
      if (product.sku) inList.add(product.sku);
      fresh.push({ key: newKey(), kind: "new", fields: { ...product, imageUrl: "" } });
    }
    setRows((current) => [...current, ...fresh]);
    setPaste("");
    const said = [
      fresh.length > 0 && `${fresh.length} added at the end`,
      repeats > 0 && `${repeats} already on the list`,
      skipped.length > 0 &&
        `${skipped.length} line${skipped.length === 1 ? "" : "s"} with no Target link skipped (“${skipped[0].slice(0, 40)}${skipped[0].length > 40 ? "…" : ""}”${skipped.length > 1 ? ", …" : ""})`,
    ].filter(Boolean);
    setNote(said.length > 0 ? `${said.join("; ")}.` : "No Target links in that.");
  }

  function edit(key: string, patch: Partial<NewFields>) {
    setRows((current) =>
      current.map((row) =>
        row.key === key && row.kind === "new"
          ? { ...row, fields: { ...row.fields, ...patch } }
          : row,
      ),
    );
  }

  // Every SKU listed anywhere, for telling a new row it's a repeat before Save does.
  const known = useMemo(() => {
    const map = new Map<string, CatalogProduct>();
    for (const product of [...products, ...retired]) map.set(product.sku, product);
    return map;
  }, [products, retired]);

  // What's wrong with each new row, as the action would say it.
  const problems = useMemo(() => {
    const found = new Map<string, string>();
    const count = new Map<string, number>();
    for (const row of rows) {
      const sku = skuOf(row);
      if (sku) count.set(sku, (count.get(sku) ?? 0) + 1);
    }
    const here = new Set(rows.flatMap((r) => (r.kind === "listed" ? [r.product.id] : [])));
    for (const row of rows) {
      if (row.kind !== "new") continue;
      const checked = parseProductInput({ ...row.fields, setName: ANY_SET });
      if (!checked.ok) {
        found.set(row.key, checked.error);
        continue;
      }
      const sku = checked.value.sku;
      const elsewhere = known.get(sku);
      if (elsewhere && !here.has(elsewhere.id)) {
        found.set(
          row.key,
          `Already listed as “${elsewhere.name}” in “${elsewhere.setName}”${elsewhere.active ? "" : " (retired — restore it instead)"}.`,
        );
      } else if ((count.get(sku) ?? 0) > 1) {
        found.set(row.key, "This SKU is on the list twice.");
      }
    }
    return found;
  }, [rows, known]);

  const fresh = rows.filter((r) => r.kind === "new").length;
  const original = editing ? listedIn(setName).map((r) => r.key) : [];
  const changed =
    fresh > 0 ||
    (editing && name.trim().replace(/\s+/g, " ") !== setName) ||
    rows.map((r) => r.key).join() !== original.join();

  function save() {
    setError(null);
    const set = parseSetName(name);
    if (!set.ok) return setError(set.error);
    if (problems.size > 0) return setError("Fix the marked products first.");
    if (!editing && fresh === 0) return setError("Paste at least one product link.");
    if (!changed) return dialog.current?.close();
    startSaving(async () => {
      const result = await saveDropSet({
        setName: name,
        previousName: setName ?? null,
        items: rows.map((row) =>
          row.kind === "listed"
            ? { id: row.product.id }
            : {
                add: {
                  name: row.fields.name,
                  url: row.fields.url,
                  sku: row.fields.sku,
                  price: row.fields.price,
                  imageUrl: row.fields.imageUrl,
                },
              },
        ),
      }).catch(() => ({ ok: false as const, error: "That didn't save. Check your connection." }));
      if (!result.ok) return setError(result.error);
      dialog.current?.close();
    });
  }

  // Everything in the set, retired too: what "Delete set" deletes.
  const everything = editing
    ? [...products, ...retired].filter((p) => p.setName === setName).length
    : 0;

  return (
    <>
      {editing ? (
        <button
          type="button"
          onClick={open}
          className="inline-flex min-h-11 items-center rounded-lg px-2.5 text-xs font-medium text-[var(--color-muted)] transition-colors hover:text-[var(--color-fg)] sm:min-h-0 sm:py-1"
        >
          Edit set
        </button>
      ) : (
        <button type="button" onClick={open} className={primary}>
          Add products
        </button>
      )}

      {/* ONE scroll area: the middle. The heading and the Save/Cancel/Delete row stay put, so
          Save is in reach however many products are listed -- and the dialog itself never
          scrolls (`overflow-hidden`), which is what put a second scrollbar beside the first:
          an absolutely positioned status line in the footer escaped the form's scrolling and
          stretched the dialog. `open:flex` rather than `flex`, which would show it closed. */}
      <dialog
        ref={dialog}
        aria-labelledby={`${id}-title`}
        className="m-auto max-h-[calc(100dvh-2rem)] w-[min(46rem,calc(100vw-2rem))] overflow-hidden rounded-2xl border border-[var(--color-edge)] bg-[var(--color-surface)] p-0 text-[var(--color-fg)] backdrop:bg-black/60 open:flex open:flex-col"
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
              <h2 id={`${id}-title`} className="text-lg font-bold text-white">
                {editing ? "Edit set" : "Add products"}
              </h2>
              <p className="mt-1 text-xs text-[var(--color-muted)]">
                Members see a set&rsquo;s products in the order below. Exports watch every SKU
                listed.
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

          <div className="relative min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-5 sm:px-6">
            <div>
              <label htmlFor={`${id}-name`} className={label}>
                {editing ? "Set name" : "Set"}
              </label>
              <input
                id={`${id}-name`}
                value={name}
                onChange={(event) => changeName(event.currentTarget.value)}
                list={editing ? undefined : `${id}-sets`}
                maxLength={SET_NAME_LIMIT}
                placeholder="Mega Evolution — Phantasmal Flames"
                className={field}
              />
              {!editing && (
                <datalist id={`${id}-sets`}>
                  {sets.map((set) => (
                    <option key={set} value={set} />
                  ))}
                </datalist>
              )}
              <p className="mt-1 text-xs text-[var(--color-muted)]">
                {editing
                  ? "Changing the name renames the set, retired products included."
                  : rows.some((r) => r.kind === "listed")
                    ? "An existing set: new products go in among its own."
                    : "A new set, unless you pick one that's listed."}
              </p>
            </div>

            <div>
              <label htmlFor={`${id}-paste`} className={label}>
                Target links — as many as you like, one per line
              </label>
              <textarea
                id={`${id}-paste`}
                value={paste}
                onChange={(event) => setPaste(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
                    event.preventDefault();
                    addLinks();
                  }
                }}
                rows={3}
                placeholder={
                  "https://www.target.com/p/…/-/A-95082118  $49.99\nhttps://www.target.com/p/…/-/A-95093989"
                }
                className={`${field} font-mono text-xs sm:text-xs`}
              />
              <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
                <button
                  type="button"
                  onClick={addLinks}
                  disabled={!paste.trim()}
                  className={`${secondary} py-1.5`}
                >
                  Add to the list
                </button>
                <span className="text-xs text-[var(--color-muted)]">
                  A price beside a link is picked up too.
                </span>
              </div>
              {note && (
                <p role="status" className="mt-1.5 text-xs text-[var(--color-fg)]">
                  {note}
                </p>
              )}
            </div>

            <div>
              <p className={label}>
                {rows.length === 0
                  ? "Order on the page"
                  : `Order on the page — ${rows.length} product${rows.length === 1 ? "" : "s"}${fresh > 0 ? `, ${fresh} new` : ""}`}
              </p>
              {rows.length === 0 ? (
                <p className="rounded-lg border border-dashed border-[var(--color-edge)] px-3 py-4 text-center text-xs text-[var(--color-muted)]">
                  Paste links above and they&rsquo;ll appear here, ready to arrange.
                </p>
              ) : (
                <ol className="space-y-1.5">
                  {rows.map((row, index) => {
                    const problem = problems.get(row.key);
                    const title =
                      row.kind === "listed" ? row.product.name : row.fields.name || "New product";
                    return (
                      <li
                        key={row.key}
                        {...dragRow(row.key, index)}
                        className={
                          "rounded-lg border px-2 py-2 transition-colors " +
                          (over === row.key && dragging !== row.key
                            ? "border-[var(--color-brand)] bg-[var(--color-brand)]/5"
                            : problem
                              ? "border-[var(--color-warn)]/50"
                              : "border-[var(--color-edge)]") +
                          (dragging === row.key ? " opacity-50" : "")
                        }
                      >
                        <div className="flex items-center gap-2">
                          <span
                            {...handle(row.key)}
                            title="Drag to reorder"
                            aria-hidden
                            className="hidden cursor-grab touch-none px-1 text-[var(--color-muted)] select-none hover:text-[var(--color-fg)] sm:block"
                          >
                            ⠿
                          </span>
                          <span className="w-5 shrink-0 text-right text-xs text-[var(--color-muted)] tabular-nums">
                            {index + 1}
                          </span>
                          <Thumb
                            src={
                              row.kind === "listed"
                                ? row.product.imageUrl
                                : row.fields.imageUrl.trim()
                            }
                          />
                          {row.kind === "listed" ? (
                            <div className="min-w-0 flex-1">
                              <p className="truncate text-sm text-white">{row.product.name}</p>
                              <p className="text-xs text-[var(--color-muted)]">
                                SKU <span className="tabular-nums">{row.product.sku}</span>
                                {row.product.priceCents !== null &&
                                  ` · ${money(row.product.priceCents)}`}
                              </p>
                            </div>
                          ) : (
                            <div className="flex min-w-0 flex-1 items-center gap-2">
                              <span className="shrink-0 rounded bg-[var(--color-good)]/15 px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-[var(--color-good)] uppercase">
                                New
                              </span>
                              {/* The link it came from, to tell rows apart while the names are
                                still the slug's guesses. */}
                              <span className="truncate text-xs text-[var(--color-muted)]">
                                {row.fields.url.replace(/^https?:\/\/(www\.)?/, "")}
                              </span>
                            </div>
                          )}
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
                            {row.kind === "new" && (
                              <button
                                type="button"
                                onClick={() =>
                                  setRows((current) => current.filter((r) => r.key !== row.key))
                                }
                                aria-label={`Remove ${title} from the list`}
                                className={iconButton}
                              >
                                ✕
                              </button>
                            )}
                          </div>
                        </div>

                        {row.kind === "new" && (
                          <div className="mt-2 grid grid-cols-2 gap-2 sm:ml-[4.75rem] sm:grid-cols-[1fr_8rem_6.5rem]">
                            <input
                              aria-label={`Name of product ${index + 1}`}
                              value={row.fields.name}
                              onChange={(event) =>
                                edit(row.key, { name: event.currentTarget.value })
                              }
                              maxLength={PRODUCT_NAME_LIMIT}
                              placeholder="Name"
                              className={`${field} col-span-2 sm:col-span-1`}
                            />
                            <input
                              aria-label={`SKU of product ${index + 1}`}
                              value={row.fields.sku}
                              onChange={(event) =>
                                edit(row.key, { sku: event.currentTarget.value })
                              }
                              inputMode="numeric"
                              placeholder="SKU (TCIN)"
                              className={field}
                            />
                            <input
                              aria-label={`Price of product ${index + 1}`}
                              value={row.fields.price}
                              onChange={(event) =>
                                edit(row.key, { price: event.currentTarget.value })
                              }
                              inputMode="decimal"
                              placeholder="Price"
                              className={field}
                            />
                            <input
                              aria-label={`Image link of product ${index + 1}`}
                              value={row.fields.imageUrl}
                              onChange={(event) =>
                                edit(row.key, { imageUrl: event.currentTarget.value })
                              }
                              inputMode="url"
                              placeholder="Image link (optional)"
                              className={`${field} col-span-2 sm:col-span-3`}
                            />
                          </div>
                        )}
                        {problem && (
                          <p
                            role="alert"
                            className="mt-1.5 text-xs text-[var(--color-warn)] sm:ml-[4.75rem]"
                          >
                            {problem}
                          </p>
                        )}
                      </li>
                    );
                  })}
                </ol>
              )}
            </div>
          </div>

          <div className="relative shrink-0 space-y-2 border-t border-[var(--color-edge)] px-5 py-4 sm:px-6">
            {error && (
              <p role="alert" className="text-sm text-[var(--color-warn)]">
                {error}
              </p>
            )}
            <div className="flex flex-wrap items-center justify-between gap-2">
              {editing && everything > 0 ? (
                <DeleteSetButton
                  setName={setName}
                  count={everything}
                  onDeleted={() => dialog.current?.close()}
                />
              ) : (
                <span />
              )}
              <div className="flex gap-2">
                <button type="button" onClick={() => dialog.current?.close()} className={secondary}>
                  Cancel
                </button>
                <button type="submit" disabled={saving} className={primary}>
                  {saving ? "Saving…" : fresh > 0 ? `Save, adding ${fresh}` : "Save"}
                </button>
              </div>
            </div>
          </div>
        </form>
      </dialog>
    </>
  );
}

/**
 * "Delete set", then "Click again to delete": every product in the set, retired ones too,
 * and every member's pick of them. The count it shows is the count the action checks.
 */
function DeleteSetButton({
  setName,
  count,
  onDeleted,
}: {
  setName: string;
  count: number;
  onDeleted: () => void;
}) {
  const [armedAt, setArmedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    if (armedAt === null) return;
    const timer = setTimeout(() => setArmedAt(null), ARMED_MS);
    return () => clearTimeout(timer);
  }, [armedAt]);

  function click() {
    const now = Date.now();
    if (armedAt === null) {
      setError(null);
      setArmedAt(now);
      return;
    }
    if (now - armedAt < DOUBLE_CLICK_MS) return;
    setArmedAt(null);
    startTransition(async () => {
      const result = await deleteDropSet({ setName, expected: count }).catch(() => ({
        ok: false as const,
        error: "That didn't go through. Check your connection.",
      }));
      if (!result.ok) return setError(result.error);
      onDeleted();
    });
  }

  const armed = armedAt !== null;
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <button
        type="button"
        onClick={click}
        // Leaving the button disarms it: an armed button left behind is a trap for later.
        onBlur={() => setArmedAt(null)}
        disabled={pending}
        className={
          "inline-flex min-h-11 items-center rounded-lg border px-3 text-sm font-semibold transition-colors disabled:opacity-60 sm:min-h-0 sm:py-1.5 " +
          (armed
            ? "border-[var(--color-warn)] bg-[var(--color-warn)]/15 text-[var(--color-warn)]"
            : "border-[var(--color-edge)] text-[var(--color-muted)] hover:border-[var(--color-warn)]/60 hover:text-[var(--color-warn)]")
        }
      >
        {pending
          ? "Deleting…"
          : armed
            ? `Click again to delete ${count} product${count === 1 ? "" : "s"}`
            : "Delete set"}
      </button>
      <span role="status" className={armed ? "text-xs text-[var(--color-muted)]" : "sr-only"}>
        {armed ? "Members' picks of them go too. There's no undo." : ""}
      </span>
      {error && (
        <span role="alert" className="text-xs text-[var(--color-warn)]">
          {error}
        </span>
      )}
    </span>
  );
}

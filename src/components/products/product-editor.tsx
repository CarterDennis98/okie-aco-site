"use client";

import { useRef, useState, useTransition } from "react";
import type { CatalogProduct } from "@/db/queries/products";
import { updateDropProduct } from "@/lib/products/admin-actions";
import {
  PRODUCT_NAME_LIMIT,
  SET_NAME_LIMIT,
  nameFromTargetUrl,
  parseProductInput,
  targetSku,
  type ProductFields,
} from "@/lib/products/product-input";

/**
 * "Edit" on one product -- a native <dialog>, like "Issue a fee" and "ACO credit". Adding,
 * one product or many, is the set editor's (SetEditor).
 *
 * Correcting the link re-reads the SKU and name from it, unless they were typed by hand.
 * The set field offers the sets already listed, because two spellings of one set would split
 * it into two headings on the members' page; a product moved to another set goes to its end.
 *
 * Checked here for a fast answer and again by the action, which is the check that holds.
 */

const field =
  "w-full rounded-lg border border-[var(--color-edge)] bg-[var(--color-ink)] px-3 py-1.5 text-base sm:text-sm text-[var(--color-fg)] placeholder:text-[var(--color-muted)]/60 focus:border-[var(--color-brand)] focus:outline-none";
const label = "mb-1 block text-xs font-medium text-[var(--color-muted)]";
const primary =
  "rounded-lg bg-[var(--color-brand)] px-4 py-2 text-sm font-semibold text-[var(--color-on-brand)] transition-colors hover:bg-[var(--color-brand-dark)] disabled:opacity-60";
const secondary =
  "rounded-lg border border-[var(--color-edge)] px-4 py-2 text-sm font-medium text-[var(--color-fg)] transition-colors hover:border-[var(--color-brand)]/50 disabled:opacity-60";

function fieldsOf(product: CatalogProduct): ProductFields {
  return {
    setName: product.setName,
    name: product.name,
    url: product.url,
    sku: product.sku,
    price: product.priceCents === null ? "" : (product.priceCents / 100).toFixed(2),
    pasFee: product.pasFeeCents === null ? "" : (product.pasFeeCents / 100).toFixed(2),
    imageUrl: product.imageUrl ?? "",
  };
}

export function ProductEditor({
  product,
  sets,
}: {
  product: CatalogProduct;
  /** Set names already in use, offered as suggestions. */
  sets: string[];
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [fields, setFields] = useState<ProductFields>(() => fieldsOf(product));
  // Which fields follow the link as it's corrected. A saved product's SKU and name stay as
  // they are; one cleared by hand is filled from the link again.
  const [guessed, setGuessed] = useState({ sku: false, name: false });
  const [error, setError] = useState<string | null>(null);
  const [saving, startSaving] = useTransition();
  const id = product.id;

  function open() {
    setFields(fieldsOf(product));
    setGuessed({ sku: false, name: false });
    setError(null);
    dialog.current?.showModal();
  }

  function set<K extends keyof ProductFields>(key: K, value: string) {
    if (key === "sku" || key === "name") setGuessed((g) => ({ ...g, [key]: false }));
    setFields((current) => {
      const next = { ...current, [key]: value };
      if (key === "url") {
        if (guessed.sku || !current.sku) next.sku = targetSku(value) ?? "";
        if (guessed.name || !current.name) next.name = nameFromTargetUrl(value);
      }
      return next;
    });
  }

  function save() {
    const checked = parseProductInput(fields);
    if (!checked.ok) return setError(checked.error);
    const form = new FormData();
    form.set("id", product.id);
    for (const [key, value] of Object.entries(fields)) form.set(key, value);
    startSaving(async () => {
      const result = await updateDropProduct(form);
      if (!result.ok) return setError(result.error);
      dialog.current?.close();
    });
  }

  const preview = fields.imageUrl.trim().startsWith("https://") ? fields.imageUrl.trim() : null;

  return (
    <>
      <button
        type="button"
        onClick={open}
        className="inline-flex min-h-11 items-center rounded-lg px-2 text-xs font-medium text-[var(--color-muted)] transition-colors hover:text-[var(--color-fg)] sm:min-h-0 sm:py-1"
      >
        Edit
      </button>

      {/* The form scrolls and the dialog never does: two scroll containers nested is two
          scrollbars. See SetEditor. */}
      <dialog
        ref={dialog}
        aria-labelledby={`product-${id}-title`}
        className="m-auto max-h-[calc(100dvh-2rem)] w-[min(34rem,calc(100vw-2rem))] overflow-hidden rounded-2xl border border-[var(--color-edge)] bg-[var(--color-surface)] p-0 text-[var(--color-fg)] backdrop:bg-black/60 open:flex open:flex-col"
      >
        <form
          method="dialog"
          onSubmit={(event) => {
            event.preventDefault();
            save();
          }}
          className="relative min-h-0 flex-1 space-y-4 overflow-y-auto p-5 sm:p-6"
        >
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 id={`product-${id}-title`} className="text-lg font-bold text-white">
                Edit product
              </h2>
              <p className="mt-1 text-xs text-[var(--color-muted)]">
                Members see it under its set and choose whether to be run for it. Exports watch its
                SKU.
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

          <div>
            <label htmlFor={`product-${id}-url`} className={label}>
              Target link
            </label>
            <input
              id={`product-${id}-url`}
              value={fields.url}
              onChange={(event) => set("url", event.currentTarget.value)}
              placeholder="https://www.target.com/p/…/-/A-95082118"
              inputMode="url"
              autoComplete="off"
              className={field}
            />
          </div>

          <div className="grid gap-3 sm:grid-cols-[1fr_9rem]">
            <div>
              <label htmlFor={`product-${id}-set`} className={label}>
                Set
              </label>
              <input
                id={`product-${id}-set`}
                value={fields.setName}
                onChange={(event) => set("setName", event.currentTarget.value)}
                list={`product-${id}-sets`}
                maxLength={SET_NAME_LIMIT}
                placeholder="Mega Evolution — Phantasmal Flames"
                className={field}
              />
              <datalist id={`product-${id}-sets`}>
                {sets.map((name) => (
                  <option key={name} value={name} />
                ))}
              </datalist>
            </div>
            <div>
              <label htmlFor={`product-${id}-sku`} className={label}>
                SKU (TCIN)
              </label>
              <input
                id={`product-${id}-sku`}
                value={fields.sku}
                onChange={(event) => set("sku", event.currentTarget.value)}
                inputMode="numeric"
                placeholder="From the link"
                className={field}
              />
            </div>
          </div>

          <div>
            <label htmlFor={`product-${id}-name`} className={label}>
              Name
            </label>
            <input
              id={`product-${id}-name`}
              value={fields.name}
              onChange={(event) => set("name", event.currentTarget.value)}
              maxLength={PRODUCT_NAME_LIMIT}
              placeholder="From the link"
              className={field}
            />
          </div>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-[9rem_9rem]">
            <div>
              <label htmlFor={`product-${id}-price`} className={label}>
                Price <span className="font-normal">(retail)</span>
              </label>
              <input
                id={`product-${id}-price`}
                value={fields.price}
                onChange={(event) => set("price", event.currentTarget.value)}
                inputMode="decimal"
                placeholder="$49.99"
                className={field}
              />
            </div>
            <div>
              <label htmlFor={`product-${id}-pas`} className={label}>
                PAS fee <span className="font-normal">(per unit)</span>
              </label>
              <input
                id={`product-${id}-pas`}
                value={fields.pasFee}
                onChange={(event) => set("pasFee", event.currentTarget.value)}
                inputMode="decimal"
                placeholder="$5"
                className={field}
              />
            </div>
          </div>

          <div>
            <label htmlFor={`product-${id}-image`} className={label}>
              Image link
            </label>
            <input
              id={`product-${id}-image`}
              value={fields.imageUrl}
              onChange={(event) => set("imageUrl", event.currentTarget.value)}
              inputMode="url"
              placeholder="https://target.scene7.com/…"
              className={field}
            />
          </div>

          {preview && (
            <div className="flex items-center gap-3">
              {/* A plain <img>: the link is whatever host the operator pastes, and next/image
                  would need that host allowlisted -- an open pattern would turn the image
                  optimizer into a proxy for anything. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={preview}
                alt=""
                referrerPolicy="no-referrer"
                className="size-16 rounded-lg bg-white object-contain p-1"
              />
              <span className="text-xs text-[var(--color-muted)]">
                How it will look on the page.
              </span>
            </div>
          )}

          {error && (
            <p role="alert" className="text-sm text-[var(--color-warn)]">
              {error}
            </p>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <button type="button" onClick={() => dialog.current?.close()} className={secondary}>
              Cancel
            </button>
            <button type="submit" disabled={saving} className={primary}>
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </form>
      </dialog>
    </>
  );
}

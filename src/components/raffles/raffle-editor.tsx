"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import type { CatalogProduct } from "@/db/queries/products";
import { PRODUCT_NAME_LIMIT, nameFromTargetUrl, targetSku } from "@/lib/products/product-input";
import { matchesSearch, searchTerms } from "@/lib/products/sets";
import { createRaffle, deleteRaffle, updateRaffle } from "@/lib/raffles/admin-actions";
import type { RaffleView } from "@/lib/raffles/entries";
import { EMPTY_RAFFLE, parseRaffleInput, type RaffleFields } from "@/lib/raffles/raffle-input";

/**
 * "New raffle" and a raffle's "Edit" -- a native <dialog>, like the product editor.
 *
 * The product is picked from Target Products or pasted in as a link: picking one only fills
 * the fields in (link, SKU, name, price, picture), so a listed product can be raffled under a
 * shorter name, and one that isn't listed -- raffled products often aren't -- goes in the same
 * way. A link re-reads the SKU and name from itself, unless they were typed by hand.
 *
 * Times are Central, as Target posts them; see lib/raffles/time.ts.
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
const quiet =
  "inline-flex min-h-11 items-center rounded-lg px-2 text-xs font-medium text-[var(--color-muted)] transition-colors hover:text-[var(--color-fg)] sm:min-h-0 sm:py-1";

/** Matches shown under the search box, at most. */
const MATCHES = 6;

function fieldsOf(raffle: RaffleView | null): RaffleFields {
  if (!raffle) return { ...EMPTY_RAFFLE };
  return {
    url: raffle.url,
    sku: raffle.sku,
    name: raffle.name,
    price: raffle.priceCents === null ? "" : (raffle.priceCents / 100).toFixed(2),
    imageUrl: raffle.imageUrl ?? "",
    startsAt: raffle.startsInput,
    dueAt: raffle.dueInput,
  };
}

export function RaffleEditor({
  raffle,
  products,
}: {
  /** The raffle being edited; null for "New raffle". */
  raffle: RaffleView | null;
  /** The products on Target Products, to pick one from. */
  products: CatalogProduct[];
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [fields, setFields] = useState<RaffleFields>(() => fieldsOf(raffle));
  // Which fields follow the link as it's typed: a saved raffle's SKU and name stay as they
  // are, and one cleared by hand is filled from the link again.
  const [guessed, setGuessed] = useState({ sku: false, name: false });
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, startSaving] = useTransition();
  const id = raffle?.id ?? "new";
  const terms = useMemo(() => searchTerms(query), [query]);
  const matches = useMemo(
    () =>
      terms.length === 0 ? [] : products.filter((p) => matchesSearch(p, terms)).slice(0, MATCHES),
    [products, terms],
  );

  function open() {
    setFields(fieldsOf(raffle));
    setGuessed({ sku: !raffle, name: !raffle });
    setQuery("");
    setError(null);
    dialog.current?.showModal();
  }

  function set<K extends keyof RaffleFields>(key: K, value: string) {
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

  /** Fills the product's half of the form from a listed product. The times are left alone. */
  function pick(product: CatalogProduct) {
    setFields((current) => ({
      ...current,
      url: product.url,
      sku: product.sku,
      name: product.name,
      price: product.priceCents === null ? "" : (product.priceCents / 100).toFixed(2),
      imageUrl: product.imageUrl ?? "",
    }));
    setGuessed({ sku: false, name: false });
    setQuery("");
    setError(null);
  }

  function save() {
    const checked = parseRaffleInput(fields, { isNew: !raffle });
    if (!checked.ok) return setError(checked.error);
    startSaving(async () => {
      const result = await (
        raffle ? updateRaffle({ id: raffle.id, fields }) : createRaffle({ fields })
      ).catch(() => ({ ok: false as const, error: "That didn't save. Check your connection." }));
      if (!result.ok) return setError(result.error);
      dialog.current?.close();
    });
  }

  const preview = fields.imageUrl.trim().startsWith("https://") ? fields.imageUrl.trim() : null;

  return (
    <>
      {raffle ? (
        <button type="button" onClick={open} className={quiet}>
          Edit
        </button>
      ) : (
        <button
          type="button"
          onClick={open}
          className="inline-flex min-h-11 items-center rounded-lg border border-[var(--color-edge)] px-3 text-xs font-medium text-[var(--color-fg)] transition-colors hover:border-[var(--color-brand)]/50 sm:min-h-0 sm:py-1.5"
        >
          New raffle
        </button>
      )}

      {/* The form scrolls and the dialog never does: two scroll containers nested is two
          scrollbars. See SetEditor. */}
      <dialog
        ref={dialog}
        aria-labelledby={`raffle-${id}-title`}
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
              <h2 id={`raffle-${id}-title`} className="text-lg font-bold text-white">
                {raffle ? "Edit raffle" : "New raffle"}
              </h2>
              <p className="mt-1 text-xs text-[var(--color-muted)]">
                Members can enter as soon as it&rsquo;s saved, until entries are due. The Shikari
                export gives it a task group of its own.
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

          {products.length > 0 && (
            <div>
              <label htmlFor={`raffle-${id}-find`} className={label}>
                Pick a product from Target Products
              </label>
              <input
                id={`raffle-${id}-find`}
                type="search"
                value={query}
                onChange={(event) => setQuery(event.currentTarget.value)}
                placeholder="Search names, SKUs or sets"
                autoComplete="off"
                className={field}
              />
              {terms.length > 0 && (
                <ul className="mt-1.5 divide-y divide-[var(--color-edge)] overflow-hidden rounded-lg border border-[var(--color-edge)]">
                  {matches.length === 0 ? (
                    <li className="px-3 py-2 text-xs text-[var(--color-muted)]">
                      Nothing listed matches. Paste its link below instead.
                    </li>
                  ) : (
                    matches.map((product) => (
                      <li key={product.id}>
                        <button
                          type="button"
                          onClick={() => pick(product)}
                          className="flex min-h-11 w-full flex-col items-start px-3 py-1.5 text-left text-sm hover:bg-[var(--color-brand)]/10"
                        >
                          <span className="text-white">{product.name}</span>
                          <span className="text-xs text-[var(--color-muted)]">
                            {product.setName} · SKU {product.sku}
                          </span>
                        </button>
                      </li>
                    ))
                  )}
                </ul>
              )}
              <p className="mt-1 text-xs text-[var(--color-muted)]">
                Or, for one that isn&rsquo;t listed, paste its Target link below.
              </p>
            </div>
          )}

          <div>
            <label htmlFor={`raffle-${id}-url`} className={label}>
              Target link
            </label>
            <input
              id={`raffle-${id}-url`}
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
              <label htmlFor={`raffle-${id}-name`} className={label}>
                Name
              </label>
              <input
                id={`raffle-${id}-name`}
                value={fields.name}
                onChange={(event) => set("name", event.currentTarget.value)}
                maxLength={PRODUCT_NAME_LIMIT}
                placeholder="From the link"
                className={field}
              />
            </div>
            <div>
              <label htmlFor={`raffle-${id}-sku`} className={label}>
                SKU (TCIN)
              </label>
              <input
                id={`raffle-${id}-sku`}
                value={fields.sku}
                onChange={(event) => set("sku", event.currentTarget.value)}
                inputMode="numeric"
                placeholder="From the link"
                className={field}
              />
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-[9rem_1fr]">
            <div>
              <label htmlFor={`raffle-${id}-price`} className={label}>
                Price <span className="font-normal">(retail)</span>
              </label>
              <input
                id={`raffle-${id}-price`}
                value={fields.price}
                onChange={(event) => set("price", event.currentTarget.value)}
                inputMode="decimal"
                placeholder="$49.99"
                className={field}
              />
            </div>
            <div>
              <label htmlFor={`raffle-${id}-image`} className={label}>
                Image link
              </label>
              <input
                id={`raffle-${id}-image`}
                value={fields.imageUrl}
                onChange={(event) => set("imageUrl", event.currentTarget.value)}
                inputMode="url"
                placeholder="https://target.scene7.com/…"
                className={field}
              />
            </div>
          </div>

          {preview && (
            <div className="flex items-center gap-3">
              {/* A plain <img>, as in the product editor: the host is whatever is pasted. */}
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

          <div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label htmlFor={`raffle-${id}-starts`} className={label}>
                  Raffle starts
                </label>
                <input
                  id={`raffle-${id}-starts`}
                  type="datetime-local"
                  value={fields.startsAt}
                  onChange={(event) => set("startsAt", event.currentTarget.value)}
                  aria-describedby={`raffle-${id}-zone`}
                  className={field}
                />
              </div>
              <div>
                <label htmlFor={`raffle-${id}-due`} className={label}>
                  Entries due
                </label>
                <input
                  id={`raffle-${id}-due`}
                  type="datetime-local"
                  value={fields.dueAt}
                  onChange={(event) => set("dueAt", event.currentTarget.value)}
                  aria-describedby={`raffle-${id}-zone`}
                  className={field}
                />
              </div>
            </div>
            <p id={`raffle-${id}-zone`} className="mt-1 text-xs text-[var(--color-muted)]">
              Central time, as Target posts them. Members can enter before it starts, but not once
              entries are due.
            </p>
          </div>

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
              {saving ? "Saving…" : raffle ? "Save" : "List raffle"}
            </button>
          </div>
        </form>
      </dialog>
    </>
  );
}

/** How long "Click again" stays armed, and how soon a second click counts as one. */
const ARMED_MS = 6000;
const DOUBLE_CLICK_MS = 400;

/**
 * "Delete", then "Click again to delete": the raffle and every member's entry in it. The count
 * it shows is the count the action checks, so nobody's entry made since is deleted unseen.
 */
export function DeleteRaffleButton({ raffleId, entries }: { raffleId: string; entries: number }) {
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
      const result = await deleteRaffle({ id: raffleId, entries }).catch(() => ({
        ok: false as const,
        error: "That didn't go through. Check your connection.",
      }));
      if (!result.ok) setError(result.error);
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
          "inline-flex min-h-11 items-center rounded-lg px-2 text-xs font-medium transition-colors disabled:opacity-60 sm:min-h-0 sm:py-1 " +
          (armed
            ? "bg-[var(--color-warn)]/15 text-[var(--color-warn)]"
            : "text-[var(--color-muted)] hover:text-[var(--color-warn)]")
        }
      >
        {pending
          ? "Deleting…"
          : armed
            ? entries > 0
              ? `Click again to delete it and ${entries} entr${entries === 1 ? "y" : "ies"}`
              : "Click again to delete"
            : "Delete"}
      </button>
      <span role="status" className={armed ? "text-xs text-[var(--color-muted)]" : "sr-only"}>
        {armed ? "Its Shikari group comes out at the next export. There's no undo." : ""}
      </span>
      {error && (
        <span role="alert" className="text-xs text-[var(--color-warn)]">
          {error}
        </span>
      )}
    </span>
  );
}

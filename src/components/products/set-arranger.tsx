"use client";

import { useRef, useState, useTransition } from "react";
import { saveSetOrder } from "@/lib/products/admin-actions";
import { useReorder } from "@/components/products/use-reorder";

/**
 * "Arrange sets": the sets in the order members see them, to drag by the handle or move with
 * the arrows, and saved together. A native <dialog>, built like the set editor: the list
 * scrolls, the heading and the buttons stay put.
 */

const primary =
  "rounded-lg bg-[var(--color-brand)] px-4 py-2 text-sm font-semibold text-[var(--color-on-brand)] transition-colors hover:bg-[var(--color-brand-dark)] disabled:opacity-60";
const secondary =
  "rounded-lg border border-[var(--color-edge)] px-4 py-2 text-sm font-medium text-[var(--color-fg)] transition-colors hover:border-[var(--color-brand)]/50 disabled:opacity-60";
const iconButton =
  "inline-flex size-11 items-center justify-center rounded-lg text-sm text-[var(--color-muted)] transition-colors hover:text-[var(--color-fg)] disabled:opacity-30 sm:size-7";

export function SetArranger({ sets }: { sets: { name: string; products: number }[] }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [order, setOrder] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, startSaving] = useTransition();
  const { move, handle, row, dragging, over } = useReorder(setOrder, order);
  const counts = new Map(sets.map((set) => [set.name, set.products]));
  const shown = sets.map((set) => set.name);

  function open() {
    setOrder(shown);
    setError(null);
    dialog.current?.showModal();
  }

  function save() {
    setError(null);
    if (order.join("\n") === shown.join("\n")) return dialog.current?.close();
    startSaving(async () => {
      const result = await saveSetOrder({ names: order }).catch(() => ({
        ok: false as const,
        error: "That didn't save. Check your connection.",
      }));
      if (!result.ok) return setError(result.error);
      dialog.current?.close();
    });
  }

  return (
    <>
      <button type="button" onClick={open} className={secondary}>
        Arrange sets
      </button>

      <dialog
        ref={dialog}
        aria-labelledby="arrange-sets-title"
        className="m-auto max-h-[calc(100dvh-2rem)] w-[min(32rem,calc(100vw-2rem))] overflow-hidden rounded-2xl border border-[var(--color-edge)] bg-[var(--color-surface)] p-0 text-[var(--color-fg)] backdrop:bg-black/60 open:flex open:flex-col"
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
              <h2 id="arrange-sets-title" className="text-lg font-bold text-white">
                Arrange sets
              </h2>
              <p className="mt-1 text-xs text-[var(--color-muted)]">
                Members see the sets in this order. A set added later shows at the top until
                it&rsquo;s placed.
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

          <ol className="relative min-h-0 flex-1 space-y-1.5 overflow-y-auto px-5 py-4 sm:px-6">
            {order.map((name, index) => {
              const products = counts.get(name) ?? 0;
              return (
                <li
                  key={name}
                  {...row(name, index)}
                  className={
                    "flex items-center gap-2 rounded-lg border px-2 py-2 transition-colors " +
                    (over === name && dragging !== name
                      ? "border-[var(--color-brand)] bg-[var(--color-brand)]/5"
                      : "border-[var(--color-edge)]") +
                    (dragging === name ? " opacity-50" : "")
                  }
                >
                  <span
                    {...handle(name)}
                    title="Drag to reorder"
                    aria-hidden
                    className="hidden cursor-grab touch-none px-1 text-[var(--color-muted)] select-none hover:text-[var(--color-fg)] sm:block"
                  >
                    ⠿
                  </span>
                  <span className="w-5 shrink-0 text-right text-xs text-[var(--color-muted)] tabular-nums">
                    {index + 1}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-white">{name}</span>
                    <span className="text-xs text-[var(--color-muted)]">
                      {products} product{products === 1 ? "" : "s"}
                    </span>
                  </span>
                  <span className="flex shrink-0 items-center">
                    <button
                      type="button"
                      onClick={() => move(index, index - 1)}
                      disabled={index === 0}
                      aria-label={`Move ${name} up`}
                      className={iconButton}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      onClick={() => move(index, index + 1)}
                      disabled={index === order.length - 1}
                      aria-label={`Move ${name} down`}
                      className={iconButton}
                    >
                      ↓
                    </button>
                  </span>
                </li>
              );
            })}
          </ol>

          <div className="shrink-0 space-y-2 border-t border-[var(--color-edge)] px-5 py-4 sm:px-6">
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

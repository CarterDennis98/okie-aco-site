"use client";

import { useId, useRef, useState, useTransition } from "react";
import type { VaultProfileSummary } from "@/db/queries/vault";
import { siteStyle } from "@/lib/sites";
import { reorderProfiles } from "@/lib/vault/actions";
import { useReorder } from "@/components/products/use-reorder";

/**
 * "Reorder": one retailer's profiles, to drag by the handle or move with the arrows, saved
 * together. Built like the set arranger: a native <dialog> whose list scrolls while the
 * heading and the buttons stay put.
 *
 * Saving RENUMBERS. Names are how order is stored -- every list sorts by name and the main
 * bot runs the first few -- so each row shows the name its position will take, and the
 * profiles that change name are the ones the runner has to reload. See reorderProfiles.
 *
 * A dialog rather than dragging the list itself, so a member can make several moves and
 * check the names before anything is written. Each save renames profiles and puts them back
 * in the runner's queue, and doing that on every drop would mean a rename and a
 * notification for every step of an arrangement.
 */

const primary =
  "rounded-lg bg-[var(--color-brand)] px-4 py-2 text-sm font-semibold text-[var(--color-on-brand)] transition-colors hover:bg-[var(--color-brand-dark)] disabled:opacity-60";
const secondary =
  "rounded-lg border border-[var(--color-edge)] px-4 py-2 text-sm font-medium text-[var(--color-fg)] transition-colors hover:border-[var(--color-brand)]/50 disabled:opacity-60";
const iconButton =
  "inline-flex size-11 items-center justify-center rounded-lg text-sm text-[var(--color-muted)] transition-colors hover:text-[var(--color-fg)] disabled:opacity-30 sm:size-7";

export function ProfileArranger({
  siteKey,
  profiles,
  renumbered,
}: {
  siteKey: string;
  /** In the order the list shows them, which is name order. */
  profiles: VaultProfileSummary[];
  /** The name each position takes. See getProfileNaming. */
  renumbered: string[];
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [order, setOrder] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, startSaving] = useTransition();
  const { move, handle, row, dragging, over } = useReorder(setOrder, order);
  const style = siteStyle(siteKey);
  const cap = style.profileSoftCap;
  const byId = new Map(profiles.map((profile) => [profile.id, profile]));

  /** The name a position takes. Falls back to the current one if the preview is short. */
  const nameAt = (index: number, profile: VaultProfileSummary) => renumbered[index] ?? profile.name;
  const renaming = order.filter((id, index) => {
    const profile = byId.get(id);
    return profile && nameAt(index, profile) !== profile.name;
  }).length;

  // Where the main bot's share ends: after the cap-th ENABLED profile, by the same rule as
  // the list's "Backup bot" chips. Null when everything enabled fits on the main bot.
  let lastOnMain: string | null = null;
  if (cap !== undefined) {
    const enabled = order.filter((id) => byId.get(id)?.active);
    if (enabled.length > cap) lastOnMain = enabled[cap - 1];
  }

  function open() {
    setOrder(profiles.map((profile) => profile.id));
    setError(null);
    dialog.current?.showModal();
  }

  function save() {
    setError(null);
    if (renaming === 0) return dialog.current?.close();
    startSaving(async () => {
      const result = await reorderProfiles({ siteKey, order }).catch(() => ({
        ok: false as const,
        error: "That didn't save. Check your connection.",
      }));
      if (!result.ok) return setError(result.error);
      dialog.current?.close();
    });
  }

  return (
    <>
      <button
        type="button"
        onClick={open}
        className="inline-flex min-h-11 items-center rounded-lg border border-[var(--color-edge)] px-3 py-1.5 text-sm font-medium text-[var(--color-fg)] transition-colors hover:border-[var(--color-brand)]/50 sm:min-h-0"
      >
        Reorder
      </button>

      <dialog
        ref={dialog}
        aria-labelledby={titleId}
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
              <h2 id={titleId} className="text-lg font-bold text-white">
                Reorder {style.label} profiles
              </h2>
              <p className="mt-1 text-xs text-[var(--color-muted)]">
                {/* The handle is hidden on touch, where native dragging doesn't work. */}
                <span className="sm:hidden">Move a profile with its arrows.</span>
                <span className="hidden sm:inline">
                  Drag a profile by its handle, or use the arrows.
                </span>{" "}
                Saving renumbers the names to match the order
                {cap !== undefined && `, and the first ${cap} enabled run on the main bot`}.
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
            {order.map((id, index) => {
              const profile = byId.get(id);
              if (!profile) return null;
              const name = nameAt(index, profile);
              return [
                <li
                  key={id}
                  {...row(id, index)}
                  className={
                    "flex items-center gap-2 rounded-lg border px-2 py-2 transition-colors " +
                    (over === id && dragging !== id
                      ? "border-[var(--color-brand)] bg-[var(--color-brand)]/5"
                      : "border-[var(--color-edge)]") +
                    (dragging === id ? " opacity-50" : "")
                  }
                >
                  <span
                    {...handle(id)}
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
                    <span className="flex flex-wrap items-baseline gap-x-2">
                      <span
                        className={
                          "truncate text-sm font-medium " +
                          (profile.active ? "text-white" : "text-[var(--color-muted)]")
                        }
                      >
                        {name}
                      </span>
                      {name !== profile.name && (
                        <span className="text-[11px] text-[var(--color-warn)]">
                          was {profile.name}
                        </span>
                      )}
                      {!profile.active && (
                        <span className="text-[10px] tracking-wide text-[var(--color-muted)] uppercase">
                          Disabled
                        </span>
                      )}
                    </span>
                    {/* The card and the city are what tell two profiles apart -- the name is
                        only a number, and it's the number that's changing. */}
                    <span className="block truncate text-xs text-[var(--color-muted)]">
                      {profile.cardLabel} · {profile.shipCity}, {profile.shipState} ·{" "}
                      {profile.email}
                    </span>
                  </span>
                  <span className="flex shrink-0 items-center">
                    <button
                      type="button"
                      onClick={() => move(index, index - 1)}
                      disabled={index === 0}
                      aria-label={`Move ${profile.name} up`}
                      className={iconButton}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      onClick={() => move(index, index + 1)}
                      disabled={index === order.length - 1}
                      aria-label={`Move ${profile.name} down`}
                      className={iconButton}
                    >
                      ↓
                    </button>
                  </span>
                </li>,
                id === lastOnMain && (
                  <li
                    key={`${id}-cap`}
                    role="separator"
                    className="flex items-center gap-2 py-1 text-[10px] tracking-wide text-[var(--color-muted)] uppercase"
                  >
                    <span aria-hidden className="h-px flex-1 bg-[var(--color-edge)]" />
                    Main bot above · backup below
                    <span aria-hidden className="h-px flex-1 bg-[var(--color-edge)]" />
                  </li>
                ),
              ];
            })}
          </ol>

          <div className="shrink-0 space-y-2 border-t border-[var(--color-edge)] px-5 py-4 sm:px-6">
            {error && (
              <p role="alert" className="text-sm text-[var(--color-warn)]">
                {error}
              </p>
            )}
            <div className="flex flex-wrap items-center justify-end gap-2">
              {/* Said before the click, because a rename reaches the bot only once the runner
                  reloads it -- the same pending state an edit puts a profile in. */}
              <p className="mr-auto text-xs text-[var(--color-muted)]">
                {renaming === 0
                  ? "No names change in this order."
                  : `${renaming} profile${renaming === 1 ? "" : "s"} will be renamed and show as pending until the bot is updated.`}
              </p>
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

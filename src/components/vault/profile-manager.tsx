"use client";

import { useActionState, useState } from "react";
import Image from "next/image";
import type { VaultProfileDetail, VaultProfileSummary } from "@/db/queries/vault";
import { siteStyle } from "@/lib/sites";
import {
  deleteProfiles,
  loadProfileForEdit,
  revealOwnAppPassword,
  setProfileActive,
  type ActionResult,
} from "@/lib/vault/actions";
import { ProfileForm } from "@/components/vault/profile-form";
import { RevealAppPassword } from "@/components/vault/reveal-app-password";

/**
 * One retailer's profiles, with add / edit / enable / remove.
 *
 * The edit form fetches the full profile on demand rather than the page shipping every
 * field for every profile up front -- a member with 90 profiles would otherwise send a
 * large payload of addresses to the browser to render a list that shows five columns.
 */

function Toggle({ profile }: { profile: VaultProfileSummary }) {
  // useActionState rather than a bare form action: these return an ActionResult, and a
  // failure ("profile not found" after it was removed in another tab) should say so
  // rather than look like a click that did nothing.
  const [state, formAction, pending] = useActionState(
    async (_previous: ActionResult | null, formData: FormData) => setProfileActive(formData),
    null,
  );

  return (
    <form action={formAction} title={state && !state.ok ? state.error : undefined}>
      <input type="hidden" name="profileId" value={profile.id} />
      <input type="hidden" name="active" value={profile.active ? "false" : "true"} />
      <button
        type="submit"
        disabled={pending}
        aria-label={profile.active ? `Disable ${profile.name}` : `Enable ${profile.name}`}
        title={profile.active ? "Disable for this site" : "Enable for this site"}
        className={
          "relative h-5 w-9 shrink-0 rounded-full transition-colors disabled:opacity-50 " +
          (profile.active ? "bg-[var(--color-brand)]" : "bg-[var(--color-elevated)]")
        }
      >
        <span
          className={
            "absolute top-0.5 size-4 rounded-full bg-white transition-[left] " +
            (profile.active ? "left-[1.125rem]" : "left-0.5")
          }
        />
      </button>
    </form>
  );
}

/**
 * How many profile rows are visible before the list starts scrolling.
 *
 * Also clamped to a share of the viewport below, because a row count alone produced a
 * box taller than the screen -- you scrolled the page for two screens before the list's
 * own scrollbar even engaged, which defeats the point of capping it.
 */
const VISIBLE_ROWS = 10;
/**
 * Approximate rendered height of one row, in rem: two text lines, the reveal control,
 * and the row padding. Only ever sizes the scroll box, so being a little out shows 24
 * or 26 rows rather than breaking anything.
 */
const ROW_REM = 5.75;
/** Upper bound as a share of the window, so the scroll always starts on screen. */
const VIEWPORT_SHARE = "55vh";

function ProfileRow({
  profile,
  onEdit,
  onBackup,
  selected,
  onSelect,
}: {
  profile: VaultProfileSummary;
  onEdit: (id: string) => void;
  /** Sits past the retailer's soft cap, so it runs on the backup bot. */
  onBackup: boolean;
  selected: boolean;
  onSelect: (checked: boolean) => void;
}) {
  return (
    <li
      className={
        "flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3.5 sm:px-5 " +
        (selected ? "bg-[var(--color-brand)]/5" : "")
      }
    >
      {/* Both controls sit in one fixed-height box so the checkbox and the toggle share a
          centre line, rather than each centring inside its own differently-sized cell. */}
      <span className="flex h-5 shrink-0 items-center gap-3">
        <input
          type="checkbox"
          checked={selected}
          onChange={(e) => onSelect(e.currentTarget.checked)}
          aria-label={`Select ${profile.name}`}
          className="size-4 accent-[var(--color-brand)]"
        />
        <Toggle profile={profile} />
      </span>

      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-2 text-sm font-semibold text-white">
          <span className={profile.active ? "" : "text-[var(--color-muted)] line-through"}>
            {profile.name}
          </span>
          {profile.cardExpired && (
            <span className="inline-flex items-center rounded-full bg-[var(--color-brand)]/15 px-2 py-1 text-[10px] leading-none font-medium tracking-wide text-[var(--color-fg)] uppercase">
              Card expired
            </span>
          )}
          {onBackup && (
            <span
              title="Past the main bot's profile cap for this retailer — still runs, just on the backup"
              className="inline-flex items-center rounded-full bg-[var(--color-elevated)] px-2 py-1 text-[10px] leading-none font-medium tracking-wide text-[var(--color-muted)] uppercase"
            >
              Backup bot
            </span>
          )}
        </p>
        <p className="mt-1 truncate text-xs text-[var(--color-muted)]">
          {profile.email} · {profile.cardLabel} · exp {profile.cardExpMonth}/
          {profile.cardExpYear.slice(-2)} · {profile.shipCity}, {profile.shipState}
        </p>
        <RevealAppPassword
          email={profile.email}
          mailbox={profile.mailbox}
          usesEmailCodes={siteStyle(profile.siteKey).usesEmailCodes !== false}
          action={revealOwnAppPassword}
          compact
        />
      </div>

      {/* Removal is deliberately only via the checkbox + "Remove selected" above. One
          stray click next to a toggle used to delete a profile and its retailer login
          with a single confirm; making it a two-step selection is the point. */}
      <button
        type="button"
        onClick={() => onEdit(profile.id)}
        className="self-center text-xs font-medium text-[var(--color-fg)] transition-colors hover:text-white"
      >
        Edit
      </button>
    </li>
  );
}

/**
 * Select-all plus the bulk remove.
 *
 * Deliberately two clicks even when many rows are selected: removing forty profiles takes
 * their retailer logins with them and there is no undo, so the count is spelled out in
 * the confirmation rather than hidden behind a generic "Are you sure?".
 */
function BulkBar({
  profiles,
  selected,
  onToggleAll,
  onCleared,
}: {
  profiles: VaultProfileSummary[];
  selected: Set<string>;
  onToggleAll: (checked: boolean) => void;
  onCleared: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [state, formAction, pending] = useActionState(
    async (_previous: ActionResult | null, formData: FormData) => {
      const result = await deleteProfiles(formData);
      if (result.ok) {
        setConfirming(false);
        onCleared();
      }
      return result;
    },
    null,
  );

  const count = selected.size;
  const allSelected = count > 0 && count === profiles.length;

  return (
    <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-2 px-1">
      <label className="flex items-center gap-2 text-xs text-[var(--color-muted)]">
        <input
          type="checkbox"
          checked={allSelected}
          ref={(el) => {
            // Partial selection reads as neither on nor off.
            if (el) el.indeterminate = count > 0 && !allSelected;
          }}
          onChange={(e) => onToggleAll(e.currentTarget.checked)}
          className="size-4 accent-[var(--color-brand)]"
        />
        Select all
      </label>

      {count > 0 && <span className="text-xs text-[var(--color-fg)]">{count} selected</span>}

      {count > 0 &&
        (confirming ? (
          <form action={formAction} className="flex flex-wrap items-center gap-2">
            {[...selected].map((id) => (
              <input key={id} type="hidden" name="profileId" value={id} />
            ))}
            <span className="text-xs text-[var(--color-muted)]">
              {state && !state.ok
                ? state.error
                : `Delete ${count} profile${count === 1 ? "" : "s"} and their logins?`}
            </span>
            <button
              type="submit"
              disabled={pending}
              className="text-xs font-semibold text-[var(--color-brand)] disabled:opacity-60"
            >
              {pending ? "Removing…" : "Yes, remove"}
            </button>
            <button
              type="button"
              onClick={() => setConfirming(false)}
              className="text-xs text-[var(--color-muted)]"
            >
              Cancel
            </button>
          </form>
        ) : (
          <button
            type="button"
            onClick={() => setConfirming(true)}
            className="rounded-lg border border-[var(--color-edge)] px-2.5 py-1 text-xs font-medium text-[var(--color-fg)] transition-colors hover:border-[var(--color-brand)]/50 hover:text-[var(--color-brand)]"
          >
            Remove selected
          </button>
        ))}
    </div>
  );
}

export function ProfileManager({
  siteKey,
  siteLogo,
  profiles,
  nextName,
}: {
  siteKey: string;
  siteLogo: string | null;
  profiles: VaultProfileSummary[];
  nextName: string;
}) {
  const [editing, setEditing] = useState<VaultProfileDetail | null>(null);
  const [adding, setAdding] = useState(false);
  const [loading, setLoading] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const style = siteStyle(siteKey);
  const activeCount = profiles.filter((p) => p.active).length;

  // Soft cap: the first N ACTIVE profiles run on the main bot, the rest on a backup.
  // Disabled profiles aren't running, so they don't hold a slot -- which means toggling
  // one off promotes the next in line, and the badges move accordingly.
  const cap = style.profileSoftCap;
  const backupIds = new Set<string>();
  if (cap !== undefined) {
    let slot = 0;
    for (const profile of profiles) {
      if (!profile.active) continue;
      slot += 1;
      if (slot > cap) backupIds.add(profile.id);
    }
  }
  const onMain = cap === undefined ? activeCount : Math.min(activeCount, cap);

  async function onEdit(id: string) {
    setLoading(id);
    const detail = await loadProfileForEdit(id);
    setLoading(null);
    if (detail) {
      setEditing(detail);
      setAdding(false);
    }
  }

  return (
    <section className="mt-10">
      <header className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <span
            className="inline-flex items-center gap-1.5 rounded-full py-1 pr-2.5 pl-1 text-[11px] font-medium text-[var(--color-fg)]"
            style={{
              backgroundColor: `color-mix(in oklab, ${style.tint} 14%, transparent)`,
              boxShadow: `inset 0 0 0 1px color-mix(in oklab, ${style.tint} 35%, transparent)`,
            }}
          >
            {siteLogo && (
              <span className="grid h-4 w-5 shrink-0 place-items-center overflow-hidden rounded-[3px]">
                <Image
                  src={siteLogo}
                  alt=""
                  width={style.width}
                  height={style.height}
                  sizes="40px"
                  className="h-3.5 w-full object-contain"
                />
              </span>
            )}
            {style.label}
          </span>
          <span className="text-sm text-[var(--color-muted)]">
            {activeCount} of {profiles.length} active
            {cap !== undefined && (
              <>
                {" · "}
                {onMain}/{cap} on the main bot
                {backupIds.size > 0 && ` · ${backupIds.size} on backup`}
              </>
            )}
          </span>
        </div>

        <button
          type="button"
          onClick={() => {
            setAdding((v) => !v);
            setEditing(null);
          }}
          className="rounded-lg border border-[var(--color-edge)] px-3 py-1.5 text-sm font-medium text-[var(--color-fg)] transition-colors hover:border-[var(--color-brand)]/50"
        >
          {adding ? "Cancel" : "Add profile"}
        </button>
      </header>

      {adding && (
        <div className="mb-4 rounded-xl border border-[var(--color-edge)] bg-[var(--color-surface)] p-5">
          <ProfileForm siteKey={siteKey} nextName={nextName} onDone={() => setAdding(false)} />
        </div>
      )}

      {editing && (
        <div className="mb-4 rounded-xl border border-[var(--color-brand)]/40 bg-[var(--color-surface)] p-5">
          <p className="mb-4 text-sm font-semibold text-white">Editing {editing.name}</p>
          <ProfileForm siteKey={siteKey} profile={editing} onDone={() => setEditing(null)} />
        </div>
      )}

      {profiles.length === 0 ? (
        <p className="rounded-xl border border-[var(--color-edge)] bg-[var(--color-surface)] px-5 py-10 text-center text-sm text-[var(--color-muted)]">
          No profiles for {style.label} yet.
        </p>
      ) : (
        <>
          <BulkBar
            profiles={profiles}
            selected={selected}
            onToggleAll={(checked) =>
              setSelected(checked ? new Set(profiles.map((p) => p.id)) : new Set())
            }
            onCleared={() => setSelected(new Set())}
          />
          {/* Scrolls past VISIBLE_ROWS rather than running the page long: a member with
              700 Walmart profiles would otherwise make every section below this one
              unreachable. */}
          <ul
            className={
              "divide-y divide-[var(--color-edge)] rounded-xl border border-[var(--color-edge)] bg-[var(--color-surface)] " +
              (profiles.length > VISIBLE_ROWS
                ? "overflow-y-auto overscroll-contain"
                : "overflow-hidden")
            }
            style={
              profiles.length > VISIBLE_ROWS
                ? { maxHeight: `min(${VISIBLE_ROWS * ROW_REM}rem, ${VIEWPORT_SHARE})` }
                : undefined
            }
          >
            {profiles.map((profile) => (
              <ProfileRow
                key={profile.id}
                profile={
                  loading === profile.id ? { ...profile, name: `${profile.name}…` } : profile
                }
                onEdit={onEdit}
                onBackup={backupIds.has(profile.id)}
                selected={selected.has(profile.id)}
                onSelect={(checked) =>
                  setSelected((prev) => {
                    const next = new Set(prev);
                    if (checked) next.add(profile.id);
                    else next.delete(profile.id);
                    return next;
                  })
                }
              />
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

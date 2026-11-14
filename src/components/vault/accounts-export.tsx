"use client";

import { useMemo, useSyncExternalStore } from "react";
import {
  ACCOUNT_FORMAT_KEYS,
  DEFAULT_ACCOUNT_FORMAT,
  accountFormatLabel,
  isAccountFormat,
  type AccountFormat,
} from "@/lib/vault/account-format";

/**
 * The accounts export, with the line shape picked right beside it: `email:password`,
 * `email:::password` or `email;password`, whichever the bot loading the file reads. See
 * account-format.ts.
 *
 * REMEMBERED PER RETAILER, in this browser. A retailer's file goes onto the same bot every
 * time, so the shape picked once is the one wanted next time -- and every accounts link on
 * the page (the whole retailer, one member, the ticked members) reads the same choice, so
 * changing it beside one changes them all. Browser storage rather than the database: it is
 * a convenience for whoever is downloading, and a lost choice falls back to the shape every
 * file had before there was a choice.
 *
 * Nothing here decides what may be exported. The route checks who is asking, and refuses a
 * separator it doesn't know.
 */

const STORAGE_KEY = "okie:accounts:format";

const listeners = new Set<() => void>();
/** This page's copy of what storage holds: read once, then every change made here. */
let stored: string | null = null;

function snapshot(): string {
  if (stored === null) {
    try {
      stored = window.localStorage.getItem(STORAGE_KEY) ?? "{}";
    } catch {
      // Storage blocked (a private window, say): the choice still works, for this visit.
      stored = "{}";
    }
  }
  return stored;
}

function subscribe(listener: () => void) {
  // A choice made in another tab is picked up too.
  const fromStorage = (event: StorageEvent) => {
    if (event.key !== STORAGE_KEY) return;
    stored = null;
    listener();
  };
  listeners.add(listener);
  window.addEventListener("storage", fromStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", fromStorage);
  };
}

/** Site key -> format. Anything unreadable is dropped rather than trusted. */
function parse(raw: string): Record<string, AccountFormat> {
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(
      Object.entries(value).filter((entry): entry is [string, AccountFormat] =>
        isAccountFormat(entry[1]),
      ),
    );
  } catch {
    return {};
  }
}

function save(siteKey: string, format: AccountFormat) {
  stored = JSON.stringify({ ...parse(snapshot()), [siteKey]: format });
  try {
    window.localStorage.setItem(STORAGE_KEY, stored);
  } catch {
    // Kept for this visit only.
  }
  for (const listener of listeners) listener();
}

/**
 * The shape remembered for this retailer. Read through useSyncExternalStore so the server --
 * which can't see this browser's storage -- and the first render agree on the default, and
 * the remembered choice follows straight after.
 */
function useAccountFormat(siteKey: string): AccountFormat {
  const raw = useSyncExternalStore(subscribe, snapshot, () => "{}");
  return useMemo(() => {
    const remembered = parse(raw);
    return Object.hasOwn(remembered, siteKey) ? remembered[siteKey] : DEFAULT_ACCOUNT_FORMAT;
  }, [raw, siteKey]);
}

export function AccountsExport({
  href,
  siteKey,
  label,
  compact = false,
}: {
  /** The export URL, ending in `format=accounts`, with no `sep` -- this adds it. */
  href: string;
  siteKey: string;
  label: string;
  /** The bulk bar's smaller size. */
  compact?: boolean;
}) {
  const format = useAccountFormat(siteKey);
  // The default leaves the URL exactly as it was before there was a choice.
  const target = format === DEFAULT_ACCOUNT_FORMAT ? href : `${href}&sep=${format}`;

  return (
    <span
      className={
        "inline-flex items-stretch overflow-hidden rounded-lg border border-[var(--color-edge)] font-medium transition-colors focus-within:border-[var(--color-brand)]/50 hover:border-[var(--color-brand)]/50 " +
        (compact ? "bg-[var(--color-surface)] text-[11px]" : "text-sm")
      }
    >
      <a
        href={target}
        // Plain anchor with `download`, not a Link: this is a file, not a route transition.
        download
        className={
          "inline-flex items-center text-[var(--color-fg)] " +
          (compact ? "min-h-11 px-2.5 py-1 sm:min-h-0" : "px-3 py-1.5")
        }
      >
        {label}
      </a>
      <select
        aria-label={`${label}: line format`}
        title="What your bot splits each line on. Remembered for this retailer, in this browser."
        value={format}
        onChange={(event) => {
          const next = event.currentTarget.value;
          if (isAccountFormat(next)) save(siteKey, next);
        }}
        className={
          "border-l border-[var(--color-edge)] bg-[var(--color-ink)] font-mono text-[var(--color-muted)] focus:text-[var(--color-fg)] focus:outline-none " +
          (compact ? "px-1.5" : "px-2")
        }
      >
        {ACCOUNT_FORMAT_KEYS.map((key) => (
          <option key={key} value={key}>
            {accountFormatLabel(key)}
          </option>
        ))}
      </select>
    </span>
  );
}

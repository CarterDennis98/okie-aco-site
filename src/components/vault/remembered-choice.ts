import { useMemo, useSyncExternalStore } from "react";

/**
 * A choice remembered PER RETAILER, in this browser, and shared by every control on the page
 * that reads it: the accounts line shape (AccountsExport) and the profile file format
 * (ProfilesExport). A retailer's file goes onto the same bot every time, so the shape picked
 * once is the one wanted next time, and every link for that retailer follows the same choice.
 *
 * Browser storage rather than the database: it is a convenience for whoever is downloading,
 * and a lost choice falls back to the default -- the file every link gave before there was a
 * choice. Read through useSyncExternalStore so the server, which can't see this browser's
 * storage, and the first render agree on that default, and the remembered choice follows
 * straight after.
 *
 * One store per storage key, made once at module level by the component that owns it.
 */
export function rememberedPerSite<T extends string>(
  storageKey: string,
  isValid: (value: unknown) => value is T,
) {
  const listeners = new Set<() => void>();
  /** This page's copy of what storage holds: read once, then every change made here. */
  let stored: string | null = null;

  function snapshot(): string {
    if (stored === null) {
      try {
        stored = window.localStorage.getItem(storageKey) ?? "{}";
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
      if (event.key !== storageKey) return;
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

  /** Site key -> choice. Anything unreadable is dropped rather than trusted. */
  function parse(raw: string): Record<string, T> {
    try {
      const value: unknown = JSON.parse(raw);
      if (!value || typeof value !== "object" || Array.isArray(value)) return {};
      return Object.fromEntries(
        Object.entries(value).filter((entry): entry is [string, T] => isValid(entry[1])),
      );
    } catch {
      return {};
    }
  }

  function save(siteKey: string, choice: T) {
    stored = JSON.stringify({ ...parse(snapshot()), [siteKey]: choice });
    try {
      window.localStorage.setItem(storageKey, stored);
    } catch {
      // Kept for this visit only.
    }
    for (const listener of listeners) listener();
  }

  /** The choice remembered for this retailer, or `fallback` where there is none. */
  function useChoice(siteKey: string, fallback: T): T {
    const raw = useSyncExternalStore(subscribe, snapshot, () => "{}");
    return useMemo(() => {
      const remembered = parse(raw);
      return Object.hasOwn(remembered, siteKey) ? remembered[siteKey] : fallback;
    }, [raw, siteKey, fallback]);
  }

  return { useChoice, save };
}

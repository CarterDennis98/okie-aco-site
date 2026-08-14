"use client";

import { useEffect, useRef, useState, useTransition } from "react";

/**
 * Reveal-on-click for a stored app password.
 *
 * The vault is write-only by design, so this is a deliberate exception rather than a
 * component that happens to render a secret. Three properties make it one:
 *
 *   1. The value is NOT in the server-rendered HTML. It arrives only after a click, from
 *      an action that writes an audit row first. A screenshot, a view-source, or a
 *      shared screen shows nothing until someone asks for it.
 *   2. It hides itself again after HIDE_AFTER_MS. A password left on screen behind a
 *      switched tab is the realistic leak here, not an attacker.
 *   3. Re-revealing costs another audited round trip, so `vault_reveals` counts reads
 *      rather than page loads.
 *
 * The same component serves the member and the admin; only the action passed in differs,
 * and each action applies its own guard.
 */

const HIDE_AFTER_MS = 60_000;

type RevealResult = { ok: true; value: string; email: string } | { ok: false; error: string };

export function RevealAppPassword({
  email,
  mailbox,
  action,
  compact = false,
}: {
  /** The retailer account address this control sits next to. */
  email: string;
  /**
   * Where this address's verification codes land: itself, another inbox it forwards
   * into, or null when nothing covers it. The reveal returns the destination mailbox's
   * password either way -- that is the one that opens the inbox holding the code.
   */
  mailbox: string | null;
  action: (form: FormData) => Promise<RevealResult>;
  compact?: boolean;
}) {
  const [value, setValue] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [pending, startTransition] = useTransition();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Clear on unmount too: navigating away must not leave the value in a detached
  // component's state for the profiler or a React devtools session to find.
  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  useEffect(() => {
    if (value === null) return;
    timer.current = setTimeout(() => setValue(null), HIDE_AFTER_MS);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [value]);

  if (mailbox === null) {
    return (
      <span className="inline-flex items-center rounded-full bg-[var(--color-warn)]/15 px-2 py-1 text-[10px] leading-none font-medium tracking-wide text-[var(--color-warn)] uppercase">
        no app password
      </span>
    );
  }

  const forwarded = mailbox.toLowerCase() !== email.toLowerCase();

  function reveal() {
    setError(null);
    startTransition(async () => {
      const form = new FormData();
      form.set("email", email);
      const result = await action(form);
      if (result.ok) setValue(result.value);
      else setError(result.error);
    });
  }

  async function copy() {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard is permission-gated and blocked outright in some embedded views.
      // The value is on screen either way, so this is not worth an error state.
    }
  }

  if (value !== null) {
    return (
      <span
        className={
          compact ? "mt-1 flex flex-wrap items-center gap-1.5" : "flex flex-wrap items-center gap-2"
        }
      >
        {forwarded && <span className="text-[11px] text-[var(--color-muted)]">{mailbox}</span>}
        <code className="rounded bg-[var(--color-elevated)] px-2 py-1 font-mono text-xs break-all text-[var(--color-fg)] select-all">
          {value}
        </code>
        <button
          type="button"
          onClick={copy}
          className="rounded px-1.5 py-1 text-[11px] font-medium text-[var(--color-muted)] transition-colors hover:text-[var(--color-fg)]"
        >
          {copied ? "Copied" : "Copy"}
        </button>
        <button
          type="button"
          onClick={() => setValue(null)}
          className="rounded px-1.5 py-1 text-[11px] font-medium text-[var(--color-muted)] transition-colors hover:text-[var(--color-fg)]"
        >
          Hide
        </button>
      </span>
    );
  }

  return (
    <span
      className={
        compact ? "mt-1 flex flex-wrap items-center gap-2" : "flex flex-wrap items-center gap-2"
      }
    >
      {forwarded && (
        <span
          title={`Codes for this address arrive in ${mailbox}, which has the app password`}
          className="inline-flex items-center gap-1 rounded-full bg-[var(--color-elevated)] px-2 py-1 text-[10px] leading-none font-medium tracking-wide text-[var(--color-muted)] uppercase"
        >
          <span aria-hidden>↳</span> forwards to {mailbox}
        </span>
      )}
      <button
        type="button"
        onClick={reveal}
        disabled={pending}
        className="rounded-lg border border-[var(--color-edge)] px-2 py-1 text-[11px] font-medium text-[var(--color-muted)] transition-colors hover:border-[var(--color-brand)]/50 hover:text-[var(--color-fg)] disabled:opacity-50"
      >
        {pending ? "Revealing…" : forwarded ? "Show inbox password" : "Show app password"}
      </button>
      {error && <span className="text-[11px] text-[var(--color-warn)]">{error}</span>}
    </span>
  );
}

"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import type { AdminMemberEmails } from "@/db/queries/admin-vault";
import { siteStyle } from "@/lib/sites";
import {
  revealAllAppPasswordsForAdmin,
  revealAppPasswordForAdmin,
  type RevealAllResult,
} from "@/lib/vault/admin-actions";
import { RevealAppPassword } from "@/components/vault/reveal-app-password";

/**
 * Every mailbox one member holds an app password for.
 *
 * Sits under the profile table but is deliberately NOT site-scoped like it: one Gmail
 * routinely covers a member's Target, Walmart and Pokémon Center accounts at once, so
 * "what are this person's app passwords" is a question with no retailer in it. Finding
 * them by clicking through each retailer's profile rows showed a third of the answer.
 *
 * Same secret-handling rules as the per-profile reveal it reuses: no value is in the
 * server-rendered HTML, each read writes its own `vault_reveals` row, and everything
 * clears itself off screen after a minute.
 */

/** Matches RevealAppPassword. A password left on a switched tab is the realistic leak. */
const HIDE_AFTER_MS = 60_000;

function SiteChips({ siteKeys }: { siteKeys: string[] }) {
  return (
    <>
      {siteKeys.map((key) => (
        <span
          key={key}
          className="inline-flex items-center rounded-full bg-[var(--color-elevated)] px-1.5 py-0.5 text-[10px] leading-none font-medium text-[var(--color-muted)]"
        >
          {siteStyle(key).label}
        </span>
      ))}
    </>
  );
}

/**
 * Reveal every one of a member's passwords at once.
 *
 * The batch equivalent of the per-row control, and held to the same rules: the values
 * arrive only after a click, each one is audited separately server-side, and the whole
 * list hides itself on the same timer. Rendered as its own block rather than inline with
 * the rows, because six passwords on screen is a state worth being able to see and dismiss
 * as one thing.
 */
function RevealAll({ discordUserId, count }: { discordUserId: string; count: number }) {
  const [result, setResult] = useState<RevealAllResult | null>(null);
  const [pending, startTransition] = useTransition();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  useEffect(() => {
    if (result === null || !result.ok) return;
    timer.current = setTimeout(() => setResult(null), HIDE_AFTER_MS);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [result]);

  function revealAll() {
    startTransition(async () => {
      const form = new FormData();
      form.set("discordUserId", discordUserId);
      setResult(await revealAllAppPasswordsForAdmin(form));
    });
  }

  async function copyAll() {
    if (!result?.ok) return;
    // Tab-separated, one per line: pastes straight into a sheet, which is what this gets
    // used for when a member's codes have stopped arriving across several accounts.
    const text = result.revealed.map((r) => `${r.email}\t${r.value}`).join("\n");
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard is permission-gated. The values are on screen either way.
    }
  }

  if (result?.ok) {
    return (
      <div className="mt-3 rounded-xl border border-[var(--color-brand)]/40 bg-[var(--color-brand)]/5 p-4">
        <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <span className="text-xs font-semibold text-white">
            {result.revealed.length} app password{result.revealed.length === 1 ? "" : "s"}
          </span>
          <button
            type="button"
            onClick={copyAll}
            className="inline-flex min-h-11 items-center text-[11px] font-medium text-[var(--color-muted)] transition-colors hover:text-[var(--color-fg)] sm:min-h-0"
          >
            {copied ? "Copied" : "Copy all"}
          </button>
          <button
            type="button"
            onClick={() => setResult(null)}
            className="inline-flex min-h-11 items-center text-[11px] font-medium text-[var(--color-muted)] transition-colors hover:text-[var(--color-fg)] sm:min-h-0"
          >
            Hide
          </button>
          <span className="text-[11px] text-[var(--color-muted)]">Hides itself in a minute.</span>
        </div>
        <ul className="flex flex-col gap-1.5">
          {result.revealed.map((row) => (
            <li key={row.email} className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
              <span className="text-[var(--color-muted)]">{row.email}</span>
              <code className="max-w-full rounded bg-[var(--color-elevated)] px-2 py-1 font-mono text-xs break-all text-[var(--color-fg)] select-all">
                {row.value}
              </code>
            </li>
          ))}
        </ul>
        {result.failed.length > 0 && (
          // Named, not counted. A row whose envelope won't open needs the member to
          // re-enter that specific password, so which one it was is the whole message.
          <p className="mt-2 text-[11px] text-[var(--color-warn)]">
            Could not decrypt: {result.failed.join(", ")} — needs re-entering.
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5">
      <button
        type="button"
        onClick={revealAll}
        disabled={pending}
        className="inline-flex min-h-11 items-center rounded-lg border border-[var(--color-edge)] px-3 py-1.5 text-sm font-medium text-[var(--color-fg)] transition-colors hover:border-[var(--color-brand)]/50 disabled:opacity-60 sm:min-h-0"
      >
        {pending ? "Revealing…" : `Show all ${count} app password${count === 1 ? "" : "s"}`}
      </button>
      {result && !result.ok && (
        <span role="alert" className="text-[11px] text-[var(--color-warn)]">
          {result.error}
        </span>
      )}
      <p className="text-[11px] text-[var(--color-muted)]">
        Every read is logged against your name and theirs.
      </p>
    </div>
  );
}

export function AdminMemberEmailsPanel({
  discordUserId,
  username,
  emails,
}: {
  discordUserId: string;
  username: string;
  emails: AdminMemberEmails;
}) {
  const { mailboxes, uncovered } = emails;

  return (
    <section className="mt-8">
      <h2 className="mb-1 flex flex-wrap items-center gap-2 text-lg font-bold text-white">
        Email app passwords
        <span className="text-sm font-normal text-[var(--color-muted)]">
          all retailers · {mailboxes.length} mailbox{mailboxes.length === 1 ? "" : "es"}
        </span>
      </h2>
      <p className="mb-3 text-xs text-[var(--color-muted)]">
        Every inbox {username} has given us a password for, whichever retailer it serves.
      </p>

      {mailboxes.length === 0 ? (
        <p className="rounded-xl border border-[var(--color-edge)] bg-[var(--color-surface)] px-5 py-8 text-center text-sm text-[var(--color-muted)]">
          No app passwords on file.
        </p>
      ) : (
        <>
          <ul className="divide-y divide-[var(--color-edge)] overflow-hidden rounded-xl border border-[var(--color-edge)] bg-[var(--color-surface)]">
            {mailboxes.map((mailbox) => (
              <li key={mailbox.id} className="px-4 py-3 sm:px-5">
                <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm break-all text-white">{mailbox.email}</p>
                    <p className="mt-0.5 text-xs text-[var(--color-muted)]">
                      {mailbox.lastError
                        ? "Last check failed — needs re-entering"
                        : mailbox.verifiedAt
                          ? "Working"
                          : "Saved"}
                      {mailbox.aliases.length > 0 &&
                        ` · covers ${mailbox.aliases.length} forwarded address${
                          mailbox.aliases.length === 1 ? "" : "es"
                        }`}
                    </p>
                  </div>
                  {/* Passing the mailbox as its own address: this row IS the mailbox, so
                      there is no forwarding hop to describe. */}
                  <RevealAppPassword
                    email={mailbox.email}
                    mailbox={mailbox.email}
                    action={revealAppPasswordForAdmin}
                  />
                </div>

                {mailbox.covers.length > 0 && (
                  <ul className="mt-2 flex flex-col gap-1">
                    {mailbox.covers.map((account) => (
                      <li
                        key={account.email}
                        className="flex flex-wrap items-center gap-1.5 text-[11px] text-[var(--color-muted)]"
                      >
                        <span aria-hidden>↳</span>
                        <span className="break-all">{account.email}</span>
                        <SiteChips siteKeys={account.siteKeys} />
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>

          <RevealAll discordUserId={discordUserId} count={mailboxes.length} />
        </>
      )}

      {uncovered.length > 0 && (
        <div className="mt-4 rounded-xl border border-[var(--color-warn)]/40 bg-[var(--color-warn)]/5 p-4">
          <p className="text-xs text-[var(--color-fg)]">
            <span className="font-semibold text-[var(--color-warn)]">{uncovered.length}</span>{" "}
            retailer account{uncovered.length === 1 ? " has" : "s have"} nowhere to read a code
            from. Codes for {uncovered.length === 1 ? "it" : "these"} have to be chased by hand
            during a drop.
          </p>
          <ul className="mt-2 flex flex-col gap-1">
            {uncovered.map((account) => (
              <li
                key={account.email}
                className="flex flex-wrap items-center gap-1.5 text-[11px] text-[var(--color-muted)]"
              >
                <span className="break-all text-[var(--color-fg)]">{account.email}</span>
                <SiteChips siteKeys={account.siteKeys} />
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

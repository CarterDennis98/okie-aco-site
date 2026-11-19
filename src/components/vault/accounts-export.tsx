"use client";

import { rememberedPerSite } from "@/components/vault/remembered-choice";
import {
  ACCOUNT_FORMAT_KEYS,
  DEFAULT_ACCOUNT_FORMAT,
  accountFormatLabel,
  isAccountFormat,
} from "@/lib/vault/account-format";

/**
 * The accounts export, with the line shape picked right beside it: `email:password`,
 * `email:::password` or `email;password`, whichever the bot loading the file reads. See
 * account-format.ts.
 *
 * REMEMBERED PER RETAILER, in this browser, and read by every accounts link on the page (the
 * whole retailer, one member, the ticked members), so changing it beside one changes them all.
 * See remembered-choice.ts.
 *
 * Nothing here decides what may be exported. The route checks who is asking, and refuses a
 * separator it doesn't know.
 */

const { useChoice: useAccountFormat, save: saveAccountFormat } = rememberedPerSite(
  "okie:accounts:format",
  isAccountFormat,
);

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
  const format = useAccountFormat(siteKey, DEFAULT_ACCOUNT_FORMAT);
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
          if (isAccountFormat(next)) saveAccountFormat(siteKey, next);
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

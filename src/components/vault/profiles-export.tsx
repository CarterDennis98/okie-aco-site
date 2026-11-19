"use client";

import { rememberedPerSite } from "@/components/vault/remembered-choice";
import {
  DEFAULT_PROFILE_FORMAT,
  isProfileFormat,
  profileFormatLabel,
  siteProfileFormats,
} from "@/lib/vault/profile-format";

/**
 * A profile export with the file's format picked right beside it: AYCD's JSON, or Hidden AIO's
 * CSV on a retailer whose bot is Hidden -- Costco. See profile-format.ts.
 *
 * Only where a retailer offers more than one format; everywhere else the page keeps its plain
 * AYCD link. REMEMBERED PER RETAILER, in this browser, and read by every profile link on the
 * page (the whole retailer, one member, the ticked members), exactly as AccountsExport keeps
 * the accounts line shape. See remembered-choice.ts.
 *
 * Nothing here decides what may be exported. The route checks who is asking, and refuses a
 * format the retailer doesn't offer.
 */

const { useChoice: useProfileFormat, save: saveProfileFormat } = rememberedPerSite(
  "okie:profiles:format",
  isProfileFormat,
);

export function ProfilesExport({
  href,
  siteKey,
  label,
  compact = false,
}: {
  /** The profile export URL, with no `format` -- this adds it. */
  href: string;
  siteKey: string;
  label: string;
  /** The bulk bar's smaller size. */
  compact?: boolean;
}) {
  const formats = siteProfileFormats(siteKey);
  const remembered = useProfileFormat(siteKey, DEFAULT_PROFILE_FORMAT);
  // A choice remembered for a format this retailer no longer offers falls back to AYCD's.
  const format = formats.includes(remembered) ? remembered : DEFAULT_PROFILE_FORMAT;
  // AYCD's leaves the URL exactly as it was before there was a choice.
  const target = format === DEFAULT_PROFILE_FORMAT ? href : `${href}&format=${format}`;

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
        aria-label={`${label}: file format`}
        title="Which bot loads the file. Remembered for this retailer, in this browser."
        value={format}
        onChange={(event) => {
          const next = event.currentTarget.value;
          if (isProfileFormat(next)) saveProfileFormat(siteKey, next);
        }}
        className={
          "border-l border-[var(--color-edge)] bg-[var(--color-ink)] text-[var(--color-muted)] focus:text-[var(--color-fg)] focus:outline-none " +
          (compact ? "px-1.5" : "px-2")
        }
      >
        {formats.map((key) => (
          <option key={key} value={key}>
            {profileFormatLabel(key)}
          </option>
        ))}
      </select>
    </span>
  );
}

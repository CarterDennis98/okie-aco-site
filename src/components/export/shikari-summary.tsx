"use client";

import { useState } from "react";
import {
  detail,
  extras,
  gather,
  headline,
  summarySections,
  summaryText,
  type SummarySection,
  type SummaryTone,
} from "@/lib/shikari/summary";
import type { BuildReport, ProfileLine } from "@/lib/shikari/types";

/**
 * The short version of what an export changes -- which profiles are new, activated,
 * updated, deactivated or removed, and what else was cleared out -- shown above each
 * instance's full review, and on its own once the files are downloaded. The words come from
 * lib/shikari/summary.ts, which is also what Copy puts on the clipboard.
 */

/** Past this many names, a heading's names are folded away behind their count. */
const FOLD = 12;

const TONES: Record<SummaryTone, string> = {
  good: "text-[var(--color-good)]",
  fg: "text-[var(--color-fg)]",
  warn: "text-[var(--color-warn)]",
  muted: "text-[var(--color-muted)]",
};

export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard is permission-gated. The summary is on screen either way.
    }
  }
  return (
    <button
      type="button"
      onClick={copy}
      className="inline-flex min-h-11 items-center rounded-lg px-2 text-xs font-medium text-[var(--color-muted)] transition-colors hover:text-[var(--color-fg)] sm:min-h-0"
    >
      {copied ? "Copied" : label}
    </button>
  );
}

function Names({ lines, withWhy }: { lines: ProfileLine[]; withWhy: boolean }) {
  const text = lines.map((l) => (withWhy && l.why ? `${l.name} (${l.why})` : l.name)).join(", ");
  if (lines.length <= FOLD) return <span className="text-[var(--color-fg)]">{text}</span>;
  return (
    <details className="inline">
      <summary className="inline cursor-pointer text-[var(--color-muted)] hover:text-[var(--color-fg)]">
        show {lines.length}
      </summary>
      <span className="block text-[var(--color-fg)]">{text}</span>
    </details>
  );
}

function SectionView({ section }: { section: SummarySection }) {
  if (section.lines.length === 0) return null;
  return (
    <div>
      <p className={`font-semibold ${TONES[section.tone]}`}>
        {section.title} <span className="font-normal">({section.lines.length})</span>
      </p>
      {section.by === "line" ? (
        <ul className="mt-0.5 max-h-60 space-y-0.5 overflow-y-auto">
          {section.lines.map((line, i) => {
            const more = detail(line);
            return (
              <li key={`${line.name}-${i}`}>
                <span className="text-white">{line.name}</span>
                {line.owner && <span className="text-[var(--color-muted)]"> · {line.owner}</span>}
                {more && <span className="text-[var(--color-muted)]"> — {more}</span>}
              </li>
            );
          })}
        </ul>
      ) : (
        <ul className="mt-0.5 space-y-0.5">
          {gather(section).map(([label, lines]) => (
            <li key={label}>
              <span className="text-[var(--color-muted)]">
                {label} ({lines.length}):
              </span>{" "}
              <Names lines={lines} withWhy={section.by === "group"} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function ChangeSummary({
  position,
  fileName,
  report,
}: {
  position: number;
  fileName: string;
  report: BuildReport;
}) {
  const also = extras(report);
  return (
    <div className="rounded-xl border border-[var(--color-edge)] bg-[var(--color-ink)]/40 px-4 py-3 text-xs">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
        <p className="text-sm">
          <span className="font-semibold text-white">Profiles</span>{" "}
          <span className="text-[var(--color-fg)]">{headline(report)}</span>
        </p>
        <CopyButton text={summaryText(position, fileName, report)} label="Copy summary" />
      </div>
      <div className="mt-2 space-y-2">
        {summarySections(report).map((section) => (
          <SectionView key={section.title} section={section} />
        ))}
      </div>
      {also.length > 0 && (
        <p className="mt-2 text-[var(--color-muted)]">Also taken out: {also.join(", ")}.</p>
      )}
    </div>
  );
}

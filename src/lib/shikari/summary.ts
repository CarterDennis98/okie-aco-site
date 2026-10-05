import type { BuildReport, ProfileLine } from "@/lib/shikari/types";

/**
 * The short version of what an export changes, in words: which profiles are NEW, ACTIVATED,
 * UPDATED, DEACTIVATED or REMOVED -- the part an operator acts on, or tells members about --
 * and what else was cleared out. The export page renders it (shikari-summary.tsx) and puts
 * the text version on the clipboard.
 *
 * "Running" is what activated and deactivated turn on: a profile with a Target checkout task
 * that has products to check out, before the export and after it.
 */

const n = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

export type SummaryTone = "good" | "fg" | "warn" | "muted";

export type SummarySection = {
  title: "New" | "Activated" | "Updated" | "Deactivated" | "Removed";
  tone: SummaryTone;
  lines: ProfileLine[];
  /** One line per profile, or gathered under a heading per reason, or per group. */
  by: "line" | "why" | "group";
};

export function summarySections(report: BuildReport): SummarySection[] {
  const p = report.profiles;
  return [
    { title: "New", tone: "good", lines: p.added, by: "line" },
    { title: "Activated", tone: "good", lines: p.activated, by: "line" },
    { title: "Updated", tone: "fg", lines: p.updated, by: "line" },
    { title: "Deactivated", tone: "warn", lines: p.deactivated, by: "why" },
    { title: "Removed", tone: "muted", lines: p.removed, by: "group" },
  ];
}

/** "card, CVV" for an update, the reason for anything else. */
export function detail(line: ProfileLine): string | null {
  if (line.fields && line.fields.length > 0) return line.fields.join(", ");
  return line.why ?? null;
}

/** The heading a line is gathered under: its reason, or the group it was taken from. */
export function heading(section: SummarySection, line: ProfileLine): string {
  return section.by === "group" ? `from “${line.group ?? "?"}”` : (line.why ?? "—");
}

/** Lines gathered under their headings, the biggest heading first. */
export function gather(section: SummarySection): [string, ProfileLine[]][] {
  const groups = new Map<string, ProfileLine[]>();
  for (const line of section.lines) {
    const key = heading(section, line);
    groups.set(key, [...(groups.get(key) ?? []), line]);
  }
  return [...groups].sort((a, b) => b[1].length - a[1].length);
}

/** What else went, besides profiles: logins, mailboxes, old wipes, strays, groups. */
export function extras(report: BuildReport): string[] {
  const said: string[] = [];
  if (report.accounts.removed) said.push(n(report.accounts.removed, "login"));
  if (report.imap.removed) said.push(n(report.imap.removed, "mailbox", "mailboxes"));
  if (report.wipes.removed) said.push(n(report.wipes.removed, "old wipe task"));
  if (report.strays)
    said.push(n(report.strays, "leftover address or card", "leftover addresses and cards"));
  const groups = [...report.groupsRemoved.profile, ...report.groupsRemoved.task];
  if (groups.length > 0)
    said.push(
      `${groups.length === 1 ? "group" : "groups"} ${groups.map((g) => `“${g}”`).join(", ")}`,
    );
  return said;
}

/** "3 new · 2 activated · 210 unchanged", leaving out the zeroes. */
export function headline(report: BuildReport): string {
  const p = report.profiles;
  const parts: [number, string][] = [
    [p.added.length, "new"],
    [p.activated.length, "activated"],
    [p.updated.length, "updated"],
    [p.deactivated.length, "deactivated"],
    [p.removed.length, "removed"],
    [p.unchanged, "unchanged"],
  ];
  const said = parts.filter(([count]) => count > 0).map(([count, label]) => `${count} ${label}`);
  return said.length > 0 ? said.join(" · ") : "no profile changes";
}

/** The summary as text: for the clipboard, and from there a note or a Discord post. */
export function summaryText(position: number, fileName: string, report: BuildReport): string {
  const out = [`Instance ${position} · ${fileName}`, headline(report)];
  for (const section of summarySections(report)) {
    if (section.lines.length === 0) continue;
    out.push("", `${section.title} (${section.lines.length})`);
    if (section.by === "line") {
      for (const line of section.lines) {
        const owner = line.owner ? ` (${line.owner})` : "";
        const more = detail(line);
        out.push(`- ${line.name}${owner}${more ? `: ${more}` : ""}`);
      }
      continue;
    }
    for (const [label, lines] of gather(section)) {
      const names = lines.map((l) =>
        section.by === "group" && l.why ? `${l.name} (${l.why})` : l.name,
      );
      out.push(`- ${label}: ${names.join(", ")}`);
    }
  }
  const also = extras(report);
  if (also.length > 0) out.push("", `Also taken out: ${also.join(", ")}.`);
  return out.join("\n");
}

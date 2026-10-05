/**
 * Writing values the way Shikari writes them.
 *
 * Shikari is Python (SQLAlchemy, Alembic), and everything it stores went through Python's
 * own formatting. Rows the export writes are formatted the same way, so a row it touched is
 * indistinguishable from one Shikari wrote -- to Shikari, and to anyone diffing two backups.
 */

/**
 * "2026-10-05 01:36:53.015574": Python's `str(datetime)`, UTC, microseconds. What every
 * `created_at` and `updated_at` in the backup looks like.
 */
export function shikariTime(date: Date): string {
  const iso = date.toISOString(); // 2026-10-05T01:36:53.015Z
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)}.${iso.slice(20, 23)}000`;
}

/**
 * JSON as Python's `json.dumps` writes it by default: `", "` and `": "` separators, and
 * every non-ASCII character escaped. Shikari reads either form, but a JSON column rewritten
 * in JavaScript's compact style would show up as changed in every diff even where no value
 * moved -- and an options blob that LOOKS edited is one somebody stops to check by hand.
 */
export function pyJson(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return "null";
    return String(value);
  }
  if (typeof value === "string") {
    return JSON.stringify(value).replace(
      /[\u0080-￿]/g,
      (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
    );
  }
  if (Array.isArray(value)) return `[${value.map(pyJson).join(", ")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).filter(
      ([, v]) => v !== undefined,
    );
    return `{${entries.map(([k, v]) => `${pyJson(k)}: ${pyJson(v)}`).join(", ")}}`;
  }
  return "null";
}

/** A JSON object column, or an empty object when it is empty, null, or not an object. */
export function jsonObject(text: unknown): Record<string, unknown> {
  if (typeof text !== "string" || !text.trim()) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** A version-4 UUID drawn from `random`, so a seeded build mints the same ids every time. */
export function uuid4(random: () => number): string {
  const hex = Array.from({ length: 32 }, () => Math.floor(random() * 16).toString(16));
  hex[12] = "4";
  hex[16] = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  const s = hex.join("");
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}

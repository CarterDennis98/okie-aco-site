/**
 * A raffle's times, in Central: how an admin types them and how members read them.
 *
 * They're stored as instants, but Target posts them as wall-clock times -- "entries close
 * 11/23 at 11:59 PM CT" -- and that's what the admin types and what members should see. So
 * both directions go through America/Chicago, the zone every drop on the site is named in,
 * and never the browser's own: an admin who is travelling mustn't move a deadline an hour.
 *
 * Pure, and free of server code: the page renders the labels, the editor fills its inputs,
 * and the actions read what was typed, all with these.
 */

export const RAFFLE_ZONE = "America/Chicago";

/** How far ahead of UTC Central is at an instant, in ms (negative: it's behind). */
function offsetMs(utcMs: number): number {
  const parts: Record<string, string> = {};
  for (const part of new Intl.DateTimeFormat("en-US", {
    timeZone: RAFFLE_ZONE,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(utcMs))) {
    parts[part.type] = part.value;
  }
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour) % 24,
    Number(parts.minute),
    Number(parts.second),
  );
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

/**
 * "2026-11-23T23:59", read as Central time -> the instant it names. Null when it isn't a real
 * date and time ("2026-02-30T10:00" included).
 *
 * Two passes, like the bot's zonedToUtc, so a guess on the wrong side of a DST change
 * corrects itself. An hour that doesn't exist (2:30 AM the day clocks go forward) lands an
 * hour on; one that happens twice (1:30 AM the day they go back) is the first of the two.
 */
export function fromZonedInput(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const [year, month, day, hour, minute] = match.slice(1).map(Number);
  if (hour > 23 || minute > 59) return null;
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const probe = new Date(guess);
  // Catches 2/30 rolling into March.
  if (probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return null;
  const first = offsetMs(guess);
  let ms = guess - first;
  const second = offsetMs(ms);
  if (second !== first) ms = guess - second;
  return new Date(ms);
}

/** An instant as Central wall-clock time, "2026-11-23T23:59": what a datetime-local input takes. */
export function toZonedInput(date: Date): string {
  const parts: Record<string, string> = {};
  for (const part of new Intl.DateTimeFormat("en-US", {
    timeZone: RAFFLE_ZONE,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(date)) {
    parts[part.type] = part.value;
  }
  return `${parts.year}-${parts.month}-${parts.day}T${String(Number(parts.hour) % 24).padStart(2, "0")}:${parts.minute}`;
}

const LABEL = new Intl.DateTimeFormat("en-US", {
  weekday: "short",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZone: RAFFLE_ZONE,
});

/** "Sun, Nov 23, 11:59 PM CT" -- a raffle time as members read it. */
export function raffleTimeLabel(date: Date): string {
  return `${LABEL.format(date)} CT`;
}

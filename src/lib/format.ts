/** Presentation helpers. No money formatting here -- see money.ts. */

/** "3 minutes ago", "2 hours ago", "yesterday". Coarse on purpose. */
export function relativeTime(date: Date, now: Date = new Date()): string {
  const seconds = Math.max(0, Math.floor((now.getTime() - date.getTime()) / 1000));
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (minutes < 60) return minutes <= 1 ? "just now" : `${minutes} minutes ago`;
  if (hours < 24) return hours === 1 ? "an hour ago" : `${hours} hours ago`;
  if (days === 1) return "yesterday";
  if (days < 30) return `${days} days ago`;

  const months = Math.floor(days / 30);
  return months === 1 ? "last month" : `${months} months ago`;
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return n === 1 ? one : many;
}

/** Thousands separators, for the headline counters. */
export function count(n: number): string {
  return n.toLocaleString("en-US");
}

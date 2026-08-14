import "server-only";

import { prisma } from "@/db/client";

/**
 * Which mailbox a retailer account's verification codes actually arrive in.
 *
 * Two ways an address is covered:
 *
 *   1. It has an app password of its own -- it maps to itself.
 *   2. It forwards into an address that does -- it maps to that one.
 *
 * Every consumer that used to ask "is there a credential row for this email?" asks this
 * instead, because the answer to the useful question -- can the bot read this account's
 * code without messaging the member mid-drop -- is yes in both cases.
 *
 * One map, built once per request, rather than a per-row lookup: the admin view resolves
 * this for every profile of every member on a site.
 */

export type MailboxCoverage = {
  /** Lowercased address -> the mailbox its mail lands in. Absent means uncovered. */
  destination: Map<string, string>;
};

export async function loadMailboxCoverage(discordUserId?: string): Promise<MailboxCoverage> {
  const scope = discordUserId ? { discordUserId } : {};

  const [credentials, aliases] = await Promise.all([
    prisma.emailCredential.findMany({ where: scope, select: { email: true } }),
    prisma.emailAlias.findMany({
      where: scope,
      select: { email: true, credential: { select: { email: true } } },
    }),
  ]);

  // Aliases first, credentials second, so a real password always wins. The write path
  // already refuses to let one address be both, but ordering the merge this way means a
  // row that slipped through resolves to the mailbox that can actually be opened rather
  // than to a forwarding claim.
  const destination = new Map<string, string>();
  for (const a of aliases) destination.set(a.email.toLowerCase(), a.credential.email);
  for (const c of credentials) destination.set(c.email.toLowerCase(), c.email);

  return { destination };
}

/** The mailbox this address's codes land in, or null when nothing covers it. */
export function mailboxFor(coverage: MailboxCoverage, email: string): string | null {
  return coverage.destination.get(email.toLowerCase()) ?? null;
}

/** True when the address is covered by forwarding rather than by its own password. */
export function isForwarded(coverage: MailboxCoverage, email: string): boolean {
  const to = mailboxFor(coverage, email);
  return to !== null && to.toLowerCase() !== email.toLowerCase();
}

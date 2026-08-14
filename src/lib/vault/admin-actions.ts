"use server";

import { prisma } from "@/db/client";
import { requireAdmin } from "@/lib/auth/guard";
import { revealCredential, type RevealResult } from "@/lib/vault/reveal";

/**
 * Admin-only vault actions.
 *
 * Kept out of actions.ts so the guard used by each file is obvious at a glance: every
 * export here calls `requireAdmin()`, every export there calls `requireMember()`. A
 * Server Action is an individually-addressable POST endpoint, so mixing the two in one
 * module is exactly how the wrong guard ends up on the wrong action.
 */

/**
 * Reveal any member's app password.
 *
 * Unlike the member action there is no owner predicate -- that is the point of the
 * admin view. The `vault_reveals` row records it as `onBehalf`, which is the flag worth
 * filtering on later: reading someone else's mailbox password is the event that matters.
 *
 * This grants nothing the audited export doesn't already grant; it just avoids
 * downloading a file full of credentials to read one line.
 */
export async function revealAppPasswordForAdmin(form: FormData): Promise<RevealResult> {
  const viewer = await requireAdmin();
  const email = String(form.get("email") ?? "")
    .trim()
    .toLowerCase();
  if (!email) return { ok: false, error: "Missing address." };

  // Same alias resolution as the member action -- see revealOwnAppPassword.
  const credential = await prisma.emailCredential.findFirst({
    where: { OR: [{ email }, { aliases: { some: { email } } }] },
    select: { id: true, email: true, appPasswordEnc: true, discordUserId: true },
  });
  return revealCredential(credential, viewer.discordUserId);
}

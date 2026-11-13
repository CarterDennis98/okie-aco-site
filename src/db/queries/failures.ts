import "server-only";

import { prisma } from "@/db/client";
import { flagsByProfile, type FailureFlag } from "@/lib/vault/failure-flags";

/**
 * Failed checkouts against a member's profiles: the reads behind the flags, and the write that
 * clears them. See lib/vault/failure-flags.ts for what a flag means.
 *
 * Member-scoped like the rest of db/queries/vault.ts: `discordUserId` comes from the guard, and
 * reaches the failures through the profile they ran on, so another member's are never read.
 */

/** Profile id -> its flag, for the member's profiles with failures still counting. */
export async function loadFailureFlags(
  discordUserId: string,
  profileId?: string,
): Promise<Map<string, FailureFlag>> {
  const rows = await prisma.checkoutFailure.findMany({
    where: {
      clearedAt: null,
      vaultProfile: { discordUserId, ...(profileId ? { id: profileId } : {}) },
    },
    select: {
      vaultProfileId: true,
      siteKey: true,
      occurredAt: true,
      reason: true,
      productRaw: true,
    },
  });
  return flagsByProfile(
    rows.flatMap((row) =>
      row.vaultProfileId ? [{ ...row, vaultProfileId: row.vaultProfileId }] : [],
    ),
  );
}

/**
 * Stop counting these profiles' failures against them, as of `at` -- their owner just changed
 * them. Returned unawaited so it can go in the same transaction as the change itself: a flag
 * cleared without the edit that cleared it, or the other way round, would be a lie either way.
 *
 * The profile's own `failuresClearedAt` is the caller's to set alongside, in the same write as
 * its other fields.
 */
export function clearFailures(profileIds: string[], at: Date) {
  return prisma.checkoutFailure.updateMany({
    where: { vaultProfileId: { in: profileIds }, clearedAt: null },
    data: { clearedAt: at },
  });
}

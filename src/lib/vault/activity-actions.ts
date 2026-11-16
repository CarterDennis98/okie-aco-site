"use server";

import { getProfileHistory } from "@/db/queries/profile-activity";
import { requireMember } from "@/lib/auth/guard";
import type { ProfileHistory } from "@/lib/vault/profile-activity";

/**
 * One profile's checkout history, for the success/fail view, fetched when its count is tapped.
 *
 * An action rather than a prop for the reason the edit form's details are one: shipping every
 * profile's history with the page would be a lot to render a list that shows a count. Guarded
 * and owner-scoped like every vault action -- someone else's profile id returns null.
 */
export async function loadProfileHistory(profileId: string): Promise<ProfileHistory | null> {
  const viewer = await requireMember();
  return getProfileHistory(viewer.discordUserId, String(profileId ?? ""));
}

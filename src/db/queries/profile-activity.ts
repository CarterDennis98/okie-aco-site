import "server-only";

import { prisma } from "@/db/client";
import { productLabel } from "@/lib/normalize";
import {
  ACTIVITY_SINCE,
  HISTORY_LIMIT,
  activityEvents,
  assignCheckouts,
  summarizeActivity,
  type ActivityCheckout,
  type ActivityFailure,
  type ProfileActivity,
  type ProfileHistory,
} from "@/lib/vault/profile-activity";

export type { ProfileHistory };

/**
 * Each profile's checkouts and failures, for the success/fail view on the Profiles page. See
 * lib/vault/profile-activity.ts for how they are matched, merged and counted.
 *
 * Member-scoped like every member query: `discordUserId` comes from the guard. Checkouts are
 * narrowed to the member's own the way the dashboard narrows them -- through their profile
 * family (`profile: { discordUserId }`) -- and failures through the profile they were bound to,
 * so nothing here can reach another member's orders. Nothing is decrypted or written.
 */

const PROFILE_SELECT = {
  id: true,
  siteKey: true,
  name: true,
  profileKey: true,
  profileIndex: true,
} as const;

const CHECKOUT_SELECT = {
  id: true,
  occurredAt: true,
  site: true,
  profileKey: true,
  profileIndex: true,
  profileRaw: true,
  orderId: true,
  quantity: true,
  productRaw: true,
  item: { select: { label: true } },
} as const;

const FAILURE_SELECT = {
  id: true,
  occurredAt: true,
  siteKey: true,
  orderId: true,
  reason: true,
  productRaw: true,
} as const;

type CheckoutRow = {
  id: string;
  occurredAt: Date;
  site: string | null;
  profileKey: string | null;
  profileIndex: number | null;
  profileRaw: string | null;
  orderId: string | null;
  quantity: number;
  productRaw: string | null;
  item: { label: string } | null;
};

/** The name a member reads, as the dashboard shows it: the curated label, else the vendor's. */
function toActivityCheckout(row: CheckoutRow): ActivityCheckout {
  const name = row.item?.label ?? row.productRaw;
  return {
    id: row.id,
    occurredAt: row.occurredAt,
    site: row.site,
    profileKey: row.profileKey,
    profileIndex: row.profileIndex,
    profileRaw: row.profileRaw,
    orderId: row.orderId,
    quantity: row.quantity,
    product: name ? productLabel(name) : null,
  };
}

/**
 * Profile id -> its counts since ACTIVITY_SINCE, for every profile of theirs with any activity.
 * A plain object, so it crosses into the client components as a prop.
 */
export async function getProfileActivity(
  discordUserId: string,
): Promise<Record<string, ProfileActivity>> {
  const [profiles, checkouts, failures] = await Promise.all([
    prisma.vaultProfile.findMany({ where: { discordUserId }, select: PROFILE_SELECT }),
    prisma.checkout.findMany({
      where: { profile: { discordUserId }, occurredAt: { gte: ACTIVITY_SINCE } },
      select: CHECKOUT_SELECT,
    }),
    prisma.checkoutFailure.findMany({
      where: { vaultProfile: { discordUserId }, occurredAt: { gte: ACTIVITY_SINCE } },
      select: { ...FAILURE_SELECT, vaultProfileId: true },
    }),
  ]);

  const checkoutsByProfile = assignCheckouts(checkouts.map(toActivityCheckout), profiles);
  const failuresByProfile = new Map<string, ActivityFailure[]>();
  for (const failure of failures) {
    if (!failure.vaultProfileId) continue;
    const list = failuresByProfile.get(failure.vaultProfileId) ?? [];
    list.push(failure);
    failuresByProfile.set(failure.vaultProfileId, list);
  }

  const activity: Record<string, ProfileActivity> = {};
  for (const profile of profiles) {
    const summary = summarizeActivity(
      checkoutsByProfile.get(profile.id) ?? [],
      failuresByProfile.get(profile.id) ?? [],
    );
    if (summary) activity[profile.id] = summary;
  }
  return activity;
}

/**
 * One profile's history since ACTIVITY_SINCE, newest first. Null when the profile isn't theirs,
 * never an error that would confirm the id exists.
 */
export async function getProfileHistory(
  discordUserId: string,
  profileId: string,
): Promise<ProfileHistory | null> {
  const profile = await prisma.vaultProfile.findFirst({
    // Both predicates, never fetch-then-compare.
    where: { id: profileId, discordUserId },
    select: PROFILE_SELECT,
  });
  if (!profile) return null;

  const [twins, checkouts, failures] = await Promise.all([
    // Their profiles that key the same way on any retailer -- what this one's checkouts have
    // to be told apart from (assignCheckouts).
    prisma.vaultProfile.findMany({
      where: {
        discordUserId,
        profileKey: profile.profileKey,
        profileIndex: profile.profileIndex,
      },
      select: PROFILE_SELECT,
    }),
    prisma.checkout.findMany({
      where: {
        profile: { discordUserId },
        profileKey: profile.profileKey,
        profileIndex: profile.profileIndex,
        occurredAt: { gte: ACTIVITY_SINCE },
      },
      select: CHECKOUT_SELECT,
    }),
    prisma.checkoutFailure.findMany({
      where: { vaultProfileId: profile.id, occurredAt: { gte: ACTIVITY_SINCE } },
      select: FAILURE_SELECT,
    }),
  ]);

  const mine = assignCheckouts(checkouts.map(toActivityCheckout), twins).get(profile.id) ?? [];
  const events = activityEvents(mine, failures);
  return { events: events.slice(0, HISTORY_LIMIT), total: events.length };
}

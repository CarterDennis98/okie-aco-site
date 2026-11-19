"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { prisma } from "@/db/client";
import { requireMember } from "@/lib/auth/guard";
import { raffleTimeLabel } from "@/lib/raffles/time";

/**
 * A member entering a raffle, narrowing an entry to some of their profiles, or withdrawing.
 *
 * Every write is narrowed to the signed-in member: the id comes from the guard, never the
 * request, and a profile id in the request counts only if it is theirs and on the raffle's
 * retailer. A Server Action is a public POST endpoint, so that check lives here rather than
 * in what the page chose to render.
 *
 * Nothing changes once entries are due -- not an entry, not a withdrawal. That is the line
 * the admin drew; by then the export may already have run on what was there.
 */

const input = z
  .object({
    raffleId: z.uuid(),
    // off: not entered. all: every profile they hold there, now and later. some: exactly the
    // profiles listed.
    mode: z.enum(["off", "all", "some"]),
    profileIds: z.array(z.uuid()).max(500).default([]),
  })
  .strict();

export type EntryResult = { ok: true } | { ok: false; error: string };

export async function saveRaffleEntry(raw: unknown): Promise<EntryResult> {
  const viewer = await requireMember();
  const parsed = input.safeParse(raw);
  if (!parsed.success)
    return { ok: false, error: "That didn't save. Reload the page and try again." };
  const { raffleId, mode } = parsed.data;
  const profileIds = [...new Set(parsed.data.profileIds)];

  const raffle = await prisma.raffle.findUnique({
    where: { id: raffleId },
    select: { siteKey: true, dueAt: true },
  });
  if (!raffle) return { ok: false, error: "That raffle isn't listed any more. Reload the page." };
  if (raffle.dueAt <= new Date()) {
    return {
      ok: false,
      error: `Entries were due ${raffleTimeLabel(raffle.dueAt)}, so this can't change now.`,
    };
  }

  if (mode === "some") {
    if (profileIds.length === 0) {
      return { ok: false, error: "Pick at least one profile, or switch it off." };
    }
    const mine = await prisma.vaultProfile.count({
      where: {
        id: { in: profileIds },
        discordUserId: viewer.discordUserId,
        siteKey: raffle.siteKey,
      },
    });
    if (mine !== profileIds.length) return { ok: false, error: "Those aren't your profiles." };
  }

  try {
    await prisma.$transaction(async (tx) => {
      if (mode === "off") {
        await tx.raffleEntry.deleteMany({
          where: { raffleId, discordUserId: viewer.discordUserId },
        });
        return;
      }
      const entry = await tx.raffleEntry.upsert({
        where: { raffleId_discordUserId: { raffleId, discordUserId: viewer.discordUserId } },
        create: { raffleId, discordUserId: viewer.discordUserId, allProfiles: mode === "all" },
        update: { allProfiles: mode === "all" },
        select: { id: true },
      });
      await tx.raffleEntryProfile.deleteMany({ where: { entryId: entry.id } });
      if (mode === "some") {
        await tx.raffleEntryProfile.createMany({
          data: profileIds.map((profileId) => ({ entryId: entry.id, profileId })),
        });
      }
    });
  } catch (error) {
    console.error(
      "raffles: saving an entry failed",
      error instanceof Error ? error.message : "unknown",
    );
    return { ok: false, error: "That didn't save. Try again." };
  }

  revalidatePath("/dashboard/products");
  return { ok: true };
}

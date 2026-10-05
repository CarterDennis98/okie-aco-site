"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { prisma } from "@/db/client";
import { requireMember } from "@/lib/auth/guard";

/**
 * A member picking which drop products they want to be run for.
 *
 * Every write is narrowed to the signed-in member: the id comes from the guard, never the
 * request, and a profile id in the request counts only if it is theirs and on the product's
 * retailer. A Server Action is a public POST endpoint, so that check lives here rather than
 * in what the page chose to render.
 */

const input = z
  .object({
    productIds: z.array(z.uuid()).min(1).max(200),
    // off: not run for these. all: every profile they hold there, now and later.
    // some: exactly the profiles listed.
    mode: z.enum(["off", "all", "some"]),
    profileIds: z.array(z.uuid()).max(500).default([]),
  })
  .strict();

export type ChoiceResult = { ok: true } | { ok: false; error: string };

export async function saveProductChoice(raw: unknown): Promise<ChoiceResult> {
  const viewer = await requireMember();
  const parsed = input.safeParse(raw);
  if (!parsed.success)
    return { ok: false, error: "That didn't save. Reload the page and try again." };
  const productIds = [...new Set(parsed.data.productIds)];
  const profileIds = [...new Set(parsed.data.profileIds)];
  const { mode } = parsed.data;

  // Retired products can still be switched OFF -- a member tidying up shouldn't be told no --
  // but nothing retired can be switched on.
  const products = await prisma.dropProduct.findMany({
    where: { id: { in: productIds }, ...(mode === "off" ? {} : { active: true }) },
    select: { id: true, siteKey: true },
  });
  if (products.length !== productIds.length) {
    return { ok: false, error: "That product isn't available any more. Reload the page." };
  }

  if (mode === "some") {
    if (profileIds.length === 0) {
      return { ok: false, error: "Pick at least one profile, or switch it off." };
    }
    const sites = [...new Set(products.map((p) => p.siteKey))];
    const mine = await prisma.vaultProfile.count({
      where: {
        id: { in: profileIds },
        discordUserId: viewer.discordUserId,
        siteKey: { in: sites },
      },
    });
    if (mine !== profileIds.length) return { ok: false, error: "Those aren't your profiles." };
  }

  try {
    await prisma.$transaction(async (tx) => {
      if (mode === "off") {
        await tx.productSelection.deleteMany({
          where: { productId: { in: productIds }, discordUserId: viewer.discordUserId },
        });
        return;
      }
      for (const productId of productIds) {
        const selection = await tx.productSelection.upsert({
          where: { productId_discordUserId: { productId, discordUserId: viewer.discordUserId } },
          create: { productId, discordUserId: viewer.discordUserId, allProfiles: mode === "all" },
          update: { allProfiles: mode === "all" },
          select: { id: true },
        });
        await tx.productSelectionProfile.deleteMany({ where: { selectionId: selection.id } });
        if (mode === "some") {
          await tx.productSelectionProfile.createMany({
            data: profileIds.map((profileId) => ({ selectionId: selection.id, profileId })),
          });
        }
      }
    });
  } catch (error) {
    console.error(
      "products: saving a choice failed",
      error instanceof Error ? error.message : "unknown",
    );
    return { ok: false, error: "That didn't save. Try again." };
  }

  revalidatePath("/dashboard/products");
  return { ok: true };
}

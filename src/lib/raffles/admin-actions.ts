"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { prisma } from "@/db/client";
import { Prisma } from "@/generated/prisma/client";
import { requireAdmin } from "@/lib/auth/guard";
import { parseRaffleInput, type RaffleInput } from "@/lib/raffles/raffle-input";

/**
 * Listing, editing and deleting raffles. FULL ADMINS ONLY, like the product catalog: a raffle
 * is something every member can be entered in, on every runner's bot.
 *
 * Every change writes an `admin_audit` row, like every other admin mutation.
 */

export type RaffleResult = { ok: true; id: string } | { ok: false; error: string };
export type DeleteRaffleResult = { ok: true; entries: number } | { ok: false; error: string };

/** Only Target has raffles today, as only Target has products. */
const SITE = "target";

const fields = z
  .object({
    url: z.string().max(2000),
    sku: z.string().max(40),
    name: z.string().max(400),
    price: z.string().max(40),
    imageUrl: z.string().max(2000),
    startsAt: z.string().max(40),
    dueAt: z.string().max(40),
  })
  .strict();

const createRequest = z.object({ fields }).strict();
const updateRequest = z.object({ id: z.uuid(), fields }).strict();
const deleteRequest = z
  .object({
    id: z.uuid(),
    /** How many members' entries the page showed: if it has moved, nothing is deleted. */
    entries: z.number().int().min(0).max(100_000),
  })
  .strict();

/** What the audit keeps of a raffle: everything about it, times as ISO strings. */
const audited = (r: RaffleInput) => ({
  ...r,
  startsAt: r.startsAt.toISOString(),
  dueAt: r.dueAt.toISOString(),
});

/** "There's already a raffle for SKU 1012850572: “Elite Trainer Box”." */
async function alreadyRaffled(sku: string): Promise<string> {
  const other = await prisma.raffle.findUnique({
    where: { siteKey_sku: { siteKey: SITE, sku } },
    select: { name: true },
  });
  return other
    ? `There's already a raffle for SKU ${sku}: “${other.name}”. Delete it first to raffle it again.`
    : `There's already a raffle for SKU ${sku}.`;
}

export async function createRaffle(raw: unknown): Promise<RaffleResult> {
  const viewer = await requireAdmin();
  const request = createRequest.safeParse(raw);
  if (!request.success)
    return { ok: false, error: "That raffle didn't arrive whole. Reload the page." };
  const parsed = parseRaffleInput(request.data.fields, { isNew: true });
  if (!parsed.ok) return parsed;
  const value = parsed.value;

  try {
    const id = await prisma.$transaction(async (tx) => {
      const row = await tx.raffle.create({
        data: { ...value, siteKey: SITE, createdBy: viewer.discordUserId },
        select: { id: true },
      });
      await tx.adminAudit.create({
        data: {
          actorDiscordId: viewer.discordUserId,
          action: "raffle.create",
          entity: "raffle",
          entityId: row.id,
          after: audited(value),
        },
      });
      return row.id;
    });
    revalidatePath("/dashboard/products");
    return { ok: true, id };
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return { ok: false, error: await alreadyRaffled(value.sku) };
    }
    console.error("raffles: create failed", error instanceof Error ? error.message : "unknown");
    return { ok: false, error: "Couldn't save that. Nothing changed — try again." };
  }
}

/**
 * Edits a raffle: its product, its start, when entries are due. Entries stay as members left
 * them -- including when the product changes, which is how a wrong link gets fixed. Moving the
 * due date into the past closes entries early.
 */
export async function updateRaffle(raw: unknown): Promise<RaffleResult> {
  const viewer = await requireAdmin();
  const request = updateRequest.safeParse(raw);
  if (!request.success)
    return { ok: false, error: "That raffle didn't arrive whole. Reload the page." };
  const { id } = request.data;
  const parsed = parseRaffleInput(request.data.fields, { isNew: false });
  if (!parsed.ok) return parsed;
  const value = parsed.value;

  try {
    const before = await prisma.raffle.findUnique({
      where: { id },
      select: {
        sku: true,
        name: true,
        url: true,
        imageUrl: true,
        priceCents: true,
        startsAt: true,
        dueAt: true,
      },
    });
    if (!before) return { ok: false, error: "That raffle is gone. Reload the page." };
    await prisma.$transaction([
      prisma.raffle.update({ where: { id }, data: value }),
      prisma.adminAudit.create({
        data: {
          actorDiscordId: viewer.discordUserId,
          action: "raffle.update",
          entity: "raffle",
          entityId: id,
          before: audited(before),
          after: audited(value),
        },
      }),
    ]);
    revalidatePath("/dashboard/products");
    return { ok: true, id };
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return { ok: false, error: await alreadyRaffled(value.sku) };
    }
    console.error("raffles: update failed", error instanceof Error ? error.message : "unknown");
    return { ok: false, error: "Couldn't save that. Nothing changed — try again." };
  }
}

/**
 * Deletes a raffle and every entry in it. Unlike a due date passing, there's no bringing it
 * back -- which is why the button takes two clicks, and why nothing is deleted if more
 * members have entered since the page loaded. The next Shikari export takes its task group
 * out of each backup.
 */
export async function deleteRaffle(raw: unknown): Promise<DeleteRaffleResult> {
  const viewer = await requireAdmin();
  const request = deleteRequest.safeParse(raw);
  if (!request.success)
    return { ok: false, error: "That request didn't arrive whole. Reload the page." };
  const { id } = request.data;

  const raffle = await prisma.raffle.findUnique({
    where: { id },
    select: {
      sku: true,
      name: true,
      url: true,
      imageUrl: true,
      priceCents: true,
      startsAt: true,
      dueAt: true,
      _count: { select: { entries: true } },
    },
  });
  if (!raffle) return { ok: false, error: "That raffle is already gone. Reload the page." };
  const entries = raffle._count.entries;
  if (entries !== request.data.entries) {
    return {
      ok: false,
      error: "Entries changed since the page loaded. Reload the page and check before deleting.",
    };
  }

  const before = {
    sku: raffle.sku,
    name: raffle.name,
    url: raffle.url,
    imageUrl: raffle.imageUrl,
    priceCents: raffle.priceCents,
    startsAt: raffle.startsAt,
    dueAt: raffle.dueAt,
  };
  await prisma.$transaction([
    prisma.raffle.delete({ where: { id } }),
    prisma.adminAudit.create({
      data: {
        actorDiscordId: viewer.discordUserId,
        action: "raffle.delete",
        entity: "raffle",
        entityId: id,
        before: { ...audited(before), entries },
      },
    }),
  ]);

  revalidatePath("/dashboard/products");
  return { ok: true, entries };
}

import { prisma } from "@/db/client";
import { authorizeBot } from "@/lib/bot-auth";
import { sanitizeEmbed } from "@/lib/ingest/embed-allowlist";
import { matchProfileOwner } from "@/lib/ingest/profile-owner";
import { normalizeProduct, normalizeProfile, toAliasMap } from "@/lib/normalize";
import { checkoutBatch } from "@/types/ingest";
import type { Prisma } from "@/generated/prisma/client";

/**
 * Checkout ingest. The bot posts here as it mirrors, and the backfill posts historical
 * messages through the same path.
 *
 * IDEMPOTENCY MATTERS MORE THAN THE AUTH. A retry, a bot restart, or a re-run of the
 * backfill must never double-insert, because a double-insert is a double-bill. Two
 * unique constraints carry that -- `discordMessageId`, and `(sourceBot, orderId)` -- and
 * the insert is `skipDuplicates`, so re-posting a batch is always safe and always
 * reports how much of it was already known.
 *
 * The bot sends RAW values. Normalization happens here, once, using the same functions
 * the site renders with, so a fix to an edge case is a deploy rather than a coordinated
 * two-repo change mid-drop.
 *
 * AN UNRECOGNISED PRODUCT MUST NEVER FAIL AN INGEST. New products are upserted as items
 * needing a fee and surface in admin; nothing here throws because a name was new.
 */
export const dynamic = "force-dynamic";

/**
 * Attach unmapped profiles in this batch to the member whose name they obviously are.
 *
 * A checkout only reaches its member through `profiles.discord_user_id`, and before this
 * nothing outside `prisma db seed` ever wrote that column -- so every profile that first
 * appeared here stayed UNMAPPED, and its checkouts stayed invisible to the member, to
 * their charge pages, and to the operator's per-charge breakdown. The bot bills off its
 * own mapping file, so it went on charging people for orders the site could not show.
 *
 * EVERY unmapped key in the batch, not only the rows just created: a profile stranded by
 * an earlier ingest is claimed the next time it checks out, which heals the backlog
 * without a migration.
 *
 * Only ever CLAIMS. It never moves a profile that already has an owner, never touches an
 * IGNORED one -- those are the operator's house profiles, deliberately attached to
 * nobody -- and never sets `billable`, which is the operator's decision alone.
 *
 * NEVER FAILS THE INGEST, same rule as an unrecognised product. A checkout that made it
 * into the database unattributed is recoverable; one that never landed is not.
 */
async function claimObviousProfiles(profileKeys: string[]): Promise<void> {
  try {
    const unmapped = await prisma.profile.findMany({
      where: { profileKey: { in: profileKeys }, discordUserId: null, status: "UNMAPPED" },
      select: { profileKey: true },
    });
    if (unmapped.length === 0) return;

    const members = await prisma.discordMember.findMany({
      select: { discordUserId: true, username: true, globalName: true },
    });

    for (const { profileKey } of unmapped) {
      const discordUserId = matchProfileOwner(profileKey, members);
      if (!discordUserId) continue;

      // Conditional on still being unowned: a concurrent flush of the same drop could
      // have claimed it between the read above and here.
      await prisma.profile.updateMany({
        where: { profileKey, discordUserId: null, status: "UNMAPPED" },
        data: {
          discordUserId,
          status: "MAPPED",
          mappedAt: new Date(),
          // Named so an audit can tell these apart from what a human decided.
          mappedBy: "ingest:name-match",
        },
      });
    }
  } catch (error) {
    console.error("bot ingest: profile auto-mapping failed:", (error as Error).message);
  }
}

export async function POST(request: Request) {
  // Before the body is read: an unauthenticated caller shouldn't get to make us parse
  // their JSON.
  const auth = authorizeBot(request);
  if (!auth.ok) {
    return Response.json({ error: auth.error }, { status: auth.status });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Body is not JSON" }, { status: 400 });
  }

  const parsed = checkoutBatch.safeParse(body);
  if (!parsed.success) {
    // Field paths and messages only. A validation echo of the payload would put vendor
    // embed contents in a log.
    return Response.json(
      {
        error: "Invalid payload",
        issues: parsed.error.issues.slice(0, 10).map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      },
      { status: 400 },
    );
  }

  // Last writer wins within a batch: the bot can legitimately retry a flush that
  // partially succeeded, and the same message may appear twice in one payload.
  const byMessageId = new Map(parsed.data.checkouts.map((c) => [c.discordMessageId, c]));
  const checkouts = [...byMessageId.values()];

  const aliases = toAliasMap(
    await prisma.itemAlias
      .findMany({ select: { aliasKey: true, item: { select: { label: true } } } })
      .then((rows) => rows.map((r) => ({ aliasKey: r.aliasKey, label: r.item.label }))),
  );

  // --- normalize -----------------------------------------------------------
  const rows = checkouts.map((input) => {
    const product = normalizeProduct(input.productRaw, aliases);
    const profile = normalizeProfile(input.profileRaw);
    const { embed, dropped, droppedSensitive } = sanitizeEmbed(input.rawEmbed);

    const flags = new Set(input.flags ?? []);
    if (input.quantityAssumed) flags.add("quantity-assumed");
    if (product.unreadable) flags.add("unreadable-product");
    if (!profile) flags.add("no-profile");

    return { input, product, profile, embed, dropped, droppedSensitive, flags: [...flags] };
  });

  // Dropped field NAMES, so the allowlist can be widened deliberately. Never values.
  const droppedNames = new Set<string>();
  const droppedSensitiveNames = new Set<string>();
  for (const row of rows) {
    for (const name of row.dropped) droppedNames.add(name);
    for (const name of row.droppedSensitive) droppedSensitiveNames.add(name);
  }
  if (droppedSensitiveNames.size) {
    console.warn(
      `bot ingest: dropped credential-bearing fields: ${[...droppedSensitiveNames].join(", ")}`,
    );
  }

  // --- profiles ------------------------------------------------------------
  // checkouts.profile_key is a foreign key, so an unseen profile needs its row before
  // the insert. Unmapped is the correct initial state; the step below claims the obvious
  // ones and the operator maps the rest.
  const profileKeys = [
    ...new Set(rows.map((r) => r.profile?.profileKey).filter(Boolean)),
  ] as string[];
  if (profileKeys.length) {
    await prisma.profile.createMany({
      data: profileKeys.map((profileKey) => {
        const row = rows.find((r) => r.profile?.profileKey === profileKey)!;
        return { profileKey, displayName: row.profile!.profileRaw };
      }),
      skipDuplicates: true,
    });
    await claimObviousProfiles(profileKeys);
  }

  // --- items ---------------------------------------------------------------
  const productKeys = [...new Set(rows.map((r) => r.product.productKey))];
  const existingItems = await prisma.item.findMany({
    where: { productKey: { in: productKeys } },
    select: { id: true, productKey: true },
  });
  const itemIdByKey = new Map(existingItems.map((i) => [i.productKey, i.id]));

  // (source, sku) is unique. A new product arriving with a sku another item already
  // claims must not fail the whole batch, so the sku is simply left off that item.
  const claimedSkus = new Set(
    (
      await prisma.item.findMany({
        where: { sku: { not: null } },
        select: { source: true, sku: true },
      })
    ).map((i) => `${i.source ?? ""}::${i.sku}`),
  );

  for (const key of productKeys) {
    if (itemIdByKey.has(key)) continue;
    const row = rows.find((r) => r.product.productKey === key)!;
    const source = row.input.site ?? null;
    const sku = row.input.sku ?? null;
    const skuFree = sku ? !claimedSkus.has(`${source ?? ""}::${sku}`) : false;

    const created = await prisma.item.upsert({
      where: { productKey: key },
      create: {
        productKey: key,
        label: row.product.label,
        source,
        sku: skuFree ? sku : null,
        unreadable: row.product.unreadable,
        imageUrl: row.input.imageUrl ?? null,
      },
      // Never clobber what the operator curated -- label, fee, and alias decisions win.
      update: {},
      select: { id: true },
    });
    if (skuFree && sku) claimedSkus.add(`${source ?? ""}::${sku}`);
    itemIdByKey.set(key, created.id);
  }

  // --- insert --------------------------------------------------------------
  const result = await prisma.checkout.createMany({
    data: rows.map((row) => ({
      orderId: row.input.orderId ?? null,
      sourceBot: row.input.sourceBot,
      discordMessageId: row.input.discordMessageId,
      discordChannelId: row.input.discordChannelId,
      occurredAt: new Date(row.input.occurredAt),
      site: row.input.site ?? null,
      productRaw: row.input.productRaw ?? null,
      productKey: row.product.productKey,
      itemId: itemIdByKey.get(row.product.productKey) ?? null,
      profileRaw: row.profile?.profileRaw ?? null,
      profileKey: row.profile?.profileKey ?? null,
      profileIndex: row.profile?.profileIndex ?? null,
      imageUrl: row.input.imageUrl ?? null,
      quantity: row.input.quantity ?? 1,
      quantityAssumed: row.input.quantityAssumed ?? row.input.quantity == null,
      flags: row.flags,
      // Prisma's Json input type doesn't accept a bare Record; the sanitized object is
      // plain JSON by construction.
      rawEmbed: (row.embed ?? undefined) as Prisma.InputJsonValue | undefined,
    })),
    skipDuplicates: true,
  });

  return Response.json({
    inserted: result.count,
    duplicates: rows.length - result.count,
    received: parsed.data.checkouts.length,
    droppedFields: [...droppedNames],
  });
}

import { prisma } from "@/db/client";
import { DeliveryStatus, PasRunStatus } from "@/generated/prisma/enums";
import { authorizeBot } from "@/lib/bot-auth";
import { normalizeProduct } from "@/lib/normalize";
import { pasRunInput } from "@/types/pas-run";

/**
 * The bot's delivery words, mapped to the stored enum.
 *
 * Same table the seed uses. An unrecognised value becomes PENDING rather than throwing:
 * a new failure mode in the bot should surface as "we don't know" on one bill, not as a
 * rejected billing run.
 */
const DELIVERY: Record<string, DeliveryStatus> = {
  sent: DeliveryStatus.SENT,
  skipped: DeliveryStatus.SKIPPED,
  "dms-closed": DeliveryStatus.DMS_CLOSED,
  "unknown-user": DeliveryStatus.UNKNOWN_USER,
  error: DeliveryStatus.ERROR,
};

function deliveryStatusOf(status: string | undefined): DeliveryStatus {
  return DELIVERY[status ?? ""] ?? DeliveryStatus.PENDING;
}

/**
 * Billing runs, posted by the bot the moment `/pas run` finishes sending.
 *
 * Before this existed, a drop only reached the site when somebody re-ran `prisma db
 * seed` against the database by hand -- which is how the 8/14 drop stayed invisible for
 * four days. This closes the last manual step in the loop.
 *
 * IDEMPOTENT ON `sessionId`. A retry, a bot restart mid-post, or the outbox re-flushing
 * must never produce a second set of bills, because that reads to a member as being
 * charged twice. The run upserts and its bills upsert on (run, member).
 *
 * AMOUNTS ARE A SNAPSHOT. `feeCents` and the totals are stored exactly as the bot
 * computed them and are never recalculated here. `computeBills` rounds the OG discount
 * in the member's favour; recomputing would risk disagreeing with the DM they already
 * hold, and the DM is the thing they will quote back.
 *
 * DRY RUNS ARE RECORDED, NOT HIDDEN. They arrive with `dryRun: true` and every read path
 * on the site already filters them out of balances and feeds. Storing them means the
 * operator can see a preview happened; pretending they didn't would make the site
 * disagree with the bot's own history.
 */
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const auth = authorizeBot(request);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Body is not JSON" }, { status: 400 });
  }

  const parsed = pasRunInput.safeParse(body);
  if (!parsed.success) {
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

  const input = parsed.data;

  // Bills reference members by Discord id, and `pas_bills.discord_user_id` is a foreign
  // key. A member billed for the first time may have no row yet -- provisional rows are
  // created here and overwritten with real names on their next sign-in.
  const memberIds = [...new Set(input.bills.map((b) => b.userId))];
  if (memberIds.length) {
    await prisma.discordMember.createMany({
      data: memberIds.map((discordUserId) => ({ discordUserId, username: discordUserId })),
      skipDuplicates: true,
    });
  }

  // Items, so every line can point at one. A product nobody has priced yet still gets a
  // row -- an unknown product must never fail a billing run, same rule as ingest.
  const lineKeys = [...new Set(input.bills.flatMap((b) => b.lines.map((l) => l.productKey)))];
  const existingItems = await prisma.item.findMany({
    where: { productKey: { in: lineKeys } },
    select: { id: true, productKey: true },
  });
  const itemIdByKey = new Map(existingItems.map((i) => [i.productKey, i.id]));

  for (const bill of input.bills) {
    for (const line of bill.lines) {
      if (itemIdByKey.has(line.productKey)) continue;
      const normalized = normalizeProduct(line.label);
      const item = await prisma.item.upsert({
        where: { productKey: line.productKey },
        create: {
          productKey: line.productKey,
          label: line.label,
          unreadable: normalized.unreadable,
        },
        // Never clobber a curated label or fee.
        update: {},
        select: { id: true },
      });
      itemIdByKey.set(line.productKey, item.id);
    }
  }

  // NON-BILLABLE OWNERS ARE DROPPED.
  //
  // `Profile.billable` marks the operator's own house profiles: their checkouts belong to
  // a person and still show on the site, but they never generate a fee. The bot has no
  // notion of the flag, so if this endpoint recorded what it sends verbatim, the operator
  // would find a charge on their own dashboard the first time one of their profiles hit
  // -- which is exactly the phantom $8 that showed up after the 8/7 backfill.
  //
  // The rule is deliberately narrow: drop a bill only when the member has profiles here
  // AND every one of them is non-billable. A member with no profiles on file yet is
  // BILLED, because a new profile the site hasn't seen is far likelier than a silent
  // debt being correct -- failing the other way would lose real money quietly.
  const profileOwners = await prisma.profile.findMany({
    where: { discordUserId: { in: memberIds } },
    select: { discordUserId: true, billable: true },
  });
  const nonBillableUsers = new Set<string>();
  for (const [userId, owned] of Map.groupBy(profileOwners, (p) => p.discordUserId!)) {
    if (owned.every((p) => !p.billable)) nonBillableUsers.add(userId);
  }

  const deliveryByUser = new Map(input.delivery.map((d) => [d.userId, d]));

  const run = await prisma.pasRun.upsert({
    where: { sessionId: input.sessionId },
    create: {
      sessionId: input.sessionId,
      windowStart: new Date(input.windowStartMs),
      windowEnd: new Date(input.windowEndMs),
      dropLabel: input.dropLabel,
      status: PasRunStatus.SENT,
      dryRun: input.dryRun,
      operatorId: input.operatorId,
      sentAt: input.sentAtMs ? new Date(input.sentAtMs) : new Date(),
    },
    // A re-post must not rewrite when the run happened.
    update: {},
    select: { id: true },
  });

  let created = 0;
  let existing = 0;
  let nonBillable = 0;

  for (const bill of input.bills) {
    // A skipped member was deliberately excluded from the run and owes nothing for it.
    if (bill.skip) continue;

    if (nonBillableUsers.has(bill.userId)) {
      nonBillable++;
      continue;
    }

    const before = await prisma.pasBill.findUnique({
      where: { pasRunId_discordUserId: { pasRunId: run.id, discordUserId: bill.userId } },
      select: { id: true },
    });
    if (before) {
      existing++;
      continue;
    }

    const delivery = deliveryByUser.get(bill.userId);
    await prisma.pasBill.create({
      data: {
        pasRunId: run.id,
        discordUserId: bill.userId,
        subtotalCents: bill.subtotalCents,
        discountCents: bill.discountCents,
        totalCents: bill.totalCents,
        ogApplied: bill.isOg,
        deliveryStatus: deliveryStatusOf(delivery?.status),
        dmMessageId: delivery?.messageId ?? null,
        deliveryError: delivery?.error ?? null,
        dmText: bill.message ?? null,
        lines: {
          create: bill.lines.map((line) => ({
            itemId: itemIdByKey.get(line.productKey)!,
            qty: line.qty,
            feeCents: line.feeCents,
            subtotalCents: line.subtotalCents,
            label: line.label,
          })),
        },
      },
    });
    created++;
  }

  return Response.json({
    sessionId: input.sessionId,
    runId: run.id,
    billsCreated: created,
    billsAlreadyPresent: existing,
    billsNonBillable: nonBillable,
    dryRun: input.dryRun,
  });
}

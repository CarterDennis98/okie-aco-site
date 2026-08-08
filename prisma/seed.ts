/**
 * Local development seed.
 *
 * Imports the bot's real PAS billing-run records so local data carries the actual
 * product names -- including the `é` and em-dash that surface UTF-8 and column-width
 * bugs early -- plus 66 real profiles and 147 real checkouts.
 *
 *   MIRROR_REPO_PATH=../okie-aco-mirror npx prisma db seed
 *
 * Idempotent: everything upserts on a natural key, so re-running is safe.
 *
 * Production data never comes from here. It arrives via /api/bot/checkouts.
 */
// Loads .env itself rather than relying on the Prisma CLI's process env reaching this
// child process, so `tsx prisma/seed.ts` also works standalone.
import "dotenv/config";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";
import { DeliveryStatus, PasRunStatus, ProfileStatus } from "../src/generated/prisma/enums";

const MIRROR_REPO =
  process.env.MIRROR_REPO_PATH ?? path.join(process.cwd(), "..", "okie-aco-mirror");
const SESSION_DIR = path.join(MIRROR_REPO, "data", "pas-sessions");
const PROFILE_MAP = path.join(MIRROR_REPO, "data", "profileMap.json");

// The only real billing runs so far were dry runs -- every DM went to the operator.
// The dashboard filters dry runs out of "unpaid fees", so seeding them truthfully
// would leave the local UI with nothing to render. We promote them here, and ONLY
// here, so there is realistic charge data to build against.
const PROMOTE_DRY_RUNS = true;

type SessionCheckout = {
  messageId: string;
  channelId: string;
  createdTimestamp: number;
  site: string | null;
  productRaw: string | null;
  productKey: string;
  productLabel: string;
  unreadableProduct: boolean;
  profileRaw: string | null;
  profileKey: string | null;
  profileIndex: number | null;
  quantity: number;
  quantityAssumed: boolean;
  flags: string[];
};

type SessionBill = {
  userId: string;
  profileKeys: string[];
  lines: {
    productKey: string;
    label: string;
    qty: number;
    feeCents: number;
    subtotalCents: number;
  }[];
  subtotalCents: number;
  isOg: boolean;
  discountCents: number;
  totalCents: number;
  message: string | null;
  skip: boolean;
  skipReason: string | null;
};

type Session = {
  id: string;
  operatorId: string;
  status: string;
  dryRun: boolean;
  window: { startMs: number; endMs: number; dropDateLabel: string };
  checkouts: SessionCheckout[];
  products: Record<
    string,
    { key: string; label: string; sites: string[]; unreadable: boolean; feeCents: number | null }
  >;
  profiles: Record<
    string,
    { key: string; rawNames: string[]; userId: string | null; resolution: string }
  >;
  bills: Record<string, SessionBill>;
  delivery: { results: { userId: string; status: string; messageId?: string; at: number }[] };
};

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

const DELIVERY_STATUS: Record<string, DeliveryStatus> = {
  sent: DeliveryStatus.SENT,
  skipped: DeliveryStatus.SKIPPED,
  "dms-closed": DeliveryStatus.DMS_CLOSED,
  "unknown-user": DeliveryStatus.UNKNOWN_USER,
  error: DeliveryStatus.ERROR,
};

function loadSessions(): Session[] {
  if (!existsSync(SESSION_DIR)) {
    console.error(`No session directory at ${SESSION_DIR}.`);
    console.error("Set MIRROR_REPO_PATH to the okie-aco-mirror checkout.");
    process.exit(1);
  }
  return (
    readdirSync(SESSION_DIR)
      .filter((f) => f.endsWith(".json"))
      .map((f) => JSON.parse(readFileSync(path.join(SESSION_DIR, f), "utf8")) as Session)
      // Oldest first, so a later run's data wins on conflict.
      .sort((a, b) => a.window.startMs - b.window.startMs)
  );
}

function loadIgnoreList(): string[] {
  if (!existsSync(PROFILE_MAP)) return [];
  const data = JSON.parse(readFileSync(PROFILE_MAP, "utf8")) as { ignore?: string[] };
  return data.ignore ?? [];
}

async function main() {
  const sessions = loadSessions();
  console.log(`Loaded ${sessions.length} session file(s) from ${SESSION_DIR}`);

  // --- Discord members ---------------------------------------------------
  // The session records carry user IDs but no usernames. For a local fixture we
  // synthesize the username from the profile that resolved to that user.
  const usernameByUserId = new Map<string, string>();
  const ogUserIds = new Set<string>();

  for (const session of sessions) {
    for (const profile of Object.values(session.profiles)) {
      if (profile.userId && !usernameByUserId.has(profile.userId)) {
        usernameByUserId.set(profile.userId, profile.key);
      }
    }
    for (const bill of Object.values(session.bills)) {
      if (bill.isOg) ogUserIds.add(bill.userId);
      if (!usernameByUserId.has(bill.userId))
        usernameByUserId.set(bill.userId, `member-${bill.userId.slice(-4)}`);
    }
    if (!usernameByUserId.has(session.operatorId))
      usernameByUserId.set(session.operatorId, "okie-operator");
  }

  for (const [discordUserId, username] of usernameByUserId) {
    await prisma.discordMember.upsert({
      where: { discordUserId },
      create: {
        discordUserId,
        username,
        isOg: ogUserIds.has(discordUserId),
        joinedAt: new Date("2026-04-01T05:00:00Z"),
      },
      update: { username, isOg: ogUserIds.has(discordUserId) },
    });
  }
  console.log(`  members:  ${usernameByUserId.size} (${ogUserIds.size} OG)`);

  // --- Items -------------------------------------------------------------
  const itemIdByKey = new Map<string, string>();
  for (const session of sessions) {
    for (const product of Object.values(session.products)) {
      const item = await prisma.item.upsert({
        where: { productKey: product.key },
        create: {
          productKey: product.key,
          label: product.label,
          source: product.sites[0] ?? null,
          unreadable: product.unreadable,
          currentFeeCents: product.feeCents,
        },
        update: { label: product.label, currentFeeCents: product.feeCents ?? undefined },
      });
      itemIdByKey.set(product.key, item.id);
    }
  }
  console.log(`  items:    ${itemIdByKey.size}`);

  // --- Profiles ----------------------------------------------------------
  const ignore = loadIgnoreList();
  for (const profileKey of ignore) {
    await prisma.profile.upsert({
      where: { profileKey },
      create: { profileKey, displayName: profileKey, status: ProfileStatus.IGNORED },
      update: { status: ProfileStatus.IGNORED, discordUserId: null },
    });
  }

  let profileCount = 0;
  for (const session of sessions) {
    for (const profile of Object.values(session.profiles)) {
      if (ignore.includes(profile.key)) continue;
      const mapped = Boolean(profile.userId) && profile.resolution !== "ignored";
      await prisma.profile.upsert({
        where: { profileKey: profile.key },
        create: {
          profileKey: profile.key,
          displayName: profile.rawNames[0] ?? profile.key,
          discordUserId: mapped ? profile.userId : null,
          status: mapped ? ProfileStatus.MAPPED : ProfileStatus.UNMAPPED,
          mappedAt: mapped ? new Date() : null,
          mappedBy: mapped ? `seed:${profile.resolution}` : null,
        },
        update: mapped ? { discordUserId: profile.userId, status: ProfileStatus.MAPPED } : {},
      });
      profileCount++;
    }
  }
  console.log(`  profiles: ${profileCount} (+${ignore.length} ignored)`);

  // --- Checkouts ---------------------------------------------------------
  // Deduped by discordMessageId; the two sessions cover the same window.
  let checkoutCount = 0;
  for (const session of sessions) {
    for (const checkout of session.checkouts) {
      const profileExists = checkout.profileKey && !ignore.includes(checkout.profileKey);
      await prisma.checkout.upsert({
        where: { discordMessageId: checkout.messageId },
        create: {
          discordMessageId: checkout.messageId,
          discordChannelId: checkout.channelId,
          // Historical rows predate order-ID capture; that's the cost of backfilling
          // from the mirrored channel rather than the raw vendor embeds.
          orderId: null,
          sourceBot: "unknown",
          occurredAt: new Date(checkout.createdTimestamp),
          site: checkout.site,
          productRaw: checkout.productRaw,
          productKey: checkout.productKey,
          itemId: itemIdByKey.get(checkout.productKey) ?? null,
          profileRaw: checkout.profileRaw,
          profileKey: profileExists ? checkout.profileKey : null,
          profileIndex: checkout.profileIndex,
          quantity: checkout.quantity,
          quantityAssumed: checkout.quantityAssumed,
          flags: checkout.flags,
          rawEmbed: undefined,
        },
        update: {},
      });
      checkoutCount++;
    }
  }
  console.log(`  checkouts: ${checkoutCount}`);

  // --- Billing runs ------------------------------------------------------
  let billCount = 0;
  for (const session of sessions) {
    if (session.status !== "sent") continue;

    const deliveryByUser = new Map(session.delivery.results.map((r) => [r.userId, r]));

    const run = await prisma.pasRun.upsert({
      where: { sessionId: session.id },
      create: {
        sessionId: session.id,
        windowStart: new Date(session.window.startMs),
        windowEnd: new Date(session.window.endMs),
        dropLabel: session.window.dropDateLabel,
        status: PasRunStatus.SENT,
        dryRun: PROMOTE_DRY_RUNS ? false : session.dryRun,
        operatorId: session.operatorId,
        sentAt: new Date(session.delivery.results[0]?.at ?? session.window.endMs),
      },
      update: {},
    });

    for (const bill of Object.values(session.bills)) {
      const delivery = deliveryByUser.get(bill.userId);
      const lines = bill.lines.filter((line) => itemIdByKey.has(line.productKey));

      await prisma.pasBill.upsert({
        where: { pasRunId_discordUserId: { pasRunId: run.id, discordUserId: bill.userId } },
        create: {
          pasRunId: run.id,
          discordUserId: bill.userId,
          subtotalCents: bill.subtotalCents,
          discountCents: bill.discountCents,
          totalCents: bill.totalCents,
          ogApplied: bill.isOg,
          deliveryStatus: DELIVERY_STATUS[delivery?.status ?? ""] ?? DeliveryStatus.PENDING,
          dmMessageId: delivery?.messageId ?? null,
          dmText: bill.message,
          lines: {
            create: lines.map((line) => ({
              itemId: itemIdByKey.get(line.productKey)!,
              qty: line.qty,
              feeCents: line.feeCents,
              subtotalCents: line.subtotalCents,
              label: line.label,
            })),
          },
        },
        update: {},
      });
      billCount++;
    }
  }
  console.log(`  bills:    ${billCount}`);

  // --- Testimonials ------------------------------------------------------
  const testimonials = [
    {
      body: "Been with Okie since the start. Hit every Series 3 restock I actually wanted.",
      attribution: "OG member",
      sortOrder: 1,
    },
    {
      body: "Fees are fair and I always know exactly what I owe. No guessing.",
      attribution: "Member since May",
      sortOrder: 2,
    },
    {
      body: "Checked out 4 First Partner boxes while I was asleep. Woke up to the DM.",
      attribution: "Member",
      sortOrder: 3,
    },
  ];
  for (const t of testimonials) {
    const existing = await prisma.testimonial.findFirst({ where: { body: t.body } });
    if (!existing) await prisma.testimonial.create({ data: { ...t, approved: true } });
  }
  console.log(`  testimonials: ${testimonials.length}`);
}

main()
  .then(async () => {
    await prisma.$disconnect();
    console.log("Seed complete.");
  })
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });

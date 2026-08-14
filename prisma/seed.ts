/**
 * Local development seed.
 *
 * Three real sources from the bot repo, none invented:
 *
 *   data/pas-sessions/*.json    billing runs -- fees, profile->user mappings, OG flags,
 *                               and the bills themselves
 *   data/checkouts-export.json  a wider window of raw checkouts so the drops UI has
 *                               several weeks of history
 *                               (node src/scripts/exportCheckouts.js <since>)
 *   data/thumbnails.json        product art for rows that predate thumbnail capture
 *                               (node src/scripts/exportThumbnails.js)
 *
 *   MIRROR_REPO_PATH=../okie-aco-mirror npx prisma db seed
 *
 * Idempotent: upserts on natural keys, so re-running is safe.
 * Production data never comes from here -- it arrives via /api/bot/checkouts.
 */
import "dotenv/config";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";
import { DeliveryStatus, PasRunStatus, ProfileStatus } from "../src/generated/prisma/enums";
import { findMapping, isIgnored, type MappingEntry } from "../src/lib/normalize";

const MIRROR_REPO =
  process.env.MIRROR_REPO_PATH ?? path.join(process.cwd(), "..", "okie-aco-mirror");
const SESSION_DIR = path.join(MIRROR_REPO, "data", "pas-sessions");
const PROFILE_MAP = path.join(MIRROR_REPO, "data", "profileMap.json");
const THUMBNAILS = path.join(MIRROR_REPO, "data", "thumbnails.json");
const CHECKOUTS_EXPORT = path.join(MIRROR_REPO, "data", "checkouts-export.json");

// The only real billing runs so far were dry runs -- every DM went to the operator.
// The dashboard filters dry runs out of "unpaid fees", so seeding them truthfully
// would leave the local UI with nothing to render. Promoted here, and ONLY here.
const PROMOTE_DRY_RUNS = true;

type RawCheckout = {
  messageId: string;
  channelId: string;
  createdTimestamp: number;
  site: string | null;
  productRaw: string | null;
  productKey: string;
  productLabel: string;
  profileRaw: string | null;
  profileKey: string | null;
  profileIndex: number | null;
  quantity: number;
  quantityAssumed: boolean;
  flags: string[];
  thumbnailUrl?: string | null;
};

type SessionBill = {
  userId: string;
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
};

type Session = {
  id: string;
  operatorId: string;
  status: string;
  dryRun: boolean;
  window: { startMs: number; endMs: number; dropDateLabel: string };
  checkouts: RawCheckout[];
  products: Record<string, { key: string; label: string; feeCents: number | null }>;
  profiles: Record<string, { key: string; userId: string | null }>;
  bills: Record<string, SessionBill>;
  delivery: { results: { userId: string; status: string; messageId?: string; at: number }[] };
};

// timezone=UTC for the same reason as src/db/client.ts: Prisma sends naive timestamps
// and Postgres resolves them against the session timezone.
const adapter = new PrismaPg({
  connectionString: process.env.DATABASE_URL,
  options: "-c timezone=UTC",
});
const prisma = new PrismaClient({ adapter });

const DELIVERY_STATUS: Record<string, DeliveryStatus> = {
  sent: DeliveryStatus.SENT,
  skipped: DeliveryStatus.SKIPPED,
  "dms-closed": DeliveryStatus.DMS_CLOSED,
  "unknown-user": DeliveryStatus.UNKNOWN_USER,
  error: DeliveryStatus.ERROR,
};

function readJson<T>(file: string, fallback: T): T {
  if (!existsSync(file)) return fallback;
  return JSON.parse(readFileSync(file, "utf8")) as T;
}

function loadSessions(): Session[] {
  if (!existsSync(SESSION_DIR)) {
    console.error(`No session directory at ${SESSION_DIR}.`);
    console.error("Set MIRROR_REPO_PATH to the okie-aco-mirror checkout.");
    process.exit(1);
  }
  return readdirSync(SESSION_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(path.join(SESSION_DIR, f), "utf8")) as Session)
    .sort((a, b) => a.window.startMs - b.window.startMs);
}

async function main() {
  const sessions = loadSessions();
  const thumbnails = readJson<Record<string, string>>(THUMBNAILS, {});
  const exported = readJson<{ checkouts: RawCheckout[] }>(CHECKOUTS_EXPORT, { checkouts: [] });
  const profileMapFile = readJson<{ ignore?: string[]; map?: Record<string, MappingEntry> }>(
    PROFILE_MAP,
    {},
  );
  const ignore = (profileMapFile.ignore ?? []).map((n) => n.toLowerCase());
  const mappings = profileMapFile.map ?? {};

  console.log(`Sessions: ${sessions.length} · exported checkouts: ${exported.checkouts.length}`);

  // --- Unified checkout list ---------------------------------------------
  // Deduped by Discord message id, the same natural key ingest uses.
  const byId = new Map<string, RawCheckout>();
  for (const session of sessions) {
    for (const c of session.checkouts) {
      byId.set(c.messageId, { ...c, thumbnailUrl: thumbnails[c.messageId] ?? null });
    }
  }
  for (const c of exported.checkouts) {
    // Export wins: it carries a thumbnail inline.
    byId.set(c.messageId, { ...byId.get(c.messageId), ...c });
  }
  const checkouts = [...byId.values()];

  // --- Discord members ----------------------------------------------------
  // Session records carry user IDs but no usernames; synthesize from the profile that
  // resolved to that user. Only profiles seen in a billing run have a user at all --
  // the rest stay unmapped, which is the real situation.
  const usernameByUserId = new Map<string, string>();
  const ogUserIds = new Set<string>();
  const userIdByProfileKey = new Map<string, string>();

  for (const session of sessions) {
    for (const profile of Object.values(session.profiles)) {
      if (!profile.userId) continue;
      userIdByProfileKey.set(profile.key, profile.userId);
      if (!usernameByUserId.has(profile.userId)) usernameByUserId.set(profile.userId, profile.key);
    }
    for (const bill of Object.values(session.bills)) {
      if (bill.isOg) ogUserIds.add(bill.userId);
      if (!usernameByUserId.has(bill.userId))
        usernameByUserId.set(bill.userId, `member-${bill.userId.slice(-4)}`);
    }
    if (!usernameByUserId.has(session.operatorId))
      usernameByUserId.set(session.operatorId, "okie-operator");
  }
  // Any user named by an explicit mapping must exist before profiles reference them.
  for (const entry of Object.values(mappings)) {
    if (!usernameByUserId.has(entry.userId)) usernameByUserId.set(entry.userId, "okie-operator");
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
      // CREATE ONLY -- deliberately a no-op update.
      //
      // Every field above is either synthesized (the username is a checkout profile
      // key like "target 9", not a Discord handle) or better known to Discord (isOg
      // comes from live roles, joinedAt from the guild member object). Signing in runs
      // syncDiscordMember, which writes the real values; an `update` here would clobber
      // them on the next re-seed and leave syncedAt still pointing at the sign-in, so
      // the damage looks like it never happened.
      //
      // Cost: re-seeding won't refresh isOg for a member who has never signed in. Use
      // `npm run db:reset && npm run db:seed` when you need that re-derived.
      update: {},
    });
  }
  console.log(`  members  : ${usernameByUserId.size} (${ogUserIds.size} OG)`);

  // --- Items --------------------------------------------------------------
  const feeByProductKey = new Map<string, number>();
  for (const session of sessions) {
    for (const p of Object.values(session.products)) {
      if (p.feeCents !== null) feeByProductKey.set(p.key, p.feeCents);
    }
  }

  const itemSeed = new Map<string, { label: string; site: string | null; image: string | null }>();
  for (const c of checkouts) {
    const existing = itemSeed.get(c.productKey);
    itemSeed.set(c.productKey, {
      label: existing?.label ?? c.productLabel,
      site: existing?.site ?? c.site,
      image: existing?.image ?? c.thumbnailUrl ?? null,
    });
  }

  const itemIdByKey = new Map<string, string>();
  for (const [productKey, meta] of itemSeed) {
    const item = await prisma.item.upsert({
      where: { productKey },
      create: {
        productKey,
        label: meta.label,
        source: meta.site,
        imageUrl: meta.image,
        currentFeeCents: feeByProductKey.get(productKey) ?? null,
      },
      update: {
        label: meta.label,
        imageUrl: meta.image ?? undefined,
        currentFeeCents: feeByProductKey.get(productKey) ?? undefined,
      },
    });
    itemIdByKey.set(productKey, item.id);
  }
  console.log(`  items    : ${itemIdByKey.size}`);

  // --- Profiles -----------------------------------------------------------
  for (const profileKey of ignore) {
    await prisma.profile.upsert({
      where: { profileKey },
      create: { profileKey, displayName: profileKey, status: ProfileStatus.IGNORED },
      update: { status: ProfileStatus.IGNORED, discordUserId: null },
    });
  }

  const profileNames = new Map<string, string>();
  for (const c of checkouts) {
    if (!c.profileKey || isIgnored(c.profileKey, ignore)) continue;
    if (!profileNames.has(c.profileKey))
      profileNames.set(c.profileKey, c.profileRaw ?? c.profileKey);
  }

  let mapped = 0;
  let unbilled = 0;
  // Who legitimately owes anything. Archived sessions predate the `billable` flag, so
  // they contain bills the operator's own house profiles were charged before those
  // profiles were marked non-billable. Replaying such a bill would invent a debt.
  const billableUserIds = new Set<string>();
  for (const [profileKey, displayName] of profileNames) {
    // Explicit mapping (exact or family) wins over what a billing run inferred.
    const explicit = findMapping(profileKey, mappings);
    const userId = explicit?.userId ?? userIdByProfileKey.get(profileKey) ?? null;
    const billable = explicit ? explicit.billable !== false : true;
    if (userId) mapped++;
    if (!billable) unbilled++;
    if (userId && billable) billableUserIds.add(userId);
    await prisma.profile.upsert({
      where: { profileKey },
      create: {
        profileKey,
        displayName,
        discordUserId: userId,
        status: userId ? ProfileStatus.MAPPED : ProfileStatus.UNMAPPED,
        billable,
        mappedAt: userId ? new Date() : null,
        mappedBy: userId ? (explicit ? `seed:${explicit.matchedBy}` : "seed:session") : null,
      },
      update: userId
        ? { discordUserId: userId, status: ProfileStatus.MAPPED, billable }
        : { billable },
    });
  }
  console.log(
    `  profiles : ${profileNames.size} (${mapped} mapped, ${profileNames.size - mapped} unmapped, ${unbilled} non-billable, ${ignore.length} ignored)`,
  );

  // --- Checkouts ----------------------------------------------------------
  // House profiles (pkc 1..30, walmart 87, ...) are the operator's own -- excluded
  // from billing, the public feed and the stats, same as before but by family.
  const billable = checkouts.filter((c) => !isIgnored(c.profileKey, ignore));
  await prisma.checkout.createMany({
    data: billable.map((c) => ({
      discordMessageId: c.messageId,
      discordChannelId: c.channelId,
      // Mirrored embeds carry no order id -- only the raw vendor channels do.
      orderId: null,
      sourceBot: "mirror",
      occurredAt: new Date(c.createdTimestamp),
      site: c.site,
      productRaw: c.productRaw,
      productKey: c.productKey,
      itemId: itemIdByKey.get(c.productKey) ?? null,
      imageUrl: c.thumbnailUrl ?? null,
      profileRaw: c.profileRaw,
      profileKey: c.profileKey,
      profileIndex: c.profileIndex,
      quantity: c.quantity,
      quantityAssumed: c.quantityAssumed,
      flags: c.flags ?? [],
    })),
    skipDuplicates: true,
  });
  const withImages = billable.filter((c) => c.thumbnailUrl).length;
  console.log(`  checkouts: ${billable.length} (${withImages} with images)`);

  // --- Billing runs -------------------------------------------------------
  let billCount = 0;
  let staleBills = 0;
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
      // Every profile this member owns is non-billable -- the charge is a replay
      // artifact from before the flag existed, not a debt. See `billableUserIds`.
      if (!billableUserIds.has(bill.userId)) {
        staleBills++;
        continue;
      }
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
  console.log(
    `  bills    : ${billCount}${staleBills ? ` (${staleBills} skipped -- non-billable profiles)` : ""}`,
  );

  // --- Testimonials -------------------------------------------------------
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
      body: "Four First Partner boxes secured on a drop I would have missed entirely.",
      attribution: "Member",
      sortOrder: 3,
    },
  ];
  await prisma.testimonial.deleteMany({ where: { source: "MANUAL" } });
  await prisma.testimonial.createMany({
    data: testimonials.map((t) => ({ ...t, approved: true })),
  });
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

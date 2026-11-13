import { prisma } from "@/db/client";
import { authorizeBot } from "@/lib/bot-auth";
import { normalizeProfile } from "@/lib/normalize";
import { siteKey } from "@/lib/sites";
import { cleanSince, matchFailureProfile } from "@/lib/vault/failure-flags";
import { failureBatch } from "@/types/ingest";

/**
 * Failed-checkout ingest. The bot posts here as it mirrors a decline, a cancelled order or a
 * checkout error into the failures channel, and each is matched to the profile it ran on so
 * that profile is flagged on its owner's page (lib/vault/failure-flags.ts).
 *
 * IDEMPOTENT, like checkouts: `discordMessageId` is unique and the insert skips duplicates, so
 * a retried or replayed batch is always safe and says how much of it was already known.
 *
 * NEVER BILLED. These rows are nowhere near `checkouts`; see CheckoutFailure in the schema.
 *
 * MATCHING, per failure: the retailer is siteKey(site), the same reading every other page
 * makes, and the profile is the one there whose name keys the way the failure's does, through
 * the checkout pipeline's own normalizer. Ambiguous or unknown means unmatched -- stored, and
 * flagging nobody. A failure from before the profile's last change (or before it existed)
 * arrives already cleared: it ran on details that are gone.
 *
 * A failure that matches nothing is not an error, and nothing here fails a batch over one: an
 * operator's house profile kept off the site, a retailer no member has profiles on yet
 * (Hayha's "Demandware" posts), or a profile deleted since.
 */
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  // Before the body is read, as on every bot endpoint.
  const auth = authorizeBot(request);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Body is not JSON" }, { status: 400 });
  }

  const parsed = failureBatch.safeParse(body);
  if (!parsed.success) {
    // Paths and messages only, never the payload; logged because the bot prints no body.
    const issues = parsed.error.issues.slice(0, 10).map((i) => ({
      path: i.path.join("."),
      message: i.message,
    }));
    console.warn(`bot failures: rejected a batch: ${JSON.stringify(issues)}`);
    return Response.json({ error: "Invalid payload", issues }, { status: 400 });
  }

  // Last writer wins within a batch, as for checkouts.
  const failures = [...new Map(parsed.data.failures.map((f) => [f.discordMessageId, f])).values()];

  const rows = failures.map((input) => ({
    input,
    occurredAt: new Date(input.occurredAt),
    site: input.site ? siteKey(input.site) : null,
    profile: normalizeProfile(input.profileRaw),
  }));

  // Every profile that could be one of these, in one read: same retailer, same name key.
  const pairs = new Map<string, { siteKey: string; profileKey: string }>();
  for (const row of rows) {
    if (row.site && row.profile) {
      pairs.set(`${row.site}\u0000${row.profile.profileKey}`, {
        siteKey: row.site,
        profileKey: row.profile.profileKey,
      });
    }
  }
  const candidates =
    pairs.size > 0
      ? await prisma.vaultProfile.findMany({
          where: { OR: [...pairs.values()] },
          select: {
            id: true,
            siteKey: true,
            name: true,
            profileKey: true,
            profileIndex: true,
            createdAt: true,
            failuresClearedAt: true,
          },
        })
      : [];

  let matched = 0;
  const data = rows.map(({ input, occurredAt, site, profile }) => {
    const match = profile
      ? matchFailureProfile(
          candidates.filter(
            (c) =>
              c.siteKey === site &&
              c.profileKey === profile.profileKey &&
              c.profileIndex === profile.profileIndex,
          ),
          input.profileRaw,
        )
      : null;
    if (match) matched++;

    const since = match ? cleanSince(match) : null;
    return {
      sourceBot: input.sourceBot,
      discordMessageId: input.discordMessageId,
      discordChannelId: input.discordChannelId,
      occurredAt,
      site: input.site ?? null,
      siteKey: site,
      orderId: input.orderId ?? null,
      productRaw: input.productRaw ?? null,
      profileRaw: profile?.profileRaw ?? input.profileRaw ?? null,
      reason: input.reason ?? null,
      vaultProfileId: match?.id ?? null,
      clearedAt: since && occurredAt <= since ? since : null,
    };
  });

  const result = await prisma.checkoutFailure.createMany({ data, skipDuplicates: true });

  return Response.json({
    inserted: result.count,
    duplicates: data.length - result.count,
    matched,
    received: parsed.data.failures.length,
  });
}

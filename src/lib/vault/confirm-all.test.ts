/**
 * "Confirm all" on one tab of the pending-changes queue.
 *
 * The properties it was allowed in on: it confirms ONE bucket, only what the page showed
 * (nothing made after it was drawn, and nothing at all if the count moved), and only within
 * the queue the viewer had open -- a runner never reaches another runner's changes.
 *
 * Faked: who is signed in, and Next's cache revalidation. Everything else is the real
 * database.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/db/client";
import { VaultAction, VaultEntity } from "@/generated/prisma/enums";
import type { AdminSites } from "@/lib/auth/admin-scope";
import { confirmAllPendingChanges } from "@/lib/vault/site-admin-actions";
import { EMAIL_BUCKET } from "@/lib/vault/pending-filter";

const asking = vi.hoisted(() => ({
  viewer: { discordUserId: "", adminSites: "all" as AdminSites, isAdmin: true },
}));
vi.mock("@/lib/auth/guard", () => ({ requireAnyAdmin: async () => asking.viewer }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

const canRun = Boolean(process.env.DATABASE_URL);

const OPERATOR = "999900000000000701";
const RUNNER = "999900000000000702";
const MEMBER = "999900000000000711";
const PREFIX = "confirm-all-spec-";

// Every change here is from 2000, and the page is "drawn" the day after: the cutoff then
// keeps whatever real changes the database already holds out of every count, so the tests
// neither depend on them nor confirm them.
const MADE = new Date("2000-01-01T00:00:00.000Z");
const SEEN = "2000-01-02T00:00:00.000Z";

async function change(label: string, siteKey: string | null, assigneeId: string | null, at = MADE) {
  return prisma.vaultChange.create({
    data: {
      actorDiscordId: MEMBER,
      ownerDiscordId: MEMBER,
      entity: siteKey ? VaultEntity.VAULT_PROFILE : VaultEntity.EMAIL_CREDENTIAL,
      entityId: `${PREFIX}${label}`,
      action: VaultAction.UPDATE,
      siteKey,
      assigneeId,
      label: `${PREFIX}${label}`,
      at,
    },
    select: { id: true },
  });
}

function form(fields: Record<string, string | number>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, String(value));
  return data;
}

const confirmedLabels = async () =>
  (
    await prisma.vaultChange.findMany({
      where: { label: { startsWith: PREFIX }, appliedAt: { not: null } },
      select: { label: true },
    })
  )
    .map((c) => c.label!.slice(PREFIX.length))
    .sort();

describe.skipIf(!canRun)("confirmAllPendingChanges", () => {
  beforeAll(cleanup);
  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });
  beforeEach(async () => {
    await cleanup();
    await change("target-1", "target", OPERATOR);
    await change("target-2", "target", OPERATOR);
    await change("target-runner", "target", RUNNER);
    await change("walmart-1", "walmart", OPERATOR);
    await change("mailbox", null, null);
    asking.viewer = { discordUserId: OPERATOR, adminSites: "all", isAdmin: true };
  });

  it("confirms one retailer's tab of the queue that was open, and nothing else", async () => {
    // A full admin's own view: their assignments, plus the mailbox changes nobody runs.
    const result = await confirmAllPendingChanges(
      form({ bucket: "target", seenAt: SEEN, expected: 2 }),
    );
    expect(result).toEqual({ ok: true, applied: 2 });
    expect(await confirmedLabels()).toEqual(["target-1", "target-2"]);
  });

  it("covers every runner's changes only when everyone's queue was the one open", async () => {
    const result = await confirmAllPendingChanges(
      form({ bucket: "target", seenAt: SEEN, expected: 3, runner: "all" }),
    );
    expect(result).toEqual({ ok: true, applied: 3 });
  });

  it("confirms the mailbox bucket as its own tab", async () => {
    const result = await confirmAllPendingChanges(
      form({ bucket: EMAIL_BUCKET, seenAt: SEEN, expected: 1 }),
    );
    expect(result).toEqual({ ok: true, applied: 1 });
    expect(await confirmedLabels()).toEqual(["mailbox"]);
  });

  it("refuses the whole click when the tab's count has moved", async () => {
    const result = await confirmAllPendingChanges(
      form({ bucket: "target", seenAt: SEEN, expected: 3 }),
    );
    expect(result).toMatchObject({ ok: false });
    expect(await confirmedLabels()).toEqual([]);
  });

  it("leaves a change made after the page was drawn for the next look", async () => {
    await change("target-late", "target", OPERATOR, new Date("2000-01-03T00:00:00.000Z"));
    const result = await confirmAllPendingChanges(
      form({ bucket: "target", seenAt: SEEN, expected: 2 }),
    );
    expect(result).toEqual({ ok: true, applied: 2 });
    expect(await confirmedLabels()).toEqual(["target-1", "target-2"]);
  });

  it("keeps a runner to their own queue whatever they ask for", async () => {
    asking.viewer = { discordUserId: RUNNER, adminSites: ["target"], isAdmin: false };
    const asked = await confirmAllPendingChanges(
      form({ bucket: "target", seenAt: SEEN, expected: 3, runner: "all" }),
    );
    expect(asked).toMatchObject({ ok: false });
    const own = await confirmAllPendingChanges(
      form({ bucket: "target", seenAt: SEEN, expected: 1 }),
    );
    expect(own).toEqual({ ok: true, applied: 1 });
    expect(await confirmedLabels()).toEqual(["target-runner"]);
  });

  it("refuses a request that isn't the shape it expects", async () => {
    expect(
      await confirmAllPendingChanges(form({ bucket: "target", seenAt: "yesterday", expected: 2 })),
    ).toMatchObject({
      ok: false,
    });
    expect(
      await confirmAllPendingChanges(form({ bucket: "", seenAt: SEEN, expected: 2 })),
    ).toMatchObject({
      ok: false,
    });
  });
});

async function cleanup() {
  await prisma.vaultChange.deleteMany({ where: { label: { startsWith: PREFIX } } });
  // Each confirm writes an audit row as one of these made-up admins.
  await prisma.adminAudit.deleteMany({ where: { actorDiscordId: { in: [OPERATOR, RUNNER] } } });
}

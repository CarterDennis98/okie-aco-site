/**
 * Reordering a member's profiles, end to end.
 *
 * What only the action can decide, pinned against the real database: the names land in the
 * dragged order, the swap gets past (site, name) uniqueness, a name another member holds is
 * stepped over, the profile key moves with the name, and nothing is written for an order
 * that isn't exactly the member's own profiles.
 *
 * Faked: who is signed in (the guard reads a session cookie that can't exist outside a
 * request), Next's cache revalidation, and the operator notification -- which would
 * otherwise post to the real vault webhook the local .env points at. No card is decrypted,
 * so the ciphertext columns hold placeholders.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/db/client";
import { reorderProfiles } from "@/lib/vault/actions";

const MEMBER = "999900000000000901";
const OTHER = "999900000000000902";
const RUNNER = "999900000000000903";
const SITE = "topps";
const STEM = "reorderspec";

vi.mock("@/lib/auth/guard", () => ({
  requireMember: async () => ({
    discordUserId: "999900000000000901",
    username: "reorderspec",
    displayName: "Reorder Spec",
    avatarUrl: null,
    isOg: false,
    isAdmin: false,
    adminSites: [],
  }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

const notified = vi.hoisted(() => ({
  calls: [] as {
    changes: { entityId: string; label: string; fields?: string[]; assigneeId: string | null }[];
    summary: string;
  }[],
}));
vi.mock("@/lib/vault/audit", () => ({
  recordBulkChange: async (
    changes: { entityId: string; label: string; fields?: string[]; assigneeId: string | null }[],
    _actor: string,
    summary: string,
  ) => {
    notified.calls.push({ changes, summary });
  },
  recordChange: async () => {},
  changedFields: () => [],
}));

const canRun = Boolean(process.env.DATABASE_URL);

async function profile(owner: string, name: string) {
  const account = await prisma.vaultAccount.create({
    data: {
      siteKey: SITE,
      email: `${name.replace(/\W+/g, "-")}@reorder-spec.example.com`,
      discordUserId: owner,
      assigneeId: RUNNER,
    },
  });
  const created = await prisma.vaultProfile.create({
    data: {
      siteKey: SITE,
      discordUserId: owner,
      name,
      profileKey: STEM,
      accountId: account.id,
      firstName: "Test",
      lastName: "Member",
      shipLine1: "1 Main St",
      shipCity: "Tulsa",
      shipState: "OK",
      shipPostalCode: "74103",
      cardBrand: "visa",
      cardLast4: "4242",
      cardExpMonth: "12",
      cardExpYear: "2030",
      cardNumberEnc: "placeholder",
      cardCvvEnc: "placeholder",
    },
  });
  return created.id;
}

const nameOf = async (id: string) =>
  prisma.vaultProfile.findUniqueOrThrow({
    where: { id },
    select: { name: true, profileKey: true, profileIndex: true },
  });

async function cleanup() {
  const owners = { in: [MEMBER, OTHER] };
  await prisma.vaultProfile.deleteMany({ where: { discordUserId: owners } });
  await prisma.vaultAccount.deleteMany({ where: { discordUserId: owners } });
  await prisma.discordMember.deleteMany({ where: { discordUserId: owners } });
}

describe.skipIf(!canRun)("reorderProfiles", () => {
  // The member's three, with a gap where "- 3" would be: another member holds it.
  let first: string;
  let second: string;
  let fourth: string;

  beforeEach(async () => {
    await cleanup();
    notified.calls = [];
    await prisma.discordMember.createMany({
      data: [MEMBER, OTHER].map((discordUserId) => ({
        discordUserId,
        username: `reorder-spec-${discordUserId.slice(-3)}`,
        roles: [],
      })),
    });
    first = await profile(MEMBER, STEM);
    second = await profile(MEMBER, `${STEM} - 2`);
    fourth = await profile(MEMBER, `${STEM} - 4`);
    await profile(OTHER, `${STEM} - 3`);
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  it("renames into the dragged order, past uniqueness and another member's name", async () => {
    // Every name moves onto one another profile held a moment ago -- the swap a single
    // pass of updates could not make.
    const result = await reorderProfiles({ siteKey: SITE, order: [fourth, first, second] });
    expect(result).toEqual({ ok: true, renamed: 3 });

    expect(await nameOf(fourth)).toEqual({ name: STEM, profileKey: STEM, profileIndex: null });
    expect(await nameOf(first)).toEqual({ name: `${STEM} - 2`, profileKey: STEM, profileIndex: 2 });
    // "- 3" is the other member's, so the third position steps over it.
    expect(await nameOf(second)).toEqual({
      name: `${STEM} - 4`,
      profileKey: STEM,
      profileIndex: 4,
    });

    // One notification, one queue entry per renamed profile, naming both names for the runner.
    expect(notified.calls).toHaveLength(1);
    const changes = notified.calls[0].changes;
    expect(changes.map((c) => c.label).sort()).toEqual([
      `${STEM} - 2 → ${STEM} - 4`,
      `${STEM} - 4 → ${STEM}`,
      `${STEM} → ${STEM} - 2`,
    ]);
    expect(changes.every((c) => c.fields?.join() === "name" && c.assigneeId === RUNNER)).toBe(true);
  });

  it("writes and records nothing when no name changes", async () => {
    const result = await reorderProfiles({ siteKey: SITE, order: [first, second, fourth] });
    expect(result).toEqual({ ok: true, renamed: 0 });
    expect(notified.calls).toHaveLength(0);
    expect((await nameOf(fourth)).name).toBe(`${STEM} - 4`);
  });

  it("refuses an order that isn't exactly the member's profiles", async () => {
    const theirs = (
      await prisma.vaultProfile.findFirstOrThrow({
        where: { discordUserId: OTHER },
        select: { id: true },
      })
    ).id;

    for (const order of [
      [fourth, first], // one left out, as if added in another tab
      [fourth, first, second, theirs], // somebody else's
      [fourth, first, theirs], // swapped for somebody else's
      [fourth, first, first], // one twice
    ]) {
      const result = await reorderProfiles({ siteKey: SITE, order });
      expect(result.ok).toBe(false);
    }

    expect(notified.calls).toHaveLength(0);
    expect((await nameOf(first)).name).toBe(STEM);
    expect((await nameOf(theirs)).name).toBe(`${STEM} - 3`);
  });

  it("refuses a retailer it can't reorder", async () => {
    expect((await reorderProfiles({ siteKey: "costco", order: [] })).ok).toBe(false);
    expect((await reorderProfiles({ siteKey: "nowhere", order: [] })).ok).toBe(false);
  });
});

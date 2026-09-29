/**
 * Vault reads, scoped to one runner.
 *
 * The property under test is the one the whole assignment model rests on: a runner reads
 * the profiles assigned to them and nothing else -- not the roster, not a member's table,
 * not the counts, not the change queue. The queries do not check authorization themselves;
 * the pages hand them a scope from `vaultScopeFor`, so this pins that every predicate they
 * are handed is actually applied.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/db/client";
import {
  getMemberVaultForAdmin,
  getMembersForSite,
  getPendingChangeCount,
  getPendingChanges,
  getVaultSites,
} from "@/db/queries/admin-vault";
import { VaultAction, VaultEntity } from "@/generated/prisma/enums";
import type { VaultScope } from "@/lib/auth/admin-scope";

const canRun = Boolean(process.env.DATABASE_URL);

// Target, for its soft cap of five: the backup split is counted per runner.
const SITE = "target";
const ALICE = "999900000000000121";
const BOB = "999900000000000122";
const MEMBER = "999900000000000111";
const OTHER = "999900000000000112";

const alice: VaultScope = { sites: [SITE], assigneeId: ALICE };
const bob: VaultScope = { sites: [SITE], assigneeId: BOB };

const PREFIX = "scope-test-";

/** One profile and its account, assigned to `runner`. */
async function profile(owner: string, runner: string, name: string) {
  const account = await prisma.vaultAccount.create({
    data: {
      siteKey: SITE,
      email: `${PREFIX}${name}@example.com`,
      discordUserId: owner,
      assigneeId: runner,
    },
  });
  return prisma.vaultProfile.create({
    data: {
      siteKey: SITE,
      discordUserId: owner,
      name: `${PREFIX}${name}`,
      profileKey: `${PREFIX}${name}`,
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
      cardNumberEnc: "not-a-real-ciphertext",
      cardCvvEnc: "not-a-real-ciphertext",
    },
  });
}

describe.skipIf(!canRun)("vault reads scoped to a runner", () => {
  beforeAll(async () => {
    await cleanup();
    await prisma.discordMember.createMany({
      data: [MEMBER, OTHER, ALICE, BOB].map((discordUserId) => ({
        discordUserId,
        username: `scope-test-${discordUserId.slice(-3)}`,
        roles: [],
      })),
    });

    // MEMBER is split: seven profiles with alice -- two past her main bot's cap of five --
    // and one with bob. OTHER is bob's alone.
    for (let i = 1; i <= 7; i++) await profile(MEMBER, ALICE, `m${i}`);
    const bobs = await profile(MEMBER, BOB, "m8");
    await profile(OTHER, BOB, "o1");

    // One pending change on each runner's bot, and one mailbox change nobody runs.
    await prisma.vaultChange.createMany({
      data: [
        { assigneeId: ALICE, siteKey: SITE, entityId: "scope-a", label: `${PREFIX}m1` },
        { assigneeId: BOB, siteKey: SITE, entityId: bobs.id, label: `${PREFIX}m8` },
        { assigneeId: null, siteKey: null, entityId: "scope-mail", label: `${PREFIX}mail` },
      ].map((row) => ({
        ...row,
        actorDiscordId: MEMBER,
        ownerDiscordId: MEMBER,
        entity: row.siteKey ? VaultEntity.VAULT_PROFILE : VaultEntity.EMAIL_CREDENTIAL,
        action: VaultAction.UPDATE,
      })),
    });
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  it("puts a member on a runner's roster only for the profiles that runner holds", async () => {
    const hers = await getMembersForSite(SITE, undefined, alice);
    expect(hers.map((m) => m.discordUserId)).toEqual([MEMBER]);
    expect(hers[0]).toMatchObject({ profileCount: 7, runners: [ALICE] });

    const his = (await getMembersForSite(SITE, undefined, bob)).map((m) => m.discordUserId);
    expect(his.sort()).toEqual([MEMBER, OTHER].sort());
  });

  it("shows a full admin's everyone-view a split member as split", async () => {
    const everyone = await getMembersForSite(SITE, undefined, {});
    const row = everyone.find((m) => m.discordUserId === MEMBER);
    // Most-held first.
    expect(row).toMatchObject({ profileCount: 8, runners: [ALICE, BOB] });
    // Two over alice's main bot; bob's single profile is on his main bot.
    expect(row?.onBackup).toBe(2);
  });

  it("opens a member's table on the runner's share only, with the slots counted per runner", async () => {
    const hers = await getMemberVaultForAdmin(SITE, MEMBER, undefined, alice);
    expect(hers.total).toBe(7);
    expect(hers.rows.every((row) => row.assigneeId === ALICE)).toBe(true);
    expect(hers.rows.filter((row) => row.onBackup).map((row) => row.name)).toEqual([
      `${PREFIX}m6`,
      `${PREFIX}m7`,
    ]);

    // Bob's one profile of this member is first on HIS main bot, whatever alice holds.
    const his = await getMemberVaultForAdmin(SITE, MEMBER, undefined, bob);
    expect(his.rows.map((row) => [row.name, row.onBackup])).toEqual([[`${PREFIX}m8`, false]]);
  });

  /**
   * What the per-member Mattel buttons are enabled by: the halves of the membership split,
   * counted exactly as the export reads -- active only, the runner's share only, and
   * regardless of the search, which the export ignores. The site here is Target, but the
   * count doesn't care which retailer it is; only the page decides whether to split.
   */
  it("counts a member's active profiles in the share by membership, ignoring the search", async () => {
    const names = (list: string[]) => list.map((name) => `${PREFIX}${name}`);
    const marked = { account: { select: { id: true } } } as const;
    const withIt = await prisma.vaultProfile.findMany({
      where: { name: { in: names(["m1", "m2", "m3", "m8"]) } },
      select: marked,
    });
    const idle = names(["m3"]);
    try {
      await prisma.vaultAccount.updateMany({
        where: { id: { in: withIt.map((p) => p.account.id) } },
        data: { hasMembership: true },
      });
      await prisma.vaultProfile.updateMany({
        where: { name: { in: idle } },
        data: { active: false },
      });

      // m1 and m2 have it; m3 does too but is switched off; m4-m7 don't.
      const hers = await getMemberVaultForAdmin(SITE, MEMBER, undefined, alice);
      expect(hers.membership).toEqual({ with: 2, without: 4 });

      // A search showing one row leaves the halves as they were.
      const searched = await getMemberVaultForAdmin(
        SITE,
        MEMBER,
        { terms: [`${PREFIX}m5`], status: "all" },
        alice,
      );
      expect(searched.rows).toHaveLength(1);
      expect(searched.membership).toEqual({ with: 2, without: 4 });

      // Bob's share of the same member is m8 alone.
      const his = await getMemberVaultForAdmin(SITE, MEMBER, undefined, bob);
      expect(his.membership).toEqual({ with: 1, without: 0 });
    } finally {
      await prisma.vaultAccount.updateMany({
        where: { id: { in: withIt.map((p) => p.account.id) } },
        data: { hasMembership: false },
      });
      await prisma.vaultProfile.updateMany({
        where: { name: { in: idle } },
        data: { active: true },
      });
    }
  });

  it("counts each retailer tab over the runner's share", async () => {
    expect((await getVaultSites(bob)).find((s) => s.siteKey === SITE)?.count).toBe(2);
  });

  it("keeps each runner's queue to the changes stamped for their bot", async () => {
    const hers = await getPendingChanges(undefined, alice);
    expect(hers.rows.map((row) => row.label)).toEqual([`${PREFIX}m1`]);
    expect(await getPendingChangeCount(bob)).toBe(1);
  });

  it("never shows a runner the mailbox changes, and always shows a full admin's own queue them", async () => {
    const runnerLabels = (await getPendingChanges(undefined, alice)).rows.map((row) => row.label);
    expect(runnerLabels).not.toContain(`${PREFIX}mail`);

    // A full admin's own view: their assignments (none here) plus the unowned mailbox work.
    const own = await getPendingChanges(undefined, {
      assigneeId: "999900000000000129",
      withUnassigned: true,
    });
    expect(own.rows.map((row) => row.label)).toContain(`${PREFIX}mail`);
    expect(own.rows.map((row) => row.label)).not.toContain(`${PREFIX}m1`);
  });
});

async function cleanup() {
  await prisma.vaultChange.deleteMany({ where: { label: { startsWith: PREFIX } } });
  await prisma.vaultProfile.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await prisma.vaultAccount.deleteMany({ where: { email: { startsWith: PREFIX } } });
  await prisma.discordMember.deleteMany({
    where: { discordUserId: { in: [MEMBER, OTHER, ALICE, BOB] } },
  });
}

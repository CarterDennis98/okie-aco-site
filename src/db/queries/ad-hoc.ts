import "server-only";

import { prisma } from "@/db/client";
import { payeeForSite } from "@/lib/billing/payees";
import { loginOnlySiteKeys, siteStyle } from "@/lib/sites";

/**
 * What an admin can issue an ad hoc fee against: their OWN assigned profiles, on the
 * retailers they run. See lib/billing/ad-hoc.ts.
 *
 * Callers MUST have passed `requireAnyAdmin()` and MUST pass the viewer's own id -- the fee
 * picker is "the members whose bot you run", never a way to reach someone else's. Same
 * split as the other query modules: nothing here re-checks.
 *
 * PROFILES ONLY. A login-only retailer has no checkout profile to bill against, and Costco's
 * fees are billed by hand outside the site on purpose.
 */

export type AdHocSite = { siteKey: string; label: string; count: number };

export type AdHocProfileOption = {
  id: string;
  name: string;
  active: boolean;
  memberId: string;
  memberName: string;
  /**
   * Whether the OG discount comes off a fee here: an OG member, on a retailer whose fees
   * are the operator's. Worked out here so the review step shows the same total the action
   * will store. See priceAdHocBill.
   */
  discounted: boolean;
};

/** Retailers where this runner holds at least one profile, most first. */
export async function getAdHocSites(
  assigneeId: string,
  sites?: readonly string[],
): Promise<AdHocSite[]> {
  const loginOnly = loginOnlySiteKeys();
  const groups = await prisma.vaultProfile.groupBy({
    by: ["siteKey"],
    where: {
      account: { assigneeId },
      siteKey: { notIn: loginOnly, ...(sites ? { in: [...sites] } : {}) },
    },
    _count: { _all: true },
  });
  return groups
    .map((group) => ({
      siteKey: group.siteKey,
      label: siteStyle(group.siteKey).label,
      count: group._count._all,
    }))
    .sort((a, b) => b.count - a.count);
}

const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

export type AdHocDetail = {
  issuedBy: string;
  /** The profile it was issued against. Null only if its audit row is somehow missing. */
  profileName: string | null;
  lines: { label: string; qty: number; feeCents: number; subtotalCents: number }[];
};

/**
 * What the admin charges row shows for an ad hoc bill in place of its checkouts -- it has
 * none. The profile it was issued against is read from its audit row, written in the same
 * transaction as the bill, rather than given a column of its own on every bill.
 *
 * ADMIN ONLY, and a runner's call MUST pass their own id as the payee -- the same rule as
 * getBillCheckouts, whose place this takes for these rows.
 */
export async function getAdHocDetail(
  billId: string,
  payeeId?: string,
): Promise<AdHocDetail | null> {
  const bill = await prisma.pasBill.findFirst({
    where: { id: billId, run: { dryRun: false, adHoc: true }, ...(payeeId ? { payeeId } : {}) },
    select: {
      run: { select: { operatorId: true } },
      lines: {
        orderBy: { subtotalCents: "desc" },
        select: { label: true, qty: true, feeCents: true, subtotalCents: true },
      },
    },
  });
  if (!bill) return null;

  const [audit, issuer] = await Promise.all([
    prisma.adminAudit.findFirst({
      where: { entity: "pas_bill", entityId: billId, action: "pas_bill.ad_hoc" },
      select: { after: true },
    }),
    prisma.discordMember.findUnique({
      where: { discordUserId: bill.run.operatorId },
      select: { username: true, globalName: true },
    }),
  ]);
  const recorded = audit?.after as { profileName?: unknown } | null | undefined;

  return {
    issuedBy: issuer?.globalName ?? issuer?.username ?? bill.run.operatorId,
    profileName: typeof recorded?.profileName === "string" ? recorded.profileName : null,
    lines: bill.lines,
  };
}

/**
 * One retailer's profiles assigned to this runner, active first, in name order.
 *
 * Disabled profiles are included, after the rest: a member who switched a profile off the
 * morning after a drop still owes for what it checked out that night.
 */
export async function getAdHocProfiles(
  siteKey: string,
  assigneeId: string,
): Promise<AdHocProfileOption[]> {
  const owedToOperator = payeeForSite(siteKey) === null;
  const rows = await prisma.vaultProfile.findMany({
    where: { siteKey, account: { assigneeId } },
    select: {
      id: true,
      name: true,
      active: true,
      discordUserId: true,
      member: { select: { username: true, globalName: true, isOg: true } },
    },
  });

  return rows
    .map((row) => ({
      id: row.id,
      name: row.name,
      active: row.active,
      memberId: row.discordUserId,
      memberName: row.member.globalName ?? row.member.username,
      discounted: owedToOperator && row.member.isOg,
    }))
    .sort((a, b) => Number(b.active) - Number(a.active) || collator.compare(a.name, b.name));
}

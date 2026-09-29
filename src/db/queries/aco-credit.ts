import "server-only";

import { prisma } from "@/db/client";

/**
 * ACO credit balances. See AcoCredit in the schema.
 *
 * A member's balance is what they were given, less what was taken back, less what their
 * bills have spent -- `pas_bills.credit_cents`, on real runs only. A dry run spends nothing:
 * nobody was billed by it, and the bot never counts one.
 *
 * No authorization here, same split as the other query modules: callers are the pages and
 * actions that have already passed a guard, and the bot endpoint behind its token.
 */

/**
 * Balance per member, for everyone with any credit history (or just `memberIds`). A member
 * missing from the map has never had credit, which is a balance of 0.
 */
export async function getAcoCreditBalances(
  memberIds?: readonly string[],
): Promise<Map<string, number>> {
  const scope = memberIds ? { discordUserId: { in: [...memberIds] } } : {};
  const [grants, spent] = await Promise.all([
    prisma.acoCredit.groupBy({
      by: ["discordUserId"],
      where: scope,
      _sum: { amountCents: true },
    }),
    prisma.pasBill.groupBy({
      by: ["discordUserId"],
      where: { ...scope, creditCents: { gt: 0 }, run: { dryRun: false } },
      _sum: { creditCents: true },
    }),
  ]);

  const balances = new Map<string, number>();
  for (const row of grants) balances.set(row.discordUserId, row._sum.amountCents ?? 0);
  for (const row of spent) {
    balances.set(
      row.discordUserId,
      (balances.get(row.discordUserId) ?? 0) - (row._sum.creditCents ?? 0),
    );
  }
  return balances;
}

export async function getAcoCreditBalance(memberId: string): Promise<number> {
  return (await getAcoCreditBalances([memberId])).get(memberId) ?? 0;
}

export type AcoCreditHolder = {
  memberId: string;
  name: string;
  balanceCents: number;
  /** The last change the operator made -- what the credit is, as far as anyone can see. */
  last: { amountCents: number; note: string | null; at: Date } | null;
};

/**
 * Everyone holding a balance, largest first -- including a NEGATIVE one, which should never
 * happen (a take-back is limited to what is left) and so is exactly what should be shown if
 * it ever does.
 */
export async function getAcoCreditHolders(): Promise<AcoCreditHolder[]> {
  const balances = await getAcoCreditBalances();
  const held = [...balances].filter(([, cents]) => cents !== 0);
  if (held.length === 0) return [];

  const ids = held.map(([id]) => id);
  const [members, latest] = await Promise.all([
    prisma.discordMember.findMany({
      where: { discordUserId: { in: ids } },
      select: { discordUserId: true, username: true, globalName: true },
    }),
    prisma.acoCredit.findMany({
      where: { discordUserId: { in: ids } },
      orderBy: { createdAt: "desc" },
      distinct: ["discordUserId"],
      select: { discordUserId: true, amountCents: true, note: true, createdAt: true },
    }),
  ]);
  const nameOf = new Map(members.map((m) => [m.discordUserId, m.globalName ?? m.username]));
  const lastOf = new Map(latest.map((row) => [row.discordUserId, row]));

  return held
    .map(([memberId, balanceCents]) => {
      const last = lastOf.get(memberId);
      return {
        memberId,
        name: nameOf.get(memberId) ?? memberId,
        balanceCents,
        last: last ? { amountCents: last.amountCents, note: last.note, at: last.createdAt } : null,
      };
    })
    .sort((a, b) => b.balanceCents - a.balanceCents);
}

export type CreditMemberOption = {
  id: string;
  name: string;
  username: string;
  balanceCents: number;
};

const collator = new Intl.Collator("en", { sensitivity: "base" });

/** Who can be given credit: everyone still in the server, by name, with their balance. */
export async function getCreditMemberOptions(): Promise<CreditMemberOption[]> {
  const [members, balances] = await Promise.all([
    prisma.discordMember.findMany({
      where: { leftAt: null },
      select: { discordUserId: true, username: true, globalName: true },
    }),
    getAcoCreditBalances(),
  ]);
  return members
    .map((m) => ({
      id: m.discordUserId,
      name: m.globalName ?? m.username,
      username: m.username,
      balanceCents: balances.get(m.discordUserId) ?? 0,
    }))
    .sort((a, b) => collator.compare(a.name, b.name));
}

/** What a member sees on their dashboard: their balance, and the last credit they were given. */
export async function getMemberAcoCredit(
  memberId: string,
): Promise<{ balanceCents: number; lastNote: string | null }> {
  const [balanceCents, lastGift] = await Promise.all([
    getAcoCreditBalance(memberId),
    prisma.acoCredit.findFirst({
      where: { discordUserId: memberId, amountCents: { gt: 0 } },
      orderBy: { createdAt: "desc" },
      select: { note: true },
    }),
  ]);
  return { balanceCents, lastNote: lastGift?.note ?? null };
}

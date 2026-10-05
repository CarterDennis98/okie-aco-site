import "server-only";

import { prisma } from "@/db/client";
import { readInstanceConfig, type ShikariInstanceConfig } from "@/lib/shikari/config";
import { siteStyle } from "@/lib/sites";

/**
 * Reads for the Shikari export page. The operator's only -- the page checks before calling.
 *
 * Nothing here decrypts; the export's secrets come from lib/shikari/payload.ts, once the
 * operator asks for a build, and are audited there.
 */

export const SHIKARI_SITE = "target";

export type ShikariMember = {
  discordUserId: string;
  username: string;
  displayName: string;
  /** Active Target profiles assigned to the operator. */
  active: number;
  /** How many of those the main bot runs, and how many spill onto a backup. */
  main: number;
  backup: number;
};

/**
 * Every member with an active Target profile on the operator's own bot.
 *
 * The OPERATOR'S ASSIGNMENTS ONLY, like the AYCD export's default: a Shikari instance is the
 * operator's bot, and loading another runner's profiles onto it would run those members
 * twice. Moving profiles between runners is how a member gets onto this list.
 */
export async function getShikariMembers(operatorId: string): Promise<ShikariMember[]> {
  const [profiles, members] = await Promise.all([
    prisma.vaultProfile.groupBy({
      by: ["discordUserId"],
      where: { siteKey: SHIKARI_SITE, active: true, account: { assigneeId: operatorId } },
      _count: { _all: true },
    }),
    prisma.discordMember.findMany({
      select: { discordUserId: true, username: true, globalName: true },
    }),
  ]);
  const byId = new Map(members.map((m) => [m.discordUserId, m]));
  const cap = siteStyle(SHIKARI_SITE).profileSoftCap;
  const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

  return profiles
    .map((row) => {
      const member = byId.get(row.discordUserId);
      const active = row._count._all;
      const main = cap === undefined ? active : Math.min(active, cap);
      return {
        discordUserId: row.discordUserId,
        username: member?.username ?? row.discordUserId,
        displayName: member?.globalName ?? member?.username ?? row.discordUserId,
        active,
        main,
        backup: active - main,
      };
    })
    .sort((a, b) => collator.compare(a.username, b.username));
}

/** The saved instance setups, in order. An instance never saved isn't listed. */
export async function getShikariInstances(): Promise<ShikariInstanceConfig[]> {
  const rows = await prisma.shikariInstance.findMany({ orderBy: { position: "asc" } });
  return rows.map((row) => readInstanceConfig(row.config));
}

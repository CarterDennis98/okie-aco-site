import "server-only";

import { prisma } from "@/db/client";
import { getSetsInLine, getSkusForProfiles } from "@/db/queries/products";
import { MISC_LINE } from "@/lib/products/misc-line";
import { siteStyle } from "@/lib/sites";
import { VALOR_PKC_SITE, VALOR_TARGET_SITE, splitPkc } from "@/lib/valor/split";

/**
 * Counts for the Export page's Valor section: who each instance would run, by the same rule
 * the export splits by (valor/split.ts). The operator's only -- the page checks before
 * calling. Nothing here decrypts.
 */

export type ValorOverview = {
  instances: { position: 1 | 2; main: number; backup: number }[];
  /** The operator's own active Pokémon Center profiles: kept in Valor by hand, left out. */
  own: number;
  /** Target profiles that picked from the Miscellaneous line, on the second instance. */
  misc: { profiles: number; members: number; products: number };
};

export async function getValorOverview(operatorId: string): Promise<ValorOverview> {
  const [pkc, own, target, miscSets] = await Promise.all([
    prisma.vaultProfile.findMany({
      where: {
        siteKey: VALOR_PKC_SITE,
        active: true,
        account: { assigneeId: operatorId },
        NOT: { discordUserId: operatorId },
      },
      select: { id: true, name: true, discordUserId: true },
    }),
    prisma.vaultProfile.count({
      where: { siteKey: VALOR_PKC_SITE, active: true, discordUserId: operatorId },
    }),
    prisma.vaultProfile.findMany({
      where: { siteKey: VALOR_TARGET_SITE, active: true, account: { assigneeId: operatorId } },
      select: { id: true, discordUserId: true },
    }),
    getSetsInLine(VALOR_TARGET_SITE, MISC_LINE),
  ]);
  const split = splitPkc(pkc, siteStyle(VALOR_PKC_SITE).profileSoftCap);
  const { skus, catalog } = await getSkusForProfiles(VALOR_TARGET_SITE, target);
  const inLine = new Set(catalog.filter((p) => miscSets.has(p.setName)).map((p) => p.sku));
  const pickers = target.filter((p) => (skus.get(p.id) ?? []).some((sku) => inLine.has(sku)));

  return {
    instances: ([1, 2] as const).map((position) => ({
      position,
      main: split[position].main.length,
      backup: split[position].backup.length,
    })),
    own,
    misc: {
      profiles: pickers.length,
      members: new Set(pickers.map((p) => p.discordUserId)).size,
      products: inLine.size,
    },
  };
}

import "server-only";

import { prisma } from "@/db/client";
import { loadMailboxCoverage, mailboxFor } from "@/db/queries/email-coverage";
import { getSetsInLine, getSkusForProfiles } from "@/db/queries/products";
import { MISC_LINE } from "@/lib/products/misc-line";
import { STANDARD_QTY, defaultQtyFor, runnableQty } from "@/lib/products/qty";
import { siteStyle } from "@/lib/sites";
import type { VaultAddress } from "@/lib/valor/format";
import {
  MISC_POSITION,
  VALOR_PKC_SITE,
  VALOR_TARGET_SITE,
  splitPkc,
  type ValorPosition,
} from "@/lib/valor/split";
import type {
  DesiredMiscProfile,
  DesiredValorInstance,
  DesiredValorProfile,
  KnownValorProfile,
  ValorMailbox,
} from "@/lib/valor/types";
import { exportPhone } from "@/lib/vault/aycd";
import { normalizeExpiry } from "@/lib/vault/card";
import { decrypt } from "@/lib/vault/crypto";
import { providerForEmail } from "@/lib/vault/email-providers";

/**
 * What each Valor instance should hold, according to the vault -- secrets included.
 *
 * Another of the doors secrets leave by, built like the Shikari export's (shikari/payload.ts):
 * the operator's own assignments only, the main/backup split by the one shared rule, every
 * member's share recorded in `vault_exports` BEFORE anything is decrypted, and nothing logged.
 *
 *   POKÉMON CENTER  every active profile on the operator's bot but the operator's OWN --
 *                   ou1998's, kept by hand in Valor groups of their own ("PKC Personal") --
 *                   split between the instances by splitPkc.
 *   TARGET          for the second instance only: every active Target profile on the
 *                   operator's bot that picked from the Miscellaneous line (MISC_LINE) --
 *                   main-bot and backup-bot alike, since a pick names its profiles -- with
 *                   its login and the mailbox its codes arrive at.
 *
 * Both instances are always split, whichever are asked for, so a profile that comes out of
 * one is said to run on the other.
 */

export type ValorPayloadResult =
  { ok: true; instances: DesiredValorInstance[] } | { ok: false; error: string };

type ProfileRow = Awaited<ReturnType<typeof loadProfiles>>[number];

function loadProfiles(site: string, operatorId: string, { ownToo }: { ownToo: boolean }) {
  return prisma.vaultProfile.findMany({
    where: {
      siteKey: site,
      active: true,
      account: { assigneeId: operatorId },
      ...(ownToo ? {} : { NOT: { discordUserId: operatorId } }),
    },
    include: {
      account: { select: { id: true, email: true, passwordEnc: true } },
      member: { select: { username: true, globalName: true } },
    },
  });
}

/** Every profile the site holds on a retailer, any runner's, to say why one isn't here. */
function loadKnown(site: string) {
  return prisma.vaultProfile.findMany({
    where: { siteKey: site },
    select: {
      id: true,
      name: true,
      active: true,
      discordUserId: true,
      account: { select: { email: true, assigneeId: true } },
    },
  });
}

const address = (row: ProfileRow, billing: boolean): VaultAddress =>
  billing
    ? {
        firstName: row.billFirstName ?? row.firstName,
        lastName: row.billLastName ?? row.lastName,
        street: row.billLine1 ?? "",
        street2: row.billLine2 ?? "",
        city: row.billCity ?? "",
        state: (row.billState ?? "").toUpperCase(),
        zip: row.billPostalCode ?? "",
        country: row.billCountry || "US",
      }
    : {
        firstName: row.firstName,
        lastName: row.lastName,
        street: row.shipLine1,
        street2: row.shipLine2 ?? "",
        city: row.shipCity,
        state: row.shipState.toUpperCase(),
        zip: row.shipPostalCode,
        country: row.shipCountry || "US",
      };

/** Decrypts one profile's card. Only ever called after the audit rows are written. */
function toDesired(row: ProfileRow): DesiredValorProfile {
  const expiry = normalizeExpiry(row.cardExpMonth, row.cardExpYear);
  return {
    key: row.id,
    ownerId: row.discordUserId,
    ownerName: row.member.globalName ?? row.member.username,
    name: row.name,
    email: row.account.email,
    // The phone every export of this profile gives it: Pokémon Center's "0" when there is
    // none, for Valor to make one up; Target's a number drawn from the profile id.
    phone: exportPhone({
      id: row.id,
      siteKey: row.siteKey,
      phone: row.phone,
      shipState: row.shipState,
    }),
    shipping: address(row, false),
    billing: row.sameBillingAndShipping ? null : address(row, true),
    card: {
      number: decrypt(row.cardNumberEnc, { entity: "vault_profile", field: "card_number" }).replace(
        /\D/g,
        "",
      ),
      expMonth: expiry.month,
      expYear: expiry.year,
      cvv: decrypt(row.cardCvvEnc, { entity: "vault_profile", field: "card_cvv" }),
    },
    onlyCheckoutOnce: row.onlyCheckoutOnce,
  };
}

export async function buildValorPayload(
  operatorId: string,
  positions: ValorPosition[],
): Promise<ValorPayloadResult> {
  const wanted = [...new Set(positions)].sort();
  const withMisc = wanted.includes(MISC_POSITION);

  // --- Pokémon Center ---
  const [pkcRows, pkcKnown] = await Promise.all([
    loadProfiles(VALOR_PKC_SITE, operatorId, { ownToo: false }),
    loadKnown(VALOR_PKC_SITE),
  ]);
  const split = splitPkc(pkcRows, siteStyle(VALOR_PKC_SITE).profileSoftCap);
  const placedOn = new Map<string, ValorPosition>();
  for (const position of [1, 2] as const)
    for (const row of [...split[position].main, ...split[position].backup])
      placedOn.set(row.id, position);

  const pkcWhy = (profile: (typeof pkcKnown)[number], position: ValorPosition): string | null => {
    const on = placedOn.get(profile.id);
    if (on === position) return null;
    if (!profile.active) return "switched off";
    if (profile.account.assigneeId !== operatorId) return "another runner's";
    if (profile.discordUserId === operatorId) return "your own — left out of the export";
    return on ? `runs on Instance ${on}` : "not on this instance";
  };

  // --- the Miscellaneous line, on Target ---
  let misc: {
    rows: ProfileRow[];
    products: Map<string, { sku: string; qty: number }[]>;
    catalog: { sku: string; name: string }[];
    known: Awaited<ReturnType<typeof loadKnown>>;
  } | null = null;
  if (withMisc) {
    const [rows, known, miscSets] = await Promise.all([
      loadProfiles(VALOR_TARGET_SITE, operatorId, { ownToo: true }),
      loadKnown(VALOR_TARGET_SITE),
      getSetsInLine(VALOR_TARGET_SITE, MISC_LINE),
    ]);
    const { skus, qty, catalog } = await getSkusForProfiles(
      VALOR_TARGET_SITE,
      rows.map((r) => ({ id: r.id, discordUserId: r.discordUserId })),
    );
    const line = catalog.filter((p) => miscSets.has(p.setName));
    const inLine = new Set(line.map((p) => p.sku));
    const limits = new Map(line.map((p) => [p.sku, p.maxQty]));
    const products = new Map<string, { sku: string; qty: number }[]>();
    for (const row of rows) {
      const mine = (skus.get(row.id) ?? []).filter((sku) => inLine.has(sku));
      if (mine.length === 0) continue;
      products.set(
        row.id,
        mine.map((sku) => ({
          sku,
          // As the Shikari export runs a pick: the member's qty, or the standard one -- or the
          // product's posted limit where that's lower -- and never past the most they can pick.
          qty: runnableQty(qty.get(row.id)?.[sku], defaultQtyFor(limits.get(sku), STANDARD_QTY)),
        })),
      );
    }
    misc = {
      rows: rows.filter((r) => products.has(r.id)),
      products,
      catalog: line.map((p) => ({ sku: p.sku, name: p.name })),
      known,
    };
  }

  // Audited BEFORE anything is decrypted: one row per member per instance and retailer,
  // as the Shikari export writes them.
  const audit = (site: string, position: number, rows: ProfileRow[], withLogins: boolean) => {
    const perMember = new Map<string, ProfileRow[]>();
    for (const row of rows)
      perMember.set(row.discordUserId, [...(perMember.get(row.discordUserId) ?? []), row]);
    return [...perMember].map(([discordUserId, mine]) => ({
      actorDiscordId: operatorId,
      siteKey: site,
      format: "valor",
      scope: `instance-${position}`,
      targetDiscordId: discordUserId,
      profileCount: mine.length,
      accountCount: withLogins ? mine.filter((r) => r.account.passwordEnc).length : 0,
    }));
  };
  await prisma.vaultExport.createMany({
    data: wanted.flatMap((position) => [
      ...audit(
        VALOR_PKC_SITE,
        position,
        [...split[position].main, ...split[position].backup],
        false,
      ),
      ...(position === MISC_POSITION && misc
        ? audit(VALOR_TARGET_SITE, position, misc.rows, true)
        : []),
    ]),
  });

  let desiredMisc: DesiredMiscProfile[] = [];
  if (misc) {
    const coverage = await loadMailboxCoverage();
    const boxes = [
      ...new Set(
        misc.rows
          .map((r) => mailboxFor(coverage, r.account.email))
          .filter((b): b is string => Boolean(b)),
      ),
    ];
    const credentials = await prisma.emailCredential.findMany({
      where: { email: { in: boxes } },
      select: { email: true, imapHost: true, appPasswordEnc: true },
    });
    const mailboxes = new Map<string, ValorMailbox>();
    for (const credential of credentials) {
      const server = credential.imapHost ?? providerForEmail(credential.email)?.imapHost ?? null;
      // No server, no entry Valor can use: the profile goes out without one.
      if (!server) continue;
      mailboxes.set(credential.email.toLowerCase(), {
        server,
        email: credential.email,
        password: decrypt(credential.appPasswordEnc, {
          entity: "email_credential",
          field: "app_password",
        }),
      });
    }
    const found = misc;
    desiredMisc = found.rows.map((row) => {
      const box = mailboxFor(coverage, row.account.email);
      return {
        ...toDesired(row),
        password: row.account.passwordEnc
          ? decrypt(row.account.passwordEnc, { entity: "vault_account", field: "password" })
          : null,
        mailbox: box ? (mailboxes.get(box.toLowerCase()) ?? null) : null,
        products: found.products.get(row.id) ?? [],
      };
    });
  }

  const targetKnown = (): KnownValorProfile[] =>
    (misc?.known ?? []).map((profile) => ({
      site: "target",
      name: profile.name,
      email: profile.account.email,
      why: misc?.products.has(profile.id)
        ? null
        : !profile.active
          ? "switched off"
          : profile.account.assigneeId !== operatorId
            ? "another runner's"
            : `picked nothing from the ${MISC_LINE} line`,
    }));

  return {
    ok: true,
    instances: wanted.map((position) => ({
      position,
      main: split[position].main.map(toDesired),
      backup: split[position].backup.map(toDesired),
      misc: position === MISC_POSITION ? desiredMisc : null,
      products: position === MISC_POSITION ? (misc?.catalog ?? []) : [],
      known: [
        ...pkcKnown.map((profile) => ({
          site: "pkc" as const,
          name: profile.name,
          email: profile.account.email,
          why: pkcWhy(profile, position),
        })),
        ...(position === MISC_POSITION ? targetKnown() : []),
      ],
    })),
  };
}

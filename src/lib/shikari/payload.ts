import "server-only";

import { prisma } from "@/db/client";
import { loadMailboxCoverage, mailboxFor } from "@/db/queries/email-coverage";
import { getSetsInLine, getSkusForProfiles } from "@/db/queries/products";
import { getRaffleEntries, getRaffles } from "@/db/queries/raffles";
import { SHIKARI_SITE } from "@/db/queries/shikari";
import { VaultAction, VaultEntity } from "@/generated/prisma/enums";
import { MISC_LINE } from "@/lib/products/misc-line";
import { rafflesByProfile } from "@/lib/raffles/entries";
import { runsMiscLine, type ExportRequest } from "@/lib/shikari/config";
import type {
  AbsentReason,
  CatalogProduct,
  DesiredInstance,
  DesiredProfile,
  KnownProfile,
  RaffleGap,
  ShikariAddress,
  ShikariMailbox,
} from "@/lib/shikari/types";
import { siteStyle } from "@/lib/sites";
import { exportPhone } from "@/lib/vault/aycd";
import { profilesForBot } from "@/lib/vault/bot-split";
import { normalizeExpiry } from "@/lib/vault/card";
import { decrypt } from "@/lib/vault/crypto";
import { providerForEmail } from "@/lib/vault/email-providers";
import { normalizePhone } from "@/lib/vault/profile-input";

/**
 * What each Shikari instance should hold, according to the vault -- secrets included.
 *
 * The SECOND door secrets leave by, beside the AYCD export route, and built the same way:
 * the operator's own assignments only, the main/backup split by the one shared rule, every
 * member's share recorded in `vault_exports` BEFORE anything is decrypted, and nothing logged.
 * What goes back is the vault's view of each profile -- card, address, password, mailbox,
 * products and the qty of each -- for the operator's browser to write into backups it never
 * uploads.
 *
 * Refused outright, rather than half-built, when the request would put one profile on two
 * instances: that is a member checked out twice, the failure every export split exists to
 * prevent.
 *
 * The Miscellaneous line's products go only to an instance set to run the line (runsMiscLine),
 * flagged, for the builder's task group of their own. Any other instance gets none of them --
 * the line is Valor's there -- and a profile on it that picked only from the line goes out
 * picking nothing; how many did is sent along for the review. Valor's export builds the line
 * either way: which bot runs a drop of it is the operator's call, made when starting tasks,
 * since a product started on both is a member checked out twice.
 *
 * Every raffle on the site goes out, with the raffles each profile is entered in, for the
 * builder's raffle groups. And since a raffle has a deadline, the entries of the operator's
 * profiles that NO instance of this export runs -- a member nobody picked, a sixth profile
 * with no backup instance -- come back too, for the review to name.
 */

export type PayloadResult =
  | { ok: true; instances: DesiredInstance[]; raffleGaps: RaffleGap[] }
  | { ok: false; error: string };

/** Changes that earn a Wipe Account task. A move between runners edits nothing. */
const WIPE_ACTIONS = [VaultAction.CREATE, VaultAction.UPDATE, VaultAction.ACTIVATE];

const digits = (phone: string) => normalizePhone(phone) ?? phone.replace(/\D/g, "");

export async function buildShikariPayload(
  operatorId: string,
  request: ExportRequest,
): Promise<PayloadResult> {
  const memberIds = [...new Set(request.instances.flatMap((i) => i.config.memberIds))];
  const rows = await prisma.vaultProfile.findMany({
    where: {
      siteKey: SHIKARI_SITE,
      active: true,
      discordUserId: { in: memberIds },
      account: { assigneeId: operatorId },
    },
    include: {
      account: { select: { id: true, email: true, passwordEnc: true } },
      member: { select: { username: true, globalName: true } },
    },
  });
  type Row = (typeof rows)[number];

  const byMember = new Map<string, Row[]>();
  for (const row of rows)
    byMember.set(row.discordUserId, [...(byMember.get(row.discordUserId) ?? []), row]);
  const cap = siteStyle(SHIKARI_SITE).profileSoftCap;

  const chosen = request.instances.map(({ position, config }) => ({
    position,
    config,
    rows: [...new Set(config.memberIds)].flatMap((id) =>
      profilesForBot(byMember.get(id) ?? [], cap, config.bot),
    ),
  }));

  const empty = chosen.filter((c) => c.rows.length === 0).map((c) => `Instance ${c.position}`);
  if (empty.length > 0) {
    return {
      ok: false,
      error: `${empty.join(" and ")} would run no profiles — pick members for ${empty.length === 1 ? "it" : "them"}, or remove ${empty.length === 1 ? "it" : "them"}.`,
    };
  }

  const placed = new Map<string, number>();
  const twice: string[] = [];
  for (const { position, rows: list } of chosen) {
    for (const row of list) {
      const other = placed.get(row.id);
      if (other !== undefined && other !== position)
        twice.push(`${row.name} (Instances ${other} and ${position})`);
      placed.set(row.id, position);
    }
  }
  if (twice.length > 0) {
    return {
      ok: false,
      error:
        `${twice.length} profile${twice.length === 1 ? "" : "s"} would run on two instances: ` +
        `${twice.slice(0, 4).join(", ")}${twice.length > 4 ? ", …" : ""}. ` +
        "Change one instance's members, or its main/backup choice.",
    };
  }

  // Audited BEFORE anything is decrypted, one row per member per instance -- the same shape
  // the AYCD route writes for a multi-member export, so the table answers "whose
  // credentials left, when, and in what" for this door too.
  await prisma.vaultExport.createMany({
    data: chosen.flatMap(({ position, rows: list }) => {
      const perMember = new Map<string, Row[]>();
      for (const row of list)
        perMember.set(row.discordUserId, [...(perMember.get(row.discordUserId) ?? []), row]);
      return [...perMember].map(([discordUserId, mine]) => ({
        actorDiscordId: operatorId,
        siteKey: SHIKARI_SITE,
        format: "shikari",
        scope: `instance-${position}`,
        targetDiscordId: discordUserId,
        profileCount: mine.length,
        accountCount: mine.filter((r) => r.account.passwordEnc).length,
      }));
    }),
  });

  const all = chosen.flatMap((c) => c.rows);
  const accountToProfile = new Map(all.map((r) => [r.account.id, r.id]));
  const [coverage, { skus, qty, catalog }, pending, known, miscSets, raffles, entries] =
    await Promise.all([
      // Unscoped, like every other coverage read: an alias row is unique globally.
      loadMailboxCoverage(),
      getSkusForProfiles(
        SHIKARI_SITE,
        all.map((r) => ({ id: r.id, discordUserId: r.discordUserId })),
      ),
      prisma.vaultChange.findMany({
        where: {
          appliedAt: null,
          siteKey: SHIKARI_SITE,
          action: { in: WIPE_ACTIONS },
          OR: [
            { entity: VaultEntity.VAULT_PROFILE, entityId: { in: all.map((r) => r.id) } },
            { entity: VaultEntity.VAULT_ACCOUNT, entityId: { in: [...accountToProfile.keys()] } },
          ],
        },
        orderBy: { at: "asc" },
        select: { entity: true, entityId: true, action: true, fields: true },
      }),
      // Every Target profile on file, any runner's: what says why a profile in the backup isn't
      // this instance's -- or that the site has never heard of it.
      prisma.vaultProfile.findMany({
        where: { siteKey: SHIKARI_SITE },
        select: {
          id: true,
          name: true,
          active: true,
          discordUserId: true,
          account: { select: { email: true, assigneeId: true } },
        },
      }),
      // The Miscellaneous line's sets: their products go only where the line runs.
      getSetsInLine(SHIKARI_SITE, MISC_LINE),
      // Every raffle, open or closed: a raffle's group stays in the backups until it's deleted.
      getRaffles(SHIKARI_SITE, { includeClosed: true }),
      // Every member's entries, not only the picked members': what the gaps are found from.
      getRaffleEntries(SHIKARI_SITE),
    ]);
  const listed = new Set(catalog.map((p) => p.sku));
  const inLine = new Set(catalog.filter((p) => miscSets.has(p.setName)).map((p) => p.sku));
  /** Whether an instance runs a pick: anything listed, but the line only where it runs. */
  const runs = (runsLine: boolean) => (sku: string) =>
    listed.has(sku) && (runsLine || !inLine.has(sku));

  // Raffles oldest first, so a backup's groups come in the order the raffles were listed.
  const raffleOrder = [...raffles].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  // Who's entered in what, over every active profile of the operator's whose member entered
  // anything: the instances' profiles, and the ones no instance runs.
  const entrants = [...new Set(entries.map((e) => e.discordUserId))];
  const entrantProfiles =
    entrants.length === 0
      ? []
      : await prisma.vaultProfile.findMany({
          where: {
            siteKey: SHIKARI_SITE,
            active: true,
            discordUserId: { in: entrants },
            account: { assigneeId: operatorId },
          },
          select: { id: true, name: true, discordUserId: true },
        });
  const entered = rafflesByProfile(entrantProfiles, entries, raffleOrder);
  const raffleName = new Map(raffleOrder.map((r) => [r.sku, r.name]));
  const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });
  const raffleGaps = raffleOrder.flatMap((raffle) => {
    const profiles = entrantProfiles
      .filter((p) => !placed.has(p.id) && (entered.get(p.id) ?? []).includes(raffle.sku))
      .map((p) => p.name)
      .sort(collator.compare);
    return profiles.length > 0
      ? [{ raffle: raffleName.get(raffle.sku) ?? raffle.sku, profiles }]
      : [];
  });

  const pendingFields = new Map<string, Set<string>>();
  for (const change of pending) {
    const profileId =
      change.entity === VaultEntity.VAULT_PROFILE
        ? change.entityId
        : accountToProfile.get(change.entityId);
    if (!profileId) continue;
    const fields = pendingFields.get(profileId) ?? new Set<string>();
    if (change.action === VaultAction.CREATE) fields.add("new profile");
    else if (change.action === VaultAction.ACTIVATE) fields.add("switched back on");
    for (const field of change.fields) fields.add(field);
    pendingFields.set(profileId, fields);
  }

  // The mailboxes behind these profiles, decrypted once each.
  const boxes = [
    ...new Set(
      all.map((r) => mailboxFor(coverage, r.account.email)).filter((b): b is string => Boolean(b)),
    ),
  ];
  const credentials = await prisma.emailCredential.findMany({
    where: { email: { in: boxes } },
    select: { email: true, imapHost: true, imapPort: true, appPasswordEnc: true },
  });
  const mailboxByEmail = new Map<string, ShikariMailbox>();
  for (const credential of credentials) {
    const server = credential.imapHost ?? providerForEmail(credential.email)?.imapHost ?? null;
    // No server, no row Shikari can use: the profile goes out without a mailbox, and its
    // task keeps whichever one the backup already gave it.
    if (!server) continue;
    mailboxByEmail.set(credential.email.toLowerCase(), {
      server,
      port: credential.imapPort ?? providerForEmail(credential.email)?.imapPort ?? 993,
      username: credential.email,
      password: decrypt(credential.appPasswordEnc, {
        entity: "email_credential",
        field: "app_password",
      }),
    });
  }

  const toDesired = (row: Row, runsLine: boolean): DesiredProfile => {
    const runsHere = runs(runsLine);
    const phone = digits(
      exportPhone({ id: row.id, siteKey: row.siteKey, phone: row.phone, shipState: row.shipState }),
    );
    const shipping: ShikariAddress = {
      firstName: row.firstName,
      lastName: row.lastName,
      street: row.shipLine1,
      street2: row.shipLine2 ?? "",
      city: row.shipCity,
      state: row.shipState.toUpperCase(),
      zip: row.shipPostalCode,
      country: row.shipCountry || "US",
      phone,
    };
    const billing: ShikariAddress | null = row.sameBillingAndShipping
      ? null
      : {
          firstName: row.billFirstName ?? row.firstName,
          lastName: row.billLastName ?? row.lastName,
          street: row.billLine1 ?? "",
          street2: row.billLine2 ?? "",
          city: row.billCity ?? "",
          state: (row.billState ?? "").toUpperCase(),
          zip: row.billPostalCode ?? "",
          country: row.billCountry || "US",
          phone,
        };
    const expiry = normalizeExpiry(row.cardExpMonth, row.cardExpYear);
    const box = mailboxFor(coverage, row.account.email);
    const fields = pendingFields.get(row.id);
    return {
      key: row.id,
      ownerId: row.discordUserId,
      ownerName: row.member.globalName ?? row.member.username,
      name: row.name,
      email: row.account.email,
      shipping,
      billing,
      card: {
        number: decrypt(row.cardNumberEnc, {
          entity: "vault_profile",
          field: "card_number",
        }).replace(/\D/g, ""),
        expMonth: Number(expiry.month),
        expYear: Number(expiry.year),
        cvv: decrypt(row.cardCvvEnc, { entity: "vault_profile", field: "card_cvv" }),
      },
      password: row.account.passwordEnc
        ? decrypt(row.account.passwordEnc, { entity: "vault_account", field: "password" })
        : null,
      mailbox: box ? (mailboxByEmail.get(box.toLowerCase()) ?? null) : null,
      skus: (skus.get(row.id) ?? []).filter(runsHere),
      qty: Object.fromEntries(
        Object.entries(qty.get(row.id) ?? {}).filter(([sku]) => runsHere(sku)),
      ),
      raffles: entered.get(row.id) ?? [],
      pending: fields ? { fields: [...fields] } : null,
    };
  };

  const productsFor = (runsLine: boolean): CatalogProduct[] =>
    catalog
      .filter((p) => runsLine || !inLine.has(p.sku))
      .map((p) => ({
        sku: p.sku,
        name: p.name,
        setName: p.setName,
        misc: inLine.has(p.sku),
        // The builder's to apply, against the standard qty the operator types in the browser.
        maxQty: p.maxQty,
      }));

  // Why each profile the site holds is or isn't on an instance, in the order the reasons are
  // checked: switched off, another runner's, its member not picked, or -- its member picked,
  // its profile not -- the other side of the main/backup split.
  const whyNot = (
    profile: (typeof known)[number],
    config: ExportRequest["instances"][number]["config"],
  ): AbsentReason => {
    if (!profile.active) return "inactive";
    if (profile.account.assigneeId !== operatorId) return "runner";
    if (!config.memberIds.includes(profile.discordUserId)) return "member";
    return config.bot === "backup" ? "main" : "backup";
  };
  const knownFor = ({ position, config }: (typeof chosen)[number]): KnownProfile[] =>
    known.map((profile) => {
      const on = placed.get(profile.id);
      return {
        name: profile.name,
        email: profile.account.email,
        why: on === position ? null : whyNot(profile, config),
        ...(on !== undefined && on !== position ? { instance: on } : {}),
      };
    });

  return {
    ok: true,
    instances: chosen.map((instance) => {
      const runsLine = runsMiscLine(instance.config);
      return {
        position: instance.position,
        profiles: instance.rows.map((row) => toDesired(row, runsLine)),
        known: knownFor(instance),
        products: productsFor(runsLine),
        raffles: raffleOrder.map((r) => ({ sku: r.sku, name: r.name })),
        misc: {
          runs: runsLine,
          picked: instance.rows.filter((row) =>
            (skus.get(row.id) ?? []).some((sku) => inLine.has(sku)),
          ).length,
        },
      };
    }),
    raffleGaps,
  };
}

"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/db/client";
import { getAcoCreditBalance } from "@/db/queries/aco-credit";
import { Prisma } from "@/generated/prisma/client";
import { operatorId } from "@/lib/auth/admin-scope";
import { requireAdmin } from "@/lib/auth/guard";
import {
  balanceAfter,
  cleanCreditNote,
  parseCreditAmount,
  parseCreditMode,
} from "@/lib/billing/aco-credit";

/**
 * Giving and taking back ACO credit, from the admin Charges page. See lib/billing/aco-credit.ts.
 *
 * THE OPERATOR ONLY -- the first ADMIN_DISCORD_IDS entry, not every full admin. Credit comes
 * off the operator's own fees, so it is the operator's money to give, the same reason only
 * they give one-off discounts on /pas run. Checked here, where the write is, not trusted
 * from the page that shows the button.
 *
 * One ledger row per change, written with its audit row in one transaction. Nothing is
 * DMed: the member sees their balance on their dashboard, and their next bill spends it.
 */

export type CreditResult =
  | {
      ok: true;
      memberName: string;
      /** What changed: positive given, negative taken back. */
      amountCents: number;
      balanceCents: number;
      /** True when this key had already been used: a retry, not a second change. */
      already: boolean;
    }
  | { ok: false; error: string };

const KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SNOWFLAKE = /^\d{15,25}$/;

export async function changeAcoCredit(form: FormData): Promise<CreditResult> {
  const viewer = await requireAdmin();
  if (viewer.discordUserId !== operatorId()) {
    return { ok: false, error: "Only the operator gives ACO credit." };
  }

  // Minted by the dialog when it opens: a double-click or a retried POST is one change.
  const key = String(form.get("key") ?? "");
  if (!KEY.test(key)) return { ok: false, error: "Reload the page and try again." };
  const requestKey = key.toLowerCase();

  const already = await existingChange(requestKey, viewer.discordUserId);
  if (already) return already;

  const mode = parseCreditMode(form.get("mode"));
  if (!mode) return { ok: false, error: "Choose whether to give or take back credit." };

  const memberId = String(form.get("memberId") ?? "");
  const member = SNOWFLAKE.test(memberId)
    ? await prisma.discordMember.findUnique({
        where: { discordUserId: memberId },
        select: { username: true, globalName: true },
      })
    : null;
  if (!member) return { ok: false, error: "Pick a member." };

  const amount = parseCreditAmount(String(form.get("amount") ?? ""));
  if (!amount.ok) return amount;
  const note = cleanCreditNote(String(form.get("note") ?? ""));

  const balance = await getAcoCreditBalance(memberId);
  // What the operator reviewed must be what gets written: a billing run can spend credit
  // between the review and the click, and a take-back sized against a stale balance would
  // leave the member owing money they never had.
  if (Number(form.get("reviewedBalance")) !== balance) {
    return { ok: false, error: "Their balance changed since you reviewed it. Review it again." };
  }
  const after = balanceAfter(balance, mode, amount.cents);
  if (!after.ok) return after;

  const amountCents = mode === "give" ? amount.cents : -amount.cents;
  try {
    await prisma.$transaction(async (tx) => {
      const credit = await tx.acoCredit.create({
        data: {
          discordUserId: memberId,
          amountCents,
          note,
          issuedBy: viewer.discordUserId,
          requestKey,
        },
        select: { id: true },
      });
      await tx.adminAudit.create({
        data: {
          actorDiscordId: viewer.discordUserId,
          action: mode === "give" ? "aco_credit.give" : "aco_credit.take",
          entity: "aco_credit",
          entityId: credit.id,
          before: { balanceCents: balance },
          after: { memberId, amountCents, note, balanceCents: after.cents },
        },
      });
    });
  } catch (error) {
    // Two clicks racing past the check above: the second hits the unique key, and the
    // change the first one made is the answer to both.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const raced = await existingChange(requestKey, viewer.discordUserId);
      if (raced) return raced;
    }
    console.error(
      "billing: ACO credit change failed",
      error instanceof Error ? error.message : "unknown",
    );
    return { ok: false, error: "Couldn't save that. Nothing changed — try again." };
  }

  revalidatePath("/admin/charges");
  revalidatePath("/dashboard");
  return {
    ok: true,
    memberName: member.globalName ?? member.username,
    amountCents,
    balanceCents: after.cents,
    already: false,
  };
}

/** The change a key already made, as a success -- or null when it hasn't made one. */
async function existingChange(requestKey: string, viewerId: string): Promise<CreditResult | null> {
  const row = await prisma.acoCredit.findUnique({
    where: { requestKey },
    select: {
      amountCents: true,
      issuedBy: true,
      discordUserId: true,
      member: { select: { username: true, globalName: true } },
    },
  });
  // Someone else's key is not a retry of yours -- say nothing about it.
  if (!row || row.issuedBy !== viewerId) return null;
  return {
    ok: true,
    memberName: row.member.globalName ?? row.member.username,
    amountCents: row.amountCents,
    balanceCents: await getAcoCreditBalance(row.discordUserId),
    already: true,
  };
}

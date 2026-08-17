"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/db/client";
import { requireAdmin, requireMember } from "@/lib/auth/guard";
import { isPaymentMethod, methodLabel } from "@/lib/billing/methods";

/**
 * The paid workflow.
 *
 * Two distinct facts, two distinct actors:
 *
 *   - A member CLAIMS they have sent payment. That is a message, not money.
 *   - The operator CONFIRMS it arrived. That writes a `payments` receipt and stamps
 *     `paidAt`. Only this clears the balance.
 *
 * Rules that hold throughout:
 *
 *   - The bill's amounts are NEVER touched. Not on claim, not on confirmation, not on
 *     reversal. `subtotalCents` / `discountCents` / `totalCents` are what the member was
 *     told they owed, and that has to stay answerable months later.
 *   - Corrections append. Un-confirming writes a negative `payments` row rather than
 *     deleting the original, so the history reads as "received, then reversed" instead
 *     of silently never having happened.
 *   - Member actions take the owner id from the guard and carry both predicates, so a
 *     member cannot touch another's bill by editing the hidden input.
 *   - Dry-run bills are not payable. Nobody was DMed and nobody owes anything.
 */

export type BillingResult = { ok: true } | { ok: false; error: string };

const NOTE_MAX = 140;

function note(form: FormData, key: string): string | null {
  const value = String(form.get(key) ?? "")
    .trim()
    .slice(0, NOTE_MAX);
  return value || null;
}

// ---------------------------------------------------------------------------
// Member
// ---------------------------------------------------------------------------

/** "I've sent this." Records the claim; does not mark the bill paid. */
export async function claimBillPaid(form: FormData): Promise<BillingResult> {
  const viewer = await requireMember();
  const billId = String(form.get("billId") ?? "");
  const method = String(form.get("method") ?? "");

  if (!isPaymentMethod(method)) return { ok: false, error: "Pick how you sent it." };

  const bill = await prisma.pasBill.findFirst({
    where: { id: billId, discordUserId: viewer.discordUserId, run: { dryRun: false } },
    select: { id: true, paidAt: true },
  });
  if (!bill) return { ok: false, error: "Not found." };
  if (bill.paidAt) return { ok: false, error: "This charge is already marked received." };

  await prisma.pasBill.update({
    where: { id: bill.id },
    data: {
      paidClaimedAt: new Date(),
      paidClaimedMethod: method,
      paidClaimedNote: note(form, "note"),
    },
  });

  revalidatePath("/dashboard");
  revalidatePath(`/dashboard/charges/${bill.id}`);
  return { ok: true };
}

/** Undo a claim. For the mis-click, not for taking money back. */
export async function unclaimBillPaid(form: FormData): Promise<BillingResult> {
  const viewer = await requireMember();
  const billId = String(form.get("billId") ?? "");

  const bill = await prisma.pasBill.findFirst({
    where: { id: billId, discordUserId: viewer.discordUserId },
    select: { id: true, paidAt: true },
  });
  if (!bill) return { ok: false, error: "Not found." };
  // Once the operator has confirmed, the member withdrawing the claim would leave a
  // confirmed payment with nothing that says it was ever claimed. Ask them instead.
  if (bill.paidAt) return { ok: false, error: "Already confirmed — message the operator." };

  await prisma.pasBill.update({
    where: { id: bill.id },
    data: { paidClaimedAt: null, paidClaimedMethod: null, paidClaimedNote: null },
  });

  revalidatePath("/dashboard");
  revalidatePath(`/dashboard/charges/${bill.id}`);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Operator
// ---------------------------------------------------------------------------

/**
 * Money arrived. Writes the receipt and stamps the bill.
 *
 * Both writes go in one transaction: a `paidAt` without its `payments` row would be a
 * balance cleared with no evidence, which is the exact thing this table exists to stop.
 */
export async function confirmBillPaid(form: FormData): Promise<BillingResult> {
  const viewer = await requireAdmin();
  const billId = String(form.get("billId") ?? "");

  const bill = await prisma.pasBill.findFirst({
    where: { id: billId, run: { dryRun: false } },
    select: { id: true, totalCents: true, paidAt: true, paidClaimedMethod: true },
  });
  if (!bill) return { ok: false, error: "Not found." };
  if (bill.paidAt) return { ok: false, error: "Already marked received." };

  // The operator's own entry wins; otherwise inherit what the member said they used.
  const stated = String(form.get("method") ?? "");
  const method = isPaymentMethod(stated) ? stated : (bill.paidClaimedMethod ?? null);
  const at = new Date();

  await prisma.$transaction([
    prisma.payment.create({
      data: {
        pasBillId: bill.id,
        amountCents: bill.totalCents,
        method,
        note: note(form, "note"),
        recordedBy: viewer.discordUserId,
        recordedAt: at,
      },
    }),
    prisma.pasBill.update({
      where: { id: bill.id },
      data: { paidAt: at, markedPaidBy: viewer.discordUserId },
    }),
    prisma.adminAudit.create({
      data: {
        actorDiscordId: viewer.discordUserId,
        action: "payment.confirm",
        entity: "pas_bill",
        entityId: bill.id,
        after: { amountCents: bill.totalCents, method: methodLabel(method) },
      },
    }),
  ]);

  revalidatePath("/admin/charges");
  revalidatePath("/dashboard");
  revalidatePath(`/dashboard/charges/${bill.id}`);
  return { ok: true };
}

/**
 * Undo a confirmation.
 *
 * Appends a reversing `payments` row rather than deleting the original: a bill that was
 * marked received in error and then corrected is a different history from one that was
 * never marked at all, and only the first is honest.
 */
export async function reopenBill(form: FormData): Promise<BillingResult> {
  const viewer = await requireAdmin();
  const billId = String(form.get("billId") ?? "");

  const bill = await prisma.pasBill.findUnique({
    where: { id: billId },
    select: { id: true, paidAt: true, payments: { select: { amountCents: true } } },
  });
  if (!bill) return { ok: false, error: "Not found." };
  if (!bill.paidAt) return { ok: false, error: "This charge is not marked received." };

  // Reverse the NET of what has been recorded, so reopening twice cannot go negative.
  const net = bill.payments.reduce((sum, p) => sum + p.amountCents, 0);

  await prisma.$transaction([
    prisma.payment.create({
      data: {
        pasBillId: bill.id,
        amountCents: -net,
        method: "reversal",
        note: note(form, "note"),
        recordedBy: viewer.discordUserId,
      },
    }),
    prisma.pasBill.update({
      where: { id: bill.id },
      data: { paidAt: null, markedPaidBy: null },
    }),
    prisma.adminAudit.create({
      data: {
        actorDiscordId: viewer.discordUserId,
        action: "payment.reverse",
        entity: "pas_bill",
        entityId: bill.id,
        before: { paidAt: bill.paidAt.toISOString(), netCents: net },
      },
    }),
  ]);

  revalidatePath("/admin/charges");
  revalidatePath("/dashboard");
  revalidatePath(`/dashboard/charges/${bill.id}`);
  return { ok: true };
}

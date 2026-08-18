"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/db/client";
import { requireAdmin, requireMember } from "@/lib/auth/guard";
import { isPaymentMethod, methodLabel } from "@/lib/billing/methods";
import { notifyPaymentClaim } from "@/lib/billing/notify";
import { money, parseCents } from "@/lib/money";

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
 *
 * PARTIAL PAYMENTS
 *
 * A confirmation records an AMOUNT, defaulting to whatever is still outstanding. The
 * running total lives on `pas_bills.paid_cents`, written in the same transaction as its
 * `payments` row, and `paid_at` is stamped only once that total covers the bill.
 *
 * That invariant -- `paid_at IS NOT NULL` exactly when the bill is settled in full -- is
 * what let partial payments land without touching a single query filter or index. A
 * half-paid bill is still `paidAt: null`, so it still reads as outstanding everywhere;
 * only the amounts had to learn the difference.
 */

export type BillingResult = { ok: true } | { ok: false; error: string };

const NOTE_MAX = 140;

/** What is still owed. Never negative, so an overpayment can't invert a balance. */
function outstanding(bill: { totalCents: number; paidCents: number }): number {
  return Math.max(0, bill.totalCents - bill.paidCents);
}

/**
 * The amount a form is asking to record, or the whole remaining balance when it says
 * nothing. Rejects what cannot be a payment rather than silently clamping: "0" and "50"
 * against a $42 balance are both mistakes worth naming.
 */
function requestedCents(
  form: FormData,
  key: string,
  remaining: number,
): { cents: number } | { error: string } {
  const raw = String(form.get(key) ?? "").trim();
  if (!raw) return { cents: remaining };

  const cents = parseCents(raw);
  if (cents === null) return { error: "Enter an amount like 12.50." };
  if (cents === 0) return { error: "Enter an amount greater than zero." };
  if (cents > remaining) {
    return { error: `That is more than the ${money(remaining)} still outstanding.` };
  }
  return { cents };
}

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
    select: {
      id: true,
      paidAt: true,
      totalCents: true,
      paidCents: true,
      run: { select: { dropLabel: true } },
    },
  });
  if (!bill) return { ok: false, error: "Not found." };
  if (bill.paidAt) return { ok: false, error: "This charge is already settled." };

  const remaining = outstanding(bill);
  if (remaining === 0) return { ok: false, error: "Nothing outstanding on this charge." };

  // Claiming part of a balance is allowed: a member paying half should be able to say so
  // rather than claim the whole amount and leave the operator to discover otherwise.
  const asked = requestedCents(form, "amount", remaining);
  if ("error" in asked) return { ok: false, error: asked.error };
  const amount = asked.cents;

  const claimNote = note(form, "note");

  await prisma.pasBill.update({
    where: { id: bill.id },
    data: {
      paidClaimedAt: new Date(),
      paidClaimedMethod: method,
      paidClaimedNote: claimNote,
      // Null when they are claiming the whole remaining balance, which is what every
      // claim made before partial payments existed meant.
      paidClaimedCents: amount === remaining ? null : amount,
    },
  });

  // After the write, and never allowed to fail it: the claim is what the admin queue
  // reads, the ping is only how the operator hears about it sooner.
  await notifyPaymentClaim({
    memberName: viewer.displayName,
    // What they say they sent, not the bill total -- otherwise a $10 payment against a
    // $42 charge pings the operator as $42 and the numbers stop matching.
    amountCents: amount,
    outstandingCents: remaining,
    dropLabel: bill.run.dropLabel,
    method: methodLabel(method),
    note: claimNote,
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
 * Money arrived. Writes the receipt and updates the running total.
 *
 * All writes go in one transaction: a `paidAt` without its `payments` row would be a
 * balance cleared with no evidence, which is the exact thing that table exists to stop,
 * and a `paid_cents` that disagrees with the receipts would be worse than either.
 *
 * PARTIAL: an `amount` records that much and leaves the bill outstanding for the rest.
 * Omitting it settles the remaining balance, which is the common case and the old
 * behaviour.
 */
export async function confirmBillPaid(form: FormData): Promise<BillingResult> {
  const viewer = await requireAdmin();
  const billId = String(form.get("billId") ?? "");

  const bill = await prisma.pasBill.findFirst({
    where: { id: billId, run: { dryRun: false } },
    select: {
      id: true,
      totalCents: true,
      paidCents: true,
      paidAt: true,
      paidClaimedMethod: true,
    },
  });
  if (!bill) return { ok: false, error: "Not found." };
  if (bill.paidAt) return { ok: false, error: "Already settled in full." };

  const remaining = outstanding(bill);
  if (remaining === 0) return { ok: false, error: "Nothing outstanding on this charge." };

  const asked = requestedCents(form, "amount", remaining);
  if ("error" in asked) return { ok: false, error: asked.error };
  const amount = asked.cents;

  // The operator's own entry wins; otherwise inherit what the member said they used.
  const stated = String(form.get("method") ?? "");
  const method = isPaymentMethod(stated) ? stated : (bill.paidClaimedMethod ?? null);
  const at = new Date();
  const settled = bill.paidCents + amount >= bill.totalCents;

  await prisma.$transaction([
    prisma.payment.create({
      data: {
        pasBillId: bill.id,
        amountCents: amount,
        method,
        note: note(form, "note"),
        recordedBy: viewer.discordUserId,
        recordedAt: at,
      },
    }),
    prisma.pasBill.update({
      where: { id: bill.id },
      data: {
        // Incremented rather than assigned, so two confirmations racing cannot lose one.
        paidCents: { increment: amount },
        // Stamped ONLY when the bill is now covered -- that is the invariant every
        // balance filter still relies on. A part payment leaves it null, and the charge
        // keeps showing as outstanding for the remainder.
        ...(settled ? { paidAt: at, markedPaidBy: viewer.discordUserId } : {}),
        // The claim has been acted on either way; leaving it would keep the charge in the
        // operator's queue after they have already dealt with it.
        paidClaimedAt: null,
        paidClaimedMethod: null,
        paidClaimedNote: null,
        paidClaimedCents: null,
      },
    }),
    prisma.adminAudit.create({
      data: {
        actorDiscordId: viewer.discordUserId,
        action: settled ? "payment.confirm" : "payment.confirm_partial",
        entity: "pas_bill",
        entityId: bill.id,
        after: {
          amountCents: amount,
          method: methodLabel(method),
          paidCents: bill.paidCents + amount,
          totalCents: bill.totalCents,
          settled,
        },
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
    select: { id: true, paidAt: true, paidCents: true, payments: { select: { amountCents: true } } },
  });
  if (!bill) return { ok: false, error: "Not found." };

  // Reverse the NET of what has been recorded, so reopening twice cannot go negative.
  const net = bill.payments.reduce((sum, p) => sum + p.amountCents, 0);
  // Anything recorded can be reversed, not only a bill settled in full: a part payment
  // entered against the wrong charge needs undoing just as much, and before partial
  // payments existed there was no such state to handle.
  if (net === 0) return { ok: false, error: "Nothing has been recorded against this charge." };

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
      // Back to zero, matching the reversed receipts: the running total has to agree with
      // the sum of payments or the two tell different stories.
      data: { paidAt: null, markedPaidBy: null, paidCents: 0 },
    }),
    prisma.adminAudit.create({
      data: {
        actorDiscordId: viewer.discordUserId,
        action: "payment.reverse",
        entity: "pas_bill",
        entityId: bill.id,
        before: { paidAt: bill.paidAt?.toISOString() ?? null, netCents: net },
      },
    }),
  ]);

  revalidatePath("/admin/charges");
  revalidatePath("/dashboard");
  revalidatePath(`/dashboard/charges/${bill.id}`);
  return { ok: true };
}

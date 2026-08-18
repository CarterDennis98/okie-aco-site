import "server-only";

/**
 * Telling the operator a member says they've paid.
 *
 * Separate webhook from the vault's: this goes to #aco-notifications, which is about
 * money moving, while vault changes are about credentials changing. Different channels
 * mean the operator can mute one without losing the other.
 *
 * Fire-and-forget by design. A claim is already durable in the database the moment this
 * runs -- the badge and the admin queue are driven from that row, not from this message
 * -- so a Discord outage costs a ping, never the claim itself. Nothing here throws.
 *
 * NO AMOUNT-FREE POLICY HERE, deliberately, unlike the vault webhook: the operator needs
 * to know what to look for in their payment app, and this channel is theirs. It still
 * carries no card details, because it never sees any.
 */

const WEBHOOK_URL = process.env.DISCORD_PAYMENT_WEBHOOK_URL;
const TIMEOUT_MS = 5_000;

export type PaymentClaim = {
  memberName: string;
  amountCents: number;
  dropLabel: string;
  method: string;
  note: string | null;
};

function money(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export async function notifyPaymentClaim(claim: PaymentClaim): Promise<void> {
  if (!WEBHOOK_URL) return;

  const note = claim.note ? `\n-# reference: ${claim.note}` : "";
  const content =
    `**${claim.memberName}** says they've sent ${money(claim.amountCents)} ` +
    `for ${claim.dropLabel} via ${claim.method}.${note}`;

  try {
    const response = await fetch(WEBHOOK_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        content,
        // A member's own reference text is echoed here; it must never ping anybody.
        allowed_mentions: { parse: [] },
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`webhook returned ${response.status}`);
  } catch (error) {
    // The claim is already recorded; this is only the announcement.
    console.error("billing: payment claim recorded but not announced", error);
  }
}

import { getAcoCreditBalances } from "@/db/queries/aco-credit";
import { authorizeBot } from "@/lib/bot-auth";

/**
 * ACO credit balances, read by the bot when it prices a `/pas run`.
 *
 * The site holds the ledger (AcoCredit) and records what each bill spends when the run is
 * posted back (PasBill.creditCents). The bot takes these balances, subtracts whatever its own
 * sent-but-not-yet-posted runs spent, and applies what's left to the operator's bills.
 *
 * Only balances above zero: nothing else can be spent. Keyed by Discord id, in cents.
 */
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const auth = authorizeBot(request);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });

  const balances = await getAcoCreditBalances();
  return Response.json({
    balances: Object.fromEntries([...balances].filter(([, cents]) => cents > 0)),
  });
}

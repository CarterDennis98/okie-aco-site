/**
 * Check that the bot's mapped billing-run payloads satisfy the site's contract.
 *
 * The bot writes these with scripts/dump-pas-payloads (in the mirror repo) from the real
 * archived sessions; this reads them back through the same zod schema the endpoint uses.
 * Running it against real sessions rather than a fixture is the point -- the `é` and the
 * em-dash in the product names are in there, and so is the aborted-run shape.
 *
 *   npx tsx scripts/validate-pas-payloads.ts <path-to-payloads.json>
 */
import { readFileSync } from "node:fs";
import { pasRunInput } from "@/types/pas-run";

const file = process.argv[2];
if (!file) {
  console.error("Usage: npx tsx scripts/validate-pas-payloads.ts <payloads.json>");
  process.exit(2);
}

const payloads: unknown[] = JSON.parse(readFileSync(file, "utf8"));
let bad = 0;

for (const payload of payloads) {
  const result = pasRunInput.safeParse(payload);
  const id = (payload as { sessionId?: string }).sessionId ?? "<no sessionId>";

  if (result.success) {
    const bills = result.data.bills.length;
    const lines = result.data.bills.reduce((n, b) => n + b.lines.length, 0);
    console.log(`PASS  ${id}  bills=${bills} lines=${lines} delivery=${result.data.delivery.length}`);
    continue;
  }

  bad++;
  console.log(`FAIL  ${id}`);
  for (const issue of result.error.issues.slice(0, 8)) {
    console.log(`        ${issue.path.join(".") || "<root>"}: ${issue.message}`);
  }
}

console.log(
  bad === 0
    ? `\nAll ${payloads.length} payloads satisfy the contract.`
    : `\n${bad} of ${payloads.length} payload(s) rejected.`,
);
process.exit(bad === 0 ? 0 : 1);

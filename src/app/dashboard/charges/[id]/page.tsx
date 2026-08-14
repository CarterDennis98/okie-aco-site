import Link from "next/link";
import { notFound } from "next/navigation";
import { SiteFooter, SiteHeader } from "@/components/site-shell";
import { getMemberCharge } from "@/db/queries/member";
import { count, plural } from "@/lib/format";
import { money } from "@/lib/money";
import { requireMember } from "@/lib/auth/guard";

export const dynamic = "force-dynamic";

const DATE_FORMAT: Intl.DateTimeFormatOptions = {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "America/Chicago",
};

function formatDate(date: Date): string {
  return new Intl.DateTimeFormat("en-US", DATE_FORMAT).format(date);
}

/**
 * One charge, in full — the page that settles a dispute months later.
 *
 * Every figure here is the SNAPSHOT taken when the bill was sent, not a recomputation.
 * `PasBillLine.feeCents` is a stored column rather than a join to `Item.currentFeeCents`,
 * so editing a fee in admin can never rewrite what someone was already charged. The
 * verbatim DM text is shown at the bottom for the same reason: it's the record, so the
 * website and Discord can't disagree.
 */
export default async function ChargePage({ params }: PageProps<"/dashboard/charges/[id]">) {
  const viewer = await requireMember();
  const { id } = await params;

  // Both predicates in one query. A charge belonging to someone else is indistinguishable
  // from one that doesn't exist -- 404, never 403.
  const charge = await getMemberCharge(viewer.discordUserId, id);
  if (!charge) notFound();

  return (
    <>
      <SiteHeader signedIn />

      <main className="mx-auto max-w-2xl px-5 py-10 sm:py-14">
        <Link
          href="/dashboard"
          className="text-sm text-[var(--color-muted)] transition-colors hover:text-[var(--color-fg)]"
        >
          ← Dashboard
        </Link>

        <header className="mt-5 flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
          <div>
            <h1 className="text-3xl font-black tracking-tight text-white">{charge.dropLabel}</h1>
            <p className="mt-1 text-sm text-[var(--color-muted)]">
              {formatDate(charge.windowStart)}
            </p>
          </div>
          <span
            className={
              "rounded-full px-3 py-1 text-xs font-semibold tracking-wide uppercase " +
              (charge.paidAt
                ? "bg-[var(--color-elevated)] text-[var(--color-muted)]"
                : "bg-[var(--color-brand)] text-[var(--color-on-brand)]")
            }
          >
            {charge.paidAt ? "Paid" : "Unpaid"}
          </span>
        </header>

        <table className="mt-8 w-full text-sm">
          <caption className="sr-only">Itemized fees for {charge.dropLabel}</caption>
          <thead>
            <tr className="border-b border-[var(--color-edge)] text-left text-[11px] tracking-[0.12em] text-[var(--color-muted)] uppercase">
              <th scope="col" className="py-2 font-medium">
                Product
              </th>
              <th scope="col" className="py-2 text-right font-medium">
                Qty
              </th>
              <th scope="col" className="py-2 text-right font-medium">
                Fee
              </th>
              <th scope="col" className="py-2 text-right font-medium">
                Subtotal
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--color-edge)]">
            {charge.lines.map((line) => (
              <tr key={line.id}>
                <td className="py-3 pr-3 text-[var(--color-fg)]">{line.label}</td>
                <td className="py-3 text-right tabular-nums">{count(line.qty)}</td>
                <td className="py-3 text-right text-[var(--color-muted)] tabular-nums">
                  {money(line.feeCents)}
                </td>
                <td className="py-3 text-right font-medium text-white tabular-nums">
                  {money(line.subtotalCents)}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot className="border-t border-[var(--color-edge)]">
            <tr>
              <th scope="row" colSpan={3} className="py-2.5 text-right font-normal">
                Subtotal
              </th>
              <td className="py-2.5 text-right tabular-nums">{money(charge.subtotalCents)}</td>
            </tr>
            {charge.discountCents > 0 && (
              <tr className="text-[var(--color-brand)]">
                <th scope="row" colSpan={3} className="py-2.5 text-right font-normal">
                  OG discount {charge.ogApplied && "(50%)"}
                </th>
                <td className="py-2.5 text-right tabular-nums">−{money(charge.discountCents)}</td>
              </tr>
            )}
            <tr className="border-t border-[var(--color-edge)] text-lg font-bold text-white">
              <th scope="row" colSpan={3} className="py-3 text-right">
                Total
              </th>
              <td className="py-3 text-right tabular-nums">{money(charge.totalCents)}</td>
            </tr>
          </tfoot>
        </table>

        {charge.payments.length > 0 && (
          <section className="mt-10">
            <h2 className="text-sm font-bold tracking-tight text-white">Payments</h2>
            <ul className="mt-3 divide-y divide-[var(--color-edge)] rounded-xl border border-[var(--color-edge)] bg-[var(--color-surface)]">
              {charge.payments.map((payment) => (
                <li key={payment.id} className="flex items-center justify-between px-4 py-3">
                  <span className="text-sm text-[var(--color-muted)]">
                    {formatDate(payment.recordedAt)}
                    {payment.method && ` · ${payment.method}`}
                  </span>
                  <span className="text-sm font-medium text-white tabular-nums">
                    {money(payment.amountCents)}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}

        {charge.dmText && (
          <section className="mt-10">
            <h2 className="text-sm font-bold tracking-tight text-white">
              What we sent you on Discord
            </h2>
            <p className="mt-1 text-xs text-[var(--color-muted)]">
              The exact message, kept so this page and your DMs can never disagree.
            </p>
            <pre className="mt-3 overflow-x-auto rounded-xl border border-[var(--color-edge)] bg-[var(--color-surface)] p-4 text-xs leading-relaxed whitespace-pre-wrap text-[var(--color-fg)]">
              {charge.dmText}
            </pre>
          </section>
        )}

        <p className="mt-10 text-xs text-[var(--color-muted)]">
          {count(charge.lines.length)} {plural(charge.lines.length, "product")} on this charge.
          Something look wrong? Message the operator on Discord.
        </p>
      </main>

      <SiteFooter />
    </>
  );
}

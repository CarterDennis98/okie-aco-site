import Image from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ClaimPayment } from "@/components/billing/claim-payment";
import { SiteChip } from "@/components/site-chip";
import { SiteFooter, SiteHeader } from "@/components/site-shell";
import { getMemberCharge } from "@/db/queries/member";
import { count, plural } from "@/lib/format";
import { methodLabel } from "@/lib/billing/methods";
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
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <p className="text-sm text-[var(--color-muted)]">{formatDate(charge.windowStart)}</p>
              {charge.sites.map(({ site, logo }) => (
                <SiteChip key={site} site={site} logo={logo} />
              ))}
            </div>
          </div>
          <span
            className={
              "rounded-full px-3 py-1 text-xs font-semibold tracking-wide uppercase " +
              (charge.paidAt
                ? "bg-[var(--color-elevated)] text-[var(--color-muted)]"
                : charge.paidClaimedAt
                  ? "bg-[var(--color-warn)]/15 text-[var(--color-warn)]"
                  : "bg-[var(--color-brand)] text-[var(--color-on-brand)]")
            }
          >
            {charge.paidAt ? "Paid" : charge.paidClaimedAt ? "Sent" : "Unpaid"}
          </span>
        </header>

        {/* Same treatment the two admin tables get: four columns with fixed numeric widths
            need about 30rem before anything is legible, which no phone has. Scrolling the
            table inside its own box beats reflowing an itemised bill into something whose
            figures no longer line up -- this is the page someone opens to check a total.
            The negative margin lets it scroll edge-to-edge instead of inside the gutter. */}
        <div className="-mx-5 mt-8 overflow-x-auto px-5">
          <table className="w-full min-w-[30rem] text-sm">
            <caption className="sr-only">Itemized fees for {charge.dropLabel}</caption>
            <thead>
              {/* Explicit widths on the numeric columns. Left to auto-layout they collapse
                  to their content and Qty ends up almost touching Fee. */}
              <tr className="border-b border-[var(--color-edge)] text-left text-[11px] tracking-[0.12em] text-[var(--color-muted)] uppercase">
                <th scope="col" className="py-2 font-medium">
                  Product
                </th>
                <th scope="col" className="w-20 py-2 pl-6 text-right font-medium">
                  Qty
                </th>
                <th scope="col" className="w-24 py-2 pl-6 text-right font-medium">
                  Fee
                </th>
                <th scope="col" className="w-28 py-2 pl-6 text-right font-medium">
                  Subtotal
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--color-edge)]">
              {charge.lines.map((line) => (
                <tr key={line.id}>
                  <td className="py-3 pr-3">
                    <div className="flex items-center gap-3">
                      {line.imageUrl ? (
                        <Image
                          src={line.imageUrl}
                          alt=""
                          width={36}
                          height={36}
                          className="size-9 shrink-0 rounded border border-[var(--color-edge)] bg-white object-contain"
                        />
                      ) : (
                        <div
                          aria-hidden
                          className="size-9 shrink-0 rounded border border-[var(--color-edge)] bg-[var(--color-elevated)]"
                        />
                      )}
                      <span className="text-[var(--color-fg)]">{line.label}</span>
                    </div>
                  </td>
                  <td className="py-3 pl-6 text-right tabular-nums">{count(line.qty)}</td>
                  <td className="py-3 pl-6 text-right text-[var(--color-muted)] tabular-nums">
                    {money(line.feeCents)}
                  </td>
                  <td className="py-3 pl-6 text-right font-medium text-white tabular-nums">
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
                  {/* Just "Discount" -- naming the OG role or its rate would leak what the
                      perk is to anyone who screenshots a bill. The figure is still shown,
                      because it is what they were actually charged. */}
                  <th scope="row" colSpan={3} className="py-2.5 text-right font-normal">
                    Discount
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
        </div>
        <ClaimPayment
          billId={charge.id}
          totalCents={charge.totalCents}
          paidCents={charge.paidCents}
          paidAt={charge.paidAt}
          claimedAt={charge.paidClaimedAt}
          claimedCents={charge.paidClaimedCents}
          claimedMethod={charge.paidClaimedMethod}
          claimedNote={charge.paidClaimedNote}
        />

        {charge.payments.length > 0 && (
          <section className="mt-10">
            <h2 className="text-sm font-bold tracking-tight text-white">Payments</h2>
            <ul className="mt-3 divide-y divide-[var(--color-edge)] rounded-xl border border-[var(--color-edge)] bg-[var(--color-surface)]">
              {charge.payments.map((payment) => (
                <li key={payment.id} className="flex items-center justify-between px-4 py-3">
                  <span className="text-sm text-[var(--color-muted)]">
                    {formatDate(payment.recordedAt)}
                    {payment.method && ` · ${methodLabel(payment.method)}`}
                  </span>
                  <span className="text-sm font-medium text-white tabular-nums">
                    {money(payment.amountCents)}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}

        {/* The verbatim DM used to be pasted here. Removed -- the itemised table above
            already says everything it did. PasBill.dmText is still stored, so the exact
            message is available to the operator if a charge is ever disputed. */}

        <p className="mt-10 text-xs text-[var(--color-muted)]">
          {count(charge.lines.length)} {plural(charge.lines.length, "product")} on this charge.
          Something look wrong? Message Okie staff on Discord.
        </p>
      </main>

      <SiteFooter />
    </>
  );
}

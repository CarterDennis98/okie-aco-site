import Link from "next/link";
import { ConfirmPayment, ReopenBill } from "@/components/billing/confirm-payment";
import { SiteFooter, SiteHeader } from "@/components/site-shell";
import {
  getAdminChargeTotals,
  getAdminCharges,
  type ChargeFilter,
} from "@/db/queries/admin-charges";
import { requireAdmin } from "@/lib/auth/guard";
import { methodLabel } from "@/lib/billing/methods";
import { count, plural } from "@/lib/format";
import { money } from "@/lib/money";

/**
 * Charges, and the queue of payments waiting to be confirmed.
 *
 * `requireAdmin()` is called here, in the page, not in a layout: a layout doesn't
 * re-render on client navigation and doesn't wrap Server Actions. It 404s rather than
 * 403s, so a non-admin can't tell this route exists.
 *
 * The default view is `claimed` -- the rows that need a decision -- rather than every
 * charge ever billed. A queue that opens on 85 rows is a list; one that opens on the
 * three someone is waiting to hear about is a queue.
 */
export const dynamic = "force-dynamic";

export const metadata = { robots: { index: false, follow: false } };

const FILTERS: { key: ChargeFilter; label: string }[] = [
  { key: "claimed", label: "Awaiting confirmation" },
  { key: "unpaid", label: "All unpaid" },
  { key: "paid", label: "Paid" },
  { key: "all", label: "Everything" },
];

const cell = "px-3 py-2.5 text-left align-middle";

function formatDate(date: Date): string {
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export default async function AdminChargesPage({
  searchParams,
}: {
  searchParams: Promise<{ filter?: string }>;
}) {
  const viewer = await requireAdmin();
  const { filter: raw } = await searchParams;
  const filter: ChargeFilter = FILTERS.some((f) => f.key === raw)
    ? (raw as ChargeFilter)
    : "claimed";

  const [rows, totals] = await Promise.all([getAdminCharges(filter), getAdminChargeTotals()]);

  return (
    <>
      <SiteHeader signedIn />

      <main className="mx-auto max-w-6xl px-5 py-10 sm:py-14">
        <div className="flex flex-wrap items-center gap-4">
          <Link
            href="/dashboard"
            className="text-sm text-[var(--color-muted)] transition-colors hover:text-[var(--color-fg)]"
          >
            ← Dashboard
          </Link>
          <Link
            href="/admin/profiles"
            className="text-sm text-[var(--color-muted)] transition-colors hover:text-[var(--color-fg)]"
          >
            Profiles
          </Link>
        </div>

        <h1 className="mt-5 text-3xl font-black tracking-tight text-white">Charges</h1>
        <p className="mt-2 text-sm text-[var(--color-muted)]">
          Signed in as {viewer.displayName}. Marking a charge received writes a receipt — the
          bill&rsquo;s own amounts are never changed.
        </p>

        {/* --- totals --- */}
        <div className="mt-8 grid gap-3 sm:grid-cols-3">
          <Stat
            label="Awaiting confirmation"
            value={money(totals.claimedCents)}
            sub={`${count(totals.claimedCount)} ${plural(totals.claimedCount, "charge")}`}
            highlight={totals.claimedCount > 0}
          />
          <Stat
            label="Outstanding"
            value={money(totals.outstandingCents)}
            sub={`${count(totals.outstandingCount)} ${plural(totals.outstandingCount, "charge")}`}
          />
          <Stat
            label="Collected"
            value={money(totals.paidCents)}
            sub={`${count(totals.paidCount)} ${plural(totals.paidCount, "charge")}`}
          />
        </div>

        {/* --- filters --- */}
        <div className="mt-6 flex flex-wrap items-center gap-2">
          {FILTERS.map((f) => (
            <Link
              key={f.key}
              href={`/admin/charges?filter=${f.key}`}
              className={
                "rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors " +
                (f.key === filter
                  ? "border-[var(--color-brand)] bg-[var(--color-brand)]/10 text-white"
                  : "border-[var(--color-edge)] text-[var(--color-muted)] hover:text-[var(--color-fg)]")
              }
            >
              {f.label}
              {f.key === "claimed" && totals.claimedCount > 0 && (
                <span className="ml-1.5 text-[var(--color-warn)]">{totals.claimedCount}</span>
              )}
            </Link>
          ))}
        </div>

        {rows.length === 0 ? (
          <p className="mt-6 rounded-xl border border-[var(--color-edge)] bg-[var(--color-surface)] px-5 py-12 text-center text-sm text-[var(--color-muted)]">
            {filter === "claimed"
              ? "Nothing waiting. Members who mark a charge sent show up here."
              : "No charges match this filter."}
          </p>
        ) : (
          <div className="mt-6 overflow-x-auto rounded-xl border border-[var(--color-edge)] bg-[var(--color-surface)]">
            <table className="w-full min-w-[46rem] text-sm">
              <thead>
                <tr className="border-b border-[var(--color-edge)] text-[11px] tracking-[0.1em] text-[var(--color-muted)] uppercase">
                  <th className={cell}>Member</th>
                  <th className={cell}>Drop</th>
                  <th className={cell}>Status</th>
                  <th className={`${cell} text-right`}>Amount</th>
                  <th className={`${cell} text-right`}>Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--color-edge)]">
                {rows.map((row) => (
                  <tr key={row.id}>
                    <td className={cell}>
                      <span className="font-medium text-white">{row.username}</span>
                    </td>
                    <td className={cell}>
                      <span className="text-[var(--color-fg)]">{row.dropLabel}</span>
                      <span className="mt-0.5 block text-xs text-[var(--color-muted)]">
                        {formatDate(row.windowStart)} · {count(row.lineCount)}{" "}
                        {plural(row.lineCount, "product")}
                      </span>
                    </td>
                    <td className={cell}>
                      {row.paidAt ? (
                        <>
                          <span className="text-[var(--color-muted)]">
                            Received {formatDate(row.paidAt)}
                          </span>
                          {row.paidClaimedMethod && (
                            <span className="mt-0.5 block text-xs text-[var(--color-muted)]">
                              {methodLabel(row.paidClaimedMethod)}
                            </span>
                          )}
                        </>
                      ) : row.paidClaimedAt ? (
                        <>
                          <span className="text-[var(--color-warn)]">
                            Sent {formatDate(row.paidClaimedAt)} ·{" "}
                            {methodLabel(row.paidClaimedMethod)}
                          </span>
                          {row.paidClaimedNote && (
                            <span className="mt-0.5 block text-xs text-[var(--color-muted)]">
                              &ldquo;{row.paidClaimedNote}&rdquo;
                            </span>
                          )}
                        </>
                      ) : (
                        <span className="text-[var(--color-muted)]">Unpaid</span>
                      )}
                    </td>
                    <td className={`${cell} text-right`}>
                      <span className="font-semibold text-white tabular-nums">
                        {money(row.totalCents)}
                      </span>
                    </td>
                    <td className={`${cell} text-right`}>
                      {row.paidAt ? (
                        <ReopenBill billId={row.id} />
                      ) : (
                        <ConfirmPayment billId={row.id} claimedMethod={row.paidClaimedMethod} />
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </main>

      <SiteFooter />
    </>
  );
}

function Stat({
  label,
  value,
  sub,
  highlight = false,
}: {
  label: string;
  value: string;
  sub: string;
  highlight?: boolean;
}) {
  return (
    <div
      className={
        "rounded-xl border bg-[var(--color-surface)] px-4 py-3.5 " +
        (highlight ? "border-[var(--color-warn)]/40" : "border-[var(--color-edge)]")
      }
    >
      <p className="text-xs font-medium tracking-wide text-[var(--color-muted)] uppercase">
        {label}
      </p>
      <p
        className={
          "mt-1 text-2xl font-black tabular-nums " +
          (highlight ? "text-[var(--color-warn)]" : "text-white")
        }
      >
        {value}
      </p>
      <p className="mt-0.5 text-xs text-[var(--color-muted)]">{sub}</p>
    </div>
  );
}

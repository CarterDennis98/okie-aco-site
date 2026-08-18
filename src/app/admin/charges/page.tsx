import Link from "next/link";
import { ConfirmPayment, ReopenBill } from "@/components/billing/confirm-payment";
import { SiteFooter, SiteHeader } from "@/components/site-shell";
import {
  PAGE_SIZE,
  getAdminChargeTotals,
  getAdminCharges,
  getDropDates,
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
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const field =
  "rounded-lg border border-[var(--color-edge)] bg-[var(--color-ink)] px-3 py-1.5 text-sm text-[var(--color-fg)] placeholder:text-[var(--color-muted)]/60 focus:border-[var(--color-brand)] focus:outline-none";

function formatDate(date: Date): string {
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export default async function AdminChargesPage({
  searchParams,
}: {
  searchParams: Promise<{
    filter?: string;
    q?: string;
    from?: string;
    to?: string;
    page?: string;
  }>;
}) {
  const viewer = await requireAdmin();
  const params = await searchParams;
  const filter: ChargeFilter = FILTERS.some((f) => f.key === params.filter)
    ? (params.filter as ChargeFilter)
    : "claimed";

  const search = params.q?.trim() || undefined;
  const from = ISO_DATE.test(params.from ?? "") ? params.from : undefined;
  const to = ISO_DATE.test(params.to ?? "") ? params.to : undefined;
  const page = Math.max(1, Number.parseInt(params.page ?? "1", 10) || 1);

  const [result, totals, drops] = await Promise.all([
    getAdminCharges({ filter, search, from, to, page }),
    getAdminChargeTotals(),
    getDropDates(),
  ]);
  const rows = result.rows;

  // Carried onto the filter tabs and the pager so one control never silently clears
  // another.
  const carry = (over: Record<string, string | number | undefined>) => {
    const next = new URLSearchParams();
    const merged = { filter, q: search, from, to, page, ...over };
    for (const [key, value] of Object.entries(merged)) {
      if (value === undefined || value === "" || (key === "page" && value === 1)) continue;
      next.set(key, String(value));
    }
    const qs = next.toString();
    return qs ? `/admin/charges?${qs}` : "/admin/charges";
  };

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
              href={carry({ filter: f.key, page: 1 })}
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

        {/* A GET form: the resulting view is a URL, so a filtered list can be linked,
            bookmarked, and reloaded. `filter` rides along as a hidden field so searching
            doesn't silently drop you back to the default tab. */}
        <form method="get" action="/admin/charges" className="mt-4 flex flex-wrap items-end gap-3">
          <input type="hidden" name="filter" value={filter} />
          <div>
            <label htmlFor="q" className="mb-1 block text-xs font-medium text-[var(--color-muted)]">
              Member
            </label>
            <input
              id="q"
              name="q"
              defaultValue={search ?? ""}
              placeholder="username"
              className={`${field} w-48`}
            />
          </div>
          <div>
            <label
              htmlFor="from"
              className="mb-1 block text-xs font-medium text-[var(--color-muted)]"
            >
              Drops from
            </label>
            <input id="from" name="from" type="date" defaultValue={from ?? ""} className={field} />
          </div>
          <div>
            <label
              htmlFor="to"
              className="mb-1 block text-xs font-medium text-[var(--color-muted)]"
            >
              to
            </label>
            <input id="to" name="to" type="date" defaultValue={to ?? ""} className={field} />
          </div>
          <button
            type="submit"
            className="rounded-lg border border-[var(--color-edge)] px-3 py-1.5 text-sm font-medium text-[var(--color-fg)] transition-colors hover:border-[var(--color-brand)]/50"
          >
            Apply
          </button>
          {(search || from || to) && (
            <Link
              href={carry({ q: undefined, from: undefined, to: undefined, page: 1 })}
              className="text-sm text-[var(--color-muted)] transition-colors hover:text-[var(--color-fg)]"
            >
              Clear
            </Link>
          )}
          {drops.length > 0 && (
            <span className="ml-auto text-xs text-[var(--color-muted)]">
              Latest drop{" "}
              <Link
                href={carry({
                  from: drops[0].date.toISOString().slice(0, 10),
                  to: drops[0].date.toISOString().slice(0, 10),
                  page: 1,
                })}
                className="underline underline-offset-2 hover:text-[var(--color-fg)]"
              >
                {drops[0].label}
              </Link>
            </span>
          )}
        </form>

        <p className="mt-4 text-xs text-[var(--color-muted)]">
          {result.total === 0
            ? "No charges match."
            : `${count(result.total)} ${plural(result.total, "charge")} · ${money(result.totalCents)}` +
              (result.pageCount > 1
                ? ` · showing ${(result.page - 1) * PAGE_SIZE + 1}–${Math.min(result.page * PAGE_SIZE, result.total)}`
                : "")}
        </p>

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
                      {/* Part-paid: what is still owed is the number the operator is
                          chasing, so it goes under the total rather than replacing it. */}
                      {!row.paidAt && row.paidCents > 0 && (
                        <span className="block text-xs text-[var(--color-muted)] tabular-nums">
                          {money(row.totalCents - row.paidCents)} left
                        </span>
                      )}
                    </td>
                    <td className={`${cell} text-right`}>
                      {row.paidAt ? (
                        <ReopenBill billId={row.id} />
                      ) : (
                        <>
                          <ConfirmPayment
                            billId={row.id}
                            totalCents={row.totalCents}
                            paidCents={row.paidCents}
                            claimedCents={row.paidClaimedCents}
                            claimedMethod={row.paidClaimedMethod}
                          />
                          {/* Reversing is offered on a part-paid row too: a payment
                              entered against the wrong charge needs undoing whether or
                              not it happened to settle the bill. */}
                          {row.paidCents > 0 && (
                            <div className="mt-1">
                              <ReopenBill billId={row.id} />
                            </div>
                          )}
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {result.pageCount > 1 && (
          <nav className="mt-4 flex items-center justify-between" aria-label="Pagination">
            <Link
              href={carry({ page: Math.max(1, result.page - 1) })}
              aria-disabled={result.page === 1}
              className={
                "rounded-lg border border-[var(--color-edge)] px-3 py-1.5 text-sm font-medium transition-colors " +
                (result.page === 1
                  ? "pointer-events-none text-[var(--color-muted)]/40"
                  : "text-[var(--color-fg)] hover:border-[var(--color-brand)]/50")
              }
            >
              ← Newer
            </Link>
            <span className="text-xs text-[var(--color-muted)]">
              Page {result.page} of {result.pageCount}
            </span>
            <Link
              href={carry({ page: Math.min(result.pageCount, result.page + 1) })}
              aria-disabled={result.page === result.pageCount}
              className={
                "rounded-lg border border-[var(--color-edge)] px-3 py-1.5 text-sm font-medium transition-colors " +
                (result.page === result.pageCount
                  ? "pointer-events-none text-[var(--color-muted)]/40"
                  : "text-[var(--color-fg)] hover:border-[var(--color-brand)]/50")
              }
            >
              Older →
            </Link>
          </nav>
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

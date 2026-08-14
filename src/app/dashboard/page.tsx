import Image from "next/image";
import Link from "next/link";
import { MemberCheckoutList } from "@/components/member-checkout-list";
import { SiteFooter, SiteHeader } from "@/components/site-shell";
import { getMemberDashboard } from "@/db/queries/member";
import { count, plural } from "@/lib/format";
import { money } from "@/lib/money";
import { signOutOfSite } from "@/lib/auth/actions";
import { requireMember } from "@/lib/auth/guard";

// Never a build-time artifact and never cached: this is one member's private data.
export const dynamic = "force-dynamic";

const PAYMENT_URL = process.env.DISCORD_PAYMENT_URL ?? null;

const DATE_FORMAT: Intl.DateTimeFormatOptions = {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "America/Chicago",
};

function formatDate(date: Date): string {
  return new Intl.DateTimeFormat("en-US", DATE_FORMAT).format(date);
}

export default async function DashboardPage() {
  // The guard lives in the page, not the layout, and its return value is the ONLY
  // source of the id below. Nothing here reads an id from the URL.
  const viewer = await requireMember();
  const data = await getMemberDashboard(viewer.discordUserId);

  return (
    <>
      <SiteHeader signedIn />

      <main className="mx-auto max-w-5xl px-5 py-10 sm:py-14">
        <header className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3.5">
            {viewer.avatarUrl ? (
              <Image
                src={viewer.avatarUrl}
                alt=""
                width={48}
                height={48}
                className="size-12 rounded-full border border-[var(--color-edge)]"
              />
            ) : (
              <div
                aria-hidden
                className="grid size-12 place-items-center rounded-full border border-[var(--color-edge)] bg-[var(--color-elevated)] text-lg font-bold text-[var(--color-muted)]"
              >
                {viewer.displayName.slice(0, 1).toUpperCase()}
              </div>
            )}
            <div>
              <h1 className="flex items-center gap-2 text-2xl font-black tracking-tight text-white">
                {viewer.displayName}
                {viewer.isOg && (
                  <span className="rounded-full bg-[var(--color-brand)] px-2 py-0.5 text-[10px] font-bold tracking-[0.1em] text-[var(--color-on-brand)] uppercase">
                    OG
                  </span>
                )}
              </h1>
              <p className="text-sm text-[var(--color-muted)]">
                {count(data.lifetimeCheckouts)} {plural(data.lifetimeCheckouts, "checkout")} ·{" "}
                {count(data.lifetimeUnits)} {plural(data.lifetimeUnits, "unit")}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {viewer.isAdmin && (
              <Link
                href="/admin/items"
                className="rounded-lg px-3 py-2 text-sm font-medium text-[var(--color-muted)] transition-colors hover:bg-[var(--color-surface)] hover:text-[var(--color-fg)]"
              >
                Admin
              </Link>
            )}
            <form action={signOutOfSite}>
              <button
                type="submit"
                className="rounded-lg px-3 py-2 text-sm font-medium text-[var(--color-muted)] transition-colors hover:bg-[var(--color-surface)] hover:text-[var(--color-fg)]"
              >
                Sign out
              </button>
            </form>
          </div>
        </header>

        {/* Balance first: it is the one thing a member opens this page to find. */}
        <section className="mt-8 rounded-xl border border-[var(--color-edge)] bg-[var(--color-surface)] p-6">
          <p className="text-[11px] tracking-[0.14em] text-[var(--color-muted)] uppercase">
            Outstanding fees
          </p>
          <p className="mt-1.5 text-4xl font-black tracking-tight text-white tabular-nums">
            {money(data.unpaidTotalCents)}
          </p>
          <p className="mt-1.5 text-sm text-[var(--color-muted)]">
            {data.unpaidCount === 0
              ? "You're all settled up."
              : `Across ${data.unpaidCount} unpaid ${plural(data.unpaidCount, "charge")}.`}
          </p>

          {data.unpaidCount > 0 && PAYMENT_URL && (
            <a
              href={PAYMENT_URL}
              className="mt-5 inline-block rounded-lg bg-[var(--color-brand)] px-5 py-2.5 text-sm font-semibold text-[var(--color-on-brand)] transition-colors hover:bg-[var(--color-brand-dark)]"
            >
              Payment methods
            </a>
          )}
        </section>

        <section className="mt-12">
          <h2 className="mb-4 flex items-center gap-2.5 text-xl font-bold tracking-tight">
            <span aria-hidden className="h-5 w-1 rounded-full bg-[var(--color-brand)]" />
            Charges
          </h2>

          {data.charges.length === 0 ? (
            <p className="rounded-xl border border-[var(--color-edge)] bg-[var(--color-surface)] px-5 py-10 text-center text-sm text-[var(--color-muted)]">
              No charges yet. Fees appear here after a drop is billed.
            </p>
          ) : (
            <ul className="divide-y divide-[var(--color-edge)] overflow-hidden rounded-xl border border-[var(--color-edge)] bg-[var(--color-surface)]">
              {data.charges.map((charge) => (
                <li key={charge.id}>
                  <Link
                    href={`/dashboard/charges/${charge.id}`}
                    className="flex items-center gap-4 px-5 py-4 transition-colors hover:bg-[var(--color-elevated)]/40"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="flex items-center gap-2 text-sm font-semibold text-white">
                        {charge.dropLabel}
                        {charge.paidAt ? (
                          <span className="rounded-full bg-[var(--color-elevated)] px-2 py-0.5 text-[10px] font-medium tracking-wide text-[var(--color-muted)] uppercase">
                            Paid
                          </span>
                        ) : (
                          <span className="rounded-full bg-[var(--color-brand)]/15 px-2 py-0.5 text-[10px] font-medium tracking-wide text-[var(--color-fg)] uppercase">
                            Unpaid
                          </span>
                        )}
                      </p>
                      <p className="mt-1 text-xs text-[var(--color-muted)]">
                        {formatDate(charge.windowStart)} · {count(charge.unitCount)}{" "}
                        {plural(charge.unitCount, "unit")} across {charge.lineCount}{" "}
                        {plural(charge.lineCount, "product")}
                        {charge.ogApplied && " · OG 50% off"}
                      </p>
                    </div>
                    <span className="text-lg font-bold text-white tabular-nums">
                      {money(charge.totalCents)}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="mt-12">
          <h2 className="mb-4 flex items-center gap-2.5 text-xl font-bold tracking-tight">
            <span aria-hidden className="h-5 w-1 rounded-full bg-[var(--color-brand)]" />
            Your checkouts
          </h2>
          <MemberCheckoutList checkouts={data.recentCheckouts} />
        </section>

        <section className="mt-12">
          <h2 className="mb-4 flex items-center gap-2.5 text-xl font-bold tracking-tight">
            <span aria-hidden className="h-5 w-1 rounded-full bg-[var(--color-brand)]" />
            Linked profiles
          </h2>

          {data.profiles.length === 0 ? (
            <p className="rounded-xl border border-[var(--color-edge)] bg-[var(--color-surface)] px-5 py-8 text-center text-sm text-[var(--color-muted)]">
              No checkout profiles are linked to your account yet. They get matched during the first
              drop you&rsquo;re billed for.
            </p>
          ) : (
            <ul className="flex flex-wrap gap-2">
              {data.profiles.map((profile) => (
                <li
                  key={profile.profileKey}
                  className="rounded-full border border-[var(--color-edge)] bg-[var(--color-surface)] px-3.5 py-1.5 text-sm text-[var(--color-fg)]"
                >
                  {profile.displayName}
                  {/* House profiles belong to a person but never generate a fee. */}
                  {!profile.billable && (
                    <span className="ml-1.5 text-xs text-[var(--color-muted)]">not billed</span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      </main>

      <SiteFooter />
    </>
  );
}

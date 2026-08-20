import Image from "next/image";
import Link from "next/link";
import { MemberCheckoutList } from "@/components/member-checkout-list";
import { SiteFooter, SiteHeader } from "@/components/site-shell";
import { getPendingConfirmationCount } from "@/db/queries/admin-charges";
import { getMemberDashboard } from "@/db/queries/member";
import { getEmailsNeedingAppPassword, getMemberProfiles } from "@/db/queries/vault";
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
  const [data, profileGroups, needingAppPassword, pendingConfirmation] = await Promise.all([
    getMemberDashboard(viewer.discordUserId),
    getMemberProfiles(viewer.discordUserId),
    getEmailsNeedingAppPassword(viewer.discordUserId),
    // Only the operator sees the badge, and only they pay for the query.
    viewer.isAdmin ? getPendingConfirmationCount() : Promise.resolve(0),
  ]);

  const allProfiles = profileGroups.flatMap((g) => g.profiles);
  const activeProfiles = allProfiles.filter((p) => p.active).length;
  const expiredCards = allProfiles.filter((p) => p.cardExpired).length;

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
            <Link
              href="/dashboard/profiles"
              className="inline-flex min-h-11 items-center rounded-lg px-3 py-2 text-sm font-medium text-[var(--color-muted)] transition-colors hover:bg-[var(--color-surface)] hover:text-[var(--color-fg)] sm:min-h-0"
            >
              Profiles
            </Link>
            {viewer.isAdmin && (
              <>
                <Link
                  href="/admin/charges"
                  className="relative inline-flex min-h-11 items-center rounded-lg px-3 py-2 text-sm font-medium text-[var(--color-muted)] transition-colors hover:bg-[var(--color-surface)] hover:text-[var(--color-fg)] sm:min-h-0"
                >
                  Charges
                  {pendingConfirmation > 0 && (
                    <span
                      // Announced rather than left as a bare number: a badge reading "3"
                      // next to "Charges" means nothing to a screen reader on its own.
                      aria-label={`${pendingConfirmation} awaiting confirmation`}
                      className="absolute -top-0.5 -right-0.5 inline-flex h-[1.125rem] min-w-[1.125rem] items-center justify-center rounded-full bg-[var(--color-warn)] px-1 text-[10px] font-bold text-[var(--color-ink)] tabular-nums"
                    >
                      {pendingConfirmation > 99 ? "99+" : pendingConfirmation}
                    </span>
                  )}
                </Link>
                <Link
                  href="/admin/profiles"
                  className="inline-flex min-h-11 items-center rounded-lg px-3 py-2 text-sm font-medium text-[var(--color-muted)] transition-colors hover:bg-[var(--color-surface)] hover:text-[var(--color-fg)] sm:min-h-0"
                >
                  Admin
                </Link>
              </>
            )}
            <form action={signOutOfSite}>
              <button
                type="submit"
                className="inline-flex min-h-11 items-center rounded-lg px-3 py-2 text-sm font-medium text-[var(--color-muted)] transition-colors hover:bg-[var(--color-surface)] hover:text-[var(--color-fg)] sm:min-h-0"
              >
                Sign out
              </button>
            </form>
          </div>
        </header>

        {/* Balance first -- it's the one thing a member opens this page to find. Amount
            left, action right, both vertically centred: stacked to the left it left
            three quarters of a full-width box empty. */}
        <section className="mt-8 flex flex-wrap items-center justify-between gap-x-8 gap-y-5 rounded-xl border border-[var(--color-edge)] bg-[var(--color-surface)] p-6">
          <div>
            <p className="text-[11px] tracking-[0.14em] text-[var(--color-muted)] uppercase">
              You owe
            </p>
            {/* Proportional figures, not tabular: equal-width digits make a large
                standalone number look loose. */}
            <p className="mt-1.5 text-5xl font-black tracking-tight text-white">
              {money(data.unpaidTotalCents)}
            </p>
            <p className="mt-2 text-sm text-[var(--color-muted)]">
              {data.unpaidCount === 0
                ? "You're all settled up."
                : `Across ${data.unpaidCount} unpaid ${plural(data.unpaidCount, "charge")} — see the breakdown below.`}
            </p>
          </div>

          {data.unpaidCount > 0 ? (
            PAYMENT_URL && (
              <a
                href={PAYMENT_URL}
                className="rounded-lg bg-[var(--color-brand)] px-6 py-3 font-semibold text-[var(--color-on-brand)] transition-colors hover:bg-[var(--color-brand-dark)]"
              >
                Payment methods
              </a>
            )
          ) : (
            // Something on the right in the settled state too, so the box doesn't read
            // as lopsided the one time there's no call to action -- and green rather
            // than grey, because settled up is the good outcome, not an absence.
            <span className="inline-flex items-center gap-2 rounded-full border border-[var(--color-good)]/40 bg-[var(--color-good)]/15 px-4 py-2 text-sm font-semibold text-[var(--color-good)]">
              <svg
                viewBox="0 0 24 24"
                className="size-4"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
              >
                <path d="m5 13 4 4L19 7" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              Nothing owed
            </span>
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
                  {/* `group` so the chevron can respond to a hover anywhere on the row,
                      not just on itself. */}
                  <Link
                    href={`/dashboard/charges/${charge.id}`}
                    className="group flex items-center gap-4 px-5 py-4 transition-colors hover:bg-[var(--color-elevated)]/40"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="flex items-center gap-2 text-sm font-semibold text-white">
                        {charge.dropLabel}
                        {charge.paidAt ? (
                          <span className="inline-flex items-center rounded-full bg-[var(--color-elevated)] px-2 py-1 text-[10px] leading-none font-medium tracking-wide text-[var(--color-muted)] uppercase">
                            Paid
                          </span>
                        ) : charge.paidCents > 0 ? (
                          // Part-paid outranks the sent claim: money actually received is
                          // a firmer fact than a claim about money, and it is what changes
                          // the number they owe.
                          <span
                            title={`${money(charge.paidCents)} of ${money(charge.totalCents)} received`}
                            className="inline-flex items-center rounded-full bg-[var(--color-warn)]/15 px-2 py-1 text-[10px] leading-none font-medium tracking-wide text-[var(--color-warn)] uppercase"
                          >
                            Part paid
                          </span>
                        ) : charge.paidClaimedAt ? (
                          <span
                            title="You marked this sent — waiting on confirmation"
                            className="inline-flex items-center rounded-full bg-[var(--color-warn)]/15 px-2 py-1 text-[10px] leading-none font-medium tracking-wide text-[var(--color-warn)] uppercase"
                          >
                            Sent
                          </span>
                        ) : (
                          <span className="inline-flex items-center rounded-full bg-[var(--color-brand)]/15 px-2 py-1 text-[10px] leading-none font-medium tracking-wide text-[var(--color-fg)] uppercase">
                            Unpaid
                          </span>
                        )}
                      </p>
                      <p className="mt-1 text-xs text-[var(--color-muted)]">
                        {formatDate(charge.windowStart)} · {count(charge.unitCount)}{" "}
                        {plural(charge.unitCount, "unit")} across {charge.lineCount}{" "}
                        {plural(charge.lineCount, "product")}
                        {/* Deliberately says nothing about OG or a rate -- the discount's
                            existence is not public. The amount is on the charge page. */}
                        {charge.discountCents > 0 && " · discount applied"}
                      </p>
                    </div>
                    <div className="flex items-center gap-2.5">
                      <span className="text-lg font-bold text-white tabular-nums">
                        {/* What is LEFT once something has been received. The full total
                            is on the charge page; the number here is the one that answers
                            "what do I still owe". */}
                        {money(
                          charge.paidAt ? charge.totalCents : charge.totalCents - charge.paidCents,
                        )}
                      </span>
                      {/* The row's only standing "this opens something" cue -- a hover
                          background alone says nothing until you're already on it. Muted
                          at rest so it reads as affordance rather than decoration, and
                          it brightens and nudges right on hover. Decorative, so
                          aria-hidden: the link's own text is the accessible name. */}
                      <svg
                        aria-hidden
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        className="size-4 shrink-0 text-[var(--color-muted)] transition-[color,transform] duration-200 group-hover:text-[var(--color-fg)] motion-safe:group-hover:translate-x-0.5"
                      >
                        <path d="m9 18 6-6-6-6" />
                      </svg>
                    </div>
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
          {/* Say so when the list is a subset. Silently stopping at the cap reads as
              "this is everything", which for a heavy account is off by hundreds. */}
          {data.lifetimeCheckouts > data.recentCheckouts.length && (
            <p className="mt-3 text-xs text-[var(--color-muted)]">
              Showing your {count(data.recentCheckouts.length)} most recent of{" "}
              {count(data.lifetimeCheckouts)}.
            </p>
          )}
        </section>

        {/* Entry point to the profile manager. The old inline "Linked profiles" list
            lived here; a summary plus a way in is more useful than the list was. */}
        <section className="mt-12">
          <h2 className="mb-4 flex items-center gap-2.5 text-xl font-bold tracking-tight">
            <span aria-hidden className="h-5 w-1 rounded-full bg-[var(--color-brand)]" />
            Your profiles
          </h2>

          <Link
            href="/dashboard/profiles"
            className="group flex flex-wrap items-center justify-between gap-x-6 gap-y-3 rounded-xl border border-[var(--color-edge)] bg-[var(--color-surface)] p-6 transition-colors hover:border-[var(--color-brand)]/40"
          >
            <div>
              <p className="text-sm text-[var(--color-fg)]">
                {allProfiles.length === 0
                  ? "No checkout profiles yet — add one so we can check out for you."
                  : `${count(activeProfiles)} active of ${count(allProfiles.length)} ${plural(allProfiles.length, "profile")} across ${count(profileGroups.length)} ${plural(profileGroups.length, "retailer")}.`}
              </p>
              <p className="mt-1.5 text-xs text-[var(--color-muted)]">
                Addresses, cards, and logins. Update them here instead of sending details over.
              </p>

              {(expiredCards > 0 || needingAppPassword.length > 0) && (
                <p className="mt-3 flex flex-wrap gap-2">
                  {expiredCards > 0 && (
                    <span className="inline-flex items-center rounded-full bg-[var(--color-brand)]/15 px-2 py-1 text-[10px] leading-none font-medium tracking-wide text-[var(--color-fg)] uppercase">
                      {count(expiredCards)} expired {plural(expiredCards, "card")}
                    </span>
                  )}
                  {needingAppPassword.length > 0 && (
                    <span className="rounded-full bg-[var(--color-elevated)] px-2 py-0.5 text-[10px] font-medium tracking-wide text-[var(--color-muted)] uppercase">
                      {count(needingAppPassword.length)} without an app password
                    </span>
                  )}
                </p>
              )}
            </div>

            <span className="flex items-center gap-2 text-sm font-semibold text-[var(--color-fg)]">
              {allProfiles.length === 0 ? "Add a profile" : "Manage"}
              <svg
                aria-hidden
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="size-4 transition-transform duration-200 motion-safe:group-hover:translate-x-0.5"
              >
                <path d="m9 18 6-6-6-6" />
              </svg>
            </span>
          </Link>
        </section>
      </main>

      <SiteFooter />
    </>
  );
}

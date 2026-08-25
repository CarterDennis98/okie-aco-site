import Link from "next/link";
import { notFound } from "next/navigation";
import { SiteFooter, SiteHeader } from "@/components/site-shell";
import { AdminMemberEmailsPanel } from "@/components/vault/admin-member-emails";
import { RevealAppPassword } from "@/components/vault/reveal-app-password";
import { SweepMailboxes, TestButton } from "@/components/vault/imap-test-controls";
import { getPendingConfirmationCount } from "@/db/queries/admin-charges";
import {
  getAllMailboxesForAdmin,
  getMemberEmailsForAdmin,
  getMemberIdentity,
  getPendingChangeCount,
} from "@/db/queries/admin-vault";
import { requireAdmin } from "@/lib/auth/guard";
import { count, plural, relativeTime } from "@/lib/format";
import { siteStyle } from "@/lib/sites";
import {
  revealAppPasswordForAdmin,
  testEmailCredentialForAdmin,
} from "@/lib/vault/admin-actions";

/**
 * IMAP mailboxes — every app password on file, and what each one covers.
 *
 * ITS OWN PAGE, not a panel under a retailer. A mailbox belongs to a PERSON: one Gmail
 * routinely reads the verification codes for the same member's Target, Walmart and
 * Pokémon Center accounts, so scoping app passwords by retailer answered a question
 * nobody asked and split the export into overlapping per-site files. The retailer pages
 * now link here instead, and the export is one file.
 *
 * `requireAdmin()` is called here, in the page, not in a layout: a layout doesn't
 * re-render on client navigation and doesn't wrap Server Actions. It 404s rather than
 * 403s, so a non-admin can't tell this route exists.
 *
 * NOTHING HERE DECRYPTS ON RENDER. Passwords arrive only through the reveal control,
 * which writes a `vault_reveals` row per read, or through the audited export.
 */
export const dynamic = "force-dynamic";

export const metadata = { robots: { index: false, follow: false } };

const field =
  "rounded-lg border border-[var(--color-edge)] bg-[var(--color-ink)] px-3 py-1.5 text-base sm:text-sm text-[var(--color-fg)] placeholder:text-[var(--color-muted)]/60 focus:border-[var(--color-brand)] focus:outline-none";

export default async function AdminImapPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; member?: string }>;
}) {
  const viewer = await requireAdmin();
  const params = await searchParams;
  const search = params.q?.trim() || undefined;
  const memberId = params.member?.trim() || undefined;

  const [view, memberEmails, member, pendingCharges, pendingChanges] = await Promise.all([
    getAllMailboxesForAdmin({ search, discordUserId: memberId }),
    // The member view reuses the panel the retailer pages used to carry, because it has
    // the one control the list can't: reveal-every-password-for-this-person, which is what
    // gets used when somebody's codes stop arriving across several accounts at once.
    memberId ? getMemberEmailsForAdmin(memberId) : Promise.resolve(null),
    memberId ? getMemberIdentity(memberId) : Promise.resolve(null),
    getPendingConfirmationCount(),
    getPendingChangeCount(),
  ]);

  // An id that isn't a member at all is a typed URL, not a state to render. A member with
  // no mailboxes IS worth rendering -- "no app passwords on file" against their name is the
  // answer somebody came here for.
  if (memberId && !member) notFound();

  const exportBase = "/api/admin/vault/export?format=imap";
  const exportHref = memberId ? `${exportBase}&member=${encodeURIComponent(memberId)}` : exportBase;

  return (
    <>
      <SiteHeader signedIn />

      <main className="mx-auto max-w-5xl px-5 py-10 sm:py-14">
        <div className="flex flex-wrap items-center gap-4">
          <Link
            href="/dashboard"
            className="text-sm text-[var(--color-muted)] transition-colors hover:text-[var(--color-fg)]"
          >
            ← Dashboard
          </Link>
          <Link
            href="/admin/charges"
            className="relative text-sm text-[var(--color-muted)] transition-colors hover:text-[var(--color-fg)]"
          >
            Charges
            {pendingCharges > 0 && (
              <span
                aria-label={`${pendingCharges} awaiting confirmation`}
                className="absolute -top-2 -right-3 inline-flex h-[1.125rem] min-w-[1.125rem] items-center justify-center rounded-full bg-[var(--color-warn)] px-1 text-[10px] font-bold text-[var(--color-ink)] tabular-nums"
              >
                {pendingCharges > 99 ? "99+" : pendingCharges}
              </span>
            )}
          </Link>
          <Link
            href="/admin/profiles"
            className="relative text-sm text-[var(--color-muted)] transition-colors hover:text-[var(--color-fg)]"
          >
            Profiles
            {pendingChanges > 0 && (
              <span
                aria-label={`${pendingChanges} profile change${
                  pendingChanges === 1 ? "" : "s"
                } pending confirmation`}
                className="absolute -top-2 -right-3 inline-flex h-[1.125rem] min-w-[1.125rem] items-center justify-center rounded-full bg-[var(--color-warn)] px-1 text-[10px] font-bold text-[var(--color-ink)] tabular-nums"
              >
                {pendingChanges > 99 ? "99+" : pendingChanges}
              </span>
            )}
          </Link>
        </div>

        <h1 className="mt-5 text-3xl font-black tracking-tight text-white">IMAP mailboxes</h1>
        <p className="mt-2 max-w-3xl text-sm text-[var(--color-muted)]">
          Every app password on file, with the retailer accounts whose verification codes land in
          it. Signed in as {viewer.displayName} — revealing or exporting a password is logged
          against your name and the member&rsquo;s. These belong to people, not retailers: one inbox
          usually serves a member&rsquo;s accounts on several sites at once.
        </p>

        {/* --- headline numbers --- */}
        <div className="mt-8 grid gap-3 sm:grid-cols-3">
          <Stat
            label="Mailboxes"
            value={count(view.total)}
            sub={`${count(view.memberCount)} ${plural(view.memberCount, "member")}`}
          />
          <Stat
            label="Nowhere to read a code"
            value={count(view.uncoveredCount)}
            sub="retailer accounts uncovered"
            highlight={view.uncoveredCount > 0}
          />
          <Stat
            label="Last check failed"
            value={count(view.failingCount)}
            sub="need re-entering by the member"
            highlight={view.failingCount > 0}
          />
        </div>

        {/* --- search and export --- */}
        <div className="mt-6 flex flex-wrap items-end gap-3">
          {/* A GET form, so a search is a URL that can be linked and reloaded. The member
              filter rides along as a hidden field rather than being cleared by a search. */}
          <form method="get" action="/admin/imap" className="flex flex-wrap items-end gap-3">
            {memberId && <input type="hidden" name="member" value={memberId} />}
            <div>
              <label
                htmlFor="q"
                className="mb-1 block text-xs font-medium text-[var(--color-muted)]"
              >
                Search
              </label>
              <input
                id="q"
                name="q"
                defaultValue={search ?? ""}
                placeholder="inbox, member, retailer account"
                className={`${field} w-72`}
              />
            </div>
            <button
              type="submit"
              className="rounded-lg border border-[var(--color-edge)] px-3 py-1.5 text-sm font-medium text-[var(--color-fg)] transition-colors hover:border-[var(--color-brand)]/50"
            >
              Search
            </button>
          </form>
          {(search || memberId) && (
            <Link
              href="/admin/imap"
              className="pb-1.5 text-sm text-[var(--color-muted)] transition-colors hover:text-[var(--color-fg)]"
            >
              Clear
            </Link>
          )}
          <a
            href={exportHref}
            // Plain anchor with `download`: a file, not a route transition.
            download
            className="ml-auto rounded-lg border border-[var(--color-edge)] px-3 py-1.5 text-sm font-medium text-[var(--color-fg)] transition-colors hover:border-[var(--color-brand)]/50"
          >
            {memberId ? "Export their app passwords" : "Export all app passwords (CSV)"}
          </a>
        </div>

        {/* --- the pre-drop sweep --- */}
        {/* Above the list rather than buried in it: "whose codes are going to fail tonight"
            is the question this page gets opened for on a drop evening, and the answer used
            to require clicking every row. Scoped to the member when one is open, so it
            doubles as "check this person" without sweeping everybody. */}
        {view.total > 0 && (
          <div className="mt-4 rounded-xl border border-[var(--color-edge)] bg-[var(--color-surface)] px-4 py-3">
            <SweepMailboxes discordUserId={memberId} total={memberId ? view.shown : view.total} />
            <p className="mt-1.5 text-[11px] text-[var(--color-muted)]">
              Signs in to each mailbox and opens the inbox — the same login the bot makes on drop
              night. Nothing is read, and no password leaves the server.
              {/* The sweep takes the MEMBER filter but not the search box, and the button's
                  count says so plainly rather than matching a list it won't match. Silently
                  sweeping 41 mailboxes while one row is on screen is the confusing version. */}
              {search && !memberId && " The search box doesn't narrow this — it checks every mailbox."}
            </p>
          </div>
        )}

        {memberId && memberEmails && member ? (
          <>
            <p className="mt-6 rounded-xl border border-[var(--color-brand)]/40 bg-[var(--color-brand)]/5 px-4 py-2.5 text-sm text-[var(--color-fg)]">
              Showing {member.displayName} only.{" "}
              <Link href="/admin/imap" className="underline underline-offset-2">
                Back to every mailbox
              </Link>
            </p>
            <AdminMemberEmailsPanel
              discordUserId={memberId}
              username={member.username}
              emails={memberEmails}
            />
          </>
        ) : (
          <>
            <p className="mt-6 text-xs text-[var(--color-muted)]">
              {view.shown === 0
                ? "No mailboxes match."
                : `${count(view.shown)} ${plural(view.shown, "mailbox", "mailboxes")}` +
                  (view.shown > view.rows.length ? ` · showing the first ${view.rows.length}` : "")}
            </p>

            {view.rows.length > 0 && (
              <ul className="mt-3 divide-y divide-[var(--color-edge)] overflow-hidden rounded-xl border border-[var(--color-edge)] bg-[var(--color-surface)]">
                {view.rows.map((row) => (
                  <li key={row.id} className="px-4 py-3.5 sm:px-5">
                    <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
                      <div className="min-w-0 flex-1">
                        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                          <span className="font-medium break-all text-white">{row.email}</span>
                          {/* The owner is a link, not a label: it is how you get from "this
                              password is failing" to everything else about that person. */}
                          <Link
                            href={`/admin/imap?member=${encodeURIComponent(row.ownerDiscordId)}`}
                            className="text-[var(--color-muted)] underline underline-offset-2 transition-colors hover:text-[var(--color-fg)]"
                          >
                            {row.ownerName}
                          </Link>
                          {row.pendingSince && (
                            <span
                              title={`Changed ${relativeTime(
                                row.pendingSince,
                              )} — the bot is still using the previous password until you confirm it on the profiles page.`}
                              className="inline-flex items-center rounded-full bg-[var(--color-warn)]/15 px-2 py-1 text-[10px] leading-none font-medium tracking-wide text-[var(--color-warn)] uppercase"
                            >
                              Pending
                            </span>
                          )}
                        </p>
                        <p className="mt-1 text-xs text-[var(--color-muted)]">
                          {/* The Test button on this row is what writes these. "Saved" now
                              means nobody has checked it yet, not that a check is pending. */}
                          <span
                            // The provider's own refusal. Too long for the line, and the
                            // exact wording is what says whether to regenerate the password
                            // or go and turn IMAP back on.
                            title={row.lastError ?? undefined}
                            className={row.lastError ? "text-[var(--color-warn)]" : undefined}
                          >
                            {row.lastError
                              ? "Last check failed — needs re-entering"
                              : row.verifiedAt
                                ? "Working"
                                : "Saved"}
                          </span>
                          {row.lastCheckedAt && ` · checked ${relativeTime(row.lastCheckedAt)}`}
                          {row.provider ? ` · ${row.provider}` : " · unknown provider"}
                          {row.imapHost && ` · ${row.imapHost}:${row.imapPort ?? 993}`}
                          {row.aliases.length > 0 &&
                            ` · ${row.aliases.length} forwarded ${plural(
                              row.aliases.length,
                              "address",
                              "addresses",
                            )}`}
                        </p>
                      </div>
                      {/* This row IS the mailbox, so there is no forwarding hop to describe. */}
                      <span className="flex flex-wrap items-center justify-end gap-x-3 gap-y-1">
                        <TestButton email={row.email} action={testEmailCredentialForAdmin} />
                        <RevealAppPassword
                          email={row.email}
                          mailbox={row.email}
                          action={revealAppPasswordForAdmin}
                        />
                      </span>
                    </div>

                    {row.covers.length > 0 && (
                      <ul className="mt-2 flex flex-col gap-1">
                        {row.covers.map((account) => (
                          <li
                            key={account.email}
                            className="flex flex-wrap items-center gap-1.5 text-[11px] text-[var(--color-muted)]"
                          >
                            <span aria-hidden>↳</span>
                            <span className="break-all">{account.email}</span>
                            {account.siteKeys.map((key) => (
                              <span
                                key={key}
                                className="inline-flex items-center rounded-full bg-[var(--color-elevated)] px-1.5 py-0.5 text-[10px] leading-none font-medium text-[var(--color-muted)]"
                              >
                                {siteStyle(key).label}
                              </span>
                            ))}
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </>
        )}

        {/* --- gaps --- */}
        {/* Deliberately not filtered by the search box: this is the list somebody has to
            act on, and hiding it behind a query would mean never seeing it. Skipped in the
            member view, where the panel above already carries that member's gaps. */}
        {!memberId && view.uncovered.length > 0 && (
          <section className="mt-10">
            <h2 className="text-lg font-bold text-white">
              Nowhere to read a code
              <span className="ml-2 text-sm font-normal text-[var(--color-muted)]">
                {count(view.uncoveredCount)} {plural(view.uncoveredCount, "account")} ·{" "}
                {count(view.uncovered.length)} {plural(view.uncovered.length, "member")}
              </span>
            </h2>
            <p className="mt-1 mb-3 max-w-3xl text-xs text-[var(--color-muted)]">
              These retailer accounts have no app password and don&rsquo;t forward into one, so
              their codes have to be chased by hand during a drop. Retailers that never email a code
              are excluded — a Pokémon Center account is not a gap.
            </p>
            <ul className="max-h-96 divide-y divide-[var(--color-edge)] overflow-y-auto overscroll-contain rounded-xl border border-[var(--color-warn)]/40 bg-[var(--color-warn)]/5">
              {view.uncovered.map((owner) => (
                <li key={owner.discordUserId} className="px-4 py-3">
                  <p className="text-sm font-medium text-white">
                    {owner.username}
                    <span className="ml-2 text-xs font-normal text-[var(--color-muted)]">
                      {owner.accounts.length} {plural(owner.accounts.length, "account")}
                    </span>
                  </p>
                  <ul className="mt-1.5 flex flex-col gap-1">
                    {owner.accounts.map((account) => (
                      <li
                        key={account.email}
                        className="flex flex-wrap items-center gap-1.5 text-[11px] text-[var(--color-muted)]"
                      >
                        <span className="break-all text-[var(--color-fg)]">{account.email}</span>
                        {account.siteKeys.map((key) => (
                          <span
                            key={key}
                            className="inline-flex items-center rounded-full bg-[var(--color-elevated)] px-1.5 py-0.5 text-[10px] leading-none font-medium text-[var(--color-muted)]"
                          >
                            {siteStyle(key).label}
                          </span>
                        ))}
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          </section>
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

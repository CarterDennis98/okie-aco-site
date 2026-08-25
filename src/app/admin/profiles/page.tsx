import Link from "next/link";
import { notFound } from "next/navigation";
import { SiteFooter, SiteHeader } from "@/components/site-shell";
import {
  getMemberVaultForAdmin,
  getMembersForSite,
  getPendingChanges,
  getSitesWithProfiles,
} from "@/db/queries/admin-vault";
import { AdminMemberPicker } from "@/components/vault/admin-member-picker";
import { AdminPendingChanges } from "@/components/vault/admin-pending-changes";
import { getPendingConfirmationCount } from "@/db/queries/admin-charges";
import { requireAdmin } from "@/lib/auth/guard";
import { count, plural } from "@/lib/format";
import { siteStyle, siteUsesAccounts } from "@/lib/sites";
import {
  PROFILE_STATUSES,
  isProfileFilterActive,
  parseProfileFilter,
} from "@/lib/vault/profile-filter";
import { revealAppPasswordForAdmin } from "@/lib/vault/admin-actions";
import { RevealAppPassword } from "@/components/vault/reveal-app-password";

/**
 * Site -> member -> everything about their profiles.
 *
 * `requireAdmin()` is called here, in the page, not in a layout: a layout doesn't
 * re-render on client navigation and doesn't wrap Server Actions. It 404s rather than
 * 403s, so a non-admin can't tell this route exists.
 *
 * Card brand, last four, and expiry only -- never a card number or CVV. The one secret
 * readable here is an app password, behind an explicit reveal that writes a
 * `vault_reveals` row; everything else leaves only through the audited export.
 *
 * APP PASSWORDS AS A WHOLE live on /admin/imap, not here. A mailbox belongs to a person
 * and routinely serves their accounts on three retailers at once, so managing them behind
 * a retailer picker showed a third of the answer and produced one CSV per retailer for a
 * set of credentials that has no retailer in it. The per-profile reveal below stays --
 * that one is a fact about the profile you are looking at.
 */
export const dynamic = "force-dynamic";

export const metadata = { robots: { index: false, follow: false } };

const cell = "px-3 py-2 text-left align-top";
const field =
  "rounded-lg border border-[var(--color-edge)] bg-[var(--color-ink)] px-3 py-1.5 text-base sm:text-sm text-[var(--color-fg)] placeholder:text-[var(--color-muted)]/60 focus:border-[var(--color-brand)] focus:outline-none";

export default async function AdminProfilesPage({
  searchParams,
}: {
  searchParams: Promise<{
    site?: string;
    member?: string;
    changes?: string;
    q?: string;
    status?: string;
  }>;
}) {
  const viewer = await requireAdmin();
  const params = await searchParams;
  const { site, member, changes: changeFilter } = params;

  // One filter object, handed to both reads below, so the roster's match counts and the
  // table's rows are decided by the same predicate. See lib/vault/profile-filter.ts.
  const filter = parseProfileFilter(params);
  const filtering = isProfileFilterActive(filter);
  const search = params.q?.trim() || undefined;

  const [sites, pending, changes] = await Promise.all([
    getSitesWithProfiles(),
    getPendingConfirmationCount(),
    getPendingChanges(changeFilter),
  ]);
  if (sites.length === 0) {
    return (
      <>
        <SiteHeader signedIn />
        <main className="mx-auto max-w-5xl px-5 py-14">
          <h1 className="text-3xl font-black tracking-tight text-white">Profiles</h1>
          <p className="mt-4 text-[var(--color-muted)]">No profiles have been imported yet.</p>
        </main>
        <SiteFooter />
      </>
    );
  }

  const siteKey = site && sites.some((s) => s.siteKey === site) ? site : sites[0].siteKey;
  const style = siteStyle(siteKey);
  // Guest checkout means no login and no emailed code. Every "account" and "app password"
  // control on this page is gated on these -- see the export row below.
  const usesAccounts = siteUsesAccounts(siteKey);
  const usesEmailCodes = style.usesEmailCodes !== false;
  // The FULL roster, filter or no filter: `?member=` is validated against it, so a search
  // that happens to exclude whoever is open must not 404 the page out from under you.
  const members = await getMembersForSite(siteKey, filter);
  const selected = member && members.some((m) => m.discordUserId === member) ? member : null;
  const profiles = selected
    ? await getMemberVaultForAdmin(siteKey, selected, filter)
    : { rows: [], total: 0 };
  const selectedMember = members.find((m) => m.discordUserId === selected);

  if (member && !selected) notFound();

  const exportBase = `/api/admin/vault/export?site=${encodeURIComponent(siteKey)}`;

  // Every control on this page carries the others: switching retailer must not silently
  // clear a search, and filtering the pending queue must not reset the table below it.
  const carried: Record<string, string> = {};
  if (search) carried.q = search;
  if (filter.status !== "all") carried.status = filter.status;

  const hrefFor = (over: Record<string, string | undefined>) => {
    const next = new URLSearchParams();
    const merged: Record<string, string | undefined> = {
      site: siteKey,
      member: selected ?? undefined,
      changes: changeFilter,
      ...carried,
      ...over,
    };
    for (const [key, value] of Object.entries(merged)) if (value) next.set(key, value);
    return `/admin/profiles?${next.toString()}`;
  };

  // How many of the retailer's profiles the filter kept, and across how many members.
  const matchedMembers = members.filter((m) => m.matchCount > 0);
  const matchedProfiles = matchedMembers.reduce((sum, m) => sum + m.matchCount, 0);
  const allProfiles = members.reduce((sum, m) => sum + m.profileCount, 0);

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
            href="/admin/charges"
            className="relative text-sm text-[var(--color-muted)] transition-colors hover:text-[var(--color-fg)]"
          >
            Charges
            {pending > 0 && (
              <span
                aria-label={`${pending} awaiting confirmation`}
                className="absolute -top-2 -right-3 inline-flex h-[1.125rem] min-w-[1.125rem] items-center justify-center rounded-full bg-[var(--color-warn)] px-1 text-[10px] font-bold text-[var(--color-ink)] tabular-nums"
              >
                {pending > 99 ? "99+" : pending}
              </span>
            )}
          </Link>
          <Link
            href="/admin/imap"
            className="text-sm text-[var(--color-muted)] transition-colors hover:text-[var(--color-fg)]"
          >
            IMAP
          </Link>
        </div>

        <h1 className="mt-5 text-3xl font-black tracking-tight text-white">Profiles</h1>
        <p className="mt-2 text-sm text-[var(--color-muted)]">
          Signed in as {viewer.displayName}. Card numbers and security codes are never shown here —
          they leave only through an export. Revealing an app password is logged too, against your
          name and the member&rsquo;s.
        </p>

        {/* --- changes pending confirmation --- */}
        {/* Above the export tools on purpose: the sequence is export, load, then confirm, so
            the queue should be the thing you see on the way back. */}
        <AdminPendingChanges
          rows={changes.rows}
          groups={changes.groups}
          total={changes.total}
          active={changes.active}
          shown={changes.shown}
          siteKey={siteKey}
          memberId={selected}
          extraParams={carried}
        />

        {/* --- site picker --- */}
        <div className="mt-8 flex flex-wrap items-center gap-2">
          {sites.map((s) => {
            const active = s.siteKey === siteKey;
            const label = siteStyle(s.siteKey).label;
            return (
              <Link
                key={s.siteKey}
                // Drops the member -- an id valid on one retailer need not hold profiles on
                // the next, and the page 404s on a member with none. The search survives.
                href={hrefFor({ site: s.siteKey, member: undefined })}
                scroll={false}
                className={
                  "rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors " +
                  (active
                    ? "border-[var(--color-brand)] bg-[var(--color-brand)]/10 text-white"
                    : "border-[var(--color-edge)] text-[var(--color-muted)] hover:text-[var(--color-fg)]")
                }
              >
                {label} <span className="text-[var(--color-muted)]">({s.count})</span>
              </Link>
            );
          })}
        </div>

        {/* --- site-wide export --- */}
        <div className="mt-4 flex flex-wrap items-center gap-2 rounded-xl border border-[var(--color-edge)] bg-[var(--color-surface)] p-4">
          <span className="mr-1 text-sm text-[var(--color-fg)]">Export all {style.label}:</span>
          {style.profileSoftCap !== undefined ? (
            <>
              <ExportLink
                href={`${exportBase}&bot=main`}
                label={`Main bot (first ${style.profileSoftCap})`}
              />
              <ExportLink href={`${exportBase}&bot=backup`} label="Backup bot" />
            </>
          ) : (
            <ExportLink href={`${exportBase}&bot=all`} label="Profiles (AYCD)" />
          )}
          {/* Meaningless on a guest-checkout retailer: Pokémon Center has no logins to list,
              so the file came out empty and the button implied credentials that do not
              exist. */}
          {usesAccounts && (
            <ExportLink href={`${exportBase}&format=accounts`} label="Accounts (user:pass)" />
          )}
          <span className="text-xs text-[var(--color-muted)]">Active profiles only.</span>
          {/* The IMAP export used to sit in this row, one file per retailer. A mailbox is
              not a per-retailer thing, so it now lives on its own page and exports once. */}
          {usesEmailCodes && (
            <Link
              href="/admin/imap"
              className="ml-auto text-xs text-[var(--color-muted)] underline underline-offset-2 transition-colors hover:text-[var(--color-fg)]"
            >
              App passwords → IMAP
            </Link>
          )}
        </div>

        {/* --- search and active/inactive filter --- */}
        {/* A GET form, like the charges page's: the resulting view is a URL, so a search can
            be linked, bookmarked and reloaded. The site and member ride along as hidden
            fields so searching never silently switches retailer or closes the open member. */}
        <form method="get" action="/admin/profiles" className="mt-4 flex flex-wrap items-end gap-3">
          <input type="hidden" name="site" value={siteKey} />
          {selected && <input type="hidden" name="member" value={selected} />}
          {changeFilter && <input type="hidden" name="changes" value={changeFilter} />}
          <div>
            <label htmlFor="q" className="mb-1 block text-xs font-medium text-[var(--color-muted)]">
              Search {style.label} profiles
            </label>
            <input
              id="q"
              name="q"
              defaultValue={search ?? ""}
              placeholder="name, email, city, phone"
              className={`${field} w-64`}
            />
          </div>
          <div>
            <label
              htmlFor="status"
              className="mb-1 block text-xs font-medium text-[var(--color-muted)]"
            >
              Show
            </label>
            <select id="status" name="status" defaultValue={filter.status} className={field}>
              {PROFILE_STATUSES.map((s) => (
                <option key={s.key} value={s.key}>
                  {s.label}
                </option>
              ))}
            </select>
          </div>
          <button
            type="submit"
            className="rounded-lg border border-[var(--color-edge)] px-3 py-1.5 text-sm font-medium text-[var(--color-fg)] transition-colors hover:border-[var(--color-brand)]/50"
          >
            Apply
          </button>
          {filtering && (
            <Link
              href={hrefFor({ q: undefined, status: undefined })}
              scroll={false}
              className="text-sm text-[var(--color-muted)] transition-colors hover:text-[var(--color-fg)]"
            >
              Clear
            </Link>
          )}
          {filtering && (
            <span className="text-xs text-[var(--color-muted)]">
              {matchedProfiles === 0
                ? `Nothing matches on ${style.label}.`
                : `${count(matchedProfiles)} of ${count(allProfiles)} ${plural(
                    allProfiles,
                    "profile",
                  )} · ${count(matchedMembers.length)} ${plural(matchedMembers.length, "member")}`}
            </span>
          )}
        </form>

        <div className="mt-6 grid gap-6 lg:grid-cols-[20rem_1fr]">
          {/* --- member picker --- */}
          {/* Sticky + self-scrolling: 60-odd members would otherwise set the page height,
              leaving you scrolling past the whole roster to reach the profile table.
              A client component because the bulk-export selection is local state -- see
              AdminMemberPicker for why it deliberately isn't in the URL. */}
          <AdminMemberPicker
            members={members}
            siteKey={siteKey}
            style={style}
            selected={selected}
            exportBase={exportBase}
            filtering={filtering}
            // `changes` rides along HERE but not in `carried`, which the pending queue also
            // receives: the queue builds its own bucket param, and an "All" tab that
            // inherited the current one could never clear it. Opening a member must not
            // reset the queue's filter, which is what dropping it did.
            extraParams={changeFilter ? { ...carried, changes: changeFilter } : carried}
          />

          {/* --- member detail --- */}
          <div>
            {!selectedMember ? (
              <p className="rounded-xl border border-[var(--color-edge)] bg-[var(--color-surface)] px-5 py-12 text-center text-sm text-[var(--color-muted)]">
                Pick a member to see their profiles.
              </p>
            ) : (
              <>
                <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                  <h2 className="text-lg font-bold text-white">
                    {selectedMember.username}
                    <span className="ml-2 text-sm font-normal text-[var(--color-muted)]">
                      {/* Says what it is showing when that is a subset. A search result
                          presented as the whole list is how you conclude a member has one
                          profile when they have thirty. */}
                      {filtering
                        ? `${profiles.rows.length} of ${profiles.total} ${plural(
                            profiles.total,
                            "profile",
                          )}`
                        : `${profiles.total} ${plural(profiles.total, "profile")}`}
                    </span>
                  </h2>
                  <div className="flex flex-wrap gap-2">
                    <ExportLink
                      href={`${exportBase}&member=${selectedMember.discordUserId}&bot=all`}
                      label="Export profiles"
                    />
                    {usesAccounts && (
                      <ExportLink
                        href={`${exportBase}&member=${selectedMember.discordUserId}&format=accounts`}
                        label="Export accounts"
                      />
                    )}
                    {usesEmailCodes && (
                      <Link
                        href={`/admin/imap?member=${selectedMember.discordUserId}`}
                        className="rounded-lg border border-[var(--color-edge)] px-3 py-1.5 text-sm font-medium text-[var(--color-fg)] transition-colors hover:border-[var(--color-brand)]/50"
                      >
                        App passwords
                      </Link>
                    )}
                  </div>
                </div>

                {profiles.rows.length === 0 ? (
                  <p className="rounded-xl border border-[var(--color-edge)] bg-[var(--color-surface)] px-5 py-12 text-center text-sm text-[var(--color-muted)]">
                    {profiles.total === 0
                      ? `No ${style.label} profiles for this member.`
                      : `None of their ${profiles.total} ${style.label} ${plural(
                          profiles.total,
                          "profile",
                        )} match.`}
                  </p>
                ) : (
                  <div className="overflow-x-auto rounded-xl border border-[var(--color-edge)] bg-[var(--color-surface)]">
                    <table className="w-full min-w-[52rem] text-sm">
                      <thead>
                        <tr className="border-b border-[var(--color-edge)] text-[11px] tracking-[0.1em] text-[var(--color-muted)] uppercase">
                          <th className={cell}>Profile</th>
                          {/* "Account" is wrong on a guest-checkout retailer: the column holds
                              the email the order confirmation goes to, and there is no login
                              behind it. Matches the member's own form, which says the same. */}
                          <th className={cell}>{usesAccounts ? "Account" : "Checkout email"}</th>
                          <th className={cell}>Name</th>
                          <th className={cell}>Card</th>
                          <th className={cell}>Ships to</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-[var(--color-edge)]">
                        {profiles.rows.map((p) => (
                          <tr key={p.id} className={p.active ? "" : "opacity-50"}>
                            <td className={cell}>
                              <span className="font-medium text-white">{p.name}</span>
                              <span className="mt-1 flex flex-wrap gap-1">
                                {!p.active && <Tag>disabled</Tag>}
                                {p.onBackup && <Tag>backup bot</Tag>}
                              </span>
                            </td>
                            <td className={cell}>
                              <span className="text-[var(--color-fg)]">{p.email}</span>
                              <span className="mt-1 block">
                                <RevealAppPassword
                                  email={p.email}
                                  mailbox={p.mailbox}
                                  usesEmailCodes={usesEmailCodes}
                                  action={revealAppPasswordForAdmin}
                                />
                              </span>
                            </td>
                            <td className={cell}>
                              <span className="text-[var(--color-fg)]">{p.fullName}</span>
                              {p.phone && (
                                <span className="mt-0.5 block text-xs text-[var(--color-muted)]">
                                  {p.phone}
                                </span>
                              )}
                            </td>
                            <td className={cell}>
                              <span className="text-[var(--color-fg)]">{p.cardLabel}</span>
                              <span
                                className={
                                  "mt-0.5 block text-xs " +
                                  (p.cardExpired
                                    ? "text-[var(--color-brand)]"
                                    : "text-[var(--color-muted)]")
                                }
                              >
                                exp {p.cardExpiry}
                                {p.cardExpired && " · expired"}
                              </span>
                            </td>
                            <td className={cell}>
                              <span className="text-xs text-[var(--color-fg)]">{p.shipping}</span>
                              {p.billing && (
                                <span className="mt-0.5 block text-xs text-[var(--color-muted)]">
                                  bills to {p.billing}
                                </span>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </main>

      <SiteFooter />
    </>
  );
}

function Tag({
  children,
  tone = "neutral",
}: {
  children: React.ReactNode;
  tone?: "neutral" | "warn";
}) {
  return (
    <span
      className={
        "inline-flex items-center rounded-full px-2 py-1 text-[10px] leading-none font-medium tracking-wide uppercase " +
        (tone === "warn"
          ? "bg-[var(--color-warn)]/15 text-[var(--color-warn)]"
          : "bg-[var(--color-elevated)] text-[var(--color-muted)]")
      }
    >
      {children}
    </span>
  );
}

function ExportLink({ href, label }: { href: string; label: string }) {
  return (
    <a
      href={href}
      // Plain anchor, not a Link: this is a file download, not a route transition.
      download
      className="rounded-lg border border-[var(--color-edge)] px-3 py-1.5 text-sm font-medium text-[var(--color-fg)] transition-colors hover:border-[var(--color-brand)]/50"
    >
      {label}
    </a>
  );
}

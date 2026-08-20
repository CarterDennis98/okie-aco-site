import Link from "next/link";
import { notFound } from "next/navigation";
import { SiteFooter, SiteHeader } from "@/components/site-shell";
import {
  getMemberEmailsForAdmin,
  getMemberVaultForAdmin,
  getMembersForSite,
  getPendingChanges,
  getSitesWithProfiles,
} from "@/db/queries/admin-vault";
import { AdminMemberEmailsPanel } from "@/components/vault/admin-member-emails";
import { AdminMemberPicker } from "@/components/vault/admin-member-picker";
import { AdminPendingChanges } from "@/components/vault/admin-pending-changes";
import { getPendingConfirmationCount } from "@/db/queries/admin-charges";
import { requireAdmin } from "@/lib/auth/guard";
import { siteStyle, siteUsesAccounts } from "@/lib/sites";
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
 */
export const dynamic = "force-dynamic";

export const metadata = { robots: { index: false, follow: false } };

const cell = "px-3 py-2 text-left align-top";

export default async function AdminProfilesPage({
  searchParams,
}: {
  searchParams: Promise<{ site?: string; member?: string; changes?: string }>;
}) {
  const viewer = await requireAdmin();
  const { site, member, changes: changeFilter } = await searchParams;

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
  const members = await getMembersForSite(siteKey);
  const selected = member && members.some((m) => m.discordUserId === member) ? member : null;
  // The profile table is site-scoped; the mailbox panel deliberately is not. See
  // getMemberEmailsForAdmin.
  const [profiles, emails] = selected
    ? await Promise.all([
        getMemberVaultForAdmin(siteKey, selected),
        getMemberEmailsForAdmin(selected),
      ])
    : [[], null];
  const selectedMember = members.find((m) => m.discordUserId === selected);

  if (member && !selected) notFound();

  const exportBase = `/api/admin/vault/export?site=${encodeURIComponent(siteKey)}`;

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
        />

        {/* --- site picker --- */}
        <div className="mt-8 flex flex-wrap items-center gap-2">
          {sites.map((s) => {
            const active = s.siteKey === siteKey;
            const label = siteStyle(s.siteKey).label;
            return (
              <Link
                key={s.siteKey}
                href={`/admin/profiles?site=${encodeURIComponent(s.siteKey)}`}
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
          {/* Both of these are meaningless on a guest-checkout retailer: Pokémon Center has
              no logins to list and never emails a verification code, so the files came out
              empty and the buttons implied credentials that do not exist. */}
          {usesAccounts && (
            <ExportLink href={`${exportBase}&format=accounts`} label="Accounts (user:pass)" />
          )}
          {usesEmailCodes && (
            <ExportLink href={`${exportBase}&format=imap`} label="App passwords (IMAP)" />
          )}
          <span className="text-xs text-[var(--color-muted)]">Active profiles only.</span>
        </div>

        <div className="mt-8 grid gap-6 lg:grid-cols-[20rem_1fr]">
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
                      {profiles.length} profile{profiles.length === 1 ? "" : "s"}
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
                      <ExportLink
                        href={`${exportBase}&member=${selectedMember.discordUserId}&format=imap`}
                        label="Export app passwords"
                      />
                    )}
                  </div>
                </div>

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
                      {profiles.map((p) => (
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
                                usesEmailCodes={style.usesEmailCodes !== false}
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

                {emails && (
                  <AdminMemberEmailsPanel
                    discordUserId={selectedMember.discordUserId}
                    username={selectedMember.username}
                    emails={emails}
                  />
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

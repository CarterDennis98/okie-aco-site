import Link from "next/link";
import { notFound } from "next/navigation";
import { SiteFooter, SiteHeader } from "@/components/site-shell";
import {
  getMemberVaultForAdmin,
  getMembersForSite,
  getSitesWithProfiles,
} from "@/db/queries/admin-vault";
import { requireAdmin } from "@/lib/auth/guard";
import { siteStyle } from "@/lib/sites";
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
  searchParams: Promise<{ site?: string; member?: string }>;
}) {
  const viewer = await requireAdmin();
  const { site, member } = await searchParams;

  const sites = await getSitesWithProfiles();
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
  const members = await getMembersForSite(siteKey);
  const selected = member && members.some((m) => m.discordUserId === member) ? member : null;
  const profiles = selected ? await getMemberVaultForAdmin(siteKey, selected) : [];
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
            className="text-sm text-[var(--color-muted)] transition-colors hover:text-[var(--color-fg)]"
          >
            Charges
          </Link>
        </div>

        <h1 className="mt-5 text-3xl font-black tracking-tight text-white">Profiles</h1>
        <p className="mt-2 text-sm text-[var(--color-muted)]">
          Signed in as {viewer.displayName}. Card numbers and security codes are never shown here —
          they leave only through an export. Revealing an app password is logged too, against your
          name and the member&rsquo;s.
        </p>

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
          <ExportLink href={`${exportBase}&format=accounts`} label="Accounts (user:pass)" />
          <span className="text-xs text-[var(--color-muted)]">Active profiles only.</span>
        </div>

        <div className="mt-8 grid gap-6 lg:grid-cols-[20rem_1fr]">
          {/* --- member picker --- */}
          {/* Sticky + self-scrolling: 60-odd members would otherwise set the page height,
              leaving you scrolling past the whole roster to reach the profile table. */}
          <div className="lg:sticky lg:top-6 lg:self-start">
            <h2 className="mb-3 text-sm font-semibold tracking-wide text-[var(--color-muted)] uppercase">
              Members ({members.length})
            </h2>
            <ul className="max-h-[min(32rem,calc(100vh-12rem))] divide-y divide-[var(--color-edge)] overflow-y-auto overscroll-contain rounded-xl border border-[var(--color-edge)] bg-[var(--color-surface)]">
              {members.map((m) => (
                <li key={m.discordUserId}>
                  <Link
                    href={`/admin/profiles?site=${encodeURIComponent(siteKey)}&member=${m.discordUserId}`}
                    className={
                      "block px-4 py-2.5 transition-colors hover:bg-[var(--color-elevated)]/40 " +
                      (m.discordUserId === selected ? "bg-[var(--color-elevated)]/60" : "")
                    }
                  >
                    <p className="truncate text-sm font-medium text-white">{m.username}</p>
                    <p className="mt-0.5 text-xs text-[var(--color-muted)]">
                      {m.activeCount}/{m.profileCount} active
                      {m.onBackup > 0 && ` · ${m.onBackup} backup`}
                      {m.expiredCards > 0 && ` · ${m.expiredCards} expired`}
                      {m.missingAppPasswords > 0 && (
                        <span className="text-[var(--color-warn)]">
                          {" "}
                          · {m.missingAppPasswords} no app pw
                        </span>
                      )}
                    </p>
                  </Link>
                </li>
              ))}
            </ul>
          </div>

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
                    <ExportLink
                      href={`${exportBase}&member=${selectedMember.discordUserId}&format=accounts`}
                      label="Export accounts"
                    />
                  </div>
                </div>

                <div className="overflow-x-auto rounded-xl border border-[var(--color-edge)] bg-[var(--color-surface)]">
                  <table className="w-full min-w-[52rem] text-sm">
                    <thead>
                      <tr className="border-b border-[var(--color-edge)] text-[11px] tracking-[0.1em] text-[var(--color-muted)] uppercase">
                        <th className={cell}>Profile</th>
                        <th className={cell}>Account</th>
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

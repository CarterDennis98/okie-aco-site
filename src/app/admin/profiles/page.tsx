import Link from "next/link";
import { SiteFooter, SiteHeader } from "@/components/site-shell";
import {
  getMemberLoginsForAdmin,
  getMemberVaultForAdmin,
  getMembersForSite,
  getPendingChanges,
  getVaultSites,
} from "@/db/queries/admin-vault";
import { getAssigneesInUse, getRunnerNames, getRunnersForSite } from "@/db/queries/runners";
import { AdminMemberPicker } from "@/components/vault/admin-member-picker";
import { AdminPendingChanges } from "@/components/vault/admin-pending-changes";
import { RunnerSelect } from "@/components/vault/runner-select";
import { getPendingConfirmationCount } from "@/db/queries/admin-charges";
import { EVERYONE, vaultScopeFor } from "@/lib/auth/admin-scope";
import { chargeScopeOf, requireAnyAdmin } from "@/lib/auth/guard";
import { count, plural } from "@/lib/format";
import { siteStoresCardCvv, siteStyle, siteUsesAccounts, siteUsesProfiles } from "@/lib/sites";
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
 * `requireAnyAdmin()` is called here, in the page, not in a layout: a layout doesn't
 * re-render on client navigation and doesn't wrap Server Actions. It 404s rather than
 * 403s, so a non-admin can't tell this route exists.
 *
 * ONE RUNNER'S PROFILES AT A TIME. Every read below takes the scope from `vaultScopeFor`:
 * a runner sees the profiles assigned to them on their own retailers and nothing else, and
 * the export route checks the same scope on its own. A full admin opens on their OWN
 * assignments -- the set their bot runs, and the set the export buttons hand over -- and can
 * switch to everyone's, or one other runner's, with the runner tabs. Only a full admin can
 * move profiles between runners; see assign-actions.ts. Mailbox controls stay
 * full-admin-only -- see requireAnyAdmin.
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
    runner?: string;
  }>;
}) {
  const viewer = await requireAnyAdmin();
  const params = await searchParams;
  const { site, member, changes: changeFilter } = params;

  // One filter object, handed to both reads below, so the roster's match counts and the
  // table's rows are decided by the same predicate. See lib/vault/profile-filter.ts.
  const filter = parseProfileFilter(params);
  const filtering = isProfileFilterActive(filter);
  const search = params.q?.trim() || undefined;

  // Whose profiles, handed to every read below so nothing outside it is fetched at all. A
  // runner's is fixed; a full admin's `?runner=` picks one, and defaults to their own.
  const { scope, runner } = vaultScopeFor(viewer, params.runner);
  const ownView = runner === viewer.discordUserId;
  // Rides along on every link and form that stays on this page, and on the export URLs --
  // which default to the viewer's own share, so leaving it off in the own view is correct.
  const runnerParam = ownView ? undefined : runner;

  const [sitesHeld, pending, changes, inUse] = await Promise.all([
    getVaultSites(scope),
    getPendingConfirmationCount(chargeScopeOf(viewer)),
    getPendingChanges(changeFilter, scope),
    viewer.isAdmin ? getAssigneesInUse() : Promise.resolve([]),
  ]);
  // A runner always sees their own retailers, even before anything is assigned to them
  // there: a page that opened on "nothing here" would read as having no access.
  const sites = viewer.isAdmin
    ? sitesHeld
    : (scope.sites ?? []).map(
        (key) => sitesHeld.find((s) => s.siteKey === key) ?? { siteKey: key, count: 0 },
      );

  // The runner tabs: yours, everyone's, then each other person holding anything, most
  // first. Only when there is a choice -- a full admin who holds everything would otherwise
  // get two tabs showing the same list. A runner never gets them.
  const others = inUse.map((r) => r.discordUserId).filter((id) => id !== viewer.discordUserId);
  if (!ownView && runner !== EVERYONE && !others.includes(runner)) others.push(runner);
  const runnerTabs =
    viewer.isAdmin && others.length > 0 ? [viewer.discordUserId, EVERYONE, ...others] : [];

  if (sites.length === 0) {
    const names = await getRunnerNames(runnerTabs.filter((id) => id !== EVERYONE));
    return (
      <>
        <SiteHeader signedIn />
        <main className="mx-auto max-w-5xl px-5 py-14">
          <h1 className="text-3xl font-black tracking-tight text-white">Profiles</h1>
          <RunnerTabs
            tabs={runnerTabs}
            active={runner}
            viewerId={viewer.discordUserId}
            names={names}
          />
          <p className="mt-4 text-[var(--color-muted)]">
            {runner === EVERYONE
              ? "No profiles have been imported yet."
              : ownView
                ? "Nothing is assigned to you yet."
                : `Nothing is assigned to ${names[runner] ?? runner}.`}
          </p>
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
  // App passwords are a FULL admin's: a mailbox serves every retailer its owner uses, so the
  // reveals and the IMAP links stay off for a runner even where the retailer reads codes.
  const usesEmailCodes = style.usesEmailCodes !== false && viewer.isAdmin;
  // Costco: an email and a password, and no card or address at all, because the order is
  // placed by hand from the member's own account. Every column and every export below
  // that assumes a checkout profile is gated on this. See usesProfiles in sites.ts.
  const usesProfiles = siteUsesProfiles(siteKey);
  const noun = usesProfiles ? "profile" : "login";
  // Costco prompts for the security code on a saved card, so a login without one is a
  // gap worth showing. See storesCardCvv.
  const storesCardCvv = siteStoresCardCvv(siteKey);
  // The FULL roster in scope, filter or no filter: `?member=` is validated against it, so a
  // search that happens to exclude whoever is open must not close them out from under you.
  const [members, runners] = await Promise.all([
    getMembersForSite(siteKey, filter, scope),
    // Who a full admin can move this retailer's profiles to. Nobody else can move anything.
    viewer.isAdmin ? getRunnersForSite(siteKey) : Promise.resolve([]),
  ]);
  const selected = member && members.some((m) => m.discordUserId === member) ? member : null;
  const profiles =
    selected && usesProfiles
      ? await getMemberVaultForAdmin(siteKey, selected, filter, scope)
      : { rows: [], total: 0 };
  const logins =
    selected && !usesProfiles
      ? await getMemberLoginsForAdmin(siteKey, selected, filter, scope)
      : { rows: [], total: 0 };
  // Whichever kind of row this retailer has, for the counts the page states in prose.
  const held = usesProfiles ? profiles : logins;
  const selectedMember = members.find((m) => m.discordUserId === selected);
  // A member id that isn't on this roster -- a typo, or someone whose profiles here all sit
  // with another runner, which is what a move leaves behind. Said plainly rather than a 404,
  // and the same words either way, so it confirms nothing about whose profiles are whose.
  const memberOutOfView = Boolean(member) && !selected;

  // Everyone this page names as a runner, looked up once.
  const names = await getRunnerNames([
    ...runnerTabs.filter((id) => id !== EVERYONE),
    ...runners.map((r) => r.discordUserId),
    ...members.flatMap((m) => m.runners),
    ...held.rows.map((row) => row.assigneeId),
    ...changes.rows.flatMap((row) => (row.assigneeId ? [row.assigneeId] : [])),
  ]);
  const runnerOptions = runners.map((r) => ({ id: r.discordUserId, name: r.name }));
  const whose = runner === EVERYONE ? "every runner's" : ownView ? "your" : `${names[runner]}'s`;

  const exportBase =
    `/api/admin/vault/export?site=${encodeURIComponent(siteKey)}` +
    (runnerParam ? `&runner=${encodeURIComponent(runnerParam)}` : "");

  // Every control on this page carries the others: switching retailer must not silently
  // clear a search, and filtering the pending queue must not reset the table below it. The
  // search survives a switch of runner too, which is why it is kept apart from `runner`.
  const searchKept: Record<string, string> = {};
  if (search) searchKept.q = search;
  if (filter.status !== "all") searchKept.status = filter.status;
  const carried: Record<string, string> = runnerParam
    ? { ...searchKept, runner: runnerParam }
    : searchKept;

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
          {viewer.isAdmin && (
            <Link
              href="/admin/imap"
              className="text-sm text-[var(--color-muted)] transition-colors hover:text-[var(--color-fg)]"
            >
              IMAP
            </Link>
          )}
        </div>

        <h1 className="mt-5 text-3xl font-black tracking-tight text-white">Profiles</h1>
        <p className="mt-2 text-sm text-[var(--color-muted)]">
          Signed in as {viewer.displayName}.{" "}
          {/* Says whose these are, because the export buttons below hand over exactly this
              set -- and loading someone else's onto your bot runs a member twice. */}
          {runner === EVERYONE
            ? "Showing every runner's profiles, and every export here includes all of them. "
            : ownView
              ? "Showing the profiles assigned to you — the ones your bot runs. "
              : `Showing the profiles assigned to ${names[runner]}. `}
          Card numbers and security codes are never shown here — they leave only through an export.
          {usesEmailCodes &&
            " Revealing an app password is logged too, against your name and the member’s."}
        </p>

        {/* --- whose profiles --- */}
        <RunnerTabs
          tabs={runnerTabs}
          active={runner}
          viewerId={viewer.discordUserId}
          names={names}
          site={siteKey}
          extraParams={searchKept}
        />

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
          viewerId={viewer.discordUserId}
          runnerNames={names}
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
                // the next. The search and the runner survive.
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
          <span className="mr-1 text-sm text-[var(--color-fg)]">
            Export {whose} {style.label}:
          </span>
          {/* No AYCD file on a login-only retailer: there are no cards or addresses to put
              in one, and the route refuses it rather than returning an empty array. */}
          {usesProfiles &&
            (style.profileSoftCap !== undefined ? (
              <>
                <ExportLink
                  href={`${exportBase}&bot=main`}
                  label={`Main bot (first ${style.profileSoftCap})`}
                />
                <ExportLink href={`${exportBase}&bot=backup`} label="Backup bot" />
              </>
            ) : (
              <ExportLink href={`${exportBase}&bot=all`} label="Profiles (AYCD)" />
            ))}
          {/* Meaningless on a guest-checkout retailer: Pokémon Center has no logins to list,
              so the file came out empty and the button implied credentials that do not
              exist. On a login-only retailer this is the ONLY export -- the file is the
              whole record. */}
          {usesAccounts && (
            <ExportLink href={`${exportBase}&format=accounts`} label="Accounts (user:pass)" />
          )}
          <span className="text-xs text-[var(--color-muted)]">Active {noun}s only.</span>
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
          {runnerParam && <input type="hidden" name="runner" value={runnerParam} />}
          <div>
            <label htmlFor="q" className="mb-1 block text-xs font-medium text-[var(--color-muted)]">
              Search {style.label} {noun}s
            </label>
            <input
              id="q"
              name="q"
              defaultValue={search ?? ""}
              // A login has an email and nothing else, so offering "city, phone" there
              // would advertise fields the matcher has no columns for.
              placeholder={usesProfiles ? "name, email, city, phone" : "email"}
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
                    noun,
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
            // Everywhere but your own view, where every name would be yours.
            runnerNames={ownView ? undefined : names}
            // Full admins only. `from` narrows a member-level move to the share on screen,
            // so moving members from your own view never takes another runner's profiles.
            move={viewer.isAdmin ? { runners: runnerOptions, from: runner } : undefined}
          />

          {/* --- member detail --- */}
          <div>
            {!selectedMember ? (
              <p className="rounded-xl border border-[var(--color-edge)] bg-[var(--color-surface)] px-5 py-12 text-center text-sm text-[var(--color-muted)]">
                {memberOutOfView
                  ? `That member has no ${style.label} ${noun}s in this view.`
                  : `Pick a member to see their ${noun}s.`}
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
                        ? `${held.rows.length} of ${held.total} ${plural(held.total, noun)}`
                        : `${held.total} ${plural(held.total, noun)}`}
                    </span>
                  </h2>
                  <div className="flex flex-wrap gap-2">
                    {usesProfiles && (
                      <ExportLink
                        href={`${exportBase}&member=${selectedMember.discordUserId}&bot=all`}
                        label="Export profiles"
                      />
                    )}
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

                {held.rows.length === 0 ? (
                  <p className="rounded-xl border border-[var(--color-edge)] bg-[var(--color-surface)] px-5 py-12 text-center text-sm text-[var(--color-muted)]">
                    {held.total === 0
                      ? `No ${style.label} ${noun}s for this member.`
                      : `None of their ${held.total} ${style.label} ${plural(
                          held.total,
                          noun,
                        )} match.`}
                  </p>
                ) : !usesProfiles ? (
                  /* A login has one column of substance, so it gets its own narrow table
                     rather than the profile table with four empty columns in it. */
                  <div className="overflow-x-auto rounded-xl border border-[var(--color-edge)] bg-[var(--color-surface)]">
                    <table className="w-full min-w-[28rem] text-sm">
                      <thead>
                        <tr className="border-b border-[var(--color-edge)] text-[11px] tracking-[0.1em] text-[var(--color-muted)] uppercase">
                          <th className={cell}>Login</th>
                          {/* Dropped entirely rather than left empty where no code is ever
                              read -- on Costco the operator is at the login. A header over
                              a blank column reads as data that failed to load. */}
                          {usesEmailCodes && <th className={cell}>Codes land in</th>}
                          {viewer.isAdmin && <th className={cell}>Runner</th>}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-[var(--color-edge)]">
                        {logins.rows.map((l) => (
                          <tr key={l.id} className={l.active ? "" : "opacity-50"}>
                            <td className={cell}>
                              <span className="font-medium break-all text-white">{l.email}</span>
                              <span className="mt-1 flex flex-wrap gap-1">
                                {!l.active && <Tag>disabled</Tag>}
                                {/* The export skips a passwordless row rather than writing
                                    "email:" with nothing after it, so this is the only
                                    place that absence is visible. */}
                                {!l.hasPassword && <Tag tone="warn">no password</Tag>}
                                {/* Warn, not neutral: this login signs in fine and then
                                    fails the order that asks for a code it hasn't got. */}
                                {storesCardCvv && !l.hasCvv && <Tag tone="warn">no CVV</Tag>}
                              </span>
                            </td>
                            {usesEmailCodes && (
                              <td className={cell}>
                                <RevealAppPassword
                                  email={l.email}
                                  mailbox={l.mailbox}
                                  usesEmailCodes={usesEmailCodes}
                                  action={revealAppPasswordForAdmin}
                                />
                              </td>
                            )}
                            {viewer.isAdmin && (
                              <td className={cell}>
                                <RunnerSelect
                                  key={l.assigneeId}
                                  siteKey={siteKey}
                                  accountId={l.id}
                                  current={l.assigneeId}
                                  runners={runnerOptions}
                                  names={names}
                                />
                              </td>
                            )}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <div className="overflow-x-auto rounded-xl border border-[var(--color-edge)] bg-[var(--color-surface)]">
                    <table
                      className={
                        "w-full text-sm " + (viewer.isAdmin ? "min-w-[62rem]" : "min-w-[52rem]")
                      }
                    >
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
                          {/* A runner's own table is all theirs, so the column would say one
                              name forty times. A full admin gets it, with the move control. */}
                          {viewer.isAdmin && <th className={cell}>Runner</th>}
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
                            {viewer.isAdmin && (
                              <td className={cell}>
                                <RunnerSelect
                                  // Reset once the move lands and the row re-renders.
                                  key={p.assigneeId}
                                  siteKey={siteKey}
                                  accountId={p.accountId}
                                  current={p.assigneeId}
                                  runners={runnerOptions}
                                  names={names}
                                />
                              </td>
                            )}
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

/**
 * Whose profiles the page shows -- a full admin's switch between their own, everyone's, and
 * one other runner's. See vaultScopeFor. Renders nothing for a runner, who has no choice.
 *
 * Switching keeps the retailer and the search and drops the open member: someone in one
 * runner's share need not be in the next one's.
 */
function RunnerTabs({
  tabs,
  active,
  viewerId,
  names,
  site,
  extraParams,
}: {
  tabs: string[];
  active: string;
  viewerId: string;
  names: Record<string, string>;
  site?: string;
  extraParams?: Record<string, string>;
}) {
  if (tabs.length === 0) return null;

  const hrefFor = (id: string) => {
    const params = new URLSearchParams(extraParams);
    if (site) params.set("site", site);
    // Your own share is the default, so it is the one tab with no param.
    if (id !== viewerId) params.set("runner", id);
    const qs = params.toString();
    return qs ? `/admin/profiles?${qs}` : "/admin/profiles";
  };

  return (
    <div className="mt-6 flex flex-wrap items-center gap-2">
      <span className="mr-1 text-xs font-medium text-[var(--color-muted)]">Runner</span>
      {tabs.map((id) => (
        <Link
          key={id}
          href={hrefFor(id)}
          scroll={false}
          aria-current={id === active ? "page" : undefined}
          className={
            "rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors " +
            (id === active
              ? "border-[var(--color-brand)] bg-[var(--color-brand)]/10 text-white"
              : "border-[var(--color-edge)] text-[var(--color-muted)] hover:text-[var(--color-fg)]")
          }
        >
          {id === viewerId ? "Mine" : id === EVERYONE ? "Everyone" : (names[id] ?? id)}
        </Link>
      ))}
    </div>
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

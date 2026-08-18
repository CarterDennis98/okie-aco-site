import Link from "next/link";
import { EmailCredentials } from "@/components/vault/email-credentials";
import { ImportProfiles } from "@/components/vault/import-profiles";
import { SiteSwitcher } from "@/components/vault/site-switcher";
import { SiteFooter, SiteHeader } from "@/components/site-shell";
import {
  getEmailsNeedingAppPassword,
  getMemberEmailCredentials,
  getMemberProfiles,
  getNextProfileName,
} from "@/db/queries/vault";
import { requireMember } from "@/lib/auth/guard";
import { resolveSiteLogo } from "@/lib/site-logo";

// One member's checkout credentials. Never cached, never a build artifact.
export const dynamic = "force-dynamic";

// Retailers a member can add a profile for even when they have none yet. Target only
// for now -- the others come online as the bots start using stored profiles for them.
const OPEN_SITES = ["target"];

export default async function ProfilesPage() {
  const viewer = await requireMember();

  const [grouped, credentials, needingPassword] = await Promise.all([
    getMemberProfiles(viewer.discordUserId),
    getMemberEmailCredentials(viewer.discordUserId),
    getEmailsNeedingAppPassword(viewer.discordUserId),
  ]);

  // Show a section for every retailer they have profiles on, plus any open site they
  // don't yet -- otherwise a member with nothing has no way to add their first profile.
  const siteKeys = [...new Set([...grouped.map((g) => g.siteKey), ...OPEN_SITES])].sort();
  const bySite = new Map(grouped.map((g) => [g.siteKey, g.profiles]));

  // Preview only -- saveProfile recomputes the name at write time, so a stale preview
  // can never become a wrong name.
  const nextNames = new Map(
    await Promise.all(
      siteKeys.map(
        async (siteKey) =>
          [
            siteKey,
            await getNextProfileName(viewer.discordUserId, siteKey, viewer.username),
          ] as const,
      ),
    ),
  );

  return (
    <>
      <SiteHeader signedIn />

      <main className="mx-auto max-w-4xl px-5 py-10 sm:py-14">
        <Link
          href="/dashboard"
          className="text-sm text-[var(--color-muted)] transition-colors hover:text-[var(--color-fg)]"
        >
          ← Dashboard
        </Link>

        <h1 className="mt-5 text-3xl font-black tracking-tight text-white">Profiles</h1>
        <p className="mt-3 max-w-2xl text-[var(--color-muted)]">
          The accounts and checkout details we use on your behalf. Keep these current and you never
          have to send updated card or address details again.
        </p>

        {/* Said once, prominently. A member who doesn't understand this will assume the
            site lost their card the first time they open the edit form. */}
        <p className="mt-4 max-w-2xl rounded-xl border border-[var(--color-edge)] bg-[var(--color-surface)] px-4 py-3 text-sm text-[var(--color-muted)]">
          Card numbers, security codes, and passwords are encrypted the moment you save them and{" "}
          <strong className="text-[var(--color-fg)]">can never be shown back to you</strong>, here
          or anywhere else. You&rsquo;ll see the card brand and last four digits; to change a card,
          just enter the new one.{" "}
          <Link
            href="/privacy"
            className="underline underline-offset-2 hover:text-[var(--color-fg)]"
          >
            How this is stored
          </Link>
          .
        </p>

        <SiteSwitcher
          siteKeys={siteKeys}
          profilesBySite={Object.fromEntries(siteKeys.map((k) => [k, bySite.get(k) ?? []]))}
          nextNames={Object.fromEntries(siteKeys.map((k) => [k, nextNames.get(k) ?? ""]))}
          logos={Object.fromEntries(siteKeys.map((k) => [k, resolveSiteLogo(k)]))}
        />

        <EmailCredentials credentials={credentials} needingPassword={needingPassword} />

        <ImportProfiles siteKeys={siteKeys} />
      </main>

      <SiteFooter />
    </>
  );
}

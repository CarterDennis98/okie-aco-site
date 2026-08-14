import type { Metadata } from "next";
import { SiteFooter, SiteHeader } from "@/components/site-shell";

export const metadata: Metadata = {
  title: "Not a member yet",
  robots: { index: false, follow: false },
};

const DISCORD_INVITE = process.env.DISCORD_INVITE_URL ?? "#";

/**
 * Where the signIn callback sends someone whose Discord account isn't in the guild.
 *
 * Nothing was written for them -- Auth.js runs the membership check before it creates
 * any user, account, or session row -- so this is genuinely a dead end plus an invite,
 * not a half-made account.
 */
export default function NotAMemberPage() {
  return (
    <>
      <SiteHeader />

      <main className="mx-auto flex max-w-md flex-col px-5 py-20 sm:py-28">
        <h1 className="text-3xl font-black tracking-tight text-white">You&rsquo;re not in yet</h1>
        <p className="mt-3 text-[var(--color-muted)]">
          That Discord account isn&rsquo;t a member of the Okie ACO server, so there&rsquo;s nothing
          to show you. Join the server and sign in again.
        </p>

        <a
          href={DISCORD_INVITE}
          className="mt-8 rounded-lg bg-[var(--color-brand)] px-5 py-3.5 text-center font-semibold text-[var(--color-on-brand)] transition-colors hover:bg-[var(--color-brand-dark)]"
        >
          Discord invite
        </a>

        <p className="mt-6 text-xs text-[var(--color-muted)]">
          Already joined? Give Discord a moment, then{" "}
          <a href="/signin" className="text-[var(--color-fg)] underline underline-offset-2">
            try signing in again
          </a>
          .
        </p>
      </main>

      <SiteFooter />
    </>
  );
}

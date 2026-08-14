import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { DiscordMark } from "@/components/discord-mark";
import { SiteFooter, SiteHeader } from "@/components/site-shell";
import { signInWithDiscord } from "@/lib/auth/actions";
import { currentViewer } from "@/lib/auth/guard";

export const metadata: Metadata = {
  title: "Sign in",
  robots: { index: false, follow: false },
};

/**
 * Auth.js redirects here with `?error=` when the OAuth round trip fails. The codes are
 * terse and mostly mean something the member can't act on, so they map to plain
 * language rather than being printed raw.
 */
const ERRORS: Record<string, string> = {
  AccessDenied: "Discord sign-in was cancelled, or that account isn't in the server.",
  Configuration: "Sign-in isn't configured correctly yet. Let the operator know.",
  Verification: "That sign-in link has expired. Try again.",
};

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  // Already signed in: skip the button entirely.
  if (await currentViewer()) redirect("/dashboard");

  const { error } = await searchParams;
  const message = error ? (ERRORS[error] ?? "Sign-in didn't complete. Try again.") : null;

  return (
    <>
      <SiteHeader />

      <main className="mx-auto flex max-w-md flex-col px-5 py-20 sm:py-28">
        <h1 className="text-3xl font-black tracking-tight text-white">Member sign-in</h1>
        <p className="mt-3 text-[var(--color-muted)]">
          Sign in with the Discord account you use in the Okie ACO server to see your checkouts and
          fees.
        </p>

        {message && (
          <p
            role="alert"
            className="mt-6 rounded-lg border border-[var(--color-brand)]/40 bg-[var(--color-brand)]/10 px-4 py-3 text-sm text-[var(--color-fg)]"
          >
            {message}
          </p>
        )}

        <form action={signInWithDiscord} className="mt-8">
          <button
            type="submit"
            className="flex w-full items-center justify-center gap-2.5 rounded-lg bg-[var(--color-brand)] px-5 py-3.5 font-semibold text-[var(--color-on-brand)] transition-colors hover:bg-[var(--color-brand-dark)]"
          >
            <DiscordMark />
            Continue with Discord
          </button>
        </form>

        {/* Stated up front because it is unusual and worth trusting us for. */}
        <p className="mt-6 text-xs leading-relaxed text-[var(--color-muted)]">
          We request your Discord username and your membership in this one server — nothing else. No
          email address, and no list of other servers you&rsquo;re in.
        </p>
      </main>

      <SiteFooter />
    </>
  );
}

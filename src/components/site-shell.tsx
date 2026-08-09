import Link from "next/link";
import { Logo } from "@/components/brand";

const DISCORD_INVITE = process.env.DISCORD_INVITE_URL ?? "#";

/**
 * Sign-in and Discord live ONLY here. The hero and closing sections deliberately
 * carry no buttons -- repeating the same two actions three times down the page made
 * it read like a landing-page template rather than a members' club.
 */
export function SiteHeader({ signedIn = false }: { signedIn?: boolean }) {
  return (
    <header className="sticky top-0 z-20 border-b border-[var(--color-edge)] bg-[var(--color-ink)]/90 backdrop-blur-md">
      <nav className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-5 py-3">
        <Link href="/" aria-label="Okie ACO home" className="rounded-md">
          <Logo height={44} />
        </Link>

        <div className="flex items-center gap-2 sm:gap-3">
          <a
            href={DISCORD_INVITE}
            className="rounded-lg px-3 py-2 text-sm font-medium text-[var(--color-muted)] transition-colors hover:bg-[var(--color-surface)] hover:text-[var(--color-fg)]"
          >
            Discord
          </a>
          <Link
            href={signedIn ? "/dashboard" : "/signin"}
            className="rounded-lg bg-[var(--color-brand)] px-4 py-2 text-sm font-semibold text-[var(--color-on-brand)] transition-colors hover:bg-[var(--color-brand-dark)]"
          >
            {signedIn ? "Dashboard" : "Sign in"}
          </Link>
        </div>
      </nav>
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer className="mt-24 border-t border-[var(--color-edge)]">
      <div className="mx-auto flex max-w-5xl flex-col gap-5 px-5 py-9 text-sm sm:flex-row sm:items-center sm:justify-between">
        <Logo height={34} />

        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-[var(--color-muted)]">
          <a href={DISCORD_INVITE} className="transition-colors hover:text-[var(--color-fg)]">
            Discord
          </a>
          <Link href="/privacy" className="transition-colors hover:text-[var(--color-fg)]">
            Privacy
          </Link>
          <Link href="/terms" className="transition-colors hover:text-[var(--color-fg)]">
            Terms
          </Link>
        </div>
      </div>
    </footer>
  );
}

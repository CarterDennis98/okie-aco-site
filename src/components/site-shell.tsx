import Link from "next/link";

const DISCORD_INVITE = process.env.DISCORD_INVITE_URL ?? "#";

function Wordmark() {
  return (
    <span className="inline-flex items-center gap-2 font-semibold tracking-tight">
      <span
        aria-hidden
        className="grid size-7 place-items-center rounded-md bg-[var(--color-accent)] text-sm font-black text-[var(--color-ink)]"
      >
        O
      </span>
      <span className="text-[var(--color-fg)]">Okie ACO</span>
    </span>
  );
}

export function SiteHeader({ signedIn = false }: { signedIn?: boolean }) {
  return (
    <header className="sticky top-0 z-20 border-b border-[var(--color-edge)] bg-[var(--color-ink)]/85 backdrop-blur">
      <nav className="mx-auto flex max-w-5xl items-center justify-between px-5 py-4">
        <Link
          href="/"
          className="rounded focus-visible:outline-2 focus-visible:outline-[var(--color-accent)]"
        >
          <Wordmark />
        </Link>

        <div className="flex items-center gap-3 text-sm">
          <a
            href={DISCORD_INVITE}
            className="hidden text-[var(--color-muted)] transition-colors hover:text-[var(--color-fg)] sm:block"
          >
            Discord
          </a>
          <Link
            href={signedIn ? "/dashboard" : "/signin"}
            className="rounded-lg bg-[var(--color-accent)] px-3.5 py-2 font-medium text-[var(--color-ink)] transition-opacity hover:opacity-90"
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
      <div className="mx-auto flex max-w-5xl flex-col gap-4 px-5 py-8 text-sm text-[var(--color-muted)] sm:flex-row sm:items-center sm:justify-between">
        <Wordmark />
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
          <a href={DISCORD_INVITE} className="transition-colors hover:text-[var(--color-fg)]">
            Join the Discord
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

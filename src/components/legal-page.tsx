import { SiteFooter, SiteHeader } from "@/components/site-shell";

/**
 * Shared shell for the privacy policy and terms.
 *
 * Prose styling lives here rather than in each page so the two can't drift, and so
 * "last updated" is impossible to render on one and forget on the other.
 */
export function LegalPage({
  title,
  lastUpdated,
  children,
}: {
  title: string;
  lastUpdated: string;
  children: React.ReactNode;
}) {
  return (
    <>
      <SiteHeader />

      <main className="mx-auto max-w-2xl px-5 py-14 sm:py-20">
        <h1 className="text-3xl font-black tracking-tight text-white sm:text-4xl">{title}</h1>
        <p className="mt-2 text-sm text-[var(--color-muted)]">Last updated {lastUpdated}</p>

        <div
          className={
            "mt-10 flex flex-col gap-5 text-[15px] leading-relaxed text-[var(--color-fg)] " +
            // Headings and lists are styled by element so the page bodies stay readable
            // as plain content rather than a wall of utility classes.
            "[&_h2]:mt-6 [&_h2]:text-lg [&_h2]:font-bold [&_h2]:tracking-tight [&_h2]:text-white " +
            "[&_a]:underline [&_a]:underline-offset-2 [&_a]:transition-colors hover:[&_a]:text-white " +
            "[&_li]:ml-5 [&_li]:list-disc [&_li]:pl-1 [&_ul]:flex [&_ul]:flex-col [&_ul]:gap-2 " +
            "[&_strong]:font-semibold [&_strong]:text-white"
          }
        >
          {children}
        </div>
      </main>

      <SiteFooter />
    </>
  );
}

import type { Metadata } from "next";

/**
 * Metadata only. **Do not put the auth guard here.**
 *
 * Layouts don't re-render on client navigation and don't wrap Server Actions, so a
 * guard in this file would look like protection while protecting nothing. Every page
 * below calls `requireMember()` itself -- see src/lib/auth/guard.ts.
 */
export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

export default function DashboardLayout({ children }: LayoutProps<"/dashboard">) {
  return children;
}

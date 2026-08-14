import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "Okie ACO",
    template: "%s · Okie ACO",
  },
  description:
    "Automated checkout for high-demand collectibles. You pay the retailer directly; we charge a small fee per item. Membership through Discord.",
  metadataBase: new URL("https://okie-aco.com"),
  openGraph: {
    title: "Okie ACO",
    description: "Automated checkout for high-demand collectibles.",
    siteName: "Okie ACO",
    type: "website",
  },
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en">
      {/* Flex column + a growing <main> keeps the footer on the bottom edge when a page
          doesn't fill the viewport, without pinning it on pages that do. See globals.css
          for the main rule -- it's global so a new page can't forget it. */}
      <body className="flex min-h-dvh flex-col antialiased">{children}</body>
    </html>
  );
}

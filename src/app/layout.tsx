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
      <body className="min-h-dvh antialiased">{children}</body>
    </html>
  );
}

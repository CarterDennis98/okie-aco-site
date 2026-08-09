import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "Okie ACO",
    template: "%s · Okie ACO",
  },
  description:
    "Automated checkout for hard-to-find trading cards. Oklahoma-run, membership through Discord.",
  metadataBase: new URL("https://okie-aco.com"),
  openGraph: {
    title: "Okie ACO",
    description: "We check out the cards you can't.",
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

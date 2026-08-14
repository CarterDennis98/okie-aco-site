import "server-only";

import { existsSync } from "node:fs";
import path from "node:path";
import { siteStyle } from "@/lib/sites";

/**
 * Resolve a retailer's logo to a public path, or null if the file isn't there.
 *
 * Server-only and deliberately so: this touches the filesystem, and calling it from a
 * component that ends up inside a client boundary makes Turbopack fail the build with
 * "chunking context does not support external modules (request: node:fs)". Resolve
 * here, pass the result down as a prop.
 *
 * A missing file degrades to a monogram chip rather than a broken image, which is what
 * makes it safe for a vendor bot to start reporting a retailer we have no artwork for.
 */
export function resolveSiteLogo(site: string | null): string | null {
  if (!site) return null;
  const { logo } = siteStyle(site);
  if (!logo) return null;
  return existsSync(path.join(process.cwd(), "public", logo.replace(/^\//, ""))) ? logo : null;
}

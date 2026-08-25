import "server-only";

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { isKnownImapHost } from "@/lib/vault/email-providers";

/**
 * Is it safe to open a socket to this mail server?
 *
 * WHY THIS REPLACED AN ALLOWLIST. The first version only permitted the five hosts in
 * EMAIL_PROVIDERS, on the belief that `email_credentials.imap_host` could only ever come
 * from that table. It can't: `scripts/import-imap.ts` writes the host straight from the
 * operator's CSV, and says why -- "the export knows about self-hosted and vanity domains
 * that a lookup table would guess wrong". So every member on a vanity or self-hosted
 * mailbox got "Unreachable" from a check that never dialled anything.
 *
 * THE PROPERTY WORTH KEEPING is not "is this a provider we listed" -- it is "will this
 * make the server open a connection to something that isn't a mail server on the public
 * internet". That is what the checks below enforce, and it is compatible with a host
 * nobody has ever heard of.
 *
 * NOT A DEFENCE AGAINST AN ATTACKER WHO CONTROLS DNS. A name that resolves to a public
 * address here and a private one a millisecond later would slip through, because the
 * connection is made by name rather than by the address we validated. Closing that means
 * dialling the checked IP with the hostname pinned for TLS, which is worth doing if this
 * ever accepts a host from a form. Today the column is written by an operator running an
 * import script, so the realistic failure is a typo or a stale internal hostname in a CSV,
 * and that is exactly what this catches.
 */

export type DialCheck = { ok: true } | { ok: false; reason: string };

/** Injected in tests, so none of this needs a resolver. */
export type AddressLookup = (host: string) => Promise<string[]>;

/**
 * IMAPS, and the plaintext port some self-hosted servers still publish.
 *
 * A port allowlist is half the point of this module: without one, a hostname that resolves
 * publicly is a way to make the server speak to anything -- an internal Redis on 6379, an
 * admin panel on 8080 -- and read the first line back in an error message.
 */
const ALLOWED_PORTS = new Set([993, 143]);

/** Names that are never a public mail server, whatever DNS happens to say today. */
const BLOCKED_SUFFIXES = [".local", ".localhost", ".internal", ".lan", ".home.arpa"];

function isPrivateV4(ip: string): boolean {
  const [a, b] = ip.split(".").map(Number);
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true; // link-local, and the cloud metadata endpoint
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
  if (a === 192 && b === 0) return true; // 192.0.0/24 protocol assignments
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a >= 224) return true; // multicast and reserved
  return false;
}

function isPrivateV6(ip: string): boolean {
  const address = ip.toLowerCase().split("%")[0];
  if (address === "::1" || address === "::") return true;
  // ::ffff:a.b.c.d -- an IPv4 address wearing an IPv6 coat, and the classic bypass.
  const mapped = address.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateV4(mapped[1]);
  if (/^f[cd][0-9a-f]{2}:/.test(address)) return true; // unique local fc00::/7
  if (/^fe[89ab][0-9a-f]:/.test(address)) return true; // link local fe80::/10
  return false;
}

export function isPrivateAddress(ip: string): boolean {
  const version = isIP(ip);
  if (version === 4) return isPrivateV4(ip);
  if (version === 6) return isPrivateV6(ip);
  return true; // unparseable is not something to dial
}

async function defaultLookup(host: string): Promise<string[]> {
  const records = await lookup(host, { all: true });
  return records.map((r) => r.address);
}

/**
 * Decide whether to dial. Never throws.
 *
 * The provider hosts short-circuit: they are ours, they are public, and making every check
 * of a @gmail.com mailbox wait on a resolver to re-learn that would be silly.
 */
export async function checkDialable(
  host: string,
  port: number,
  addresses: AddressLookup = defaultLookup,
): Promise<DialCheck> {
  const name = String(host ?? "")
    .trim()
    .toLowerCase()
    .replace(/\.$/, "");

  if (!ALLOWED_PORTS.has(port)) {
    return { ok: false, reason: `port ${port} isn't an IMAP port.` };
  }
  if (isKnownImapHost(name)) return { ok: true };
  if (!name) return { ok: false, reason: "no mail server on file." };

  // An IP literal is the shape an SSRF attempt takes, and no real mail server is
  // configured as one -- IMAPS needs a name for the certificate anyway.
  if (isIP(name)) return { ok: false, reason: `${host} is an IP address, not a mail server.` };

  // A single label is an intranet name: "mailserver", "exchange01".
  if (!name.includes(".")) return { ok: false, reason: `${host} isn't a full domain name.` };
  if (name === "localhost" || BLOCKED_SUFFIXES.some((s) => name.endsWith(s))) {
    return { ok: false, reason: `${host} is a local address.` };
  }

  let resolved: string[];
  try {
    resolved = await addresses(name);
  } catch {
    return { ok: false, reason: `${host} doesn't resolve.` };
  }
  if (resolved.length === 0) return { ok: false, reason: `${host} doesn't resolve.` };

  // EVERY address, not just the first: a name that answers with one public and one private
  // address would otherwise be dialled on whichever the OS picked.
  if (resolved.some(isPrivateAddress)) {
    return { ok: false, reason: `${host} points inside a private network.` };
  }

  return { ok: true };
}

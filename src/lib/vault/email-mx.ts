import "server-only";

import { resolveMx } from "node:dns/promises";
import {
  domainOf,
  providerForEmail,
  providerForMxHosts,
  type EmailProvider,
} from "@/lib/vault/email-providers";

/**
 * Who actually handles the mail for an address.
 *
 * WHY DNS AND NOT A LIST. `@swatfame.com` was refused as an unreadable custom domain when
 * its MX records are aspmx.l.google.com and alt1-4 -- it is Google Workspace, and a Google
 * app password reads it through imap.gmail.com exactly like any @gmail.com address. The
 * domain never says who serves it; the MX records do, and they are public.
 *
 * SEPARATE MODULE, and `server-only` is the reason. email-providers.ts is imported by the
 * credentials form, which is a client component -- putting node:dns in there would break
 * the client build. The pure matching lives there; only the lookup lives here.
 *
 * A LOOKUP FAILURE IS NOT A REJECTION. DNS being briefly unreachable must not tell a member
 * their perfectly good work address is unsupported, so `lookupFailed` is reported separately
 * and the caller says "try again" rather than "no".
 */

export type MailProviderLookup = {
  /** The provider that serves this address, or null when nothing recognised it. */
  provider: EmailProvider | null;
  /** The primary MX host, so a rejection can name the fact that decided it. */
  mailHost: string | null;
  /** True when DNS itself failed, as opposed to answering "nobody you know". */
  lookupFailed: boolean;
};

/** Injected in tests. Returns mail hosts in priority order, best first. */
export type MxLookup = (domain: string) => Promise<string[]>;

/**
 * Long enough for a cold cache, short enough that a member isn't staring at a spinner.
 * Saving a credential already does encryption and three database round trips.
 */
const LOOKUP_TIMEOUT_MS = 3000;

const TIMED_OUT = Symbol("timed-out");

async function defaultLookup(domain: string): Promise<string[]> {
  const records = await resolveMx(domain);
  // Lowest preference value wins, which is why this is not a plain sort on the object.
  return [...records].sort((a, b) => a.priority - b.priority).map((r) => r.exchange);
}

/**
 * Resolve an address to a provider, consulting DNS only when it has to.
 *
 * The consumer domains short-circuit: @gmail.com is Gmail without asking anybody, and
 * making every member's save wait on a DNS round trip to learn that would be silly.
 */
export async function resolveMailProvider(
  email: string,
  lookup: MxLookup = defaultLookup,
): Promise<MailProviderLookup> {
  const known = providerForEmail(email);
  if (known) return { provider: known, mailHost: null, lookupFailed: false };

  const domain = domainOf(email);
  if (!domain) return { provider: null, mailHost: null, lookupFailed: false };

  let hosts: string[];
  try {
    const raced = await Promise.race([
      lookup(domain),
      new Promise<typeof TIMED_OUT>((resolve) =>
        setTimeout(() => resolve(TIMED_OUT), LOOKUP_TIMEOUT_MS).unref?.(),
      ),
    ]);
    if (raced === TIMED_OUT) return { provider: null, mailHost: null, lookupFailed: true };
    hosts = raced;
  } catch (error) {
    // A domain that simply has no mail is a real answer, not a failure: nothing is going
    // to arrive there, so "we can't read it" is the honest thing to tell the member.
    const code = (error as NodeJS.ErrnoException)?.code;
    const noRecords = code === "ENOTFOUND" || code === "ENODATA" || code === "NXDOMAIN";
    return { provider: null, mailHost: null, lookupFailed: !noRecords };
  }

  // A single "." exchange is how a domain declares it accepts no mail at all.
  const usable = hosts.filter((host) => host && host !== ".");
  return {
    provider: providerForMxHosts(usable),
    mailHost: usable[0] ?? null,
    lookupFailed: false,
  };
}

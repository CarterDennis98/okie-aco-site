/**
 * The email providers we can read a verification code from.
 *
 * A CLOSED LIST OF PROVIDERS, an OPEN LIST OF DOMAINS. Reading codes over IMAP needs a
 * provider that issues app passwords and keeps IMAP working, so the providers below are
 * the tested set and nothing else is accepted -- a credential on an untested host is one
 * that silently never works, discovered mid-drop when nobody chases the code.
 *
 * But the DOMAIN is not the provider. `@swatfame.com` was refused as "a custom domain we
 * can't read" when its MX records are `aspmx.l.google.com` and friends -- it is Google
 * Workspace, served by imap.gmail.com, and a Google app password reads it exactly like any
 * @gmail.com address. Every custom domain on Workspace, Microsoft 365, or iCloud+ was being
 * turned away for the same reason: the check was looking at the wrong half of the address.
 *
 * So `domains` is now only the FAST PATH -- the consumer domains, which need no lookup.
 * Anything else is resolved by its MX records against `mxSuffixes`; see email-mx.ts.
 *
 * Pure data and pure functions: imported by the form that renders the options AND by the
 * action that validates the submission, so what's offered and what's accepted can't drift.
 * Nothing here does I/O, because the form is a client component -- the DNS half lives in
 * email-mx.ts, which is server-only.
 */

export type EmailProvider = {
  key: string;
  label: string;
  /**
   * Lowercased consumer domains this provider owns.
   *
   * A shortcut, not the definition: matching one means no DNS lookup is needed. Missing
   * one is not a rejection -- it falls through to the MX check, which is authoritative.
   */
  domains: string[];
  /**
   * Mail hosts that mean this provider serves the domain, matched against its MX records.
   *
   * Compared on a LABEL BOUNDARY, never a bare `endsWith` -- see matchesMailHost. Plain
   * suffix matching would hand `notgoogle.com` to Gmail.
   */
  mxSuffixes: string[];
  imapHost: string;
  imapPort: number;
  /** Where the member generates an app password. */
  setupUrl: string;
  /** Shown as a caveat; still allowed. */
  caveat?: string;
};

export const EMAIL_PROVIDERS: EmailProvider[] = [
  {
    key: "gmail",
    label: "Gmail",
    domains: ["gmail.com", "googlemail.com"],
    // Every Google Workspace domain points here. The classic set is aspmx.l.google.com
    // plus alt1-4; older tenants use aspmx2-5.googlemail.com and newer ones a single
    // smtp.google.com, so both parent domains are listed rather than the individual hosts.
    mxSuffixes: ["google.com", "googlemail.com"],
    imapHost: "imap.gmail.com",
    imapPort: 993,
    setupUrl: "https://support.google.com/mail/answer/185833?hl=en",
  },
  {
    key: "outlook",
    label: "Outlook",
    domains: ["outlook.com", "hotmail.com", "live.com", "msn.com"],
    // Microsoft 365 gives each tenant <tenant>.mail.protection.outlook.com; older ones
    // sit under olc.protection.outlook.com. The parent covers both.
    mxSuffixes: ["outlook.com"],
    imapHost: "outlook.office365.com",
    imapPort: 993,
    setupUrl:
      "https://support.microsoft.com/en-us/accounts-billing/manage/how-to-get-and-use-app-passwords",
    // Microsoft has been switching accounts to modern auth and disabling app passwords
    // for basic IMAP, and it varies by account age and tenant with no clear signal.
    caveat:
      "Outlook doesn't always work — if codes stop arriving, forward to another inbox instead.",
  },
  {
    key: "yahoo",
    label: "Yahoo",
    domains: ["yahoo.com", "yahoo.co.uk", "yahoo.co.kr", "ymail.com", "rocketmail.com"],
    // Yahoo/Turbify business domains land on *.am0.yahoodns.net.
    mxSuffixes: ["yahoodns.net", "yahoo.com"],
    imapHost: "imap.mail.yahoo.com",
    imapPort: 993,
    setupUrl: "https://help.yahoo.com/kb/create-party-passwords-sln15241.html",
  },
  {
    key: "aol",
    label: "AOL",
    // AIM mail IS AOL mail -- @aim.com addresses have been served by AOL for years, and
    // members were being told an address we can read perfectly well was unsupported. The
    // rest are AOL's older aliases, all on the same host and all issuing app passwords
    // from the same page.
    domains: ["aol.com", "aim.com", "netscape.net", "love.com", "ygm.com", "wow.com", "games.com"],
    // AOL is Yahoo infrastructure and custom domains on it route through yahoodns.net,
    // which the Yahoo entry above already claims. Only AOL's own hosts belong here.
    mxSuffixes: ["aol.com"],
    imapHost: "imap.aol.com",
    imapPort: 993,
    setupUrl: "https://help.aol.com/articles/Create-and-manage-app-password",
  },
  {
    key: "icloud",
    label: "iCloud",
    domains: ["icloud.com", "me.com", "mac.com"],
    // iCloud+ custom domains use mx01/mx02.mail.icloud.com.
    mxSuffixes: ["icloud.com"],
    imapHost: "imap.mail.me.com",
    imapPort: 993,
    setupUrl: "https://support.apple.com/en-us/102654",
    // Apple's IMAP refuses app-password logins for some accounts with no useful error,
    // and Hide My Email aliases can't be read at all. Allowed, but say so up front.
    caveat:
      "iCloud doesn't always work — if codes stop arriving, forward to another inbox instead.",
  },
];

const BY_DOMAIN = new Map<string, EmailProvider>();
for (const provider of EMAIL_PROVIDERS) {
  for (const domain of provider.domains) BY_DOMAIN.set(domain, provider);
}

export function domainOf(email: string): string {
  return (
    String(email ?? "")
      .trim()
      .toLowerCase()
      .split("@")[1] ?? ""
  );
}

/**
 * The provider owning this address BY DOMAIN ALONE -- the fast path, no DNS.
 *
 * Null means "not a consumer domain we recognise", NOT "unsupported": a Workspace or
 * Microsoft 365 domain lands here too. Callers deciding whether to accept a credential
 * must fall through to the MX check in email-mx.ts. The only caller that legitimately
 * stops at this answer is display, where a lookup per row would be absurd.
 */
export function providerForEmail(email: string): EmailProvider | null {
  return BY_DOMAIN.get(domainOf(email)) ?? null;
}

/*
 * `isSupportedEmail` USED TO LIVE HERE and is deliberately gone rather than kept for
 * convenience. It answered "is this domain in the list", every caller read that as "can we
 * read this inbox", and for a Workspace domain those are opposite answers -- which is the
 * whole bug. Deciding acceptance now needs `resolveMailProvider`, which is async, so the
 * absence of a synchronous predicate is the point: there is no longer a cheap wrong answer
 * to reach for.
 */

/**
 * Does this mail host belong to `suffix`, on a label boundary?
 *
 * `endsWith` alone is the bug waiting to happen here: "notgoogle.com" ends with
 * "google.com" and would hand an attacker-controlled domain a Gmail app password prompt.
 * The host must either BE the suffix or sit under it as a subdomain.
 */
export function matchesMailHost(host: string, suffix: string): boolean {
  const h = String(host ?? "")
    .trim()
    .toLowerCase()
    .replace(/\.$/, ""); // DNS answers are fully qualified: "aspmx.l.google.com."
  const s = suffix.toLowerCase();
  return h === s || h.endsWith(`.${s}`);
}

/**
 * The provider serving a domain, judged by its MX records.
 *
 * Hosts should arrive in priority order; the first that matches anything wins, so a domain
 * with a backup MX elsewhere is decided by its primary. Null when no host is one we know.
 */
export function providerForMxHosts(hosts: string[]): EmailProvider | null {
  for (const host of hosts) {
    for (const provider of EMAIL_PROVIDERS) {
      if (provider.mxSuffixes.some((suffix) => matchesMailHost(host, suffix))) return provider;
    }
  }
  return null;
}

/**
 * Is this an IMAP host we put there ourselves?
 *
 * The credential's `imap_host` is always derived server-side from the table above and never
 * comes from a form, so this should never fail -- which is exactly why it is worth asserting
 * before the one place in the app that opens an outbound socket. A stored row holding
 * "localhost" or an internal address must not become a way to make the server dial itself.
 */
export function isKnownImapHost(host: string): boolean {
  const target = String(host ?? "")
    .trim()
    .toLowerCase();
  return EMAIL_PROVIDERS.some((provider) => provider.imapHost === target);
}

/**
 * The message shown when an address is on a provider we can't read.
 *
 * Names the mail host when one was found. "We can't read codes from swatfame.com" sent the
 * member hunting through their own settings; "its mail is handled by mx.example.net" tells
 * them -- and the operator -- the actual fact that decided it, which is the thing needed to
 * either fix the address or add the provider here.
 */
export function unsupportedMessage(email: string, mailHost?: string | null): string {
  const domain = domainOf(email) || "that domain";
  const names = EMAIL_PROVIDERS.map((p) => p.label).join(", ");
  const served = mailHost ? ` — its mail is handled by ${mailHost}` : "";
  return (
    `We can't read codes for ${domain}${served}. App passwords work with ${names}, including ` +
    `custom domains hosted on them. If that address forwards into one of those, add the ` +
    `destination inbox here and point this one at it with "Forwards to".`
  );
}

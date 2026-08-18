/**
 * The email providers we can read a verification code from.
 *
 * A CLOSED LIST, deliberately. Reading codes over IMAP needs a provider that issues app
 * passwords and keeps IMAP working; a member who saves one for a custom domain or a
 * provider we've never tested gets a credential that silently never works, and finds out
 * mid-drop when nobody chases their code.
 *
 * A custom or Workspace domain isn't a dead end -- it forwards into one of these, and
 * one app password on the destination covers it. See EmailAlias.
 *
 * Pure data: imported by the form that renders the options and by the action that
 * validates the submission, so what's offered and what's accepted can't drift.
 */

export type EmailProvider = {
  key: string;
  label: string;
  /** Lowercased domains this provider owns. */
  domains: string[];
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
    imapHost: "imap.gmail.com",
    imapPort: 993,
    setupUrl: "https://support.google.com/mail/answer/185833?hl=en",
  },
  {
    key: "outlook",
    label: "Outlook",
    domains: ["outlook.com", "hotmail.com", "live.com", "msn.com"],
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
    imapHost: "imap.mail.yahoo.com",
    imapPort: 993,
    setupUrl: "https://help.yahoo.com/kb/create-party-passwords-sln15241.html",
  },
  {
    key: "icloud",
    label: "iCloud",
    domains: ["icloud.com", "me.com", "mac.com"],
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

/** The provider that owns this address, or null when it isn't one we support. */
export function providerForEmail(email: string): EmailProvider | null {
  return BY_DOMAIN.get(domainOf(email)) ?? null;
}

export function isSupportedEmail(email: string): boolean {
  return providerForEmail(email) !== null;
}

/** The message shown when an address isn't on a supported provider. */
export function unsupportedMessage(email: string): string {
  const domain = domainOf(email);
  const names = EMAIL_PROVIDERS.map((p) => p.label).join(", ");
  return (
    `We can't read codes from ${domain || "that provider"}. App passwords work with ${names}. ` +
    `If that address forwards into one of those, add the destination inbox here and point this one at it.`
  );
}

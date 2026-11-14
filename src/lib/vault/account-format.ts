/**
 * The line shapes the accounts export can write: one login per line, email first, then the
 * password, split by whatever the bot loading the file expects.
 *
 *   colon          email:password      what every accounts file was before there was a choice
 *   triple-colon   email:::password
 *   semicolon      email;password
 *
 * The team runs different bots, and they don't agree on the separator. Everything else about
 * the file is the same, so the shape is a choice made at download time rather than another
 * export format.
 *
 * Shared by the export route, which writes these lines (toAccountList), the logins import,
 * which reads all of them back (parseAccountList), and the profiles page, which offers the
 * choice. Pure, so a client component can import it.
 */
export const ACCOUNT_FORMATS = {
  colon: ":",
  "triple-colon": ":::",
  semicolon: ";",
} as const satisfies Record<string, string>;

export type AccountFormat = keyof typeof ACCOUNT_FORMATS;

/** In the order the picker lists them. */
export const ACCOUNT_FORMAT_KEYS = Object.keys(ACCOUNT_FORMATS) as AccountFormat[];

/** What a URL with no `sep` gets: the file every bot was loaded with before the choice. */
export const DEFAULT_ACCOUNT_FORMAT: AccountFormat = "colon";

export function isAccountFormat(value: unknown): value is AccountFormat {
  return typeof value === "string" && Object.hasOwn(ACCOUNT_FORMATS, value);
}

/** "email:::password" -- the line itself, which is how a bot's own docs describe it. */
export function accountFormatLabel(format: AccountFormat): string {
  return `email${ACCOUNT_FORMATS[format]}password`;
}

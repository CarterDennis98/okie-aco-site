import { describe, expect, it } from "vitest";
import {
  ACCOUNT_FORMAT_KEYS,
  ACCOUNT_FORMATS,
  DEFAULT_ACCOUNT_FORMAT,
  accountFormatLabel,
  isAccountFormat,
} from "@/lib/vault/account-format";

/**
 * The accounts file's line shapes. The picker lists them in this order, the export route
 * accepts exactly these keys as `sep`, and the logins import reads every one of them back --
 * so adding one here means checking parseAccountList can tell it apart.
 */
describe("account formats", () => {
  it("offers the three shapes the team's bots read", () => {
    expect(ACCOUNT_FORMAT_KEYS.map(accountFormatLabel)).toEqual([
      "email:password",
      "email:::password",
      "email;password",
    ]);
  });

  it("defaults to email:password, the file every bot was loaded with before the choice", () => {
    expect(ACCOUNT_FORMATS[DEFAULT_ACCOUNT_FORMAT]).toBe(":");
  });

  /** It guards a query param and a browser's stored choice, so neither can name a separator. */
  it("knows its own keys and nothing else", () => {
    for (const key of ACCOUNT_FORMAT_KEYS) expect(isAccountFormat(key)).toBe(true);
    for (const value of [":", ";", ":::", "", "Colon", "toString", "__proto__", null, 1]) {
      expect(isAccountFormat(value), JSON.stringify(value)).toBe(false);
    }
  });
});

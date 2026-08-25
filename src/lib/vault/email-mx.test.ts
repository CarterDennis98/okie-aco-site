import { describe, expect, it } from "vitest";
import { resolveMailProvider, type MxLookup } from "@/lib/vault/email-mx";

/**
 * The lookup is injected, so none of this touches the network. What is under test is the
 * decision made around DNS, not DNS itself: when to skip it, what to do with the answer,
 * and -- the part that matters most -- keeping "nobody we know serves this" apart from
 * "we couldn't ask". The first is a verdict on the address; the second is not, and telling
 * a member their working address is unsupported because a resolver blipped sends them off
 * changing settings that were never wrong.
 */

const SWATFAME = [
  "aspmx.l.google.com",
  "alt1.aspmx.l.google.com",
  "alt2.aspmx.l.google.com",
  "alt3.aspmx.l.google.com",
  "alt4.aspmx.l.google.com",
];

const lookupOf =
  (byDomain: Record<string, string[]>): MxLookup =>
  async (domain) =>
    byDomain[domain] ?? [];

const throwing =
  (code?: string): MxLookup =>
  async () => {
    const error: NodeJS.ErrnoException = new Error("lookup failed");
    error.code = code;
    throw error;
  };

describe("resolveMailProvider", () => {
  it("accepts a custom domain hosted on Google Workspace", async () => {
    // The reported failure: @swatfame.com refused as unreadable when it is Workspace.
    const result = await resolveMailProvider(
      "smorales@swatfame.com",
      lookupOf({ "swatfame.com": SWATFAME }),
    );
    expect(result.provider?.key).toBe("gmail");
    expect(result.provider?.imapHost).toBe("imap.gmail.com");
    expect(result.provider?.imapPort).toBe(993);
    expect(result.lookupFailed).toBe(false);
  });

  it("accepts a custom domain on Microsoft 365", async () => {
    const result = await resolveMailProvider(
      "buyer@contoso.com",
      lookupOf({ "contoso.com": ["contoso-com.mail.protection.outlook.com"] }),
    );
    expect(result.provider?.imapHost).toBe("outlook.office365.com");
  });

  it("never asks DNS for a consumer domain", async () => {
    let asked = 0;
    const counting: MxLookup = async () => {
      asked++;
      return [];
    };
    expect((await resolveMailProvider("a@gmail.com", counting)).provider?.key).toBe("gmail");
    expect((await resolveMailProvider("a@aim.com", counting)).provider?.key).toBe("aol");
    expect(asked).toBe(0);
  });

  it("reports the mail host when it recognises nobody", async () => {
    const result = await resolveMailProvider(
      "buyer@privacy.example",
      lookupOf({ "privacy.example": ["mail.protonmail.ch", "mailsec.protonmail.ch"] }),
    );
    expect(result.provider).toBeNull();
    expect(result.lookupFailed).toBe(false);
    // The primary, so the error can name what decided it.
    expect(result.mailHost).toBe("mail.protonmail.ch");
  });

  it("treats a domain with no mail as an answer, not a failure", async () => {
    const noRecords = await resolveMailProvider("a@nomail.example", lookupOf({}));
    expect(noRecords.provider).toBeNull();
    expect(noRecords.lookupFailed).toBe(false);

    // A single "." exchange is how a domain says it accepts no mail at all.
    const nullMx = await resolveMailProvider(
      "a@nomail.example",
      lookupOf({ "nomail.example": ["."] }),
    );
    expect(nullMx.provider).toBeNull();
    expect(nullMx.mailHost).toBeNull();
    expect(nullMx.lookupFailed).toBe(false);
  });

  it("treats a non-existent domain as an answer too", async () => {
    for (const code of ["ENOTFOUND", "ENODATA", "NXDOMAIN"]) {
      const result = await resolveMailProvider("a@nope.example", throwing(code));
      expect(result.lookupFailed, code).toBe(false);
      expect(result.provider, code).toBeNull();
    }
  });

  it("reports a resolver failure as a failure, so the caller can say 'try again'", async () => {
    for (const code of ["ETIMEOUT", "ESERVFAIL", "ECONNREFUSED", undefined]) {
      const result = await resolveMailProvider("a@works.example", throwing(code));
      expect(result.lookupFailed, String(code)).toBe(true);
      expect(result.provider, String(code)).toBeNull();
    }
  });

  it("takes the primary MX when a backup sits elsewhere", async () => {
    const result = await resolveMailProvider(
      "a@mixed.example",
      lookupOf({ "mixed.example": ["aspmx.l.google.com", "mx.backup.example"] }),
    );
    expect(result.provider?.key).toBe("gmail");
  });

  it("refuses an address with no domain without asking anybody", async () => {
    const result = await resolveMailProvider("no-at-sign", throwing());
    expect(result.provider).toBeNull();
    expect(result.lookupFailed).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import {
  EMAIL_PROVIDERS,
  domainOf,
  matchesMailHost,
  providerForEmail,
  providerForMxHosts,
  unsupportedMessage,
} from "@/lib/vault/email-providers";

/**
 * Two different questions, and conflating them was the bug.
 *
 * `providerForEmail` answers "is this a consumer domain I know" -- a shortcut that skips a
 * DNS lookup. `providerForMxHosts` answers "who actually serves this domain", which is the
 * one that decides whether a credential is accepted. A Workspace domain answers null to the
 * first and Gmail to the second.
 */

describe("providerForEmail (the no-DNS fast path)", () => {
  it("accepts every domain it lists", () => {
    for (const provider of EMAIL_PROVIDERS) {
      for (const domain of provider.domains) {
        expect(providerForEmail(`someone@${domain}`)?.key, domain).toBe(provider.key);
      }
    }
  });

  it("maps each provider to the IMAP host that actually serves it", () => {
    expect(providerForEmail("a@gmail.com")?.imapHost).toBe("imap.gmail.com");
    expect(providerForEmail("a@hotmail.com")?.imapHost).toBe("outlook.office365.com");
    expect(providerForEmail("a@yahoo.co.kr")?.imapHost).toBe("imap.mail.yahoo.com");
    expect(providerForEmail("a@me.com")?.imapHost).toBe("imap.mail.me.com");
    // AIM resolves to AOL's host, not Yahoo's, even though AOL and Yahoo are one company:
    // imap.mail.yahoo.com does not serve an @aim.com login.
    expect(providerForEmail("a@aim.com")?.imapHost).toBe("imap.aol.com");
    expect(providerForEmail("a@aol.com")?.imapHost).toBe("imap.aol.com");
  });

  it("accepts AOL and AIM", () => {
    // Regression: both were refused outright, so members with an AIM or AOL inbox could
    // not save an app password at all and their codes had to be chased by hand.
    for (const email of ["someone@aol.com", "someone@aim.com", "SOMEONE@AOL.COM"]) {
      expect(providerForEmail(email)?.key, email).toBe("aol");
    }
  });

  it("returns null for a custom domain, which means 'ask DNS', not 'refuse'", () => {
    for (const email of ["riley@heyrileyhelp.com", "smorales@swatfame.com", "no-at-sign", ""]) {
      expect(providerForEmail(email), email).toBeNull();
    }
  });

  it("is case- and whitespace-insensitive about the domain", () => {
    expect(providerForEmail("  Someone@GMAIL.com  ")?.key).toBe("gmail");
    expect(domainOf(" A@Yahoo.COM ")).toBe("yahoo.com");
  });
});

describe("matchesMailHost", () => {
  it("matches the suffix itself and anything under it", () => {
    expect(matchesMailHost("google.com", "google.com")).toBe(true);
    expect(matchesMailHost("aspmx.l.google.com", "google.com")).toBe(true);
    // DNS answers come back fully qualified, with the root dot.
    expect(matchesMailHost("alt1.aspmx.l.google.com.", "google.com")).toBe(true);
    expect(matchesMailHost("ASPMX.L.GOOGLE.COM", "google.com")).toBe(true);
  });

  it("refuses a lookalike that merely ends with the same letters", () => {
    // The reason this is not a bare endsWith: a domain anybody can register must not be
    // able to present itself as Google and collect a Gmail app password.
    expect(matchesMailHost("notgoogle.com", "google.com")).toBe(false);
    expect(matchesMailHost("mx.evilgoogle.com", "google.com")).toBe(false);
    expect(matchesMailHost("google.com.attacker.net", "google.com")).toBe(false);
  });
});

describe("providerForMxHosts", () => {
  it("recognises Google Workspace", () => {
    // swatfame.com's real records, which were being refused as an unreadable custom domain.
    const hosts = [
      "aspmx.l.google.com",
      "alt1.aspmx.l.google.com",
      "alt2.aspmx.l.google.com",
      "alt3.aspmx.l.google.com",
      "alt4.aspmx.l.google.com",
    ];
    expect(providerForMxHosts(hosts)?.key).toBe("gmail");
    expect(providerForMxHosts(hosts)?.imapHost).toBe("imap.gmail.com");
    // Older tenants, and the newer single-record form.
    expect(providerForMxHosts(["aspmx3.googlemail.com"])?.key).toBe("gmail");
    expect(providerForMxHosts(["smtp.google.com"])?.key).toBe("gmail");
  });

  it("recognises Microsoft 365", () => {
    expect(providerForMxHosts(["okie-aco.mail.protection.outlook.com"])?.key).toBe("outlook");
    expect(providerForMxHosts(["example.olc.protection.outlook.com"])?.key).toBe("outlook");
    expect(providerForMxHosts(["okie.mail.protection.outlook.com"])?.imapHost).toBe(
      "outlook.office365.com",
    );
  });

  it("recognises Yahoo and iCloud custom domains", () => {
    expect(providerForMxHosts(["mx-van.mail.am0.yahoodns.net"])?.key).toBe("yahoo");
    expect(providerForMxHosts(["mx01.mail.icloud.com"])?.key).toBe("icloud");
  });

  it("decides on the primary when a backup MX is somewhere else", () => {
    // Hosts arrive in priority order, so the first match wins rather than the last.
    expect(providerForMxHosts(["aspmx.l.google.com", "backup.mailhop.example"])?.key).toBe("gmail");
  });

  it("returns null for a host nobody claims", () => {
    expect(providerForMxHosts(["mx.proton.me"])).toBeNull();
    expect(providerForMxHosts(["mail.selfhosted.example"])).toBeNull();
    expect(providerForMxHosts([])).toBeNull();
  });
});

describe("unsupportedMessage", () => {
  it("names the rejected domain and points at forwarding", () => {
    const message = unsupportedMessage("buyer@mycatchall.xyz");
    expect(message).toContain("mycatchall.xyz");
    expect(message).toContain("Gmail");
    expect(message).toMatch(/forward/i);
  });

  it("names the mail host when the lookup found one", () => {
    // The fact that actually decided it. Without this the member goes hunting through
    // their own settings for a reason we already know.
    const message = unsupportedMessage("buyer@mycatchall.xyz", "mx.proton.me");
    expect(message).toContain("mx.proton.me");
  });
});

describe("provider data", () => {
  it("flags iCloud as unreliable without blocking it", () => {
    expect(providerForEmail("a@icloud.com")?.caveat).toBeTruthy();
  });

  it("gives every provider a setup link and at least one mail host", () => {
    for (const provider of EMAIL_PROVIDERS) {
      expect(provider.setupUrl, provider.key).toMatch(/^https:\/\//);
      expect(provider.mxSuffixes.length, provider.key).toBeGreaterThan(0);
    }
  });
});

import { describe, expect, it } from "vitest";
import {
  EMAIL_PROVIDERS,
  domainOf,
  isSupportedEmail,
  providerForEmail,
  unsupportedMessage,
} from "@/lib/vault/email-providers";

describe("email providers", () => {
  it("accepts every domain it lists", () => {
    for (const provider of EMAIL_PROVIDERS) {
      for (const domain of provider.domains) {
        expect(isSupportedEmail(`someone@${domain}`), domain).toBe(true);
        expect(providerForEmail(`someone@${domain}`)?.key).toBe(provider.key);
      }
    }
  });

  it("maps each provider to the IMAP host that actually serves it", () => {
    expect(providerForEmail("a@gmail.com")?.imapHost).toBe("imap.gmail.com");
    expect(providerForEmail("a@hotmail.com")?.imapHost).toBe("outlook.office365.com");
    expect(providerForEmail("a@yahoo.co.kr")?.imapHost).toBe("imap.mail.yahoo.com");
    expect(providerForEmail("a@me.com")?.imapHost).toBe("imap.mail.me.com");
  });

  it("rejects a custom or work domain", () => {
    // The realistic case: a Google Workspace domain. Its mail is on Gmail's servers, but
    // we can't tell that from the address, and guessing wrong means a silently dead
    // credential. Forwarding is the supported path.
    for (const email of [
      "riley@heyrileyhelp.com",
      "someone@exceedhealthcare.com",
      "buyer@mycatchall.xyz",
      "anything@aol.com",
      "no-at-sign",
      "",
    ]) {
      expect(isSupportedEmail(email), email).toBe(false);
    }
  });

  it("is case- and whitespace-insensitive about the domain", () => {
    expect(isSupportedEmail("  Someone@GMAIL.com  ")).toBe(true);
    expect(domainOf(" A@Yahoo.COM ")).toBe("yahoo.com");
  });

  it("names the rejected domain and points at forwarding", () => {
    const message = unsupportedMessage("buyer@mycatchall.xyz");
    expect(message).toContain("mycatchall.xyz");
    expect(message).toContain("Gmail");
    expect(message).toMatch(/forward/i);
  });

  it("flags iCloud as unreliable without blocking it", () => {
    const icloud = providerForEmail("a@icloud.com");
    expect(icloud?.caveat).toBeTruthy();
    expect(isSupportedEmail("a@icloud.com")).toBe(true);
  });

  it("gives every provider a setup link", () => {
    for (const provider of EMAIL_PROVIDERS) {
      expect(provider.setupUrl, provider.key).toMatch(/^https:\/\//);
    }
  });
});

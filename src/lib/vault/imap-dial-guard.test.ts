import { describe, expect, it } from "vitest";
import { checkDialable, isPrivateAddress, type AddressLookup } from "@/lib/vault/imap-dial-guard";

/**
 * The guard has to let two things through that look opposite.
 *
 * A vanity mail host nobody has heard of is LEGITIMATE -- `scripts/import-imap.ts` writes
 * those from the operator's CSV on purpose, and the first version of this guard rejected
 * every one of them, reporting "Unreachable" for members whose mailboxes were fine.
 *
 * An internal address is NOT, however it is spelled: as a literal, as a name that resolves
 * inwards, or as an IPv4 address wearing an IPv6 coat.
 */

const resolving =
  (byHost: Record<string, string[]>): AddressLookup =>
  async (host) => {
    const found = byHost[host];
    if (!found) throw new Error("ENOTFOUND");
    return found;
  };

const publicDns = resolving({
  "mail.somecompany.com": ["203.0.113.10"],
  "imap.secureserver.net": ["104.16.0.1", "104.16.0.2"],
  "mail.privateemail.com": ["2606:4700::1"],
});

describe("isPrivateAddress", () => {
  it("knows the ranges that must never be dialled", () => {
    for (const ip of [
      "127.0.0.1",
      "10.1.2.3",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "169.254.169.254", // the cloud metadata endpoint, the whole reason this exists
      "100.64.0.1",
      "0.0.0.0",
      "::1",
      "fc00::1",
      "fe80::1",
      "::ffff:127.0.0.1", // the classic bypass
      "::ffff:10.0.0.1",
    ]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
  });

  it("lets real public addresses through", () => {
    for (const ip of ["203.0.113.10", "8.8.8.8", "142.250.72.4", "2606:4700::1", "172.32.0.1"]) {
      expect(isPrivateAddress(ip), ip).toBe(false);
    }
  });

  it("refuses anything it cannot parse", () => {
    expect(isPrivateAddress("not-an-ip")).toBe(true);
    expect(isPrivateAddress("")).toBe(true);
  });
});

describe("checkDialable", () => {
  it("allows the known providers without asking a resolver", async () => {
    let asked = false;
    const counting: AddressLookup = async () => {
      asked = true;
      return [];
    };
    for (const host of ["imap.gmail.com", "outlook.office365.com", "imap.mail.me.com"]) {
      expect((await checkDialable(host, 993, counting)).ok, host).toBe(true);
    }
    expect(asked).toBe(false);
  });

  it("ALLOWS a self-hosted or vanity mail host", async () => {
    // The regression. These are exactly the rows import-imap.ts creates, and the previous
    // allowlist guard reported every one of them as Unreachable without dialling.
    for (const host of ["mail.somecompany.com", "imap.secureserver.net", "mail.privateemail.com"]) {
      expect((await checkDialable(host, 993, publicDns)).ok, host).toBe(true);
    }
  });

  it("allows the plaintext IMAP port some self-hosted servers publish", async () => {
    expect((await checkDialable("mail.somecompany.com", 143, publicDns)).ok).toBe(true);
  });

  it("refuses a port that isn't IMAP", async () => {
    // Without this, a publicly-resolving name is a way to make the server speak to an
    // internal service on any port and read the first line back in an error message.
    for (const port of [22, 80, 6379, 8080, 5432]) {
      const result = await checkDialable("mail.somecompany.com", port, publicDns);
      expect(result.ok, String(port)).toBe(false);
    }
  });

  it("refuses an IP literal", async () => {
    for (const host of ["127.0.0.1", "10.0.0.5", "8.8.8.8", "::1"]) {
      expect((await checkDialable(host, 993, publicDns)).ok, host).toBe(false);
    }
  });

  it("refuses local and intranet names without resolving them", async () => {
    for (const host of ["localhost", "mailserver", "exchange01", "mail.internal", "box.local"]) {
      const result = await checkDialable(host, 993, publicDns);
      expect(result.ok, host).toBe(false);
    }
  });

  it("refuses a public name that points inside", async () => {
    // DNS says 10.0.0.5 -- a stale internal hostname in a CSV looks exactly like this.
    const inward = resolving({ "mail.corp.example": ["10.0.0.5"] });
    const result = await checkDialable("mail.corp.example", 993, inward);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/private network/);
  });

  it("refuses a name where ANY address is private", async () => {
    // One public, one private: dialling by name would let the OS pick either.
    const mixed = resolving({ "mail.split.example": ["203.0.113.9", "192.168.1.5"] });
    expect((await checkDialable("mail.split.example", 993, mixed)).ok).toBe(false);
  });

  it("refuses a name that doesn't resolve", async () => {
    const result = await checkDialable("imap.gmail.com.evil.tld", 993, publicDns);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/resolve/);
  });

  it("refuses an empty host", async () => {
    expect((await checkDialable("", 993, publicDns)).ok).toBe(false);
  });

  it("ignores a trailing dot and case, which DNS answers carry", async () => {
    expect((await checkDialable("IMAP.GMAIL.COM.", 993, publicDns)).ok).toBe(true);
    expect((await checkDialable("Mail.SomeCompany.com", 993, publicDns)).ok).toBe(true);
  });
});

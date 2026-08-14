/**
 * Vault crypto tests.
 *
 * Weighted toward the ways this fails badly rather than the round trip:
 *   - tampering must throw, never return plausible garbage
 *   - a ciphertext must not decrypt in a column it wasn't written for
 *   - values with leading zeros (CVVs, expiry months) must survive byte for byte
 *   - the same input must not produce the same output twice
 *   - a rotated-away key must fail loudly, not silently lose data
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import {
  VaultCryptoError,
  decrypt,
  encrypt,
  envelopeKeyId,
  isEnvelope,
  resetKeyringCache,
  rewrap,
} from "@/lib/vault/crypto";

const KEY_A = randomBytes(32).toString("base64");
const KEY_B = randomBytes(32).toString("base64");

const CARD = { entity: "vault_profile", field: "card" } as const;
const PASSWORD = { entity: "vault_account", field: "password" } as const;

let saved: NodeJS.ProcessEnv;

beforeEach(() => {
  saved = { ...process.env };
  for (const name of Object.keys(process.env)) {
    if (name.startsWith("VAULT_KEY")) delete process.env[name];
  }
  process.env.VAULT_KEY_K1 = KEY_A;
  process.env.VAULT_KEY_ACTIVE = "k1";
  resetKeyringCache();
});

afterEach(() => {
  process.env = saved;
  resetKeyringCache();
});

describe("round trip", () => {
  it("recovers the exact plaintext", () => {
    const secret = "4147098930053384";
    expect(decrypt(encrypt(secret, CARD), CARD)).toBe(secret);
  });

  it("preserves leading zeros", () => {
    // 18 CVVs in the real export start with 0. Anything that round-trips through a
    // number silently turns "037" into "37" and every checkout using it fails.
    for (const value of ["037", "009", "0818", "0430", "01"]) {
      expect(decrypt(encrypt(value, CARD), CARD)).toBe(value);
    }
  });

  it("handles unicode and awkward characters found in real passwords", () => {
    for (const value of ["pALzZV4J-p%6,7=12", "!8y1m4z8@8U3F1A0", "#|8X@f-gS[Vyu$7", "Pokémon—é"]) {
      expect(decrypt(encrypt(value, PASSWORD), PASSWORD)).toBe(value);
    }
  });

  it("passes empty through untouched, so absent stays absent", () => {
    expect(encrypt("", CARD)).toBe("");
    expect(decrypt("", CARD)).toBe("");
  });

  it("never produces the same ciphertext twice for the same input", () => {
    const one = encrypt("4147098930053384", CARD);
    const two = encrypt("4147098930053384", CARD);
    expect(one).not.toBe(two);
    expect(decrypt(one, CARD)).toBe(decrypt(two, CARD));
  });
});

describe("tamper detection", () => {
  it("rejects a single flipped bit in the ciphertext", () => {
    const envelope = encrypt("4147098930053384", CARD);
    const parts = envelope.split(".");
    const ct = Buffer.from(parts[4], "base64url");
    ct[0] ^= 0x01;
    parts[4] = ct.toString("base64url");

    expect(() => decrypt(parts.join("."), CARD)).toThrow(VaultCryptoError);
  });

  it("rejects a swapped authentication tag", () => {
    const a = encrypt("secret-a", CARD).split(".");
    const b = encrypt("secret-b", CARD).split(".");
    a[3] = b[3];
    expect(() => decrypt(a.join("."), CARD)).toThrow(VaultCryptoError);
  });

  it("rejects a ciphertext moved into a different column", () => {
    // The attack this prevents: someone with write access copies a stored account
    // password into a card column, or one field's value into another's.
    const envelope = encrypt("hunter2", PASSWORD);
    expect(decrypt(envelope, PASSWORD)).toBe("hunter2");
    expect(() => decrypt(envelope, CARD)).toThrow(VaultCryptoError);
  });

  it("rejects a malformed envelope instead of guessing", () => {
    for (const bad of ["nonsense", "v1.k1.short", "v1.k1.a.b.c.d.e", "v2.k1.a.b.c"]) {
      expect(() => decrypt(bad, CARD)).toThrow(VaultCryptoError);
    }
  });

  it("never leaks plaintext or key material in the error message", () => {
    const envelope = encrypt("4147098930053384", CARD);
    try {
      decrypt(envelope, PASSWORD);
      throw new Error("should have thrown");
    } catch (error) {
      const text = String((error as Error).message);
      expect(text).not.toContain("4147098930053384");
      expect(text).not.toContain(KEY_A);
      expect(text).not.toContain(envelope);
    }
  });
});

describe("keyring", () => {
  it("refuses to start with no key configured", () => {
    delete process.env.VAULT_KEY_K1;
    resetKeyringCache();
    expect(() => encrypt("x", CARD)).toThrow(/No vault keys configured/);
  });

  it("refuses a key that isn't 32 bytes", () => {
    process.env.VAULT_KEY_K1 = Buffer.from("too-short").toString("base64");
    resetKeyringCache();
    expect(() => encrypt("x", CARD)).toThrow(/32-byte base64 key/);
  });

  it("refuses when the active key names nothing", () => {
    process.env.VAULT_KEY_ACTIVE = "nope";
    resetKeyringCache();
    expect(() => encrypt("x", CARD)).toThrow(/does not match any configured key/);
  });

  it("cannot decrypt under a different key", () => {
    const envelope = encrypt("secret", CARD);
    delete process.env.VAULT_KEY_K1;
    process.env.VAULT_KEY_K2 = KEY_B;
    process.env.VAULT_KEY_ACTIVE = "k2";
    resetKeyringCache();
    // Loud failure, not a silent empty value -- this is what a botched rotation looks
    // like, and it has to be obvious immediately.
    expect(() => decrypt(envelope, CARD)).toThrow(/No vault key "k1" is configured/);
  });
});

describe("rotation", () => {
  it("reads old rows while writing new ones under the new key", () => {
    const old = encrypt("4147098930053384", CARD);
    expect(envelopeKeyId(old)).toBe("k1");

    // Both keys present: k2 writes, k1 still readable.
    process.env.VAULT_KEY_K2 = KEY_B;
    process.env.VAULT_KEY_ACTIVE = "k2";
    resetKeyringCache();

    expect(decrypt(old, CARD)).toBe("4147098930053384");
    expect(envelopeKeyId(encrypt("new", CARD))).toBe("k2");

    const migrated = rewrap(old, CARD);
    expect(envelopeKeyId(migrated)).toBe("k2");
    expect(decrypt(migrated, CARD)).toBe("4147098930053384");
  });
});

describe("isEnvelope", () => {
  it("distinguishes our envelopes from stray plaintext", () => {
    expect(isEnvelope(encrypt("x", CARD))).toBe(true);
    expect(isEnvelope("4147098930053384")).toBe(false);
    expect(isEnvelope("")).toBe(false);
  });
});

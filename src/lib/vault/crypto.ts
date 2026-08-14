import "server-only";

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Application-layer encryption for the profile vault.
 *
 * WHAT THIS PROTECTS AGAINST: a stolen database dump, a backup left somewhere, a
 * misconfigured read replica, a `SELECT *` in a support session. The ciphertext is
 * useless without the key, and the key is never in the database.
 *
 * WHAT IT DOES NOT PROTECT AGAINST: a compromised application server. The running app
 * must be able to decrypt in order to export to the bots, so anything that can execute
 * code as the app can read everything. That is inherent to the requirement, not a gap
 * in this module -- do not let it be described as "encrypted, therefore safe".
 *
 * AES-256-GCM: authenticated, so tampering fails loudly instead of decrypting to
 * garbage. A fresh 12-byte IV per encryption, which is what makes it safe to encrypt
 * the same card number under the same key many times.
 *
 * KEY CUSTODY: one key from the environment, injected from Secret Manager in
 * production. Deliberately chosen over Cloud KMS for simplicity -- the trade is that a
 * leaked env var loses everything at once, with no audit trail of the leak. The
 * envelope below is VERSIONED and NAMES ITS KEY precisely so that decision is
 * reversible: a later move to KMS adds a `v2` scheme that reads `v1` rows unchanged,
 * with no data migration and no downtime.
 */

const SCHEME = "v1";
const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** `VAULT_KEY_<ID>` holds a base64 32-byte key; `VAULT_KEY_ACTIVE` names the writer. */
const KEY_PREFIX = "VAULT_KEY_";
const ACTIVE_VAR = "VAULT_KEY_ACTIVE";

/** Key ids appear in the envelope, which is dot-delimited. */
const KEY_ID_RE = /^[A-Za-z0-9_-]{1,32}$/;

export class VaultCryptoError extends Error {
  constructor(message: string) {
    // Never interpolate plaintext, ciphertext, or key material into this message --
    // it ends up in logs and error reporters.
    super(message);
    this.name = "VaultCryptoError";
  }
}

type Keyring = { active: string; keys: Map<string, Buffer> };

let cached: Keyring | null = null;

function loadKeyring(): Keyring {
  if (cached) return cached;

  const keys = new Map<string, Buffer>();
  for (const [name, value] of Object.entries(process.env)) {
    if (!name.startsWith(KEY_PREFIX) || name === ACTIVE_VAR) continue;
    const id = name.slice(KEY_PREFIX.length).toLowerCase();
    if (!value) continue;

    if (!KEY_ID_RE.test(id)) {
      throw new VaultCryptoError(
        `Key id "${id}" must match ${KEY_ID_RE} (it is stored in the envelope).`,
      );
    }
    const key = Buffer.from(value, "base64");
    if (key.length !== KEY_BYTES) {
      throw new VaultCryptoError(
        `${name} decoded to ${key.length} bytes; a 32-byte base64 key is required. Generate one with: openssl rand -base64 32`,
      );
    }
    keys.set(id, key);
  }

  if (keys.size === 0) {
    throw new VaultCryptoError(
      `No vault keys configured. Set ${KEY_PREFIX}<ID> to a base64 32-byte key and ${ACTIVE_VAR} to <ID>.`,
    );
  }

  const active = (process.env[ACTIVE_VAR] ?? "").toLowerCase();
  if (!active) {
    throw new VaultCryptoError(
      `${ACTIVE_VAR} is not set; it must name one of: ${[...keys.keys()].join(", ")}`,
    );
  }
  if (!keys.has(active)) {
    throw new VaultCryptoError(`${ACTIVE_VAR}="${active}" does not match any configured key.`);
  }

  cached = { active, keys };
  return cached;
}

/** Tests and key rotation need to re-read the environment. */
export function resetKeyringCache(): void {
  cached = null;
}

/**
 * Binds ciphertext to the column it belongs in.
 *
 * Without this, anyone who can write to the database could move a stored password's
 * ciphertext into a CVV column and have it decrypt cleanly. With it, GCM rejects the
 * value. Change these strings and existing rows stop decrypting, so they are part of
 * the data format -- not a detail.
 */
export type VaultField = {
  entity: string;
  field: string;
};

function aad({ entity, field }: VaultField): Buffer {
  return Buffer.from(`${SCHEME}.${entity}.${field}`, "utf8");
}

/**
 * Encrypt with the active key.
 *
 * Returns `v1.<keyId>.<iv>.<tag>.<ciphertext>`, base64url throughout. Empty string in,
 * empty string out -- an absent secret stays absent rather than becoming an
 * indistinguishable blob.
 */
export function encrypt(plaintext: string, field: VaultField): string {
  if (plaintext === "") return "";

  const { active, keys } = loadKeyring();
  const key = keys.get(active)!;
  const iv = randomBytes(IV_BYTES);

  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(aad(field));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [
    SCHEME,
    active,
    iv.toString("base64url"),
    tag.toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

/**
 * Decrypt, verifying the authentication tag and the field binding.
 *
 * Throws on ANY inconsistency -- unknown key, wrong field, a single flipped bit. A
 * silent fallback to null here would turn a tampered row into a plausible-looking one.
 */
export function decrypt(envelope: string, field: VaultField): string {
  if (envelope === "") return "";

  const parts = envelope.split(".");
  if (parts.length !== 5) {
    throw new VaultCryptoError("Malformed vault envelope (expected 5 dot-separated parts).");
  }

  const [scheme, keyId, ivB64, tagB64, ctB64] = parts;
  if (scheme !== SCHEME) {
    throw new VaultCryptoError(
      `Unsupported vault scheme "${scheme}"; this build understands "${SCHEME}".`,
    );
  }

  const { keys } = loadKeyring();
  const key = keys.get(keyId);
  if (!key) {
    // The most likely real cause: a key was rotated out of the environment while rows
    // encrypted under it are still in the database.
    throw new VaultCryptoError(
      `No vault key "${keyId}" is configured; rows encrypted under it cannot be read.`,
    );
  }

  const iv = Buffer.from(ivB64, "base64url");
  const tag = Buffer.from(tagB64, "base64url");
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new VaultCryptoError("Vault envelope has a malformed IV or authentication tag.");
  }

  try {
    const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
    decipher.setAAD(aad(field));
    decipher.setAuthTag(tag);
    return Buffer.concat([
      decipher.update(Buffer.from(ctB64, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    // Swallow the underlying message: node's is unhelpful and we must not risk it
    // carrying fragments of the input.
    throw new VaultCryptoError(
      "Vault decryption failed: wrong key, wrong field binding, or the value was modified.",
    );
  }
}

/** True when a stored value is one of our envelopes rather than stray plaintext. */
export function isEnvelope(value: string): boolean {
  return value.startsWith(`${SCHEME}.`) && value.split(".").length === 5;
}

/** The key id a value was written under, for auditing a rotation's progress. */
export function envelopeKeyId(envelope: string): string | null {
  return isEnvelope(envelope) ? (envelope.split(".")[1] ?? null) : null;
}

/**
 * Re-wrap an existing envelope under the active key.
 *
 * The whole of key rotation: read with whichever key wrote it, write back with the new
 * one. Rows can be migrated in batches while the app keeps serving.
 */
export function rewrap(envelope: string, field: VaultField): string {
  return encrypt(decrypt(envelope, field), field);
}

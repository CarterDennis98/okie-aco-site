import "server-only";

import { toAycdProfile, type ExportableProfile } from "@/lib/vault/aycd";
import { decrypt } from "@/lib/vault/crypto";
import { toHiddenCsv, type HiddenGroup } from "@/lib/vault/hidden";

/**
 * What the profile exports share: the operator's (api/admin/vault/export) and a member's own
 * (api/vault/export). Built here once so a member's download is byte-for-byte the file the
 * operator would load for them -- and so the operator's Hidden file decrypts exactly as the
 * AYCD one does.
 */

/** A stored profile as an export reads it: the clear columns, the two card ciphertexts, and the login's email. */
export type StoredProfile = Omit<ExportableProfile, "email" | "cardNumber" | "cardCvv"> & {
  cardNumberEnc: string;
  cardCvvEnc: string;
  account: { email: string };
};

/** One stored profile with its card number and security code decrypted, and its login's email. */
function withSecrets(row: StoredProfile): ExportableProfile {
  return {
    ...row,
    email: row.account.email,
    cardNumber: decrypt(row.cardNumberEnc, { entity: "vault_profile", field: "card_number" }),
    cardCvv: decrypt(row.cardCvvEnc, { entity: "vault_profile", field: "card_cvv" }),
  };
}

/**
 * AYCD's profile file, with every card number and security code decrypted.
 *
 * Record the export in `vault_exports` BEFORE calling this, so a crash mid-file still
 * leaves the record that an export was attempted.
 */
export function aycdFile(rows: StoredProfile[]): string {
  return JSON.stringify(
    rows.map((row) => toAycdProfile(withSecrets(row))),
    null,
    2,
  );
}

/**
 * Hidden AIO's profile CSV, every row filed under `group` -- see hidden.ts. Decrypted, and
 * recorded first, exactly as aycdFile is.
 */
export function hiddenFile(rows: StoredProfile[], group: HiddenGroup): string {
  return toHiddenCsv(rows.map(withSecrets), group);
}

export function fileResponse(body: string, filename: string, contentType: string): Response {
  return new Response(body, {
    headers: {
      "content-type": contentType,
      "content-disposition": `attachment; filename="${filename}"`,
      // Belt and braces: this body is plaintext credentials, so nothing may cache it.
      "cache-control": "no-store, no-cache, must-revalidate, private",
      pragma: "no-cache",
    },
  });
}

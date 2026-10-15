import "server-only";

import { toAycdProfile, type ExportableProfile } from "@/lib/vault/aycd";
import { decrypt } from "@/lib/vault/crypto";

/**
 * What the two profile exports share: the operator's (api/admin/vault/export) and a member's
 * own (api/vault/export). Built here once so a member's download is byte-for-byte the file
 * the operator would load for them.
 */

/** A stored profile as an export reads it: the clear columns, the two card ciphertexts, and the login's email. */
export type StoredProfile = Omit<ExportableProfile, "email" | "cardNumber" | "cardCvv"> & {
  cardNumberEnc: string;
  cardCvvEnc: string;
  account: { email: string };
};

/**
 * AYCD's profile file, with every card number and security code decrypted.
 *
 * Record the export in `vault_exports` BEFORE calling this, so a crash mid-file still
 * leaves the record that an export was attempted.
 */
export function aycdFile(rows: StoredProfile[]): string {
  const profiles = rows.map((row) =>
    toAycdProfile({
      ...row,
      email: row.account.email,
      cardNumber: decrypt(row.cardNumberEnc, { entity: "vault_profile", field: "card_number" }),
      cardCvv: decrypt(row.cardCvvEnc, { entity: "vault_profile", field: "card_cvv" }),
    }),
  );
  return JSON.stringify(profiles, null, 2);
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

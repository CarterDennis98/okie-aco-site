import "server-only";

import { prisma } from "@/db/client";
import { VaultEntity } from "@/generated/prisma/enums";
import { decrypt } from "@/lib/vault/crypto";

/**
 * Showing a stored app password on screen.
 *
 * The vault is otherwise write-only: secrets go in, and the only way plaintext comes
 * back out is the audited export. A reveal is the second such door, so it is built like
 * the first one -- the audit row is written BEFORE anything is decrypted, so a crash
 * mid-request still leaves the record that someone asked.
 *
 * Only app passwords are revealable. Card numbers and CVVs deliberately are not: an app
 * password is provider-issued, scoped to one application, and revocable in a click,
 * which a card number is not.
 *
 * Callers must have passed a guard first. This module does not authorize -- it takes an
 * already-resolved actor and an already-ownership-scoped credential row.
 */

export type RevealResult =
  { ok: true; value: string; email: string } | { ok: false; error: string };

type Credential = { id: string; email: string; appPasswordEnc: string; discordUserId: string };

export async function revealCredential(
  credential: Credential | null,
  actorDiscordId: string,
): Promise<RevealResult> {
  // Same answer for "not yours" and "doesn't exist" -- the caller's query carries both
  // predicates, so a guessed id is indistinguishable from a missing one.
  if (!credential) return { ok: false, error: "No app password on file for that address." };

  await prisma.vaultReveal.create({
    data: {
      actorDiscordId,
      ownerDiscordId: credential.discordUserId,
      entity: VaultEntity.EMAIL_CREDENTIAL,
      entityId: credential.id,
      field: "app_password",
      onBehalf: actorDiscordId !== credential.discordUserId,
    },
  });

  try {
    return {
      ok: true,
      email: credential.email,
      value: decrypt(credential.appPasswordEnc, {
        entity: "email_credential",
        field: "app_password",
      }),
    };
  } catch {
    // A decrypt failure means the keyring no longer has the key this was wrapped with.
    // Say so plainly; never echo the envelope.
    return { ok: false, error: "Stored password could not be decrypted. Re-enter it." };
  }
}

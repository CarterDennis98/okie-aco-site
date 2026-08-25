import "server-only";

import { prisma } from "@/db/client";
import { decrypt } from "@/lib/vault/crypto";
import { checkImapLogin, type ImapConnect } from "@/lib/vault/imap-check";

/**
 * Testing one stored app password, and recording what happened.
 *
 * Sits between the Server Actions and the protocol code so both the member's button and the
 * operator's sweep run exactly the same check and write exactly the same columns. Callers
 * must have passed a guard and scoped the row to somebody allowed to see it -- like
 * reveal.ts, this module does not authorize.
 *
 * THE COOLDOWN IS HERE, not in the UI, because the UI is not the only caller and a disabled
 * button is not a rule. Providers lock an account after repeated failed logins, so the thing
 * this feature exists to protect -- the mailbox the bot reads drop codes from -- is exactly
 * what an unbounded retry loop would break.
 */

export type ImapTestOutcome = {
  ok: boolean;
  /**
   * Two or three words, for the inline result beside the button.
   *
   * Separate from `message` so the wording lives here rather than being reconstructed in
   * two components: the full explanation is what a member needs once, on hover, and a
   * sentence of it rendered inline pushed every row on the page sideways.
   */
  label: string;
  /** The whole explanation, for the tooltip and for screen readers. Never has the password. */
  message: string;
  /** True when nothing was attempted because the cooldown is still running. */
  throttled?: boolean;
  /**
   * Whether this is a verdict on the CREDENTIAL at all.
   *
   * False for a cooldown or an unreachable server -- neither says the password is wrong,
   * so neither may render as a red cross. Keeping this on the result rather than letting
   * the UI infer it from `ok` is what stops "the mail server had a bad minute" from
   * looking identical to "your password is wrong".
   */
  verdict: boolean;
};

type TestableCredential = {
  id: string;
  email: string;
  appPasswordEnc: string;
  imapHost: string | null;
  imapPort: number | null;
  lastCheckedAt: Date | null;
};

/**
 * How long a credential rests between checks.
 *
 * Long enough that holding the button down cannot walk an account into a provider lockout,
 * short enough that "I just fixed it, let me retry" is not a frustrating wait. Saving a new
 * password clears `lastCheckedAt`, so correcting a wrong password is never throttled.
 */
export const CHECK_COOLDOWN_MS = 60_000;

/**
 * The server's own words, attributed and kept at the end of the message.
 *
 * Appended rather than spliced mid-sentence because the punctuation is not ours to predict:
 * Gmail answers "[AUTHENTICATIONFAILED] Invalid credentials (Failure)" with no full stop and
 * Microsoft answers "Basic authentication is disabled." with one, and a template that
 * assumed either produced a run-on or a double period. It stays in the message because it is
 * the part that says WHICH fix -- those two examples need completely different actions.
 */
function quote(detail: string): string {
  return detail ? `The server said: ${detail}` : "";
}

export function cooldownRemainingMs(lastCheckedAt: Date | null, now = Date.now()): number {
  if (!lastCheckedAt) return 0;
  return Math.max(0, CHECK_COOLDOWN_MS - (now - lastCheckedAt.getTime()));
}

export async function testCredential(
  credential: TestableCredential | null,
  connect?: ImapConnect,
): Promise<ImapTestOutcome> {
  // Same answer for "not yours" and "doesn't exist": the caller's query carries both
  // predicates, so a guessed id is indistinguishable from a missing one. Matches reveal.ts.
  if (!credential) {
    return {
      ok: false,
      verdict: false,
      label: "Not found",
      message: "No app password on file for that address.",
    };
  }

  const waitMs = cooldownRemainingMs(credential.lastCheckedAt);
  if (waitMs > 0) {
    const seconds = Math.ceil(waitMs / 1000);
    return {
      ok: false,
      throttled: true,
      verdict: false,
      label: `Wait ${seconds}s`,
      message: `Just checked. Try again in ${seconds} second${seconds === 1 ? "" : "s"}.`,
    };
  }

  if (!credential.imapHost) {
    return {
      ok: false,
      verdict: false,
      label: "No server",
      message: "No mail server on file for this address — remove it and add it again.",
    };
  }

  let password: string;
  try {
    password = decrypt(credential.appPasswordEnc, {
      entity: "email_credential",
      field: "app_password",
    });
  } catch {
    // The keyring no longer holds the key this was wrapped with. Not a password problem,
    // and not something a retry fixes.
    return {
      ok: false,
      verdict: false,
      label: "Unreadable",
      message: "Stored password could not be decrypted. Re-enter it.",
    };
  }

  const result = await checkImapLogin({
    host: credential.imapHost,
    port: credential.imapPort ?? 993,
    user: credential.email,
    password,
    connect,
  });

  // Stamped whatever happened, including the failures below: the cooldown exists to stop
  // repeated ATTEMPTS, and an attempt that failed on the network still opened a connection.
  const lastCheckedAt = new Date();

  if (result.ok) {
    await prisma.emailCredential.update({
      where: { id: credential.id },
      data: { verifiedAt: lastCheckedAt, lastError: null, lastCheckedAt },
    });
    return {
      ok: true,
      verdict: true,
      label: "Success",
      message: "Signed in and opened the inbox — this password works.",
    };
  }

  // A NETWORK FAILURE IS NOT A VERDICT ON THE PASSWORD, so it does not touch `verifiedAt` or
  // `lastError`. Recording it would put "re-enter the app password" on a working credential
  // because a mail server had a bad minute, and the member would dutifully replace a
  // password that was never wrong.
  if (result.kind === "network") {
    // LOGGED, because nothing else records it. Deliberately not written to `lastError` --
    // that column drives "needs re-entering", which is the wrong thing to tell somebody
    // whose password is fine. But leaving no trace at all made "some of my members get
    // Unreachable" unanswerable: the reason existed only in a tooltip nobody had open.
    //
    // Host and reason, never the address or the password: enough to tell a blocked port
    // from a rate limit from a dead DNS record, without putting mailboxes in a log.
    console.warn(`imap check unreachable: ${credential.imapHost} — ${result.detail}`);
    await prisma.emailCredential.update({
      where: { id: credential.id },
      data: { lastCheckedAt },
    });
    return {
      ok: false,
      verdict: false,
      label: "Unreachable",
      message:
        `Couldn't reach ${credential.imapHost}. This says nothing about your password — ` +
        `try again shortly. ${quote(result.detail)}`,
    };
  }

  await prisma.emailCredential.update({
    where: { id: credential.id },
    data: { verifiedAt: null, lastError: result.detail, lastCheckedAt },
  });

  return {
    ok: false,
    verdict: true,
    label: "Failed",
    message:
      result.kind === "auth"
        ? `The mail server refused this password. Generate a new app password and save it here. ${quote(result.detail)}`
        : `Signed in, but the inbox wouldn't open. ${quote(result.detail)}`,
  };
}

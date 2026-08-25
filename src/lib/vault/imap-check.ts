import "server-only";

import { connect as tlsConnect } from "node:tls";
import { isKnownImapHost } from "@/lib/vault/email-providers";

/**
 * Does this app password actually open this mailbox?
 *
 * The bot's whole job on drop night is reading a verification code out of a member's inbox.
 * Until now the only way to find out that a password was wrong was for that to fail while
 * somebody waited on a checkout, so this runs the same login on demand and says so.
 *
 * WHAT IT DOES: TLS connect, LOGIN, SELECT INBOX, LOGOUT. Nothing else -- no listing, no
 * fetching, no message bodies ever read. SELECT is included because LOGIN alone is not the
 * question: an account can authenticate and still refuse to open the mailbox, and "your
 * password works but we can't read your mail" is a distinction worth surfacing before a drop
 * rather than during one.
 *
 * HAND-ROLLED ON PURPOSE. The protocol subset above is four commands and a tagged-response
 * reader; an IMAP library would be the first dependency here that isn't framework-essential,
 * pulled into a path that handles decrypted credentials.
 *
 * THE SOCKET IS INJECTED, which is what makes the protocol testable -- see imap-check.test.ts,
 * where a scripted fake replays real Gmail and Outlook responses. Same shape as the MX lookup
 * in email-mx.ts, for the same reason.
 */

export type ImapCheckResult =
  | { ok: true; greeting: string }
  | { ok: false; kind: ImapFailure; detail: string };

/**
 * Why it failed, because the three want different things from the reader.
 *
 *   - `auth`  the password is wrong or the provider refused it. The member must act.
 *   - `mailbox` login worked, INBOX would not open. Rare, and not a password problem.
 *   - `network` we never got a usable answer. Says nothing about the credential, so it
 *     must NOT be recorded as a failed password -- see runImapCheck's caller.
 */
export type ImapFailure = "auth" | "mailbox" | "network";

export type SocketLike = {
  write(data: string): void;
  destroy(): void;
  setEncoding(encoding: "utf8"): void;
  on(event: "data", listener: (chunk: string) => void): void;
  on(event: "error", listener: (error: Error) => void): void;
  on(event: "close", listener: () => void): void;
};

export type ImapConnect = (host: string, port: number) => Promise<SocketLike>;

export type ImapCheckOptions = {
  host: string;
  port: number;
  user: string;
  password: string;
  /** Injected in tests. */
  connect?: ImapConnect;
  /** Injected in tests, so a timeout case doesn't take ten real seconds. */
  timeoutMs?: number;
};

/**
 * Whole-check budget, not per-command.
 *
 * A member is watching a spinner, and a Server Action that hangs holds a server slot. Ten
 * seconds is generous for four round trips to a major provider and still short enough that
 * a black-holed connection gives up while somebody is still looking at it.
 */
const DEFAULT_TIMEOUT_MS = 10_000;

/** Server text kept for the operator. Long enough to be useful, capped so it can't be a payload. */
const MAX_DETAIL = 200;

/**
 * IMAP quoted-string escaping.
 *
 * Backslash and double quote are the only two characters that need it. App passwords are
 * normally 16 letters, but "normally" is not a security argument: an unescaped quote would
 * end the string early and turn the rest of the password into command syntax.
 */
function quoted(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * One line of server text, safe to store and show.
 *
 * Control bytes are collapsed rather than trusted: this string is written to the database
 * and rendered on two pages, and it arrives from a third party. Capped for the same reason
 * -- a server is free to answer with a megabyte, and it would be stored and re-rendered.
 */
function tidy(line: string): string {
  const clean = line
    // eslint-disable-next-line no-control-regex -- collapsing control bytes is the point
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return clean.length > MAX_DETAIL ? `${clean.slice(0, MAX_DETAIL - 1)}\u2026` : clean;
}

async function defaultConnect(host: string, port: number): Promise<SocketLike> {
  return new Promise((resolve, reject) => {
    const socket = tlsConnect({ host, port, servername: host }, () => resolve(socket));
    socket.once("error", reject);
  });
}

/**
 * A line-oriented reader over the socket.
 *
 * IMAP answers a tagged command with any number of untagged `*` lines followed by one line
 * starting with the tag. Everything before the tag is progress, not an answer, so the reader
 * skips it -- treating the first `*` line as the response is the classic way to read
 * "* OK Still here" as success.
 */
function reader(socket: SocketLike, deadline: number) {
  let buffer = "";
  const lines: string[] = [];
  let notify: (() => void) | null = null;
  let failure: Error | null = null;

  socket.setEncoding("utf8");
  socket.on("data", (chunk) => {
    buffer += chunk;
    let index = buffer.indexOf("\r\n");
    while (index !== -1) {
      lines.push(buffer.slice(0, index));
      buffer = buffer.slice(index + 2);
      index = buffer.indexOf("\r\n");
    }
    notify?.();
  });
  socket.on("error", (error) => {
    failure = error;
    notify?.();
  });
  socket.on("close", () => {
    failure ??= new Error("The mail server closed the connection.");
    notify?.();
  });

  /** The next line, or throws on socket failure or deadline. */
  async function nextLine(): Promise<string> {
    for (;;) {
      if (lines.length) return lines.shift()!;
      if (failure) throw failure;
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error("The mail server didn't respond in time.");

      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, remaining);
        timer.unref?.();
        notify = () => {
          clearTimeout(timer);
          notify = null;
          resolve();
        };
      });
    }
  }

  /** Skip untagged chatter and return the line that answers `tag`. */
  async function taggedResponse(tag: string): Promise<{ status: string; text: string }> {
    for (;;) {
      const line = await nextLine();
      if (!line.startsWith(`${tag} `)) continue;
      const [, status = "", ...rest] = line.split(" ");
      return { status: status.toUpperCase(), text: tidy(rest.join(" ")) };
    }
  }

  return { nextLine, taggedResponse };
}

/**
 * Run the check. Never throws -- every outcome is a result the caller can store.
 */
export async function checkImapLogin(options: ImapCheckOptions): Promise<ImapCheckResult> {
  const { host, port, user, password } = options;
  const connect = options.connect ?? defaultConnect;
  const deadline = Date.now() + (options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  // SSRF GUARD. The host is derived server-side from the provider list and never comes from
  // a form, but this is the one place in the app that opens an outbound socket, so it
  // refuses anything that isn't a mail host we put there ourselves. A stored row that
  // somehow held "localhost" must not be a way to make the server dial itself.
  if (!isKnownImapHost(host)) {
    return { ok: false, kind: "network", detail: `${host} isn't a mail host we recognise.` };
  }

  let socket: SocketLike;
  try {
    socket = await connect(host, port);
  } catch (error) {
    return { ok: false, kind: "network", detail: tidy((error as Error).message) };
  }

  try {
    const { nextLine, taggedResponse } = reader(socket, deadline);

    // The greeting arrives unprompted. `* BYE` here is a refusal to talk at all -- some
    // providers use it to say "too many connections from your address".
    const greeting = await nextLine();
    if (greeting.startsWith("* BYE")) {
      return { ok: false, kind: "network", detail: tidy(greeting) };
    }

    socket.write(`a1 LOGIN ${quoted(user)} ${quoted(password)}\r\n`);
    const login = await taggedResponse("a1");
    if (login.status !== "OK") {
      // NO is a refusal, BAD is malformed. Both mean the credential did not get in, and the
      // server's own words are the useful part -- Gmail distinguishes "Invalid credentials"
      // from "Application-specific password required", which are different fixes.
      return { ok: false, kind: "auth", detail: login.text || "The mail server refused the login." };
    }

    socket.write("a2 SELECT INBOX\r\n");
    const select = await taggedResponse("a2");
    if (select.status !== "OK") {
      return {
        ok: false,
        kind: "mailbox",
        detail: select.text || "Signed in, but the inbox wouldn't open.",
      };
    }

    // Best-effort: a server that drops us here has already answered the question.
    try {
      socket.write("a3 LOGOUT\r\n");
      await taggedResponse("a3");
    } catch {
      /* nothing left to learn */
    }

    return { ok: true, greeting: tidy(greeting) };
  } catch (error) {
    return { ok: false, kind: "network", detail: tidy((error as Error).message) };
  } finally {
    socket.destroy();
  }
}

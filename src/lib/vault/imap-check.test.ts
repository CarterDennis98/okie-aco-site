import { describe, expect, it } from "vitest";
import { checkImapLogin, type SocketLike } from "@/lib/vault/imap-check";

/**
 * The protocol handling, against a scripted server.
 *
 * The responses below are the real shapes: Gmail's "[AUTHENTICATIONFAILED] Invalid
 * credentials", its "[ALERT] Application-specific password required", and the untagged
 * chatter every server emits before the line that actually answers. Nothing here touches the
 * network -- the socket is injected, the same way email-mx.ts injects its resolver.
 *
 * What is worth testing is not "does IMAP work" but the three ways this could quietly lie:
 * reading an untagged line as the answer, treating an unreachable server as a bad password,
 * and letting a password with a quote in it run off the end of its own string.
 */

/** A socket that answers each command written to it with scripted lines. */
function scripted(script: {
  greeting?: string;
  onLogin?: string[];
  onSelect?: string[];
  onLogout?: string[];
  /** Never answers, to exercise the deadline. */
  silent?: boolean;
}) {
  const written: string[] = [];
  let onData: ((chunk: string) => void) | null = null;
  let onClose: (() => void) | null = null;

  const emit = (lines: string[]) => {
    // Next tick, so the reader is already waiting -- a real socket never answers
    // synchronously inside write().
    setTimeout(() => onData?.(lines.map((l) => `${l}\r\n`).join("")), 0);
  };

  const socket: SocketLike = {
    setEncoding() {},
    write(data: string) {
      written.push(data);
      if (script.silent) return;
      if (data.includes(" LOGIN ")) emit(script.onLogin ?? ["a1 OK LOGIN completed"]);
      else if (data.includes(" SELECT ")) emit(script.onSelect ?? ["a2 OK [READ-WRITE] SELECT"]);
      else if (data.includes(" LOGOUT ") || data.includes(" LOGOUT\r\n"))
        emit(script.onLogout ?? ["* BYE logging out", "a3 OK LOGOUT completed"]);
    },
    destroy() {
      onClose?.();
    },
    on(event: string, listener: (arg: never) => void) {
      if (event === "data") {
        onData = listener as (chunk: string) => void;
        if (!script.silent) {
          emit([script.greeting ?? "* OK Gimap ready for requests"]);
        }
      }
      if (event === "close") onClose = listener as () => void;
    },
  };

  return { socket, written };
}

const run = (script: Parameters<typeof scripted>[0], over: Record<string, unknown> = {}) => {
  const { socket, written } = scripted(script);
  const promise = checkImapLogin({
    host: "imap.gmail.com",
    port: 993,
    user: "member@gmail.com",
    password: "abcdefghijklmnop",
    connect: async () => socket,
    timeoutMs: 200,
    ...over,
  });
  return { promise, written };
};

describe("checkImapLogin", () => {
  it("passes when the login and the inbox both open", async () => {
    const { promise, written } = run({});
    await expect(promise).resolves.toMatchObject({ ok: true });

    // SELECT is not optional: authenticating and being able to read are different claims.
    expect(written.some((w) => w.startsWith("a1 LOGIN "))).toBe(true);
    expect(written.some((w) => w.startsWith("a2 SELECT INBOX"))).toBe(true);
    expect(written.some((w) => w.startsWith("a3 LOGOUT"))).toBe(true);
  });

  it("reads past untagged chatter to the line that answers", async () => {
    // The trap: taking the first `* OK` as the verdict reads a refusal as a success.
    const { promise } = run({
      onLogin: [
        "* CAPABILITY IMAP4rev1 UNSELECT IDLE MOVE",
        "* OK still here",
        "a1 NO [AUTHENTICATIONFAILED] Invalid credentials (Failure)",
      ],
    });
    await expect(promise).resolves.toMatchObject({ ok: false, kind: "auth" });
  });

  it("keeps the server's own words, which are the actionable part", async () => {
    const { promise } = run({
      onLogin: ["a1 NO [ALERT] Application-specific password required"],
    });
    const result = await promise;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // Gmail distinguishes this from "invalid credentials" and they are different fixes.
      expect(result.detail).toContain("Application-specific password required");
      expect(result.kind).toBe("auth");
    }
  });

  it("treats BAD as a refusal too", async () => {
    const { promise } = run({ onLogin: ["a1 BAD Command line too long"] });
    await expect(promise).resolves.toMatchObject({ ok: false, kind: "auth" });
  });

  it("separates 'signed in but the inbox will not open' from a bad password", async () => {
    const { promise } = run({ onSelect: ["a2 NO [NONEXISTENT] Unknown Mailbox: INBOX"] });
    await expect(promise).resolves.toMatchObject({ ok: false, kind: "mailbox" });
  });

  it("calls a greeting-level refusal a network problem, not a bad password", async () => {
    // "* BYE" before we say anything is the server declining to talk -- too many
    // connections from this address, usually. Recording it against the credential would
    // tell a member to replace a password that is fine.
    const { promise } = run({ greeting: "* BYE Too many simultaneous connections" });
    await expect(promise).resolves.toMatchObject({ ok: false, kind: "network" });
  });

  it("gives up on a server that never answers", async () => {
    const { promise } = run({ silent: true });
    await expect(promise).resolves.toMatchObject({ ok: false, kind: "network" });
  });

  it("reports a refused connection without blaming the credential", async () => {
    const result = await checkImapLogin({
      host: "imap.gmail.com",
      port: 993,
      user: "a@gmail.com",
      password: "x",
      connect: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    expect(result).toMatchObject({ ok: false, kind: "network" });
  });

  it("escapes a password that would otherwise break out of its own string", async () => {
    const { promise, written } = run({}, { password: 'has"quote\\and-slash' });
    await promise;
    const login = written.find((w) => w.startsWith("a1 LOGIN "))!;
    expect(login).toContain('\\"');
    expect(login).toContain("\\\\");
    // One command on one line, still terminated properly.
    expect(login.endsWith("\r\n")).toBe(true);
    expect(login.split("\r\n").filter(Boolean)).toHaveLength(1);
  });

  it("refuses an unsafe host before opening a socket", async () => {
    // The SSRF guard, wired in from imap-dial-guard.ts -- which owns the rules and its own
    // tests. What matters HERE is only that checkImapLogin consults it and gives up before
    // dialling, so `connected` staying false is the whole assertion.
    //
    // The resolver is injected so this stays hermetic: without it the evil.tld case would
    // put a real DNS query in a unit test.
    let connected = false;
    const resolve = async (host: string) => {
      if (host === "mail.corp.example") return ["10.0.0.5"];
      throw new Error("ENOTFOUND");
    };
    for (const host of [
      "localhost",
      "127.0.0.1",
      "169.254.169.254",
      "imap.gmail.com.evil.tld",
      "mail.corp.example",
    ]) {
      const result = await checkImapLogin({
        host,
        port: 993,
        user: "a@gmail.com",
        password: "x",
        resolve,
        connect: async () => {
          connected = true;
          return scripted({}).socket;
        },
      });
      expect(result, host).toMatchObject({ ok: false, kind: "network" });
    }
    expect(connected).toBe(false);
  });

  it("DOES dial a vanity mail host, which the vault legitimately contains", async () => {
    // The regression this whole change exists for: import-imap.ts writes hosts straight
    // from the operator's CSV, and the old allowlist guard reported every self-hosted
    // mailbox as Unreachable without ever opening a socket.
    const { socket } = scripted({});
    const result = await checkImapLogin({
      host: "mail.somecompany.com",
      port: 993,
      user: "someone@somecompany.com",
      password: "x",
      resolve: async () => ["203.0.113.10"],
      connect: async () => socket,
      timeoutMs: 200,
    });
    expect(result).toMatchObject({ ok: true });
  });

  it("never puts the password in the result", async () => {
    const secret = "sup3rsecretpassword";
    const { promise } = run({ onLogin: ["a1 NO Invalid credentials"] }, { password: secret });
    expect(JSON.stringify(await promise)).not.toContain(secret);
  });
});

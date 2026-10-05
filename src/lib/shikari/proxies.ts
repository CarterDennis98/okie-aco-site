import type { ProxyEntry } from "@/lib/shikari/types";

/**
 * A proxy list, read from the .txt a provider hands out.
 *
 * Accepts the shapes those files actually come in, one proxy per line:
 *
 *   host:port
 *   host:port:user:pass        the common one; a password may itself contain ":"
 *   user:pass@host:port
 *   http://user:pass@host:port (or https://, socks5://)
 *
 * Blank lines and `#` comments are skipped. A line that is none of the above is REPORTED,
 * by line number only -- the text holds credentials, and the page shows what it is told.
 * Exact duplicates are dropped and counted: a list with the same proxy twice gives two
 * browsers the same exit, which is the thing a list of distinct proxies exists to avoid.
 */
export type ParsedProxyList = {
  proxies: ProxyEntry[];
  /** 1-based line numbers that could not be read. */
  invalid: number[];
  duplicates: number;
};

const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

export function parseProxyLine(raw: string): ProxyEntry | null {
  const line = raw.trim().replace(SCHEME, "").replace(/\/+$/, "");
  if (!line) return null;

  let host: string;
  let portText: string;
  let username: string | null = null;
  let password: string | null = null;

  const at = line.lastIndexOf("@");
  if (at >= 0) {
    // user:pass@host:port -- split on the LAST "@", since a password can carry one.
    const credentials = line.slice(0, at);
    const address = line.slice(at + 1).split(":");
    if (address.length !== 2) return null;
    [host, portText] = address;
    const colon = credentials.indexOf(":");
    if (colon < 0) return null;
    username = credentials.slice(0, colon);
    password = credentials.slice(colon + 1);
  } else {
    const parts = line.split(":");
    if (parts.length === 2) {
      [host, portText] = parts;
    } else if (parts.length >= 4) {
      [host, portText, username] = parts;
      password = parts.slice(3).join(":");
    } else {
      return null;
    }
  }

  if (!/^[A-Za-z0-9._-]+$/.test(host)) return null;
  if (!/^\d{1,5}$/.test(portText)) return null;
  const port = Number(portText);
  if (port < 1 || port > 65535) return null;
  if (username !== null && (!username || !password)) return null;

  return { host, port, username, password };
}

export function parseProxyList(text: string): ParsedProxyList {
  const proxies: ProxyEntry[] = [];
  const invalid: number[] = [];
  const seen = new Set<string>();
  let duplicates = 0;

  text.split(/\r?\n/).forEach((raw, index) => {
    const line = raw.trim();
    if (!line || line.startsWith("#")) return;
    const proxy = parseProxyLine(line);
    if (!proxy) {
      invalid.push(index + 1);
      return;
    }
    const key = proxyKey(proxy);
    if (seen.has(key)) {
      duplicates++;
      return;
    }
    seen.add(key);
    proxies.push(proxy);
  });

  return { proxies, invalid, duplicates };
}

/** Equality for proxies: the same exit with the same credentials. */
export function proxyKey(proxy: ProxyEntry): string {
  return [proxy.host.toLowerCase(), proxy.port, proxy.username ?? "", proxy.password ?? ""].join(
    "\u0000",
  );
}

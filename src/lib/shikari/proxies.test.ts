import { describe, expect, it } from "vitest";
import { parseProxyLine, parseProxyList } from "@/lib/shikari/proxies";

describe("parseProxyLine", () => {
  it.each([
    ["63.141.1.21:8022", { host: "63.141.1.21", port: 8022, username: null, password: null }],
    [
      "gate.example.net:7777:user-1:pass",
      { host: "gate.example.net", port: 7777, username: "user-1", password: "pass" },
    ],
    // A provider's session syntax puts colons in the password; only the first three split.
    [
      "res.example.net:8000:cust-abc:pw:session-12:ttl-30",
      {
        host: "res.example.net",
        port: 8000,
        username: "cust-abc",
        password: "pw:session-12:ttl-30",
      },
    ],
    [
      "user:secret@10.0.0.1:3128",
      { host: "10.0.0.1", port: 3128, username: "user", password: "secret" },
    ],
    [
      "http://user:p@ss@10.0.0.1:3128/",
      { host: "10.0.0.1", port: 3128, username: "user", password: "p@ss" },
    ],
    ["socks5://10.0.0.2:1080", { host: "10.0.0.2", port: 1080, username: null, password: null }],
  ])("reads %s", (line, expected) => {
    expect(parseProxyLine(line)).toEqual(expected);
  });

  it.each([
    "10.0.0.1",
    "10.0.0.1:port",
    "10.0.0.1:70000",
    "10.0.0.1:80:user",
    "bad host:80",
    ":80",
  ])("refuses %s", (line) => {
    expect(parseProxyLine(line)).toBeNull();
  });
});

describe("parseProxyList", () => {
  it("skips blanks and comments, reports bad lines by number, and drops exact repeats", () => {
    const parsed = parseProxyList(
      [
        "# resi list",
        "a.example:1:u:p",
        "",
        "a.example:1:u:p",
        "nonsense",
        "b.example:2:u:p\r",
      ].join("\n"),
    );
    expect(parsed.proxies.map((p) => p.host)).toEqual(["a.example", "b.example"]);
    expect(parsed.invalid).toEqual([5]);
    expect(parsed.duplicates).toBe(1);
  });
});

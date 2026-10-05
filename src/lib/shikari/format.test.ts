import { describe, expect, it } from "vitest";
import { jsonObject, pyJson, shikariTime, uuid4 } from "@/lib/shikari/format";

describe("pyJson", () => {
  // Strings exactly as Shikari's own rows hold them, so a value the export re-writes
  // without changing comes out byte-identical.
  it.each([
    '{"auto_loop_checkout": false, "login_method": "password", "apply_circle_offers": false, "bypass_threshold": false, "save_cc_to_account": true, "ignore_low_stock": false}',
    '{"check_interval": 3333}',
    '{"ios_device_data": {"device_model": "iPhone18,4", "total_storage": 512, "gpu_registry_id": 4294967669, "ipv4_addresses": ["169.254.141.169 : en2", "192.168.3.28 : en0"]}, "site-password": null}',
    "{}",
    "[]",
  ])("writes %s back exactly as Python's json.dumps did", (text) => {
    expect(pyJson(JSON.parse(text))).toBe(text);
  });

  it("escapes non-ASCII the way ensure_ascii does", () => {
    expect(pyJson({ name: "Pokémon — ✓" })).toBe('{"name": "Pok\\u00e9mon \\u2014 \\u2713"}');
    expect(pyJson("\u007f")).toBe('"\u007f"');
  });
});

describe("shikariTime", () => {
  it("writes Python's str(datetime) form, in UTC, to the microsecond", () => {
    expect(shikariTime(new Date("2026-10-05T01:36:53.015Z"))).toBe("2026-10-05 01:36:53.015000");
  });
});

describe("helpers", () => {
  it("reads only JSON objects, and treats anything else as empty", () => {
    expect(jsonObject('{"a": 1}')).toEqual({ a: 1 });
    expect(jsonObject("[1]")).toEqual({});
    expect(jsonObject("not json")).toEqual({});
    expect(jsonObject(null)).toEqual({});
  });

  it("mints version-4 UUIDs, the same ones for the same seed", () => {
    const seeded = () => {
      let state = 9;
      return () => (state = (state * 1664525 + 1013904223) % 4294967296) / 4294967296;
    };
    const id = uuid4(seeded());
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(uuid4(seeded())).toBe(id);
  });
});

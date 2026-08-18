/**
 * Reading a typed money amount.
 *
 * The formatting half of this module is covered by the parity suite in normalize.test.ts,
 * which checks it byte-for-byte against the bot. This covers the input direction, added
 * for partial payments: an operator or member types an amount and a cent must not go
 * missing on the way in.
 */
import { describe, expect, it } from "vitest";
import { parseCents } from "@/lib/money";

describe("parseCents", () => {
  it("reads what people type into a money field", () => {
    expect(parseCents("12")).toBe(1200);
    expect(parseCents("12.5")).toBe(1250);
    expect(parseCents("$12.50")).toBe(1250);
    expect(parseCents("1,250")).toBe(125000);
    expect(parseCents(" 8 ")).toBe(800);
  });

  it("does not lose a cent to floating point", () => {
    // 12.34 * 100 is 1233.9999999999998; a bill left a cent short never settles.
    expect(parseCents("12.34")).toBe(1234);
    expect(parseCents("0.07")).toBe(7);
    expect(parseCents("19.99")).toBe(1999);
  });

  it("rejects rather than guesses", () => {
    expect(parseCents("")).toBeNull();
    expect(parseCents("abc")).toBeNull();
    expect(parseCents("-5")).toBeNull();
    expect(parseCents("1.234")).toBeNull(); // more precision than money has
    expect(parseCents("1.2.3")).toBeNull();
  });
});

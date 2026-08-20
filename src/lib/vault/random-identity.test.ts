/**
 * Random shipping identities.
 *
 * The thing worth testing is not that the output is random -- it is that every value the
 * button can produce is one the retailer will accept and one `normalizePhone` will store.
 * A generator that emits an unassignable area code or an N11 exchange hands the member a
 * profile that fails at checkout, which is the exact failure it exists to prevent.
 */
import { describe, expect, it } from "vitest";
import { normalizePhone } from "@/lib/vault/profile-input";
import { randomFirstName, randomLastName, randomPhone } from "@/lib/vault/random-identity";

/** A deterministic rng cycling through the given fractions. */
function rngOf(...values: number[]): () => number {
  let index = 0;
  return () => values[index++ % values.length];
}

describe("randomPhone", () => {
  it("always produces a number the vault will store", () => {
    // Every draw over a wide sweep of rng values, not one sample: the whole point is that
    // there is no unlucky combination that yields an unusable number.
    for (let i = 0; i < 500; i++) {
      const fraction = i / 500;
      const phone = randomPhone(
        "OK",
        rngOf(fraction, (fraction + 0.37) % 1, (fraction + 0.71) % 1),
      );
      expect(normalizePhone(phone), `rng ${fraction} produced ${phone}`).toBe(phone);
    }
  });

  it("takes the area code from the shipping state", () => {
    for (let i = 0; i < 50; i++) {
      expect(["405", "580", "918"]).toContain(randomPhone("OK").slice(0, 3));
      expect(["512", "214", "210", "409", "713", "806", "817", "915"]).toContain(
        randomPhone("tx").slice(0, 3),
      );
    }
  });

  it("still yields a valid number when the state is unknown or blank", () => {
    for (const state of [null, undefined, "", "ZZ", "Oklahoma"]) {
      const phone = randomPhone(state);
      expect(normalizePhone(phone)).toBe(phone);
    }
  });

  it("never emits an N11 service exchange", () => {
    // 211, 311, ... 911 are never assigned, and a retailer's validator rejects them.
    for (let i = 0; i < 300; i++) {
      expect(randomPhone("CA").slice(3, 6)).not.toMatch(/11$/);
    }
  });
});

describe("randomFirstName / randomLastName", () => {
  it("draws from the corpus", () => {
    expect(randomFirstName("Smith", [], rngOf(0))).toBe("Aaron");
    expect(randomLastName("Aaron", [], rngOf(0))).toBe("Abbott");
  });

  it("never runs off the end of the corpus at the top of the range", () => {
    // Math.random() is [0, 1), but a stubbed rng at 0.999... must still index in bounds.
    expect(randomFirstName("Smith", [], rngOf(0.9999999))).toBeTruthy();
    expect(randomLastName("Aaron", [], rngOf(0.9999999))).toBeTruthy();
  });

  it("judges collisions on the PAIR, not the field alone", () => {
    // The fields randomize independently, so "Aaron" is only a problem next to "Abbott".
    const taken = [{ firstName: "Aaron", lastName: "Abbott" }];
    // Same first name, different surname in the form -> no collision, first draw stands.
    expect(randomFirstName("Zamora", taken, rngOf(0))).toBe("Aaron");
    // Beside "Abbott" it would recreate the taken pair, so it draws again.
    expect(randomFirstName("Abbott", taken, rngOf(0, 0, 0.5))).not.toBe("Aaron");
  });

  it("avoids a taken pair from the surname side too", () => {
    const taken = [{ firstName: "Aaron", lastName: "Abbott" }];
    expect(randomLastName("Aaron", taken, rngOf(0, 0, 0.5))).not.toBe("Abbott");
    expect(randomLastName("Zamora", taken, rngOf(0))).toBe("Abbott");
  });

  it("matches case-insensitively", () => {
    const taken = [{ firstName: "aaron", lastName: "ABBOTT" }];
    expect(randomFirstName("Abbott", taken, rngOf(0, 0, 0.5))).not.toBe("Aaron");
  });

  it("gives up rather than hanging when everything collides", () => {
    // A stuck rng can only ever draw one value. The button must still return something.
    const taken = [{ firstName: "Aaron", lastName: "Abbott" }];
    expect(randomFirstName("Abbott", taken, () => 0)).toBe("Aaron");
  });

  it("treats an empty counterpart field as no collision", () => {
    // Half-filled form: nothing is a duplicate of a pair that doesn't exist yet.
    expect(randomFirstName("", [{ firstName: "Aaron", lastName: "Abbott" }], rngOf(0))).toBe(
      "Aaron",
    );
  });
});

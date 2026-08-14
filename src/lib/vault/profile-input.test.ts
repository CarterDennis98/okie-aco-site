/**
 * Profile form parsing and validation.
 *
 * This is where a bad save actually comes from: a card that passes a typo, an expiry
 * that loses its leading zero, a billing address left behind after the member ticked
 * "same as shipping", or a profile key that doesn't match the one the checkout pipeline
 * records. Card numbers below are Luhn-valid but not real.
 */
import { describe, expect, it } from "vitest";
import {
  nextProfileName,
  profileBaseFor,
  profileFieldsFromForm,
  profileIdentity,
  validateProfileForm,
} from "@/lib/vault/profile-input";

function formOf(overrides: Record<string, string> = {}): FormData {
  const base: Record<string, string> = {
    firstName: "Carter",
    lastName: "Dennis",
    phone: "4055551234",
    email: "someone@example.com",
    shipLine1: "10621 NW 40th Ter",
    shipCity: "Yukon",
    shipState: "ok",
    shipPostalCode: "73099",
    cardNumber: "4147098930053384",
    cardCvv: "525",
    cardExpMonth: "9",
    cardExpYear: "2029",
    sameBillingAndShipping: "on",
  };
  const form = new FormData();
  for (const [key, value] of Object.entries({ ...base, ...overrides })) {
    if (value !== "") form.set(key, value);
  }
  return form;
}

describe("validateProfileForm", () => {
  it("accepts a complete form", () => {
    expect(validateProfileForm(formOf(), true)).toBeNull();
  });

  it("requires the basics", () => {
    expect(validateProfileForm(formOf({ lastName: "" }), true)).toMatch(/last name/i);
    expect(validateProfileForm(formOf({ shipLine1: "" }), true)).toMatch(/shipping address/i);
  });

  it("insists on a two-letter state and a real ZIP", () => {
    expect(validateProfileForm(formOf({ shipState: "Oklahoma" }), true)).toMatch(/two-letter/i);
    expect(validateProfileForm(formOf({ shipPostalCode: "730" }), true)).toMatch(/ZIP/i);
    expect(validateProfileForm(formOf({ shipPostalCode: "73099-1234" }), true)).toBeNull();
  });

  it("catches a mistyped card before it reaches a drop", () => {
    // Transposed digits -- the exact failure Luhn exists for.
    expect(validateProfileForm(formOf({ cardNumber: "4147098930053834" }), true)).toMatch(/typo/i);
  });

  it("requires a card on create but not on edit", () => {
    expect(validateProfileForm(formOf({ cardNumber: "", cardCvv: "" }), true)).toMatch(
      /card number/i,
    );
    // Blank on edit means "keep the current card", which must be allowed.
    expect(validateProfileForm(formOf({ cardNumber: "", cardCvv: "" }), false)).toBeNull();
  });

  it("requires a security code whenever a new card is entered", () => {
    expect(validateProfileForm(formOf({ cardCvv: "" }), false)).toMatch(/security code/i);
  });

  it("matches the security code length to the card type", () => {
    // 3 digits on an Amex.
    expect(
      validateProfileForm(formOf({ cardNumber: "372658867781002", cardCvv: "123" }), true),
    ).toMatch(/security code/i);
    expect(
      validateProfileForm(formOf({ cardNumber: "372658867781002", cardCvv: "1234" }), true),
    ).toBeNull();
  });

  it("rejects an impossible expiry", () => {
    expect(validateProfileForm(formOf({ cardExpMonth: "13" }), true)).toMatch(/01–12/);
    expect(validateProfileForm(formOf({ cardExpMonth: "0" }), true)).toMatch(/01–12/);
    expect(validateProfileForm(formOf({ cardExpYear: "29" }), true)).toBeNull(); // expanded to 2029
  });

  it("requires a billing address only when it differs", () => {
    const separate = formOf({ sameBillingAndShipping: "" });
    expect(validateProfileForm(separate, true)).toMatch(/billing address/i);

    separate.set("billLine1", "1 Other St");
    separate.set("billCity", "Edmond");
    separate.set("billState", "OK");
    expect(validateProfileForm(separate, true)).toBeNull();
  });
});

describe("profileFieldsFromForm", () => {
  it("uppercases the state and pads the expiry month", () => {
    const fields = profileFieldsFromForm(formOf());
    expect(fields.shipState).toBe("OK");
    expect(fields.cardExpMonth).toBe("09");
    expect(fields.cardExpYear).toBe("2029");
  });

  it("nulls every billing field when billing matches shipping", () => {
    // Otherwise a previously-entered billing address lingers in the row and reappears
    // in an export long after the member said it no longer applied.
    const fields = profileFieldsFromForm(
      formOf({ sameBillingAndShipping: "on", billLine1: "1 Stale St", billCity: "Nowhere" }),
    );
    expect(fields.sameBillingAndShipping).toBe(true);
    expect(fields.billLine1).toBeNull();
    expect(fields.billCity).toBeNull();
    expect(fields.billCountry).toBeNull();
  });

  it("keeps the billing address when it differs", () => {
    const fields = profileFieldsFromForm(
      formOf({
        sameBillingAndShipping: "",
        billLine1: "1 Other St",
        billCity: "Edmond",
        billState: "ok",
      }),
    );
    expect(fields.sameBillingAndShipping).toBe(false);
    expect(fields.billLine1).toBe("1 Other St");
    expect(fields.billState).toBe("OK");
  });

  it("turns an empty optional into null rather than an empty string", () => {
    expect(profileFieldsFromForm(formOf({ phone: "" })).phone).toBeNull();
  });
});

describe("profileIdentity", () => {
  it("derives the same key the checkout pipeline records", () => {
    expect(profileIdentity("carter - 2")).toEqual({ profileKey: "carter", profileIndex: 2 });
    expect(profileIdentity("shockereyes - 10")).toEqual({
      profileKey: "shockereyes",
      profileIndex: 10,
    });
  });

  it("leaves a name without a hyphenated suffix alone", () => {
    // "Target 9" keeps the number: the suffix pattern requires a hyphen, so a bare
    // space does not make an index. These house profiles are attributed through the
    // FAMILY matching in profileMap.json instead ("target" covers "target 9"), which
    // is why the import resolved 44 of them without any index.
    expect(profileIdentity("Target 9")).toEqual({ profileKey: "target 9", profileIndex: null });
    expect(profileIdentity("devin24")).toEqual({ profileKey: "devin24", profileIndex: null });
  });

  it("does not treat a trailing number inside a handle as an index", () => {
    // "thisisgold0220" is a real member; splitting it would attribute their checkouts
    // to a profile called "thisisgold".
    expect(profileIdentity("thisisgold0220")).toEqual({
      profileKey: "thisisgold0220",
      profileIndex: null,
    });
  });
});

describe("nextProfileName", () => {
  it("gives the first profile the bare base name", () => {
    expect(nextProfileName("shockereyes", [])).toBe("shockereyes");
  });

  it("counts on from the existing profiles", () => {
    // The example from the brief: 7 existing profiles -> "shockereyes - 8".
    const existing = [
      "shockereyes",
      "shockereyes - 2",
      "shockereyes - 3",
      "shockereyes - 4",
      "shockereyes - 5",
      "shockereyes - 6",
      "shockereyes - 7",
    ];
    expect(nextProfileName("shockereyes", existing)).toBe("shockereyes - 8");
  });

  it("reuses the number of a deleted profile", () => {
    // "- 3" was deleted, so the next profile fills that slot rather than drifting to
    // "- 5" and leaving a permanent hole in the numbering.
    expect(nextProfileName("carter", ["carter", "carter - 2", "carter - 4"])).toBe("carter - 3");
  });

  it("reuses the bare base name when the first profile was deleted", () => {
    expect(nextProfileName("carter", ["carter - 2", "carter - 3"])).toBe("carter");
  });

  it("skips a name another member already holds on the same site", () => {
    // (site, name) is unique across all members, so a clash has to be stepped over.
    expect(nextProfileName("carter", ["carter"])).toBe("carter - 2");
    expect(nextProfileName("carter", ["carter", "carter - 2"])).toBe("carter - 3");
  });

  it("ignores profiles belonging to a different base", () => {
    expect(nextProfileName("carter", ["shockereyes - 9", "target 4"])).toBe("carter");
  });
});

describe("profileBaseFor", () => {
  it("prefers the base already in use over the Discord handle", () => {
    // These genuinely disagree: someone checks out as "shockereyes" while their Discord
    // username is something else. Switching base would split their profiles in two.
    expect(profileBaseFor(["shockereyes", "shockereyes - 2"], "sahab_astani")).toBe("shockereyes");
  });

  it("falls back to the Discord handle for a member with no profiles yet", () => {
    expect(profileBaseFor([], "NewMember")).toBe("newmember");
  });

  it("picks the most common base when they are mixed", () => {
    expect(profileBaseFor(["carter", "carter - 2", "oddone"], "whoever")).toBe("carter");
  });
});

describe("family grouping", () => {
  it("treats space-separated house profiles as one family", () => {
    // 58 profiles named "Target 1".."Target 59" each key differently, because the
    // suffix rule needs a hyphen. Grouped naively the base came out as "target 1" and
    // the next name as "target 1 - 2".
    const house = Array.from({ length: 59 }, (_, i) => `Target ${i + 1}`);
    expect(profileBaseFor(house, "ou1998")).toBe("target");
    expect(nextProfileName("target", house)).toBe("target - 60");
  });

  it("counts hyphenated and spaced members of a family together", () => {
    // 3 and 5 are taken across both spellings, so 1 is the lowest free slot.
    expect(nextProfileName("carter", ["Carter 3", "carter - 5"])).toBe("carter");
    expect(nextProfileName("carter", ["carter", "Carter 2", "carter - 4"])).toBe("carter - 3");
  });

  it("does not pull an unrelated name into a family", () => {
    // "carterson" starts with "carter" but is a different person.
    expect(nextProfileName("carter", ["carterson", "carterson - 4"])).toBe("carter");
  });
});

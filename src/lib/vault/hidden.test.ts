import { describe, expect, it } from "vitest";
import { siteHiddenGroup } from "@/lib/sites";
import type { ExportableProfile } from "@/lib/vault/aycd";
import {
  HIDDEN_HEADER,
  hiddenCardType,
  hiddenPhone,
  toHiddenCsv,
  toHiddenRow,
  type HiddenGroup,
} from "@/lib/vault/hidden";

/**
 * Hidden AIO's profile CSV, held to the one file Hidden has been seen to write: a test profile
 * the operator exported from Hidden's Costco group on 2026-11-19. Both of its lines are here
 * verbatim -- every value in them is made up, the card included.
 */
const HIDDEN_HEADER_LINE =
  "profileName,shippingFirstName,shippingLastName,shippingEmail,shippingPhone,shippingLine1,shippingLine2,shippingLine3,shippingPostCode,shippingCity,shippingCountry,shippingState,sameBillingAndShippingAddress,billingFirstName,billingLastName,billingEmail,billingPhone,billingLine1,billingLine2,billingLine3,billingPostCode,billingCity,billingCountry,billingState,cardFirstName,cardLastName,cardType,cardNumber,cardExpMonth,cardExpYear,cardCvv,onlyCheckoutOnce,accountEmail,profileId (do not edit),groupName,groupId (do not edit)";
const HIDDEN_ROW =
  "Test,Test,Test,test@gmail.com,4051234567,1234 W Test St,,,73069,Test,US,OK,true,Test,Test,test@gmail.com,4051234567,1234 W Test St,,,73069,Test,US,OK,Test,Test,visa,1234123412341234,10,2030,666,false,,fe0234c2-1c86-442f-827d-2753b96f8b41,Costco,53815241-3f20-4e10-b987-33c26c671f80";

const COSTCO: HiddenGroup = siteHiddenGroup("costco")!;

/** That test profile, as the vault would hold it -- with a real test Visa, see below. */
const base: ExportableProfile = {
  id: "cm0a1b2c3d4e5f6g7h8i9j0k",
  siteKey: "costco",
  name: "Test",
  email: "test@gmail.com",
  firstName: "Test",
  lastName: "Test",
  phone: "4051234567",
  shipLine1: "1234 W Test St",
  shipLine2: null,
  shipCity: "Test",
  shipState: "OK",
  shipPostalCode: "73069",
  shipCountry: "US",
  sameBillingAndShipping: true,
  billFirstName: null,
  billLastName: null,
  billLine1: null,
  billLine2: null,
  billCity: null,
  billState: null,
  billPostalCode: null,
  billCountry: null,
  cardBrand: "Visa",
  cardExpMonth: "10",
  cardExpYear: "2030",
  onlyCheckoutOnce: false,
  matchNameOnCardAndAddress: true,
  cardNumber: "4111111111111111",
  cardCvv: "666",
};

const row = (over: Partial<ExportableProfile> = {}) => toHiddenRow({ ...base, ...over }, COSTCO);

/** A CSV line back into cells, quotes and all -- enough of RFC 4180 to read our own output. */
function cells(line: string): string[] {
  const out: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted && c === '"' && line[i + 1] === '"') {
      cell += '"';
      i++;
    } else if (c === '"') quoted = !quoted;
    else if (c === "," && !quoted) {
      out.push(cell);
      cell = "";
    } else cell += c;
  }
  out.push(cell);
  return out;
}

describe("toHiddenCsv", () => {
  it("writes Hidden's own header, column for column", () => {
    expect(HIDDEN_HEADER.join(",")).toBe(HIDDEN_HEADER_LINE);
    expect(toHiddenCsv([], COSTCO)).toBe(HIDDEN_HEADER_LINE);
  });

  it("reproduces the row Hidden wrote for the same profile", () => {
    // Two differences, both on purpose. The number is a real test Visa: Hidden's placeholder
    // starts with a 1, which no brand does, and the type is read off the digits. And the
    // profile id is blank, because the profile is new to Hidden.
    const expected = HIDDEN_ROW.replace("1234123412341234", "4111111111111111").replace(
      "fe0234c2-1c86-442f-827d-2753b96f8b41",
      "",
    );
    expect(toHiddenCsv([base], COSTCO)).toBe(`${HIDDEN_HEADER_LINE}\n${expected}`);
  });

  it("separates lines with \\n and ends on the last row, with no BOM", () => {
    const csv = toHiddenCsv([base, { ...base, name: "Test 2" }], COSTCO);
    expect(csv.split("\n")).toHaveLength(3);
    expect(csv).not.toContain("\r");
    expect(csv.endsWith("\n")).toBe(false);
    expect(csv.charCodeAt(0)).not.toBe(0xfeff);
  });

  it("quotes a cell with a comma or a quote in it, and only those", () => {
    const csv = toHiddenCsv(
      [{ ...base, shipLine1: "2401 S Cooper St, Wichita", firstName: 'Jo "JJ"' }],
      COSTCO,
    );
    const line = csv.split("\n")[1];
    expect(line).toContain('"2401 S Cooper St, Wichita"');
    expect(line).toContain('"Jo ""JJ"""');
    // Still 36 cells, holding exactly what went in.
    const read = cells(line);
    expect(read).toHaveLength(HIDDEN_HEADER.length);
    expect(read[HIDDEN_HEADER.indexOf("shippingLine1")]).toBe("2401 S Cooper St, Wichita");
    expect(read[HIDDEN_HEADER.indexOf("shippingFirstName")]).toBe('Jo "JJ"');
  });
});

describe("toHiddenRow", () => {
  it("writes billing out in full when it is the shipping address", () => {
    const out = row({ shipLine2: "Apt 5" });
    expect(out.sameBillingAndShippingAddress).toBe("true");
    for (const field of ["FirstName", "LastName", "Email", "Phone", "Line1", "Line2", "Line3"]) {
      expect(out[`billing${field}` as keyof typeof out], field).toBe(
        out[`shipping${field}` as keyof typeof out],
      );
    }
    expect(out.billingLine2).toBe("Apt 5");
  });

  it("writes a separate billing address, and puts its name on the card", () => {
    const out = row({
      sameBillingAndShipping: false,
      billFirstName: "Daniel",
      billLastName: "Mendoza",
      billLine1: "1005 SW 16th St",
      billCity: "Moore",
      billState: "OK",
      billPostalCode: "73160",
      billCountry: "US",
    });
    expect(out).toMatchObject({
      sameBillingAndShippingAddress: "false",
      shippingFirstName: "Test",
      billingFirstName: "Daniel",
      billingLastName: "Mendoza",
      billingLine1: "1005 SW 16th St",
      billingLine2: "",
      billingCity: "Moore",
      billingState: "OK",
      billingPostCode: "73160",
      billingCountry: "US",
      cardFirstName: "Daniel",
      cardLastName: "Mendoza",
    });
  });

  it("falls back to the shipping name where billing has none, as the AYCD file does", () => {
    const out = row({ sameBillingAndShipping: false, billLine1: "9 Other St", billCity: "Tulsa" });
    expect(out.billingFirstName).toBe("Test");
    expect(out.cardLastName).toBe("Test");
  });

  it("writes the two-letter state and US however the vault spelled them", () => {
    const out = row({ shipState: "Oklahoma", shipCountry: "United States" });
    expect(out.shippingState).toBe("OK");
    expect(out.shippingCountry).toBe("US");
    expect(row({ shipCountry: "" }).shippingCountry).toBe("US");
  });

  it("keeps the leading zeros a ZIP, a code and a month carry", () => {
    const out = row({ shipPostalCode: "07506", cardCvv: "068", cardExpMonth: "4" });
    expect(out.shippingPostCode).toBe("07506");
    expect(out.cardCvv).toBe("068");
    expect(out.cardExpMonth).toBe("04");
    expect(row({ shipPostalCode: "10128-4087" }).shippingPostCode).toBe("10128-4087");
  });

  it("files every row under the retailer's group and leaves Hidden's own ids blank", () => {
    const out = row();
    expect(out.groupName).toBe("Costco");
    expect(out["groupId (do not edit)"]).toBe("53815241-3f20-4e10-b987-33c26c671f80");
    expect(out["profileId (do not edit)"]).toBe("");
    expect(out.accountEmail).toBe("");
    expect(out.shippingLine3).toBe("");
  });

  it("writes the one-checkout flag as Hidden does", () => {
    expect(row({ onlyCheckoutOnce: true }).onlyCheckoutOnce).toBe("true");
    expect(row().onlyCheckoutOnce).toBe("false");
  });

  it("gives a profile with no phone the number the AYCD file gives it", () => {
    const first = row({ phone: null }).shippingPhone;
    expect(first).toMatch(/^\d{10}$/);
    // Seeded by the profile, so it holds still from one export to the next.
    expect(row({ phone: null }).shippingPhone).toBe(first);
    expect(row({ phone: null }).billingPhone).toBe(first);
  });
});

describe("hiddenCardType", () => {
  it("reads the brand off the number, in lowercase", () => {
    expect(hiddenCardType("4111111111111111")).toBe("visa");
    expect(hiddenCardType("5555555555554444")).toBe("mastercard");
    expect(hiddenCardType("2223003122003222")).toBe("mastercard");
    expect(hiddenCardType("378282246310005")).toBe("amex");
    expect(hiddenCardType("6011111111111117")).toBe("discover");
  });

  it("leaves anything else blank rather than guessing", () => {
    expect(hiddenCardType("6394630000000000")).toBe(""); // Target REDcard
    expect(hiddenCardType("1234123412341234")).toBe("");
  });

  it("is what the row writes, whatever the stored brand says", () => {
    expect(row({ cardNumber: "5555555555554444", cardBrand: "Visa" }).cardType).toBe("mastercard");
    expect(row({ cardNumber: "4111 1111 1111 1111" }).cardNumber).toBe("4111111111111111");
  });
});

describe("hiddenPhone", () => {
  it("writes ten digits however the number was punctuated", () => {
    expect(hiddenPhone("(405) 555-0101")).toBe("4055550101");
    expect(hiddenPhone("405-555-0101")).toBe("4055550101");
    expect(hiddenPhone("+1 405 555 0101")).toBe("4055550101");
    expect(hiddenPhone("4055550101")).toBe("4055550101");
  });
});

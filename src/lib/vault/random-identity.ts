/**
 * Random shipping identities for the profile editor.
 *
 * WHY THIS EXISTS: retailers throttle and cancel orders that look like one person
 * checking out five times, and the signal they key on is repeated name and phone across
 * profiles. Members were varying these by hand, badly -- "John Smith 2", one phone number
 * on every profile -- which is worse than not varying them, because it is a pattern.
 *
 * WHAT IT DELIBERATELY DOES NOT DO: touch the address or the card. Those have to be real,
 * they are what the payment actually clears against, and a random one is a declined order
 * rather than a disguised one. Name and phone are the only fields where a plausible
 * invention is better than a repeat.
 *
 * Pure and synchronous, so the form can call it in an onClick and the tests can assert on
 * it without a DOM. Randomness is injected, which is the only reason the shape of the
 * output is testable at all.
 */

/**
 * Given names, deliberately spanning the eras and origins that actually turn up on US
 * shipping labels rather than one decade's top-ten. A corpus that all reads as
 * twenty-five-year-olds from the same census tract is its own pattern.
 */
// Space-separated and split, not an array literal: prettier puts one string per line in an
// array that doesn't fit, which is 124 lines of names each. This reads as the list it is.
const FIRST_NAMES = `
Aaron Adriana Alan Alicia Amara Andre Angela Anthony Bianca Brandon Brenda Bryan
Camila Carl Carmen Cedric Chelsea Clarence Colleen Curtis Damon Danielle Darius Dawn
Denise Derrick Diane Dominic Elaine Elena Elliot Erica Ernesto Felicia Fernando Frances
Gabriel Gina Glenn Gloria Gordon Grace Harold Heather Hector Imani Irene Isaac
Ivan Jacqueline Janelle Jared Jasmine Javier Jeanette Jerome Joanne Jonas Josephine Julian
Kara Keith Kendra Kevin Latoya Laurel Leonard Lorraine Lucas Lydia Malik Marcus
Margarita Marilyn Martin Maureen Melvin Miguel Monica Nadia Nathan Nicole Norman Olivia
Omar Patrice Paula Perry Priya Rachel Ramon Regina Renee Ricardo Roberta Rodney
Rosa Russell Samir Sandra Sergio Sharon Sheldon Sonia Stanley Stephanie Sylvia Tamara
Terrence Theresa Tobias Tonya Trevor Valerie Vanessa Vernon Veronica Vincent Wanda Wesley
Whitney Wyatt Yolanda Yusuf
`
  .trim()
  .split(/\s+/);

/** Surnames, on the same principle. */
const LAST_NAMES = `
Abbott Acosta Aguilar Alvarez Ashford Ballard Barnett Beasley Bellamy Blackwell Bowen
Bradshaw Brennan Briggs Cabrera Caldwell Calloway Cardenas Carrington Castillo Chandler
Chapman Colbert Conley Contreras Cortez Crawford Cunningham Dalton Delacruz Dempsey Devlin
Dorsey Duarte Dunlap Eastman Escobar Everett Fairchild Farrell Fitzgerald Fleming Fontaine
Galloway Garrison Gentry Gilliam Glover Granger Guerrero Hadley Hancock Harrington Hastings
Hollis Holloway Huffman Ibarra Ingram Jennings Kimball Kirkland Langford Lattimore Ledbetter
Lombardi Lockhart Maddox Mallory Mancini Marquez Mathis McAllister McClain Mendoza Merritt
Montague Mosley Nakamura Navarro Nunez Odell Okafor Oliveira Osborne Pemberton Peralta
Pickett Prescott Quintero Ramsey Rawlings Redmond Rhodes Rincon Rutledge Salazar Sandoval
Sargent Sheridan Sinclair Solano Stafford Sterling Sutherland Tanaka Thornton Tillman
Trujillo Underwood Vaughn Vega Villanueva Wakefield Waller Whitfield Winslow Woodard Yeager
Zamora
`
  .trim()
  .split(/\s+/);

/**
 * Real, in-service NANP area codes by state.
 *
 * A number whose area code doesn't match the shipping state is a mismatch a fraud check
 * can see, so the state picks the code. Two to four per state rather than every code:
 * the list only has to be RIGHT, and a short accurate one beats a long one with a
 * decommissioned code in it. `null` state falls back to ANY_AREA_CODES.
 */
const AREA_CODES: Record<string, string[]> = {
  AK: ["907"],
  AL: ["205", "251", "256", "334"],
  AR: ["479", "501", "870"],
  AZ: ["480", "520", "602", "928"],
  CA: ["209", "310", "415", "619", "714", "916"],
  CO: ["303", "719", "970"],
  CT: ["203", "860"],
  DC: ["202"],
  DE: ["302"],
  FL: ["305", "407", "813", "904", "954"],
  GA: ["404", "478", "706", "912"],
  HI: ["808"],
  IA: ["319", "515", "563", "712"],
  ID: ["208"],
  IL: ["217", "312", "618", "815", "847"],
  IN: ["219", "317", "574", "812"],
  KS: ["316", "620", "785", "913"],
  KY: ["270", "502", "606", "859"],
  LA: ["225", "318", "337", "504"],
  MA: ["413", "508", "617", "781"],
  MD: ["301", "410", "443"],
  ME: ["207"],
  MI: ["231", "313", "517", "616", "734"],
  MN: ["218", "507", "612", "651"],
  MO: ["314", "417", "573", "816"],
  MS: ["228", "601", "662"],
  MT: ["406"],
  NC: ["252", "336", "704", "828", "919"],
  ND: ["701"],
  NE: ["308", "402"],
  NH: ["603"],
  NJ: ["201", "609", "732", "856", "973"],
  NM: ["505", "575"],
  NV: ["702", "775"],
  NY: ["315", "516", "518", "585", "607", "716", "718", "914"],
  OH: ["216", "330", "419", "513", "614", "937"],
  OK: ["405", "580", "918"],
  OR: ["503", "541", "971"],
  PA: ["215", "412", "570", "610", "717", "814"],
  RI: ["401"],
  SC: ["803", "843", "864"],
  SD: ["605"],
  TN: ["423", "615", "731", "865", "901"],
  TX: ["210", "214", "409", "512", "713", "806", "817", "915"],
  UT: ["385", "435", "801"],
  VA: ["540", "703", "757", "804"],
  VT: ["802"],
  WA: ["206", "253", "360", "509"],
  WI: ["414", "608", "715", "920"],
  WV: ["304"],
  WY: ["307"],
};

/** Used when the state is unknown or isn't one we have codes for. */
const ANY_AREA_CODES = ["214", "312", "404", "480", "602", "704", "813", "816", "919", "972"];

/** `random()` is injected so tests can pin the output. Defaults to Math.random. */
export type Rng = () => number;

function pick<T>(items: readonly T[], random: Rng): T {
  return items[Math.floor(random() * items.length)];
}

export type TakenName = { firstName: string; lastName: string };

/**
 * Draw from `pool` until the FULL NAME it produces isn't one the member already uses.
 *
 * The fields randomize one at a time, so uniqueness can only be judged on the pair: a new
 * first name is fine or not depending on the last name already sitting beside it. Hence
 * `toFullName` rather than comparing the drawn value directly.
 *
 * Bounded attempts, then it returns whatever it last drew. With 124 names either side a
 * collision is already unlikely, and a member who somehow holds most of the corpus should
 * still get a working button rather than a hang.
 */
function pickUnique(
  pool: readonly string[],
  taken: readonly TakenName[],
  toFullName: (candidate: string) => string,
  random: Rng,
): string {
  const used = new Set(taken.map((t) => `${t.firstName} ${t.lastName}`.trim().toLowerCase()));

  let candidate = pick(pool, random);
  for (let attempt = 0; attempt < 25; attempt++) {
    if (!used.has(toFullName(candidate).trim().toLowerCase())) break;
    candidate = pick(pool, random);
  }
  return candidate;
}

/**
 * A first name that doesn't recreate a full name the member already has on this retailer.
 *
 * `lastName` is the one currently in the form, not a stored value -- the pair being judged
 * is the one the member would end up with if they stopped clicking now.
 */
export function randomFirstName(
  lastName: string,
  taken: readonly TakenName[] = [],
  random: Rng = Math.random,
): string {
  return pickUnique(FIRST_NAMES, taken, (first) => `${first} ${lastName}`, random);
}

/** The mirror of `randomFirstName`. */
export function randomLastName(
  firstName: string,
  taken: readonly TakenName[] = [],
  random: Rng = Math.random,
): string {
  return pickUnique(LAST_NAMES, taken, (last) => `${firstName} ${last}`, random);
}

/**
 * A ten-digit US number, plausible for `state`.
 *
 * NANP rules, which are what a retailer's own validator checks:
 *   - the area code comes from the table above, so it is one that exists
 *   - the exchange (next three) may not start with 0 or 1
 *   - N11 exchanges (211, 311, ... 911) are service codes and never assigned
 *
 * Returned as bare digits, matching `normalizePhone` and the column.
 *
 * NOT a reserved 555-01xx number: those are guaranteed unassigned, but retailers reject
 * them, and a profile that cannot receive an order confirmation is worse than one sharing
 * an exchange with somebody. The trade is deliberate.
 */
export function randomPhone(state?: string | null, random: Rng = Math.random): string {
  const codes = AREA_CODES[String(state ?? "").toUpperCase()] ?? ANY_AREA_CODES;
  const area = pick(codes, random);

  // Bounded, not `do/while`: a stubbed rng that happens to land on an N11 every time
  // would spin forever, and a test hanging is a worse failure than one unlucky number.
  let exchange = String(200 + Math.floor(random() * 800));
  for (let attempt = 0; attempt < 10 && exchange.endsWith("11"); attempt++) {
    exchange = String(200 + Math.floor(random() * 800));
  }
  if (exchange.endsWith("11")) exchange = "555";

  const line = String(Math.floor(random() * 10000)).padStart(4, "0");
  return `${area}${exchange}${line}`;
}

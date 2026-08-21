import { describe, expect, it } from "vitest";
import {
  isProfileFilterActive,
  matchesProfileFilter,
  parseProfileFilter,
  type SearchableProfile,
} from "@/lib/vault/profile-filter";

const profile: SearchableProfile = {
  name: "shockereyes - 6",
  active: true,
  email: "Shocker.Eyes+t6@Gmail.com",
  firstName: "Jane",
  lastName: "Doe",
  shipCity: "Tulsa",
  shipState: "OK",
  phone: "(405) 555-1234",
};

const disabled: SearchableProfile = { ...profile, name: "shockereyes - 7", active: false };

describe("parseProfileFilter", () => {
  it("splits on whitespace and lowercases", () => {
    expect(parseProfileFilter({ q: "  Shocker   GMAIL " }).terms).toEqual(["shocker", "gmail"]);
  });

  it("defaults to no terms and every status", () => {
    const filter = parseProfileFilter({});
    expect(filter.terms).toEqual([]);
    expect(filter.status).toBe("all");
    expect(isProfileFilterActive(filter)).toBe(false);
  });

  it("falls back to all on an unknown status rather than showing nothing", () => {
    expect(parseProfileFilter({ status: "enabled" }).status).toBe("all");
    expect(parseProfileFilter({ status: "inactive" }).status).toBe("inactive");
  });

  it("counts a status-only filter as active", () => {
    expect(isProfileFilterActive(parseProfileFilter({ status: "active" }))).toBe(true);
  });

  it("caps a pasted paragraph so it can't become an unsatisfiable AND", () => {
    const many = Array.from({ length: 30 }, (_, i) => `w${i}`).join(" ");
    expect(parseProfileFilter({ q: many }).terms).toHaveLength(10);
  });
});

describe("matchesProfileFilter", () => {
  const filter = (q?: string, status?: string) => parseProfileFilter({ q, status });

  it("matches the profile name, case-insensitively", () => {
    expect(matchesProfileFilter(profile, filter("SHOCKER"))).toBe(true);
    expect(matchesProfileFilter(profile, filter("- 6"))).toBe(true);
  });

  it("matches the account email and its domain", () => {
    expect(matchesProfileFilter(profile, filter("gmail.com"))).toBe(true);
    expect(matchesProfileFilter(profile, filter("+t6"))).toBe(true);
  });

  it("matches a full name spanning two columns", () => {
    expect(matchesProfileFilter(profile, filter("jane doe"))).toBe(true);
    expect(matchesProfileFilter(profile, filter("doe"))).toBe(true);
  });

  it("matches the city and state", () => {
    expect(matchesProfileFilter(profile, filter("tulsa"))).toBe(true);
    expect(matchesProfileFilter(profile, filter("ok"))).toBe(true);
  });

  it("matches a phone typed without punctuation", () => {
    expect(matchesProfileFilter(profile, filter("4055551234"))).toBe(true);
    expect(matchesProfileFilter(profile, filter("555-1234"))).toBe(true);
  });

  it("requires every term to match something", () => {
    expect(matchesProfileFilter(profile, filter("shocker tulsa"))).toBe(true);
    // Second term matches nothing, so the whole search misses -- otherwise a stray word
    // would widen the result set instead of narrowing it.
    expect(matchesProfileFilter(profile, filter("shocker yahoo"))).toBe(false);
  });

  it("filters by active state", () => {
    expect(matchesProfileFilter(profile, filter(undefined, "active"))).toBe(true);
    expect(matchesProfileFilter(profile, filter(undefined, "inactive"))).toBe(false);
    expect(matchesProfileFilter(disabled, filter(undefined, "inactive"))).toBe(true);
    expect(matchesProfileFilter(disabled, filter(undefined, "active"))).toBe(false);
  });

  it("combines search and state", () => {
    expect(matchesProfileFilter(disabled, filter("shocker", "inactive"))).toBe(true);
    expect(matchesProfileFilter(disabled, filter("shocker", "active"))).toBe(false);
  });

  it("keeps everything when nothing is set", () => {
    expect(matchesProfileFilter(profile, filter())).toBe(true);
    expect(matchesProfileFilter(disabled, filter())).toBe(true);
  });

  it("tolerates a profile with the optional columns missing", () => {
    const sparse: SearchableProfile = { name: "bare - 1", active: true, email: "b@aol.com" };
    expect(matchesProfileFilter(sparse, filter("bare"))).toBe(true);
    expect(matchesProfileFilter(sparse, filter("tulsa"))).toBe(false);
  });
});

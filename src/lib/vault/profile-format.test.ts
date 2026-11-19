import { describe, expect, it } from "vitest";
import { supportedSites } from "@/lib/sites";
import {
  DEFAULT_PROFILE_FORMAT,
  isProfileFormat,
  profileFormatLabel,
  siteProfileFormats,
} from "@/lib/vault/profile-format";

describe("siteProfileFormats", () => {
  it("offers Hidden's CSV beside AYCD's file on Costco", () => {
    expect(siteProfileFormats("costco")).toEqual(["aycd", "hidden"]);
    expect(siteProfileFormats("Costco")).toEqual(["aycd", "hidden"]);
  });

  it("offers AYCD's file alone everywhere else, a new retailer included", () => {
    for (const site of supportedSites().filter((s) => s.key !== "costco")) {
      expect(siteProfileFormats(site.key), site.key).toEqual(["aycd"]);
    }
    expect(siteProfileFormats("some-new-store")).toEqual(["aycd"]);
    expect(siteProfileFormats(null)).toEqual(["aycd"]);
  });

  it("always lists the default first, so a picker opens on the file there was before", () => {
    for (const site of supportedSites()) {
      expect(siteProfileFormats(site.key)[0]).toBe(DEFAULT_PROFILE_FORMAT);
    }
  });
});

describe("isProfileFormat", () => {
  it("knows the two formats and nothing else", () => {
    expect(isProfileFormat("aycd")).toBe(true);
    expect(isProfileFormat("hidden")).toBe(true);
    for (const value of ["accounts", "imap", "Hidden", "", null, undefined, "toString"]) {
      expect(isProfileFormat(value), String(value)).toBe(false);
    }
  });

  it("labels each by its bot's name", () => {
    expect(profileFormatLabel("aycd")).toBe("AYCD");
    expect(profileFormatLabel("hidden")).toBe("Hidden");
  });
});

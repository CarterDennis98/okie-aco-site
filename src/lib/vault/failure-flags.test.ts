/**
 * The flag rules: how many failures make a profile orange or red, which profile a failure ran
 * on, and from when its failures count. Pure -- the ingest route and the pages are tested
 * against the database in their own files.
 */
import { describe, expect, it } from "vitest";
import {
  cancellationReason,
  cleanSince,
  countsTowardFlag,
  flagLabel,
  flagsByProfile,
  HIGH_RISK_AT,
  matchFailureProfile,
  riskFor,
  tidyReason,
} from "@/lib/vault/failure-flags";

const at = (iso: string) => new Date(iso);

describe("cancellationReason", () => {
  it("reads the policy out of every vendor's wording", () => {
    // Shikari
    expect(cancellationReason("Order Canceled: Item Demand")).toBe("item demand");
    expect(cancellationReason("Order Canceled: Quantity Limit")).toBe("quantity limit");
    expect(cancellationReason("Order Canceled: Reseller")).toBe("reseller");
    expect(cancellationReason("Order Canceled: Other")).toBe("other");
    // Sniped
    expect(cancellationReason("Cancelled Checkout (Policy - Item Demand)")).toBe("item demand");
    expect(cancellationReason("Cancelled Checkout (Policy - Quantity Limit)")).toBe(
      "quantity limit",
    );
    // Refract and Swft
    expect(cancellationReason("Policy - Item Demand")).toBe("item demand");
    expect(cancellationReason("**Policy  -  Reseller**")).toBe("reseller");
  });

  it("knows a cancellation that gave no policy from a failure that was never one", () => {
    expect(cancellationReason("Cancelled Checkout")).toBe("");
    expect(cancellationReason("Payment Declined")).toBeNull();
    expect(cancellationReason("Checkout Failed")).toBeNull();
    expect(cancellationReason(null)).toBeNull();
  });
});

describe("countsTowardFlag", () => {
  it("counts only Item Demand and Reseller among Target's cancellations", () => {
    expect(countsTowardFlag("target", "Order Canceled: Item Demand")).toBe(true);
    expect(countsTowardFlag("target", "Order Canceled: Reseller")).toBe(true);
    expect(countsTowardFlag("target", "Cancelled Checkout (Policy - Item Demand)")).toBe(true);
    // The member hit their own checkout limit: nothing wrong with the profile.
    expect(countsTowardFlag("target", "Order Canceled: Quantity Limit")).toBe(false);
    expect(countsTowardFlag("target", "Cancelled Checkout (Policy - Quantity Limit)")).toBe(false);
    expect(countsTowardFlag("target", "Order Canceled: Other")).toBe(false);
    expect(countsTowardFlag("target", "Cancelled Checkout")).toBe(false);
  });

  it("still counts a Target failure that isn't a cancellation", () => {
    expect(countsTowardFlag("target", "Payment Declined")).toBe(true);
    expect(countsTowardFlag("target", null)).toBe(true);
  });

  it("counts every failure on a retailer that names no policies, an unknown one included", () => {
    expect(countsTowardFlag("walmart", "Order Canceled: Quantity Limit")).toBe(true);
    expect(countsTowardFlag("topps", "Checkout Failed")).toBe(true);
    expect(countsTowardFlag(null, "Order Canceled: Quantity Limit")).toBe(true);
  });

  it("leaves a Target profile's Quantity Limit cancels out of its count and its last reason", () => {
    const failure = (day: number, reason: string) => ({
      vaultProfileId: "t",
      siteKey: "target",
      occurredAt: at(`2026-11-0${day}T01:00:00Z`),
      reason,
      productRaw: null,
    });
    const flags = flagsByProfile([
      failure(2, "Order Canceled: Item Demand"),
      failure(3, "Order Canceled: Quantity Limit"),
      failure(4, "Order Canceled: Quantity Limit"),
    ]);
    expect(flags.get("t")).toMatchObject({
      count: 1,
      risk: "flagged",
      lastReason: "Order Canceled: Item Demand",
    });
    // Nothing but Quantity Limit cancels: no flag at all.
    expect(flagsByProfile([failure(3, "Order Canceled: Quantity Limit")]).size).toBe(0);
  });
});

describe("riskFor", () => {
  it("flags one failure, and turns red at three", () => {
    expect(riskFor(0)).toBeNull();
    expect(riskFor(1)).toBe("flagged");
    expect(riskFor(2)).toBe("flagged");
    expect(HIGH_RISK_AT).toBe(3);
    expect(riskFor(3)).toBe("high");
    expect(riskFor(12)).toBe("high");
  });
});

describe("flagsByProfile", () => {
  it("counts per profile and keeps the latest failure's reason and product", () => {
    const flags = flagsByProfile([
      {
        vaultProfileId: "a",
        siteKey: "pokemon-center",
        occurredAt: at("2026-11-10T01:00:00Z"),
        reason: "Payment Declined",
        productRaw: null,
      },
      {
        vaultProfileId: "a",
        siteKey: "pokemon-center",
        occurredAt: at("2026-11-12T01:00:00Z"),
        reason: "**Policy - Item Demand**",
        productRaw:
          "[(10-10425-120) Pokémon TCG: Mega Evolution-Pitch Black Booster Display Box](https://www.pokemoncenter.com/product/10-10425-120)",
      },
      {
        vaultProfileId: "a",
        siteKey: "pokemon-center",
        occurredAt: at("2026-11-11T01:00:00Z"),
        reason: null,
        productRaw: null,
      },
      {
        vaultProfileId: "b",
        siteKey: "target",
        occurredAt: at("2026-11-12T05:00:00Z"),
        reason: null,
        productRaw: "95120834",
      },
    ]);

    expect(flags.get("a")).toEqual({
      count: 3,
      risk: "high",
      lastAt: at("2026-11-12T01:00:00Z"),
      lastReason: "Policy - Item Demand",
      // The same tidying the product name gets everywhere else on the site.
      lastProduct: "Mega Evolution-Pitch Black Booster Display Box",
    });
    expect(flags.get("b")).toMatchObject({ count: 1, risk: "flagged", lastReason: null });
    expect(flags.has("c")).toBe(false);
  });

  it("labels the chip by count", () => {
    expect(flagLabel({ count: 1 })).toBe("Failed checkout");
    expect(flagLabel({ count: 4 })).toBe("4 failed checkouts");
  });

  it("tidies a reason down to its words", () => {
    expect(tidyReason("  ||Cancelled   Checkout|| (Policy - Item Demand) ")).toBe(
      "Cancelled Checkout (Policy - Item Demand)",
    );
    expect(tidyReason("   ")).toBeNull();
    expect(tidyReason(null)).toBeNull();
  });
});

describe("cleanSince", () => {
  const created = at("2026-09-01T00:00:00Z");

  it("is the last change, or the creation when there has been none", () => {
    expect(cleanSince({ createdAt: created, failuresClearedAt: null })).toEqual(created);
    const changed = at("2026-11-12T00:00:00Z");
    expect(cleanSince({ createdAt: created, failuresClearedAt: changed })).toEqual(changed);
  });

  it("never goes back before the profile existed", () => {
    expect(
      cleanSince({ createdAt: created, failuresClearedAt: at("2026-08-01T00:00:00Z") }),
    ).toEqual(created);
  });
});

describe("matchFailureProfile", () => {
  const profile = (id: string, name: string) => ({ id, name });

  it("takes the one profile the name keys to, however the bot spaced it", () => {
    // Valor pads its Profile field; the underscore is markdown to the normalizer on both sides.
    expect(matchFailureProfile([profile("p1", "devin24_ - 2")], " devin24_ - 2 ")?.id).toBe("p1");
  });

  it("prefers the name exactly as printed when two profiles key alike", () => {
    // Different spellings, one key: "carter - 2" and "Carter-2" are the same name to the bot.
    const twins = [profile("p1", "carter - 2"), profile("p2", "Carter-2")];
    expect(matchFailureProfile(twins, "Carter-2")?.id).toBe("p2");
    expect(matchFailureProfile(twins, "carter - 2")?.id).toBe("p1");
  });

  it("matches nothing rather than guess between look-alikes", () => {
    const twins = [profile("p1", "carter - 2"), profile("p2", "Carter-2")];
    // Case alone is no difference -- "CARTER-2" is Carter-2 -- but a third spelling is
    // neither of them, and keys to both.
    expect(matchFailureProfile(twins, "CARTER-2")?.id).toBe("p2");
    expect(matchFailureProfile(twins, "carter -2")).toBeNull();
    expect(matchFailureProfile([], "carter - 2")).toBeNull();
  });
});

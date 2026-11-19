/**
 * The success/fail view's rules: which profile a checkout belongs to, an order shown once when it
 * was cancelled after checking out, and what the row's counts add up to. Pure; the reads behind
 * them are tested against the database in db/queries/profile-activity.test.ts.
 */
import { describe, expect, it } from "vitest";
import {
  activityEvents,
  assignCheckouts,
  summarizeActivity,
  type ActivityCheckout,
  type ActivityFailure,
} from "@/lib/vault/profile-activity";

const at = (iso: string) => new Date(iso);

function checkout(over: Partial<ActivityCheckout> = {}): ActivityCheckout {
  return {
    id: "c1",
    occurredAt: at("2026-11-05T02:00:00Z"),
    site: "Target",
    profileKey: "carter",
    profileIndex: 2,
    profileRaw: "carter - 2",
    orderId: "912000000001",
    quantity: 2,
    product: "Prismatic Evolutions Booster Bundle",
    ...over,
  };
}

function failure(over: Partial<ActivityFailure> = {}): ActivityFailure {
  return {
    id: "f1",
    occurredAt: at("2026-11-07T02:00:00Z"),
    siteKey: "target",
    orderId: null,
    reason: "Payment Declined",
    productRaw: null,
    ...over,
  };
}

const PROFILE = { siteKey: "target", name: "carter - 2", profileKey: "carter", profileIndex: 2 };

describe("assignCheckouts", () => {
  it("gives a checkout to the profile with its retailer, name and number", () => {
    const profiles = [
      { ...PROFILE, id: "target-2" },
      { ...PROFILE, id: "walmart-2", siteKey: "walmart" },
      { ...PROFILE, id: "target-3", name: "carter - 3", profileIndex: 3 },
    ];
    const assigned = assignCheckouts(
      [
        checkout({ id: "a" }),
        checkout({ id: "b", site: "Walmart" }),
        checkout({ id: "c", profileIndex: 3, profileRaw: "carter - 3" }),
        // A retailer they have no profile on, and a number they don't hold.
        checkout({ id: "d", site: "Pokemon Center US" }),
        checkout({ id: "e", profileIndex: 9, profileRaw: "carter - 9" }),
        checkout({ id: "f", profileKey: null }),
      ],
      profiles,
    );
    expect(assigned.get("target-2")?.map((c) => c.id)).toEqual(["a"]);
    expect(assigned.get("walmart-2")?.map((c) => c.id)).toEqual(["b"]);
    expect(assigned.get("target-3")?.map((c) => c.id)).toEqual(["c"]);
    expect([...assigned.values()].flat()).toHaveLength(3);
  });

  it("tells two of their names that key alike apart by the name printed, or not at all", () => {
    const twins = [
      { ...PROFILE, id: "spaced" },
      { ...PROFILE, id: "tight", name: "Carter-2" },
    ];
    const assigned = assignCheckouts(
      [
        checkout({ id: "a", profileRaw: "carter - 2" }),
        checkout({ id: "b", profileRaw: "Carter-2" }),
        checkout({ id: "c", profileRaw: "carter -2" }),
      ],
      twins,
    );
    expect(assigned.get("spaced")?.map((c) => c.id)).toEqual(["a"]);
    expect(assigned.get("tight")?.map((c) => c.id)).toEqual(["b"]);
  });
});

describe("activityEvents", () => {
  it("shows an order cancelled after checkout once, as cancelled, with its checkout's details", () => {
    const events = activityEvents(
      [
        checkout({ id: "kept", orderId: "912000000002", occurredAt: at("2026-11-04T02:00:00Z") }),
        checkout(),
      ],
      [
        failure({
          id: "cancel",
          orderId: "#912000000001",
          reason: "Order Canceled: Item Demand",
          occurredAt: at("2026-11-06T02:00:00Z"),
        }),
      ],
    );

    expect(events.map((e) => [e.id, e.kind])).toEqual([
      ["cancel", "cancelled"],
      ["kept", "checked-out"],
    ]);
    expect(events[0]).toMatchObject({
      checkedOutAt: at("2026-11-05T02:00:00Z"),
      product: "Prismatic Evolutions Booster Bundle",
      quantity: 2,
      orderId: "912000000001",
      reason: "Order Canceled: Item Demand",
      flags: true,
    });
  });

  it("keeps a cancellation with no checkout on file, and a decline, each as its own line", () => {
    const events = activityEvents(
      [],
      [
        failure({
          id: "limit",
          orderId: "912000000009",
          reason: "Order Canceled: Quantity Limit",
          productRaw: "[(10-10403-109) Pokémon TCG: Booster Bundle](https://example.com)",
        }),
        failure({ id: "declined", occurredAt: at("2026-11-08T02:00:00Z") }),
      ],
    );
    expect(events.map((e) => [e.id, e.kind])).toEqual([
      ["declined", "failed"],
      ["limit", "cancelled"],
    ]);
    // A Target Quantity Limit cancel is shown, but says it raises no flag.
    expect(events[1]).toMatchObject({
      flags: false,
      checkedOutAt: null,
      product: "Booster Bundle",
    });
    expect(events[0].flags).toBe(true);
  });

  it("doesn't pair an order number with the same one on another retailer", () => {
    const events = activityEvents(
      [checkout({ site: "Walmart" })],
      [failure({ orderId: "912000000001", reason: "Order Canceled: Reseller" })],
    );
    expect(events.map((e) => e.kind).sort()).toEqual(["cancelled", "checked-out"]);
  });

  it("leaves out a raffle entry a bot reported as a failure, and doesn't count it", () => {
    const failures = [
      failure({ id: "entered", reason: "Raffle Entered" }),
      failure({ id: "declined", occurredAt: at("2026-11-08T02:00:00Z") }),
    ];
    expect(activityEvents([], failures).map((e) => e.id)).toEqual(["declined"]);
    expect(summarizeActivity([], failures)).toMatchObject({ failed: 1 });
    expect(summarizeActivity([], [failure({ reason: "Raffle Entered" })])).toBeNull();
  });
});

describe("summarizeActivity", () => {
  it("counts what the history shows, units included", () => {
    const summary = summarizeActivity(
      [
        checkout({ id: "a", orderId: "1", quantity: 2 }),
        checkout({ id: "b", orderId: "2", quantity: 1, occurredAt: at("2026-11-09T02:00:00Z") }),
        checkout({ id: "c", orderId: "3", quantity: 4 }),
      ],
      [
        failure({ id: "x", orderId: "3", reason: "Order Canceled: Item Demand" }),
        failure({ id: "y" }),
      ],
    );
    expect(summary).toEqual({
      checkedOut: 2,
      units: 3,
      cancelled: 1,
      failed: 1,
      lastAt: at("2026-11-09T02:00:00Z"),
    });
  });

  it("is null for a profile with nothing to show", () => {
    expect(summarizeActivity([], [])).toBeNull();
  });
});

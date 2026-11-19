/**
 * The pure half of raffles: Central time both ways, what an admin types, and who a member's
 * entry enters.
 *
 * The properties with something behind them: a time typed is read as Central whatever the
 * machine's own zone, across both DST changes; a raffle is never saved with entries due before
 * it starts, or already due when it's new; and "all profiles" enters every profile the member
 * holds, including ones added later, exactly as a product pick runs on them.
 */
import { describe, expect, it } from "vitest";
import { enteredWith, rafflePhase, rafflesByProfile, toRaffleView } from "@/lib/raffles/entries";
import { parseRaffleInput, type RaffleFields } from "@/lib/raffles/raffle-input";
import { fromZonedInput, raffleTimeLabel, toZonedInput } from "@/lib/raffles/time";
import { readInstanceConfig } from "@/lib/shikari/config";

describe("raffle times", () => {
  it("reads a typed time as Central, in standard time and daylight time", () => {
    // CST is UTC-6, CDT UTC-5.
    expect(fromZonedInput("2026-11-23T23:59")?.toISOString()).toBe("2026-11-24T05:59:00.000Z");
    expect(fromZonedInput("2026-07-04T09:00")?.toISOString()).toBe("2026-07-04T14:00:00.000Z");
  });

  it("gets the days the clocks change right", () => {
    // 2026-03-08: 2:00 AM CST jumps to 3:00 AM CDT. 2026-11-01: 2:00 AM CDT falls to 1:00 CST.
    expect(fromZonedInput("2026-03-08T01:30")?.toISOString()).toBe("2026-03-08T07:30:00.000Z");
    expect(fromZonedInput("2026-03-08T03:30")?.toISOString()).toBe("2026-03-08T08:30:00.000Z");
    expect(fromZonedInput("2026-11-01T00:30")?.toISOString()).toBe("2026-11-01T05:30:00.000Z");
    expect(fromZonedInput("2026-11-01T03:00")?.toISOString()).toBe("2026-11-01T09:00:00.000Z");
  });

  it("refuses what isn't a real date and time", () => {
    for (const bad of ["", "2026-02-30T10:00", "2026-11-23", "2026-11-23T24:00", "tomorrow"]) {
      expect(fromZonedInput(bad)).toBeNull();
    }
  });

  it("puts an instant back the way it was typed, and into words", () => {
    for (const typed of ["2026-11-23T23:59", "2026-07-04T00:00", "2027-01-01T12:05"]) {
      expect(toZonedInput(fromZonedInput(typed)!)).toBe(typed);
    }
    expect(raffleTimeLabel(new Date("2026-11-24T05:59:00.000Z"))).toMatch(
      /^Mon, Nov 23, 11:59\sPM CT$/,
    );
  });
});

describe("parseRaffleInput", () => {
  const NOW = new Date("2026-11-19T18:00:00.000Z");
  const fields = (over: Partial<RaffleFields> = {}): RaffleFields => ({
    url: "https://www.target.com/p/pokemon-prismatic-evolutions-elite-trainer-box/-/A-1012850572?preselect=1#lnk=x",
    sku: "",
    name: "",
    price: "$59.99",
    imageUrl: "",
    startsAt: "2026-11-21T09:00",
    dueAt: "2026-11-23T23:59",
    ...over,
  });

  it("takes the product from its link, and the times as Central", () => {
    const parsed = parseRaffleInput(fields(), { now: NOW, isNew: true });
    expect(parsed).toEqual({
      ok: true,
      value: {
        sku: "1012850572",
        name: "Pokemon Prismatic Evolutions Elite Trainer Box",
        url: "https://www.target.com/p/pokemon-prismatic-evolutions-elite-trainer-box/-/A-1012850572?preselect=1",
        imageUrl: null,
        priceCents: 5999,
        startsAt: new Date("2026-11-21T15:00:00.000Z"),
        dueAt: new Date("2026-11-24T05:59:00.000Z"),
      },
    });
  });

  it("holds the product to a listed product's rules", () => {
    expect(
      parseRaffleInput(fields({ url: "https://example.com/x" }), { now: NOW, isNew: true }),
    ).toMatchObject({ ok: false, error: "Paste the product's target.com link." });
    expect(parseRaffleInput(fields({ sku: "123456" }), { now: NOW, isNew: true })).toMatchObject({
      ok: false,
      error: "That SKU doesn't match the link, which is A-1012850572.",
    });
  });

  it("wants both times, entries due after the start, and a new raffle still open", () => {
    const refused = (over: Partial<RaffleFields>, isNew = true) => {
      const parsed = parseRaffleInput(fields(over), { now: NOW, isNew });
      return parsed.ok ? null : parsed.error;
    };
    expect(refused({ startsAt: "" })).toBe("When does the raffle start?");
    expect(refused({ dueAt: "" })).toBe("When are entries due?");
    expect(refused({ dueAt: "2026-02-30T10:00" })).toBe(
      "That due date isn't a real date and time.",
    );
    expect(refused({ dueAt: "2026-11-21T09:00" })).toBe(
      "Entries have to be due after the raffle starts.",
    );
    expect(refused({ startsAt: "2026-11-01T09:00", dueAt: "2026-11-19T11:59" })).toBe(
      "Entries for that would already be due. Check the date.",
    );
    // An edit may close entries early.
    expect(refused({ startsAt: "2026-11-01T09:00", dueAt: "2026-11-19T11:59" }, false)).toBeNull();
  });
});

describe("raffle entries", () => {
  const raffles = [
    { id: "r1", sku: "111111" },
    { id: "r2", sku: "222222" },
  ];
  const profiles = [
    { id: "a1", discordUserId: "alice" },
    { id: "a2", discordUserId: "alice" },
    { id: "a3", discordUserId: "alice" }, // added after she entered
    { id: "b1", discordUserId: "bob" },
    { id: "c1", discordUserId: "carol" },
  ];

  it("enters every profile for all, only the listed ones for some, in raffle order", () => {
    const entered = rafflesByProfile(
      profiles,
      [
        { raffleId: "r2", discordUserId: "alice", allProfiles: true, profileIds: [] },
        { raffleId: "r1", discordUserId: "alice", allProfiles: false, profileIds: ["a2"] },
        { raffleId: "r1", discordUserId: "bob", allProfiles: false, profileIds: ["a1"] },
      ],
      raffles,
    );
    expect(Object.fromEntries(entered)).toEqual({
      a1: ["222222"],
      a2: ["111111", "222222"],
      a3: ["222222"],
      // bob's entry names a profile that isn't his: it enters nothing.
      b1: [],
      c1: [],
    });
  });

  it("enters nothing for a raffle that's gone", () => {
    const entered = rafflesByProfile(
      profiles,
      [{ raffleId: "deleted", discordUserId: "alice", allProfiles: true, profileIds: [] }],
      raffles,
    );
    expect(entered.get("a1")).toEqual([]);
  });

  it("says what an entry comes to on a past raffle: none, every profile, or the ones listed", () => {
    const mine = [
      { id: "p1", name: "carter - 1", active: true },
      { id: "p2", name: "carter - 2", active: false },
      { id: "p3", name: "carter - 3", active: true },
    ];
    expect(enteredWith(undefined, mine)).toBeNull();
    // A switched-off profile is entered in nothing, however the entry reads.
    expect(enteredWith({ all: true, profileIds: [] }, mine)).toEqual({
      all: true,
      names: ["carter - 1", "carter - 3"],
    });
    expect(enteredWith({ all: false, profileIds: ["p3", "p2"] }, mine)).toEqual({
      all: false,
      names: ["carter - 3"],
    });
    expect(enteredWith({ all: false, profileIds: ["p2"] }, mine)).toEqual({
      all: false,
      names: [],
    });
  });

  it("is upcoming until it starts, live until entries are due, then closed", () => {
    const raffle = {
      startsAt: new Date("2026-11-21T15:00:00.000Z"),
      dueAt: new Date("2026-11-24T05:59:00.000Z"),
    };
    expect(rafflePhase(raffle, new Date("2026-11-20T00:00:00.000Z"))).toBe("upcoming");
    expect(rafflePhase(raffle, new Date("2026-11-21T15:00:00.000Z"))).toBe("live");
    expect(rafflePhase(raffle, new Date("2026-11-24T05:58:59.999Z"))).toBe("live");
    expect(rafflePhase(raffle, new Date("2026-11-24T05:59:00.000Z"))).toBe("closed");
  });

  it("is put into words for the page once, on the server", () => {
    const view = toRaffleView(
      {
        id: "r1",
        sku: "1012850572",
        name: "Elite Trainer Box",
        url: "https://www.target.com/p/x/-/A-1012850572",
        imageUrl: null,
        priceCents: 5999,
        startsAt: new Date("2026-11-21T15:00:00.000Z"),
        dueAt: new Date("2026-11-24T05:59:00.000Z"),
      },
      new Date("2026-11-19T18:00:00.000Z"),
    );
    expect(view).toMatchObject({
      phase: "upcoming",
      startsInput: "2026-11-21T09:00",
      dueInput: "2026-11-23T23:59",
    });
    expect(view.dueLabel).toMatch(/^Mon, Nov 23, 11:59\sPM CT$/);
  });
});

describe("a Shikari instance's saved setup", () => {
  it("runs raffles on a setup saved before there were any, keeping its other choices", () => {
    const config = readInstanceConfig({
      memberIds: ["999900000000000501"],
      bot: "backup",
      sections: {
        profiles: true,
        accounts: true,
        imap: true,
        proxies: false,
        tasks: true,
        wipes: false,
      },
      groups: {},
    });
    expect(config.bot).toBe("backup");
    expect(config.sections).toEqual({
      profiles: true,
      accounts: true,
      imap: true,
      proxies: false,
      tasks: true,
      wipes: false,
      raffles: true,
    });
  });

  it("keeps raffles off where the operator switched them off", () => {
    const config = readInstanceConfig({
      memberIds: [],
      bot: "main",
      sections: {
        profiles: true,
        accounts: true,
        imap: true,
        proxies: true,
        tasks: true,
        wipes: true,
        raffles: false,
      },
      groups: {},
    });
    expect(config.sections.raffles).toBe(false);
  });
});

/**
 * Unit tests for the single-report analysis functions (lib/analysis/report.ts).
 * All against the plain fixture data in ./fixtures/sampleReport.ts -- no
 * network access, no mocking of `fetch`, since these functions never touch
 * the API themselves (that's the whole point of the wcl/ vs analysis/
 * split -- see the top comment in lib/analysis/report.ts).
 */
import { describe, expect, it } from "vitest";
import {
  buildDeathRecords,
  deathCauseBreakdown,
  playerDeathCounts,
  rankEntries,
  summarizeFights,
} from "@/lib/analysis/report";
import {
  sampleDamageEntries,
  sampleDeathEntries,
  sampleFights,
  sampleHealingEntries,
} from "./fixtures/sampleReport";

describe("rankEntries", () => {
  it("sorts by total descending and computes per-second rate from activeTime", () => {
    const ranked = rankEntries(sampleDamageEntries);
    expect(ranked.map((r) => r.name)).toEqual(["Alice", "Bob", "Carol"]);
    // 5,000,000 total over 300,000ms active = 300s -> 16,666.67 dps
    expect(ranked[0].perSecond).toBeCloseTo(5_000_000 / 300, 1);
  });

  it("drops zero/undefined-total entries", () => {
    const ranked = rankEntries([...sampleHealingEntries, { name: "Zero", id: 5, guid: 555, type: "Rogue", total: 0 }]);
    expect(ranked.find((r) => r.name === "Zero")).toBeUndefined();
  });

  it("attaches parsePercent by name when a ranking map is supplied, and leaves it undefined otherwise", () => {
    const withoutMap = rankEntries(sampleDamageEntries);
    expect(withoutMap.every((r) => r.parsePercent === undefined)).toBe(true);

    const parsePercentByName = new Map([["Alice", 82]]);
    const withMap = rankEntries(sampleDamageEntries, parsePercentByName);
    expect(withMap.find((r) => r.name === "Alice")?.parsePercent).toBe(82);
    // Bob has no entry in the map -- e.g. WCL didn't rank them for some
    // reason -- so their parsePercent stays undefined, not 0.
    expect(withMap.find((r) => r.name === "Bob")?.parsePercent).toBeUndefined();
  });
});

describe("buildDeathRecords", () => {
  it("attributes each death to its fight via the API's own fight ID", () => {
    const deaths = buildDeathRecords(sampleDeathEntries, sampleFights);
    expect(deaths).toHaveLength(3);

    const bob = deaths.find((d) => d.playerName === "Bob");
    expect(bob?.fightName).toBe("Ulgrax the Devourer");
    expect(bob?.fightId).toBe(2);
    expect(bob?.timeIntoFightMs).toBe(60_000); // 120_000 - fight2.startTime (60_000)

    const dave = deaths.find((d) => d.playerName === "Dave");
    expect(dave?.fightId).toBe(3);
    expect(dave?.timeIntoFightMs).toBe(40_000); // 400_000 - fight3.startTime (360_000)
  });

  // Guards against a real regression risk: if `fights` and `deaths` ever
  // come from two different requests/report codes by mistake, this is the
  // failure mode that should happen (a labeled "Unknown fight"), not a
  // thrown error or a silently wrong match.
  it("falls back gracefully when the fight ID doesn't match any known fight", () => {
    const deaths = buildDeathRecords(
      [{ name: "Ghost", id: 9, guid: 999, type: "Hunter", timestamp: 999_999, fight: 42 }],
      sampleFights
    );
    expect(deaths[0].fightId).toBe(42);
    expect(deaths[0].fightName).toBe("Unknown fight");
    expect(deaths[0].timeIntoFightMs).toBe(999_999);
  });

  it("drops deaths from trash fights (encounterID 0)", () => {
    // sampleFights[0] is the trash pull (id: 1, encounterID: 0).
    const deaths = buildDeathRecords(
      [
        { name: "Eve", id: 6, guid: 666, type: "Rogue", timestamp: 10_000, fight: 1 },
        { name: "Bob", id: 2, guid: 222, type: "Warrior", timestamp: 120_000, fight: 2 },
      ],
      sampleFights
    );
    expect(deaths).toHaveLength(1);
    expect(deaths[0].playerName).toBe("Bob");
  });

  it("stamps every death with the reportCode it was passed, when given one", () => {
    const withCode = buildDeathRecords(sampleDeathEntries, sampleFights, "AbCdEfGh");
    expect(withCode.every((d) => d.reportCode === "AbCdEfGh")).toBe(true);

    // Omitting it leaves reportCode undefined -- the single-report page
    // doesn't need it (see the guild page for why the guild page does).
    const withoutCode = buildDeathRecords(sampleDeathEntries, sampleFights);
    expect(withoutCode.every((d) => d.reportCode === undefined)).toBe(true);
  });
});

describe("deathCauseBreakdown", () => {
  it("counts deaths by killing ability, most common first", () => {
    const deaths = buildDeathRecords(sampleDeathEntries, sampleFights);
    const causes = deathCauseBreakdown(deaths);
    expect(causes[0]).toEqual({ ability: "Devour", count: 2 });
    expect(causes[1]).toEqual({ ability: "Venomous Lash", count: 1 });
  });
});

describe("playerDeathCounts", () => {
  it("counts deaths by player, carrying each player's class along", () => {
    const deaths = buildDeathRecords(sampleDeathEntries, sampleFights);
    const counts = playerDeathCounts(deaths);
    expect(counts).toHaveLength(3);
    expect(counts.find((p) => p.playerName === "Bob")).toEqual({ playerName: "Bob", className: "Warrior", count: 1 });
    expect(counts.find((p) => p.playerName === "Alice")).toEqual({ playerName: "Alice", className: "Mage", count: 1 });
  });

  it("adds up multiple deaths from the same player instead of listing them twice", () => {
    const deaths = buildDeathRecords(
      [
        { name: "Eve", id: 6, guid: 666, type: "Rogue", timestamp: 65_000, fight: 2, killingBlow: { name: "Devour", guid: 999 } },
        { name: "Eve", id: 6, guid: 666, type: "Rogue", timestamp: 70_000, fight: 2, killingBlow: { name: "Devour", guid: 999 } },
      ],
      sampleFights
    );
    const counts = playerDeathCounts(deaths);
    expect(counts).toEqual([{ playerName: "Eve", className: "Rogue", count: 2 }]);
  });
});

describe("summarizeFights", () => {
  it("counts kills/wipes and finds the closest wipe percentage", () => {
    const summary = summarizeFights(sampleFights);
    expect(summary.totalFights).toBe(3);
    expect(summary.kills).toBe(1);
    expect(summary.wipes).toBe(1);
    expect(summary.killRate).toBeCloseTo(1 / 3);
    expect(summary.bestWipePercent).toBe(12.4);
  });
});

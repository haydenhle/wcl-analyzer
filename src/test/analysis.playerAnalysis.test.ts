/**
 * Unit tests for the player-analysis pure functions (lib/analysis/playerAnalysis.ts).
 * These never touch the network -- everything here is fake table/fight data,
 * shaped like what lib/wcl/service.ts's buildPlayerAnalysis would hand them
 * after fetching from Warcraft Logs.
 */
import { describe, expect, it } from "vitest";
import {
  buildAbilityCastRates,
  buildComparisonWindow,
  buildPhaseWindows,
  buildPlayerWindowStats,
  buildRotationSuggestions,
  castsPerMinute,
  mergeAbilityComparison,
  parseClassSpecFromIcon,
} from "@/lib/analysis/playerAnalysis";
import type { AbilityComparisonRow } from "@/lib/analysis/types";
import type { WCLTableEntry } from "@/lib/wcl/types";

describe("buildPhaseWindows", () => {
  it("always puts 'the whole fight' first, as phaseId 0", () => {
    const fight = { startTime: 1_000, endTime: 5_000, phaseTransitions: [] };
    const windows = buildPhaseWindows(fight);
    expect(windows).toEqual([{ key: "whole", phaseId: 0, label: "Whole fight", startTime: 1_000, endTime: 5_000 }]);
  });

  it("derives each phase's end from the NEXT phase's start, and the last phase's end from the fight's own end", () => {
    const fight = {
      startTime: 0,
      endTime: 9_000,
      phaseTransitions: [
        { id: 1, startTime: 0 },
        { id: 2, startTime: 3_000 },
        { id: 3, startTime: 6_000 },
      ],
    };
    const windows = buildPhaseWindows(fight);
    expect(windows).toEqual([
      { key: "whole", phaseId: 0, label: "Whole fight", startTime: 0, endTime: 9_000 },
      { key: "1#1", phaseId: 1, label: "Phase 1", startTime: 0, endTime: 3_000 },
      { key: "2#1", phaseId: 2, label: "Phase 2", startTime: 3_000, endTime: 6_000 },
      { key: "3#1", phaseId: 3, label: "Phase 3", startTime: 6_000, endTime: 9_000 },
    ]);
  });

  it("sorts out-of-order phase transitions before deriving windows", () => {
    const fight = {
      startTime: 0,
      endTime: 6_000,
      phaseTransitions: [
        { id: 2, startTime: 3_000 },
        { id: 1, startTime: 0 },
      ],
    };
    const windows = buildPhaseWindows(fight);
    expect(windows.map((w) => w.phaseId)).toEqual([0, 1, 2]);
    expect(windows[1]).toEqual({ key: "1#1", phaseId: 1, label: "Phase 1", startTime: 0, endTime: 3_000 });
  });

  // Regression: a boss that goes back into an earlier phase (P1 -> P2 -> P1)
  // reports the same phase id twice. Those used to share an identity, so
  // the second window's data overwrote the first's and React warned about
  // duplicate keys on the phase toggle buttons.
  it("gives a repeated phase its own unique key and a numbered label", () => {
    const fight = {
      startTime: 0,
      endTime: 9_000,
      phaseTransitions: [
        { id: 1, startTime: 0 },
        { id: 2, startTime: 3_000 },
        { id: 1, startTime: 6_000 },
      ],
    };
    const windows = buildPhaseWindows(fight);
    expect(windows.map((w) => w.key)).toEqual(["whole", "1#1", "2#1", "1#2"]);
    expect(windows.map((w) => w.label)).toEqual(["Whole fight", "Phase 1 (1)", "Phase 2", "Phase 1 (2)"]);
    expect(new Set(windows.map((w) => w.key)).size).toBe(windows.length);
    expect(windows[3]).toEqual({ key: "1#2", phaseId: 1, label: "Phase 1 (2)", startTime: 6_000, endTime: 9_000 });
  });
});

describe("castsPerMinute", () => {
  it("converts a cast count over a millisecond window into casts/minute", () => {
    expect(castsPerMinute(30, 60_000)).toBe(30); // 30 casts in exactly one minute
    expect(castsPerMinute(15, 30_000)).toBe(30); // 15 casts in half a minute -> 30/min
  });

  it("returns 0 instead of dividing by zero for a zero or negative window", () => {
    expect(castsPerMinute(10, 0)).toBe(0);
    expect(castsPerMinute(10, -1)).toBe(0);
  });
});

describe("buildAbilityCastRates", () => {
  it("sorts most-cast-first and computes each ability's rate", () => {
    const abilities = [
      { guid: 1, name: "Mind Blast", total: 10 },
      { guid: 2, name: "Mind Flay", total: 30 },
      { guid: 3, name: "Shadow Word: Death", total: 20 },
    ];
    const rates = buildAbilityCastRates(abilities, 60_000);
    expect(rates.map((r) => r.name)).toEqual(["Mind Flay", "Shadow Word: Death", "Mind Blast"]);
    expect(rates[0]).toEqual({ guid: 2, name: "Mind Flay", casts: 30, castsPerMinute: 30 });
  });

  it("returns an empty list instead of throwing when abilities is undefined", () => {
    expect(buildAbilityCastRates(undefined, 60_000)).toEqual([]);
  });
});

describe("buildPlayerWindowStats", () => {
  const castsEntry: WCLTableEntry = {
    name: "Testpriest",
    id: 1,
    guid: 100,
    type: "Priest",
    total: 12,
    abilities: [{ guid: 1, name: "Mind Blast", total: 12 }],
  };
  const throughputEntry: WCLTableEntry = {
    name: "Testpriest",
    id: 1,
    guid: 100,
    type: "Priest",
    total: 60_000, // e.g. 60,000 healing done
  };

  it("combines a Casts entry and a throughput entry into one window's stats", () => {
    const stats = buildPlayerWindowStats(castsEntry, throughputEntry, 60_000);
    expect(stats.totalCasts).toBe(12);
    expect(stats.castsPerMinute).toBe(12);
    expect(stats.throughputPerSecond).toBe(1_000); // 60,000 over 60 seconds
    expect(stats.abilities).toHaveLength(1);
  });

  it("zeroes out instead of throwing when either entry is missing", () => {
    expect(buildPlayerWindowStats(undefined, undefined, 60_000)).toEqual({
      totalCasts: 0,
      castsPerMinute: 0,
      throughputPerSecond: 0,
      abilities: [],
    });
  });
});

describe("buildComparisonWindow", () => {
  it("builds both sides from a window's bounds, defaulting a missing side to zeros", () => {
    const window = { key: "1#1", phaseId: 1, label: "Phase 1", startTime: 0, endTime: 60_000 };
    const playerCasts: WCLTableEntry = { name: "Me", id: 1, guid: 1, type: "Priest", total: 30 };
    const result = buildComparisonWindow(window, playerCasts, undefined, undefined, undefined);
    expect(result.phaseId).toBe(1);
    expect(result.player.totalCasts).toBe(30);
    expect(result.player.castsPerMinute).toBe(30);
    expect(result.topLog).toEqual({ totalCasts: 0, castsPerMinute: 0, throughputPerSecond: 0, abilities: [] });
  });

  // Regression, with the real numbers that exposed it: a 5:09 kill compared
  // against a top log's 4:22 kill (289,927.6 DPS on Warcraft Logs). Dividing
  // the top log's damage by THIS pull's 309s showed it as 245.8K.
  it("divides the top log's totals by the top log's own duration, not this pull's", () => {
    const window = { key: "whole", phaseId: 0, label: "Whole fight", startTime: 0, endTime: 309_000 };
    const mine: WCLTableEntry = { name: "Dreamsweet", id: 1, guid: 1, type: "Evoker", total: 267_502.4 * 309 };
    const topThroughput: WCLTableEntry = { name: "Top", id: 2, guid: 2, type: "Evoker", total: 289_927.6 * 262 };
    const topCasts: WCLTableEntry = { name: "Top", id: 2, guid: 2, type: "Evoker", total: 242 };
    const result = buildComparisonWindow(window, undefined, mine, topCasts, topThroughput, 262_000);
    expect(result.player.throughputPerSecond).toBeCloseTo(267_502.4);
    expect(result.topLog.throughputPerSecond).toBeCloseTo(289_927.6);
    expect(result.topLog.castsPerMinute).toBeCloseTo(242 / (262 / 60));
  });
});

describe("mergeAbilityComparison", () => {
  it("lines up matching abilities by guid, and sorts by the top log's rate", () => {
    const playerAbilities = [
      { guid: 1, name: "Mind Blast", casts: 6, castsPerMinute: 6 },
      { guid: 2, name: "Mind Flay", casts: 10, castsPerMinute: 10 },
    ];
    const topLogAbilities = [
      { guid: 2, name: "Mind Flay", casts: 8, castsPerMinute: 8 },
      { guid: 1, name: "Mind Blast", casts: 12, castsPerMinute: 12 },
    ];
    const rows = mergeAbilityComparison(playerAbilities, topLogAbilities);
    expect(rows).toEqual([
      { guid: 1, name: "Mind Blast", playerCastsPerMinute: 6, topLogCastsPerMinute: 12 },
      { guid: 2, name: "Mind Flay", playerCastsPerMinute: 10, topLogCastsPerMinute: 8 },
    ]);
  });

  it("still produces a row (with a 0 on the other side) for an ability only one side cast", () => {
    const playerOnly = [{ guid: 1, name: "Shadow Word: Death", casts: 4, castsPerMinute: 4 }];
    const topLogOnly = [{ guid: 2, name: "Void Bolt", casts: 5, castsPerMinute: 5 }];
    const rows = mergeAbilityComparison(playerOnly, topLogOnly);
    expect(rows).toContainEqual({ guid: 1, name: "Shadow Word: Death", playerCastsPerMinute: 4, topLogCastsPerMinute: 0 });
    expect(rows).toContainEqual({ guid: 2, name: "Void Bolt", playerCastsPerMinute: 0, topLogCastsPerMinute: 5 });
  });
});

describe("buildRotationSuggestions", () => {
  const rows: AbilityComparisonRow[] = [
    { guid: 1, name: "Big gap", playerCastsPerMinute: 1, topLogCastsPerMinute: 5 }, // delta 4
    { guid: 2, name: "Tiny gap", playerCastsPerMinute: 4.9, topLogCastsPerMinute: 5 }, // delta 0.1, below the noise floor
    { guid: 3, name: "You cast it more", playerCastsPerMinute: 6, topLogCastsPerMinute: 2 }, // negative delta
    { guid: 4, name: "Medium gap", playerCastsPerMinute: 2, topLogCastsPerMinute: 3 }, // delta 1
  ];

  it("only surfaces abilities the top log casts noticeably more often, biggest gap first", () => {
    const suggestions = buildRotationSuggestions(rows);
    expect(suggestions.map((s) => s.name)).toEqual(["Big gap", "Medium gap"]);
    expect(suggestions[0]).toEqual({
      guid: 1,
      name: "Big gap",
      playerCastsPerMinute: 1,
      topLogCastsPerMinute: 5,
      deltaCastsPerMinute: 4,
    });
  });

  it("never suggests casting something LESS (only ever the one direction)", () => {
    const suggestions = buildRotationSuggestions(rows);
    expect(suggestions.find((s) => s.name === "You cast it more")).toBeUndefined();
  });

  it("caps the list instead of returning every gap", () => {
    const manyRows: AbilityComparisonRow[] = Array.from({ length: 10 }, (_, i) => ({
      guid: i,
      name: `Ability ${i}`,
      playerCastsPerMinute: 0,
      topLogCastsPerMinute: 10 - i, // every one clears the noise floor
    }));
    expect(buildRotationSuggestions(manyRows)).toHaveLength(5);
  });
});

describe("parseClassSpecFromIcon", () => {
  it("splits a real Warcraft Logs icon string into class + spec", () => {
    expect(parseClassSpecFromIcon("Priest-Shadow")).toEqual({ className: "Priest", specName: "Shadow" });
    expect(parseClassSpecFromIcon("DemonHunter-Vengeance")).toEqual({
      className: "DemonHunter",
      specName: "Vengeance",
    });
  });

  it("returns null instead of throwing for a missing or malformed icon", () => {
    expect(parseClassSpecFromIcon(undefined)).toBeNull();
    expect(parseClassSpecFromIcon("")).toBeNull();
    expect(parseClassSpecFromIcon("NoDashHere")).toBeNull();
  });
});

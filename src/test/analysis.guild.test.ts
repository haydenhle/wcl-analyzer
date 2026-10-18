/**
 * Unit tests for the guild trend aggregation (lib/analysis/guild.ts).
 * Builds several "raid nights" out of the same single-report fixture data
 * (see ./fixtures/sampleReport.ts) via `makeNight` below, then checks that
 * aggregating them produces the right sort order, per-night stats, and
 * cross-night totals -- including merging same-session reports together
 * (see groupIntoSessions's own tests further down).
 */
import { describe, expect, it } from "vitest";
import { buildDeathRecords } from "@/lib/analysis/report";
import {
  SESSION_GAP_MS,
  aggregateGuildTrend,
  filterNightToMythic,
  groupIntoSessions,
  matchesTierZone,
  takeMostRecentSessions,
} from "@/lib/analysis/guild";
import type { GuildNightInput, GuildNightSummary } from "@/lib/analysis/types";
import type { WCLFight } from "@/lib/wcl/types";
import { sampleDeathEntries, sampleFights } from "./fixtures/sampleReport";

// The zone's own "Mythic" id for these tests -- filterNightToMythic takes
// this as a parameter rather than assuming a fixed number, since a
// different raid tier's zone can use a different id (see
// lib/wowDifficulty.ts).
const MYTHIC_ID = 5;

// Comfortably clear of SESSION_GAP_MS (4 hours) in either direction, so
// tests can be explicit about whether two nights are meant to merge or not
// without tiptoeing around the exact threshold.
const A_DAY_MS = 24 * 60 * 60 * 1000;
const HALF_HOUR_MS = 30 * 60 * 1000;

// One realistic raid night's raw data (one report), with sensible defaults
// so each test only has to override the field(s) it actually cares about
// (code/startTime, mostly, to control ordering and session grouping).
// `endTime` defaults to a 3-hour raid, computed off whatever `startTime`
// ends up being (from an override or the default), not a fixed number --
// otherwise overriding startTime alone would leave a stale default endTime.
function makeNight(overrides: Partial<GuildNightInput>): GuildNightInput {
  const startTime = overrides.startTime ?? Date.now();
  return {
    code: "code1",
    title: "Night 1",
    startTime,
    endTime: startTime + 3 * 60 * 60_000,
    zoneName: "Nerub-ar Palace",
    fights: sampleFights,
    deaths: buildDeathRecords(sampleDeathEntries, sampleFights),
    ...overrides,
  };
}

describe("groupIntoSessions", () => {
  it("merges items whose gap is within the threshold", () => {
    const a = { startTime: 0, endTime: 100 };
    const b = { startTime: 150, endTime: 250 }; // gap from a's end: 50
    const groups = groupIntoSessions([a, b], 100);
    expect(groups).toEqual([[a, b]]);
  });

  it("keeps items apart when the gap exceeds the threshold", () => {
    const a = { startTime: 0, endTime: 100 };
    const b = { startTime: 500, endTime: 600 }; // gap from a's end: 400
    const groups = groupIntoSessions([a, b], 100);
    expect(groups).toEqual([[a], [b]]);
  });

  it("sorts unsorted input before grouping, regardless of input order", () => {
    const a = { startTime: 0, endTime: 100 };
    const b = { startTime: 150, endTime: 250 };
    expect(groupIntoSessions([b, a], 100)).toEqual([[a, b]]);
  });

  it("chains a group's end forward -- a 3rd item close to the 2nd still joins, even if far from the 1st", () => {
    const a = { startTime: 0, endTime: 50 };
    const b = { startTime: 100, endTime: 300 }; // gap from a: 50, merges
    const c = { startTime: 350, endTime: 400 }; // gap from b's end (300): 50, merges
    const groups = groupIntoSessions([a, b, c], 100);
    expect(groups).toEqual([[a, b, c]]);
  });

  it("handles an empty list and a single item without throwing", () => {
    expect(groupIntoSessions([], 100)).toEqual([]);
    const only = { startTime: 0, endTime: 10 };
    expect(groupIntoSessions([only], 100)).toEqual([[only]]);
  });
});

describe("takeMostRecentSessions", () => {
  // Five separate sessions, a day apart, each with 3 items -- close enough
  // together within a session to model a guild that splits every raid
  // across a few logs (exactly what triggered the real-world bug this
  // guards: a single fixed-size page of reports easily contains more
  // sessions than were actually asked for, and trimming has to cut whole
  // sessions, not just however many raw items happen to add up to N).
  function makeSessions(count: number) {
    const items: { startTime: number; endTime: number }[] = [];
    for (let s = 0; s < count; s++) {
      const base = s * A_DAY_MS;
      items.push(
        { startTime: base, endTime: base + 1000 },
        { startTime: base + 2000, endTime: base + 3000 },
        { startTime: base + 4000, endTime: base + 5000 }
      );
    }
    return items;
  }

  it("keeps only the most recent N sessions' worth of items, not just N items", () => {
    const items = makeSessions(5); // 5 sessions x 3 items = 15 items
    const kept = takeMostRecentSessions(items, SESSION_GAP_MS, 2);
    // The 2 most recent sessions are sessions 3 and 4 (0-indexed) -> 6 items,
    // not 2 -- trimming by session, not by raw item count, is the whole point.
    expect(kept).toHaveLength(6);
    const keptStarts = kept.map((i) => i.startTime).sort((a, b) => a - b);
    expect(keptStarts).toEqual([3 * A_DAY_MS, 3 * A_DAY_MS + 2000, 3 * A_DAY_MS + 4000, 4 * A_DAY_MS, 4 * A_DAY_MS + 2000, 4 * A_DAY_MS + 4000]);
  });

  it("returns everything when there are fewer sessions than requested", () => {
    const items = makeSessions(2);
    expect(takeMostRecentSessions(items, SESSION_GAP_MS, 8)).toHaveLength(6);
  });

  it("never splits one session's items across the trim boundary", () => {
    // One single session with 5 items -- asking for "the most recent 1
    // session" should keep all 5, not cut it down to fewer.
    const oneSession = [
      { startTime: 0, endTime: 100 },
      { startTime: 200, endTime: 300 },
      { startTime: 400, endTime: 500 },
      { startTime: 600, endTime: 700 },
      { startTime: 800, endTime: 900 },
    ];
    expect(takeMostRecentSessions(oneSession, SESSION_GAP_MS, 1)).toHaveLength(5);
  });
});

describe("aggregateGuildTrend", () => {
  it("sorts nights chronologically ascending", () => {
    const older = makeNight({ code: "old", startTime: 0 });
    const newer = makeNight({ code: "new", startTime: A_DAY_MS });
    const trend = aggregateGuildTrend([newer, older]);
    expect(trend.nights.map((n) => n.reports[0]?.code)).toEqual(["old", "new"]);
  });

  it("computes kill rate and death count per night", () => {
    const trend = aggregateGuildTrend([makeNight({ code: "n1" })]);
    const night = trend.nights[0]!;
    expect(night.reports).toEqual([{ code: "n1", title: "Night 1", counted: true, excludedFights: 0 }]);
    // sampleFights: 1 kill, 1 wipe (trash fight has kill:null, excluded from both)
    expect(night.kills).toBe(1);
    expect(night.wipes).toBe(1);
    expect(night.deathCount).toBe(3);
    expect(trend.killRateOverTime[0]!.value).toBeCloseTo(0.5);
    expect(trend.deathsOverTime[0]!.value).toBe(3);
  });

  it("aggregates top death causes across all nights", () => {
    const trend = aggregateGuildTrend([
      makeNight({ code: "n1", startTime: 0 }),
      makeNight({ code: "n2", startTime: A_DAY_MS }),
    ]);
    const devour = trend.topDeathCausesOverall.find((c) => c.ability === "Devour");
    // 2 Devour deaths per night x 2 nights
    expect(devour?.count).toBe(4);
  });

  it("also returns the raw pooled deaths, not just the summarized causes", () => {
    const trend = aggregateGuildTrend([
      makeNight({ code: "n1", startTime: 0 }),
      makeNight({ code: "n2", startTime: A_DAY_MS }),
    ]);
    // 3 deaths per night (see sampleDeathEntries) x 2 nights
    expect(trend.deaths).toHaveLength(6);
  });

  it("merges reports from the same raid session into ONE night, with combined totals", () => {
    const first = makeNight({ code: "split1", title: "Log part 1", startTime: 0 });
    // Starts half an hour after the first report's (3-hour) end -- well
    // within SESSION_GAP_MS -- like a crash/relog splitting one raid into
    // two logs.
    const second = makeNight({
      code: "split2",
      title: "Log part 2",
      startTime: first.endTime + HALF_HOUR_MS,
    });
    const trend = aggregateGuildTrend([first, second]);

    expect(trend.nights).toHaveLength(1);
    const night = trend.nights[0]!;
    expect(night.reports).toEqual([
      { code: "split1", title: "Log part 1", counted: true, excludedFights: 0 },
      { code: "split2", title: "Log part 2", counted: true, excludedFights: 0 },
    ]);
    // Combined across both reports: 2x the kills/wipes/deaths of one.
    expect(night.kills).toBe(2);
    expect(night.wipes).toBe(2);
    expect(night.deathCount).toBe(6);
    // Only one point on the trend charts for this merged night, not two.
    expect(trend.killRateOverTime).toHaveLength(1);
    expect(trend.deathsOverTime).toHaveLength(1);
  });

  it("does NOT double-count when two reports fully OVERLAP in time (two people logging the same raid)", () => {
    // Both reports use the exact same relative fight timestamps AND the
    // exact same startTime, so every one of loggerA's pulls lands on the
    // exact same absolute window as the matching pull in loggerB -- what
    // two simultaneous loggers recording the same raid looks like: not
    // just "close in time", but every individual pull duplicated.
    const loggerA = makeNight({ code: "loggerA", title: "Logger A's copy", startTime: 0 });
    const loggerB = makeNight({ code: "loggerB", title: "Logger B's copy", startTime: 0 });
    const trend = aggregateGuildTrend([loggerA, loggerB]);

    expect(trend.nights).toHaveLength(1);
    const night = trend.nights[0]!;
    // Still ONE real kill, ONE real wipe, THREE real deaths -- not double,
    // even though two reports both "saw" them.
    expect(night.kills).toBe(1);
    expect(night.wipes).toBe(1);
    expect(night.deathCount).toBe(3);
    // Both reports are still listed (and still linkable). Every pull was a
    // duplicate of the other report's, so exactly one report ends up fully
    // counted and the other ends up fully excluded (not a partial overlap).
    expect(night.reports).toHaveLength(2);
    const counted = night.reports.filter((r) => r.counted);
    const notCounted = night.reports.filter((r) => !r.counted);
    expect(counted).toHaveLength(1);
    expect(counted[0]!.excludedFights).toBe(0);
    expect(notCounted).toHaveLength(1);
    expect(notCounted[0]!.excludedFights).toBe(sampleFights.length);
    // The guild-wide pooled deaths (topDeathCausesOverall / trend.deaths)
    // use the same dedup -- 3 deaths total, not 6.
    expect(trend.deaths).toHaveLength(3);
  });

  it("only excludes the PULLS that actually overlap when a report partially overlaps another, within the same real night", () => {
    // Both reports' pulls are only minutes apart overall (unlike the test
    // below, which spreads them across a real day-sized gap), so this
    // still merges into a single night row -- it's here to check that a
    // partial overlap within one real night excludes only the duplicated
    // pull, not the whole report, the same thing report-level dedup used
    // to get wrong.
    const nightOneTrashPull = sampleFights[0]!; // kill: null, no deaths tied to it -- keeps this fixture simple
    // Report A: a full, normal raid night (sampleFights, abs 0-660_000),
    // PLUS one extra pull at the very end that's actually the first pull
    // of night two, because this logger's file never stopped recording.
    const overlappingTailPull: WCLFight = {
      ...nightOneTrashPull,
      id: 4,
      startTime: 700_000,
      endTime: 760_000,
    };
    const longRunningReport = makeNight({
      code: "long",
      title: "Never stopped logging",
      startTime: 0,
      endTime: 760_000,
      fights: [...sampleFights, overlappingTailPull],
      deaths: buildDeathRecords(sampleDeathEntries, sampleFights),
    });
    // Report B: a fresh, properly-scoped report for night two, started
    // right at 700_000ms -- its very first pull (relative startTime: 0)
    // lands on the exact same absolute window as longRunningReport's tail
    // pull above (700_000-760_000).
    const freshReport = makeNight({
      code: "fresh",
      title: "Night two's own report",
      startTime: 700_000,
      fights: sampleFights,
      deaths: buildDeathRecords(sampleDeathEntries, sampleFights),
    });

    const trend = aggregateGuildTrend([longRunningReport, freshReport]);

    expect(trend.nights).toHaveLength(1);
    const night = trend.nights[0]!;
    // Two real, distinct boss attempts worth of kills/wipes -- one from
    // each report's own unique content -- not one report's worth (the old,
    // whole-report-dedup bug) and not doubled either.
    expect(night.kills).toBe(2);
    expect(night.wipes).toBe(2);
    expect(night.deathCount).toBe(6);

    const long = night.reports.find((r) => r.code === "long")!;
    const fresh = night.reports.find((r) => r.code === "fresh")!;
    // The long-running report's own copy of the shared pull won the tie
    // (it was seen first), so none of ITS pulls were excluded...
    expect(long.counted).toBe(true);
    expect(long.excludedFights).toBe(0);
    // ...but the fresh report's first pull -- the duplicate of that same
    // moment -- was excluded. It's a PARTIAL overlap: still counted
    // overall (2 of its 3 pulls are unique), just not struck through as a
    // full duplicate.
    expect(fresh.counted).toBe(true);
    expect(fresh.excludedFights).toBe(1);
  });

  it("splits into TWO real nights when a report's envelope reaches into a different real night (the actual '9/23 vs 9/24' bug)", () => {
    // This is the exact shape of the real bug: a logger's combat log kept
    // running for ~20 hours between two actual raid nights, so their
    // report's own early pulls (night one, a normal ~11-minute test raid
    // here) are hours away from its own tail pull -- which happens to be
    // the exact same moment as a second, freshly-started report's first
    // pull (night two). Grouping by REPORT ENVELOPE would merge these (the
    // long report's stated end time reaches right up to the tail pull, and
    // the fresh report starts at that same moment) -- but grouping by
    // actual pull gaps should correctly split them into two real nights,
    // ~20 hours apart, with the long report contributing to BOTH.
    const TAIL_START = 20 * 60 * 60 * 1000; // 20 hours after the long report's own first pull -- comfortably more than SESSION_GAP_MS (4h) away from its own early content
    const nightOneTrashPull = sampleFights[0]!;
    const overlappingTailPull: WCLFight = {
      ...nightOneTrashPull,
      id: 4,
      startTime: TAIL_START,
      endTime: TAIL_START + 60_000,
    };
    const longRunningReport = makeNight({
      code: "long",
      title: "Never stopped logging",
      startTime: 0,
      endTime: TAIL_START + 60_000,
      fights: [...sampleFights, overlappingTailPull],
      deaths: buildDeathRecords(sampleDeathEntries, sampleFights),
    });
    // Starts at the exact same absolute moment as longRunningReport's tail
    // pull -- envelope-wise this looks like it starts as soon as (or even
    // before) the long report "ends", well within SESSION_GAP_MS of it.
    const freshReport = makeNight({
      code: "fresh",
      title: "Night two's own report",
      startTime: TAIL_START,
      fights: sampleFights,
      deaths: buildDeathRecords(sampleDeathEntries, sampleFights),
    });

    const trend = aggregateGuildTrend([longRunningReport, freshReport]);

    // Two real nights, not one -- the whole point of this fix.
    expect(trend.nights).toHaveLength(2);
    const [nightOne, nightTwo] = trend.nights as [GuildNightSummary, GuildNightSummary];

    // Night one is JUST the long report's own early, unique content.
    expect(nightOne.reports).toEqual([{ code: "long", title: "Never stopped logging", counted: true, excludedFights: 0 }]);
    expect(nightOne.kills).toBe(1);
    expect(nightOne.wipes).toBe(1);
    expect(nightOne.deathCount).toBe(3);

    // Night two combines the long report's tail pull with the fresh
    // report's own content -- the long report shows up here TOO (a report
    // can now legitimately contribute to more than one real night row).
    const long = nightTwo.reports.find((r) => r.code === "long")!;
    const fresh = nightTwo.reports.find((r) => r.code === "fresh")!;
    expect(long.counted).toBe(true);
    expect(long.excludedFights).toBe(0); // its only pull assigned to THIS night (the tail pull) won the dedup tie
    expect(fresh.counted).toBe(true);
    expect(fresh.excludedFights).toBe(1); // its first pull was the duplicate of the long report's tail pull
    expect(nightTwo.kills).toBe(1);
    expect(nightTwo.wipes).toBe(1);
    expect(nightTwo.deathCount).toBe(3);
  });

  it("counts every report in full when none of a session's reports overlap each other", () => {
    // Three genuinely sequential chunks (a raid split into thirds, each
    // starting right as the last one ends) -- none of them overlap another,
    // so every one of them should be counted in full, same as the 2-report
    // sequential-split test above.
    const part1 = makeNight({ code: "p1", startTime: 0 });
    const part2 = makeNight({ code: "p2", startTime: part1.endTime });
    const part3 = makeNight({ code: "p3", startTime: part2.endTime });
    const trend = aggregateGuildTrend([part1, part2, part3]);

    expect(trend.nights).toHaveLength(1);
    const night = trend.nights[0]!;
    expect(night.reports.every((r) => r.counted)).toBe(true);
    expect(night.kills).toBe(3);
    expect(night.deathCount).toBe(9);
  });

  it("does NOT merge two reports on genuinely different raid nights, even a day apart", () => {
    const trend = aggregateGuildTrend([
      makeNight({ code: "n1", startTime: 0 }),
      makeNight({ code: "n2", startTime: A_DAY_MS }),
    ]);
    expect(trend.nights).toHaveLength(2);
    expect(trend.nights.map((n) => n.reports.length)).toEqual([1, 1]);
  });

  it("SESSION_GAP_MS is a positive, sane threshold (hours, not days or milliseconds)", () => {
    expect(SESSION_GAP_MS).toBeGreaterThan(0);
    expect(SESSION_GAP_MS).toBeLessThan(A_DAY_MS);
  });

  describe("maxNights", () => {
    // Five separate real nights, a day apart -- this is the "N nights"
    // sample mode's own trim, now applied to the REAL, fight-derived night
    // count instead of the report-envelope approximation
    // collectRecentSessionReports (service.ts) used to decide how much to
    // fetch. That earlier step can only ever over-fetch, never
    // under-fetch (see takeMostRecentSessions above) -- this is what
    // brings it back down to exactly what was asked for.
    function makeFiveNights() {
      return [0, 1, 2, 3, 4].map((i) => makeNight({ code: `n${i}`, startTime: i * A_DAY_MS }));
    }

    it("keeps only the most recent N real nights when maxNights is given", () => {
      const trend = aggregateGuildTrend(makeFiveNights(), { maxNights: 2 });
      expect(trend.nights).toHaveLength(2);
      expect(trend.nights.map((n) => n.reports[0]?.code)).toEqual(["n3", "n4"]);
    });

    it("keeps everything when maxNights is omitted (the 'whole tier' sample mode)", () => {
      const trend = aggregateGuildTrend(makeFiveNights());
      expect(trend.nights).toHaveLength(5);
    });

    it("keeps everything when there are fewer real nights than maxNights asks for", () => {
      const trend = aggregateGuildTrend(makeFiveNights(), { maxNights: 8 });
      expect(trend.nights).toHaveLength(5);
    });

    it("derives the trend charts and pooled deaths from only the KEPT nights, not the full sample", () => {
      const trend = aggregateGuildTrend(makeFiveNights(), { maxNights: 2 });
      // One point per KEPT night, not per fetched night.
      expect(trend.killRateOverTime).toHaveLength(2);
      expect(trend.deathsOverTime).toHaveLength(2);
      // 3 deaths per night (see sampleDeathEntries) x 2 KEPT nights, not 5.
      expect(trend.deaths).toHaveLength(6);
    });
  });
});

describe("filterNightToMythic", () => {
  // A night with one Normal-difficulty kill and one Mythic-difficulty kill
  // -- a death in each -- to check that both `fights` and `deaths` get
  // narrowed down together, not just one or the other.
  const normalFight = { id: 10, name: "Boss", startTime: 0, endTime: 100, kill: true, difficulty: 3, encounterID: 1, bossPercentage: 0, fightPercentage: 0, size: 20, phaseTransitions: [] };
  const mythicFight = { id: 11, name: "Boss", startTime: 100, endTime: 200, kill: true, difficulty: MYTHIC_ID, encounterID: 1, bossPercentage: 0, fightPercentage: 0, size: 20, phaseTransitions: [] };
  const night: GuildNightInput = {
    code: "n1",
    title: "Night 1",
    startTime: 1,
    endTime: 200,
    zoneName: "Test Zone",
    fights: [normalFight, mythicFight],
    deaths: [
      { fightId: normalFight.id, fightName: "Boss", timeIntoFightMs: 10, playerName: "Alice", className: "Mage", killingAbility: "Fireball", overkill: 0 },
      { fightId: mythicFight.id, fightName: "Boss", timeIntoFightMs: 10, playerName: "Bob", className: "Warrior", killingAbility: "Cleave", overkill: 0 },
    ],
  };

  it("keeps only the Mythic fight and only the death that happened in it", () => {
    const filtered = filterNightToMythic(night, MYTHIC_ID);
    expect(filtered.fights.map((f) => f.id)).toEqual([mythicFight.id]);
    expect(filtered.deaths.map((d) => d.playerName)).toEqual(["Bob"]);
  });

  it("leaves every other field on the night untouched", () => {
    const filtered = filterNightToMythic(night, MYTHIC_ID);
    expect(filtered.code).toBe(night.code);
    expect(filtered.title).toBe(night.title);
    expect(filtered.zoneName).toBe(night.zoneName);
    expect(filtered.endTime).toBe(night.endTime);
  });

  it("ignores a fight at the Mythic id that isn't 20-player (e.g. a Mythic+ dungeon pull)", () => {
    const dungeonPull = { ...mythicFight, id: 12, size: 5 };
    const mixedNight: GuildNightInput = { ...night, fights: [normalFight, dungeonPull] };
    const filtered = filterNightToMythic(mixedNight, MYTHIC_ID);
    expect(filtered.fights).toHaveLength(0);
  });
});

describe("matchesTierZone", () => {
  it("matches a report in the same zone and rejects one in a different zone", () => {
    const raidReport = { zone: { name: "The Venomous Abyss" } };
    const dungeonReport = { zone: { name: "Mythic+ Season 2" } };
    expect(matchesTierZone(raidReport, "The Venomous Abyss")).toBe(true);
    expect(matchesTierZone(dungeonReport, "The Venomous Abyss")).toBe(false);
  });

  it("rejects a report with no zone at all", () => {
    expect(matchesTierZone({ zone: null }, "The Venomous Abyss")).toBe(false);
  });
});

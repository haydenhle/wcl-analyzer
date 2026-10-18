/**
 * This file's job: combine several raid nights' worth of already-processed
 * data (each night has already been run through report.ts) into the trend
 * data the guild dashboard charts show -- things like kill rate over time
 * and deaths per night across multiple logs.
 *
 * This file does NOT talk to the internet either. Like report.ts, it just
 * takes data that was already fetched and reshapes/combines it. See
 * src/test/analysis.guild.test.ts for tests that feed it fake nights.
 */
import { deathCauseBreakdown, summarizeFights } from "./report";
import type { DeathRecord, GuildNightInput, GuildNightSummary, GuildTrendSummary } from "./types";
import type { WCLFight } from "@/lib/wcl/types";
import { isMythicFight } from "@/lib/wowDifficulty";

/**
 * Narrows one raid night down to just its Mythic-difficulty pulls -- used
 * by the guild page's "Mythic only" toggle. Deaths get filtered right
 * alongside the fights, so a death that happened during a Normal/Heroic
 * pull doesn't leak into a "Mythic only" view.
 *
 * `mythicDifficultyId` is THIS NIGHT'S OWN zone's "Mythic" id, not a fixed
 * number -- see lib/wowDifficulty.ts for why that has to be looked up per
 * zone instead of assumed.
 */
export function filterNightToMythic(night: GuildNightInput, mythicDifficultyId: number): GuildNightInput {
  const fights = night.fights.filter((f) => isMythicFight(f, mythicDifficultyId));
  const mythicFightIds = new Set(fights.map((f) => f.id));
  return {
    ...night,
    fights,
    deaths: night.deaths.filter((d) => mythicFightIds.has(d.fightId)),
  };
}

// How much of a gap still counts as "the same raid session" -- e.g. a
// crash/relog, or swapping loggers partway through, splits one real raid
// night into two or more separate WCL reports. Real guild schedules
// practically always leave at least half a day between two DIFFERENT raid
// nights (even guilds that raid back-to-back days raid in an evening
// block, not around the clock), while a same-session split is usually
// minutes and rarely more than an hour or two (a long dinner break). 4
// hours is a generous cutoff that comfortably merges same-session splits
// without ever merging two genuinely different nights.
//
// Used two ways: as a cheap, approximate stand-in for "how many reports do
// we need to fetch" BEFORE any fight data exists (collectRecentSessionReports
// in service.ts, working off report envelope start/end times only -- see
// takeMostRecentSessions below), and as the real, accurate boundary between
// raid nights once fight data IS available (aggregateGuildTrend below,
// working off actual pull timestamps). The two can disagree -- a report's
// own stated envelope can span into a completely different real night if
// its logger's file just kept running -- which is why the accurate,
// fight-based version exists at all; see aggregateGuildTrend's own doc
// comment for the story behind that.
export const SESSION_GAP_MS = 4 * 60 * 60 * 1000;

/**
 * Groups a list of time-ranged items (raw WCL reports, fully-fetched
 * GuildNightInputs, or individual fight instances -- anything with its own
 * startTime/endTime) into sessions: runs of items where each one starts
 * within `gapMs` of the previous item's own end. Doesn't care what order
 * `items` comes in -- always sorts by startTime first, since WCL's own
 * report list comes back newest-first.
 *
 * This is generic so the SAME grouping logic can be used for more than one
 * thing: on raw WCLGuildReportSummary entries, while deciding how many
 * reports to fetch for a given "N nights" request (service.ts); and, with a
 * negative gap, on individual fight time windows to find duplicate pulls,
 * or with SESSION_GAP_MS, to find the real boundaries between raid nights
 * (both in aggregateGuildTrend below). All of these need to agree on
 * exactly the same grouping shape, so there's only one implementation.
 */
export function groupIntoSessions<T extends { startTime: number; endTime: number }>(
  items: T[],
  gapMs: number
): T[][] {
  const sorted = [...items].sort((a, b) => a.startTime - b.startTime);
  const groups: T[][] = [];
  let currentGroup: T[] = [];
  let currentGroupEnd = -Infinity;

  for (const item of sorted) {
    if (currentGroup.length > 0 && item.startTime - currentGroupEnd <= gapMs) {
      currentGroup.push(item);
    } else {
      if (currentGroup.length > 0) groups.push(currentGroup);
      currentGroup = [item];
    }
    currentGroupEnd = Math.max(currentGroupEnd, item.endTime);
  }
  if (currentGroup.length > 0) groups.push(currentGroup);

  return groups;
}

/**
 * Trims a list of time-ranged items down to just the ones belonging to the
 * most recent `count` sessions (see groupIntoSessions above) -- "the N most
 * recent NIGHTS' worth of reports", not "the N most recent REPORTS". Keeps
 * whole sessions together; never splits one session's reports across the
 * trim boundary. Returns everything if there are fewer than `count`
 * sessions to begin with.
 *
 * Used by service.ts's collectRecentSessionReports, working off cheap
 * report-envelope timestamps (no fight data fetched yet). That grouping is
 * only ever an UNDER-estimate of the true number of raid nights -- it can
 * merge two real nights together (if one report's envelope happens to
 * reach into the next), but it can never split one real night into two --
 * so stopping/trimming once it sees `count` envelope-sessions always means
 * "at least `count` real nights are present in what got fetched", never
 * fewer. Good: better to fetch one report too many than to silently miss a
 * night. The final, exact trim down to precisely `count` real nights
 * happens later, in aggregateGuildTrend, once real fight data (and
 * therefore real night boundaries) exists.
 */
export function takeMostRecentSessions<T extends { startTime: number; endTime: number }>(
  items: T[],
  gapMs: number,
  count: number
): T[] {
  return groupIntoSessions(items, gapMs).slice(-count).flat();
}

/**
 * Whether one report belongs to the same raid tier as `tierZoneName` --
 * just a zone-name match. Used by the guild page's "This tier" sample-size
 * option (see collectCurrentTierReports in lib/wcl/service.ts) to pick out
 * only the reports that are actually part of the current tier while
 * paging through a guild's full report history, which is also full of
 * OTHER zones (old raid tiers, Mythic+ dungeon logs) mixed in by upload
 * date, not grouped by zone.
 */
export function matchesTierZone(report: { zone: { name: string } | null }, tierZoneName: string): boolean {
  return report.zone?.name === tierZoneName;
}

// One report's fight, lifted out to an ABSOLUTE (epoch ms) time window,
// tagged with everything about its origin report that a night summary
// needs to know. `fight.startTime`/`endTime` from WCL are report-RELATIVE
// (0 = that report's own start) -- only comparable to another report's
// fights, or usable as a real point in time, once each report's own
// absolute `startTime` has been added back in.
interface FightInstance {
  code: string;
  title: string;
  zoneName: string | null;
  fight: WCLFight;
  startTime: number;
  endTime: number;
}

function toFightInstances(nights: GuildNightInput[]): FightInstance[] {
  return nights.flatMap((night) =>
    night.fights.map((fight) => ({
      code: night.code,
      title: night.title,
      zoneName: night.zoneName,
      fight,
      startTime: night.startTime + fight.startTime,
      endTime: night.startTime + fight.endTime,
    }))
  );
}

/**
 * Picks which fight instance in a cluster of overlapping pulls is the one
 * that counts -- "most complete recording" as a proxy: the longest-running
 * recording of the pull wins (someone whose client lagged or joined a few
 * seconds late would show a shorter duration for the same real pull),
 * tie-broken by whichever started first. Not perfect, but far better than
 * the alternative of silently doubling every number.
 */
function pickFightRepresentative(cluster: FightInstance[]): FightInstance {
  return [...cluster].sort(
    (a, b) => b.endTime - b.startTime - (a.endTime - a.startTime) || a.startTime - b.startTime
  )[0]!;
}

function instanceKey(code: string, fightId: number): string {
  return `${code}:${fightId}`;
}

/**
 * Dedupes every fight across every fetched report -- globally, not scoped
 * to any pre-decided session -- because session boundaries THEMSELVES get
 * derived from the deduped pulls right after this (see aggregateGuildTrend
 * below), so duplicate detection has to happen first. This is safe to run
 * globally: two DIFFERENT real raid nights are always hours apart, so an
 * actual time overlap (two recordings of literally the same pull) can only
 * ever happen between reports of the very same real session to begin with.
 *
 * Reuses groupIntoSessions with a gap of -1 for the same reason as before:
 * two pulls that exactly TOUCH (one starts the very millisecond the other
 * ends) are back-to-back pulls, not a duplicate recording of the same one.
 *
 * Returns, for every original fight instance (winner or not), which
 * dedup cluster it belongs to (as the winner's own key) -- so a caller can
 * look up "is this fight counted" (countedKeys has its OWN key) and "which
 * other instances does this fight's real pull include" (everything mapped
 * to the same winner key) in one pass.
 */
function dedupeFights(instances: FightInstance[]): {
  countedKeys: Set<string>;
  winnerKeyByInstanceKey: Map<string, string>;
  winners: FightInstance[];
} {
  const clusters = groupIntoSessions(instances, -1);
  const countedKeys = new Set<string>();
  const winnerKeyByInstanceKey = new Map<string, string>();
  const winners: FightInstance[] = [];
  for (const cluster of clusters) {
    const winner = pickFightRepresentative(cluster);
    const winnerKey = instanceKey(winner.code, winner.fight.id);
    countedKeys.add(winnerKey);
    winners.push(winner);
    for (const member of cluster) {
      winnerKeyByInstanceKey.set(instanceKey(member.code, member.fight.id), winnerKey);
    }
  }
  return { countedKeys, winnerKeyByInstanceKey, winners };
}

/**
 * Takes a list of WCL reports and turns them into the guild trend view:
 * kill rate over time, death count over time, and the most common death
 * causes across all nights combined.
 *
 * The tricky part -- and the reason this doesn't just group whole REPORTS
 * by their own stated start/end time -- is that a report's own envelope
 * can be misleading. This is a real bug that came up in practice: a
 * logger's combat log kept running between two actual raid nights (they
 * never stopped recording), so one report's stated end time reached all
 * the way into the START of the NEXT night's raid, with a second, properly
 * -scoped report for that next night. Grouping by report envelope treated
 * those as one merged night; the real activity inside them was almost a
 * full day apart.
 *
 * So instead, this works from the ground up, off actual pull timestamps:
 * 1. Every fight from every report, converted to an absolute time window
 *    (toFightInstances).
 * 2. Dedupe genuine duplicate recordings of the same pull -- two reports
 *    whose pulls actually overlap in time, not just two reports that are
 *    merely close together (dedupeFights). This has to happen BEFORE
 *    finding night boundaries, so a duplicated pull doesn't get counted
 *    twice while deciding where one night ends and the next begins.
 * 3. Cluster the deduped, REAL pulls by an actual gap in raid activity
 *    (groupIntoSessions with SESSION_GAP_MS) -- this is what a "raid
 *    night" actually means here: a run of real pulls with no big gap in
 *    the middle, regardless of what any one report's own envelope claims.
 * 4. Reduce each of those real-pull clusters down to a summary row.
 *    Because night boundaries are now decided by pulls instead of whole
 *    reports, a single report CAN legitimately contribute to more than one
 *    night row (like the logger above, whose report's last pull belongs
 *    with the next night, not its own) -- `reports[]` on each row only
 *    lists the reports that actually contributed a pull to THAT row, and
 *    `excludedFights` only counts THAT report's pulls excluded within THAT
 *    row.
 * 5. If `maxNights` is given (the "N nights" sample mode, as opposed to
 *    "whole tier"), keeps only the most recent N of these -- the REAL
 *    count now, not the report-envelope approximation
 *    collectRecentSessionReports (service.ts) used to decide how much to
 *    fetch in the first place. That earlier step can only ever fetch too
 *    much, never too little (see takeMostRecentSessions above), so there's
 *    always enough real data here to trim down to an exact N.
 * 6. Builds one point per night for the "kill rate over time" line chart.
 *    A night with zero attempts counts as 0% instead of crashing on a
 *    divide-by-zero.
 * 7. Builds one point per night for the "deaths per night" line chart.
 * 8. Pools every counted death across every KEPT night and ranks the top
 *    causes, so this chart shows a pattern across the whole sample, not
 *    just one night repeated -- and reflects exactly the nights actually
 *    shown, not any that got trimmed off in step 5.
 */
export function aggregateGuildTrend(
  nightsInput: GuildNightInput[],
  opts?: { maxNights?: number }
): GuildTrendSummary {
  const instances = toFightInstances(nightsInput);
  const { countedKeys, winnerKeyByInstanceKey, winners } = dedupeFights(instances);

  // Real night boundaries: cluster each real pull (one per dedup winner) by
  // an actual gap in activity. Every ORIGINAL instance (winner or not)
  // belongs to whichever session its own dedup winner ended up in -- a
  // duplicate recording is, by definition, essentially co-located in time
  // with the pull it duplicates, so it always lands in the same session.
  const sessionClusters = groupIntoSessions(winners, SESSION_GAP_MS);
  const sessionIndexByWinnerKey = new Map<string, number>();
  sessionClusters.forEach((cluster, i) => {
    for (const w of cluster) sessionIndexByWinnerKey.set(instanceKey(w.code, w.fight.id), i);
  });

  const instancesBySession: FightInstance[][] = sessionClusters.map(() => []);
  for (const inst of instances) {
    const winnerKey = winnerKeyByInstanceKey.get(instanceKey(inst.code, inst.fight.id))!;
    const sessionIndex = sessionIndexByWinnerKey.get(winnerKey)!;
    instancesBySession[sessionIndex]!.push(inst);
  }

  // A lookup from "report code : fight id" to that pull's deaths, so a
  // session's counted instances can pull in exactly the deaths that belong
  // to them, without re-scanning every report's death list per session.
  const deathsByKey = new Map<string, DeathRecord[]>();
  for (const night of nightsInput) {
    for (const death of night.deaths) {
      const key = instanceKey(night.code, death.fightId);
      const existing = deathsByKey.get(key);
      if (existing) existing.push(death);
      else deathsByKey.set(key, [death]);
    }
  }

  // sessionClusters is already chronological ascending (groupIntoSessions
  // sorts before it groups), so this stays chronological too -- no
  // re-sort needed before the maxNights trim below.
  let builders = instancesBySession.map((sessionInstances) => {
    const byReport = new Map<string, FightInstance[]>();
    for (const inst of sessionInstances) {
      const existing = byReport.get(inst.code);
      if (existing) existing.push(inst);
      else byReport.set(inst.code, [inst]);
    }
    const reports = [...byReport.values()]
      .sort((a, b) => Math.min(...a.map((i) => i.startTime)) - Math.min(...b.map((i) => i.startTime)))
      .map((reportInstances) => {
        const excludedFights = reportInstances.filter(
          (i) => !countedKeys.has(instanceKey(i.code, i.fight.id))
        ).length;
        return {
          code: reportInstances[0]!.code,
          title: reportInstances[0]!.title,
          counted: excludedFights < reportInstances.length,
          excludedFights,
        };
      });

    const countedInstances = sessionInstances.filter((i) => countedKeys.has(instanceKey(i.code, i.fight.id)));
    const countedFightsList: WCLFight[] = countedInstances.map((i) => i.fight);
    const { kills, wipes } = summarizeFights(countedFightsList);
    const countedDeaths: DeathRecord[] = countedInstances.flatMap(
      (i) => deathsByKey.get(instanceKey(i.code, i.fight.id)) ?? []
    );
    // "First pull of the night" is now decided by real pulls, not by
    // whichever report's stated envelope started earliest -- a report can
    // claim it started before its first logged pull (loading screens,
    // idle time before the first fight), so this is a small accuracy
    // improvement on top of the bigger fix above.
    const earliest = sessionInstances.reduce((min, i) => (i.startTime < min.startTime ? i : min));

    return {
      reports,
      date: new Date(earliest.startTime).toISOString(),
      zoneName: earliest.zoneName,
      kills,
      wipes,
      deathCount: countedDeaths.length,
      topDeathCauses: deathCauseBreakdown(countedDeaths).slice(0, 3),
      _deaths: countedDeaths,
    };
  });

  if (opts?.maxNights !== undefined) {
    builders = builders.slice(-opts.maxNights);
  }

  const nights: GuildNightSummary[] = builders.map(({ _deaths, ...summary }) => summary);

  const killRateOverTime = nights.map((n) => ({
    date: n.date,
    code: n.reports[0]?.code ?? "",
    value: n.kills + n.wipes > 0 ? n.kills / (n.kills + n.wipes) : 0,
  }));

  const deathsOverTime = nights.map((n) => ({
    date: n.date,
    code: n.reports[0]?.code ?? "",
    value: n.deathCount,
  }));

  // Pooled from exactly the nights kept above (after the maxNights trim,
  // if any) -- not the full fetched sample, which can legitimately include
  // a bit more than was asked for (see takeMostRecentSessions above).
  const allDeaths = builders.flatMap((b) => b._deaths);
  const topDeathCausesOverall = deathCauseBreakdown(allDeaths).slice(0, 8);

  // `allDeaths` is also returned as-is (not just summarized into
  // topDeathCausesOverall) so the guild page can hand it to the same
  // clickable death charts (DeathsPanel) the single-report page uses.
  return { nights, killRateOverTime, deathsOverTime, topDeathCausesOverall, deaths: allDeaths };
}

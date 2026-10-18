/**
 * This file's job: take the raw data already fetched from Warcraft Logs for
 * ONE report (a single raid night's log) and turn it into the shapes the
 * report page needs to display -- ranked damage/healing lists, a list of
 * deaths, a "most common causes of death" count, and a summary of kills vs
 * wipes.
 *
 * This file does NOT talk to the internet. It never calls the Warcraft Logs
 * API. Everything here is just math and array/object reshaping on data
 * that was already fetched elsewhere. That's what makes it easy to test
 * (see src/test/analysis.report.test.ts) -- you can hand these functions
 * fake data and check the output, with no live API needed.
 */
import type { WCLFight, WCLTableEntry } from "@/lib/wcl/types";
import type { DeathCause, DeathRecord, FightsSummary, PlayerDeathCount, RankedEntry } from "./types";

/**
 * Takes a raw damage-done or healing table and turns it into a sorted
 * leaderboard.
 *
 * What it does:
 * 1. Drops anyone with 0 total (e.g. someone in the raid who never
 *    actually played in a logged fight).
 * 2. Works out each player's per-second rate, using WCL's `activeTime`
 *    (the time they were actually attacking/healing) as the denominator.
 *    If we don't have an active time, the rate is just 0 instead of
 *    crashing on a divide-by-zero.
 * 3. Sorts everyone from highest total to lowest, so the result is ready
 *    to render as a ranked list.
 *
 * `parsePercentByName` is optional: it's only passed in when the report has
 * been narrowed down to one specific fight, because a "Parse %" ranking
 * only makes sense for one pull at a time. Players are matched to their
 * parse % by name.
 */
export function rankEntries(entries: WCLTableEntry[], parsePercentByName?: Map<string, number>): RankedEntry[] {
  return entries
    .filter((e) => (e.total ?? 0) > 0)
    .map((e) => {
      const activeTimeMs = e.activeTime ?? 0;
      const total = e.total ?? 0;
      const perSecond = activeTimeMs > 0 ? total / (activeTimeMs / 1000) : 0;
      return {
        name: e.name,
        className: e.type,
        total,
        activeTimeMs,
        perSecond,
        parsePercent: parsePercentByName?.get(e.name),
      };
    })
    .sort((a, b) => b.total - a.total);
}

/**
 * Takes the raw "Deaths" table for a report and turns each death into a
 * DeathRecord our UI understands.
 *
 * What it does:
 * - Looks up which fight each death happened in, so we can show the fight's
 *   name and how far into that pull the death occurred (death timestamp
 *   minus fight start time).
 * - Skips deaths that happened during trash fights (encounterID === 0) --
 *   we only care about boss deaths for "what's killing people" stats.
 * - If a death's fight can't be found for some reason, we keep it anyway
 *   rather than throw it away, since we can't tell if it was trash or not.
 *
 * `reportCode` is optional and just gets stamped onto every DeathRecord as
 * `reportCode`. The single-report page doesn't need it (every death it
 * shows is already from the same report). The guild page does: it combines
 * deaths from several reports into one list, and this is what keeps two
 * different reports' "fight 1" from being treated as the same fight.
 */
export function buildDeathRecords(entries: WCLTableEntry[], fights: WCLFight[], reportCode?: string): DeathRecord[] {
  return entries
    .map((e) => ({ e, fight: fights.find((f) => f.id === (e.fight ?? 0)) }))
    .filter(({ fight }) => !fight || fight.encounterID !== 0)
    .map(({ e, fight }) => {
      const fightId = e.fight ?? 0;
      const timestamp = e.timestamp ?? 0;
      return {
        fightId,
        fightName: fight?.name ?? "Unknown fight",
        timeIntoFightMs: fight ? timestamp - fight.startTime : timestamp,
        playerName: e.name,
        className: e.type,
        killingAbility: e.killingBlow?.name ?? null,
        overkill: e.overkill ?? 0,
        reportCode,
      };
    });
}

/**
 * Counts up how many times each ability killed someone, and sorts from
 * most to least common. This powers the "top causes of death" chart on
 * both the single-report page and the guild trend page (via
 * `aggregateGuildTrend` in guild.ts).
 *
 * Deaths with no named killing ability (e.g. released from death,
 * unexplained environmental damage) get counted under "Unknown" instead
 * of being skipped.
 */
export function deathCauseBreakdown(deaths: DeathRecord[]): DeathCause[] {
  const counts = new Map<string, number>();
  for (const d of deaths) {
    const key = d.killingAbility ?? "Unknown";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([ability, count]) => ({ ability, count }))
    .sort((a, b) => b.count - a.count);
}

/**
 * Counts up how many times each player died, sorted from most to least.
 * The flip side of `deathCauseBreakdown` above (which counts by ability
 * instead of by player) -- used for the "deaths by player" chart, and again
 * on a smaller, already-filtered list to answer "who died to this specific
 * cause, and how many times" when someone clicks a bar on that chart.
 *
 * Each player's class is carried along too, so the chart can color their
 * bar the same way the damage/healing charts do.
 */
export function playerDeathCounts(deaths: DeathRecord[]): PlayerDeathCount[] {
  const counts = new Map<string, { className: string; count: number }>();
  for (const d of deaths) {
    const existing = counts.get(d.playerName);
    if (existing) {
      existing.count += 1;
    } else {
      counts.set(d.playerName, { className: d.className, count: 1 });
    }
  }
  return [...counts.entries()]
    .map(([playerName, v]) => ({ playerName, className: v.className, count: v.count }))
    .sort((a, b) => b.count - a.count);
}

/**
 * Boils a report's list of fights down to the numbers shown in the stat
 * tiles: total fights, how many were kills, how many were wipes, and (for
 * wipes) how close the best attempt got, measured by boss health % left.
 */
export function summarizeFights(fights: WCLFight[]): FightsSummary {
  const totalFights = fights.length;
  // `kill` can be true, false, or null (trash/incomplete pulls), so we
  // check for exactly `true`/`false` rather than just truthy/falsy.
  const kills = fights.filter((f) => f.kill === true).length;
  const wipes = fights.filter((f) => f.kill === false).length;
  const nonKillBossPercents = fights
    .filter((f) => f.kill === false && f.bossPercentage != null)
    .map((f) => f.bossPercentage as number);
  const bestWipePercent = nonKillBossPercents.length ? Math.min(...nonKillBossPercents) : null;

  return {
    totalFights,
    kills,
    wipes,
    killRate: totalFights > 0 ? kills / totalFights : 0,
    bestWipePercent,
  };
}

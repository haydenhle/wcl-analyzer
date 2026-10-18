/**
 * This file's job: turn raw Casts/Damage/Healing table entries (already
 * fetched from Warcraft Logs) into the casts-per-minute comparison the
 * player-analysis feature shows -- one player vs the top server-wide log,
 * for the whole fight and for each phase.
 *
 * Like report.ts and guild.ts, this file does NOT talk to the network. It's
 * pure reshaping/math on data lib/wcl/service.ts has already fetched, which
 * is what makes it testable with fake data (see
 * src/test/analysis.playerAnalysis.test.ts).
 */
import type { WCLFight, WCLTableAbilityBreakdown, WCLTableEntry } from "@/lib/wcl/types";
import type {
  AbilityCastRate,
  AbilityComparisonRow,
  PlayerAnalysisWindow,
  PlayerWindowStats,
  RotationSuggestion,
} from "./types";

/**
 * Splits a fight into its comparison windows: "the whole fight" first
 * (phaseId 0, so the UI always has that as a safe default), followed by one
 * window per real phase transition (empty if the fight has none -- a lot of
 * single-phase bosses don't).
 *
 * A phase runs from its own startTime until the NEXT phase's startTime, or
 * the fight's own endTime for the last phase -- Warcraft Logs only sends a
 * start for each phase, not an end (confirmed with
 * scripts/wcl-diagnose-player-analysis.mjs), so the end has to be derived
 * from whatever comes next.
 */
export interface PhaseWindow {
  // Unique per window -- use THIS for identity (React keys, lookups,
  // "which one is selected"), never `phaseId`. A boss can go back into a
  // phase it's already been in (P1 -> P2 -> P1), and Warcraft Logs reports
  // that as the same phase id twice, so `phaseId` alone isn't unique.
  // "<phaseId>#<n>" for the nth time that phase came up; "whole" for the
  // whole-fight window. Lines up across two logs of the same boss (your
  // second Phase 1 vs. the top log's second Phase 1).
  key: string;
  phaseId: number;
  label: string;
  startTime: number;
  endTime: number;
}

export function buildPhaseWindows(
  fight: Pick<WCLFight, "startTime" | "endTime" | "phaseTransitions">
): PhaseWindow[] {
  const wholeFight = { key: "whole", phaseId: 0, label: "Whole fight", startTime: fight.startTime, endTime: fight.endTime };
  const sorted = [...fight.phaseTransitions].sort((a, b) => a.startTime - b.startTime);
  const totalById = new Map<number, number>();
  for (const p of sorted) totalById.set(p.id, (totalById.get(p.id) ?? 0) + 1);
  const seenById = new Map<number, number>();
  const phases = sorted.map((phase, i) => {
    const occurrence = (seenById.get(phase.id) ?? 0) + 1;
    seenById.set(phase.id, occurrence);
    const repeats = (totalById.get(phase.id) ?? 1) > 1;
    return {
      key: `${phase.id}#${occurrence}`,
      phaseId: phase.id,
      label: repeats ? `Phase ${phase.id} (${occurrence})` : `Phase ${phase.id}`,
      startTime: phase.startTime,
      endTime: sorted[i + 1]?.startTime ?? fight.endTime,
    };
  });
  return [wholeFight, ...phases];
}

/** Casts per minute, over some time window. 0 instead of a divide-by-zero for a zero/negative window. */
export function castsPerMinute(casts: number, durationMs: number): number {
  return durationMs > 0 ? casts / (durationMs / 60_000) : 0;
}

/**
 * Turns a Casts-table entry's per-ability breakdown into per-ability cast
 * rates, sorted most-cast-first (the order that's actually useful to read --
 * "what are they casting most/least often" rather than alphabetical).
 */
export function buildAbilityCastRates(
  abilities: WCLTableAbilityBreakdown[] | undefined,
  durationMs: number
): AbilityCastRate[] {
  return (abilities ?? [])
    .map((a) => ({
      guid: a.guid,
      name: a.name,
      casts: a.total,
      castsPerMinute: castsPerMinute(a.total, durationMs),
    }))
    .sort((a, b) => b.casts - a.casts);
}

/**
 * Combines one player's Casts-table entry and their Damage/Healing-table
 * entry (for throughput) into one window's worth of stats. Either entry can
 * be missing (e.g. the top log's player didn't cast anything trackable, or
 * this window has no matching table entry at all) -- that just produces
 * zeroed-out stats instead of throwing, since "no data for this window"
 * is a normal, displayable outcome here, not a bug.
 *
 * `durationMs` is the WINDOW's own wall-clock length (endTime - startTime),
 * not WCL's `activeTime` field -- this matches how the "amount" field on a
 * characterRankings entry works (a rate over the whole timed window, not
 * just moments spent actively casting), so the player's own throughput
 * number is directly comparable to the top log's.
 */
export function buildPlayerWindowStats(
  castsEntry: WCLTableEntry | undefined,
  throughputEntry: WCLTableEntry | undefined,
  durationMs: number
): PlayerWindowStats {
  const totalCasts = castsEntry?.total ?? 0;
  const throughputTotal = throughputEntry?.total ?? 0;
  return {
    totalCasts,
    castsPerMinute: castsPerMinute(totalCasts, durationMs),
    throughputPerSecond: durationMs > 0 ? throughputTotal / (durationMs / 1000) : 0,
    abilities: buildAbilityCastRates(castsEntry?.abilities, durationMs),
  };
}

/**
 * Builds one full comparison window (both players' stats together) from a
 * window's time bounds plus each player's already-fetched table entries.
 *
 * `topLogDurationMs` is the length of the TOP LOG's own matching window --
 * a different pull, so almost never the same length as this one. Every
 * per-second/per-minute rate on the top-log side has to be divided by that,
 * not by this window's length: dividing a 4:22 kill's damage by a 5:09
 * kill's duration understated the top log's DPS and cast rates by ~15%.
 * Defaults to this window's length only when there's no top-log window.
 */
export function buildComparisonWindow(
  window: PhaseWindow,
  playerCasts: WCLTableEntry | undefined,
  playerThroughput: WCLTableEntry | undefined,
  topLogCasts: WCLTableEntry | undefined,
  topLogThroughput: WCLTableEntry | undefined,
  topLogDurationMs?: number
): PlayerAnalysisWindow {
  const durationMs = window.endTime - window.startTime;
  return {
    key: window.key,
    phaseId: window.phaseId,
    label: window.label,
    startTime: window.startTime,
    endTime: window.endTime,
    player: buildPlayerWindowStats(playerCasts, playerThroughput, durationMs),
    topLog: buildPlayerWindowStats(topLogCasts, topLogThroughput, topLogDurationMs ?? durationMs),
  };
}

/**
 * Merges one window's two ability-cast-rate lists (the analyzed player's,
 * and the top log's) into one row per ability, keyed by guid so the same
 * ability lines up even if the two players don't cast the exact same set
 * (talent choices, a proc-only ability, etc). An ability only one side ever
 * cast still gets a row -- the other side's rate is just 0, which is
 * exactly what "never casts this" should look like next to "casts it
 * 4/min", not a missing row.
 */
export function mergeAbilityComparison(
  playerAbilities: AbilityCastRate[],
  topLogAbilities: AbilityCastRate[]
): AbilityComparisonRow[] {
  const rows = new Map<number, AbilityComparisonRow>();
  for (const a of playerAbilities) {
    rows.set(a.guid, {
      guid: a.guid,
      name: a.name,
      playerCastsPerMinute: a.castsPerMinute,
      topLogCastsPerMinute: 0,
    });
  }
  for (const a of topLogAbilities) {
    const existing = rows.get(a.guid);
    if (existing) {
      existing.topLogCastsPerMinute = a.castsPerMinute;
    } else {
      rows.set(a.guid, {
        guid: a.guid,
        name: a.name,
        playerCastsPerMinute: 0,
        topLogCastsPerMinute: a.castsPerMinute,
      });
    }
  }
  // Sorted by how often the TOP LOG casts it -- that's the ranking that
  // actually matters for "what should I be doing more of", not alphabetical
  // or by the analyzed player's own numbers.
  return [...rows.values()].sort(
    (a, b) => b.topLogCastsPerMinute - a.topLogCastsPerMinute || b.playerCastsPerMinute - a.playerCastsPerMinute
  );
}

// Below this gap (casts/minute), a shortfall is treated as noise (rounding,
// one extra proc across a whole log, etc.) rather than a real suggestion.
const MIN_SUGGESTION_GAP_CPM = 0.3;

// Never show more than this many suggestions at once -- "start small" per
// the feature's own brief: a handful of the biggest gaps is more useful
// than a wall of every minor difference.
const MAX_SUGGESTIONS = 5;

/**
 * Turns a merged ability comparison into the "cast this more often"
 * checklist -- the abilities the top log casts noticeably more often than
 * the analyzed player, biggest gap first. See RotationSuggestion's own
 * comment (lib/analysis/types.ts) for why this is one-directional.
 */
export function buildRotationSuggestions(rows: AbilityComparisonRow[]): RotationSuggestion[] {
  return rows
    .map((r) => ({ ...r, deltaCastsPerMinute: r.topLogCastsPerMinute - r.playerCastsPerMinute }))
    .filter((r) => r.deltaCastsPerMinute >= MIN_SUGGESTION_GAP_CPM)
    .sort((a, b) => b.deltaCastsPerMinute - a.deltaCastsPerMinute)
    .slice(0, MAX_SUGGESTIONS);
}

/**
 * Splits a table entry's `icon` field ("Warrior-Fury") into class + spec.
 * Confirmed against a real report with
 * scripts/wcl-diagnose-player-analysis.mjs -- falls back to nulls instead of
 * throwing if an entry ever comes back without an icon (e.g. an NPC/pet
 * entry that slipped into the table).
 */
export function parseClassSpecFromIcon(icon: string | undefined): { className: string; specName: string } | null {
  if (!icon || !icon.includes("-")) return null;
  const [className, specName] = icon.split("-");
  if (!className || !specName) return null;
  return { className, specName };
}

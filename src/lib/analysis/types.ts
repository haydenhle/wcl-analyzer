/**
 * This file's job: define the TypeScript shapes for data AFTER our own
 * analysis code (report.ts, guild.ts) has processed it -- the shapes the
 * UI actually renders.
 *
 * There are two separate sets of types in this app on purpose:
 *  - `lib/wcl/types.ts` describes exactly what the Warcraft Logs API sends
 *    us (the raw response shapes).
 *  - This file describes what our own app needs internally, after we've
 *    reshaped that raw data (ranked lists, death counts, summaries, etc).
 * Keeping them separate means that if Warcraft Logs ever changes its API,
 * we only have to fix things in one place (lib/wcl/*) -- everything that
 * uses the types in this file doesn't need to change.
 */
import type { WCLFight, WCLRateLimitStatus } from "@/lib/wcl/types";
import type { PlayerRole } from "@/lib/wowSpecRoles";

// --- Single-report analysis (see lib/analysis/report.ts) ----------------

export interface RankedEntry {
  name: string;
  className: string;
  total: number;
  activeTimeMs: number;
  perSecond: number;
  // WCL's percentile ranking (0-100, "Parse %") for this player on this
  // one fight. Only set when the report has been narrowed to a single
  // fight and WCL actually ranked it (it doesn't rank wipes). When it's
  // missing, the UI just hides the parse column instead of showing "0%".
  parsePercent?: number;
}

export interface DeathRecord {
  fightId: number;
  fightName: string;
  timeIntoFightMs: number;
  playerName: string;
  className: string;
  killingAbility: string | null;
  overkill: number;
  // Which report this death happened in. Optional because a single report
  // page only ever shows one report's deaths (so it doesn't matter there),
  // but the guild page combines deaths from SEVERAL reports into one list
  // -- and different reports can reuse the same small fightId numbers
  // (e.g. two different nights can both have a "fight 1"). DeathsPanel
  // uses `reportCode` + `fightId` together so it never mixes up two
  // unrelated pulls that happen to share a number.
  reportCode?: string;
}

export interface DeathCause {
  ability: string;
  count: number;
}

// How many times ONE player died -- the flip side of DeathCause (which
// counts by ability instead of by player). Powers the "deaths by player"
// chart, and the drill-down when you click a cause on that chart.
export interface PlayerDeathCount {
  playerName: string;
  className: string;
  count: number;
}

export interface FightsSummary {
  totalFights: number;
  kills: number;
  wipes: number;
  killRate: number; // 0..1
  bestWipePercent: number | null; // lowest boss% remaining on a non-kill, i.e. closest wipe
}

// The full payload for one report -- what `buildReportAnalysis` (service.ts)
// returns, and what the report page + its JSON API route both render.
export interface ReportAnalysis {
  code: string;
  title: string;
  zoneName: string | null;
  fights: WCLFight[];
  fightsSummary: FightsSummary;
  damageRanking: RankedEntry[];
  healingRanking: RankedEntry[];
  deaths: DeathRecord[];
  deathCauses: DeathCause[];
  rateLimit: WCLRateLimitStatus | null;
}

// --- Player analysis: casts-per-minute vs the top server-wide log --------
// (see lib/analysis/playerAnalysis.ts and lib/wcl/service.ts's
// buildPlayerAnalysis)

// One ability's cast count and rate over some time window (the whole fight,
// or one phase of it).
export interface AbilityCastRate {
  guid: number;
  name: string;
  casts: number;
  castsPerMinute: number;
}

// One player's stats over one time window. The SAME shape is used for both
// the person being analyzed and the top-log player being compared against,
// so the UI can lay them out side by side without two different types.
export interface PlayerWindowStats {
  totalCasts: number;
  castsPerMinute: number;
  // dps or hps depending on role -- see PlayerAnalysisResult.metric.
  throughputPerSecond: number;
  abilities: AbilityCastRate[];
}

// One comparison window: either the whole fight, or one phase of it.
// `phaseId` is 0 for "the whole fight" (not a real WCL phase number) so the
// UI can always show that option first without a special case. `key` is the
// window's unique identity -- `phaseId` can repeat when a boss returns to an
// earlier phase (see buildPhaseWindows in playerAnalysis.ts).
export interface PlayerAnalysisWindow {
  key: string;
  phaseId: number;
  label: string;
  startTime: number;
  endTime: number;
  player: PlayerWindowStats;
  topLog: PlayerWindowStats;
}

export interface PlayerAnalysisResult {
  player: { name: string; className: string; specName: string; role: PlayerRole };
  fightName: string;
  metric: "dps" | "hps";
  // null when no server-wide top parse could be found for this exact boss +
  // difficulty + class + spec (a very unpopular combo, or a brand new
  // encounter) -- the UI shows a message instead of a zeroed-out comparison.
  topLog: {
    playerName: string;
    reportCode: string;
    fightID: number;
  } | null;
  // windows[0] is always "the whole fight"; anything after that is one real
  // phase (empty array if this fight has no phases at all).
  windows: PlayerAnalysisWindow[];
}

// --- Rotational suggestion checklist (see lib/analysis/playerAnalysis.ts's
// mergeAbilityComparison / buildRotationSuggestions) --------------------

// One ability's cast rate for BOTH sides of a window's comparison, merged
// by guid so the same ability lines up in the chart even when the two
// players don't cast the exact same set of abilities. Either side can be 0
// -- "never casts this" is a real, displayable value here, not a gap.
export interface AbilityComparisonRow {
  guid: number;
  name: string;
  playerCastsPerMinute: number;
  topLogCastsPerMinute: number;
}

// One "cast this more often" suggestion: an ability the top log casts
// noticeably more often than the analyzed player, in the currently-selected
// window. Deliberately one-directional -- WCL logs vary enough in fight
// length and proc RNG that "you're under-using X" is a much more reliable
// signal than "you cast X too often" would be, so this checklist never
// surfaces the latter.
export interface RotationSuggestion {
  guid: number;
  name: string;
  playerCastsPerMinute: number;
  topLogCastsPerMinute: number;
  deltaCastsPerMinute: number;
}

// --- Augmentation Evoker buff analysis (see lib/analysis/augmentation.ts
// and lib/wcl/service.ts's buildAugmentationAnalysis) ---------------------

// The self-buffs/procs tracked for uptime and counts. Prescience and
// Shifting Sands aren't here -- they land on OTHER players, so they get
// graded on who they landed on instead (see BuffTargetGrade).
export type AugSelfBuffKey = "ebonMight" | "momentumShift" | "essenceBurst" | "duplicate" | "doubleTime";

export interface BuffUptimeSummary {
  key: AugSelfBuffKey;
  name: string;
  uptimePct: number; // 0..1 of the fight
  uptimeMs: number;
  applications: number; // fresh applications ("applybuff")
  stackGains: number; // extra stacks gained while already up ("applybuffstack")
  maxStacks: number;
  // When it was up, in fight-relative ms -- drives the timeline bars.
  intervals: { start: number; end: number }[];
}

// One Prescience or Shifting Sands application, graded against every DPS
// player's actual damage output during the window it was active.
export interface BuffTargetGrade {
  timeMs: number; // fight-relative
  windowMs: number;
  recipientName: string;
  recipientClass: string | null;
  recipientDps: number; // the recipient's (pets included) damage per second in the window
  // 1 = the recipient really was the highest-damage eligible DPS during
  // that window. null = the recipient isn't a DPS at all (a tank, healer,
  // or someone who did no damage this fight).
  rank: number | null;
  candidates: number; // how many eligible DPS were ranked
  topName: string | null;
  topClass: string | null;
  topDps: number;
  shareOfTop: number | null; // recipientDps / topDps, 0..1
  // Prescience only: true = matched to a real Prescience cast by this
  // Evoker, false = no matching cast (a proc, e.g. Motes of Possibility --
  // not a decision the player made, so it's left out of the stats).
  // null = couldn't tell (cast data unavailable) -- counted, to be safe.
  deliberate: boolean | null;
  // Every DPS's damage per second during this window, highest first -- the
  // data behind the click-to-open "whole raid during this buff" chart.
  // `blocked` = already holding this Evoker's other Prescience, so not a
  // valid target at that moment (left out of `rank`, still shown).
  ranking: { name: string; className: string | null; dps: number; recipient: boolean; blocked: boolean }[];
}

export interface BuffTargetingSummary {
  total: number; // every application found
  graded: number; // those counted toward the rates below (not procs)
  autoApplications: number; // procs excluded from grading
  top1Rate: number | null; // 0..1, null when nothing was graded
  top3Rate: number | null;
  avgShareOfTop: number | null;
  // Average DPS (pets included) of the players actually buffed, during the
  // windows they were buffed -- "were you buffing big numbers", in raw DPS.
  avgRecipientDps: number | null;
}

export interface AugmentationAnalysisResult {
  player: { name: string; actorId: number };
  // The player's own headline DPS for this pull, same number Warcraft
  // Logs' rankings show (from the DamageDone table).
  dps: number;
  reportCode: string;
  fightId: number;
  fightName: string;
  fightDurationMs: number;
  buffs: BuffUptimeSummary[];
  prescience: { grades: BuffTargetGrade[]; summary: BuffTargetingSummary };
  shiftingSands: { grades: BuffTargetGrade[]; summary: BuffTargetingSummary };
  // Anything that makes the numbers above less than complete (a paginated
  // fetch that hit its page cap, cast data that couldn't be loaded, ...)
  // -- shown on the page instead of silently skewing the results.
  warnings: string[];
}

// --- Guild trend analysis (see lib/analysis/guild.ts) --------------------

// One WCL REPORT's raw ingredients -- one of these per report, fetched by
// buildGuildTrend (service.ts). NOT the same thing as one raid night: a
// guild can (and often does) split a single raid session across several
// reports -- a crash/relog, swapping loggers partway through, farm vs.
// progression groups logging separately -- so several of these can end up
// representing the same real night. `groupIntoSessions` (guild.ts) is what
// merges same-session reports back together into one GuildNightSummary
// below; this type is deliberately still one-per-report so that merging
// step has real start/end times to compare.
export interface GuildNightInput {
  code: string;
  title: string;
  startTime: number;
  endTime: number;
  zoneName: string | null;
  fights: WCLFight[];
  deaths: DeathRecord[];
}

// One real raid night, AFTER same-session reports have been merged
// together (see groupIntoSessions in guild.ts). `reports` lists every
// report that got folded into this row, oldest first -- almost always just
// one, but more when the guild split a single raid across several logs.
// Every other field (kills, wipes, deathCount, ...) is already the COMBINED
// total across every report's fights that were actually COUNTED -- dedup
// happens per PULL, not per whole report (see countedFightKeys in
// guild.ts), because two reports in the same session can overlap in time
// without every pull in them being duplicates of each other (two
// simultaneous loggers recording the same raid vs. one logger's file
// spilling into the start of the next report). `excludedFights` on each
// report is how many of ITS OWN pulls were excluded as duplicates of a
// pull another report in this session already has; `counted` is false only
// when EVERY one of a report's pulls was excluded (a full duplicate
// recording). A report is still listed -- and still links to its own WCL
// page -- no matter how many of its pulls were excluded, so nothing looks
// like it silently vanished.
export interface GuildNightSummary {
  reports: { code: string; title: string; counted: boolean; excludedFights: number }[];
  date: string; // ISO date
  zoneName: string | null;
  kills: number;
  wipes: number;
  deathCount: number;
  topDeathCauses: DeathCause[];
}

// One (date, value) point on a trend line chart. `code` is the first of
// this night's (possibly several merged) reports -- included so a future
// "click a point to open that night's report" feature has somewhere to
// link to; not consumed by any chart yet.
export interface GuildTrendPoint {
  date: string;
  code: string;
  value: number;
}

// The full payload for a guild's trend -- what `aggregateGuildTrend`
// (guild.ts) returns, extended with guild/quota info in
// `GuildTrendResult` (service.ts) before it reaches the page.
export interface GuildTrendSummary {
  nights: GuildNightSummary[];
  killRateOverTime: GuildTrendPoint[];
  deathsOverTime: GuildTrendPoint[];
  topDeathCausesOverall: DeathCause[];
  // Every death from every sampled night, pooled into one list. Lets the
  // guild page reuse the same clickable "causes of death" / "deaths by
  // player" charts (DeathsPanel) that the single-report page uses, instead
  // of a second, guild-specific version of those charts.
  deaths: DeathRecord[];
}

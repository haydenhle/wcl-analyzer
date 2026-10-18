/**
 * This is the "put it all together" layer, between raw API calls and what
 * a page actually renders. It calls the query functions in queries.ts to
 * get raw data from Warcraft Logs, then hands that data to the analysis
 * functions (lib/analysis/*) that turn it into rankings, charts, and stats.
 *
 * Both the pages (app/report/**, app/guild/**) and the JSON API routes
 * (app/api/**\/route.ts) call these same functions, so there's only one
 * place that knows how to build a report or guild dashboard.
 */
import { buildDeathRecords, deathCauseBreakdown, rankEntries, summarizeFights } from "@/lib/analysis/report";
import {
  SESSION_GAP_MS,
  aggregateGuildTrend,
  filterNightToMythic,
  groupIntoSessions,
  matchesTierZone,
  takeMostRecentSessions,
} from "@/lib/analysis/guild";
import {
  AUG_ABILITY_NAMES,
  SELF_BUFF_LABELS,
  abilityIdsByName,
  buildActorLookup,
  buildDamageIndex,
  computeBuffUptime,
  extractBuffApplications,
  gradeApplications,
  heldByOthersAt,
  inferPetOwners,
  isDpsPlayer,
  markDeliberate,
  parseReportLink,
  summarizeGrades,
} from "@/lib/analysis/augmentation";
import { resolveFightScope } from "@/lib/analysis/fightScope";
import {
  buildComparisonWindow,
  buildPhaseWindows,
  parseClassSpecFromIcon,
} from "@/lib/analysis/playerAnalysis";
import type {
  AugSelfBuffKey,
  AugmentationAnalysisResult,
  GuildNightInput,
  GuildTrendSummary,
  PlayerAnalysisResult,
  ReportAnalysis,
} from "@/lib/analysis/types";
import { FALLBACK_MYTHIC_DIFFICULTY_ID, findMythicDifficultyId, isTierZoneFight } from "@/lib/wowDifficulty";
import { metricForRole, roleForSpec } from "@/lib/wowSpecRoles";
import {
  getCharacterRankings,
  getFightRankings,
  getGuildReports,
  getRateLimitStatus,
  getReportEvents,
  getReportMasterData,
  getReportMeta,
  getReportTable,
  getZoneDifficulties,
} from "./queries";
import type {
  TableDataType,
  WCLCharacterRankingEntry,
  WCLGuild,
  WCLGuildReportSummary,
  WCLRateLimitStatus,
  WCLTableEntry,
  WCLZoneDifficulty,
} from "./types";
import { WCLApiError } from "./types";

/**
 * Figures out which `WCLFight.difficulty` number means "Mythic" for a
 * given zone -- looked up live instead of hardcoded, since that id isn't
 * the same across raid tiers (see lib/wowDifficulty.ts). Falls back to a
 * reasonable default rather than failing the whole page if the lookup
 * itself has a problem (unknown zone, a network hiccup, etc.).
 */
async function resolveMythicDifficultyId(zoneId: number | undefined): Promise<number> {
  if (zoneId === undefined) return FALLBACK_MYTHIC_DIFFICULTY_ID;
  try {
    const difficulties = await getZoneDifficulties(zoneId);
    return findMythicDifficultyId(difficulties) ?? FALLBACK_MYTHIC_DIFFICULTY_ID;
  } catch {
    return FALLBACK_MYTHIC_DIFFICULTY_ID;
  }
}

/**
 * Asks for the current rate-limit (quota) status, but never lets that
 * request break the whole page if it fails -- it's just informational, so
 * we show it if we have it and skip it otherwise.
 */
async function tryGetRateLimitStatus(): Promise<WCLRateLimitStatus | null> {
  try {
    return await getRateLimitStatus();
  } catch {
    return null;
  }
}

/**
 * Builds everything the single-report dashboard needs, in one call: fight
 * summary, damage/healing rankings, and the death log with causes.
 *
 * `opts.scope` optionally narrows all of that to a subset of the report's
 * fights -- one pull, one boss, all kills, all wipes, etc. (see
 * lib/analysis/fightScope.ts). Leaving it out uses every fight.
 */
export async function buildReportAnalysis(code: string, opts?: { scope?: string }): Promise<ReportAnalysis> {
  // 1. Get the report's basic info first. We need its start/end time and
  // fight list before we can figure out the scope or fetch anything else,
  // so this has to happen before the requests below.
  const meta = await getReportMeta(code);

  // Figure out which fights are in scope. `undefined` means "no filter,
  // use every fight"; an array (maybe empty) is the exact list of fight
  // IDs to use.
  const fightIDs = resolveFightScope(opts?.scope, meta.fights);
  const scopedFights = fightIDs ? meta.fights.filter((f) => fightIDs.includes(f.id)) : meta.fights;

  // Warcraft Logs wants the time range in report-relative milliseconds
  // (0 = report start), not the absolute timestamps in meta.startTime/
  // endTime, so we convert here. The table() request fails without a time
  // range or a fight list -- the range stays "the whole report" even when
  // we're scoped to certain fights; `fightIDs` is what actually narrows
  // the result.
  const range = { startTime: 0, endTime: meta.endTime - meta.startTime };
  const tableOpts = { reportEndTimeMs: meta.endTime, fightIDs };

  // 2. Fetch damage, healing, deaths, rankings, and the quota check
  // together -- they're independent requests, so there's no need to wait
  // for one before starting the next.
  //
  // If the scope has zero fights in it (e.g. "this boss's kills" when it
  // was never killed), there's nothing to fetch -- skip the requests
  // entirely instead of spending quota on calls we know will come back
  // empty.
  //
  // Percentile rankings ("Parse %") only make sense for exactly ONE fight,
  // so we only ask for them when the scope resolved to a single fight ID.
  // Otherwise we just use empty maps, which the ranking code already
  // treats as "no parse data for this row".
  //
  // Damage and healing rankings need two SEPARATE requests (playerMetric:
  // "dps" vs "hps") rather than one shared result -- see getFightRankings's
  // comment for why.
  let damageEntries: WCLTableEntry[] = [];
  let healingEntries: WCLTableEntry[] = [];
  let deathEntries: WCLTableEntry[] = [];
  let damageParsePercentByName = new Map<string, number>();
  let healingParsePercentByName = new Map<string, number>();
  let rateLimit: WCLRateLimitStatus | null;
  if (!fightIDs || fightIDs.length > 0) {
    const singleFightId = fightIDs?.length === 1 ? fightIDs[0] : undefined;
    [damageEntries, healingEntries, deathEntries, damageParsePercentByName, healingParsePercentByName, rateLimit] =
      await Promise.all([
        getReportTable(code, "DamageDone", range, tableOpts),
        getReportTable(code, "Healing", range, tableOpts),
        getReportTable(code, "Deaths", range, tableOpts),
        singleFightId !== undefined
          ? getFightRankings(code, singleFightId, "dps")
          : Promise.resolve(new Map<string, number>()),
        singleFightId !== undefined
          ? getFightRankings(code, singleFightId, "hps")
          : Promise.resolve(new Map<string, number>()),
        tryGetRateLimitStatus(),
      ]);
  } else {
    rateLimit = await tryGetRateLimitStatus();
  }

  // 3. Hand the raw entries off to the analysis layer (lib/analysis) to
  // turn them into rankings and death records -- nothing past this point
  // needs to know about the API anymore. We pass the FULL fight list here
  // (not just the scoped ones) so a death's fight name still looks up
  // correctly even though the entries themselves are already scoped.
  const deaths = buildDeathRecords(deathEntries, meta.fights, code);

  return {
    code: meta.code,
    title: meta.title,
    zoneName: meta.zone?.name ?? null,
    // The FULL fight list, not scopedFights -- the fight picker in the UI
    // needs every fight as an option, regardless of what's selected.
    fights: meta.fights,
    fightsSummary: summarizeFights(scopedFights),
    damageRanking: rankEntries(damageEntries, damageParsePercentByName),
    healingRanking: rankEntries(healingEntries, healingParsePercentByName),
    deaths,
    deathCauses: deathCauseBreakdown(deaths),
    rateLimit,
  };
}

// --- Player analysis: one player's casts-per-minute vs the top server-wide
// log for the same boss + difficulty + class + spec -------------------------
//
// The shape of this function is: figure out WHO we're looking at (their
// class/spec/role, which decides whether "throughput" means dps or hps),
// then fetch that player's own data window-by-window (whole fight, then
// each real phase), then try to find a top server-wide log to compare
// against and fetch ITS data the same way, then zip the two together.
//
// Every table() fetch here is scoped to one window's own absolute
// startTime/endTime (see buildPhaseWindows) -- confirmed with
// scripts/wcl-diagnose-player-analysis.mjs that WCL's table() genuinely
// filters by that absolute range, not just a formality alongside fightIDs.

/**
 * Finds the highest server-wide parse for this fight's boss + difficulty +
 * class + spec -- "the top log". Used by both the player-analysis tab
 * (casts vs. the top log) and the Compare tab's "vs. #1" button.
 *
 * Wipe/trash "fights" don't have a real difficulty id, and the rankings
 * query needs one, so those get null rather than a guessed difficulty. The
 * exact pull being analyzed is skipped -- comparing a log to itself isn't a
 * comparison -- so if you ARE #1, this returns #2 (`rank` says which).
 */
async function findTopRankedLog(
  fight: { encounterID: number; difficulty: number | null },
  className: string,
  specName: string,
  metric: "dps" | "hps",
  exclude: { code: string; fightId: number }
): Promise<{ entry: WCLCharacterRankingEntry; rank: number } | null> {
  if (fight.difficulty === null) return null;
  const rankings = await getCharacterRankings(fight.encounterID, className, specName, fight.difficulty, metric);
  const index = rankings.findIndex((r) => !(r.report.code === exclude.code && r.report.fightID === exclude.fightId));
  return index >= 0 ? { entry: rankings[index]!, rank: index + 1 } : null;
}

/**
 * Builds the casts-per-minute / throughput comparison for one player in one
 * fight, against the #1 server-wide parse for the same boss + difficulty +
 * class + spec.
 *
 * Returns `topLog: null` (with the player's own stats still filled in) when
 * this is a trash/undifferentiated "fight" with no real difficulty id, when
 * nobody else has a log of this exact combo, or when the top log itself
 * fails to load -- a missing comparison is a normal, displayable outcome
 * here, not a reason to fail the whole page.
 */
export async function buildPlayerAnalysis(
  code: string,
  fightId: number,
  playerName: string
): Promise<PlayerAnalysisResult> {
  // 1. Get the report + fight, and figure out its comparison windows (whole
  // fight first, then one per real phase transition).
  const meta = await getReportMeta(code);
  const fight = meta.fights.find((f) => f.id === fightId);
  if (!fight) {
    throw new WCLApiError(`Fight ${fightId} not found in report "${code}".`);
  }
  const windows = buildPhaseWindows(fight);
  const wholeFightWindow = windows[0]!;
  const tableOpts = { fightIDs: [fightId], reportEndTimeMs: meta.endTime };

  // 2. We don't know the player's class/spec/role yet, so the first fetch
  // pulls Casts AND both throughput tables (DamageDone, Healing) for the
  // whole fight -- whichever throughput table actually has this player in
  // it (plus the Casts table's `icon` field) is what tells us their
  // class/spec, which everything after this depends on.
  const wholeFightRange = { startTime: wholeFightWindow.startTime, endTime: wholeFightWindow.endTime };
  const [wholeCasts, wholeDamage, wholeHealing] = await Promise.all([
    getReportTable(code, "Casts", wholeFightRange, tableOpts),
    getReportTable(code, "DamageDone", wholeFightRange, tableOpts),
    getReportTable(code, "Healing", wholeFightRange, tableOpts),
  ]);

  const playerCasts = wholeCasts.find((e) => e.name === playerName);
  const playerDamage = wholeDamage.find((e) => e.name === playerName);
  const playerHealing = wholeHealing.find((e) => e.name === playerName);
  const classSpec = parseClassSpecFromIcon(playerCasts?.icon ?? playerDamage?.icon ?? playerHealing?.icon);
  if (!classSpec) {
    throw new WCLApiError(
      `Couldn't find "${playerName}" in fight ${fightId} of report "${code}" -- check the name/spelling.`
    );
  }
  const { className, specName } = classSpec;
  const role = roleForSpec(className, specName);
  const metric = metricForRole(role);
  const throughputType: TableDataType = metric === "hps" ? "Healing" : "DamageDone";
  const playerThroughputWhole = metric === "hps" ? playerHealing : playerDamage;

  // 3. Fetch the player's own remaining phase windows (the whole fight is
  // already covered by step 2) -- Casts + whichever throughput table
  // matches their role, per phase.
  const laterWindows = windows.slice(1);
  const playerPhaseTables = await Promise.all(
    laterWindows.map((w) =>
      Promise.all([
        getReportTable(code, "Casts", { startTime: w.startTime, endTime: w.endTime }, tableOpts),
        getReportTable(code, throughputType, { startTime: w.startTime, endTime: w.endTime }, tableOpts),
      ])
    )
  );

  // window key -> this player's (casts, throughput) entries for that
  // window, looked up again below when the final windows get assembled.
  // Keyed by `key`, not `phaseId`: a boss that returns to an earlier phase
  // has the same phaseId twice, and keying by it made the second window's
  // data silently overwrite the first's.
  const playerByPhase = new Map<
    string,
    { casts: WCLTableEntry | undefined; throughput: WCLTableEntry | undefined }
  >();
  playerByPhase.set("whole", { casts: playerCasts, throughput: playerThroughputWhole });
  laterWindows.forEach((w, i) => {
    const [castsEntries, throughputEntries] = playerPhaseTables[i]!;
    playerByPhase.set(w.key, {
      casts: castsEntries.find((e) => e.name === playerName),
      throughput: throughputEntries.find((e) => e.name === playerName),
    });
  });

  // 4. Look up the server-wide #1 parse for this exact boss + difficulty +
  // class + spec. Wipe/trash "fights" don't have a real difficulty id, and
  // the rankings query needs one -- skip the lookup entirely there rather
  // than guessing at a difficulty.
  const topLogEntry = (await findTopRankedLog(fight, className, specName, metric, { code, fightId }))?.entry;

  let topLog: PlayerAnalysisResult["topLog"] = null;
  // Also carries each top-log window's OWN length -- the top log is a
  // different pull, so its rates must be divided by its own duration, not
  // this player's (see buildComparisonWindow).
  const topByPhase = new Map<
    string,
    { casts: WCLTableEntry | undefined; throughput: WCLTableEntry | undefined; durationMs: number }
  >();

  if (topLogEntry) {
    try {
      const topCode = topLogEntry.report.code;
      const topFightID = topLogEntry.report.fightID;
      const topPlayerName = topLogEntry.name;
      const topMeta = await getReportMeta(topCode);
      const topFight = topMeta.fights.find((f) => f.id === topFightID);
      if (topFight) {
        const topWindows = buildPhaseWindows(topFight);
        const topTableOpts = { fightIDs: [topFight.id], reportEndTimeMs: topMeta.endTime };
        const topWholeWindow = topWindows[0]!;
        const topWholeRange = { startTime: topWholeWindow.startTime, endTime: topWholeWindow.endTime };
        const [topWholeCasts, topWholeThroughput] = await Promise.all([
          getReportTable(topCode, "Casts", topWholeRange, topTableOpts),
          getReportTable(topCode, throughputType, topWholeRange, topTableOpts),
        ]);
        topByPhase.set("whole", {
          casts: topWholeCasts.find((e) => e.name === topPlayerName),
          throughput: topWholeThroughput.find((e) => e.name === topPlayerName),
          durationMs: topWholeWindow.endTime - topWholeWindow.startTime,
        });

        const topLaterWindows = topWindows.slice(1);
        const topPhaseTables = await Promise.all(
          topLaterWindows.map((w) =>
            Promise.all([
              getReportTable(topCode, "Casts", { startTime: w.startTime, endTime: w.endTime }, topTableOpts),
              getReportTable(topCode, throughputType, { startTime: w.startTime, endTime: w.endTime }, topTableOpts),
            ])
          )
        );
        topLaterWindows.forEach((w, i) => {
          const [castsEntries, throughputEntries] = topPhaseTables[i]!;
          topByPhase.set(w.key, {
            casts: castsEntries.find((e) => e.name === topPlayerName),
            throughput: throughputEntries.find((e) => e.name === topPlayerName),
            durationMs: w.endTime - w.startTime,
          });
        });

        topLog = { playerName: topPlayerName, reportCode: topCode, fightID: topFightID };
      }
    } catch (err) {
      // The top-ranked log failing to load (deleted, still processing, a
      // transient API error) shouldn't break the whole comparison -- fall
      // back to showing the player's own stats with no comparison instead
      // of failing the page.
      // eslint-disable-next-line no-console
      console.error("[wcl] top log lookup failed, showing player-only analysis:", err);
    }
  }

  // 5. Assemble the final comparison windows -- one per entry in `windows`
  // (whole fight first, then real phases), pulling each side's data from
  // the window-key -> entry maps built above. A key missing from either
  // map (e.g. the top log's phases don't line up 1:1 with this one) just
  // produces zeroed stats for that side instead of throwing.
  const resultWindows = windows.map((w) => {
    const player = playerByPhase.get(w.key);
    const top = topByPhase.get(w.key);
    return buildComparisonWindow(w, player?.casts, player?.throughput, top?.casts, top?.throughput, top?.durationMs);
  });

  return {
    player: { name: playerName, className, specName, role },
    fightName: fight.name,
    metric,
    topLog,
    windows: resultWindows,
  };
}

// --- Augmentation Evoker buff analysis ---------------------------------------
//
// Everything here runs off raw EVENTS (getReportEvents), not the aggregate
// tables the rest of this file uses -- "who did this Prescience land on,
// and was that person the top DPS at that moment" needs individual
// timestamped buff applications and hits. See lib/analysis/augmentation.ts
// for the analysis itself and scripts/wcl-diagnose-buff-events.mjs for how
// the event shapes were confirmed.

// Fallback/cap for how long a Prescience or Shifting Sands "window" lasts
// when grading it -- used only when the log doesn't show the buff falling
// off (e.g. still up when the fight ended). Prescience lasts ~18s.
const BUFF_WINDOW_DEFAULT_MS = 15_000;
const BUFF_WINDOW_MAX_MS = 30_000;

export async function buildAugmentationAnalysis(
  code: string,
  fightId: number,
  playerName: string
): Promise<AugmentationAnalysisResult> {
  const meta = await getReportMeta(code);
  const fight = meta.fights.find((f) => f.id === fightId);
  if (!fight) {
    throw new WCLApiError(`Fight ${fightId} not found in report "${code}".`);
  }
  const master = await getReportMasterData(code, meta.endTime);
  const evoker = master.actors.find(
    (a) => a.type === "Player" && a.name.toLowerCase() === playerName.toLowerCase()
  );
  if (!evoker) {
    throw new WCLApiError(`Couldn't find a player named "${playerName}" in report "${code}".`);
  }
  if (!/^Evoker-Augmentation$/i.test(evoker.icon)) {
    throw new WCLApiError(`${evoker.name} isn't an Augmentation Evoker in report "${code}".`);
  }

  const ids = Object.fromEntries(
    Object.entries(AUG_ABILITY_NAMES).map(([key, name]) => [key, abilityIdsByName(master.abilities, name)])
  ) as Record<keyof typeof AUG_ABILITY_NAMES, number[]>;
  const range = { startTime: fight.startTime, endTime: fight.endTime };
  const common = { fightIDs: [fight.id], ...range, reportEndTimeMs: meta.endTime };
  const warnings: string[] = [];

  // One query per ability id, not one big unfiltered pull: filtering by
  // ability keeps each response small, and (see getReportEvents) it's the
  // filter that was confirmed to return every application.
  const allBuffIds = [...new Set(Object.values(ids).flat())];
  const [buffResults, castEvents, damage, damageTable] = await Promise.all([
    Promise.all(
      allBuffIds.map((abilityID) =>
        getReportEvents(code, { ...common, dataType: "Buffs", abilityID, hostilityType: "Friendlies" })
      )
    ),
    // Prescience casts, to tell real casts apart from procs. Optional: if
    // this fails, every application just stays "unknown" and is counted.
    Promise.all(
      ids.prescience.map((abilityID) => getReportEvents(code, { ...common, dataType: "Casts", abilityID }))
    )
      .then((results) => results.flatMap((r) => r.events))
      .catch(() => {
        warnings.push("Couldn't load Prescience casts, so procs couldn't be told apart from real casts -- all applications are counted.");
        return null;
      }),
    getReportEvents(code, { ...common, dataType: "DamageDone", hostilityType: "Friendlies" }),
    // The DamageDone TABLE (not events) for the player's headline DPS --
    // it's what Warcraft Logs' own rankings use (an Aug's table total
    // matched its ranking DPS exactly), and it's the same request the
    // other tabs make for this pull, so it's usually already cached.
    getReportTable(code, "DamageDone", range, { fightIDs: [fight.id], reportEndTimeMs: meta.endTime }),
  ]);

  if (buffResults.some((r) => r.truncated)) {
    warnings.push("Some buff data for this pull was cut off by the page cap -- uptimes near the end may be low.");
  }
  if (damage.truncated) {
    warnings.push("This pull's damage data was cut off by the page cap -- target grading near the end of the fight is incomplete.");
  }
  const buffEvents = buffResults.flatMap((r) => r.events);

  // Pet -> owner for every actor, including summons the report doesn't
  // link to an owner (see inferPetOwners) -- worked out from the
  // single-target buffs, so it has to wait for the events above. Every
  // later step (buff recipients, damage per player) goes through this.
  const lookup = buildActorLookup(
    master.actors,
    inferPetOwners(buffEvents, master.actors, [...ids.prescience, ...ids.shiftingSands])
  );

  // Self-buffs: up-time + counts. Ebon Might goes on the whole raid, so
  // it's narrowed to the copy on the Evoker themself; the rest only ever
  // sit on the Evoker anyway.
  const selfBuffKeys: AugSelfBuffKey[] = ["ebonMight", "momentumShift", "essenceBurst", "duplicate", "doubleTime"];
  const buffs = selfBuffKeys.map((key) => ({
    key,
    name: SELF_BUFF_LABELS[key],
    ...computeBuffUptime(buffEvents, {
      abilityIds: ids[key],
      sourceId: evoker.id,
      targetId: key === "ebonMight" ? evoker.id : undefined,
      fightStart: fight.startTime,
      fightEnd: fight.endTime,
    }),
  }));

  // Who counts as a ranked DPS: players with a dps spec who actually did
  // damage this pull (masterData lists everyone in the whole REPORT, most
  // of whom weren't in this fight), minus the Evoker being graded.
  const damageIndex = buildDamageIndex(damage.events, lookup.ownerOf);
  const candidates = damageIndex
    .owners()
    .filter((id) => id !== evoker.id && isDpsPlayer(lookup.actor(id)));

  const appOpts = {
    sourceId: evoker.id,
    ownerOf: lookup.ownerOf,
    isPlayer: lookup.isPlayer,
    fightEnd: fight.endTime,
    defaultWindowMs: BUFF_WINDOW_DEFAULT_MS,
    maxWindowMs: BUFF_WINDOW_MAX_MS,
  };
  const prescienceApps = markDeliberate(
    extractBuffApplications(buffEvents, { ...appOpts, abilityIds: ids.prescience }),
    castEvents,
    { sourceId: evoker.id }
  );
  const sandsApps = extractBuffApplications(buffEvents, { ...appOpts, abilityIds: ids.shiftingSands });

  const gradeCtx = { damage: damageIndex, candidates, lookup, fightStart: fight.startTime };
  const prescienceGrades = gradeApplications(prescienceApps, {
    ...gradeCtx,
    blockedAt: heldByOthersAt(prescienceApps),
  });
  const sandsGrades = gradeApplications(sandsApps, gradeCtx);

  return {
    player: { name: evoker.name, actorId: evoker.id },
    dps: (damageTable.find((e) => e.name === evoker.name)?.total ?? 0) / Math.max(1, (fight.endTime - fight.startTime) / 1000),
    reportCode: code,
    fightId: fight.id,
    fightName: fight.name,
    fightDurationMs: fight.endTime - fight.startTime,
    buffs,
    prescience: { grades: prescienceGrades, summary: summarizeGrades(prescienceGrades) },
    shiftingSands: { grades: sandsGrades, summary: summarizeGrades(sandsGrades) },
    warnings,
  };
}

/**
 * The comparison side: someone pastes a WCL link to ANOTHER Augmentation
 * Evoker's pull (any report, any boss) and this resolves it to a report +
 * fight + player, then runs the same analysis on it.
 *
 * The link needs a specific pull (`fight=` in it -- WCL adds that when
 * you're viewing a single fight). The player comes from, in order: the
 * link's own `source=`, the name typed in alongside it, or -- if that log
 * only has ONE Augmentation Evoker -- that one automatically.
 */
export async function buildAugmentationComparison(
  link: string,
  playerName?: string
): Promise<AugmentationAnalysisResult> {
  const parsed = parseReportLink(link);
  if (!parsed) {
    throw new WCLApiError("That doesn't look like a Warcraft Logs report link.");
  }
  const meta = await getReportMeta(parsed.code);
  const fightId = parsed.fight === "last" ? meta.fights[meta.fights.length - 1]?.id : parsed.fight;
  if (fightId == null) {
    throw new WCLApiError("That link doesn't point at a specific pull -- open the fight on Warcraft Logs and copy the link from there (it should include fight=...).");
  }

  let name = playerName?.trim() || undefined;
  if (!name) {
    const master = await getReportMasterData(parsed.code, meta.endTime);
    if (parsed.sourceId !== null) {
      name = master.actors.find((a) => a.id === parsed.sourceId)?.name;
    }
    if (!name) {
      const augs = master.actors.filter((a) => a.type === "Player" && /^Evoker-Augmentation$/i.test(a.icon));
      if (augs.length === 1) {
        name = augs[0]!.name;
      } else if (augs.length === 0) {
        throw new WCLApiError("That log doesn't have an Augmentation Evoker in it.");
      } else {
        throw new WCLApiError(
          `That log has more than one Augmentation Evoker (${augs.map((a) => a.name).join(", ")}) -- type which one to compare against.`
        );
      }
    }
  }
  return buildAugmentationAnalysis(parsed.code, fightId, name);
}

/**
 * Every Augmentation Evoker who actually played in one pull -- for the
 * Compare tab's "you" picker and its "vs. <another Aug in your raid>"
 * buttons. Read off the pull's own DamageDone table (each entry's `icon` is
 * "Class-Spec"), which every tab of the report page already requests for a
 * single pull, so this is normally a cache hit, not a new API call.
 */
export async function listAugmentationEvokers(code: string, fightId: number): Promise<string[]> {
  const meta = await getReportMeta(code);
  const fight = meta.fights.find((f) => f.id === fightId);
  if (!fight) return [];
  const entries = await getReportTable(
    code,
    "DamageDone",
    { startTime: fight.startTime, endTime: fight.endTime },
    { fightIDs: [fight.id], reportEndTimeMs: meta.endTime }
  );
  return entries.filter((e) => e.icon === "Evoker-Augmentation").map((e) => e.name);
}

/**
 * The Compare tab's "vs. #1" button: the highest-ranked Augmentation Evoker
 * log anywhere for this same boss + difficulty, analyzed the same way as
 * yours. `rank` is that log's position (2 if you're #1 yourself -- see
 * findTopRankedLog).
 */
export async function buildAugmentationVsTopLog(
  code: string,
  fightId: number
): Promise<{ analysis: AugmentationAnalysisResult; rank: number }> {
  const meta = await getReportMeta(code);
  const fight = meta.fights.find((f) => f.id === fightId);
  if (!fight) {
    throw new WCLApiError(`Fight ${fightId} not found in report "${code}".`);
  }
  const top = await findTopRankedLog(fight, "Evoker", "Augmentation", "dps", { code, fightId });
  if (!top) {
    throw new WCLApiError("No ranked Augmentation Evoker logs found for this boss and difficulty.");
  }
  const analysis = await buildAugmentationAnalysis(top.entry.report.code, top.entry.report.fightID, top.entry.name);
  return { analysis, rank: top.rank };
}

// How many recent raid nights we pull in for the guild trend chart when the
// page doesn't ask for a specific amount (see app/api/guild/route.ts).
const DEFAULT_NIGHTS_FOR_TREND = 8;

// Hard ceiling on how many nights we'll ever fetch in one go, no matter what
// the page asks for -- both for a manual "?nights=N" count AND for how many
// matching nights "This tier" mode (below) will collect. Each extra night is
// a handful of extra API requests, so this protects the WCL quota from
// someone hand-editing the URL to something huge like ?nights=500.
const MAX_NIGHTS_FOR_TREND = 40;

// Clamps a requested night count into the allowed [1, MAX_NIGHTS_FOR_TREND]
// range, falling back to the default for anything missing or not a real
// number (e.g. a malformed ?nights= value).
function clampNightsRequested(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested)) {
    return DEFAULT_NIGHTS_FOR_TREND;
  }
  return Math.min(Math.max(Math.trunc(requested), 1), MAX_NIGHTS_FOR_TREND);
}

// How many raw reports one page of the guild's report list returns while
// paging below -- shared by both "count" and "This tier" sample modes.
const REPORTS_PAGE_SIZE = 20;

// Stop paginating after scanning this many reports total, match or not --
// shared by both sample modes below, so a guild with an unusually dense
// report history (or a lot of same-session log splitting) can't run up the
// API quota chasing a target that's further back than it's worth fetching.
const REPORTS_SCAN_CAP = 120;

/**
 * Pages through a guild's report list until it's collected enough reports
 * to cover `sessionsRequested` real raid NIGHTS -- not just that many
 * REPORTS. A plain `getGuildReports(..., { limit: sessionsRequested })`
 * would under-deliver whenever the guild has split any of its recent raids
 * across multiple reports (see groupIntoSessions in lib/analysis/guild.ts):
 * asking for "8 nights" should still get you close to 8 nights even if 3 of
 * them were each logged as 2-3 separate reports.
 *
 * This counts sessions directly off the raw WCLGuildReportSummary list
 * (which already carries each report's own startTime/endTime) rather than
 * waiting to fetch each report's full fight data -- grouping only needs
 * start/end times, so there's no need to fetch anything extra just to
 * decide when to stop paginating.
 */
async function collectRecentSessionReports(
  name: string,
  serverSlug: string,
  serverRegion: string,
  sessionsRequested: number
): Promise<{ guild: WCLGuild; reports: WCLGuildReportSummary[]; sampleTruncated: boolean }> {
  let page = 1;
  let scanned = 0;
  const collected: WCLGuildReportSummary[] = [];
  let firstPageGuild: WCLGuild | null = null;
  let sampleTruncated = false;

  for (;;) {
    const batch = await getGuildReports(name, serverSlug, serverRegion, {
      limit: REPORTS_PAGE_SIZE,
      page,
    });
    if (page === 1) firstPageGuild = batch;
    const pageReports = batch.reports.data;
    if (pageReports.length === 0) break;

    collected.push(...pageReports);
    scanned += pageReports.length;

    const sessionCount = groupIntoSessions(collected, SESSION_GAP_MS).length;
    const hitSessionsGoal = sessionCount >= sessionsRequested;
    const hitScanCap = scanned >= REPORTS_SCAN_CAP;
    if (hitSessionsGoal || hitScanCap) {
      // Only truthfully "truncated" if we stopped short of the goal
      // because of the scan cap, with more pages we never looked at --
      // reaching the goal cleanly isn't a truncation.
      sampleTruncated = !hitSessionsGoal && batch.reports.has_more_pages;
      break;
    }
    if (!batch.reports.has_more_pages) break;
    page++;
  }

  // The loop above stops as soon as we have AT LEAST `sessionsRequested`
  // sessions, but it can easily end up with quite a few more than that --
  // WCL's report list is only paged in fixed chunks of REPORTS_PAGE_SIZE,
  // so one page can (and for a guild that logs a lot of same-night splits,
  // often does) contain more real nights than were actually asked for.
  // Trim back down to just the most recent `sessionsRequested` sessions'
  // worth of reports here, so "8 nights" always means the 8 most recent
  // nights -- not "at least 8, plus however many extra happened to be on
  // the same page" -- and so the per-report meta/deaths fetches in
  // buildGuildTrend don't spend quota on nights that would just get
  // discarded anyway.
  const trimmedReports = takeMostRecentSessions(collected, SESSION_GAP_MS, sessionsRequested);

  return { guild: firstPageGuild!, reports: trimmedReports, sampleTruncated };
}

// --- "This tier" sample mode ------------------------------------------------
// Instead of a fixed count, this mode pulls in EVERY recent report that
// belongs to the guild's current raid tier -- however many nights that
// actually is, since a tier can run anywhere from a few nights to a couple
// of months. "Current tier" just means "whatever zone the most recent
// report was in."
//
// A guild's report list isn't neatly grouped by zone -- Mythic+ dungeon
// logs and (eventually) the next tier's logs are mixed in by upload date --
// so this has to page through the list checking each report's zone, not
// just take the first page. Two caps protect the API quota from a guild
// with an unusually long report history: TIER_NIGHTS_CAP stops once we've
// found "enough" matching nights (same ceiling as the manual count option,
// so neither mode can out-cost the other); REPORTS_SCAN_CAP (shared with
// collectRecentSessionReports above) stops paginating after looking through
// this many reports total, match or not, in case matches are sparse (e.g. a
// guild that mostly does Mythic+ these days).
const TIER_NIGHTS_CAP = MAX_NIGHTS_FOR_TREND;

// A report's own top-level `zone` is unreliable when it bundles OTHER
// content together with real raid pulls -- most commonly a Mythic+
// keystone or two, logged before that night's raid by the same continuous
// logger. Warcraft Logs then labels the whole report by whichever content
// was logged FIRST, which reads as something like "Mythic+ Season 2" (or
// similar keystone/dungeon wording) even though the report also has real
// current-tier raid pulls in it. That's the specific, confirmed failure
// mode `collectCurrentTierReports` below falls back to a per-fight check
// for (see isTierZoneFight in lib/wowDifficulty.ts) -- this just recognizes
// when a report's zone LOOKS like that kind of non-raid label (or is
// simply missing) so the fallback only runs where it's actually needed,
// not on every report from a genuinely older raid tier.
function looksLikeNonRaidZone(zoneName: string | null | undefined): boolean {
  if (!zoneName) return true;
  return /mythic\s*\+|keystone|dungeon/i.test(zoneName);
}

/**
 * Pages through a guild's report list collecting the reports that belong
 * to the CURRENT tier's raid zone (the most recent report's own zone) --
 * either because the report itself is labeled with that zone, or (for a
 * report whose own label looks like a Mythic+/dungeon log, or has no zone
 * at all) because at least one of its fights is a genuine pull of that
 * zone's content once actually checked (see isTierZoneFight). See the
 * constants above for why this can't just take one page.
 */
async function collectCurrentTierReports(
  name: string,
  serverSlug: string,
  serverRegion: string
): Promise<{ guild: WCLGuild; reports: WCLGuildReportSummary[]; sampleTruncated: boolean }> {
  let page = 1;
  let scanned = 0;
  let tierZoneName: string | null = null;
  // This tier's own difficulty catalog (LFR/Normal/Heroic/Mythic ids,
  // whatever it has) -- fetched once, as soon as the tier's zone id is
  // known, and reused for every report that needs the fallback check
  // below. Left null (fallback never runs) if the most recent report
  // somehow has no zone id to look up.
  let tierZoneDifficulties: WCLZoneDifficulty[] | null = null;
  const matched: WCLGuildReportSummary[] = [];
  let firstPageGuild: WCLGuild | null = null;
  let sampleTruncated = false;

  for (;;) {
    const batch = await getGuildReports(name, serverSlug, serverRegion, {
      limit: REPORTS_PAGE_SIZE,
      page,
    });
    if (page === 1) firstPageGuild = batch;
    const pageReports = batch.reports.data;
    if (pageReports.length === 0) break;

    // The very first report we ever see (the most recent one) IS the
    // current tier -- everything else gets compared against its zone name.
    if (tierZoneName === null) {
      tierZoneName = pageReports[0]?.zone?.name ?? null;
      const tierZoneId = pageReports[0]?.zone?.id;
      if (tierZoneId !== undefined) {
        tierZoneDifficulties = await getZoneDifficulties(tierZoneId);
      }
    }

    for (const report of pageReports) {
      scanned++;
      if (tierZoneName && matchesTierZone(report, tierZoneName)) {
        matched.push(report);
        continue;
      }
      // The cheap zone label didn't match -- normally that means this
      // report really is from a different tier. But when the label itself
      // looks like non-raid content (or is missing), that's not a safe
      // conclusion (see looksLikeNonRaidZone's doc comment above), so
      // actually check this one report's fights before ruling it out.
      if (tierZoneDifficulties && tierZoneDifficulties.length > 0 && looksLikeNonRaidZone(report.zone?.name)) {
        try {
          const meta = await getReportMeta(report.code);
          if (meta.fights.some((f) => isTierZoneFight(f, tierZoneDifficulties!))) {
            matched.push(report);
          }
        } catch {
          // Failed to load while just figuring out which reports belong in
          // the sample -- skip it here rather than failing the whole
          // collection step. If it really does belong, buildGuildTrend's
          // own fetch step will hit the same failure and report it in
          // `failedReports` instead of this report just being absent.
        }
      }
    }

    const hitNightsCap = matched.length >= TIER_NIGHTS_CAP;
    const hitScanCap = scanned >= REPORTS_SCAN_CAP;
    if (hitNightsCap || hitScanCap) {
      // We stopped early because of a cap, not because we ran out of
      // pages -- if there's still more to look at, there might be more of
      // this tier we never checked. The caller surfaces this so the page
      // can say so instead of silently showing a partial sample as if it
      // were the whole tier.
      sampleTruncated = batch.reports.has_more_pages;
      break;
    }
    if (!batch.reports.has_more_pages) break;
    page++;
  }

  return { guild: firstPageGuild!, reports: matched.slice(0, TIER_NIGHTS_CAP), sampleTruncated };
}

export interface GuildTrendResult extends GuildTrendSummary {
  guild: { id: number; name: string; faction: string | null };
  reportsAvailable: number;
  rateLimit: WCLRateLimitStatus | null;
  // True if there might be MORE matching nights than what's shown, because
  // the report-collecting step (collectCurrentTierReports, or
  // collectRecentSessionReports for a manual count) hit one of its safety
  // caps before it ran out of pages to check.
  sampleTruncated: boolean;
  // Reports that WERE in the fetched sample (so they'd otherwise have
  // contributed a raid night below) but failed to load -- deleted between
  // being listed and being fetched, still processing, a transient WCL API
  // error, etc. Previously this was only visible as a
  // "[wcl] skipping a guild report that failed to load" line in the server
  // terminal, which made a night silently vanishing from the table
  // impossible to tell apart from "that night just isn't in the sample" --
  // surfacing it here lets the page show it instead.
  failedReports: { code: string; title: string; reason: string }[];
}

/**
 * Builds the guild trend dashboard: kill rate and death count across the
 * guild's most recent raid nights, plus the most common causes of death
 * over that whole sample.
 *
 * `opts.mythicOnly`, when true, narrows every one of those numbers down to
 * just Mythic-difficulty pulls -- a normal/heroic clear night that had zero
 * Mythic pulls doesn't count as a "raid night" at all in that view, rather
 * than showing up as a row full of zeros.
 *
 * `opts.sampleMode` picks HOW nights get chosen:
 * - "count" (the default): reports covering the `opts.nights` most recent
 *   real raid NIGHTS (not reports -- see collectRecentSessionReports above
 *   and groupIntoSessions in lib/analysis/guild.ts), clamped to
 *   MAX_NIGHTS_FOR_TREND.
 * - "currentTier": every recent report from the guild's current raid tier,
 *   however many nights that is (see collectCurrentTierReports above).
 *   `opts.nights` is ignored in this mode.
 *
 * Either way, `reportsToFetch` below can still end up with more than one
 * report for the same real raid night (a guild that split a night across
 * several logs) -- `aggregateGuildTrend` (lib/analysis/guild.ts) is what
 * actually merges those back into one row per night, at the very end.
 */
export async function buildGuildTrend(
  name: string,
  serverSlug: string,
  serverRegion: string,
  opts?: { mythicOnly?: boolean; nights?: number; sampleMode?: "count" | "currentTier" }
): Promise<GuildTrendResult> {
  // 1. Get the reports to analyze, and the quota check, together -- which
  // reports depends on opts.sampleMode (see above).
  let guild: WCLGuild;
  let reportsToFetch: WCLGuildReportSummary[];
  let sampleTruncated = false;
  let rateLimit: WCLRateLimitStatus | null;
  // Set only in "count" mode -- the exact number of real raid nights to
  // trim aggregateGuildTrend's output down to, once real fight data (and
  // therefore real night boundaries) exists. "This tier" mode wants every
  // night in the tier, however many that is, so it's left undefined and
  // aggregateGuildTrend does no trimming at all.
  let maxNights: number | undefined;

  if (opts?.sampleMode === "currentTier") {
    const [tierResult, rl] = await Promise.all([
      collectCurrentTierReports(name, serverSlug, serverRegion),
      tryGetRateLimitStatus(),
    ]);
    guild = tierResult.guild;
    reportsToFetch = tierResult.reports;
    sampleTruncated = tierResult.sampleTruncated;
    rateLimit = rl;
  } else {
    const nightsRequested = clampNightsRequested(opts?.nights);
    maxNights = nightsRequested;
    const [sessionResult, rl] = await Promise.all([
      collectRecentSessionReports(name, serverSlug, serverRegion, nightsRequested),
      tryGetRateLimitStatus(),
    ]);
    guild = sessionResult.guild;
    reportsToFetch = sessionResult.reports;
    sampleTruncated = sessionResult.sampleTruncated;
    rateLimit = rl;
  }

  // 2. Fetch each raid night's fight/death data separately. If one report
  // fails to load (deleted, still processing, etc.) we don't want that to
  // break the whole guild page -- so each night is fetched independently,
  // and any that fail are just dropped instead of failing everything.
  const nightResults = await Promise.allSettled(
    reportsToFetch.map(async (summary): Promise<GuildNightInput> => {
      const meta = await getReportMeta(summary.code);
      const range = { startTime: 0, endTime: meta.endTime - meta.startTime };
      const deathEntries = await getReportTable(summary.code, "Deaths", range, {
        reportEndTimeMs: meta.endTime,
      });
      // Deaths are built from the FULL fight list (same reasoning as
      // buildReportAnalysis: trash-fight exclusion and fight-name lookups
      // need every fight, not just the Mythic ones) -- `filterNightToMythic`
      // narrows both `fights` and `deaths` down together afterward, only
      // when the toggle is on.
      const night: GuildNightInput = {
        code: summary.code,
        title: summary.title,
        startTime: summary.startTime,
        endTime: meta.endTime,
        zoneName: summary.zone?.name ?? null,
        fights: meta.fights,
        deaths: buildDeathRecords(deathEntries, meta.fights, summary.code),
      };
      if (!opts?.mythicOnly) return night;
      // This report's own zone decides what "Mythic" means here -- a
      // different raid tier can use a different difficulty id (see
      // resolveMythicDifficultyId above), so this has to happen per night,
      // not once for the whole guild.
      const mythicDifficultyId = await resolveMythicDifficultyId(meta.zone?.id);
      return filterNightToMythic(night, mythicDifficultyId);
    })
  );

  // 3. Keep only the nights that loaded successfully. When filtering to
  // Mythic only, also drop any night that had zero Mythic pulls -- it's
  // not part of this sample at all, not a zero-value data point.
  //
  // `nightResults[i]` corresponds to `reportsToFetch[i]` -- Promise.allSettled
  // preserves the order of the promises it was given, and reportsToFetch is
  // exactly what nightResults's map() above iterated over -- so a rejected
  // entry can be matched back to the report summary it came from, to report
  // WHICH report failed (not just that something did).
  const nights: GuildNightInput[] = [];
  const failedReports: { code: string; title: string; reason: string }[] = [];
  nightResults.forEach((result, i) => {
    if (result.status === "fulfilled") {
      if (!opts?.mythicOnly || result.value.fights.length > 0) {
        nights.push(result.value);
      }
    } else {
      const summary = reportsToFetch[i]!;
      const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
      failedReports.push({ code: summary.code, title: summary.title, reason });
      // eslint-disable-next-line no-console
      console.error("[wcl] skipping a guild report that failed to load:", result.reason);
    }
  });

  // 4. Hand the raw per-night data to the analysis layer to sort, combine,
  // and compute the trend -- same split between "getting data" and
  // "making sense of it" as buildReportAnalysis above. `maxNights` is what
  // actually enforces "N nights" now that real night boundaries are
  // computed from real pull data -- collectRecentSessionReports above can
  // only ever fetch too much, never too little (see takeMostRecentSessions
  // in lib/analysis/guild.ts), so this is always working with enough.
  const trend = aggregateGuildTrend(nights, { maxNights });

  return {
    guild: { id: guild.id, name: guild.name, faction: guild.faction?.name ?? null },
    reportsAvailable: guild.reports.total,
    rateLimit,
    sampleTruncated,
    failedReports,
    ...trend,
  };
}

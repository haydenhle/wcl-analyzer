/**
 * This file describes the SHAPE of the data that comes back from the
 * Warcraft Logs API -- which fields exist, and what type each one is.
 * These are TypeScript "types": they don't run any code, they just let the
 * editor and compiler catch mistakes, like using a field that doesn't
 * exist or treating a number as text.
 *
 * This only covers the small slice of Warcraft Logs's API that this app
 * actually uses. If a field's name ever changes on their end, this is the
 * file to fix -- the rest of the app only depends on these types, not the
 * raw API response.
 */

// --- Shared enums / small value types --------------------------------

export type TableDataType = "DamageDone" | "Healing" | "Deaths" | "Casts";

// --- Report metadata (see getReportMeta in queries.ts) -----------------

// One phase boundary within a fight -- `id` is the phase number (1, 2, 3...)
// and `startTime` is when it began, in the same report-relative milliseconds
// as everything else (see WCLFight below). A phase RUNS from its own
// startTime until the next phase's startTime, or the fight's own endTime for
// the last phase -- WCL doesn't send an explicit end for each phase, so
// lib/analysis/playerAnalysis.ts derives it. Not every fight has phases (a
// single-phase tank-and-spank boss has none), so this can be an empty list.
export interface WCLPhaseTransition {
  id: number;
  startTime: number;
}

export interface WCLFight {
  id: number;
  name: string;
  startTime: number;
  endTime: number;
  kill: boolean | null;
  difficulty: number | null;
  encounterID: number;
  bossPercentage: number | null;
  fightPercentage: number | null;
  size: number | null;
  phaseTransitions: WCLPhaseTransition[];
}

export interface WCLReportMeta {
  code: string;
  title: string;
  startTime: number;
  endTime: number;
  zone: { id: number; name: string } | null;
  guild: { id: number; name: string } | null;
  owner: { name: string } | null;
  fights: WCLFight[];
}

export interface WCLReportMetaResponse {
  reportData: {
    report: WCLReportMeta | null;
  };
}

// --- Zone difficulty catalog (see getZoneDifficulties in queries.ts) ------
// Each zone (raid, dungeon, etc.) has its own list of difficulty levels,
// and -- confirmed the hard way -- the numeric id for "Mythic" is NOT the
// same across every zone. This is what lets the app look up the real id
// for a specific report's zone instead of assuming one.

export interface WCLZoneDifficulty {
  id: number;
  name: string;
  sizes: number[];
}

export interface WCLZoneDifficultiesResponse {
  worldData: {
    zone: { id: number; name: string; difficulties: WCLZoneDifficulty[] } | null;
  };
}

// --- Report tables (see getReportTable in queries.ts) -------------------

/**
 * `report.table(...)` returns a table of entries shaped like
 * `{ data: { entries: [...] } }`. It requires a `startTime`/`endTime` (or
 * `fightIDs`) or Warcraft Logs errors out. The damage/healing entries and
 * the deaths entries don't look the same, which is why several fields
 * below are marked optional -- they only show up for one kind of table.
 */
export interface WCLTableAbilityBreakdown {
  guid: number;
  name: string;
  total: number;
  totalReduced?: number;
  type?: number;
  icon?: string;
}

export interface WCLTableEntry {
  name: string;
  id: number;
  guid: number;
  type: string; // class name, e.g. "Warrior"
  icon?: string;
  // DamageDone / Healing table fields
  total?: number;
  activeTime?: number;
  activeTimeReduced?: number;
  abilities?: WCLTableAbilityBreakdown[];
  // Deaths table fields
  timestamp?: number; // ms, relative to report start (matches WCLFight.startTime/endTime)
  fight?: number; // fight ID this death occurred in
  killingBlow?: { name: string; guid: number; type?: number; abilityIcon?: string } | null;
  overkill?: number;
}

export interface WCLTable {
  data?: {
    entries?: WCLTableEntry[];
  };
}

export interface WCLReportTableResponse {
  reportData: {
    report: {
      table: WCLTable | null;
    } | null;
  };
}

// --- Guild report list (see getGuildReports in queries.ts) --------------

export interface WCLGuildReportSummary {
  code: string;
  title: string;
  startTime: number;
  endTime: number;
  zone: { id: number; name: string } | null;
}

/**
 * Warcraft Logs doesn't have a `reports` field directly on `Guild` -- the
 * list of a guild's reports actually comes from a separate
 * `reportData.reports(...)` request, filtered by guild name/server/region.
 * `getGuildReports` in queries.ts asks for both pieces (the guild's info,
 * and its report list) in one request and combines them into this shape,
 * so the rest of the app can treat "a guild" as one object with a
 * `.reports` list on it.
 */
export interface WCLGuildReportsPage {
  data: WCLGuildReportSummary[];
  total: number;
  per_page: number;
  current_page: number;
  has_more_pages: boolean;
}

export interface WCLGuildReportsResponse {
  guildData: {
    guild: {
      id: number;
      name: string;
      faction: { name: string } | null;
    } | null;
  };
  reportData: {
    reports: WCLGuildReportsPage;
  };
}

export interface WCLGuild {
  id: number;
  name: string;
  faction: { name: string } | null;
  reports: WCLGuildReportsPage;
}

// --- Fight rankings / "Parse %" (see getFightRankings in queries.ts) ----

/**
 * `report.rankings(...)` groups characters by role (tanks / healers /
 * dps). Each character's `rankPercent` (0-100) is their percentile ranking
 * -- the same "Parse %" number shown on warcraftlogs.com itself.
 *
 * Only kill fights get ranked -- a wipe fight's rankings come back as an
 * empty list. `getFightRankings` in queries.ts turns that into an empty
 * map either way, so nothing else in the app needs to know ahead of time
 * whether a fight was a kill.
 */
export interface WCLRankingCharacter {
  name: string;
  rankPercent: number;
}

export interface WCLRankingsRoleGroup {
  characters: WCLRankingCharacter[];
}

export interface WCLRankingsFightEntry {
  fightID: number;
  // Grouped by role name ("tanks" | "healers" | "dps"). Left as a loose
  // key -> value type instead of a fixed list, since Warcraft Logs doesn't
  // document exactly which roles can show up here.
  roles: Record<string, WCLRankingsRoleGroup | undefined>;
}

export interface WCLRankingsResponse {
  reportData: {
    report: {
      rankings: { data: WCLRankingsFightEntry[] } | null;
    } | null;
  };
}

// --- "Top log" lookup (see getCharacterRankings in queries.ts) -----------
// `worldData.encounter(id).characterRankings(...)` is a DIFFERENT ranking
// query from `report.rankings(...)` above -- that one ranks the characters
// INSIDE one specific report; this one ranks across every report Warcraft
// Logs has for one boss + difficulty + class + spec, server-wide. Each
// entry carries its own `report.code` + `report.fightID`, which is what
// lets the player-analysis feature jump straight from "here's the #1
// parse" to fetching THAT log's own casts data for comparison.

export interface WCLCharacterRankingEntry {
  name: string;
  class: string;
  spec: string;
  amount: number; // the ranked metric's value (e.g. dps or hps)
  duration: number; // ms
  report: {
    code: string;
    fightID: number;
  };
}

export interface WCLCharacterRankingsResponse {
  worldData: {
    encounter: {
      characterRankings: {
        rankings: WCLCharacterRankingEntry[];
      } | null;
    } | null;
  };
}

// --- Raw events + master data (see getReportEvents / getReportMasterData
// in queries.ts) ------------------------------------------------------------
//
// Shapes confirmed against a live report with
// scripts/wcl-diagnose-buff-events.mjs. Unlike `table()`, which returns
// per-player AGGREGATES, `events()` returns individual timestamped events
// -- the only way to answer "who did THIS buff land on, and when".

// The `dataType` values `events()` accepts (WCL's EventDataType enum --
// only the ones this app uses).
export type EventDataType = "Buffs" | "Casts" | "DamageDone";

/**
 * One raw combat-log event. `timestamp` is report-relative ms, same
 * timeline as WCLFight.startTime/endTime. `sourceID`/`targetID` are actor
 * ids -- resolve them through WCLMasterData.actors. Which optional fields
 * are present depends on `type`: buff events ("applybuff", "removebuff",
 * "refreshbuff", "applybuffstack", "removebuffstack") may carry `stack`;
 * "damage" events carry `amount` (and `absorbed`, when a shield ate some
 * of the hit -- WCL's own damage meters count that too); "cast" events
 * just have source/target/ability.
 */
export interface WCLEvent {
  timestamp: number;
  type: string;
  sourceID?: number;
  targetID?: number;
  abilityGameID?: number;
  fight?: number;
  stack?: number;
  amount?: number;
  absorbed?: number;
}

export interface WCLReportEventsResponse {
  reportData: {
    report: {
      events: { data: WCLEvent[] | null; nextPageTimestamp: number | null } | null;
    } | null;
  };
}

// One participant in a report -- a player, a pet/guardian, or an NPC.
// `icon` is "Class-Spec" for players (e.g. "Evoker-Augmentation"), and
// `petOwner` is the owning player's actor id for pets/guardians (null
// otherwise) -- that's how a buff or a hit landing on "Akaari's Soul" gets
// credited back to the Rogue who summoned it.
export interface WCLActor {
  id: number;
  gameID: number;
  name: string;
  type: string; // "Player" | "Pet" | "NPC" | ...
  subType: string; // class name for players, e.g. "Evoker"
  icon: string;
  server: string | null;
  petOwner: number | null;
}

// One ability seen anywhere in a report. Events only carry the numeric
// `abilityGameID`; this is where the human-readable name lives. Note the
// same name can map to several ids (e.g. "Prescience" the spell vs.
// "Prescience" the buff it applies) -- look ids up by name, not the
// other way around.
export interface WCLAbilityInfo {
  gameID: number;
  name: string;
  icon: string;
  type: string;
}

export interface WCLMasterData {
  actors: WCLActor[];
  abilities: WCLAbilityInfo[];
}

export interface WCLReportMasterDataResponse {
  reportData: {
    report: {
      masterData: WCLMasterData | null;
    } | null;
  };
}

// --- Quota status (see getRateLimitStatus in queries.ts) ----------------

export interface WCLRateLimitStatus {
  limitPerHour: number;
  pointsSpentThisHour: number;
  pointsResetIn: number; // seconds
}

// --- Errors ---------------------------------------------------------------

/**
 * The one error type this app throws for anything Warcraft-Logs-related:
 * missing credentials, a report/guild that doesn't exist, a GraphQL error,
 * hitting the rate limit. Code that calls the API can catch just this one
 * type and show `err.message` to the user, without needing to know which
 * exact failure produced it.
 */
export class WCLApiError extends Error {
  constructor(message: string, public status?: number, public details?: unknown) {
    super(message);
    this.name = "WCLApiError";
  }
}

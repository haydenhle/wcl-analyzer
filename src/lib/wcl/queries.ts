/**
 * This file holds the actual questions ("queries") this app asks the
 * Warcraft Logs API - one function per data need. Each function sends a
 * GraphQL query (a way of asking an API for exactly the fields we want)
 * and hands back clean, typed data.
 *
 * This is the only file that needs to know Warcraft Logs's exact field
 * names. Everything else in the app (starting with service.ts) just calls
 * these functions and works with the results.
 *
 * Things this app can ask for, each documented at its own function below:
 *   - getReportMeta        a report's title, zone, and list of fights
 *   - getReportTable       a report's damage / healing / deaths / casts data
 *   - getFightRankings     how well a player ranked (percentile) on one fight
 *   - getCharacterRankings the top server-wide parses for a boss+class+spec
 *   - getGuildReports      a guild's recent list of reports
 *   - getZoneDifficulties  a zone's difficulty levels (which id is "Mythic")
 *   - getRateLimitStatus   how much of our hourly request quota we've used
 */
import { wclGraphQL } from "./client";
import type {
  EventDataType,
  TableDataType,
  WCLEvent,
  WCLMasterData,
  WCLReportEventsResponse,
  WCLReportMasterDataResponse,
  WCLCharacterRankingEntry,
  WCLCharacterRankingsResponse,
  WCLGuild,
  WCLGuildReportsResponse,
  WCLRankingsResponse,
  WCLRateLimitStatus,
  WCLReportMeta,
  WCLReportMetaResponse,
  WCLReportTableResponse,
  WCLTable,
  WCLTableEntry,
  WCLZoneDifficulty,
  WCLZoneDifficultiesResponse,
} from "./types";
import { WCLApiError } from "./types";

/**
 * How long we cache report data depends on how old the report is. A raid
 * night that ended very recently might still be getting uploaded to, so we
 * only cache it briefly. A report from hours ago is basically frozen, so
 * we can cache it for much longer.
 */
const RECENT_REPORT_THRESHOLD_MS = 2 * 60 * 60 * 1000; // a report counts as "recent" if it ended less than 2 hours ago
const RECENT_REPORT_TTL_MS = 10 * 60_000; // cache a recent report for 10 minutes
const OLD_REPORT_TTL_MS = 24 * 60 * 60_000; // cache an old report for 24 hours

// Picks how long to cache a response, based on when the report ended.
function cacheTtlForReportEndTime(endTimeMs: number | undefined): number {
  if (endTimeMs === undefined) return 60_000; // we don't know the report's age (e.g. it wasn't found) -- don't cache long
  const age = Date.now() - endTimeMs;
  return age < RECENT_REPORT_THRESHOLD_MS ? RECENT_REPORT_TTL_MS : OLD_REPORT_TTL_MS;
}

// --- Report metadata: title, zone, and the list of fights ----------------
// This is always the FIRST request made for a report. We need its start/
// end time to ask for the damage/healing/deaths tables below, and we need
// its list of fights to know each fight's name for the death log.

const REPORT_META_QUERY = /* GraphQL */ `
  query ReportMeta($code: String!) {
    reportData {
      report(code: $code) {
        code
        title
        startTime
        endTime
        zone {
          id
          name
        }
        guild {
          id
          name
        }
        owner {
          name
        }
        fights(killType: All) {
          id
          name
          startTime
          endTime
          kill
          difficulty
          encounterID
          bossPercentage
          fightPercentage
          size
          phaseTransitions {
            id
            startTime
          }
        }
      }
    }
  }
`;

/**
 * Asks Warcraft Logs for one report's basic info: title, zone, and its
 * list of fights. Takes a report code (e.g. "AbCdEfGh"), returns that
 * report's metadata. Always the first thing fetched for a report page.
 */
export async function getReportMeta(code: string): Promise<WCLReportMeta> {
  if (!code) {
    throw new WCLApiError("getReportMeta called with an empty report code (this is an app bug, not a WCL error).");
  }
  const data = await wclGraphQL<WCLReportMetaResponse>(
    REPORT_META_QUERY,
    { code },
    {
      cacheKey: `report-meta:${code}`,
      cacheTtlMs: (d) => cacheTtlForReportEndTime(d.reportData.report?.endTime),
    }
  );
  const report = data.reportData.report;
  if (!report) {
    throw new WCLApiError(`No report found for code "${code}". Double-check the report URL/code.`);
  }
  return report;
}

// --- Report tables: damage / healing / deaths / casts ----------------------
// One query handles all four tables. Which one we get back depends on the
// `dataType` we pass in (DamageDone, Healing, Deaths, or Casts) -- each
// shape is a bit different, which is why `WCLTableEntry` in types.ts has
// separate optional fields for each kind of table. Casts entries reuse the
// same `abilities` breakdown shape as DamageDone/Healing -- just cast COUNTS
// per ability instead of damage/healing amounts.

const REPORT_TABLE_QUERY = /* GraphQL */ `
  query ReportTable(
    $code: String!
    $fightIDs: [Int]
    $dataType: TableDataType!
    $startTime: Float!
    $endTime: Float!
  ) {
    reportData {
      report(code: $code) {
        table(fightIDs: $fightIDs, dataType: $dataType, startTime: $startTime, endTime: $endTime)
      }
    }
  }
`;

/**
 * Asks Warcraft Logs for one of a report's data tables: who did how much
 * damage, who did how much healing, or who died and when.
 *
 * Needs a time range (or a list of fight IDs) -- Warcraft Logs returns a
 * generic error if you ask without one of those. `range` is usually
 * `{ startTime: 0, endTime: <report duration> }` for the whole report, or
 * one fight's own start/end time to scope to just that fight.
 *
 * `reportEndTimeMs` (the report's end time, from `getReportMeta`) is
 * optional but worth passing -- it lets the response be cached longer when
 * the report is old (see cacheTtlForReportEndTime above).
 */
export async function getReportTable(
  code: string,
  dataType: TableDataType,
  range: { startTime: number; endTime: number },
  opts?: { fightIDs?: number[]; reportEndTimeMs?: number }
): Promise<WCLTableEntry[]> {
  if (!code) {
    throw new WCLApiError("getReportTable called with an empty report code (this is an app bug, not a WCL error).");
  }
  const fightIDs = opts?.fightIDs;
  // If the time range is empty (start >= end) and we're not scoped to
  // specific fights, there's nothing to fetch. Skip the request instead of
  // sending one that can't succeed anyway -- Warcraft Logs returns a
  // confusing generic error for an empty/negative range, not just an empty
  // result.
  if (!fightIDs?.length && range.endTime <= range.startTime) {
    return [];
  }
  const data = await wclGraphQL<WCLReportTableResponse>(
    REPORT_TABLE_QUERY,
    { code, fightIDs: fightIDs ?? null, dataType, startTime: range.startTime, endTime: range.endTime },
    {
      cacheKey: `report-table:${code}:${dataType}:${range.startTime}-${range.endTime}:${(fightIDs ?? []).join(",")}`,
      cacheTtlMs: cacheTtlForReportEndTime(opts?.reportEndTimeMs),
    }
  );

  const table: WCLTable | null | undefined = data.reportData.report?.table;
  return table?.data?.entries ?? [];
}

// --- Master data: every actor + ability name in a report -----------------
// Raw events (below) only carry numeric actor/ability ids. This is the
// lookup table that turns them back into names, classes/specs, and pet ->
// owner links.

const REPORT_MASTER_DATA_QUERY = /* GraphQL */ `
  query ReportMasterData($code: String!) {
    reportData {
      report(code: $code) {
        masterData {
          actors {
            id
            gameID
            name
            type
            subType
            icon
            server
            petOwner
          }
          abilities {
            gameID
            name
            icon
            type
          }
        }
      }
    }
  }
`;

export async function getReportMasterData(code: string, reportEndTimeMs?: number): Promise<WCLMasterData> {
  const data = await wclGraphQL<WCLReportMasterDataResponse>(
    REPORT_MASTER_DATA_QUERY,
    { code },
    {
      cacheKey: `report-master-data:${code}`,
      cacheTtlMs: cacheTtlForReportEndTime(reportEndTimeMs),
    }
  );
  const masterData = data.reportData.report?.masterData;
  if (!masterData) {
    throw new WCLApiError(`No report found for code "${code}".`);
  }
  return masterData;
}

// --- Raw events: individual timestamped buff/cast/damage events ------------
// `events` is a real GraphQL object (ReportEventPaginator), not a bare JSON
// scalar like `table` -- it needs the `{ data nextPageTimestamp }`
// sub-selection, and it's PAGINATED: one page holds roughly 10,000 events,
// and a busy raid fight's unfiltered friendly buff stream overflowed one
// page in under a minute of fight time (found with
// scripts/wcl-diagnose-buff-events.mjs). So this keeps asking for the next
// page, starting from `nextPageTimestamp`, until WCL stops returning one.
//
// Filtering by `abilityID` (one id per call) is the reliable way to narrow
// this down -- the same diagnostic found that filtering by `sourceID`
// silently dropped real Prescience applications that an `abilityID`-only
// query returned, so this deliberately doesn't offer a sourceID filter.
// Filter by source in code instead, after fetching.

const REPORT_EVENTS_QUERY = /* GraphQL */ `
  query ReportEvents(
    $code: String!
    $dataType: EventDataType!
    $fightIDs: [Int]
    $startTime: Float!
    $endTime: Float!
    $abilityID: Float
    $hostilityType: HostilityType
  ) {
    reportData {
      report(code: $code) {
        events(
          dataType: $dataType
          fightIDs: $fightIDs
          startTime: $startTime
          endTime: $endTime
          abilityID: $abilityID
          hostilityType: $hostilityType
          useAbilityIDs: true
          useActorIDs: true
        ) {
          data
          nextPageTimestamp
        }
      }
    }
  }
`;

// Safety cap on pages per getReportEvents call -- each page is one API
// request, and an unfiltered damage stream for a long fight is the one
// thing in this app that could otherwise ask for dozens in a row.
const MAX_EVENT_PAGES = 60;

export interface ReportEventsResult {
  events: WCLEvent[];
  // True if MAX_EVENT_PAGES stopped us before WCL ran out of pages --
  // anything computed from `events` is then missing the tail of the range.
  truncated: boolean;
}

export async function getReportEvents(
  code: string,
  opts: {
    dataType: EventDataType;
    startTime: number;
    endTime: number;
    fightIDs?: number[];
    abilityID?: number;
    hostilityType?: "Friendlies" | "Enemies";
    reportEndTimeMs?: number;
  }
): Promise<ReportEventsResult> {
  const events: WCLEvent[] = [];
  let cursor = opts.startTime;
  for (let page = 0; page < MAX_EVENT_PAGES; page++) {
    const variables = {
      code,
      dataType: opts.dataType,
      fightIDs: opts.fightIDs ?? null,
      startTime: cursor,
      endTime: opts.endTime,
      abilityID: opts.abilityID ?? null,
      hostilityType: opts.hostilityType ?? null,
    };
    const data = await wclGraphQL<WCLReportEventsResponse>(REPORT_EVENTS_QUERY, variables, {
      cacheKey: `report-events:${code}:${JSON.stringify(variables)}`,
      cacheTtlMs: cacheTtlForReportEndTime(opts.reportEndTimeMs),
    });
    const paginator = data.reportData.report?.events;
    events.push(...(paginator?.data ?? []));
    const next = paginator?.nextPageTimestamp;
    // No next page (or one that wouldn't move us forward) means we're done.
    if (next == null || next <= cursor || next >= opts.endTime) {
      return { events, truncated: false };
    }
    cursor = next;
  }
  return { events, truncated: true };
}

// --- Fight rankings: percentile ranking ("Parse %") -----------------------
// This only makes sense for ONE specific fight (a single kill or wipe) --
// Warcraft Logs compares that one pull's damage/healing against everyone
// else's logs of the same fight, not several pulls combined. service.ts
// only calls this when exactly one fight is selected.

const FIGHT_RANKINGS_QUERY = /* GraphQL */ `
  query FightRankings($code: String!, $fightID: Int!, $playerMetric: ReportRankingMetricType!) {
    reportData {
      report(code: $code) {
        rankings(fightIDs: [$fightID], compare: Rankings, playerMetric: $playerMetric)
      }
    }
  }
`;

// The two metrics this app cares about: "dps" (damage per second) feeds the
// damage chart, "hps" (healing per second) feeds the healing chart. WCL
// supports other metric values, but they don't apply to a normal raid
// fight.
export type RankingMetric = "dps" | "hps";

/**
 * Asks Warcraft Logs how each character ranked (0-100 percentile) on one
 * fight, for one metric (damage or healing). Returns a map of character
 * name -> percentile.
 *
 * A couple of things worth knowing:
 * - Wipes don't get ranked -- Warcraft Logs returns no ranking data for a
 *   wipe fight, so this returns an empty map instead of throwing.
 * - `playerMetric` must be passed explicitly. If it's left out, Warcraft
 *   Logs defaults to "dps" for every character, even healers -- which is
 *   why the damage chart and the healing chart each need their own
 *   separate call instead of sharing one result.
 */
export async function getFightRankings(
  code: string,
  fightID: number,
  playerMetric: RankingMetric
): Promise<Map<string, number>> {
  const data = await wclGraphQL<WCLRankingsResponse>(
    FIGHT_RANKINGS_QUERY,
    { code, fightID, playerMetric },
    {
      cacheKey: `fight-rankings:${code}:${fightID}:${playerMetric}`,
      // Percentile rankings only shift slowly as more logs get uploaded
      // across the whole game, so it's safe to cache these for a full hour
      // -- longer than we cache the report's own damage/healing tables.
      cacheTtlMs: 60 * 60_000,
    }
  );
  const fightEntry = data.reportData.report?.rankings?.data?.[0];
  const percentByName = new Map<string, number>();
  if (!fightEntry) return percentByName;
  for (const role of Object.values(fightEntry.roles ?? {})) {
    for (const character of role?.characters ?? []) {
      percentByName.set(character.name, character.rankPercent);
    }
  }
  return percentByName;
}

// --- "Top log" lookup: server-wide character rankings ----------------------
// A DIFFERENT ranking query from getFightRankings above. That one ranks the
// players INSIDE one specific report against each other; this one ranks
// across every log Warcraft Logs has for one boss + difficulty + class +
// spec, server-wide -- it's how the player-analysis feature finds "the #1
// log" to compare someone's casts against. `worldData.encounter(id)` is the
// same root pattern as `worldData.zone(id)` (see getZoneDifficulties above).

const CHARACTER_RANKINGS_QUERY = /* GraphQL */ `
  query CharacterRankings(
    $encounterID: Int!
    $className: String!
    $specName: String!
    $difficulty: Int!
    $metric: CharacterRankingMetricType
  ) {
    worldData {
      encounter(id: $encounterID) {
        characterRankings(
          className: $className
          specName: $specName
          difficulty: $difficulty
          metric: $metric
        )
      }
    }
  }
`;

/**
 * Asks Warcraft Logs for the top server-wide parses of one boss, for one
 * class + spec + difficulty + metric (damage or healing). Each entry carries
 * its own `report.code` + `report.fightID` -- that's how the caller can go
 * fetch THAT log's own data for a side-by-side comparison, without needing
 * to know ahead of time which report happens to hold the #1 parse.
 *
 * `metric` reuses the same "dps" / "hps" values as getFightRankings' -- the
 * caller picks based on the analyzed player's role (see
 * lib/analysis/playerAnalysis.ts's roleForSpec).
 */
export async function getCharacterRankings(
  encounterID: number,
  className: string,
  specName: string,
  difficulty: number,
  metric: RankingMetric
): Promise<WCLCharacterRankingEntry[]> {
  const data = await wclGraphQL<WCLCharacterRankingsResponse>(
    CHARACTER_RANKINGS_QUERY,
    { encounterID, className, specName, difficulty, metric },
    {
      cacheKey: `character-rankings:${encounterID}:${className}:${specName}:${difficulty}:${metric}`,
      // Same reasoning as getFightRankings: server-wide rankings only shift
      // slowly as new logs get uploaded, so an hour-long cache is safe.
      cacheTtlMs: 60 * 60_000,
    }
  );
  return data.worldData.encounter?.characterRankings?.rankings ?? [];
}

// --- Guild report list ----------------------------------------------------
// Warcraft Logs doesn't have a single field for "this guild's reports" --
// we have to ask for two things in one request: the guild's own info, and
// the report list (filtered by guild name/server/region), then combine
// them ourselves below (see `WCLGuildReportsPage` in types.ts).
const GUILD_REPORTS_QUERY = /* GraphQL */ `
  query GuildReports(
    $name: String!
    $serverSlug: String!
    $serverRegion: String!
    $limit: Int!
    $page: Int!
  ) {
    guildData {
      guild(name: $name, serverSlug: $serverSlug, serverRegion: $serverRegion) {
        id
        name
        faction {
          name
        }
      }
    }
    reportData {
      reports(
        guildName: $name
        guildServerSlug: $serverSlug
        guildServerRegion: $serverRegion
        limit: $limit
        page: $page
      ) {
        data {
          code
          title
          startTime
          endTime
          zone {
            id
            name
          }
        }
        total
        per_page
        current_page
        has_more_pages
      }
    }
  }
`;

/**
 * Asks Warcraft Logs for a guild's info and its recent list of reports,
 * and combines them into one object. Takes the guild's name, server, and
 * region.
 */
export async function getGuildReports(
  name: string,
  serverSlug: string,
  serverRegion: string,
  opts?: { limit?: number; page?: number }
): Promise<WCLGuild> {
  const limit = opts?.limit ?? 16;
  const page = opts?.page ?? 1;

  const data = await wclGraphQL<WCLGuildReportsResponse>(
    GUILD_REPORTS_QUERY,
    { name, serverSlug, serverRegion, limit, page },
    {
      cacheKey: `guild-reports:${serverRegion}:${serverSlug}:${name}:${page}:${limit}`,
      // A guild's list of reports changes at most once per raid night, so
      // it's safe to cache this for a couple of hours.
      cacheTtlMs: 2 * 60 * 60_000,
    }
  );

  const guild = data.guildData.guild;
  if (!guild) {
    throw new WCLApiError(
      `No guild found for "${name}" on ${serverSlug}-${serverRegion}. Check the spelling, ` +
        `server, and region (e.g. us, eu, kr, tw, cn).`
    );
  }
  // Warcraft Logs gives us the guild info and the report list as two
  // separate pieces of the response -- combine them here so the rest of
  // the app can treat "a guild" as one object that has a `.reports` list
  // on it.
  return { ...guild, reports: data.reportData.reports };
}

// --- Zone difficulty catalog -----------------------------------------------
// Used by the guild page's "Mythic only" filter. `WCLFight.difficulty` is
// just a raw number, and it turns out that number is assigned PER RAID
// TIER, not globally -- a fight with difficulty 4 was Mythic in one tier's
// zone, but difficulty 5 in a newer tier's zone. This looks up one zone's
// own difficulty list so the app can find whichever id that zone itself
// calls "Mythic", instead of hardcoding a number that only works for one
// tier. See lib/wowDifficulty.ts for how the result gets used.

const ZONE_DIFFICULTIES_QUERY = /* GraphQL */ `
  query ZoneDifficulties($zoneID: Int!) {
    worldData {
      zone(id: $zoneID) {
        id
        name
        difficulties {
          id
          name
          sizes
        }
      }
    }
  }
`;

/**
 * Asks Warcraft Logs for one zone's list of difficulties (id/name/sizes),
 * e.g. Mythic/Heroic/Normal/LFR for a raid zone. A zone's difficulty list
 * is fixed once a raid tier ships, so this is cached for a full week --
 * far longer than any other request in this app.
 */
export async function getZoneDifficulties(zoneId: number): Promise<WCLZoneDifficulty[]> {
  const data = await wclGraphQL<WCLZoneDifficultiesResponse>(
    ZONE_DIFFICULTIES_QUERY,
    { zoneID: zoneId },
    {
      cacheKey: `zone-difficulties:${zoneId}`,
      cacheTtlMs: 7 * 24 * 60 * 60_000,
    }
  );
  return data.worldData.zone?.difficulties ?? [];
}

// --- This app's own quota usage -------------------------------------------

const RATE_LIMIT_QUERY = /* GraphQL */ `
  query {
    rateLimitData {
      limitPerHour
      pointsSpentThisHour
      pointsResetIn
    }
  }
`;

/**
 * Asks Warcraft Logs how much of our hourly request quota we've used.
 * This isn't tied to any specific report or guild, so it's cheap to check,
 * and lets the UI show the user how close we are to the limit.
 */
export async function getRateLimitStatus(): Promise<WCLRateLimitStatus> {
  const data = await wclGraphQL<{ rateLimitData: WCLRateLimitStatus }>(
    RATE_LIMIT_QUERY,
    {},
    { cacheKey: "rate-limit-status", cacheTtlMs: 60_000 }
  );
  return data.rateLimitData;
}

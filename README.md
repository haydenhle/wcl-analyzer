# WCL Analyzer

A small full-stack app that pulls raid logs from [Warcraft Logs](https://www.warcraftlogs.com)
and turns them into patterns instead of raw parses: who did the damage/healing, what's killing
people, and how a guild trends across raid nights.

Two entry points:

- **Single report** — paste a report URL/code, get a damage/healing ranking, a death log, and a
  breakdown of what killed people and when.
- **Guild** — enter a guild's name/realm/region, get a trend view across its most recent raid
  nights: kill rate over time, deaths per night, and the most common causes of death.

## Stack & why

- **Next.js 15 (App Router) + TypeScript** — one codebase for the UI and the API layer (server
  components fetch data directly; API routes exist alongside them for future client-side re-fetch
  use cases). Deploys as a single Vercel project.
- **Warcraft Logs API v2 (GraphQL)**, OAuth2 client-credentials flow — this app never asks a user
  to log in; it authenticates as *itself* to read public log data, which is all this app needs.
- **Tailwind CSS**, **Recharts** for charts, built to the accessibility/contrast rules in the
  in-repo dataviz guidelines (single-hue ranking bars, one axis per chart, always-visible legends
  where relevant, hover tooltips).
- **Vitest** for the analysis layer — the part of the app with actual logic worth testing.

## Architecture

```
src/
  lib/
    wcl/
      client.ts     OAuth token fetch/cache + GraphQL request helper, response caching,
                     a defensive request throttle
      queries.ts     GraphQL query strings + typed fetch functions
      service.ts     Orchestration: combines queries + analysis into what the UI needs
      types.ts       Hand-written types for the slice of the WCL schema this app uses
    analysis/
      report.ts      Pure functions: rank a damage/healing table, build death records,
                      summarize fights (kills/wipes)
      guild.ts        Pure function: aggregate a set of raid nights into a trend
  app/
    page.tsx                            Landing page (report + guild search forms)
    report/[code]/page.tsx              Single-report dashboard (server component)
    guild/[region]/[server]/[name]/     Guild trend dashboard (server component)
    api/report/[code]/route.ts          JSON API mirror of the report page's data
    api/guild/route.ts                  JSON API mirror of the guild page's data
  components/                           UI + chart components
  test/                                 Vitest suite + fixtures for the analysis layer
```

The split that matters most for talking about this in an interview: **lib/wcl** knows how to talk
to Warcraft Logs and returns typed data; **lib/analysis** is pure, side-effect-free functions that
turn that data into rankings/trends and are unit tested without any network access; **service.ts**
is the only place that wires the two together. Pages and API routes are thin consumers of
`service.ts` — the same functions back both a server-rendered page and a JSON endpoint, so nothing
is duplicated.

### Design decisions worth mentioning

- **Why client-credentials, not user OAuth?** This app only reads public report/guild data, which
  WCL exposes to any authenticated API client — there's no need to make a visitor log in with
  their Warcraft Logs account just to look up a guild.
- **Caching & rate limits, per WCL's own guidance.** A free WCL API client gets 3,600 points/hour,
  reset on a rolling 1-hour cycle. WCL's API docs spell out a caching policy (cache report metadata
  for ~10 min if the report ended in the last couple hours, effectively indefinitely once it's
  older; cache guild/ranking data for hours) — `lib/wcl/queries.ts`'s `cacheTtlForReportEndTime`
  implements exactly that instead of one flat TTL for everything. `lib/cache.ts` provides the
  underlying in-memory TTL cache, plus a defensive sliding-window throttle on raw requests as a
  backstop. Both are process-local — fine for a single small deployment, and documented as the
  first thing to swap for Redis/Vercel KV if this became a real multi-instance service.
- **Quota visibility.** Rather than only guessing at usage, the app calls WCL's own `rateLimitData`
  query (`getRateLimitStatus` in `lib/wcl/queries.ts`) and shows the live points-spent-this-hour on
  both dashboards (`RateLimitTile`) — it's a best-effort check that never blocks the page if it
  fails, since it's purely informational.
- **Guild trend cost tradeoff.** Building a guild's trend view requires fetching fight + death data
  for each of its recent reports individually (WCL's guild endpoint only returns report summaries,
  not full detail). `MAX_NIGHTS_FOR_TREND` in `lib/wcl/service.ts` caps this at 8 nights by default
  to keep page loads and point spend reasonable — bump it if your API client has the
  Patreon-boosted rate limit.
- **Death attribution.** Deaths-table entries carry the fight ID they occurred in directly (`fight`),
  so `buildDeathRecords` in `lib/analysis/report.ts` just looks that fight up for a name and turns
  the report-relative `timestamp` into "how far into that pull" — no time-window guessing (covered
  by `src/test/analysis.report.test.ts`).
- **Scope.** "Analyze a character's logs" is handled by opening a specific report and reading that
  player's row in the rankings/death log, rather than a separate character-search feature — that
  keeps the API surface (and the WCL point budget) small. Character-level history via
  `characterData` is a natural next step (see below).

## Setup

1. **Create a Warcraft Logs API client:** [warcraftlogs.com/api/clients](https://www.warcraftlogs.com/api/clients/) →
   Create Client. Leave "Public Client" **unchecked** (this app needs a client secret for the
   client-credentials flow) and put anything in the redirect URL field (e.g. `http://localhost:3000`) —
   it's required by the form but unused by this flow.
2. Copy `.env.example` to `.env.local` and fill in the client ID/secret:
   ```
   cp .env.example .env.local
   ```
3. Install and run:
   ```
   npm install
   npm run dev
   ```
   Open http://localhost:3000.
4. Run the tests:
   ```
   npm test
   ```

## Verifying against the live schema

The WCL v2 schema is introspectable (open the GraphiQL explorer at
`https://www.warcraftlogs.com/api/v2/client` with a bearer token, or use a tool like Insomnia). The
query strings in `lib/wcl/queries.ts` were originally hand-written against the documented v2
schema, then corrected against the live API — two things weren't documented anywhere public:

- `report.table(...)` **requires** `startTime`/`endTime` (or `fightIDs`) or it throws a generic
  `"Internal server error"` rather than a helpful validation error — and this isn't just about
  *omitting* them: an explicit `endTime: 0` (which happens for a handful of real reports whose
  `endTime === startTime`, e.g. an empty/near-instant log) hits the same bug, since the API seems to
  treat a falsy value the same as a missing one. `getReportTable` short-circuits to `[]` for a
  zero/negative range instead of making a doomed request.
- The JSON payload is wrapped one level deeper than expected — `table.data.entries`, not
  `table.entries` — and the Deaths table's entries carry a `fight` ID and a `killingBlow` object
  directly, rather than the flatter shape the API's own (sparse) docs implied.
- `reports` is **not** a field on `Guild` (`Cannot query field "reports" on type "Guild"`) — report
  search lives on the `reportData.reports(...)` root field, filtered by
  `guildName`/`guildServerSlug`/`guildServerRegion`. `getGuildReports` queries `guildData.guild` and
  `reportData.reports` as sibling root fields in one request and merges them, so the rest of the app
  can keep treating "a guild" as one object with a `.reports` page on it.

Because a single bad report can't be fully ruled out ahead of time, `buildGuildTrend` also fetches
each raid night independently with `Promise.allSettled` and drops any that fail (logging why)
instead of one bad night taking down the whole guild page.

- Percentile rankings ("Parse %") live on `report.rankings(fightIDs:, compare:, playerMetric:, ...)`,
  not `characterRankings`/`playerRankings` as the docs' own naming might suggest — it returns a JSON
  blob shaped `{ data: [{ roles: { tanks/healers/dps: { characters: [{ name, rankPercent, ... }] } } } ] }`.
  The player-metric argument's enum is called `ReportRankingMetricType`, not `PlayerMetric`, and its
  legal values (confirmed via live introspection) include a lot of near-miss dead ends —
  `bosscdps`/`bossndps`/`bossrdps`/`krsi`/`tankhps`/`cdps`/`ndps`/`rdps` all return a generic
  `"Internal server error"` for a normal raid fight, and `wdps`/`playerscore` resolve but come back
  empty. The two that matter here are `dps` and `hps`.
  **`playerMetric` must be passed explicitly, and once per metric.** Omitting it doesn't give each
  character their own "natural" metric (healing for healers, damage for DPS) — it silently defaults
  to `dps` for EVERY character, tanks and healers included — and each explicit metric returns a
  `rankPercent` for every role bucket, not just the "expected" one (e.g. `hps` gives a real
  percentile for a DPS player's incidental self/cleave healing). An early version of this feature
  made one `rankings` call without `playerMetric` and reused the single result for both the damage
  and healing charts, which is what caused a player's damage percentile to show up on the healing
  chart too — fixed by firing two separate calls (`playerMetric: dps` and `playerMetric: hps`) and
  keeping their results in two separate maps.
  Also confirmed: **WCL only ranks kills.** Passing a wipe fight's ID resolves cleanly (no error) but
  `data` comes back as an empty array — confirmed against a real wipe pull, not assumed. That's why
  `getFightRankings` returns an empty `Map` either way instead of throwing: an empty map already
  reads as "nothing to show" everywhere it's consumed, so callers never need to ask "was this a
  kill?" themselves.

- **A raid's "Mythic" difficulty id is per-zone, not global — and it's easy to get burned by testing
  against just one raid tier.** The guild page's "Mythic only" filter first shipped hardcoded to
  `difficulty === 4`, confirmed against one real report at the time. That held up for a while, then
  quietly broke: once a new raid tier ("The Venomous Abyss") launched, its real Mythic pulls came
  back as `difficulty: 5` instead — confirmed with `scripts/wcl-diagnose-difficulty.mjs` against a
  fresh report, where every fight was either `difficulty: 5` (always paired with `size: 20`, the
  player count Mythic raids are locked to) or `null` (trash). Interestingly, `5` also matches what
  `worldData.zone(id).difficulties` calls "Mythic" for that zone — the two sources agreed this time,
  they just hadn't for the older tier. The fix: stop hardcoding a number at all. `getZoneDifficulties`
  looks up each report's own zone and finds whichever id THAT zone calls "Mythic"
  (`findMythicDifficultyId` in `lib/wowDifficulty.ts`), cached for a week since a raid tier's
  difficulty list never changes once it ships. `isMythicFight` also now requires `size === 20`
  alongside the difficulty match, so a Mythic+ (keystone) dungeon pull — 5-player content that can
  share the same "Mythic" difficulty id in its own zone's catalog — never gets counted as a raid
  Mythic pull.

- **Player analysis: casts-per-minute vs. the server-wide top log.** This feature compares one
  player's ability-cast rate and throughput against Warcraft Logs' own #1-ranked parse for the same
  boss + difficulty + class + spec, broken down by fight phase. Confirmed live with
  `scripts/wcl-diagnose-player-analysis.mjs`:
  - `TableDataType` includes a `Casts` value alongside `DamageDone`/`Healing`/`Deaths`. A
    `table(dataType: Casts, ...)` response reuses the exact same entry shape as damage/healing tables
    (`{ name, id, guid, type, icon, total, abilities: [{ guid, name, total, ... }], ... }`) — `total`
    is a cast COUNT (not an amount), already summed over whatever time range was requested, and each
    `abilities[].total` is that one ability's own cast count over the same range.
  - **`table()`'s `startTime`/`endTime` genuinely filters by absolute report-relative time — it is
    NOT fight-local.** `WCLFight.startTime`/`endTime` (from `fights()`) are already absolute offsets
    from the report's own start (e.g. a fight starting 5+ minutes into a 2-hour report has
    `startTime: 5090808`, not `0`). An early version of the diagnostic script treated a fight's own
    bounds as if they were fight-local (`{ startTime: 0, endTime: fight.endTime - fight.startTime }`)
    and got zero results back for a real fight, because that window didn't overlap the fight's real
    position on the report's timeline. The fix — and the thing this confirms — is to pass a window's
    own absolute bounds directly. This is what makes per-phase-scoped `table()` calls work at all:
    narrow the range to one phase's own absolute start/end and the result is scoped to just that
    phase, no `fightIDs`-only trick needed.
  - `ReportFight` has a `phaseTransitions` field: `[{ id: Int, startTime: Float }]`, confirmed with
    real 3-4 phase data. WCL sends only each phase's *start* — there's no explicit end — so a phase's
    end has to be derived as the next phase's start, or the fight's own `endTime` for the last phase
    (`buildPhaseWindows` in `lib/analysis/playerAnalysis.ts`). Single-phase bosses just return an
    empty list, not a single implicit phase.
  - `worldData.encounter(id).characterRankings(className, specName, difficulty, metric, ...)` is a
    **different** query from `report.rankings(...)` above — that one ranks players inside one report
    against each other; this one ranks every log Warcraft Logs has for one boss + difficulty + class
    + spec, server-wide. It returns `{ rankings: [{ name, class, spec, amount, duration, report: {
    code, fightID }, ... }] }` — `report.code` + `report.fightID` is what lets the app jump straight
    from "here's the #1 parse" to fetching that exact log's own data, without a separate lookup.
    `amount` is a rate computed over the fight's whole wall-clock `duration` in ms (confirmed: a real
    entry's `duration` exactly matched its own fight's `endTime - startTime`), matching how
    `buildPlayerWindowStats` computes `throughputPerSecond` here — both sides of the comparison use
    the same denominator. `CharacterRankingMetricType` reuses the same `dps`/`hps` values as
    `ReportRankingMetricType` (see above) for the two roles this app cares about.
  - `class`/`spec` aren't split fields on a damage/healing/casts table entry — they're packed into one
    `icon` string, e.g. `"Priest-Shadow"` or `"DemonHunter-Vengeance"` (`parseClassSpecFromIcon`).
    Role (dps/healer/tank) isn't in the API at all — it's fixed by the game's own class design, so
    it's hardcoded in `lib/wowSpecRoles.ts`, the same way `lib/wowClassColors.ts` hardcodes Blizzard's
    real class colors.
  - `events(dataType: Casts, ...)` returns a `ReportEventPaginator`, which — unlike `table(...)` — is
    an object type and needs its own sub-selection (`{ data nextPageTimestamp }`) or WCL errors with
    `"Field \"events\" of type \"ReportEventPaginator\" must have a sub selection."`. Investigated as
    an alternative to `table()` for this feature, but not used in the end — per-phase `table()` calls
    are simpler and already give exactly the aggregated counts this feature needs.

`scripts/wcl-diagnose.mjs`, `scripts/wcl-diagnose-rankings.mjs`,
`scripts/wcl-diagnose-rankings-metric.mjs`, `scripts/wcl-diagnose-difficulty.mjs`, and
`scripts/wcl-diagnose-player-analysis.mjs` are the tools that found all of this: standalone Node
scripts (no npm install needed) that hit the live GraphQL endpoint directly — one with a few argument
variants, one via live introspection of the `Report` type plus a real kill/wipe call, one that
introspects `ReportRankingMetricType` and fires a live call per enum value, one that prints a report's
zone difficulty catalog alongside every fight's raw difficulty/kill/size, and one that covers
`phaseTransitions`, the `Casts` table, `characterRankings`, and `events` — and print the full,
untruncated response. Worth keeping all of them around for the next time a field (or a raid tier's
numbering) drifts. If a field ever comes back missing/renamed again, `lib/wcl/queries.ts` and
`lib/wcl/types.ts` are the only places that need to change; the analysis layer is insulated from the
raw API shape by design.

## Deploying

Deploy-ready for Vercel: push this repo, import it in Vercel, and set `WCL_CLIENT_ID` /
`WCL_CLIENT_SECRET` as environment variables in the project settings. No other config needed —
`next.config.mjs` has no special build steps.

## What I'd add next

- Character-level search (`characterData.character(...)`) so you can pull one player's recent
  logs across multiple guilds/reports instead of opening a report first.
- A persistent cache (Redis/Vercel KV/SQLite) so the point budget survives redeploys and is shared
  across serverless instances.
- More metrics: interrupts, dispels, buff/debuff uptime, and a "damage taken" table to correlate
  avoidable-damage patterns with deaths.
- A commercial-use review before ever monetizing this: WCL's API terms require prior approval for
  apps earning revenue through ads, subscriptions, or selling data — fine for a portfolio project,
  but worth flagging if this ever became a real product.

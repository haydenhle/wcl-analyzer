/**
 * This is the guild dashboard page, shown at a URL like
 * "/guild/us/area-52/My Guild Name". It shows trends across a guild's
 * recent raid nights (kill rate over time, deaths over time, etc.),
 * instead of one single report.
 *
 * Same shape as the report page: it's a Server Component (renders on the
 * server before your browser sees it), one call (`buildGuildTrend`) does
 * all the data fetching, and a try/catch shows a friendly error box
 * instead of crashing if something goes wrong (bad guild name, no reports
 * found, etc.).
 */
import { DeathsPanel } from "@/components/DeathsPanel";
import { MythicOnlyToggle } from "@/components/MythicOnlyToggle";
import { NightsSampleSelector } from "@/components/NightsSampleSelector";
import { TrendLineChart } from "@/components/charts/TrendLineChart";
import { ErrorState } from "@/components/ui/ErrorState";
import { RateLimitTile } from "@/components/ui/RateLimitTile";
import { StatTile } from "@/components/ui/StatTile";
import { formatDate, formatPercent } from "@/lib/format";
import { buildGuildTrend } from "@/lib/wcl/service";
import { WCLApiError } from "@/lib/wcl/types";

export const revalidate = 0;

export default async function GuildPage({
  params,
  searchParams,
}: {
  params: Promise<{ region: string; server: string; name: string }>;
  searchParams: Promise<{ mythic?: string; nights?: string }>;
}) {
  // region/server/name come straight from the URL, e.g.
  // /guild/us/area-52/My%20Guild -> region="us", server="area-52",
  // name="My%20Guild". Guild names can have spaces/apostrophes, so they're
  // URL-encoded in the link; decode it back before using it anywhere.
  const { region, server, name } = await params;
  const guildName = decodeURIComponent(name);
  // `?mythic=1` comes from the MythicOnlyToggle button below -- when it's
  // set, buildGuildTrend narrows every number on this page down to just
  // Mythic-difficulty pulls. `?nights=` comes from NightsSampleSelector: a
  // plain number ("16") for "my last N nights", or the literal word "tier"
  // for "every night from my current raid tier, whatever that count is".
  // buildGuildTrend clamps a number itself, so a missing/bad value here
  // just falls back to its default (8).
  const { mythic, nights } = await searchParams;
  const mythicOnly = mythic === "1";
  const sampleMode = nights === "tier" ? "currentTier" : "count";
  const nightsRequested = nights && nights !== "tier" ? Number(nights) : 8;

  try {
    // This is the one call that fetches everything: it looks up the
    // guild's recent raid nights and builds the trend data below.
    const trend = await buildGuildTrend(guildName, server, region, {
      mythicOnly,
      nights: nightsRequested,
      sampleMode,
    });

    // Kill rate average and total deaths aren't returned directly --
    // they're quick to calculate here from the per-night numbers we do
    // have, so there's no need to fetch them separately.
    const avgKillRate =
      trend.killRateOverTime.reduce((sum, p) => sum + p.value, 0) /
      (trend.killRateOverTime.length || 1);
    const totalDeaths = trend.deathsOverTime.reduce((sum, p) => sum + p.value, 0);

    return (
      <div className="space-y-8">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <a href="/" className="label hover:text-ink-secondary">
              ← New search
            </a>
            <h1 className="mt-2 text-2xl font-semibold text-ink-primary">{trend.guild.name}</h1>
            <p className="mt-1 text-sm text-ink-muted">
              {server.replace(/-/g, " ")} · {region.toUpperCase()}
              {trend.guild.faction ? ` · ${trend.guild.faction}` : ""}
            </p>
          </div>
          <div className="flex items-center gap-3">
            <NightsSampleSelector nights={nights ?? String(nightsRequested)} />
            <MythicOnlyToggle mythicOnly={mythicOnly} />
          </div>
        </div>

        {mythicOnly && trend.nights.length === 0 ? (
          <p className="text-sm text-ink-muted">
            None of this guild&apos;s recent raid nights had any Mythic pulls -- everything below is empty until one
            does.
          </p>
        ) : null}

        {trend.sampleTruncated ? (
          <p className="text-sm text-ink-muted">
            {sampleMode === "currentTier"
              ? "This tier has more raid nights than shown here -- the sample stopped early to keep this page fast. Switch to a manual night count above for an exact total."
              : "There may be more raid nights further back than what's shown here -- the sample stopped early to keep this page fast."}
          </p>
        ) : null}

        {trend.failedReports.length > 0 ? (
          <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-ink-secondary">
            <p className="font-medium text-ink-primary">
              {trend.failedReports.length === 1
                ? "1 report couldn't be loaded and is missing from the numbers below:"
                : `${trend.failedReports.length} reports couldn't be loaded and are missing from the numbers below:`}
            </p>
            <ul className="mt-1.5 space-y-1">
              {trend.failedReports.map((r) => (
                <li key={r.code}>
                  <a href={`/report/${r.code}`} className="text-sky-400 hover:text-sky-300 hover:underline">
                    {r.title}
                  </a>{" "}
                  <span className="text-ink-muted">-- {r.reason}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
          <StatTile label="Raid nights analyzed" value={String(trend.nights.length)} />
          <StatTile
            label="Reports on file"
            value={String(trend.reportsAvailable)}
            sub={sampleMode === "currentTier" ? "this tier's nights are analyzed" : "most recent nights are analyzed"}
          />
          <StatTile label="Avg kill rate" value={formatPercent(avgKillRate)} />
          <StatTile label="Deaths (sample)" value={String(totalDeaths)} />
          <RateLimitTile rateLimit={trend.rateLimit} />
        </div>

        <div className="grid gap-6 lg:grid-cols-2">
          <section className="card">
            <h2 className="mb-4 text-sm font-semibold text-ink-primary">Kill rate over time</h2>
            <TrendLineChart
              data={trend.killRateOverTime.map((p) => ({ date: p.date, value: p.value }))}
              format="percent"
            />
          </section>
          <section className="card">
            <h2 className="mb-4 text-sm font-semibold text-ink-primary">Deaths per raid night</h2>
            <TrendLineChart
              data={trend.deathsOverTime.map((p) => ({ date: p.date, value: p.value }))}
              format="count"
            />
          </section>
        </div>

        {/* Same clickable "causes of death" / "deaths by player" charts as
            the single-report page -- just fed every death pooled across
            all the raid nights sampled above, instead of one report's. */}
        <DeathsPanel deaths={trend.deaths} />

        <section className="card">
          <h2 className="mb-4 text-sm font-semibold text-ink-primary">Raid nights</h2>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="label border-b border-surface-border">
                  <th className="py-2 pr-4 font-medium">Date</th>
                  <th className="py-2 pr-4 font-medium">Report{trend.nights.some((n) => n.reports.length > 1) ? "s" : ""}</th>
                  <th className="py-2 pr-4 font-medium">Zone</th>
                  <th className="py-2 pr-4 font-medium">Kills</th>
                  <th className="py-2 pr-4 font-medium">Wipes</th>
                  <th className="py-2 pr-4 font-medium">Deaths</th>
                  <th className="py-2 pr-4 font-medium">Top death cause</th>
                </tr>
              </thead>
              <tbody>
                {trend.nights.map((n) => (
                  // Keyed by date, not by the first report's code: a single
                  // report can now legitimately show up on TWO different
                  // night rows (see aggregateGuildTrend in
                  // lib/analysis/guild.ts -- a report whose own content
                  // spans a real gap in raid activity contributes to both
                  // nights it touches), so the same report code can appear
                  // as `reports[0]` more than once. Each night's own `date`
                  // is always unique -- real raid nights never overlap.
                  <tr key={n.date} className="border-b border-surface-border/60 last:border-0">
                    <td className="py-2 pr-4 text-ink-secondary">{formatDate(n.date)}</td>
                    <td className="py-2 pr-4">
                      {/* Usually just one report per night -- but a guild
                          that split one raid across several logs (crash/
                          relog, swapping loggers, etc) gets every one of
                          them listed here, since this whole row's kills/
                          wipes/deaths are the COMBINED total across every
                          pull that was actually counted (see
                          groupIntoSessions in lib/analysis/guild.ts).
                          Dedup happens per PULL, not per whole report (see
                          countedFightKeys in lib/analysis/guild.ts) -- two
                          reports can overlap in time without every pull in
                          them being duplicates of each other. A report with
                          SOME pulls excluded (but not all) still counts and
                          just gets a small note; only a report where EVERY
                          pull was a duplicate of another report's gets
                          struck through as fully "not counted". */}
                      <div className="flex flex-wrap gap-x-2 gap-y-0.5">
                        {n.reports.map((r, i) => (
                          <span key={r.code} className="inline-flex items-center gap-1">
                            <a
                              href={`/report/${r.code}`}
                              className={
                                r.counted
                                  ? "text-sky-400 hover:text-sky-300 hover:underline"
                                  : "text-ink-muted hover:text-ink-secondary hover:underline line-through decoration-ink-muted/60"
                              }
                            >
                              {n.reports.length > 1 ? `${r.title} (${i + 1})` : r.title}
                            </a>
                            {!r.counted ? (
                              <span
                                className="text-xs text-ink-muted"
                                title="Every pull in this report overlapped one already counted from another report in this night -- almost certainly the same raid logged twice -- so none of it was counted toward the totals to avoid doubling them."
                              >
                                (duplicate, not counted)
                              </span>
                            ) : r.excludedFights > 0 ? (
                              <span
                                className="text-xs text-ink-muted"
                                title="Some of this report's pulls overlapped ones already counted from another report in this night -- possibly a logger who didn't stop recording between two raids -- so just those pulls were excluded, not the whole report."
                              >
                                ({r.excludedFights} pull{r.excludedFights === 1 ? "" : "s"} excluded as duplicates)
                              </span>
                            ) : null}
                          </span>
                        ))}
                      </div>
                    </td>
                    <td className="py-2 pr-4 text-ink-muted">{n.zoneName ?? "—"}</td>
                    <td className="py-2 pr-4 text-ink-primary">{n.kills}</td>
                    <td className="py-2 pr-4 text-ink-primary">{n.wipes}</td>
                    <td className="py-2 pr-4 text-ink-primary">{n.deathCount}</td>
                    <td className="py-2 pr-4 text-ink-secondary">
                      {n.topDeathCauses[0]?.ability ?? "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    );
  } catch (err) {
    // Same pattern as the report page: a WCLApiError's message is already
    // safe to show a user (e.g. "No guild found for..."); anything else
    // shows a generic message instead.
    const message = err instanceof WCLApiError ? err.message : "Failed to load this guild.";
    return <ErrorState message={message} />;
  }
}

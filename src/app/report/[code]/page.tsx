/**
 * This is the main dashboard page, shown at a URL like "/report/AbCdEfGh"
 * (the "AbCdEfGh" part is the Warcraft Logs report code). This is the
 * most important page in the app.
 *
 * What it does:
 * 1. Reads the report `code` out of the URL.
 * 2. Calls `buildReportAnalysis(code)`, which does all the real work --
 *    it talks to the Warcraft Logs API and hands back everything this
 *    page needs to draw (stat tiles, damage/healing rankings, deaths).
 * 3. Lays out the stat tiles and charts using that data.
 *
 * It's a Server Component (renders on the server, before your browser sees
 * it) -- there's no spinner logic here, because Next.js shows loading.tsx
 * automatically while step 2 is still running. If `buildReportAnalysis`
 * throws an error (bad code, report not found, etc.), the catch block
 * below shows a friendly error box instead of crashing the page.
 */
import { AugComparisonForm, type AugCompareMode } from "@/components/AugComparisonForm";
import { AugmentationPanel, type ComparisonSide } from "@/components/AugmentationPanel";
import { DeathsPanel } from "@/components/DeathsPanel";
import { FightScopeSelector } from "@/components/FightScopeSelector";
import { PlayerAnalysisPanel } from "@/components/PlayerAnalysisPanel";
import { PlayerAnalysisSelector } from "@/components/PlayerAnalysisSelector";
import { ReportTabs, type ReportTab } from "@/components/ReportTabs";
import { RankingBarChart } from "@/components/charts/RankingBarChart";
import { ErrorState } from "@/components/ui/ErrorState";
import { RateLimitTile } from "@/components/ui/RateLimitTile";
import { StatTile } from "@/components/ui/StatTile";
import { resolveFightScope } from "@/lib/analysis/fightScope";
import type { PlayerAnalysisResult, ReportAnalysis } from "@/lib/analysis/types";
import { formatPercent } from "@/lib/format";
import {
  buildAugmentationAnalysis,
  buildAugmentationComparison,
  buildAugmentationVsTopLog,
  buildPlayerAnalysis,
  buildReportAnalysis,
  listAugmentationEvokers,
} from "@/lib/wcl/service";
import { WCLApiError } from "@/lib/wcl/types";

// Tells Next.js not to cache this page's HTML -- caching already happens
// one level down, inside the API calls themselves (see lib/cache.ts).
export const revalidate = 0;

export default async function ReportPage({
  params,
  searchParams,
}: {
  params: Promise<{ code: string }>;
  searchParams: Promise<{
    scope?: string;
    analyze?: string;
    compare?: string;
    compareName?: string;
    vs?: string;
    vsName?: string;
    tab?: string;
  }>;
}) {
  try {
    // `code` comes from the URL, e.g. /report/AbCdEfGh -> code = "AbCdEfGh".
    // `scope` comes from a query string like ?scope=kills (set by the
    // FightScopeSelector dropdown below, when someone picks "All kills",
    // a single pull, etc). `analyze` comes from PlayerAnalysisSelector,
    // below. `tab` is which ReportTabs tab is open. Next.js hands all of
    // these back as Promises.
    const { code } = await params;
    const { scope, analyze, compare, compareName, vs, vsName, tab } = await searchParams;
    // No explicit tab (e.g. an old link from before tabs existed): open
    // whichever tab the other params point at, otherwise the raid view.
    const activeTab: ReportTab =
      tab === "raid" || tab === "player" || tab === "compare"
        ? tab
        : compare || vs
          ? "compare"
          : analyze
            ? "player"
            : "raid";
    // This is the one call that does all the actual data fetching --
    // it talks to the Warcraft Logs API and returns everything the charts
    // below need, already filtered down to whatever `scope` picked.
    const analysis = await buildReportAnalysis(code, { scope });

    // The player-analysis feature (casts-per-minute vs. the server-wide top
    // log) only makes sense for ONE specific pull -- same reasoning as the
    // Parse % column on the damage/healing charts. `resolveFightScope` is
    // the same logic FightScopeSelector's own choices resolve through, so
    // "one specific pull" here means exactly what it means everywhere else
    // in the app: the `?scope=fight:<id>` case (or any other scope that
    // happens to resolve to just one fight, e.g. a boss with only one pull
    // total).
    const fightIDs = resolveFightScope(scope, analysis.fights);
    const singleFightId = fightIDs?.length === 1 ? fightIDs[0] : undefined;

    // The player picker's options: every name that shows up in either
    // ranking, deduped (a player can appear in both damage and healing --
    // an off-spec heal, a hybrid class's incidental healing, etc).
    const playerOptions = new Map<string, string>();
    for (const e of [...analysis.damageRanking, ...analysis.healingRanking]) {
      if (!playerOptions.has(e.name)) playerOptions.set(e.name, e.className);
    }
    const players = [...playerOptions.entries()].map(([name, className]) => ({ name, className }));

    // Fetching the player analysis is its own try/catch, separate from the
    // page's own -- a bad/misspelled `?analyze=` name, or the top-log
    // lookup itself failing, shouldn't take down the whole report page,
    // just show an inline message where the panel would be. Only done when
    // the Player tab is actually open: it's the expensive part of this page
    // (especially the Augmentation breakdown below), and the Raid tab
    // doesn't show any of it.
    let playerAnalysis: PlayerAnalysisResult | null = null;
    let playerAnalysisError: string | null = null;
    if (activeTab === "player" && analyze && singleFightId !== undefined) {
      try {
        playerAnalysis = await buildPlayerAnalysis(code, singleFightId, analyze);
      } catch (err) {
        playerAnalysisError = err instanceof WCLApiError ? err.message : "Failed to analyze this player.";
      }
    }

    // Player tab, Augmentation Evokers only: the spec breakdown for this
    // one player (Prescience / Shifting Sands targeting with per-application
    // ranks, buff up-times, procs). Its own try/catch, like the panel above
    // -- if it fails, the cast comparison still shows.
    const playerIsAug =
      playerAnalysis?.player.className === "Evoker" && playerAnalysis.player.specName === "Augmentation";
    let playerAug: ComparisonSide | null = null;
    let playerAugError: string | null = null;
    if (activeTab === "player" && playerIsAug && singleFightId !== undefined) {
      try {
        playerAug = { analysis: await buildAugmentationAnalysis(code, singleFightId, playerAnalysis!.player.name), label: "This pull" };
      } catch (err) {
        playerAugError = err instanceof WCLApiError ? err.message : "Failed to build the Augmentation breakdown.";
      }
    }

    // --- Compare tab: one Augmentation Evoker vs. another ---------------
    // Nothing is compared until a comparison is picked (a quick button or a
    // pasted link) -- this is the most expensive thing the app fetches, so
    // just opening the tab doesn't trigger it. Each side has its own
    // try/catch-equivalent (allSettled): a bad comparison link shouldn't
    // take down your own side, and neither should take down the page.
    let augs: string[] = [];
    let me: string | null = null;
    let compareMode: AugCompareMode | null = null;
    const compareSides: ComparisonSide[] = [];
    let compareError: string | null = null;
    let compareOtherError: string | null = null;
    if (activeTab === "compare" && singleFightId !== undefined) {
      augs = await listAugmentationEvokers(code, singleFightId);
      me = analyze && augs.includes(analyze) ? analyze : (augs[0] ?? null);
      compareMode = vs === "top" || vs === "log" || vs === "link" ? vs : compare ? "link" : null;
      if (compareMode === "log" && (!vsName || vsName === me || !augs.includes(vsName))) compareMode = null;
      if (compareMode === "link" && !compare) compareMode = null;

      if (me && compareMode) {
        const opponent: Promise<ComparisonSide> =
          compareMode === "top"
            ? buildAugmentationVsTopLog(code, singleFightId).then((r) => ({
                analysis: r.analysis,
                // Rank 2 only happens when #1 is this very pull (see
                // findTopRankedLog), i.e. you're #1 yourself.
                label: r.rank === 1 ? "#1 ranked log" : r.rank === 2 ? "#2 ranked log (you're #1)" : `#${r.rank} ranked log`,
              }))
            : compareMode === "log"
              ? buildAugmentationAnalysis(code, singleFightId, vsName!).then((analysis) => ({ analysis, label: "Your raid" }))
              : buildAugmentationComparison(compare!, compareName).then((analysis) => ({ analysis, label: "Pasted log" }));
        const [mineResult, otherResult] = await Promise.allSettled([
          buildAugmentationAnalysis(code, singleFightId, me),
          opponent,
        ]);
        const message = (reason: unknown, fallback: string) => (reason instanceof WCLApiError ? reason.message : fallback);
        if (mineResult.status === "fulfilled") {
          compareSides.push({ analysis: mineResult.value, label: "You" });
          if (otherResult.status === "fulfilled") compareSides.push(otherResult.value);
          else compareOtherError = message(otherResult.reason, "Failed to load the comparison pull.");
        } else {
          compareError = message(mineResult.reason, "Failed to build the Augmentation breakdown.");
        }
      }
    }

    return (
      <div className="space-y-8">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <a href="/" className="label hover:text-ink-secondary">
              ← New search
            </a>
            <h1 className="mt-2 text-2xl font-semibold text-ink-primary">{analysis.title}</h1>
            <p className="mt-1 text-sm text-ink-muted">
              {analysis.zoneName ?? "Unknown zone"} · {analysis.code}
            </p>
          </div>
          <FightScopeSelector code={code} fights={analysis.fights} currentScope={scope ?? ""} />
        </div>

        <ReportTabs code={code} activeTab={activeTab} params={{ scope, analyze, compare, compareName, vs, vsName }} />

        {activeTab === "raid" ? <RaidOverview analysis={analysis} /> : null}

        {activeTab === "player" ? (
          <section className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <h2 className="text-sm font-semibold text-ink-primary">Player analysis</h2>
              {singleFightId !== undefined ? <PlayerAnalysisSelector players={players} /> : null}
            </div>
            {/* Everything on this tab compares one specific pull (see the
                singleFightId comment above), so with anything broader
                picked there's nothing to show yet but a pointer to the
                dropdown. */}
            {singleFightId === undefined ? (
              <p className="card text-sm text-ink-muted">
                Pick a single pull from the dropdown above, then choose a player to analyze.
              </p>
            ) : !analyze ? (
              <p className="card text-sm text-ink-muted">Choose a player to compare their casts against the top log.</p>
            ) : null}
            {playerAnalysisError ? <ErrorState message={playerAnalysisError} /> : null}
            {playerAnalysis ? <PlayerAnalysisPanel analysis={playerAnalysis} /> : null}
            {playerAugError ? <ErrorState message={playerAugError} /> : null}
            {playerAug ? (
              <>
                <h3 className="pt-2 text-sm font-semibold text-ink-primary">Augmentation breakdown</h3>
                <AugmentationPanel sides={[playerAug]} otherError={null} detailsOpen />
              </>
            ) : null}
            {playerIsAug && playerAnalysis ? (
              <p className="text-sm text-ink-muted">
                Want this side by side with another Aug? The{" "}
                <a
                  href={`/report/${code}?${new URLSearchParams({ ...(scope ? { scope } : {}), analyze: playerAnalysis.player.name, tab: "compare" })}`}
                  className="text-sky-400 hover:underline"
                >
                  Compare tab
                </a>{" "}
                compares against the #1 ranked Aug, another Aug in your raid, or any log you paste.
              </p>
            ) : null}
          </section>
        ) : null}

        {activeTab === "compare" ? (
          <section className="space-y-4">
            <h2 className="text-sm font-semibold text-ink-primary">Compare Augmentation Evokers</h2>
            {singleFightId === undefined ? (
              <p className="card text-sm text-ink-muted">Pick a single pull from the dropdown above to compare.</p>
            ) : augs.length === 0 ? (
              <p className="card text-sm text-ink-muted">There&apos;s no Augmentation Evoker in this pull.</p>
            ) : (
              <>
                <AugComparisonForm augs={augs} me={me} mode={compareMode} vsName={compareMode === "log" ? (vsName ?? null) : null} />
                {compareError ? <ErrorState message={compareError} /> : null}
                {compareSides.length > 0 ? <AugmentationPanel sides={compareSides} otherError={compareOtherError} /> : null}
              </>
            )}
          </section>
        ) : null}
      </div>
    );
  } catch (err) {
    // If the API layer threw a WCLApiError, its message is already
    // written to be shown to a user (e.g. "No report found for code...").
    // Any other kind of error is unexpected, so show a generic message
    // instead of leaking a raw error/stack trace.
    const message = err instanceof WCLApiError ? err.message : "Failed to load this report.";
    return <ErrorState message={message} />;
  }
}

// The Raid overview tab: the whole raid's numbers for whatever fight scope
// is picked -- stat tiles, damage/healing rankings, and deaths.
function RaidOverview({ analysis }: { analysis: ReportAnalysis }) {
  return (
    <div className="space-y-8">
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <StatTile label="Fights" value={String(analysis.fightsSummary.totalFights)} />
        <StatTile
          label="Kills"
          value={String(analysis.fightsSummary.kills)}
          sub={formatPercent(analysis.fightsSummary.killRate) + " kill rate"}
        />
        <StatTile label="Wipes" value={String(analysis.fightsSummary.wipes)} />
        <StatTile label="Deaths" value={String(analysis.deaths.length)} />
        <RateLimitTile rateLimit={analysis.rateLimit} />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <section className="card">
          <h2 className="mb-4 text-sm font-semibold text-ink-primary">Damage done</h2>
          <RankingBarChart
            data={analysis.damageRanking.map((e) => ({
              name: e.name,
              value: e.total,
              className: e.className,
              rate: e.perSecond,
              activeTimeMs: e.activeTimeMs,
              parsePercent: e.parsePercent,
            }))}
            format="number"
            colorByClass
          />
        </section>
        <section className="card">
          <h2 className="mb-4 text-sm font-semibold text-ink-primary">Healing done</h2>
          <RankingBarChart
            data={analysis.healingRanking.map((e) => ({
              name: e.name,
              value: e.total,
              className: e.className,
              rate: e.perSecond,
              activeTimeMs: e.activeTimeMs,
              parsePercent: e.parsePercent,
            }))}
            format="number"
            colorByClass
          />
        </section>
      </div>

      {/* Shows the death-cause chart and the death log together, plus a
          filter dropdown that controls both at once (see DeathsPanel). */}
      <DeathsPanel deaths={analysis.deaths} />
    </div>
  );
}

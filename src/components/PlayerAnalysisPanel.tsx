/**
 * The player-analysis dashboard itself: phase toggle, throughput stat
 * tiles, the casts-per-minute comparison chart, and the rotational
 * suggestion checklist -- everything the report page shows once someone
 * picks a player from PlayerAnalysisSelector.
 *
 * `analysis` is already fully fetched (lib/wcl/service.ts's
 * buildPlayerAnalysis fetches every phase window up front), so switching
 * phases here is pure client-side state -- no extra network request per
 * click, just re-slicing `analysis.windows` to whichever one is selected.
 */
"use client";

import { useState } from "react";
import { CastRateComparisonChart } from "@/components/charts/CastRateComparisonChart";
import { StatTile } from "@/components/ui/StatTile";
import { buildRotationSuggestions, mergeAbilityComparison } from "@/lib/analysis/playerAnalysis";
import type { PlayerAnalysisResult } from "@/lib/analysis/types";
import { formatNumber } from "@/lib/format";
import { classColor, classDisplayName } from "@/lib/wowClassColors";

const ROLE_LABEL: Record<PlayerAnalysisResult["player"]["role"], string> = {
  dps: "DPS",
  healer: "Healer",
  tank: "Tank",
};

export function PlayerAnalysisPanel({ analysis }: { analysis: PlayerAnalysisResult }) {
  // Selected by `key`, not `phaseId` -- a phase id can repeat when a boss
  // returns to an earlier phase (see buildPhaseWindows).
  const [selectedKey, setSelectedKey] = useState("whole");
  const activeWindow = analysis.windows.find((w) => w.key === selectedKey) ?? analysis.windows[0];

  if (!activeWindow) {
    // Every fight has at least the "whole fight" window (phaseId 0), so
    // this can't actually happen -- but the type says `windows` is just an
    // array, so guard rather than assume.
    return <p className="text-sm text-ink-muted">No analysis data for this pull.</p>;
  }

  const metricLabel = analysis.metric === "hps" ? "HPS" : "DPS";
  const comparisonRows = mergeAbilityComparison(activeWindow.player.abilities, activeWindow.topLog.abilities);
  const suggestions = buildRotationSuggestions(comparisonRows);
  const topLogUrl = analysis.topLog
    ? `https://www.warcraftlogs.com/reports/${analysis.topLog.reportCode}?fight=${analysis.topLog.fightID}&type=casts`
    : null;

  return (
    <section className="card space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <span
              className="inline-block h-2.5 w-2.5 rounded-full"
              style={{ backgroundColor: classColor(analysis.player.className) }}
            />
            <h2 className="text-sm font-semibold text-ink-primary">
              {analysis.player.name} -- {classDisplayName(analysis.player.className)} {analysis.player.specName}
            </h2>
            <span className="label">{ROLE_LABEL[analysis.player.role]}</span>
          </div>
          <p className="mt-1 text-xs text-ink-muted">
            {analysis.fightName}
            {analysis.topLog ? (
              <>
                {" "}
                · vs. server #1 parse:{" "}
                <a
                  href={topLogUrl ?? undefined}
                  target="_blank"
                  rel="noreferrer"
                  className="text-sky-400 hover:underline"
                >
                  {analysis.topLog.playerName}
                </a>
              </>
            ) : (
              " · no server-wide top parse found for this exact boss/difficulty/spec"
            )}
          </p>
        </div>

        {/* Phase toggle -- always has at least "Whole fight" (phaseId 0).
            A single-phase boss's list has nothing else to show, so the
            toggle row just doesn't render extra buttons instead of a
            dropdown with one disabled option. */}
        {analysis.windows.length > 1 ? (
          <div className="flex flex-wrap gap-1.5">
            {analysis.windows.map((w) => (
              <button
                key={w.key}
                type="button"
                onClick={() => setSelectedKey(w.key)}
                aria-pressed={w.key === selectedKey}
                className={
                  w.key === selectedKey
                    ? "rounded-lg border border-sky-500 bg-sky-500 px-2.5 py-1 text-xs font-medium text-white"
                    : "rounded-lg border border-surface-border bg-surface px-2.5 py-1 text-xs text-ink-primary hover:border-sky-500"
                }
              >
                {w.label}
              </button>
            ))}
          </div>
        ) : null}
      </div>

      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <StatTile label="Your CPM" value={activeWindow.player.castsPerMinute.toFixed(1)} sub={`${activeWindow.player.totalCasts} casts`} />
        <StatTile
          label="Top log CPM"
          value={activeWindow.topLog.castsPerMinute.toFixed(1)}
          sub={analysis.topLog ? `${activeWindow.topLog.totalCasts} casts` : "no comparison"}
        />
        <StatTile label={`Your ${metricLabel}`} value={formatNumber(activeWindow.player.throughputPerSecond)} sub="per second" />
        <StatTile
          label={`Top log ${metricLabel}`}
          value={analysis.topLog ? formatNumber(activeWindow.topLog.throughputPerSecond) : "--"}
          sub="per second"
        />
      </div>

      <div>
        <h3 className="mb-3 text-xs font-semibold text-ink-secondary">Casts per minute, by ability</h3>
        <CastRateComparisonChart data={comparisonRows} playerLabel="You" topLogLabel="Top log" />
      </div>

      {suggestions.length > 0 ? (
        <div className="border-t border-surface-border pt-4">
          <h3 className="mb-3 text-xs font-semibold text-ink-secondary">Rotational suggestions</h3>
          <ul className="space-y-2">
            {suggestions.map((s) => (
              <li key={s.guid} className="flex items-center justify-between gap-4 text-sm">
                <span className="text-ink-primary">Cast {s.name} more often</span>
                <span className="text-xs text-ink-muted">
                  {s.playerCastsPerMinute.toFixed(1)}/min → top log casts it {s.topLogCastsPerMinute.toFixed(1)}/min
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : analysis.topLog ? (
        <p className="border-t border-surface-border pt-4 text-sm text-ink-muted">
          No notable gaps -- your cast rates are in line with the top log for this window.
        </p>
      ) : null}
    </section>
  );
}

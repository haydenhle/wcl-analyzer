/**
 * Groups all of the "who's dying and to what" charts together, plus the
 * "first N deaths per pull" filter dropdown that controls all of them at
 * once:
 *  1. "Most common causes of death" -- click a bar to see which players
 *     died to that specific ability.
 *  2. "Deaths by player" -- click a bar to see what that specific player
 *     died to.
 *
 * Reused on both dashboards: the single-report page passes in one report's
 * deaths, and the guild page passes in every death from all the raid nights
 * it sampled, pooled into one list -- this component doesn't care which.
 *
 * Data flow: `deaths` is passed in as a prop (already filtered to whichever
 * fights/nights are in scope). This component filters that list further,
 * in the browser, based on the dropdown and whatever bar was last clicked
 * -- no extra API call needed, it's just re-slicing data that's already
 * here.
 *
 * Why filter to "first N per pull": usually only the first death or two in
 * a wipe is a real mistake worth analyzing -- everyone dying right after is
 * often just the fight falling apart, and only the early deaths are the
 * ones a raid can typically battle-rez back to life.
 */
// "use client" means this component runs in the browser (not on the
// server), so the dropdown and both charts can update together instantly
// when someone picks a different filter or clicks a bar.
"use client";

import { useState } from "react";
import { RankingBarChart } from "@/components/charts/RankingBarChart";
import { deathCauseBreakdown, playerDeathCounts } from "@/lib/analysis/report";
import type { DeathRecord } from "@/lib/analysis/types";

const FIRST_N_OPTIONS = [
  { value: "all", label: "All deaths" },
  { value: "1", label: "First death only" },
  { value: "2", label: "First 2 deaths" },
  { value: "3", label: "First 3 deaths" },
] as const;

type FirstNValue = (typeof FIRST_N_OPTIONS)[number]["value"];

/**
 * Keeps only the first `n` deaths of each fight (not the first `n` deaths
 * overall). So if multiple pulls are being shown, you get "the first N of
 * every pull", not just the first N deaths of the very first pull.
 *
 * "Each fight" means `reportCode` + `fightId` together, not just `fightId`
 * -- on the guild page, `deaths` can be pooled from several different
 * reports, and two different reports can both have a "fight 1". Without
 * including `reportCode`, those two unrelated pulls would get treated as
 * one and share the same first-N cap. On the single-report page every
 * death already has the same `reportCode`, so this works out to grouping
 * by `fightId` alone anyway -- same behavior as before.
 */
function limitFirstDeathsPerFight(deaths: DeathRecord[], n: number | null): DeathRecord[] {
  if (n === null) return deaths;
  const sorted = [...deaths].sort((a, b) => a.fightId - b.fightId || a.timeIntoFightMs - b.timeIntoFightMs);
  const seenPerFight = new Map<string, number>();
  const kept: DeathRecord[] = [];
  for (const d of sorted) {
    const key = `${d.reportCode ?? ""}:${d.fightId}`;
    const count = seenPerFight.get(key) ?? 0;
    if (count < n) {
      kept.push(d);
      seenPerFight.set(key, count + 1);
    }
  }
  return kept;
}

// Small header row used above both drill-down mini-charts: a title plus a
// "Clear" button to close it again.
function DrilldownHeader({ title, onClear }: { title: string; onClear: () => void }) {
  return (
    <div className="mb-2 flex items-center justify-between">
      <h3 className="text-xs font-semibold text-ink-secondary">{title}</h3>
      <button type="button" onClick={onClear} className="text-xs text-ink-muted hover:text-ink-primary">
        Clear
      </button>
    </div>
  );
}

export function DeathsPanel({ deaths }: { deaths: DeathRecord[] }) {
  const [firstN, setFirstN] = useState<FirstNValue>("all");
  // Which cause (in the top chart) or which player (in the bottom chart)
  // is currently clicked on -- that's what controls whether a drill-down
  // mini-chart shows up underneath, and what it shows. `null` means
  // nothing is selected, so no drill-down is shown.
  const [selectedCause, setSelectedCause] = useState<string | null>(null);
  const [selectedPlayer, setSelectedPlayer] = useState<string | null>(null);

  const limited = limitFirstDeathsPerFight(deaths, firstN === "all" ? null : Number(firstN));

  // Changing the filter can change (or remove) the bar someone had
  // clicked -- e.g. a cause that only shows up in "all deaths" -- so clear
  // both selections whenever the dropdown changes, rather than leaving a
  // stale drill-down on screen.
  function handleFirstNChange(value: FirstNValue) {
    setFirstN(value);
    setSelectedCause(null);
    setSelectedPlayer(null);
  }

  const causes = deathCauseBreakdown(limited).slice(0, 8);
  const playerCounts = playerDeathCounts(limited);

  // The drill-down data is just the same two counting functions, run again
  // on a smaller, already-filtered slice of `limited` -- "only the deaths
  // that match whatever's selected". Clicking the same bar again clears
  // the selection (see the onBarClick handlers below), so these can end up
  // `null` even while a cause/player is still technically selected in
  // state for one render -- the `&&` checks below handle that.
  const causeDrilldown = selectedCause
    ? playerDeathCounts(limited.filter((d) => (d.killingAbility ?? "Unknown") === selectedCause))
    : null;
  const playerDrilldown = selectedPlayer
    ? deathCauseBreakdown(limited.filter((d) => d.playerName === selectedPlayer))
    : null;

  return (
    <>
      <section className="card">
        <div className="mb-1 flex items-center justify-between gap-4">
          <h2 className="text-sm font-semibold text-ink-primary">Most common causes of death</h2>
          <select
            value={firstN}
            onChange={(e) => handleFirstNChange(e.target.value as FirstNValue)}
            className="rounded-lg border border-surface-border bg-surface px-2 py-1 text-xs text-ink-primary focus:border-sky-500 focus:outline-none"
          >
            {FIRST_N_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
        {firstN !== "all" ? (
          <p className="mb-4 text-xs text-ink-muted">
            Only the first {firstN} death{firstN === "1" ? "" : "s"} of each pull -- the ones usually worth a
            battle-rez or a cooldown reassignment.
          </p>
        ) : (
          <div className="mb-4" />
        )}
        {/* Click a bar to see, below, which players actually died to that
            cause. `selectedName` just tells the chart which bar (if any)
            to highlight -- the actual click handling lives here. */}
        <RankingBarChart
          data={causes.map((c) => ({ name: c.ability, value: c.count }))}
          format="count"
          height={Math.max(140, causes.length * 32)}
          onBarClick={(name) => setSelectedCause(name === selectedCause ? null : name)}
          selectedName={selectedCause}
        />
        {selectedCause && causeDrilldown ? (
          <div className="mt-4 border-t border-surface-border pt-4">
            <DrilldownHeader title={`Who died to "${selectedCause}"`} onClear={() => setSelectedCause(null)} />
            <RankingBarChart
              data={causeDrilldown.map((p) => ({ name: p.playerName, value: p.count, className: p.className }))}
              format="count"
              height={Math.max(100, causeDrilldown.length * 32)}
              colorByClass
            />
          </div>
        ) : null}
      </section>

      <section className="card">
        <h2 className="mb-1 text-sm font-semibold text-ink-primary">Deaths by player</h2>
        <p className="mb-4 text-xs text-ink-muted">Click a player to see what killed them.</p>
        {/* Same click-to-drill-down pattern as the chart above, just
            flipped: bars are players instead of causes. Colored by class,
            same as the damage/healing charts. */}
        <RankingBarChart
          data={playerCounts.map((p) => ({ name: p.playerName, value: p.count, className: p.className }))}
          format="count"
          height={Math.max(140, playerCounts.length * 32)}
          colorByClass
          onBarClick={(name) => setSelectedPlayer(name === selectedPlayer ? null : name)}
          selectedName={selectedPlayer}
        />
        {selectedPlayer && playerDrilldown ? (
          <div className="mt-4 border-t border-surface-border pt-4">
            <DrilldownHeader title={`What ${selectedPlayer} died to`} onClear={() => setSelectedPlayer(null)} />
            <RankingBarChart
              data={playerDrilldown.map((c) => ({ name: c.ability, value: c.count }))}
              format="count"
              height={Math.max(100, playerDrilldown.length * 32)}
            />
          </div>
        ) : null}
      </section>
    </>
  );
}

// This runs in the browser (not on the server) because recharts needs to
// measure the page and handle hover.
"use client";

import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { TooltipProps } from "recharts";
import type { AbilityComparisonRow } from "@/lib/analysis/types";

// Fixed categorical slots (see tailwind.config.ts / the dataviz skill's
// palette.md) -- "you" is always slot 1 (blue), "the top log" is always
// slot 2 (orange). Color follows the entity, never its rank, so these never
// swap even when the top log out-casts the player on every single ability.
const PLAYER_COLOR = "#3987e5";
const TOP_LOG_COLOR = "#d95926";

function formatRate(v: number): string {
  return `${v.toFixed(1)}/min`;
}

// A custom tooltip (rather than the shared ChartTooltip) since this chart
// always has exactly two series per row and needs both listed together --
// "one tooltip, every series" -- with a line-key instead of ChartTooltip's
// single-series dot styling.
function CastRateTooltip({
  active,
  payload,
  label,
  playerLabel,
  topLogLabel,
}: TooltipProps<number, string> & { playerLabel: string; topLogLabel: string }) {
  if (!active || !payload?.length) return null;
  const playerValue = Number(payload.find((p) => p.dataKey === "playerCastsPerMinute")?.value ?? 0);
  const topLogValue = Number(payload.find((p) => p.dataKey === "topLogCastsPerMinute")?.value ?? 0);
  return (
    <div className="rounded-lg border border-surface-border bg-surface-raised px-3 py-2 text-xs shadow-lg">
      <div className="mb-1.5 font-medium text-ink-primary">{label}</div>
      <div className="flex items-center gap-2">
        <span className="inline-block h-0.5 w-3" style={{ backgroundColor: PLAYER_COLOR }} />
        <span className="text-ink-secondary">{formatRate(playerValue)}</span>
        <span className="text-ink-muted">{playerLabel}</span>
      </div>
      <div className="mt-1 flex items-center gap-2">
        <span className="inline-block h-0.5 w-3" style={{ backgroundColor: TOP_LOG_COLOR }} />
        <span className="text-ink-secondary">{formatRate(topLogValue)}</span>
        <span className="text-ink-muted">{topLogLabel}</span>
      </div>
    </div>
  );
}

/**
 * Grouped horizontal bar chart: one row per ability, two bars per row (the
 * analyzed player's casts/minute vs. the top log's) -- the visual half of
 * the rotational suggestion checklist (see RotationSuggestions for the
 * textual half). `playerLabel`/`topLogLabel` name the two series in the
 * legend and tooltip -- kept short and generic ("You" / "Top log") rather
 * than a possibly-long character name, since the panel header above this
 * chart already says who the top log actually is.
 */
export function CastRateComparisonChart({
  data,
  playerLabel,
  topLogLabel,
}: {
  data: AbilityComparisonRow[];
  playerLabel: string;
  topLogLabel: string;
}) {
  if (data.length === 0) {
    return <p className="text-sm text-ink-muted">No cast data for this window.</p>;
  }

  return (
    <ResponsiveContainer width="100%" height={Math.max(160, data.length * 40)}>
      <BarChart
        data={data}
        layout="vertical"
        barGap={2}
        margin={{ top: 4, right: 24, bottom: 4, left: 4 }}
      >
        <CartesianGrid horizontal={false} stroke="#2c2c2a" strokeDasharray="2 4" />
        <XAxis
          type="number"
          tickFormatter={(v: number) => `${v.toFixed(0)}/min`}
          tick={{ fill: "#898781", fontSize: 11 }}
          axisLine={{ stroke: "#383835" }}
          tickLine={false}
        />
        <YAxis
          type="category"
          dataKey="name"
          width={140}
          tick={{ fill: "#c3c2b7", fontSize: 12 }}
          axisLine={{ stroke: "#383835" }}
          tickLine={false}
        />
        <Tooltip
          content={<CastRateTooltip playerLabel={playerLabel} topLogLabel={topLogLabel} />}
          cursor={{ fill: "rgba(255,255,255,0.04)" }}
        />
        <Legend
          verticalAlign="top"
          height={28}
          formatter={(value: string) => <span className="text-xs text-ink-secondary">{value}</span>}
        />
        <Bar
          dataKey="playerCastsPerMinute"
          name={playerLabel}
          fill={PLAYER_COLOR}
          radius={[0, 4, 4, 0]}
          maxBarSize={10}
        />
        <Bar
          dataKey="topLogCastsPerMinute"
          name={topLogLabel}
          fill={TOP_LOG_COLOR}
          radius={[0, 4, 4, 0]}
          maxBarSize={10}
        />
      </BarChart>
    </ResponsiveContainer>
  );
}

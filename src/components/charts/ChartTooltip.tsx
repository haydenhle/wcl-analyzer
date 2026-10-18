// Runs in the browser (not on the server), since it only ever shows up
// while someone is actively hovering over a chart.
"use client";

import type { TooltipProps } from "recharts";
import { formatDuration } from "@/lib/format";
import { parseColor } from "@/lib/wclParseColor";
import { classColor, classDisplayName } from "@/lib/wowClassColors";

/**
 * The small popup box that appears when you hover over a bar or point on
 * a chart. Used by both RankingBarChart and TrendLineChart, so it has one
 * consistent look everywhere instead of recharts' default white box.
 *
 * recharts itself decides when to show/hide this and fills in `active`,
 * `payload`, and `label` -- this component just reads those and renders
 * them. `valueFormatter` is passed in directly as a function (not a name
 * like the chart components use) because recharts always renders this
 * component from inside the browser, so there's no server/client boundary
 * to worry about here.
 */
export function ChartTooltip({
  active,
  payload,
  label,
  valueFormatter,
}: TooltipProps<number, string> & { valueFormatter?: (v: number) => string }) {
  // recharts only shows the tooltip while hovering a data point -- if
  // there's nothing being hovered, render nothing.
  if (!active || !payload?.length) return null;
  const entry = payload[0];
  const value = typeof entry?.value === "number" ? entry.value : Number(entry?.value ?? 0);
  // `entry.payload` is the original data row for whatever's being
  // hovered. Pull out the extra fields (class, active time, parse %) so
  // the tooltip can explain them in words -- the chart itself only shows
  // a color or a bare number for these.
  const datum = entry?.payload as
    | { className?: string; activeTimeMs?: number; parsePercent?: number }
    | undefined;
  const className = datum?.className;
  const activeTimeMs = datum?.activeTimeMs;
  const parsePercent = datum?.parsePercent;

  return (
    <div className="rounded-lg border border-surface-border bg-surface-raised px-3 py-2 text-xs shadow-lg">
      {label ? <div className="mb-1 font-medium text-ink-primary">{label}</div> : null}
      <div className="text-ink-secondary">{valueFormatter ? valueFormatter(value) : value}</div>
      {className ? (
        <div className="mt-1 flex items-center gap-1.5 text-ink-muted">
          <span
            className="inline-block h-2 w-2 rounded-full"
            style={{ backgroundColor: classColor(className) }}
          />
          {classDisplayName(className)}
        </div>
      ) : null}
      {activeTimeMs ? <div className="mt-1 text-ink-muted">Active: {formatDuration(activeTimeMs)}</div> : null}
      {parsePercent !== undefined ? (
        <div className="mt-1 flex items-center gap-1.5 text-ink-muted">
          <span
            className="inline-block h-2 w-2 rounded-full"
            style={{ backgroundColor: parseColor(parsePercent) }}
          />
          Parse: {Math.round(parsePercent)}%
        </div>
      ) : null}
    </div>
  );
}

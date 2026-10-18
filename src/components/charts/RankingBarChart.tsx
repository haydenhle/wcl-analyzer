// This runs in the browser (not on the server) because recharts (the
// charting library) needs to measure the page and handle mouse hovers.
"use client";

// recharts is the charting library this app uses. You give it pieces
// (Bar, XAxis, YAxis, etc.) as JSX and it draws the actual SVG chart.
import { Bar, BarChart, CartesianGrid, Cell, LabelList, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { formatNumber } from "@/lib/format";
import { parseColor } from "@/lib/wclParseColor";
import { classColor } from "@/lib/wowClassColors";
import { ChartTooltip } from "./ChartTooltip";

// One row of the chart: a name (player or ability) and its value (damage
// done, deaths caused, etc). The rest are optional extras used only for
// some kinds of rankings:
export interface RankingDatum {
  name: string;
  value: number;
  // The player's WoW class, e.g. "Mage". Only set for player rankings
  // (damage/healing) when `colorByClass` is on -- used to color the bar.
  className?: string;
  // Per-second rate and how long that player was actively doing something
  // (casting, healing). Set for damage/healing rankings; not used for
  // count-based rankings like death causes, where "per second" doesn't
  // make sense.
  rate?: number;
  activeTimeMs?: number;
  // Warcraft Logs' 0-100 "Parse %" score for this row. Only set when the
  // chart is showing a single pull (not "all fights" or a whole encounter),
  // because a parse percentile only makes sense for one specific pull.
  parsePercent?: number;
}

// A Server Component can't pass a plain JS function as a prop to a Client
// Component like this one -- so instead of passing the actual format
// function, callers pass its name ("number" or "count") and we look up
// the real function here.
const FORMATTERS: Record<"number" | "count", (v: number) => string> = {
  number: formatNumber,
  count: (v) => String(v),
};

const DEFAULT_FILL = "#3987e5"; // default bar color (blue)

/**
 * A horizontal bar chart used in two places:
 * 1. Damage/healing rankings on the report page (one bar per player).
 * 2. Death-cause rankings (one bar per cause of death).
 *
 * Data comes in as the `data` prop -- an array of `RankingDatum`, passed
 * down from whichever page or component renders this chart.
 *
 * When `colorByClass` is on, each bar is colored by the player's WoW
 * class (see lib/wowClassColors.ts) instead of one plain color, so a
 * player's row is recognizable at a glance the way it would be on
 * warcraftlogs.com itself.
 *
 * `onBarClick`, if passed, turns the bars into buttons -- clicking one
 * calls it with that row's `name`. Used for drill-downs, e.g. clicking a
 * death cause to see which players died to it (see DeathsPanel.tsx).
 * `selectedName` dims every OTHER bar, so it's obvious which one is
 * currently drilled into.
 */
export function RankingBarChart({
  data,
  format,
  height,
  colorByClass,
  onBarClick,
  selectedName,
}: {
  data: RankingDatum[];
  format: "number" | "count";
  height?: number;
  colorByClass?: boolean;
  onBarClick?: (name: string) => void;
  selectedName?: string | null;
}) {
  const valueFormatter = FORMATTERS[format];
  if (data.length === 0) {
    return <p className="text-sm text-ink-muted">No data for this table.</p>;
  }

  return (
    // ResponsiveContainer: a recharts wrapper that measures the space
    // available and resizes the chart to fit it. Height grows with the
    // number of rows so a short list of bars doesn't look squished.
    <ResponsiveContainer width="100%" height={height ?? Math.max(160, data.length * 32)}>
      {/* BarChart: the chart itself. layout="vertical" makes the bars run
          left-to-right (horizontal bars) instead of the usual up-down. */}
      <BarChart data={data} layout="vertical" margin={{ top: 4, right: 148, bottom: 4, left: 4 }}>
        <CartesianGrid horizontal={false} stroke="#2c2c2a" strokeDasharray="2 4" />
        {/* XAxis: the numeric axis along the bottom, showing values like
            "1.60B" (formatted using the chosen formatter). */}
        <XAxis
          type="number"
          tickFormatter={valueFormatter}
          tick={{ fill: "#898781", fontSize: 11 }}
          axisLine={{ stroke: "#383835" }}
          tickLine={false}
        />
        {/* YAxis: the category axis along the left -- one row per name
            (a player, an ability, etc). Rows are already sorted by the
            caller before they reach this chart. */}
        <YAxis
          type="category"
          dataKey="name"
          width={110}
          tick={{ fill: "#c3c2b7", fontSize: 12 }}
          axisLine={{ stroke: "#383835" }}
          tickLine={false}
        />
        {/* Tooltip: the little popup shown on hover. It renders our own
            ChartTooltip component instead of recharts' default styling. */}
        <Tooltip
          content={<ChartTooltip valueFormatter={valueFormatter} />}
          cursor={{ fill: "rgba(255,255,255,0.04)" }}
        />
        {/* Bar: draws one bar per row of data, using the "value" field. */}
        <Bar dataKey="value" radius={[0, 4, 4, 0]} maxBarSize={22}>
          {/* Cell: lets us color each bar individually, instead of every
              bar being one single color. When colorByClass is on, each
              bar is colored by that player's WoW class; otherwise every
              bar just gets the same default blue.

              When `onBarClick` is passed, each Cell also becomes clickable
              (cursor turns into a pointer) and calls it with that row's
              name. If something is currently selected (`selectedName`),
              every OTHER bar is dimmed (lower fillOpacity) so the picked
              one stands out. */}
          {data.map((d, i) => (
            <Cell
              key={i}
              fill={colorByClass ? classColor(d.className) : DEFAULT_FILL}
              fillOpacity={selectedName && selectedName !== d.name ? 0.35 : 1}
              cursor={onBarClick ? "pointer" : undefined}
              onClick={onBarClick ? () => onBarClick(d.name) : undefined}
            />
          ))}
          {/* LabelList: draws the text label past the end of each bar --
              the number, plus "/s" rate if this ranking has one (damage
              and healing do, death causes don't), plus a colored Parse %
              number when this chart is showing a single pull. The parse
              number is colored using Warcraft Logs' own color scale (see
              wclParseColor.ts) so it reads the same way it does on
              warcraftlogs.com. A custom `content` function is used here
              (instead of a simple `formatter`) because it needs more than
              just the raw value -- it also needs `rate` and `parsePercent`
              off the same row. */}
          <LabelList
            dataKey="value"
            position="right"
            content={(props: { x?: number; y?: number; width?: number; height?: number; index?: number }) => {
              // `index` tells us which row of `data` this label belongs
              // to, so we can pull `rate`/`parsePercent` back out of it.
              const { x = 0, y = 0, width = 0, height: rowHeight = 0, index = 0 } = props;
              const d = data[index];
              if (!d) return null;
              const text =
                d.rate !== undefined
                  ? `${valueFormatter(d.value)} · ${formatNumber(d.rate)}/s`
                  : valueFormatter(d.value);
              return (
                <text x={x + width + 6} y={y + rowHeight / 2} dy={4} fontSize={11}>
                  <tspan fill="#c3c2b7">{text}</tspan>
                  {d.parsePercent !== undefined ? (
                    <tspan fill={parseColor(d.parsePercent)} fontWeight={600}>
                      {"  " + Math.round(d.parsePercent)}
                    </tspan>
                  ) : null}
                </text>
              );
            }}
          />
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

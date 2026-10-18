// Runs in the browser (not on the server) because recharts (the charting
// library) needs to measure the page and handle mouse hovers.
"use client";

// recharts is the charting library this app uses. You give it pieces
// (Line, XAxis, YAxis, etc.) as JSX and it draws the actual SVG chart.
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { formatDate, formatPercent } from "@/lib/format";
import { ChartTooltip } from "./ChartTooltip";

// One point on the line: a raid-night date and the metric's value on that
// night (e.g. kill rate, or number of deaths).
export interface TrendDatum {
  date: string;
  value: number;
}

// Same trick as RankingBarChart.tsx: a Server Component can't pass a
// function as a prop, so we pass a name and look the function up here.
const FORMATTERS: Record<"percent" | "count", (v: number) => string> = {
  percent: formatPercent,
  count: (v) => String(v),
};

/**
 * A line chart used on the guild page to show one metric over several raid
 * nights (e.g. kill rate over time, or deaths per night).
 *
 * Data comes in as the `data` prop, one point per raid night, passed down
 * from the guild page. Always shows a single line -- if two metrics need
 * comparing, this app renders two separate charts side by side instead of
 * squeezing both onto one chart.
 */
export function TrendLineChart({
  data,
  format,
}: {
  data: TrendDatum[];
  format: "percent" | "count";
}) {
  const valueFormatter = FORMATTERS[format];
  if (data.length === 0) {
    return <p className="text-sm text-ink-muted">Not enough raid nights yet.</p>;
  }

  return (
    <ResponsiveContainer width="100%" height={220}>
      <LineChart data={data} margin={{ top: 8, right: 16, bottom: 4, left: 4 }}>
        <CartesianGrid vertical={false} stroke="#2c2c2a" strokeDasharray="2 4" />
        {/* XAxis: always the raid-night date along the bottom -- every
            chart using this component is "one metric over time". */}
        <XAxis
          dataKey="date"
          tickFormatter={formatDate}
          tick={{ fill: "#898781", fontSize: 11 }}
          axisLine={{ stroke: "#383835" }}
          tickLine={false}
        />
        {/* YAxis: the metric's value, formatted using `format` (a percent
            for kill rate, a plain count for deaths). */}
        <YAxis
          tickFormatter={valueFormatter}
          tick={{ fill: "#898781", fontSize: 11 }}
          axisLine={{ stroke: "#383835" }}
          tickLine={false}
          width={48}
        />
        {/* Tooltip: the popup shown on hover -- uses our own ChartTooltip
            component instead of recharts' default styling. */}
        <Tooltip
          content={<ChartTooltip valueFormatter={valueFormatter} />}
          cursor={{ stroke: "#383835", strokeWidth: 1 }}
        />
        {/* Line: draws the actual line connecting each data point. */}
        <Line
          type="monotone"
          dataKey="value"
          stroke="#3987e5"
          strokeWidth={2}
          dot={{ r: 4, fill: "#3987e5", strokeWidth: 0 }}
          activeDot={{ r: 5 }}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}

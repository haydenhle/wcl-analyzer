/**
 * The Augmentation Evoker breakdown. Used two ways:
 *   - Compare tab: two Augs side by side (`sides` has two entries).
 *   - Player analysis tab: one Aug on its own (`sides` has one entry,
 *     `detailsOpen` set) -- a single wide box, with the per-application
 *     tables (who got each buff, their rank, who was actually top) open.
 *
 * The Compare tab's main view: two Augmentation Evokers side by side, one
 * "hero" box each, with every stat that matters for the spec lined up row
 * for row -- headline DPS, Prescience and Shifting Sands targeting, and the
 * key buffs/procs (Ebon Might, Duplicate, Momentum Shift, Essence Burst,
 * Double-time). The better value in each row gets a ▲.
 *
 * Below the boxes: up-time timelines for both players, and the
 * per-application details behind the targeting numbers (collapsed).
 *
 * Counts are also shown per minute: two pulls almost never last the same
 * time, and a raw "40 procs" vs "34 procs" says more about fight length than
 * about the player.
 *
 * No client state -- lib/wcl/service.ts's buildAugmentationAnalysis has
 * already computed everything, so this renders on the server.
 */
import { BuffGradeTable } from "@/components/BuffGradeTable";
import type {
  AugSelfBuffKey,
  AugmentationAnalysisResult,
  BuffTargetingSummary,
  BuffUptimeSummary,
} from "@/lib/analysis/types";
import { formatDuration, formatNumber, formatPercent } from "@/lib/format";

export interface ComparisonSide {
  analysis: AugmentationAnalysisResult;
  label: string; // e.g. "You", "#1 ranked log", "Your raid", "Pasted log"
}

const SIDE_STYLES = [
  { text: "text-viz-series1", bar: "bg-viz-series1", border: "border-viz-series1/50" },
  { text: "text-viz-series2", bar: "bg-viz-series2", border: "border-viz-series2/50" },
] as const;

function wclLink(r: AugmentationAnalysisResult) {
  return `https://www.warcraftlogs.com/reports/${r.reportCode}#fight=${r.fightId}&source=${r.player.actorId}`;
}

function perMinute(count: number, durationMs: number) {
  return durationMs > 0 ? count / (durationMs / 60_000) : 0;
}

function buff(r: AugmentationAnalysisResult, key: AugSelfBuffKey): BuffUptimeSummary | undefined {
  return r.buffs.find((b) => b.key === key);
}

// One comparable row in a hero box. `value` is what decides which side is
// better (higher is always better for every row here); `display` is what's
// shown; `sub` is optional small print under it.
interface StatRow {
  label: string;
  value: (r: AugmentationAnalysisResult) => number | null;
  display: (r: AugmentationAnalysisResult) => string;
  sub?: (r: AugmentationAnalysisResult) => string | null;
}

const pct = (n: number | null) => (n === null ? "--" : formatPercent(n));

function targetingRows(pick: (r: AugmentationAnalysisResult) => BuffTargetingSummary): StatRow[] {
  return [
    {
      label: "On the top DPS",
      value: (r) => pick(r).top1Rate,
      display: (r) => pct(pick(r).top1Rate),
      sub: (r) => (pick(r).top3Rate !== null ? `${pct(pick(r).top3Rate)} on a top-3 DPS` : null),
    },
    {
      label: "Avg. buffed player DPS",
      value: (r) => pick(r).avgRecipientDps,
      display: (r) => (pick(r).avgRecipientDps === null ? "--" : formatNumber(pick(r).avgRecipientDps!)),
      sub: (r) => (pick(r).avgShareOfTop !== null ? `${pct(pick(r).avgShareOfTop)} of the top DPS at the time` : null),
    },
    {
      label: "Applications",
      value: (r) => perMinute(pick(r).graded, r.fightDurationMs),
      display: (r) => `${pick(r).graded} (${perMinute(pick(r).graded, r.fightDurationMs).toFixed(1)}/min)`,
      sub: (r) => (pick(r).autoApplications > 0 ? `+${pick(r).autoApplications} procs not graded` : null),
    },
  ];
}

const uptimeRow = (key: AugSelfBuffKey, label: string): StatRow => ({
  label,
  value: (r) => buff(r, key)?.uptimePct ?? null,
  display: (r) => pct(buff(r, key)?.uptimePct ?? null),
  sub: (r) => {
    const b = buff(r, key);
    return b ? `${b.applications} applied${b.maxStacks > 1 ? ` · max ${b.maxStacks} stacks` : ""}` : null;
  },
});

const procRow = (key: AugSelfBuffKey, label: string): StatRow => ({
  label,
  value: (r) => {
    const b = buff(r, key);
    return b ? perMinute(b.applications + b.stackGains, r.fightDurationMs) : null;
  },
  display: (r) => {
    const b = buff(r, key);
    if (!b) return "--";
    const procs = b.applications + b.stackGains;
    return `${procs} (${perMinute(procs, r.fightDurationMs).toFixed(1)}/min)`;
  },
  sub: (r) => {
    const b = buff(r, key);
    return b ? `${formatPercent(b.uptimePct)} up-time` : null;
  },
});

const SECTIONS: { title: string; note?: string; rows: StatRow[] }[] = [
  {
    title: "Prescience",
    note: "Procs (no matching cast) aren't graded. A target already holding your other Prescience isn't counted as a better option.",
    rows: targetingRows((r) => r.prescience.summary),
  },
  {
    title: "Shifting Sands",
    note: "Goes to whoever's closest when an empowered spell finishes -- this grades positioning.",
    rows: targetingRows((r) => r.shiftingSands.summary),
  },
  {
    title: "Buffs & procs",
    rows: [
      uptimeRow("ebonMight", "Ebon Might up-time"),
      uptimeRow("duplicate", "Duplicate up-time"),
      uptimeRow("momentumShift", "Momentum Shift up-time"),
      procRow("essenceBurst", "Essence Burst procs"),
      procRow("doubleTime", "Double-time procs"),
    ],
  },
];

export function AugmentationPanel({
  sides,
  otherError,
  detailsOpen = false,
}: {
  sides: ComparisonSide[];
  otherError: string | null;
  detailsOpen?: boolean;
}) {
  const analyses = sides.map((s) => s.analysis);
  const single = sides.length === 1 && !otherError;
  const warnings = sides.flatMap((s) => s.analysis.warnings.map((w) => `${s.analysis.player.name}: ${w}`));

  return (
    <div className="space-y-6">
      {warnings.map((w) => (
        <p key={w} className="text-xs text-amber-400">
          {w}
        </p>
      ))}

      <div className={single ? "grid gap-4" : "grid gap-4 lg:grid-cols-2"}>
        {sides.map((side, i) => (
          <HeroBox key={i} side={side} index={i} opponent={analyses[1 - i] ?? null} wide={single} />
        ))}
        {otherError ? (
          <div className="card flex items-center text-sm text-viz-critical">Couldn&apos;t load the comparison: {otherError}</div>
        ) : null}
      </div>

      <section className="card space-y-4">
        <h3 className="text-xs font-semibold text-ink-secondary">Up-time over the fight</h3>
        {analyses[0]!.buffs.map((b) => (
          <div key={b.key} className="grid grid-cols-[9rem_1fr] items-center gap-3">
            <span className="text-sm text-ink-primary">{b.name}</span>
            <div className="space-y-1">
              {analyses.map((a, i) => {
                const mine = buff(a, b.key);
                return mine ? (
                  <TimelineBar key={i} buff={mine} durationMs={a.fightDurationMs} colorClass={SIDE_STYLES[i]!.bar} />
                ) : null;
              })}
            </div>
          </div>
        ))}
      </section>

      <section className="space-y-2">
        <p className="text-xs text-ink-muted">
          Each row ranks every DPS (pets included) by damage per second while that buff was up. The buffed
          player&apos;s own number includes a little help from the buff itself.
        </p>
        {analyses.map((a, i) => (
          <div key={i} className="space-y-2">
            <BuffGradeTable title={`${a.player.name} -- Prescience`} buffName="Prescience" grades={a.prescience.grades} open={detailsOpen} />
            <BuffGradeTable
              title={`${a.player.name} -- Shifting Sands`}
              buffName="Shifting Sands"
              grades={a.shiftingSands.grades}
              open={detailsOpen}
            />
          </div>
        ))}
      </section>
    </div>
  );
}

function HeroBox({
  side,
  index,
  opponent,
  wide = false,
}: {
  side: ComparisonSide;
  index: number;
  opponent: AugmentationAnalysisResult | null;
  // Full page width (one player, no comparison): lay the stat sections
  // out in columns instead of one long stack.
  wide?: boolean;
}) {
  const a = side.analysis;
  const style = SIDE_STYLES[index] ?? SIDE_STYLES[0];
  const dpsBetter = opponent !== null && a.dps > opponent.dps;
  return (
    <section className={`card space-y-5 border ${style.border}`}>
      <div>
        <div className="flex items-baseline justify-between gap-3">
          <h3 className={`text-base font-semibold ${style.text}`}>{a.player.name}</h3>
          <span className="label">{side.label}</span>
        </div>
        <p className="mt-1 text-xs text-ink-muted">
          {a.fightName} · {formatDuration(a.fightDurationMs)} ·{" "}
          <a href={wclLink(a)} target="_blank" rel="noreferrer" className="text-sky-400 hover:underline">
            View on Warcraft Logs
          </a>
        </p>
        <div className="mt-3 flex items-baseline gap-2">
          <span className="text-3xl font-semibold text-ink-primary">{formatNumber(a.dps)}</span>
          <span className="text-sm text-ink-muted">DPS</span>
          {dpsBetter ? <BetterMark /> : null}
        </div>
      </div>

      <div className={wide ? "space-y-5 lg:grid lg:grid-cols-3 lg:gap-6 lg:space-y-0" : "space-y-5"}>
      {SECTIONS.map((section) => (
        <div key={section.title} className="border-t border-surface-border pt-3">
          <h4 className="mb-2 text-xs font-semibold text-ink-secondary">{section.title}</h4>
          <dl className="space-y-2">
            {section.rows.map((row) => {
              const mine = row.value(a);
              const theirs = opponent ? row.value(opponent) : null;
              const better = mine !== null && theirs !== null && mine > theirs;
              const sub = row.sub?.(a);
              return (
                <div key={row.label} className="flex items-start justify-between gap-4">
                  <dt className="text-sm text-ink-secondary">{row.label}</dt>
                  <dd className="text-right">
                    <div className="text-sm text-ink-primary">
                      {row.display(a)} {better ? <BetterMark /> : null}
                    </div>
                    {sub ? <div className="text-xs text-ink-muted">{sub}</div> : null}
                  </dd>
                </div>
              );
            })}
          </dl>
          {section.note ? <p className="mt-2 text-xs text-ink-muted">{section.note}</p> : null}
        </div>
      ))}
      </div>
    </section>
  );
}

function BetterMark() {
  return (
    <span className="text-xs text-viz-good" title="Better than the other side">
      ▲
    </span>
  );
}

function TimelineBar({ buff, durationMs, colorClass }: { buff: BuffUptimeSummary; durationMs: number; colorClass: string }) {
  const d = Math.max(1, durationMs);
  return (
    <div className="relative h-2 w-full rounded bg-viz-gridline" title={`${formatPercent(buff.uptimePct)} up`}>
      {buff.intervals.map((iv, i) => (
        <div
          key={i}
          className={`absolute top-0 h-2 rounded-sm ${colorClass}`}
          style={{ left: `${(iv.start / d) * 100}%`, width: `${Math.max(0.3, ((iv.end - iv.start) / d) * 100)}%` }}
        />
      ))}
    </div>
  );
}

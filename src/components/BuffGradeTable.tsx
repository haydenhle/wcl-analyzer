/**
 * The per-application table for one Augmentation Evoker's Prescience or
 * Shifting Sands (who got each one, their DPS, their rank, who was top),
 * plus the pop-up you get by clicking a row: every DPS in the raid ranked
 * by damage per second during exactly that buff's window, with the player
 * who was buffed highlighted -- "was this the right person, and who should
 * it have been?" at a glance.
 *
 * Procs (applications with no matching cast -- Motes of Possibility and
 * friends) are hidden by default: they weren't a decision, so they're just
 * noise when reviewing targeting. A checkbox brings them back.
 *
 * A client component only because of the click-to-open / toggle state; all the
 * numbers were computed server-side (see gradeApplications in
 * lib/analysis/augmentation.ts, which fills in `ranking` for each row).
 *
 * The chart is plain HTML bars rather than a charting library: one ranked
 * list, one value per player, colored by class (identity) -- with the
 * buffed player marked by a label and a highlighted row, not by color
 * alone.
 */
"use client";

import { useEffect, useRef, useState } from "react";
import type { BuffTargetGrade } from "@/lib/analysis/types";
import { formatDuration, formatNumber, formatPercent } from "@/lib/format";
import { classColor } from "@/lib/wowClassColors";

const pct = (n: number | null) => (n === null ? "--" : formatPercent(n));

export function BuffGradeTable({
  title,
  buffName,
  grades,
  open = false,
}: {
  title: string;
  buffName: string;
  grades: BuffTargetGrade[];
  open?: boolean;
}) {
  const [selected, setSelected] = useState<number | null>(null);
  const [showProcs, setShowProcs] = useState(false);
  const procCount = grades.filter((g) => g.deliberate === false).length;
  const visible = showProcs ? grades : grades.filter((g) => g.deliberate !== false);
  const selectedGrade = selected !== null ? visible[selected] : undefined;

  return (
    <details className="rounded-lg border border-surface-border" open={open}>
      <summary className="cursor-pointer px-4 py-2 text-xs font-semibold text-ink-secondary">
        {title} ({visible.length}
        {!showProcs && procCount > 0 ? ` · ${procCount} procs hidden` : ""})
      </summary>
      {grades.length === 0 ? (
        <p className="px-4 pb-3 text-xs text-ink-muted">None found in this pull.</p>
      ) : (
        <div className="overflow-x-auto px-4 pb-3">
          <div className="flex flex-wrap items-center justify-between gap-2 pb-2">
            <p className="text-xs text-ink-muted">Click a row to see the whole raid&apos;s DPS while that {buffName} was up.</p>
            {procCount > 0 ? (
              <label className="flex cursor-pointer items-center gap-1.5 text-xs text-ink-secondary">
                <input
                  type="checkbox"
                  checked={showProcs}
                  onChange={(e) => {
                    setSelected(null);
                    setShowProcs(e.target.checked);
                  }}
                  className="accent-sky-500"
                />
                Show procs ({procCount})
              </label>
            ) : null}
          </div>
          <table className="w-full min-w-[28rem] text-left text-sm">
            <thead>
              <tr className="label border-b border-surface-border">
                <th className="py-1.5 pr-3 font-medium">Time</th>
                <th className="py-1.5 pr-3 font-medium">Buffed</th>
                <th className="py-1.5 pr-3 font-medium">Their DPS</th>
                <th className="py-1.5 pr-3 font-medium">Rank</th>
                <th className="py-1.5 font-medium">% of top</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((g, i) => (
                <tr
                  key={i}
                  tabIndex={0}
                  role="button"
                  aria-label={`Show the raid's DPS during the ${buffName} on ${g.recipientName} at ${formatDuration(g.timeMs)}`}
                  onClick={() => setSelected(i)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      setSelected(i);
                    }
                  }}
                  className="cursor-pointer border-b border-surface-border/60 last:border-0 hover:bg-white/5 focus:bg-white/5 focus:outline-none"
                >
                  <td className="py-1.5 pr-3 text-ink-secondary">{formatDuration(g.timeMs)}</td>
                  <td className="py-1.5 pr-3">
                    <PlayerName name={g.recipientName} className={g.recipientClass} />
                  </td>
                  <td className="py-1.5 pr-3 text-ink-primary">{formatNumber(g.recipientDps)}</td>
                  <td className="py-1.5 pr-3">
                    <RankBadge grade={g} />
                  </td>
                  <td className="py-1.5 text-ink-primary">{pct(g.shareOfTop)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {selectedGrade ? <RaidDpsDialog grade={selectedGrade} buffName={buffName} onClose={() => setSelected(null)} /> : null}
    </details>
  );
}

function RaidDpsDialog({ grade, buffName, onClose }: { grade: BuffTargetGrade; buffName: string; onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);

  // Esc closes it; focus starts on the close button so the keyboard lands
  // inside the dialog instead of behind it.
  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const max = Math.max(1, ...grade.ranking.map((r) => r.dps));
  // The first player who was actually a valid pick -- the "should have
  // been" target. Blocked players (already holding your other Prescience)
  // are shown but don't count.
  const best = grade.ranking.find((r) => !r.blocked);
  const end = grade.timeMs + grade.windowMs;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="raid-dps-dialog-title"
        className="card max-h-[90vh] w-full max-w-2xl overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 id="raid-dps-dialog-title" className="text-sm font-semibold text-ink-primary">
              Raid DPS during {buffName} on {grade.recipientName}
            </h3>
            <p className="mt-1 text-xs text-ink-muted">
              {formatDuration(grade.timeMs)}–{formatDuration(end)} ({(grade.windowMs / 1000).toFixed(1)}s window)
              {grade.deliberate === false ? " · a proc, not a cast -- not graded" : ""}
            </p>
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            className="rounded-lg border border-surface-border px-2.5 py-1 text-xs text-ink-secondary hover:border-sky-500"
          >
            Close
          </button>
        </div>

        <p className="mt-3 text-sm text-ink-secondary">
          {grade.rank === null ? (
            <>
              {grade.recipientName} isn&apos;t a DPS, so this one can&apos;t be ranked.
            </>
          ) : grade.rank === 1 ? (
            <>
              <span className="text-viz-good">Right call.</span> {grade.recipientName} was the top DPS during this window.
            </>
          ) : (
            <>
              {grade.recipientName} ranked <span className="text-ink-primary">#{grade.rank}</span> of {grade.candidates}, doing{" "}
              {pct(grade.shareOfTop)} of {best?.name ?? grade.topName}&apos;s DPS.
            </>
          )}
        </p>

        <ol className="mt-4 space-y-1.5">
          {grade.ranking.map((r) => (
            <li
              key={r.name}
              title={`${r.name}: ${formatNumber(r.dps)} DPS (${max > 0 ? formatPercent(r.dps / max) : "--"} of the highest)`}
              className={`grid grid-cols-[8.5rem_1fr_4.5rem] items-center gap-3 rounded px-2 py-1 ${r.recipient ? "bg-sky-500/10 ring-1 ring-sky-500/60" : ""}`}
            >
              <span className={`flex min-w-0 items-center gap-1.5 text-sm ${r.recipient ? "font-semibold text-ink-primary" : "text-ink-secondary"}`}>
                <span className="inline-block h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: classColor(r.className) }} />
                <span className="truncate">{r.name}</span>
              </span>
              <span className="relative h-2.5 rounded-sm bg-viz-gridline">
                <span
                  className={`absolute inset-y-0 left-0 rounded-r ${r.blocked ? "opacity-40" : ""}`}
                  style={{ width: `${(r.dps / max) * 100}%`, backgroundColor: classColor(r.className) }}
                />
              </span>
              <span className="text-right text-xs text-ink-primary">{formatNumber(r.dps)}</span>
              {r.recipient || r.blocked || r === best ? (
                <span className="col-span-3 -mt-1 pl-[1.1rem] text-xs text-ink-muted">
                  {[
                    r.recipient ? `Got the ${buffName}` : null,
                    r === best && !r.recipient ? "Best available target" : null,
                    r.blocked ? "Already had your other Prescience" : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              ) : null}
            </li>
          ))}
        </ol>
        <p className="mt-4 text-xs text-ink-muted">
          Damage per second during this window only, pets included. The buffed player&apos;s number includes a little help
          from the buff itself.
        </p>
      </div>
    </div>
  );
}

function RankBadge({ grade }: { grade: BuffTargetGrade }) {
  if (grade.deliberate === false) return <span className="text-ink-muted">proc</span>;
  if (grade.rank === null) return <span className="text-viz-critical">not a DPS</span>;
  const cls = grade.rank === 1 ? "text-viz-good" : grade.rank <= 3 ? "text-amber-400" : "text-viz-critical";
  return (
    <span className={cls}>
      #{grade.rank} <span className="text-ink-muted">of {grade.candidates}</span>
    </span>
  );
}

function PlayerName({ name, className }: { name: string; className: string | null }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-ink-primary">
      <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: classColor(className) }} />
      {name}
    </span>
  );
}

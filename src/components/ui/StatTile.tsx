/**
 * A generic small stat box: a label, a big number, and an optional detail
 * line underneath. Reused for the "Fights / Kills / Wipes / Deaths" tiles
 * on both dashboard pages.
 *
 * Everything it shows comes in as props (`label`, `value`, `sub`) already
 * formatted as text by whoever renders it -- this component just displays
 * them and doesn't know or care what the numbers mean.
 */
export function StatTile({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div className="card">
      <div className="label">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums text-ink-primary">{value}</div>
      {sub ? <div className="mt-1 text-xs text-ink-muted">{sub}</div> : null}
    </div>
  );
}

/**
 * This is not a page you navigate to -- Next.js shows it automatically,
 * in place of report/[code]/page.tsx, while that page is still waiting on
 * `buildReportAnalysis` to fetch data. As soon as the real data is ready,
 * Next.js swaps this out for the real page.
 *
 * The gray pulsing boxes below are a rough stand-in for the real stat
 * tiles and chart, so the page doesn't visually "jump" when it finishes.
 */
export default function Loading() {
  return (
    <div className="space-y-6">
      <div className="h-8 w-64 animate-pulse rounded bg-surface-raised" />
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="card h-20 animate-pulse" />
        ))}
      </div>
      <div className="card h-64 animate-pulse" />
    </div>
  );
}

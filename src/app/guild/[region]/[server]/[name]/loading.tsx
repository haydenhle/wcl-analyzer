/**
 * Same idea as report/[code]/loading.tsx: Next.js shows this automatically
 * while the guild page next to it is still fetching data, then swaps it
 * out once the real page is ready.
 *
 * The guild page's fetch (`buildGuildTrend`) has to pull data for several
 * raid nights, not just one, so this can take a bit longer -- the message
 * below tells the user that instead of leaving them staring at a blank
 * spinner.
 */
export default function Loading() {
  return (
    <div className="space-y-6">
      <div className="h-8 w-72 animate-pulse rounded bg-surface-raised" />
      <p className="text-sm text-ink-muted">
        Pulling recent raid nights and death data -- this fetches several reports, so it can take a
        few seconds.
      </p>
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="card h-20 animate-pulse" />
        ))}
      </div>
      <div className="card h-64 animate-pulse" />
    </div>
  );
}

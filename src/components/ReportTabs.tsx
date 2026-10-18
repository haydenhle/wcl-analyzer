/**
 * The tab bar at the top of the report page: "Raid overview" (the whole
 * raid's numbers -- stat tiles, damage/healing charts, deaths), "Player
 * analysis" (one player's casts vs. the top log), and "Compare" (one
 * Augmentation Evoker side by side with another -- the #1 log, another Aug
 * in the same raid, or any pasted log).
 *
 * The active tab lives in the URL (`?tab=player`), not in component state,
 * for the same reasons every other control on this page does:
 *   - the server only fetches what the open tab actually shows -- the
 *     player tab's data (especially the Augmentation breakdown) is by far
 *     the most expensive part of this page, so the raid tab never pays for
 *     it;
 *   - a link to a specific tab + pull + player can be shared or reloaded.
 *
 * Plain links, so this renders on the server -- no "use client" needed.
 * Every other query param (scope, analyze, compare, ...) is carried over.
 */
import Link from "next/link";

export type ReportTab = "raid" | "player" | "compare";

const TABS: { id: ReportTab; label: string }[] = [
  { id: "raid", label: "Raid overview" },
  { id: "player", label: "Player analysis" },
  { id: "compare", label: "Compare" },
];

export function ReportTabs({
  code,
  activeTab,
  params,
}: {
  code: string;
  activeTab: ReportTab;
  params: Record<string, string | undefined>;
}) {
  function hrefFor(tab: ReportTab) {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value && key !== "tab") query.set(key, value);
    }
    query.set("tab", tab);
    return `/report/${code}?${query.toString()}`;
  }

  return (
    <nav className="flex gap-1 border-b border-surface-border" aria-label="Report sections">
      {TABS.map((t) => {
        const active = t.id === activeTab;
        return (
          <Link
            key={t.id}
            href={hrefFor(t.id)}
            aria-current={active ? "page" : undefined}
            className={
              active
                ? "-mb-px border-b-2 border-sky-500 px-4 py-2 text-sm font-medium text-ink-primary"
                : "-mb-px border-b-2 border-transparent px-4 py-2 text-sm text-ink-muted hover:text-ink-secondary"
            }
          >
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}

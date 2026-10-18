/**
 * A dropdown on the report page for picking a player to run the
 * casts-per-minute / rotational-suggestion analysis on (see
 * PlayerAnalysisPanel). Only rendered by the report page when exactly one
 * pull is in view -- this analysis compares one specific fight's casts
 * against the server-wide top log for that same fight, so "all fights" or
 * "all of this boss's kills" doesn't have a single fight to compare.
 *
 * Same URL-param pattern as MythicOnlyToggle/NightsSampleSelector: picking a
 * player doesn't fetch anything itself, it just MERGES `?analyze=<name>`
 * into the current query string (so the `?scope=` fight selection isn't
 * lost), which makes the report page re-run scoped to that player.
 */
"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { classDisplayName } from "@/lib/wowClassColors";

export interface PlayerAnalysisOption {
  name: string;
  className: string;
}

export function PlayerAnalysisSelector({ players }: { players: PlayerAnalysisOption[] }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const current = searchParams.get("analyze") ?? "";

  function onChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const params = new URLSearchParams(searchParams.toString());
    if (e.target.value) {
      params.set("analyze", e.target.value);
    } else {
      params.delete("analyze");
    }
    const query = params.toString();
    router.push(query ? `${pathname}?${query}` : pathname);
  }

  if (players.length === 0) return null;

  return (
    <select
      value={current}
      onChange={onChange}
      className="rounded-lg border border-surface-border bg-surface px-3 py-2 text-sm text-ink-primary focus:border-sky-500 focus:outline-none"
    >
      <option value="">Analyze a player...</option>
      {players.map((p) => (
        <option key={p.name} value={p.name}>
          {p.name} ({classDisplayName(p.className)})
        </option>
      ))}
    </select>
  );
}

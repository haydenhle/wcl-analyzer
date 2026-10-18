/**
 * A dropdown on the report page for picking which fights to look at --
 * all fights, all kills, all wipes, one boss's pulls, or a single pull.
 *
 * Data flow: `fights` and `code` are passed in as props from the report
 * page (a parent component). When the user picks an option, this dropdown
 * doesn't fetch anything itself -- it just changes the page's URL to
 * "/report/[code]?scope=...". That URL change makes the report page
 * re-run and re-fetch, scoped to just the fights that were picked, so the
 * whole dashboard (stat tiles, charts, deaths) updates together.
 */
// "use client" means this component runs in the browser (not on the
// server) so it can respond to the dropdown changing, unlike most of this
// app which renders on the server before the page is sent to you.
"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { buildFightScopeGroups } from "@/lib/analysis/fightScope";
import type { WCLFight } from "@/lib/wcl/types";

export function FightScopeSelector({
  code,
  fights,
  currentScope,
}: {
  code: string;
  fights: WCLFight[];
  currentScope: string;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const groups = buildFightScopeGroups(fights);

  // Only `scope` changes -- everything else in the URL (which tab is open,
  // which player is being analyzed, a pasted comparison link) is kept, so
  // stepping through pulls on the Player tab doesn't bounce you back to the
  // Raid tab or make you re-pick your player every time.
  function onChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const params = new URLSearchParams(searchParams.toString());
    if (e.target.value) params.set("scope", e.target.value);
    else params.delete("scope");
    const query = params.toString();
    router.push(query ? `/report/${code}?${query}` : `/report/${code}`);
  }

  return (
    <select
      value={currentScope}
      onChange={onChange}
      className="rounded-lg border border-surface-border bg-surface px-3 py-2 text-sm text-ink-primary focus:border-sky-500 focus:outline-none"
    >
      <option value="">All fights</option>
      <option value="kills">All kills</option>
      <option value="wipes">All wipes</option>
      {groups.map((g) => (
        <optgroup key={g.encounterID} label={g.bossName}>
          <option value={`encounter:${g.encounterID}`}>All pulls ({g.pulls.length})</option>
          {g.killCount > 0 ? (
            <option value={`encounter:${g.encounterID}:kills`}>Kills ({g.killCount})</option>
          ) : null}
          {g.wipeCount > 0 ? (
            <option value={`encounter:${g.encounterID}:wipes`}>Wipes ({g.wipeCount})</option>
          ) : null}
          {g.pulls.map((p) => (
            <option key={p.id} value={`fight:${p.id}`}>
              Pull {p.pullNumber} -- {p.kill ? "Kill" : p.bossPercentage != null ? `Wipe (${p.bossPercentage.toFixed(1)}%)` : "Wipe"}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}

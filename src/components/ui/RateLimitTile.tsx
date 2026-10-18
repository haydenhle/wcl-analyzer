import type { WCLRateLimitStatus } from "@/lib/wcl/types";
import { StatTile } from "./StatTile";

/**
 * A small stat tile showing how much of the Warcraft Logs API quota has
 * been used this hour. `rateLimit` is passed in as a prop (fetched
 * alongside the rest of the page's data). If it's missing (the check
 * itself failed), this tile just renders nothing -- it's a nice-to-have,
 * not worth showing an error over.
 */
export function RateLimitTile({ rateLimit }: { rateLimit: WCLRateLimitStatus | null }) {
  if (!rateLimit) return null;

  // The API gives us a reset time in seconds and raw point counts -- turn
  // those into "resets in Nm" and a used percentage for display.
  const resetMinutes = Math.ceil(rateLimit.pointsResetIn / 60);
  const usedPct = rateLimit.limitPerHour > 0 ? rateLimit.pointsSpentThisHour / rateLimit.limitPerHour : 0;

  return (
    <StatTile
      label="API quota (this hour)"
      value={`${Math.round(rateLimit.pointsSpentThisHour)} / ${rateLimit.limitPerHour}`}
      sub={`${Math.round(usedPct * 100)}% used · resets in ${resetMinutes}m`}
    />
  );
}

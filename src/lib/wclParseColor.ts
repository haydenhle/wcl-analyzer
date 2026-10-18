/**
 * This file's job: turn a "Parse %" (a 0-100 percentile ranking of how
 * good a player's performance was, compared to everyone else who logged
 * that fight) into the color Warcraft Logs itself uses to show it.
 *
 * This is Warcraft Logs' own color scale, not one this app invented:
 * grey (low) -> green -> blue -> purple -> orange -> pink -> gold (top rank).
 * We match it exactly so the colors mean the same thing here as they do
 * on the Warcraft Logs website.
 */
export function parseColor(percent: number): string {
  if (percent >= 100) return "#e5cc80"; // gold -- rank 1 (best in the world/region)
  if (percent >= 99) return "#e268a8"; // pink -- 99th percentile
  if (percent >= 95) return "#ff8000"; // orange -- 95th-98th percentile
  if (percent >= 75) return "#a335ee"; // purple -- 75th-94th percentile
  if (percent >= 50) return "#0070ff"; // blue -- 50th-74th percentile
  if (percent >= 25) return "#1eff00"; // green -- 25th-49th percentile
  return "#666666"; // grey -- below 25th percentile
}

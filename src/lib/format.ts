/**
 * This file's job: small helper functions that turn raw numbers, ISO
 * dates, and millisecond durations into short, readable text for the UI
 * -- stat tiles, chart axes, tooltips. No network calls, no React, just
 * plain string formatting.
 */

// Big totals like damage/healing numbers can run into the billions, so
// this shortens them to labels like "1.60B" or "450.00M" instead of a
// long string of digits.
export function formatNumber(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return Math.round(n).toString();
}

// Turns a 0..1 fraction (like FightsSummary.killRate) into a percent
// string, e.g. 0.625 -> "62.5%".
export function formatPercent(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

// Turns a duration in milliseconds into "m:ss", e.g. for a fight length
// or how far into a pull something happened. Not used on a page yet, but
// kept here alongside the other formatters for when it's needed.
export function formatDuration(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

// Turns an ISO date string into a short readable label for chart axes and
// tables, e.g. "Aug 16, 2026".
export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/**
 * Turns a WoW server name into the URL-safe slug the Warcraft Logs API
 * expects, e.g. "Area 52" -> "area-52", "Kel'Thuzad" -> "kelthuzad".
 */
export function slugifyServerName(server: string): string {
  return server
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-");
}

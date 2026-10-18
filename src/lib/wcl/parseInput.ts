/**
 * This file's job: take whatever the user typed into the search box (a
 * report code, or a full Warcraft Logs report URL) and turn it into a
 * clean report code the API can use.
 *
 * Accepts either a bare code or a URL like
 * "https://www.warcraftlogs.com/reports/AbCdEfGhJkLmNoPq#fight=3", and
 * returns just the code. Returns null if the input doesn't look like
 * either one.
 */
export function parseReportCode(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  // Case 1: a full report URL was pasted in -- pull just the code out of
  // the path, and ignore anything after it (like #fight=3).
  const urlMatch = trimmed.match(/warcraftlogs\.com\/reports\/([a-zA-Z0-9]+)/);
  if (urlMatch?.[1]) return urlMatch[1];

  // Case 2: a bare code was pasted in directly. Report codes are letters
  // and numbers, usually 16 characters -- we accept a wider range (6-32)
  // so we don't reject a real code just because our length guess is off.
  if (/^[a-zA-Z0-9]{6,32}$/.test(trimmed)) return trimmed;

  // Didn't match either shape -- let the caller show a "that doesn't look
  // like a report code/URL" message instead of sending bad input to the API.
  return null;
}

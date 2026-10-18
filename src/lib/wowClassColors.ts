/**
 * This file's job: map each WoW class name (like "Mage" or "Druid") to its
 * official color, so damage/healing charts can color each player's bar by
 * their class. These are the exact colors Blizzard uses in-game and that
 * Warcraft Logs itself uses -- not colors this app made up -- so players
 * already recognize them at a glance.
 */

// The order Blizzard itself lists classes in (roughly release order).
// This order is fixed and never changes, so class colors stay consistent
// across charts.
export const WOW_CLASS_ORDER = [
  "DeathKnight",
  "DemonHunter",
  "Druid",
  "Evoker",
  "Hunter",
  "Mage",
  "Monk",
  "Paladin",
  "Priest",
  "Rogue",
  "Shaman",
  "Warlock",
  "Warrior",
] as const;

const CLASS_COLORS: Record<string, string> = {
  DeathKnight: "#C41F3B",
  DemonHunter: "#A330C9",
  Druid: "#FF7D0A",
  Evoker: "#33937F",
  Hunter: "#ABD473",
  Mage: "#69CCF0",
  Monk: "#00FF96",
  Paladin: "#F58CBA",
  // Priest's real color is pure white (#FFFFFF). We use an off-white
  // instead so the bar still looks like a filled bar, not a blank gap.
  Priest: "#E6E6E6",
  Rogue: "#FFF569",
  Shaman: "#0070DE",
  Warlock: "#9482C9",
  Warrior: "#C79C6E",
};

// Color used when we don't recognize the class name, so a chart still
// renders instead of breaking.
const FALLBACK_COLOR = "#6b7280";

/**
 * Cleans up a class name so it matches the keys in CLASS_COLORS above.
 * The class name coming from Warcraft Logs can show up as "DeathKnight",
 * "death-knight", etc. -- this strips spaces/dashes/underscores and
 * capitalizes the first letter so it always matches.
 */
export function normalizeClassName(raw: string): string {
  return raw
    .replace(/[\s_-]+/g, "")
    .replace(/^[a-z]/, (c) => c.toUpperCase());
}

// Looks up the color for a class name. Returns the fallback grey if the
// name is missing or unrecognized.
export function classColor(raw: string | undefined | null): string {
  if (!raw) return FALLBACK_COLOR;
  return CLASS_COLORS[normalizeClassName(raw)] ?? FALLBACK_COLOR;
}

/** "DeathKnight" -> "Death Knight"; single-word classes pass through. */
export function classDisplayName(raw: string): string {
  return normalizeClassName(raw).replace(/([a-z])([A-Z])/g, "$1 $2");
}

/**
 * This file's job: know whether a class+spec is a damage dealer, healer, or
 * tank. Used by the player-analysis feature to decide which metric ("dps" or
 * "hps") makes sense when looking up "the top log" for someone's spec --
 * ranking a healer's log by damage-per-second would just be wrong.
 *
 * Unlike this app's other lib/wow*.ts files (wowDifficulty.ts,
 * wowClassColors.ts), this ISN'T something Warcraft Logs' API can answer --
 * there's no "role" field on a character. Role is fixed by the game's own
 * class design instead (Discipline Priest has always been a healer, Fury
 * Warrior has always been a dps), so it's safe to hardcode here the same way
 * wowClassColors.ts hardcodes Blizzard's own class colors.
 *
 * Class and spec names below match Warcraft Logs' own naming exactly (see
 * wowClassColors.ts's WOW_CLASS_ORDER, and the `icon` field on a table entry,
 * which looks like "DeathKnight-Blood" -- confirmed against a real report
 * with scripts/wcl-diagnose-player-analysis.mjs).
 */

export type PlayerRole = "dps" | "healer" | "tank";

const SPEC_ROLES: Record<string, Record<string, PlayerRole>> = {
  DeathKnight: { Blood: "tank", Frost: "dps", Unholy: "dps" },
  DemonHunter: { Havoc: "dps", Vengeance: "tank" },
  Druid: { Balance: "dps", Feral: "dps", Guardian: "tank", Restoration: "healer" },
  Evoker: { Devastation: "dps", Preservation: "healer", Augmentation: "dps" },
  Hunter: { BeastMastery: "dps", Marksmanship: "dps", Survival: "dps" },
  Mage: { Arcane: "dps", Fire: "dps", Frost: "dps" },
  Monk: { Brewmaster: "tank", Mistweaver: "healer", Windwalker: "dps" },
  Paladin: { Holy: "healer", Protection: "tank", Retribution: "dps" },
  Priest: { Discipline: "healer", Holy: "healer", Shadow: "dps" },
  Rogue: { Assassination: "dps", Outlaw: "dps", Subtlety: "dps" },
  Shaman: { Elemental: "dps", Enhancement: "dps", Restoration: "healer" },
  Warlock: { Affliction: "dps", Demonology: "dps", Destruction: "dps" },
  Warrior: { Arms: "dps", Fury: "dps", Protection: "tank" },
};

/**
 * Looks up a class+spec's role. Defaults to "dps" for anything unrecognized
 * (a new spec this list hasn't been updated for yet, or a bad name) --
 * "dps" is the most common role, so it's the least-wrong fallback.
 */
export function roleForSpec(className: string, specName: string): PlayerRole {
  return SPEC_ROLES[className]?.[specName] ?? "dps";
}

/**
 * Which WCL ranking metric matches a role: healers get ranked by "hps"
 * (healing per second), everyone else by "dps" -- tanks included, since a
 * tank's own damage output is still what WCL ranks tanks by.
 */
export function metricForRole(role: PlayerRole): "dps" | "hps" {
  return role === "healer" ? "hps" : "dps";
}

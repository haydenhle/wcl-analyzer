/**
 * This file's job: know which raid pulls count as "Mythic" difficulty, for
 * the guild page's "Mythic only" filter button.
 *
 * This file used to hardcode a single number ("Mythic = difficulty 4"),
 * confirmed against one real report. That turned out to be wrong to rely
 * on everywhere: `WCLFight.difficulty` ids are assigned PER RAID TIER, not
 * globally. A guild's older raid tier really did use difficulty 4 for
 * Mythic, but the current tier ("The Venomous Abyss") uses difficulty 5
 * instead -- confirmed with scripts/wcl-diagnose-difficulty.mjs against a
 * report from that zone. Every single fight in it was either difficulty 5
 * (with the 20-player lock Mythic raids always have) or null (trash).
 * Hardcoding either number would eventually be wrong again for some future
 * tier, so instead this app now looks up each REPORT's own zone and asks
 * Warcraft Logs which id THAT zone calls "Mythic" (see getZoneDifficulties
 * in lib/wcl/queries.ts) -- one lookup per zone, not one guess for all of
 * them.
 *
 * As a second safety check, `isMythicFight` also requires `size === 20`.
 * Mythic raids are always locked to exactly 20 players (Heroic/Normal
 * aren't) -- this app confirmed that alongside the difficulty-id finding
 * above. It rules out anything that might share a "Mythic" difficulty id
 * with an actual raid but isn't one, like 5-player Mythic+ dungeon content.
 */
import type { WCLZoneDifficulty } from "@/lib/wcl/types";

// Used only when a zone's difficulty catalog can't be fetched, or doesn't
// have anything named "Mythic" (e.g. a non-raid zone) -- the value from the
// current raid tier's own catalog, kept as a reasonable last resort rather
// than a guess pulled out of thin air.
export const FALLBACK_MYTHIC_DIFFICULTY_ID = 5;

/**
 * Finds the difficulty id Warcraft Logs itself labels "Mythic" in one
 * zone's difficulty list. Returns null if that zone has no such entry
 * (e.g. it isn't a raid).
 */
export function findMythicDifficultyId(difficulties: WCLZoneDifficulty[]): number | null {
  return difficulties.find((d) => d.name === "Mythic")?.id ?? null;
}

/**
 * Whether one fight was a genuine Mythic-difficulty raid pull.
 * `mythicDifficultyId` is that report's own zone's "Mythic" id -- look it
 * up with findMythicDifficultyId first, once per zone.
 */
export function isMythicFight(
  fight: { difficulty: number | null; size: number | null },
  mythicDifficultyId: number
): boolean {
  return fight.difficulty === mythicDifficultyId && fight.size === 20;
}

/**
 * Whether one fight's difficulty+size belongs to a RAID zone's own
 * difficulty catalog at all (LFR/Normal/Heroic/Mythic -- whichever that
 * zone has), regardless of which of those it is. Used to tell a genuine
 * pull of that zone's content apart from something else entirely (most
 * commonly a Mythic+ dungeon fight) that happens to reuse the same
 * difficulty NUMBER -- dungeon keystones use their own unrelated
 * numbering/size scheme, so they won't match any entry in a raid zone's
 * catalog, while every real pull of that raid (at any difficulty) will.
 *
 * Why this exists: a single WCL report can bundle a few Mythic+ keystones
 * together with that same night's raid pulls -- one logger recording
 * straight through a "warmup keys, then raid" night. Warcraft Logs then
 * labels the WHOLE report's top-level `zone` by whichever content was
 * logged FIRST, which is often the dungeon, not the raid, even though the
 * report also contains real raid-tier pulls. `collectCurrentTierReports`
 * (lib/wcl/service.ts) uses this as a fallback, per-fight check for a
 * report whose own advertised zone doesn't match the current tier, instead
 * of trusting that top-level label alone and silently dropping a report
 * that's genuinely part of this tier.
 */
export function isTierZoneFight(
  fight: { difficulty: number | null; size: number | null },
  zoneDifficulties: WCLZoneDifficulty[]
): boolean {
  if (fight.difficulty === null) return false;
  const difficulty = zoneDifficulties.find((d) => d.id === fight.difficulty);
  if (!difficulty) return false;
  return fight.size === null || difficulty.sizes.includes(fight.size);
}

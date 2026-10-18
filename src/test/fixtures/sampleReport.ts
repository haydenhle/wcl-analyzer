/**
 * A small, hand-built "report" -- one trash pull plus a wipe-then-kill on
 * the same boss -- shared by both analysis.report.test.ts and
 * analysis.guild.test.ts. Shaped to match the REAL live-API response (see
 * README "Verifying against the live schema"), not the schema's own
 * (sparse) docs, so these tests catch a regression against reality, not
 * against a guess.
 */
import type { WCLFight, WCLTableEntry } from "@/lib/wcl/types";

export const sampleFights: WCLFight[] = [
  // Fight 1: trash -- `kill: null` is WCL's convention for a pull that's
  // neither a clean kill nor a wipe (deliberately exercises the `=== true`
  // / `=== false` checks in summarizeFights, not just truthiness).
  {
    id: 1,
    name: "Trash",
    startTime: 0,
    endTime: 60_000,
    kill: null,
    difficulty: null,
    encounterID: 0,
    bossPercentage: null,
    fightPercentage: null,
    size: 20,
    phaseTransitions: [],
  },
  // Fight 2: a wipe on the boss, at 12.4% remaining.
  {
    id: 2,
    name: "Ulgrax the Devourer",
    startTime: 60_000,
    endTime: 360_000,
    kill: false,
    difficulty: 5,
    encounterID: 2902,
    bossPercentage: 12.4,
    fightPercentage: 12.4,
    size: 20,
    phaseTransitions: [],
  },
  // Fight 3: the kill, same boss, next pull. Has two phases, so
  // player-analysis tests (and anything exercising phaseTransitions) have a
  // real multi-phase fixture to use, not just single-phase fights.
  {
    id: 3,
    name: "Ulgrax the Devourer",
    startTime: 360_000,
    endTime: 660_000,
    kill: true,
    difficulty: 5,
    encounterID: 2902,
    bossPercentage: 0,
    fightPercentage: 0,
    size: 20,
    phaseTransitions: [
      { id: 1, startTime: 360_000 },
      { id: 2, startTime: 510_000 },
    ],
  },
];

// Deliberately out of ranked order (Alice > Bob > Carol by total) so
// rankEntries' sort-by-total is actually exercised, not just its shape.
export const sampleDamageEntries: WCLTableEntry[] = [
  { name: "Alice", id: 1, guid: 111, type: "Mage", total: 5_000_000, activeTime: 300_000 },
  { name: "Bob", id: 2, guid: 222, type: "Warrior", total: 4_200_000, activeTime: 290_000 },
  { name: "Carol", id: 3, guid: 333, type: "Priest", total: 500_000, activeTime: 280_000 },
];

export const sampleHealingEntries: WCLTableEntry[] = [
  { name: "Carol", id: 3, guid: 333, type: "Priest", total: 3_000_000, activeTime: 280_000 },
  { name: "Dave", id: 4, guid: 444, type: "Druid", total: 2_500_000, activeTime: 260_000 },
];

// timestamp values are report-relative ms, matching fight.startTime/endTime.
// `fight` is the fight ID the death occurred in, straight from the API.
export const sampleDeathEntries: WCLTableEntry[] = [
  {
    name: "Bob",
    id: 2,
    guid: 222,
    type: "Warrior",
    timestamp: 120_000, // 60_000ms into fight 2 (60_000-360_000)
    fight: 2,
    killingBlow: { name: "Devour", guid: 999 },
    overkill: 1000,
  },
  {
    name: "Alice",
    id: 1,
    guid: 111,
    type: "Mage",
    timestamp: 200_000, // also in fight 2
    fight: 2,
    killingBlow: { name: "Devour", guid: 999 },
    overkill: 200,
  },
  {
    name: "Dave",
    id: 4,
    guid: 444,
    type: "Druid",
    timestamp: 400_000, // 40_000ms into fight 3 (360_000-660_000)
    fight: 3,
    killingBlow: { name: "Venomous Lash", guid: 111 },
    overkill: 0,
  },
];

import { describe, expect, it } from "vitest";
import { findMythicDifficultyId, isMythicFight } from "@/lib/wowDifficulty";

describe("isMythicFight", () => {
  // The zone's own "Mythic" id -- looked up per report, not hardcoded (see
  // lib/wowDifficulty.ts for why one raid tier's id doesn't carry over to
  // another).
  const MYTHIC_ID = 5;

  it("matches only a fight at the zone's Mythic id AND locked to 20 players", () => {
    expect(isMythicFight({ difficulty: MYTHIC_ID, size: 20 }, MYTHIC_ID)).toBe(true);
    expect(isMythicFight({ difficulty: 3, size: 20 }, MYTHIC_ID)).toBe(false); // Normal
    expect(isMythicFight({ difficulty: null, size: null }, MYTHIC_ID)).toBe(false); // trash pulls
  });

  it("rejects a Mythic-id fight that isn't 20-player (e.g. a Mythic+ dungeon pull)", () => {
    expect(isMythicFight({ difficulty: MYTHIC_ID, size: 5 }, MYTHIC_ID)).toBe(false);
  });
});

describe("findMythicDifficultyId", () => {
  it("finds the id named \"Mythic\" in a zone's difficulty list", () => {
    const difficulties = [
      { id: 5, name: "Mythic", sizes: [20] },
      { id: 4, name: "Heroic", sizes: [] },
      { id: 3, name: "Normal", sizes: [] },
      { id: 1, name: "LFR", sizes: [] },
    ];
    expect(findMythicDifficultyId(difficulties)).toBe(5);
  });

  it("returns null when the zone has no Mythic entry", () => {
    expect(findMythicDifficultyId([{ id: 3, name: "Normal", sizes: [] }])).toBeNull();
  });
});

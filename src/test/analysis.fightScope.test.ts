/**
 * Unit tests for the fight-scope helpers (lib/analysis/fightScope.ts) that
 * back the report page's "which pulls am I looking at" selector.
 */
import { describe, expect, it } from "vitest";
import { buildFightScopeGroups, resolveFightScope } from "@/lib/analysis/fightScope";
import { sampleFights } from "./fixtures/sampleReport";

describe("resolveFightScope", () => {
  it("returns undefined (no filter) for an empty/missing scope", () => {
    expect(resolveFightScope(undefined, sampleFights)).toBeUndefined();
    expect(resolveFightScope("", sampleFights)).toBeUndefined();
  });

  it("resolves 'kills' and 'wipes' across all bosses", () => {
    expect(resolveFightScope("kills", sampleFights)).toEqual([3]);
    expect(resolveFightScope("wipes", sampleFights)).toEqual([2]);
  });

  it("resolves a specific fight", () => {
    expect(resolveFightScope("fight:2", sampleFights)).toEqual([2]);
  });

  it("falls back to no filter for a fight ID that doesn't exist", () => {
    expect(resolveFightScope("fight:999", sampleFights)).toBeUndefined();
  });

  it("resolves an encounter, optionally filtered to kills/wipes", () => {
    expect(resolveFightScope("encounter:2902", sampleFights)).toEqual([2, 3]);
    expect(resolveFightScope("encounter:2902:kills", sampleFights)).toEqual([3]);
    expect(resolveFightScope("encounter:2902:wipes", sampleFights)).toEqual([2]);
  });

  it("resolves to an empty array (not undefined) when a scope matches nothing", () => {
    // This encounter was never killed in the fixture data.
    expect(resolveFightScope("encounter:2902:kills".replace("2902", "9999"), sampleFights)).toEqual([]);
  });

  it("falls back to no filter for an unrecognized scope string", () => {
    expect(resolveFightScope("garbage", sampleFights)).toBeUndefined();
  });
});

describe("buildFightScopeGroups", () => {
  it("groups fights by boss, excluding trash, with per-boss pull numbers", () => {
    const groups = buildFightScopeGroups(sampleFights);
    expect(groups).toHaveLength(1); // only the trash fight is excluded
    const [ulgrax] = groups;
    expect(ulgrax.bossName).toBe("Ulgrax the Devourer");
    expect(ulgrax.encounterID).toBe(2902);
    expect(ulgrax.killCount).toBe(1);
    expect(ulgrax.wipeCount).toBe(1);
    expect(ulgrax.pulls.map((p) => p.pullNumber)).toEqual([1, 2]);
  });
});

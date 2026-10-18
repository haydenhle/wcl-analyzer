/**
 * Unit tests for the Augmentation Evoker analysis (lib/analysis/augmentation.ts).
 * All fake events, shaped like the real ones scripts/wcl-diagnose-buff-events.mjs
 * pulled from a live report (report-relative timestamps, numeric actor and
 * ability ids).
 */
import { describe, expect, it } from "vitest";
import {
  buildActorLookup,
  buildDamageIndex,
  computeBuffUptime,
  extractBuffApplications,
  gradeApplications,
  heldByOthersAt,
  inferPetOwners,
  isDpsPlayer,
  markDeliberate,
  parseReportLink,
  summarizeGrades,
  type BuffApplication,
} from "@/lib/analysis/augmentation";
import type { BuffTargetGrade } from "@/lib/analysis/types";
import type { WCLActor, WCLEvent } from "@/lib/wcl/types";

const FIGHT_START = 100_000;
const FIGHT_END = 160_000; // a 60s fight

function actor(id: number, name: string, icon: string, extra: Partial<WCLActor> = {}): WCLActor {
  const [subType] = icon.split("-");
  return { id, gameID: id, name, type: "Player", subType: subType ?? "", icon, server: null, petOwner: null, ...extra };
}

const ACTORS: WCLActor[] = [
  actor(8, "Notnewmen", "Evoker-Augmentation"),
  actor(3, "Messerknecht", "Rogue-Subtlety"),
  actor(6, "Darkenedlife", "Warlock-Demonology"),
  actor(4, "Keenpr", "Priest-Holy"),
  actor(2, "Feythe", "DeathKnight-Blood"),
  actor(50, "Wild Imp", "Pet", { type: "Pet", subType: "Pet", petOwner: 6 }),
  actor(51, "Akaari's Soul", "Pet", { type: "Pet", subType: "Pet", petOwner: 3 }),
];
const lookup = buildActorLookup(ACTORS);

function buff(timestamp: number, type: string, sourceID: number, targetID: number, abilityGameID: number, stack?: number): WCLEvent {
  return { timestamp, type, sourceID, targetID, abilityGameID, ...(stack !== undefined ? { stack } : {}) };
}
function hit(timestamp: number, sourceID: number, amount: number, absorbed = 0): WCLEvent {
  return { timestamp, type: "damage", sourceID, targetID: 999, abilityGameID: 1, amount, absorbed };
}

describe("buildActorLookup / isDpsPlayer", () => {
  it("credits pets to their owner and leaves players alone", () => {
    expect(lookup.ownerOf(50)).toBe(6);
    expect(lookup.ownerOf(51)).toBe(3);
    expect(lookup.ownerOf(3)).toBe(3);
    expect(lookup.ownerOf(12345)).toBe(12345); // unknown actor -> itself
  });

  it("only counts dps-spec players as DPS", () => {
    expect(isDpsPlayer(lookup.actor(3))).toBe(true);
    expect(isDpsPlayer(lookup.actor(4))).toBe(false); // healer
    expect(isDpsPlayer(lookup.actor(2))).toBe(false); // tank
    expect(isDpsPlayer(lookup.actor(50))).toBe(false); // pet
  });
});

describe("inferPetOwners", () => {
  // Summons the report DOESN'T link to an owner -- a real log had a Sub
  // Rogue's Akaari's Soul show up like this.
  const unowned: WCLActor[] = [
    ...ACTORS,
    actor(60, "Akaari's Soul", "Pet", { type: "Pet", subType: "Pet" }),
    actor(61, "Mystery Guardian", "Pet", { type: "Pet", subType: "Pet" }),
  ];

  it("finds the owner from buffs the pet copied from that player at the same moment", () => {
    const owners = inferPetOwners(
      [
        buff(110_000, "applybuff", 8, 3, 410089),
        buff(110_005, "applybuff", 8, 60, 410089),
        buff(130_000, "applybuff", 8, 6, 410089), // someone else, nothing copied
        buff(150_000, "applybuff", 8, 3, 410089),
        buff(150_000, "applybuff", 8, 60, 410089),
      ],
      unowned,
      [410089]
    );
    expect(owners.get(60)).toBe(3);
    // ...and that flows through the lookup, for buffs and damage alike.
    expect(buildActorLookup(unowned, owners).ownerOf(60)).toBe(3);
  });

  it("leaves a pet alone when the evidence is a tie, and never re-owns a pet the report already linked", () => {
    const owners = inferPetOwners(
      [
        buff(110_000, "applybuff", 8, 3, 410089),
        buff(110_000, "applybuff", 8, 61, 410089),
        buff(130_000, "applybuff", 8, 6, 410089),
        buff(130_000, "applybuff", 8, 61, 410089),
        buff(140_000, "applybuff", 8, 6, 410089),
        buff(140_000, "applybuff", 8, 51, 410089), // 51 is already owned by 3 in the report
      ],
      unowned,
      [410089]
    );
    expect(owners.has(61)).toBe(false);
    expect(owners.has(51)).toBe(false);
  });
});

describe("computeBuffUptime", () => {
  const base = { abilityIds: [100], fightStart: FIGHT_START, fightEnd: FIGHT_END };

  it("measures a simple apply -> remove", () => {
    const r = computeBuffUptime([buff(110_000, "applybuff", 8, 8, 100), buff(125_000, "removebuff", 8, 8, 100)], base);
    expect(r.uptimeMs).toBe(15_000);
    expect(r.uptimePct).toBeCloseTo(0.25);
    expect(r.applications).toBe(1);
    expect(r.intervals).toEqual([{ start: 10_000, end: 25_000 }]);
  });

  it("treats a buff removed with no apply as up since the pull, and one never removed as up until the end", () => {
    const r = computeBuffUptime([buff(105_000, "removebuff", 8, 8, 100), buff(150_000, "applybuff", 8, 8, 100)], base);
    expect(r.intervals).toEqual([
      { start: 0, end: 5_000 },
      { start: 50_000, end: 60_000 },
    ]);
  });

  it("tracks stacks and counts stack gains separately from fresh applications", () => {
    const r = computeBuffUptime(
      [
        buff(110_000, "applybuff", 8, 8, 100),
        buff(111_000, "applybuffstack", 8, 8, 100, 2),
        buff(112_000, "removebuffstack", 8, 8, 100, 1),
        buff(113_000, "removebuff", 8, 8, 100),
      ],
      base
    );
    expect(r.applications).toBe(1);
    expect(r.stackGains).toBe(1);
    expect(r.maxStacks).toBe(2);
    expect(r.uptimeMs).toBe(3_000);
  });

  it("merges overlapping copies from different sources instead of double counting", () => {
    const r = computeBuffUptime(
      [
        buff(110_000, "applybuff", 8, 8, 100),
        buff(115_000, "applybuff", 9, 8, 100),
        buff(120_000, "removebuff", 8, 8, 100),
        buff(130_000, "removebuff", 9, 8, 100),
      ],
      base
    );
    expect(r.uptimeMs).toBe(20_000);
  });

  it("respects source/target filters and ignores other abilities", () => {
    const events = [
      buff(110_000, "applybuff", 9, 8, 100), // someone else's copy
      buff(110_000, "applybuff", 8, 3, 100), // on someone else
      buff(110_000, "applybuff", 8, 8, 200), // different ability
    ];
    const r = computeBuffUptime(events, { ...base, sourceId: 8, targetId: 8 });
    expect(r.uptimeMs).toBe(0);
    expect(r.applications).toBe(0);
  });
});

describe("buildDamageIndex", () => {
  const index = buildDamageIndex(
    [hit(101_000, 3, 100), hit(102_000, 51, 50), hit(103_000, 6, 10, 5), hit(104_000, 50, 1), { timestamp: 105_000, type: "heal", sourceID: 3, amount: 9999 }],
    lookup.ownerOf
  );

  it("credits pet damage to the owner and counts absorbed damage", () => {
    expect(index.damageBetween(3, 100_000, 110_000)).toBe(150);
    expect(index.damageBetween(6, 100_000, 110_000)).toBe(16);
  });

  it("uses a half-open [from, to) window", () => {
    expect(index.damageBetween(3, 101_000, 102_000)).toBe(100);
    expect(index.damageBetween(3, 101_001, 102_001)).toBe(50);
  });

  it("ignores non-damage events and unknown players", () => {
    expect(index.damageBetween(3, 104_500, 110_000)).toBe(0);
    expect(index.damageBetween(77, 100_000, 110_000)).toBe(0);
  });
});

describe("extractBuffApplications", () => {
  const opts = { abilityIds: [410089], sourceId: 8, ownerOf: lookup.ownerOf, fightEnd: FIGHT_END, defaultWindowMs: 15_000, maxWindowMs: 30_000 };

  it("collapses a buff mirrored onto pets into one application on the owner", () => {
    const apps = extractBuffApplications(
      [
        buff(110_000, "applybuff", 8, 6, 410089),
        buff(110_000, "applybuff", 8, 50, 410089),
        buff(110_050, "applybuff", 8, 50, 410089),
        buff(128_000, "removebuff", 8, 6, 410089),
      ],
      opts
    );
    expect(apps).toHaveLength(1);
    expect(apps[0]!.recipientId).toBe(6);
    expect(apps[0]!.windowEnd).toBe(128_000);
  });

  it("falls back to the default window, capped by the fight end", () => {
    const apps = extractBuffApplications([buff(110_000, "applybuff", 8, 3, 410089), buff(155_000, "applybuff", 8, 6, 410089)], opts);
    expect(apps.map((a) => a.windowEnd)).toEqual([125_000, FIGHT_END]);
  });

  it("drops applications that still don't resolve to a player", () => {
    const withStray = [...ACTORS, actor(61, "Mystery Guardian", "Pet", { type: "Pet", subType: "Pet" })];
    const strayLookup = buildActorLookup(withStray);
    const apps = extractBuffApplications(
      [buff(110_000, "applybuff", 8, 61, 410089), buff(120_000, "applybuff", 8, 3, 410089)],
      { ...opts, ownerOf: strayLookup.ownerOf, isPlayer: strayLookup.isPlayer }
    );
    expect(apps.map((a) => a.recipientId)).toEqual([3]);
  });

  it("counts refreshes as decisions and ignores other Evokers' applications", () => {
    const apps = extractBuffApplications(
      [buff(110_000, "applybuff", 9, 3, 410089), buff(111_000, "refreshbuff", 8, 3, 410089), buff(112_000, "removebuff", 8, 3, 410089)],
      opts
    );
    expect(apps).toEqual([{ time: 111_000, windowEnd: 112_000, recipientId: 3, deliberate: null }]);
  });
});

describe("markDeliberate", () => {
  const apps: BuffApplication[] = [
    { time: 110_000, windowEnd: 120_000, recipientId: 3, deliberate: null },
    { time: 130_000, windowEnd: 140_000, recipientId: 6, deliberate: null },
  ];

  it("matches casts to applications and calls the rest procs", () => {
    const casts: WCLEvent[] = [
      { timestamp: 109_900, type: "cast", sourceID: 8, abilityGameID: 409311 },
      { timestamp: 130_000, type: "cast", sourceID: 9, abilityGameID: 409311 }, // another Evoker's cast
    ];
    expect(markDeliberate(apps, casts, { sourceId: 8 }).map((a) => a.deliberate)).toEqual([true, false]);
  });

  it("leaves everything unknown when there's no usable cast data", () => {
    expect(markDeliberate(apps, null, { sourceId: 8 }).map((a) => a.deliberate)).toEqual([null, null]);
    expect(markDeliberate(apps, [], { sourceId: 8 }).map((a) => a.deliberate)).toEqual([null, null]);
  });
});

describe("gradeApplications / heldByOthersAt / summarizeGrades", () => {
  // Messerknecht (3) does 300/s, Darkenedlife (6) 200/s, both the whole fight.
  const hits: WCLEvent[] = [];
  for (let t = FIGHT_START; t < FIGHT_END; t += 1000) {
    hits.push(hit(t, 3, 300), hit(t, 6, 200));
  }
  const damage = buildDamageIndex(hits, lookup.ownerOf);
  const ctx = { damage, candidates: [3, 6], lookup, fightStart: FIGHT_START };

  it("ranks the recipient against every DPS by damage per second in the window", () => {
    const [onTop, onSecond, onHealer] = gradeApplications(
      [
        { time: 110_000, windowEnd: 120_000, recipientId: 3, deliberate: true },
        { time: 110_000, windowEnd: 120_000, recipientId: 6, deliberate: true },
        { time: 110_000, windowEnd: 120_000, recipientId: 4, deliberate: true },
      ],
      ctx
    );
    expect(onTop!.rank).toBe(1);
    expect(onTop!.recipientDps).toBeCloseTo(300);
    expect(onSecond!.rank).toBe(2);
    expect(onSecond!.topName).toBe("Messerknecht");
    expect(onSecond!.shareOfTop).toBeCloseTo(200 / 300);
    expect(onHealer!.rank).toBeNull();
    expect(onHealer!.timeMs).toBe(10_000);

    // The whole-raid chart data: every DPS, highest first, recipient flagged.
    expect(onSecond!.ranking.map((r) => [r.name, Math.round(r.dps), r.recipient])).toEqual([
      ["Messerknecht", 300, false],
      ["Darkenedlife", 200, true],
    ]);
    // A healer pick still shows up in the chart, even though it can't be ranked.
    expect(onHealer!.ranking.map((r) => r.name)).toEqual(["Messerknecht", "Darkenedlife", "Keenpr"]);
    expect(onHealer!.ranking[2]!.recipient).toBe(true);
  });

  it("doesn't penalize picking the best AVAILABLE target when the top DPS already holds your other Prescience", () => {
    const apps: BuffApplication[] = [
      { time: 105_000, windowEnd: 123_000, recipientId: 3, deliberate: true },
      { time: 110_000, windowEnd: 128_000, recipientId: 6, deliberate: true },
    ];
    const grades = gradeApplications(apps, { ...ctx, blockedAt: heldByOthersAt(apps) });
    expect(grades.map((g) => g.rank)).toEqual([1, 1]);
    // ...but the chart still shows the blocked top DPS, marked as such.
    expect(grades[1]!.ranking[0]).toEqual({ name: "Messerknecht", className: "Rogue", dps: 300, recipient: false, blocked: true });
  });

  it("summarizes rates over deliberate applications only", () => {
    const g = (rank: number | null, deliberate: boolean | null, shareOfTop: number | null): BuffTargetGrade => ({
      timeMs: 0, windowMs: 1, recipientName: "", recipientClass: null, recipientDps: (shareOfTop ?? 0) * 1000, rank, candidates: 5,
      topName: null, topClass: null, topDps: 0, shareOfTop, deliberate, ranking: [],
    });
    const s = summarizeGrades([g(1, true, 1), g(3, null, 0.5), g(5, true, 0.3), g(1, false, 1)]);
    expect(s.total).toBe(4);
    expect(s.graded).toBe(3);
    expect(s.autoApplications).toBe(1);
    expect(s.top1Rate).toBeCloseTo(1 / 3);
    expect(s.top3Rate).toBeCloseTo(2 / 3);
    expect(s.avgShareOfTop).toBeCloseTo(0.6);
    expect(s.avgRecipientDps).toBeCloseTo(600); // procs excluded: (1000 + 500 + 300) / 3
    expect(summarizeGrades([]).top1Rate).toBeNull();
  });
});

describe("parseReportLink", () => {
  it("reads fight/source from the hash or the query string", () => {
    expect(parseReportLink("https://www.warcraftlogs.com/reports/LckJC7GMhQvD6rdw#fight=1&source=8")).toEqual({
      code: "LckJC7GMhQvD6rdw", fight: 1, sourceId: 8,
    });
    expect(parseReportLink("https://www.warcraftlogs.com/reports/LckJC7GMhQvD6rdw?fight=last&type=damage-done")).toEqual({
      code: "LckJC7GMhQvD6rdw", fight: "last", sourceId: null,
    });
  });

  it("accepts a bare report code and rejects junk", () => {
    expect(parseReportLink("LckJC7GMhQvD6rdw")).toEqual({ code: "LckJC7GMhQvD6rdw", fight: null, sourceId: null });
    expect(parseReportLink("not a link")).toBeNull();
  });
});

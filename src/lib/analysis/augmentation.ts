/**
 * This file's job: turn raw Warcraft Logs EVENTS (individual timestamped
 * buff applications, casts, and hits -- see getReportEvents in
 * lib/wcl/queries.ts) into the Augmentation Evoker analysis: how long each
 * key self-buff was up, how many procs happened, and -- the main point --
 * whether each Prescience / Shifting Sands landed on the player who was
 * actually doing the most damage at that moment.
 *
 * Like the rest of lib/analysis, nothing here talks to the network. See
 * src/test/analysis.augmentation.test.ts.
 *
 * How the spec works, as far as this file is concerned (Midnight / 12.1,
 * confirmed with the person this was built for, who plays it, and against
 * real logs with scripts/wcl-diagnose-buff-events.mjs):
 *   - Ebon Might hits every DPS automatically now, so there's no target
 *     decision to grade -- only whether the Evoker kept it rolling.
 *   - Prescience is the one buff the Evoker aims by hand. Each Evoker can
 *     have it on several players over a fight (2 charges), and one player
 *     can hold at most one from each Evoker. Some applications are procs
 *     (Motes of Possibility), not decisions.
 *   - Shifting Sands goes to whoever is CLOSEST when the Evoker finishes an
 *     empowered spell (Fire Breath / Upheaval) -- a positioning decision.
 *   - Buffs on a player also show up on their pets (a Demonology Warlock's
 *     imps, a Subtlety Rogue's Akaari's Soul), as separate actors. Both
 *     buffs and damage get credited back to the owning player here.
 */
import type {
  AugSelfBuffKey,
  BuffTargetGrade,
  BuffTargetingSummary,
  BuffUptimeSummary,
} from "./types";
import type { WCLAbilityInfo, WCLActor, WCLEvent } from "@/lib/wcl/types";
import { parseClassSpecFromIcon } from "./playerAnalysis";
import { roleForSpec } from "@/lib/wowSpecRoles";

// Ability NAMES, not ids -- one name can map to several ids (Prescience the
// spell is 409311, Prescience the buff it applies is 410089), and ids can
// shift between patches. Ids get resolved per report from masterData.
export const AUG_ABILITY_NAMES = {
  prescience: "Prescience",
  shiftingSands: "Shifting Sands",
  ebonMight: "Ebon Might",
  momentumShift: "Momentum Shift",
  essenceBurst: "Essence Burst",
  duplicate: "Duplicate",
  doubleTime: "Double-time",
} as const;

export const SELF_BUFF_LABELS: Record<AugSelfBuffKey, string> = {
  ebonMight: "Ebon Might",
  momentumShift: "Momentum Shift",
  essenceBurst: "Essence Burst",
  duplicate: "Duplicate",
  doubleTime: "Double-time",
};

export function abilityIdsByName(abilities: WCLAbilityInfo[], name: string): number[] {
  return abilities.filter((a) => a.name === name).map((a) => a.gameID);
}

// --- Actors: pet -> owner, and who counts as a DPS ----------------------

export interface ActorLookup {
  actor(id: number): WCLActor | undefined;
  // The player who "owns" an actor: a pet's (or a pet's pet's) owner, or
  // the actor itself if it's not a pet.
  ownerOf(id: number): number;
  isPlayer(id: number): boolean;
}

/**
 * `inferredOwners` fills in owners the report itself doesn't record (see
 * inferPetOwners) -- only used where an actor's own `petOwner` is missing.
 */
export function buildActorLookup(actors: WCLActor[], inferredOwners?: Map<number, number>): ActorLookup {
  const byId = new Map(actors.map((a) => [a.id, a]));
  return {
    actor: (id) => byId.get(id),
    ownerOf(id) {
      let current = id;
      // A few hops is plenty (a guardian summoned by a pet); the cap just
      // guards against a malformed self-referencing petOwner.
      for (let i = 0; i < 4; i++) {
        const owner = byId.get(current)?.petOwner ?? inferredOwners?.get(current);
        if (owner == null || owner === current) break;
        current = owner;
      }
      return current;
    },
    isPlayer: (id) => byId.get(id)?.type === "Player",
  };
}

/**
 * Works out owners for pets/guardians the report doesn't link to anyone.
 * Most pets come with a `petOwner`, but some summons don't -- a Subtlety
 * Rogue's "Akaari's Soul" showed up in a real log as its own unowned actor,
 * so its buffs and damage weren't being credited to the Rogue.
 *
 * The tell: when a player gets a single-target buff (Prescience, Shifting
 * Sands), their pets get a copy from the same source at the same moment.
 * So for each unowned non-player, count which player received the same
 * buff from the same source within `toleranceMs`, every time it did; the
 * player it lines up with most often is the owner. Ties (ambiguous) are
 * left alone rather than guessed.
 *
 * Only pass single-target buffs here: a raid-wide one like Ebon Might hits
 * every DPS at once, so it lines up with everyone and proves nothing.
 */
export function inferPetOwners(
  events: WCLEvent[],
  actors: WCLActor[],
  singleTargetAbilityIds: number[],
  toleranceMs = 30
): Map<number, number> {
  const byId = new Map(actors.map((a) => [a.id, a]));
  const isPlayer = (id: number | undefined) => id !== undefined && byId.get(id)?.type === "Player";
  const needsOwner = (id: number | undefined) => {
    const a = id !== undefined ? byId.get(id) : undefined;
    return !!a && a.type !== "Player" && a.petOwner == null;
  };
  const ids = new Set(singleTargetAbilityIds);

  const groups = new Map<string, WCLEvent[]>();
  for (const e of events) {
    if (e.abilityGameID === undefined || !ids.has(e.abilityGameID) || e.targetID === undefined) continue;
    if (e.type !== "applybuff" && e.type !== "refreshbuff" && e.type !== "removebuff") continue;
    const key = `${e.sourceID}:${e.abilityGameID}:${e.type}`;
    const list = groups.get(key);
    if (list) list.push(e);
    else groups.set(key, [e]);
  }

  const votes = new Map<number, Map<number, number>>();
  for (const list of groups.values()) {
    list.sort((a, b) => a.timestamp - b.timestamp);
    list.forEach((e, i) => {
      if (!needsOwner(e.targetID)) return;
      const pet = e.targetID!;
      const vote = (other: WCLEvent) => {
        if (!isPlayer(other.targetID)) return;
        const tally = votes.get(pet) ?? new Map<number, number>();
        tally.set(other.targetID!, (tally.get(other.targetID!) ?? 0) + 1);
        votes.set(pet, tally);
      };
      for (let j = i - 1; j >= 0 && e.timestamp - list[j]!.timestamp <= toleranceMs; j--) vote(list[j]!);
      for (let j = i + 1; j < list.length && list[j]!.timestamp - e.timestamp <= toleranceMs; j++) vote(list[j]!);
    });
  }

  const owners = new Map<number, number>();
  for (const [pet, tally] of votes) {
    const ranked = [...tally.entries()].sort((a, b) => b[1] - a[1]);
    const [best, second] = ranked;
    if (best && (!second || best[1] > second[1])) owners.set(pet, best[0]);
  }
  return owners;
}

export function isDpsPlayer(actor: WCLActor | undefined): boolean {
  if (!actor || actor.type !== "Player") return false;
  const spec = parseClassSpecFromIcon(actor.icon);
  return spec ? roleForSpec(spec.className, spec.specName) === "dps" : false;
}

// --- Self-buff uptime -----------------------------------------------------

/**
 * Walks one buff's apply/refresh/stack/remove events and works out when it
 * was up. Fight-relative output (0 = pull).
 *
 * Events are grouped per (source, target) stream first -- the same buff
 * from two different sources is two separate auras in game -- then the
 * streams' up-time is merged, so "up" means "at least one copy was up".
 *
 * Edge cases a real log throws at this: a buff that was already up at the
 * pull shows up first as a refresh or a remove with no apply before it
 * (treated as up since the pull), and one still up at the end of the fight
 * has no remove (treated as up until the end).
 */
export function computeBuffUptime(
  events: WCLEvent[],
  opts: { abilityIds: number[]; sourceId?: number; targetId?: number; fightStart: number; fightEnd: number }
): Omit<BuffUptimeSummary, "key" | "name"> {
  const ids = new Set(opts.abilityIds);
  const relevant = events
    .filter(
      (e) =>
        e.abilityGameID !== undefined &&
        ids.has(e.abilityGameID) &&
        (opts.sourceId === undefined || e.sourceID === opts.sourceId) &&
        (opts.targetId === undefined || e.targetID === opts.targetId)
    )
    .sort((a, b) => a.timestamp - b.timestamp);

  const streams = new Map<string, { active: boolean; start: number; stacks: number }>();
  const intervals: { start: number; end: number }[] = [];
  let applications = 0;
  let stackGains = 0;
  let maxStacks = 0;

  for (const e of relevant) {
    const key = `${e.sourceID}:${e.targetID}`;
    let s = streams.get(key);
    if (!s) {
      s = { active: false, start: opts.fightStart, stacks: 0 };
      streams.set(key, s);
    }
    const t = Math.min(Math.max(e.timestamp, opts.fightStart), opts.fightEnd);
    switch (e.type) {
      case "applybuff":
        applications++;
        if (!s.active) {
          s.active = true;
          s.start = t;
        }
        s.stacks = e.stack ?? 1;
        break;
      case "applybuffstack":
        stackGains++;
        if (!s.active) {
          s.active = true;
          s.start = opts.fightStart;
        }
        s.stacks = e.stack ?? s.stacks + 1;
        break;
      case "removebuffstack":
        if (!s.active) {
          s.active = true;
          s.start = opts.fightStart;
        }
        s.stacks = e.stack ?? Math.max(1, s.stacks - 1);
        break;
      case "refreshbuff":
        if (!s.active) {
          s.active = true;
          s.start = opts.fightStart;
          s.stacks = Math.max(s.stacks, 1);
        }
        break;
      case "removebuff":
        intervals.push({ start: s.active ? s.start : opts.fightStart, end: t });
        s.active = false;
        s.stacks = 0;
        break;
      default:
        break;
    }
    maxStacks = Math.max(maxStacks, s.stacks);
  }
  for (const s of streams.values()) {
    if (s.active) intervals.push({ start: s.start, end: opts.fightEnd });
  }

  const merged = mergeIntervals(intervals).map((i) => ({
    start: i.start - opts.fightStart,
    end: i.end - opts.fightStart,
  }));
  const uptimeMs = merged.reduce((sum, i) => sum + (i.end - i.start), 0);
  const duration = Math.max(1, opts.fightEnd - opts.fightStart);
  return { uptimeMs, uptimePct: uptimeMs / duration, applications, stackGains, maxStacks, intervals: merged };
}

export function mergeIntervals(intervals: { start: number; end: number }[]): { start: number; end: number }[] {
  const sorted = intervals.filter((i) => i.end > i.start).sort((a, b) => a.start - b.start);
  const out: { start: number; end: number }[] = [];
  for (const i of sorted) {
    const last = out[out.length - 1];
    if (last && i.start <= last.end) {
      last.end = Math.max(last.end, i.end);
    } else {
      out.push({ ...i });
    }
  }
  return out;
}

// --- Damage over time, per player -------------------------------------

export interface DamageIndex {
  // Damage the player (pets included) did in [from, to), report-relative ms.
  damageBetween(ownerId: number, from: number, to: number): number;
  owners(): number[];
}

/**
 * Indexes every friendly damage event by owning player, so "how much did
 * each DPS do between t1 and t2" is a couple of binary searches instead of
 * a scan -- it gets asked once per DPS per buff application.
 *
 * A hit's value is `amount + absorbed`: WCL's own damage meters count
 * damage a shield ate as damage done, so this does too.
 */
export function buildDamageIndex(events: WCLEvent[], ownerOf: (id: number) => number): DamageIndex {
  const perOwner = new Map<number, { t: number; v: number }[]>();
  for (const e of events) {
    if (e.type !== "damage" || e.sourceID === undefined) continue;
    const value = (e.amount ?? 0) + (e.absorbed ?? 0);
    if (value <= 0) continue;
    const owner = ownerOf(e.sourceID);
    const list = perOwner.get(owner);
    if (list) list.push({ t: e.timestamp, v: value });
    else perOwner.set(owner, [{ t: e.timestamp, v: value }]);
  }

  const index = new Map<number, { times: number[]; prefix: number[] }>();
  for (const [owner, list] of perOwner) {
    list.sort((a, b) => a.t - b.t);
    const times = list.map((x) => x.t);
    const prefix = [0];
    for (const x of list) prefix.push(prefix[prefix.length - 1]! + x.v);
    index.set(owner, { times, prefix });
  }

  // First index whose time is >= x.
  function lowerBound(times: number[], x: number): number {
    let lo = 0;
    let hi = times.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (times[mid]! < x) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  return {
    damageBetween(ownerId, from, to) {
      const entry = index.get(ownerId);
      if (!entry || to <= from) return 0;
      return entry.prefix[lowerBound(entry.times, to)]! - entry.prefix[lowerBound(entry.times, from)]!;
    },
    owners: () => [...index.keys()],
  };
}

// --- Buff applications on other players -----------------------------------

export interface BuffApplication {
  time: number; // report-relative ms
  windowEnd: number; // when this application's buff fell off (or a capped default)
  recipientId: number; // the owning PLAYER, after pet -> owner
  deliberate: boolean | null;
}

/**
 * Pulls one Evoker's applications of a targeted buff (Prescience, Shifting
 * Sands) out of the buff events, credited to the owning player.
 *
 * - "applybuff" and "refreshbuff" both count: re-casting on someone who
 *   still has it is still a choice of who to buff.
 * - A buff on a player is mirrored onto their pets as separate events at
 *   the same moment (one Prescience on a Warlock = a burst of applications
 *   on every imp). Those collapse into ONE application here: same owner
 *   within `dedupeMs`.
 * - The window runs until that buff fell off the target (the next
 *   "removebuff" on the same source+target), capped at `maxWindowMs` and
 *   the fight's end, or `defaultWindowMs` if it never visibly fell off.
 */
export function extractBuffApplications(
  events: WCLEvent[],
  opts: {
    abilityIds: number[];
    sourceId: number;
    ownerOf: (id: number) => number;
    fightEnd: number;
    defaultWindowMs: number;
    maxWindowMs: number;
    dedupeMs?: number;
    // If given, applications whose recipient (after pet -> owner) still
    // isn't a player are dropped -- a pet the owner link couldn't be found
    // for is never a target the Evoker chose.
    isPlayer?: (id: number) => boolean;
  }
): BuffApplication[] {
  const ids = new Set(opts.abilityIds);
  const dedupeMs = opts.dedupeMs ?? 150;
  const mine = events
    .filter((e) => e.abilityGameID !== undefined && ids.has(e.abilityGameID) && e.sourceID === opts.sourceId)
    .sort((a, b) => a.timestamp - b.timestamp);

  const apps: BuffApplication[] = [];
  const lastByOwner = new Map<number, number>();
  for (let i = 0; i < mine.length; i++) {
    const e = mine[i]!;
    if ((e.type !== "applybuff" && e.type !== "refreshbuff") || e.targetID === undefined) continue;
    const owner = opts.ownerOf(e.targetID);
    if (opts.isPlayer && !opts.isPlayer(owner)) continue;
    const previous = lastByOwner.get(owner);
    if (previous !== undefined && e.timestamp - previous <= dedupeMs) continue;
    lastByOwner.set(owner, e.timestamp);

    let removedAt: number | undefined;
    for (let j = i + 1; j < mine.length; j++) {
      const later = mine[j]!;
      if (later.targetID === e.targetID && later.abilityGameID === e.abilityGameID && later.type === "removebuff") {
        removedAt = later.timestamp;
        break;
      }
    }
    const naturalEnd = removedAt ?? e.timestamp + opts.defaultWindowMs;
    const windowEnd = Math.min(naturalEnd, e.timestamp + opts.maxWindowMs, opts.fightEnd);
    apps.push({ time: e.timestamp, windowEnd, recipientId: owner, deliberate: null });
  }
  return apps;
}

/**
 * Prescience only: tags each application as a real cast by this Evoker
 * (deliberate) or not (a proc -- Motes of Possibility and friends). Each
 * cast "claims" the closest unclaimed application within `toleranceMs`.
 * With no cast data at all, everything stays `null` (unknown) rather than
 * being wrongly called a proc.
 */
export function markDeliberate(
  apps: BuffApplication[],
  castEvents: WCLEvent[] | null,
  opts: { sourceId: number; toleranceMs?: number }
): BuffApplication[] {
  if (!castEvents) return apps;
  const tolerance = opts.toleranceMs ?? 400;
  const casts = castEvents
    .filter((e) => e.type === "cast" && e.sourceID === opts.sourceId)
    .map((e) => e.timestamp)
    .sort((a, b) => a - b);
  // Zero casts from this Evoker almost certainly means the cast data
  // didn't come back in the shape expected, not that every single
  // Prescience was a proc -- don't throw every application out over that.
  if (casts.length === 0) return apps;
  const claimed = new Set<number>();
  return apps.map((app) => {
    let best = -1;
    let bestDistance = Infinity;
    casts.forEach((t, i) => {
      const distance = Math.abs(t - app.time);
      if (!claimed.has(i) && distance <= tolerance && distance < bestDistance) {
        best = i;
        bestDistance = distance;
      }
    });
    if (best >= 0) claimed.add(best);
    return { ...app, deliberate: best >= 0 };
  });
}

/**
 * Grades each application: during the window that buff was up, rank every
 * eligible DPS by damage per second (pets included), and see where the
 * recipient landed.
 *
 * `blockedAt`, if given, removes players from the ranking for one
 * application -- used for Prescience, where the best player may already be
 * holding this Evoker's OTHER Prescience (2 charges), so "best AVAILABLE
 * target" is the fair bar, not "best player, period".
 *
 * Known bias, stated on the page too: the recipient's own numbers in the
 * window include whatever the buff itself added. That's a few percent,
 * not enough to change who ranks first in practice.
 */
export function gradeApplications(
  apps: BuffApplication[],
  ctx: {
    damage: DamageIndex;
    candidates: number[];
    lookup: ActorLookup;
    fightStart: number;
    blockedAt?: (app: BuffApplication) => Set<number>;
  }
): BuffTargetGrade[] {
  return apps.map((app) => {
    const windowMs = Math.max(1, app.windowEnd - app.time);
    const blocked = ctx.blockedAt?.(app) ?? new Set<number>();
    const dpsOf = (id: number) => ctx.damage.damageBetween(id, app.time, app.windowEnd) / (windowMs / 1000);
    const ranked = ctx.candidates
      .filter((id) => id === app.recipientId || !blocked.has(id))
      .map((id) => ({ id, dps: dpsOf(id) }))
      .sort((a, b) => b.dps - a.dps);
    // The whole raid's DPS in this window, for the click-to-open chart --
    // every DPS (including ones `blocked` left out of the rank, so the
    // chart can show WHY they didn't count), plus the recipient even if
    // they aren't a DPS at all (a tank / healer pick should still show up).
    const raidIds = ctx.candidates.includes(app.recipientId)
      ? ctx.candidates
      : [...ctx.candidates, app.recipientId];
    const ranking = raidIds
      .map((id) => {
        const actor = ctx.lookup.actor(id);
        return {
          name: actor?.name ?? `Unknown (${id})`,
          className: actor?.type === "Player" ? actor.subType : null,
          dps: dpsOf(id),
          recipient: id === app.recipientId,
          blocked: id !== app.recipientId && blocked.has(id),
        };
      })
      .sort((a, b) => b.dps - a.dps);
    const position = ranked.findIndex((r) => r.id === app.recipientId);
    const top = ranked[0];
    const recipient = ctx.lookup.actor(app.recipientId);
    const topActor = top ? ctx.lookup.actor(top.id) : undefined;
    const recipientDps = ctx.damage.damageBetween(app.recipientId, app.time, app.windowEnd) / (windowMs / 1000);
    return {
      timeMs: app.time - ctx.fightStart,
      windowMs,
      recipientName: recipient?.name ?? `Unknown (${app.recipientId})`,
      recipientClass: recipient?.type === "Player" ? recipient.subType : null,
      recipientDps,
      rank: position >= 0 ? position + 1 : null,
      candidates: ranked.length,
      topName: topActor?.name ?? null,
      topClass: topActor?.subType ?? null,
      topDps: top?.dps ?? 0,
      shareOfTop: top && top.dps > 0 ? recipientDps / top.dps : null,
      deliberate: app.deliberate,
      ranking,
    };
  });
}

/**
 * For Prescience: at each application, which OTHER players already held
 * this Evoker's Prescience (from an earlier application whose window is
 * still open)? Those weren't valid targets at that moment.
 */
export function heldByOthersAt(apps: BuffApplication[]): (app: BuffApplication) => Set<number> {
  return (app) => {
    const held = new Set<number>();
    for (const other of apps) {
      if (other === app || other.recipientId === app.recipientId) continue;
      if (other.time < app.time && other.windowEnd > app.time) held.add(other.recipientId);
    }
    return held;
  };
}

export function summarizeGrades(grades: BuffTargetGrade[]): BuffTargetingSummary {
  const counted = grades.filter((g) => g.deliberate !== false);
  const n = counted.length;
  const rate = (pred: (g: BuffTargetGrade) => boolean) => (n > 0 ? counted.filter(pred).length / n : null);
  return {
    total: grades.length,
    graded: n,
    autoApplications: grades.length - n,
    top1Rate: rate((g) => g.rank === 1),
    top3Rate: rate((g) => g.rank !== null && g.rank <= 3),
    avgShareOfTop: n > 0 ? counted.reduce((sum, g) => sum + (g.shareOfTop ?? 0), 0) / n : null,
    avgRecipientDps: n > 0 ? counted.reduce((sum, g) => sum + g.recipientDps, 0) / n : null,
  };
}

// --- Comparison links -------------------------------------------------------

export interface ParsedReportLink {
  code: string;
  fight: number | "last" | null;
  sourceId: number | null;
}

/**
 * Reads a Warcraft Logs report link -- or just a bare report code -- into
 * its parts. WCL puts `fight`/`source` in the query string OR the hash
 * depending on where you copied the link from (e.g. `?fight=5&source=12`
 * vs `#fight=5&source=12`), so both are checked.
 */
export function parseReportLink(input: string): ParsedReportLink | null {
  const trimmed = input.trim();
  if (/^[A-Za-z0-9]{16}$/.test(trimmed)) return { code: trimmed, fight: null, sourceId: null };

  const match = trimmed.match(/reports\/([A-Za-z0-9]+)/);
  if (!match?.[1]) return null;
  const params = new URLSearchParams();
  const query = trimmed.split("?")[1]?.split("#")[0];
  const hash = trimmed.split("#")[1];
  for (const part of [query, hash]) {
    if (!part) continue;
    for (const [k, v] of new URLSearchParams(part)) params.set(k, v);
  }
  const fightParam = params.get("fight");
  const fight = fightParam === "last" ? "last" : fightParam && /^\d+$/.test(fightParam) ? Number(fightParam) : null;
  const sourceParam = params.get("source");
  const sourceId = sourceParam && /^\d+$/.test(sourceParam) ? Number(sourceParam) : null;
  return { code: match[1], fight, sourceId };
}

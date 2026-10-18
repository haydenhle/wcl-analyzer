/**
 * This file's job: handle the "fight scope" dropdown on the report page --
 * the control that lets someone pick "all fights", "just kills", "just
 * wipes", "just this one boss", or "just this one pull". This file figures
 * out (a) which fight IDs match the current selection, and (b) the list of
 * bosses/pulls to show in the dropdown itself.
 *
 * This file does NOT talk to the internet. It's plain filtering logic over
 * a fight list that was already fetched. See
 * src/test/analysis.fightScope.test.ts for tests.
 *
 * The selection is stored as one string, in the page's `?scope=` URL
 * parameter, so a link to "just the kill on this boss" can be bookmarked
 * or shared. For example, `scope=encounter:1234:kills` means "only the
 * kill(s) of the boss with encounter ID 1234". The formats are:
 *   (empty)                            -> every fight in the report
 *   "kills"                            -> every fight that was a kill, any boss
 *   "wipes"                            -> every fight that was a wipe, any boss
 *   "encounter:<encounterID>"          -> every pull of one boss
 *   "encounter:<encounterID>:kills"    -> that boss's kill(s) only
 *   "encounter:<encounterID>:wipes"    -> that boss's wipes only
 *   "fight:<fightID>"                  -> one specific pull
 */
import type { WCLFight } from "@/lib/wcl/types";

/**
 * Turns a scope string (from the URL) into the list of fight IDs it
 * matches.
 *
 * Returns `undefined` when there's no filter to apply -- meaning "use
 * every fight". Returns an empty array when the scope is valid but nothing
 * matches (e.g. "this boss's kills" but the boss was never actually
 * killed) -- callers should treat that as "don't bother asking WCL for
 * this data" rather than "no filter". An unrecognized scope string falls
 * back to `undefined` instead of throwing, so an old or broken URL never
 * breaks the page.
 */
export function resolveFightScope(scope: string | undefined, fights: WCLFight[]): number[] | undefined {
  if (!scope) return undefined;

  if (scope === "kills") return fights.filter((f) => f.kill === true).map((f) => f.id);
  if (scope === "wipes") return fights.filter((f) => f.kill === false).map((f) => f.id);

  if (scope.startsWith("fight:")) {
    const id = Number(scope.slice("fight:".length));
    return fights.some((f) => f.id === id) ? [id] : undefined;
  }

  if (scope.startsWith("encounter:")) {
    const [idStr, filter] = scope.slice("encounter:".length).split(":");
    const encounterID = Number(idStr);
    let matched = fights.filter((f) => f.encounterID === encounterID);
    if (filter === "kills") matched = matched.filter((f) => f.kill === true);
    if (filter === "wipes") matched = matched.filter((f) => f.kill === false);
    return matched.map((f) => f.id);
  }

  return undefined;
}

export interface FightScopePull {
  id: number;
  pullNumber: number; // 1-based, within this encounter only
  kill: boolean | null;
  bossPercentage: number | null;
}

export interface FightScopeGroup {
  encounterID: number;
  bossName: string;
  pulls: FightScopePull[];
  killCount: number;
  wipeCount: number;
}

/**
 * Groups all fights by boss (in the order each boss was first pulled), so
 * FightScopeSelector can render one dropdown section per boss. Trash
 * fights (encounterID === 0) are left out, since there's no boss to group
 * them under.
 */
export function buildFightScopeGroups(fights: WCLFight[]): FightScopeGroup[] {
  const groups = new Map<number, FightScopeGroup>();
  const order: number[] = [];

  for (const f of fights) {
    if (!f.encounterID) continue;
    let group = groups.get(f.encounterID);
    if (!group) {
      group = { encounterID: f.encounterID, bossName: f.name, pulls: [], killCount: 0, wipeCount: 0 };
      groups.set(f.encounterID, group);
      order.push(f.encounterID);
    }
    group.pulls.push({
      id: f.id,
      pullNumber: group.pulls.length + 1,
      kill: f.kill,
      bossPercentage: f.bossPercentage,
    });
    if (f.kill === true) group.killCount++;
    if (f.kill === false) group.wipeCount++;
  }

  return order.map((id) => groups.get(id)!);
}

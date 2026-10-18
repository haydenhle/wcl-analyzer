/**
 * Diagnostic for the planned Augmentation Evoker buff-targeting comparison
 * feature: "did the Evoker apply Prescience to whoever was actually doing
 * the most damage in that moment?"
 *
 * What we need to know before designing that feature (same rationale as
 * every other scripts/wcl-diagnose-*.mjs in this project -- verify against
 * the live schema instead of guessing):
 *
 *   1. `report.table(dataType: ..., ...)` only ever gave us PER-PLAYER
 *      AGGREGATE numbers (total casts, total damage) -- it has no per-cast
 *      TARGET. To know "who did this specific Prescience cast land on, and
 *      when", we need individual timestamped events, not aggregates. Does
 *      WCL expose those at all (an `events` field on Report, most likely),
 *      and what does one event actually look like (sourceID/targetID?
 *      ability id/name? a human-readable target name, or just a numeric
 *      actor id we'd have to resolve ourselves)?
 *   2. Is there a `TableDataType` (or separate `EventDataType`) enum value
 *      for buffs/auras specifically, as opposed to casts/damage/healing?
 *   3. How do we turn a numeric actor id back into a player name/class --
 *      is there a `masterData`/`actors`-style field on Report we can join
 *      against?
 *   4. As a sanity check (and to pin down what "Shifting Sands" actually
 *      is, since public guides disagree/are vague on it), does a live
 *      report's buff/aura list even contain an ability literally named
 *      "Shifting Sands", and if so, what do ITS events look like compared
 *      to Prescience's?
 *
 * This is read-only and introspection-first: it prints the real Report
 * type's fields, the real enum values of anything buff/event-shaped, then
 * fires one live query with whatever it found, against a REAL report. Pass
 * in one of your own Augmentation Evoker logs so the output actually has
 * Prescience/Ebon Might/Shifting Sands applications in it -- the default
 * report code below is just a placeholder from earlier scripts and almost
 * certainly won't.
 *
 * No npm dependency (just native `fetch`), because this cloud sandbox
 * can't reach warcraftlogs.com -- run this from your own machine, where
 * .env.local's real credentials and real network access both live.
 *
 * Run with: node scripts/wcl-diagnose-buff-events.mjs [reportCode] [fightID]
 */

import { readFileSync } from "node:fs";

const REPORT_CODE = process.argv[2] || "NFgQbyqH8aK7GCW4";
const FIGHT_ID_ARG = process.argv[3] ? Number(process.argv[3]) : null;

function loadEnvLocal() {
  const text = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
  const env = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return env;
}

async function getToken(clientId, clientSecret) {
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const res = await fetch("https://www.warcraftlogs.com/oauth/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`Token request failed (${res.status}): ${JSON.stringify(json)}`);
  return json.access_token;
}

// Deliberately does NOT throw on a GraphQL error -- we want to SEE
// `result.errors` directly, same reasoning as every other script here.
async function gql(token, query, variables) {
  const res = await fetch("https://www.warcraftlogs.com/api/v2/client", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });
  return res.json();
}

function unwrapType(t) {
  let name = null;
  let list = false;
  let nonNullOuter = t?.kind === "NON_NULL";
  let cur = t;
  while (cur) {
    if (cur.kind === "LIST") list = true;
    if (cur.name) name = cur.name;
    cur = cur.ofType;
  }
  return { name, list, nonNullOuter };
}

const TYPE_REF_FRAGMENT = `
  kind
  name
  ofType {
    kind
    name
    ofType {
      kind
      name
      ofType {
        kind
        name
      }
    }
  }
`;

// Same idea as unwrapType, but also reports the FINAL kind (OBJECT, SCALAR,
// ENUM, ...) after stripping away any NON_NULL/LIST wrappers -- needed to
// tell "this field is a nested object that itself needs a sub-selection"
// (e.g. ReportMasterData.actors) apart from a plain scalar/enum field.
function unwrapFull(t) {
  let cur = t;
  let list = false;
  while (cur && (cur.kind === "NON_NULL" || cur.kind === "LIST")) {
    if (cur.kind === "LIST") list = true;
    cur = cur.ofType;
  }
  return { kind: cur?.kind ?? null, name: cur?.name ?? null, list };
}

async function introspectType(token, typeName) {
  const q = `query { __type(name: "${typeName}") { name kind fields { name type { ${TYPE_REF_FRAGMENT} } } enumValues { name } } }`;
  const res = await gql(token, q, {});
  if (res.errors) {
    console.log(`Introspection of ${typeName} failed:`, JSON.stringify(res.errors));
    return null;
  }
  return res.data?.__type ?? null;
}

// Learned the hard way (see the doc comment at the top of this file): some
// Report fields (like `table`) return a plain JSON scalar you can select
// bare, but others (like `events`, and `masterData`) return a real GraphQL
// OBJECT type that needs its own `{ ... }` sub-selection, or WCL rejects
// the query outright ("must have a sub selection"). This builds that
// sub-selection by introspecting the object type's own fields, recursing
// one extra level into any field that's ITSELF an object (e.g.
// ReportMasterData.actors) -- deep enough for every shape this script
// needs without writing a fully generic GraphQL explorer.
async function buildSelection(token, typeName, depthRemaining) {
  const t = await introspectType(token, typeName);
  if (!t?.fields?.length) return null;
  const parts = [];
  for (const f of t.fields) {
    const { kind, name: fieldTypeName } = unwrapFull(f.type);
    if (kind === "OBJECT" && depthRemaining > 0 && fieldTypeName) {
      const nested = await buildSelection(token, fieldTypeName, depthRemaining - 1);
      parts.push(nested ? `${f.name} { ${nested} }` : f.name);
    } else {
      parts.push(f.name);
    }
  }
  return parts.join(" ");
}

// Step 1: introspect the Report type broadly (every field name + args),
// plus the TableDataType enum we already know exists (used by table()) --
// checking whether it ALSO covers buffs, or whether buffs live behind a
// differently-named field/enum entirely.
const BROAD_INTROSPECTION_QUERY = `
  query {
    reportType: __type(name: "Report") {
      name
      fields {
        name
        args {
          name
          type { ${TYPE_REF_FRAGMENT} }
        }
        type { ${TYPE_REF_FRAGMENT} }
      }
    }
    tableDataTypeEnum: __type(name: "TableDataType") {
      name
      enumValues { name }
    }
  }
`;

const FIGHTS_QUERY = `
  query($code: String!) {
    reportData {
      report(code: $code) {
        startTime
        endTime
        fights(killType: All) {
          id
          name
          kill
          startTime
          endTime
        }
      }
    }
  }
`;

async function main() {
  const env = loadEnvLocal();
  const token = await getToken(env.WCL_CLIENT_ID, env.WCL_CLIENT_SECRET);

  console.log(`\n========== Step 1: introspecting Report type + TableDataType ==========`);
  const broad = await gql(token, BROAD_INTROSPECTION_QUERY, {});
  if (broad.errors) console.log("ERRORS:", JSON.stringify(broad.errors, null, 2));

  const reportType = broad.data?.reportType;
  const allFields = reportType?.fields ?? [];
  console.log("All Report fields:", allFields.map((f) => f.name).join(", "));

  const tableDataTypeEnum = broad.data?.tableDataTypeEnum?.enumValues?.map((v) => v.name) ?? [];
  console.log("\nTableDataType enum values (used by table()):", tableDataTypeEnum.join(", "));
  console.log(
    tableDataTypeEnum.some((v) => /buff/i.test(v))
      ? "-> table() DOES appear to support a buffs-shaped dataType -- see below."
      : "-> table() does NOT appear to have a buffs-shaped dataType value -- buff/aura data likely lives behind a different field."
  );

  // Candidates for "give me individual timestamped events, not aggregates".
  const eventLike = allFields.filter((f) => /event|aura|buff|cast(?!s\b)/i.test(f.name));
  console.log(`\nReport fields matching /event|aura|buff|cast/i:`, eventLike.map((f) => f.name));
  for (const f of eventLike) {
    console.log(`\n--- ${f.name} ---`);
    console.log("returns:", JSON.stringify(f.type));
    console.log("args:", JSON.stringify(f.args, null, 2));
  }

  // Candidate for "turn a numeric actor id into a player name/class".
  const actorLike = allFields.filter((f) => /master|actor|player|friend/i.test(f.name));
  console.log(`\nReport fields matching /master|actor|player|friend/i (for resolving actor ids to names):`, actorLike.map((f) => f.name));
  for (const f of actorLike) {
    console.log(`\n--- ${f.name} ---`);
    console.log("returns:", JSON.stringify(f.type));
    console.log("args:", JSON.stringify(f.args, null, 2));
  }

  if (eventLike.length === 0) {
    console.log(
      "\nNo field matched /event|aura|buff|cast/i -- printing ALL field names above so we can spot the real one by hand. Stopping here; re-run with a corrected field name once we know it."
    );
    return;
  }

  // Step 2: introspect whatever enum types the discovered event-like
  // field's args actually reference (we don't know their names yet, so
  // this is a second round-trip, same two-step pattern as
  // wcl-diagnose-rankings.mjs -> wcl-diagnose-rankings-metric.mjs).
  const primaryEventField = eventLike.find((f) => /^events$/i.test(f.name)) ?? eventLike[0];
  console.log(`\n========== Step 2: introspecting enum args of "${primaryEventField.name}" ==========`);
  const enumArgNames = primaryEventField.args
    .map((a) => unwrapType(a.type))
    .filter((t) => t.name && !["Int", "Float", "Boolean", "String", "ID"].includes(t.name));
  console.log("Non-scalar arg types to resolve:", enumArgNames.map((t) => t.name));

  const enumIntrospectionFields = enumArgNames
    .map((t, i) => `enum${i}: __type(name: "${t.name}") { name kind enumValues { name } inputFields { name type { ${TYPE_REF_FRAGMENT} } } }`)
    .join("\n");
  const enums = {};
  if (enumIntrospectionFields) {
    const enumResult = await gql(token, `query { ${enumIntrospectionFields} }`, {});
    if (enumResult.errors) console.log("ERRORS:", JSON.stringify(enumResult.errors, null, 2));
    for (const key of Object.keys(enumResult.data ?? {})) {
      const t = enumResult.data[key];
      if (!t) continue;
      console.log(`\nType ${t.name} (${t.kind}):`, t.enumValues ? t.enumValues.map((v) => v.name).join(", ") : JSON.stringify(t.inputFields));
      if (t.enumValues) enums[t.name] = t.enumValues.map((v) => v.name);
    }
  }

  // Step 3: grab real fight time ranges so we can scope a live call to
  // something that actually has data in it.
  console.log(`\n========== Step 3: fetching fights for ${REPORT_CODE} ==========`);
  const fightsJson = await gql(token, FIGHTS_QUERY, { code: REPORT_CODE });
  if (fightsJson.errors) console.log("ERRORS:", JSON.stringify(fightsJson.errors, null, 2));
  const fights = fightsJson.data?.reportData?.report?.fights ?? [];
  const fight = FIGHT_ID_ARG ? fights.find((f) => f.id === FIGHT_ID_ARG) : fights.find((f) => f.kill === true) ?? fights[0];
  if (!fight) {
    console.log("No usable fight found in this report -- pass a report code that actually has fights.");
    return;
  }
  console.log(`Using fight ${fight.id} (${fight.name}), relative window ${fight.startTime}-${fight.endTime}`);

  // Step 3b: `events` (and `masterData`, fetched further down) return real
  // GraphQL objects, not a bare JSON scalar like `table` does -- WCL
  // rejected the first version of this script over exactly that
  // ("must have a sub selection"). Build the right sub-selection by
  // introspecting the actual return type instead of guessing its shape.
  const { name: eventReturnTypeName } = unwrapFull(primaryEventField.type);
  console.log(`\n========== Step 3b: introspecting "${eventReturnTypeName}" (the return type of "${primaryEventField.name}") ==========`);
  const eventSelection = eventReturnTypeName ? await buildSelection(token, eventReturnTypeName, 1) : null;
  console.log(`Sub-selection for ${eventReturnTypeName}:`, eventSelection);

  // Step 4: fire a live call against the discovered field, filling in
  // whatever args we can. `dataType`-shaped args get the first enum value
  // containing "buff" (case-insensitive) if one exists, else just the
  // first available value -- printed explicitly so it's obvious what was
  // actually requested.
  console.log(`\n========== Step 4: live "${primaryEventField.name}" call ==========`);
  const argLiterals = [];
  for (const arg of primaryEventField.args) {
    const { name: typeName, list, nonNullOuter } = unwrapType(arg.type);
    const lowerName = arg.name.toLowerCase();
    let lit = null;
    if (lowerName.includes("fight")) {
      lit = list ? `[${fight.id}]` : String(fight.id);
    } else if (lowerName === "starttime") {
      lit = String(fight.startTime);
    } else if (lowerName === "endtime") {
      lit = String(fight.endTime);
    } else if (enums[typeName]?.length) {
      const preferred = enums[typeName].find((v) => /buff/i.test(v)) ?? enums[typeName][0];
      lit = list ? `[${preferred}]` : preferred;
    } else if (typeName === "Boolean") {
      lit = "true";
    }
    if (lit !== null) {
      argLiterals.push(`${arg.name}: ${lit}`);
    } else if (nonNullOuter) {
      console.log(`Required arg "${arg.name}" (type ${typeName}) couldn't be auto-filled -- add it by hand and re-run.`);
    }
  }
  const query = `
    query {
      reportData {
        report(code: "${REPORT_CODE}") {
          ${primaryEventField.name}${argLiterals.length ? `(${argLiterals.join(", ")})` : ""}${eventSelection ? ` { ${eventSelection} }` : ""}
        }
      }
    }
  `;
  console.log("Query:", query.trim());
  const result = await gql(token, query, {});
  if (result.errors) {
    console.log("ERRORS:", JSON.stringify(result.errors, null, 2));
    return;
  }
  const payload = result.data?.reportData?.report?.[primaryEventField.name];
  const entries = payload?.data ?? payload; // ReportEventPaginator.data is where the real array lives
  const entryList = Array.isArray(entries) ? entries : entries?.events ?? entries?.entries ?? [];
  console.log(`\nTotal entries returned: ${Array.isArray(entryList) ? entryList.length : "(not a list -- see raw payload below)"}`);
  console.log("nextPageTimestamp (set if there's more beyond this page):", payload?.nextPageTimestamp);
  console.log("\nFirst 3 raw entries:", JSON.stringify(Array.isArray(entryList) ? entryList.slice(0, 3) : payload, null, 2));

  // Step 5: search for anything ability-named Prescience / Ebon Might /
  // Shifting Sands among whatever we got back, so we can see real target
  // info (or a numeric actor id we still need to resolve) on each one.
  if (Array.isArray(entryList)) {
    const interesting = entryList.filter((e) => {
      const text = JSON.stringify(e);
      return /prescience|ebon.?might|shifting.?sand/i.test(text);
    });
    console.log(`\nEntries mentioning Prescience / Ebon Might / Shifting Sands: ${interesting.length}`);
    console.log(JSON.stringify(interesting.slice(0, 10), null, 2));
  }

  // Step 6: fetch masterData so numeric sourceID/targetID actor ids in the
  // events above can actually be read as player names/classes -- same
  // "introspect the real return type first" approach as events above.
  const masterDataField = allFields.find((f) => f.name === "masterData");
  if (masterDataField) {
    const { name: masterDataTypeName } = unwrapFull(masterDataField.type);
    console.log(`\n========== Step 6: introspecting + fetching "masterData" (${masterDataTypeName}) ==========`);
    const masterDataSelection = masterDataTypeName ? await buildSelection(token, masterDataTypeName, 2) : null;
    console.log(`Sub-selection for ${masterDataTypeName}:`, masterDataSelection);
    if (masterDataSelection) {
      const mdQuery = `
        query {
          reportData {
            report(code: "${REPORT_CODE}") {
              masterData { ${masterDataSelection} }
            }
          }
        }
      `;
      console.log("Query:", mdQuery.trim());
      const mdResult = await gql(token, mdQuery, {});
      if (mdResult.errors) {
        console.log("ERRORS:", JSON.stringify(mdResult.errors, null, 2));
        return;
      }
      const actors = mdResult.data?.reportData?.report?.masterData?.actors ?? [];
      const abilities = mdResult.data?.reportData?.report?.masterData?.abilities ?? [];
      console.log(`\nTotal actors: ${actors.length}, total abilities: ${abilities.length}`);

      // Raw events came back with `useAbilityIDs: true`, so every entry only
      // has a numeric `abilityGameID`, never a name -- that's WHY Step 5's
      // text search for "Prescience" etc. found nothing against the raw
      // events even though they're almost certainly in there. The names
      // live here instead, on masterData.abilities -- resolve our ability
      // IDs from THIS list, not from the events themselves.
      const INTERESTING = /prescience|ebon.?might|shifting.?sand|double.?time|momentum.?shift|essence.?burst|duplicate/i;
      const matchedAbilities = abilities.filter((a) => INTERESTING.test(a.name));
      console.log(`\nAbilities matching our interest list (${INTERESTING}):`);
      console.log(JSON.stringify(matchedAbilities, null, 2));
      const abilityNameByID = new Map(abilities.map((a) => [a.gameID, a.name]));
      const actorByID = new Map(actors.map((a) => [a.id, a]));

      if (matchedAbilities.length === 0) {
        console.log("\nNo ability names matched -- this report/fight may not have any of these up. Stopping here.");
        return;
      }

      // Step 7: now that we know the REAL ability ids, scope a fresh events
      // call to just the Augmentation Evoker's own casts (sourceID), across
      // the WHOLE fight -- Step 4's unscoped pull hit 10,002 entries and
      // still didn't cover the full fight window (see nextPageTimestamp
      // above), so scoping by source + paginating through
      // nextPageTimestamp is what a real fetch needs to do, not just one
      // unscoped page.
      const evoker =
        actors.find((a) => a.type === "Player" && /augmentation/i.test(a.icon ?? "")) ??
        actors.find((a) => a.type === "Player" && a.subType === "Evoker");
      if (!evoker) {
        console.log("\nNo Evoker found in this report's actors -- pass a report where one played. Stopping here.");
        return;
      }
      console.log(`\n========== Step 7: paginating "events" scoped to source actor ${evoker.id} (${evoker.name}, ${evoker.icon}) ==========`);

      const interestingIDs = new Set(matchedAbilities.map((a) => a.gameID));
      const allHits = [];
      let cursor = fight.startTime;
      let page = 0;
      while (cursor < fight.endTime && page < 20) {
        page++;
        const pageQuery = `
          query {
            reportData {
              report(code: "${REPORT_CODE}") {
                events(dataType: Buffs, hostilityType: Friendlies, fightIDs: [${fight.id}], sourceID: ${evoker.id}, startTime: ${cursor}, endTime: ${fight.endTime}, useAbilityIDs: true, useActorIDs: true) { data nextPageTimestamp }
              }
            }
          }
        `;
        const pageResult = await gql(token, pageQuery, {});
        if (pageResult.errors) {
          console.log(`Page ${page} ERRORS:`, JSON.stringify(pageResult.errors, null, 2));
          break;
        }
        const pagePayload = pageResult.data?.reportData?.report?.events;
        const pageEntries = Array.isArray(pagePayload?.data) ? pagePayload.data : [];
        console.log(`Page ${page}: ${pageEntries.length} entries from sourceID ${evoker.id}, starting at ${cursor}`);
        for (const e of pageEntries) {
          if (interestingIDs.has(e.abilityGameID)) allHits.push(e);
        }
        if (!pagePayload?.nextPageTimestamp || pagePayload.nextPageTimestamp <= cursor) break;
        cursor = pagePayload.nextPageTimestamp;
      }

      console.log(`\nTotal matching buff events from ${evoker.name}: ${allHits.length}`);
      const counts = new Map();
      for (const e of allHits) {
        const name = abilityNameByID.get(e.abilityGameID) ?? `ability ${e.abilityGameID}`;
        counts.set(name, (counts.get(name) ?? 0) + 1);
      }
      console.log("Counts by ability:", Object.fromEntries(counts));

      const readable = allHits.slice(0, 30).map((e) => ({
        time: e.timestamp - fight.startTime,
        type: e.type,
        ability: abilityNameByID.get(e.abilityGameID) ?? e.abilityGameID,
        source: actorByID.get(e.sourceID)?.name ?? e.sourceID,
        target: actorByID.get(e.targetID)?.name ?? e.targetID,
      }));
      console.log("\nFirst 30 matching events (fight-relative ms, readable names):");
      console.log(JSON.stringify(readable, null, 2));

      // Step 8: Prescience specifically came back with ZERO matches scoped
      // to the Evoker's own sourceID in Step 7, even though it's one of
      // the most important abilities for the planned feature. Rather than
      // guess why, check directly and unscoped: query each real Prescience
      // ability id (found in matchedAbilities above) with NO sourceID
      // filter at all, across the whole fight, and print every match --
      // this tells us for certain whether it's genuinely absent from this
      // fight, or whether its applybuff events attribute sourceID
      // differently than Ebon Might's do (e.g. to something other than
      // the caster).
      const prescienceAbilities = matchedAbilities.filter((a) => a.name === "Prescience");
      if (prescienceAbilities.length > 0) {
        console.log(`\n========== Step 8: unscoped check for Prescience (ability ids ${prescienceAbilities.map((a) => a.gameID).join(", ")}) ==========`);
        for (const ability of prescienceAbilities) {
          const presQuery = `
            query {
              reportData {
                report(code: "${REPORT_CODE}") {
                  events(dataType: Buffs, hostilityType: Friendlies, fightIDs: [${fight.id}], abilityID: ${ability.gameID}, startTime: ${fight.startTime}, endTime: ${fight.endTime}, useAbilityIDs: true, useActorIDs: true) { data nextPageTimestamp }
                }
              }
            }
          `;
          const presResult = await gql(token, presQuery, {});
          if (presResult.errors) {
            console.log(`Ability ${ability.gameID} ERRORS:`, JSON.stringify(presResult.errors, null, 2));
            continue;
          }
          const presEntries = presResult.data?.reportData?.report?.events?.data ?? [];
          console.log(`\nAbility ${ability.gameID} (${ability.name}): ${presEntries.length} unscoped matches in this fight.`);
          const presReadable = presEntries.slice(0, 20).map((e) => ({
            time: e.timestamp - fight.startTime,
            type: e.type,
            source: actorByID.get(e.sourceID)?.name ?? e.sourceID,
            target: actorByID.get(e.targetID)?.name ?? e.targetID,
          }));
          console.log(JSON.stringify(presReadable, null, 2));
        }
      }
    }
  }
}

main().catch((err) => {
  console.error("Script failed:", err);
  process.exit(1);
});

/**
 * Diagnostic for the new "player analysis" feature: casts-per-minute vs the
 * top-ranked log, optionally split by fight phase.
 *
 * Three things we don't know yet and can't guess (this project's been
 * burned by guessing WCL's schema before -- see README):
 *   1. Does `table(dataType: Casts, ...)` exist, and what does one entry
 *      look like (per-ability counts? just a total? timestamps?).
 *   2. How do we find "the top log" for a given boss + difficulty + class +
 *      spec, and does that ranking data include the report code + fight ID
 *      of that top log so we can go pull ITS casts too?
 *   3. Does Warcraft Logs expose fight "phases" at all (a lot of multi-phase
 *      encounters have them on the website), and if so, where do the phase
 *      boundaries live -- on the fight itself, or per event?
 *
 * This introspects live types before guessing a field name anywhere it can,
 * and prints real query results for the report+fight you pass in.
 *
 * Run with: node scripts/wcl-diagnose-player-analysis.mjs [reportCode] [fightID]
 * Defaults to the log you linked: W6nrRczBvK7jdCHk, fight 9.
 */

import { readFileSync } from "node:fs";

const REPORT_CODE = process.argv[2] || "W6nrRczBvK7jdCHk";
const FIGHT_ID = Number(process.argv[3] || 9);

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

// Prints a GraphQL introspection type's fields, resolving NON_NULL/LIST
// wrappers down to the real named type so the output is readable.
function describeType(t) {
  if (!t) return "?";
  if (t.kind === "NON_NULL") return describeType(t.ofType) + "!";
  if (t.kind === "LIST") return `[${describeType(t.ofType)}]`;
  return t.name ?? t.kind;
}

async function introspectType(token, typeName) {
  const json = await gql(
    token,
    `query($name: String!) {
      __type(name: $name) {
        name
        kind
        fields { name args { name type { name kind ofType { name kind ofType { name kind } } } } type { name kind ofType { name kind ofType { name kind } } } }
        enumValues { name }
      }
    }`,
    { name: typeName }
  );
  return json.data?.__type ?? null;
}

async function main() {
  const env = loadEnvLocal();
  const token = await getToken(env.WCL_CLIENT_ID, env.WCL_CLIENT_SECRET);

  console.log(`\n========== 1. Report meta + fight ${FIGHT_ID} ==========`);
  const metaJson = await gql(
    token,
    `query($code: String!) {
      reportData {
        report(code: $code) {
          zone { id name }
          fights(killType: All) {
            id name startTime endTime kill difficulty encounterID bossPercentage fightPercentage size
          }
        }
      }
    }`,
    { code: REPORT_CODE }
  );
  if (metaJson.errors) console.log("ERRORS:", JSON.stringify(metaJson.errors, null, 2));
  const report = metaJson.data?.reportData?.report;
  const fight = (report?.fights ?? []).find((f) => f.id === FIGHT_ID);
  console.log("Fight:", fight);
  if (!fight) {
    console.log("Fight not found in this report -- stopping, nothing else can run without it.");
    return;
  }
  // IMPORTANT: fight.startTime/endTime from the fights() query are ALREADY
  // report-relative absolute offsets (matches WCLFight's convention
  // elsewhere in this app), not a fight-local duration starting at 0. The
  // table()/events() `startTime`/`endTime` args genuinely filter by that
  // same absolute timeline, so the range passed here has to bracket the
  // fight's real position in the report -- its own startTime/endTime does
  // that directly.
  const range = { startTime: fight.startTime, endTime: fight.endTime };

  console.log(`\n========== 2. Does the Fight type have any phase-related field, and what shape is "phaseTransitions"? ==========`);
  let phaseTransitionsSelection = "";
  try {
    const reportType = await introspectType(token, "Report");
    const fightsField = (reportType?.fields ?? []).find((f) => f.name === "fights");
    console.log("Report.fights returns:", describeType(fightsField?.type));
    const fightTypeName = fightsField?.type?.ofType?.ofType?.name ?? fightsField?.type?.ofType?.name ?? fightsField?.type?.name;
    if (fightTypeName) {
      const fightType = await introspectType(token, fightTypeName);
      console.log(`All fields on ${fightTypeName}:`, (fightType?.fields ?? []).map((f) => f.name).join(", "));
      const phaseTransitionsField = (fightType?.fields ?? []).find((f) => f.name === "phaseTransitions");
      console.log("phaseTransitions field:", JSON.stringify(phaseTransitionsField, null, 2));
      const phaseTypeName =
        phaseTransitionsField?.type?.ofType?.ofType?.name ?? phaseTransitionsField?.type?.ofType?.name ?? phaseTransitionsField?.type?.name;
      if (phaseTypeName) {
        const phaseType = await introspectType(token, phaseTypeName);
        const phaseFields = (phaseType?.fields ?? []).map((f) => f.name);
        console.log(`Fields on ${phaseTypeName}:`, phaseFields.join(", "));
        phaseTransitionsSelection = phaseFields.length > 0 ? `phaseTransitions { ${phaseFields.join(" ")} }` : "";
      }
    }
  } catch (err) {
    console.log("Step 2 failed:", err.message);
  }

  if (phaseTransitionsSelection) {
    console.log(`\n========== 2b. Real phaseTransitions data for fight ${FIGHT_ID} ==========`);
    try {
      const phaseJson = await gql(
        token,
        `query($code: String!) {
          reportData {
            report(code: $code) {
              fights(killType: All) {
                id
                ${phaseTransitionsSelection}
              }
            }
          }
        }`,
        { code: REPORT_CODE }
      );
      if (phaseJson.errors) console.log("ERRORS:", JSON.stringify(phaseJson.errors, null, 2));
      const thisFight = (phaseJson.data?.reportData?.report?.fights ?? []).find((f) => f.id === FIGHT_ID);
      console.log(`phaseTransitions for fight ${FIGHT_ID}:`, JSON.stringify(thisFight?.phaseTransitions, null, 2));
    } catch (err) {
      console.log("Step 2b failed:", err.message);
    }
  } else {
    console.log(`\n(Skipping step 2b -- couldn't determine phaseTransitions' sub-fields.)`);
  }

  console.log(`\n========== 3. TableDataType enum values (looking for "Casts") ==========`);
  let hasCastsDataType = false;
  try {
    const enumType = await introspectType(token, "TableDataType");
    const values = (enumType?.enumValues ?? []).map((v) => v.name);
    console.log("TableDataType values:", values.join(", "));
    hasCastsDataType = values.includes("Casts");
  } catch (err) {
    console.log("Step 3 failed:", err.message);
  }

  let dmgEntries = [];
  console.log(`\n========== 4. Real DamageDone table for fight ${FIGHT_ID} (checking the "icon" field for class-spec) ==========`);
  try {
    const dmgJson = await gql(
      token,
      `query($code: String!, $fightIDs: [Int], $startTime: Float!, $endTime: Float!) {
        reportData {
          report(code: $code) {
            table(fightIDs: $fightIDs, dataType: DamageDone, startTime: $startTime, endTime: $endTime)
          }
        }
      }`,
      { code: REPORT_CODE, fightIDs: [FIGHT_ID], startTime: range.startTime, endTime: range.endTime }
    );
    if (dmgJson.errors) console.log("ERRORS:", JSON.stringify(dmgJson.errors, null, 2));
    dmgEntries = dmgJson.data?.reportData?.report?.table?.data?.entries ?? [];
    console.log(
      `Got ${dmgEntries.length} damage entries. name/type(class)/icon:`,
      JSON.stringify(dmgEntries.map((e) => ({ name: e.name, type: e.type, icon: e.icon })), null, 2)
    );
  } catch (err) {
    console.log("Step 4 failed:", err.message);
  }

  if (hasCastsDataType) {
    console.log(`\n========== 5. Real Casts table for fight ${FIGHT_ID} ==========`);
    try {
      const castsJson = await gql(
        token,
        `query($code: String!, $fightIDs: [Int], $startTime: Float!, $endTime: Float!) {
          reportData {
            report(code: $code) {
              table(fightIDs: $fightIDs, dataType: Casts, startTime: $startTime, endTime: $endTime)
            }
          }
        }`,
        { code: REPORT_CODE, fightIDs: [FIGHT_ID], startTime: range.startTime, endTime: range.endTime }
      );
      if (castsJson.errors) console.log("ERRORS:", JSON.stringify(castsJson.errors, null, 2));
      const castsEntries = castsJson.data?.reportData?.report?.table?.data?.entries ?? [];
      console.log(`Got ${castsEntries.length} cast entries. FULL first entry:`, JSON.stringify(castsEntries[0], null, 2));
      console.log(
        "All entries' name/type/icon/total:",
        JSON.stringify(castsEntries.map((e) => ({ name: e.name, type: e.type, icon: e.icon, total: e.total })), null, 2)
      );
    } catch (err) {
      console.log("Step 5 failed:", err.message);
    }
  } else {
    console.log(`\n(Skipping step 5 -- "Casts" wasn't in the TableDataType enum above.)`);
  }

  // Pick a sample player (whoever did the most damage) to use for the
  // rankings lookup below -- class comes straight from `type`, spec is a
  // GUESS from splitting `icon` on "-" (WCL's icon strings often look like
  // "Warrior-Fury"), printed so you can eyeball whether that guess is right.
  const sample = [...dmgEntries].sort((a, b) => (b.total ?? 0) - (a.total ?? 0))[0];
  const sampleClass = sample?.type;
  const sampleSpec = sample?.icon?.includes("-") ? sample.icon.split("-")[1] : null;
  console.log(`\nSample player for the rankings lookup below: ${sample?.name}, class="${sampleClass}", spec guess="${sampleSpec}" (from icon="${sample?.icon}")`);

  console.log(`\n========== 6. Does WorldData have an "encounter" field, and does Encounter have "characterRankings"? ==========`);
  let charRankingsArgs = null;
  try {
    const worldDataType = await introspectType(token, "WorldData");
    console.log("WorldData fields:", (worldDataType?.fields ?? []).map((f) => f.name).join(", "));
    const encounterType = await introspectType(token, "Encounter");
    console.log("Encounter fields:", (encounterType?.fields ?? []).map((f) => f.name).join(", "));
    const charRankingsField = (encounterType?.fields ?? []).find((f) => f.name === "characterRankings");
    console.log("characterRankings field detail:", JSON.stringify(charRankingsField, null, 2));
    charRankingsArgs = charRankingsField?.args ?? null;
  } catch (err) {
    console.log("Step 6 failed:", err.message);
  }

  if (charRankingsArgs && fight.encounterID && sampleClass && sampleSpec) {
    console.log(`\n========== 7. Whatever enum the "metric" arg uses, and its values ==========`);
    let metricValue = "dps";
    try {
      const metricArg = charRankingsArgs.find((a) => a.name === "metric");
      const metricTypeName = metricArg?.type?.ofType?.name ?? metricArg?.type?.name;
      console.log("metric arg type:", metricTypeName);
      if (metricTypeName) {
        const metricEnum = await introspectType(token, metricTypeName);
        const values = (metricEnum?.enumValues ?? []).map((v) => v.name);
        console.log(`${metricTypeName} values:`, values.join(", "));
        if (values.includes("dps")) metricValue = "dps";
        else if (values.length > 0) metricValue = values[0];
      }
    } catch (err) {
      console.log("Step 7 failed:", err.message);
    }

    console.log(`\n========== 8. Real characterRankings call (encounter ${fight.encounterID}, ${sampleClass}/${sampleSpec}, difficulty ${fight.difficulty}, metric ${metricValue}) ==========`);
    try {
      const rankJson = await gql(
        token,
        `query($encounterID: Int!, $className: String!, $specName: String!, $difficulty: Int!, $metric: CharacterRankingMetricType) {
          worldData {
            encounter(id: $encounterID) {
              characterRankings(className: $className, specName: $specName, difficulty: $difficulty, metric: $metric)
            }
          }
        }`,
        {
          encounterID: fight.encounterID,
          className: sampleClass,
          specName: sampleSpec,
          difficulty: fight.difficulty,
          metric: metricValue,
        }
      );
      if (rankJson.errors) console.log("ERRORS:", JSON.stringify(rankJson.errors, null, 2));
      // This can be a big payload -- print enough to see the shape of ONE
      // ranking entry (esp. whether it carries a report code + fight ID)
      // without dumping hundreds of entries.
      const data = rankJson.data?.worldData?.encounter?.characterRankings;
      console.log("Raw characterRankings top-level keys:", data && typeof data === "object" ? Object.keys(data) : typeof data);
      console.log("First ~3000 chars of the response:", JSON.stringify(rankJson, null, 2).slice(0, 3000));
    } catch (err) {
      console.log("Step 8 failed:", err.message);
    }
  } else {
    console.log(`\n(Skipping steps 7-8 -- missing a piece: characterRankings field, encounterID, class, or spec guess.)`);
  }

  console.log(`\n========== 9. What does "events" actually return (ReportEventPaginator), and does one Cast event carry a phase? ==========`);
  try {
    const paginatorType = await introspectType(token, "ReportEventPaginator");
    console.log("ReportEventPaginator fields:", JSON.stringify(paginatorType?.fields, null, 2));
    const dataField = (paginatorType?.fields ?? []).find((f) => f.name === "data");
    console.log("`data` field type:", describeType(dataField?.type));
    // `data` on a paginator type is very likely a JSON scalar (same pattern
    // as `table` above) rather than something with its own sub-fields --
    // request it plainly and fall back to introspection output otherwise.
    const evJson = await gql(
      token,
      `query($code: String!, $fightIDs: [Int], $startTime: Float!, $endTime: Float!) {
        reportData {
          report(code: $code) {
            events(fightIDs: $fightIDs, dataType: Casts, startTime: $startTime, endTime: $endTime, limit: 10) {
              data
              nextPageTimestamp
            }
          }
        }
      }`,
      { code: REPORT_CODE, fightIDs: [FIGHT_ID], startTime: range.startTime, endTime: Math.min(range.endTime, range.startTime + 60000) }
    );
    if (evJson.errors) console.log("ERRORS:", JSON.stringify(evJson.errors, null, 2));
    console.log(JSON.stringify(evJson, null, 2).slice(0, 4000));
  } catch (err) {
    console.log("Step 9 failed:", err.message);
  }
}

main().catch((err) => {
  console.error("Script failed:", err);
  process.exit(1);
});

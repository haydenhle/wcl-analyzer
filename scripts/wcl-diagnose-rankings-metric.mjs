/**
 * Follow-up diagnostic to scripts/wcl-diagnose-rankings.mjs.
 *
 * That first script found `report.rankings(fightIDs:, compare:, ...)` and
 * confirmed WCL only ranks kills, but it never explicitly set the
 * `playerMetric` argument (its enum type -- `ReportRankingMetricType` --
 * wasn't known yet, so the introspection query guessed the wrong type name
 * and got an "Internal server error" back for it, silently). Leaving
 * `playerMetric` unset means WCL picks ONE default metric per character
 * (damage for DPS/tanks, healing for healers) and returns exactly one
 * `rankPercent` -- which is why the app ended up showing a player's DAMAGE
 * percentile on the HEALING chart too: it was reusing that one number for
 * both charts instead of asking for damage and healing percentiles
 * separately.
 *
 * This script:
 *   1. Introspects `ReportRankingMetricType` properly this time, to get its
 *      real enum values (no more guessing "dps"/"hps" as literal names).
 *   2. Fires one live `rankings` call per enum value against a real kill
 *      fight, so we can see which value actually changes `rankPercent` for
 *      DPS-role characters vs. healer-role characters, and -- importantly
 *      -- whether an off-role character (e.g. a DPS's incidental healing)
 *      gets a rankPercent under the healing-flavored metric at all, or is
 *      simply absent from that role bucket.
 *
 * Run with: node scripts/wcl-diagnose-rankings-metric.mjs [reportCode] [fightID]
 */

import { readFileSync } from "node:fs";

const REPORT_CODE = process.argv[2] || "NFgQbyqH8aK7GCW4";
const EXPLICIT_FIGHT_ID = process.argv[3] ? Number(process.argv[3]) : undefined;

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

async function main() {
  const env = loadEnvLocal();
  const token = await getToken(env.WCL_CLIENT_ID, env.WCL_CLIENT_SECRET);

  console.log(`\n========== Introspecting ReportRankingMetricType ==========`);
  const enumJson = await gql(
    token,
    `query { __type(name: "ReportRankingMetricType") { name enumValues { name } } }`,
    {}
  );
  const enumValues = (enumJson.data?.__type?.enumValues ?? []).map((v) => v.name);
  console.log("Values:", enumValues.join(", "));
  if (enumJson.errors) console.log("ERRORS:", JSON.stringify(enumJson.errors, null, 2));
  if (!enumValues.length) {
    console.log("No enum values found -- can't continue without them.");
    return;
  }

  // Pick a fight: an explicit ID if given, otherwise the first kill in the
  // report (same as the previous script -- rankings only exist for kills).
  let fightID = EXPLICIT_FIGHT_ID;
  if (fightID === undefined) {
    const fightsJson = await gql(
      token,
      `query($code: String!) { reportData { report(code: $code) { fights { id kill name } } } }`,
      { code: REPORT_CODE }
    );
    const fights = fightsJson.data?.reportData?.report?.fights ?? [];
    const killFight = fights.find((f) => f.kill === true);
    if (!killFight) {
      console.log("No kill fight found in this report -- pass a fight ID explicitly as the 2nd argument.");
      return;
    }
    fightID = killFight.id;
    console.log(`\nUsing kill fight ${fightID} (${killFight.name})`);
  } else {
    console.log(`\nUsing explicit fight ${fightID}`);
  }

  // For each enum value, fire a live call and print, per role bucket, each
  // character's name + rankPercent -- so we can see which metric affects
  // which role, and whether a role bucket is empty/different in size
  // between metrics (e.g. does "healers" show up at all under a damage
  // metric, do DPS characters show up under a healing metric).
  for (const metric of enumValues) {
    const query = `
      query {
        reportData {
          report(code: "${REPORT_CODE}") {
            rankings(fightIDs: [${fightID}], compare: Rankings, playerMetric: ${metric})
          }
        }
      }
    `;
    console.log(`\n========== playerMetric: ${metric} ==========`);
    const result = await gql(token, query, {});
    if (result.errors) {
      console.log("ERRORS:", JSON.stringify(result.errors, null, 2));
      continue;
    }
    const fightEntry = result.data?.reportData?.report?.rankings?.data?.[0];
    if (!fightEntry) {
      console.log("(no fight entry in response)");
      continue;
    }
    for (const [roleName, role] of Object.entries(fightEntry.roles ?? {})) {
      const names = (role?.characters ?? []).map((c) => `${c.name}=${c.rankPercent}`);
      console.log(`  ${roleName}: ${names.join(", ") || "(empty)"}`);
    }
  }
}

main().catch((err) => {
  console.error("Script failed:", err);
  process.exit(1);
});

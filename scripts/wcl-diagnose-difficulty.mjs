/**
 * Diagnostic for a new feature: a "Mythic only" filter on the guild page.
 * `WCLFight.difficulty` is just a raw number (confirmed from the fights()
 * query this app already uses) -- Warcraft Logs' own public docs describe
 * the *shape* of a Difficulty (id/name/sizes) but not which number means
 * "Mythic" for raids, and this project's own history (two earlier wrong
 * schema guesses) is exactly why that number shouldn't be assumed.
 *
 * This script asks the live API directly, two ways:
 *   1. Introspects the `Zone` type to see if it exposes a `difficulties`
 *      field (id/name/sizes) we can query directly for the definitive
 *      id -> name mapping.
 *   2. If that field exists, looks up the report's own zone and prints
 *      every difficulty option for it (with id, name, and size range).
 *   3. Either way, also prints every fight in the report with its raw
 *      `difficulty` number, `kill`, and `size` -- so you can cross-check
 *      against what you actually know that raid night's difficulty was,
 *      even if step 2 comes back empty for some reason.
 *
 * Run with: node scripts/wcl-diagnose-difficulty.mjs [reportCode]
 */

import { readFileSync } from "node:fs";

const REPORT_CODE = process.argv[2] || "NFgQbyqH8aK7GCW4";

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

  console.log(`\n========== Introspecting Zone type for a "difficulties" field ==========`);
  const zoneIntrospection = await gql(
    token,
    `query { __type(name: "Zone") { name fields { name args { name type { name } } type { name kind ofType { name kind } } } } }`,
    {}
  );
  const zoneFields = (zoneIntrospection.data?.__type?.fields ?? []).map((f) => f.name);
  console.log("All Zone fields:", zoneFields.join(", "));
  if (zoneIntrospection.errors) console.log("ERRORS:", JSON.stringify(zoneIntrospection.errors, null, 2));

  // Get this report's zone id + every fight's raw difficulty/kill/size, in
  // one request -- gives us real data to cross-check against regardless of
  // whether step 2 below works out.
  const reportJson = await gql(
    token,
    `query($code: String!) {
      reportData {
        report(code: $code) {
          zone { id name }
          fights(killType: All) { id name kill difficulty size encounterID }
        }
      }
    }`,
    { code: REPORT_CODE }
  );
  if (reportJson.errors) console.log("ERRORS:", JSON.stringify(reportJson.errors, null, 2));
  const report = reportJson.data?.reportData?.report;
  const zone = report?.zone;
  console.log(`\nReport zone:`, zone);

  if (zoneFields.includes("difficulties") && zone?.id) {
    console.log(`\n========== worldData.zone(${zone.id}).difficulties ==========`);
    const diffJson = await gql(
      token,
      `query($zoneID: Int!) { worldData { zone(id: $zoneID) { id name difficulties { id name sizes } } } }`,
      { zoneID: zone.id }
    );
    console.log(JSON.stringify(diffJson, null, 2));
  } else {
    console.log(`\n(Zone has no "difficulties" field, or this report has no zone -- skipping step 2.)`);
  }

  console.log(`\n========== Every fight's raw difficulty/kill/size (cross-check by eye) ==========`);
  for (const f of report?.fights ?? []) {
    console.log(
      `  fight ${f.id}: "${f.name}" -- difficulty=${f.difficulty}, kill=${f.kill}, size=${f.size}, encounterID=${f.encounterID}`
    );
  }
}

main().catch((err) => {
  console.error("Script failed:", err);
  process.exit(1);
});

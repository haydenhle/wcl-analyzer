/**
 * Standalone diagnostic tool for talking to the live WCL API directly,
 * outside the app's own types/caching -- no `npm install` needed (just
 * native `fetch`), so it works even from an environment (like this app's
 * own dev sandbox) that can't reach npm's registry.
 *
 * The point: when `report.table(...)` came back as a bare "Internal server
 * error" with no useful detail, and the app's own hand-written types
 * turned out not to match the real response shape, this script is what
 * found the actual required arguments and printed the actual field names --
 * evidence gathered from the live API instead of guessing again from the
 * (sparse) public docs. See README "Verifying against the live schema".
 *
 * Round 2 (this version): we already know table() needs startTime/endTime.
 * This prints the FULL, untruncated JSON of one Deaths entry and one
 * DamageDone entry so every field name is visible before rewriting the
 * app's types.
 *
 * Run with: node scripts/wcl-diagnose.mjs [reportCode]
 */

import { readFileSync } from "node:fs";

const REPORT_CODE = process.argv[2] || "NFgQbyqH8aK7GCW4";

// Reads WCL_CLIENT_ID/WCL_CLIENT_SECRET straight out of .env.local -- a
// tiny hand-rolled parser instead of pulling in a dotenv dependency for a
// one-off script.
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

// Same client-credentials flow as lib/wcl/client.ts's getAccessToken, just
// inlined here so this script has zero dependency on the app's own code
// (deliberately -- it needs to keep working even if the app's client is
// what's broken).
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

// Deliberately does NOT throw on a GraphQL error -- the whole point of this
// script is to inspect `result.errors` and `result.data` directly, so
// `main()` below prints them instead of an exception swallowing the detail.
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

const TABLE_QUERY = `
  query($code: String!, $dataType: TableDataType!, $startTime: Float!, $endTime: Float!) {
    reportData {
      report(code: $code) {
        table(dataType: $dataType, startTime: $startTime, endTime: $endTime)
      }
    }
  }
`;

async function main() {
  const env = loadEnvLocal();
  const token = await getToken(env.WCL_CLIENT_ID, env.WCL_CLIENT_SECRET);

  // Step 1: fetch just enough metadata to compute the report's duration --
  // table() needs a startTime/endTime range (see TABLE_QUERY below), and
  // report.endTime/startTime are absolute epoch ms while table() wants
  // report-relative bounds, same as the real app does in queries.ts.
  const metaJson = await gql(
    token,
    `query($code: String!) { reportData { report(code: $code) { startTime endTime } } }`,
    { code: REPORT_CODE }
  );
  const report = metaJson.data.reportData.report;
  const duration = report.endTime - report.startTime;

  // Step 2: pull one full table of each kind and print the FIRST entry's
  // raw JSON, untruncated -- that's enough to read off every field name
  // WCL actually sends, instead of guessing from the schema's sparse docs.
  for (const dataType of ["Deaths", "DamageDone"]) {
    const result = await gql(token, TABLE_QUERY, {
      code: REPORT_CODE,
      dataType,
      startTime: 0,
      endTime: duration,
    });
    const entries = result.data?.reportData?.report?.table?.data?.entries;
    console.log(`\n========== ${dataType}: full first entry ==========`);
    if (result.errors) {
      console.log("ERRORS:", JSON.stringify(result.errors, null, 2));
    } else if (!entries?.length) {
      console.log("(no entries -- table.data.entries was empty or missing; full payload below)");
      console.log(JSON.stringify(result.data, null, 2).slice(0, 2000));
    } else {
      console.log(JSON.stringify(entries[0], null, 2));
      console.log(`\n(total entries: ${entries.length})`);
    }
  }
}

main().catch((err) => {
  console.error("Script failed:", err);
  process.exit(1);
});

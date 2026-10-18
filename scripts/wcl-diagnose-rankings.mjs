/**
 * Standalone diagnostic tool for the "Parse %" feature (WCL's percentile
 * ranking data -- how a pull's damage/healing compares to other logs of the
 * same encounter/difficulty).
 *
 * Same rationale as scripts/wcl-diagnose.mjs: two earlier features in this
 * app (report.table()'s required startTime/endTime, and Guild.reports not
 * actually existing on the Guild type) were both guessed wrong from the
 * public docs. Rather than guess a third time, this script:
 *
 *   1. Introspects the `Report` type so we can see every field WCL actually
 *      exposes (and its real argument names/types) instead of assuming the
 *      field is called `rankings`.
 *   2. Introspects a couple of likely enum types (e.g. whatever the
 *      `playerMetric`-shaped argument turns out to be) so we know the legal
 *      enum values too, not just that an enum argument exists.
 *   3. Picks one real kill fight and one real wipe fight from the target
 *      report, then uses what step 1 discovered to build and fire a live
 *      call for BOTH -- since the app only needs this feature for kill/wipe
 *      pulls, and needs to know whether WCL even returns percentiles for a
 *      wipe (a wipe never "completes" the encounter, so it's plausible WCL
 *      only ranks kills -- this is exactly the kind of thing worth checking
 *      against the live API instead of assuming).
 *
 * No npm dependency (just native `fetch`), because this cloud sandbox can't
 * reach warcraftlogs.com -- run this from your own machine, where
 * .env.local's real credentials and real network access both live.
 *
 * Run with: node scripts/wcl-diagnose-rankings.mjs [reportCode]
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

// A type reference in introspection can be wrapped in NON_NULL/LIST any
// number of times (e.g. `[Int!]!`) before you get to the actual named type.
// This walks the `ofType` chain to recover: the base type's name, whether
// it's a list, and whether the OUTERMOST layer is required.
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

// Introspection fragment for a type reference, nested deep enough to unwrap
// `[Type!]!`-style wrappers (NON_NULL -> LIST -> NON_NULL -> named type).
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

const INTROSPECTION_QUERY = `
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
    playerMetricEnum: __type(name: "PlayerMetric") {
      name
      enumValues { name }
    }
    rankingCompareEnum: __type(name: "RankingCompareType") {
      name
      enumValues { name }
    }
    rankingTimeframeEnum: __type(name: "RankingTimeframeType") {
      name
      enumValues { name }
    }
  }
`;

const FIGHTS_QUERY = `
  query($code: String!) {
    reportData {
      report(code: $code) {
        fights {
          id
          kill
          encounterID
          name
        }
      }
    }
  }
`;

// Builds a literal (not a $variable) for a given introspected arg type, so
// the generated query is a single self-contained string we can print
// alongside its result. `fightIdLiteral` is substituted for any argument
// whose name looks like it wants the fight ID(s) we picked.
function literalForArg(arg, fightIdLiteral, enums) {
  const { name: typeName, list } = unwrapType(arg.type);
  const lowerArgName = arg.name.toLowerCase();

  if (lowerArgName.includes("fight")) {
    return list ? `[${fightIdLiteral}]` : String(fightIdLiteral);
  }
  if (typeName === "Int" || typeName === "Float") return list ? "[0]" : "0";
  if (typeName === "Boolean") return "true";
  if (typeName === "String" || typeName === "ID") return list ? `["a"]` : `"a"`;

  // Enum: use whatever value the introspection above actually found for it,
  // rather than guessing a name.
  const enumValues = enums[typeName];
  if (enumValues?.length) {
    const v = enumValues[0];
    return list ? `[${v}]` : v;
  }
  return null; // unknown type we can't safely fill in -- caller should skip
}

async function main() {
  const env = loadEnvLocal();
  const token = await getToken(env.WCL_CLIENT_ID, env.WCL_CLIENT_SECRET);

  console.log(`\n========== Introspecting Report type + candidate enums ==========`);
  const introspection = await gql(token, INTROSPECTION_QUERY, {});
  if (introspection.errors) {
    console.log("ERRORS:", JSON.stringify(introspection.errors, null, 2));
  }
  const reportType = introspection.data?.reportType;
  const allFieldNames = (reportType?.fields ?? []).map((f) => f.name);
  console.log("All Report fields:", allFieldNames.join(", "));

  const rankLike = (reportType?.fields ?? []).filter((f) => /rank|percentile|parse/i.test(f.name));
  console.log(`\nFields matching /rank|percentile|parse/i:`, rankLike.map((f) => f.name));
  for (const f of rankLike) {
    console.log(`\n--- ${f.name} ---`);
    console.log("returns:", JSON.stringify(f.type));
    console.log("args:", JSON.stringify(f.args, null, 2));
  }

  const enums = {};
  for (const key of ["playerMetricEnum", "rankingCompareEnum", "rankingTimeframeEnum"]) {
    const t = introspection.data?.[key];
    if (t?.enumValues) {
      enums[t.name] = t.enumValues.map((v) => v.name);
      console.log(`\nEnum ${t.name}:`, enums[t.name].join(", "));
    }
  }

  if (rankLike.length === 0) {
    console.log("\nNo field on Report matched /rank|percentile|parse/i -- printing ALL field names above so we can spot the real one by hand.");
    return;
  }

  // Grab one real kill fight and one real wipe fight to test against.
  const fightsJson = await gql(token, FIGHTS_QUERY, { code: REPORT_CODE });
  const fights = fightsJson.data?.reportData?.report?.fights ?? [];
  const killFight = fights.find((f) => f.kill === true);
  const wipeFight = fights.find((f) => f.kill === false);
  console.log(`\nPicked kill fight:`, killFight ? `${killFight.id} (${killFight.name})` : "none found");
  console.log(`Picked wipe fight:`, wipeFight ? `${wipeFight.id} (${wipeFight.name})` : "none found");

  // For every rank-like field, try firing a live call against both fights,
  // using the introspected args to fill in literals automatically.
  for (const field of rankLike) {
    for (const [label, fight] of [["KILL", killFight], ["WIPE", wipeFight]]) {
      if (!fight) continue;
      const argLiterals = [];
      let skip = false;
      for (const arg of field.args) {
        const { nonNullOuter } = unwrapType(arg.type);
        const lit = literalForArg(arg, fight.id, enums);
        if (lit === null) {
          if (nonNullOuter) {
            console.log(`\nSkipping ${field.name} for ${label} fight -- required arg "${arg.name}" has an unhandled type ${JSON.stringify(arg.type)}.`);
            skip = true;
            break;
          }
          continue; // optional arg we can't fill -- just omit it
        }
        argLiterals.push(`${arg.name}: ${lit}`);
      }
      if (skip) continue;

      const query = `
        query {
          reportData {
            report(code: "${REPORT_CODE}") {
              ${field.name}${argLiterals.length ? `(${argLiterals.join(", ")})` : ""}
            }
          }
        }
      `;
      console.log(`\n========== ${field.name} -- ${label} fight ${fight.id} ==========`);
      console.log("Query:", query.trim());
      const result = await gql(token, query, {});
      console.log("Result:", JSON.stringify(result, null, 2));
    }
  }
}

main().catch((err) => {
  console.error("Script failed:", err);
  process.exit(1);
});

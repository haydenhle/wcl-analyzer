/**
 * This file is the only place in the app that actually sends requests to
 * the Warcraft Logs API over the network. Every other file (queries.ts,
 * service.ts) calls the `wclGraphQL()` function below instead of using
 * `fetch` directly.
 *
 * Every request goes through the same three steps:
 * 1. Log in (or reuse a saved login) using OAuth - a way of proving to
 *    Warcraft Logs who we are.
 * 2. Check we haven't sent too many requests recently (rate limiting).
 * 3. Send the request, and cache the response so we don't have to ask
 *    again right away.
 */
import { SlidingWindowCounter, TTLCache } from "@/lib/cache";
import { WCLApiError } from "./types";

const TOKEN_URL = "https://www.warcraftlogs.com/oauth/token";
const GRAPHQL_URL = "https://www.warcraftlogs.com/api/v2/client";

// Rate limiting: Warcraft Logs gives free API clients 3,600 "points" per
// hour to spend. We don't track the exact point cost of each query, so
// this is just a simple safety cap of 50 requests per minute, to catch a
// runaway loop before it burns through the real quota.
const REQUEST_THROTTLE = new SlidingWindowCounter(60_000, 50);

// Caching: temporary storage for API responses, so we don't ask Warcraft
// Logs for the same data twice. By default a response is kept for 5
// minutes.
const responseCache = new TTLCache<unknown>(5 * 60_000);

// --- Logging in (OAuth) --------------------------------------------------
// OAuth here just means: this app proves who it is with a client ID +
// secret (like a username/password, but for apps instead of people), and
// Warcraft Logs hands back a token. There's no login button for a person -
// the app logs in as itself, once, and reuses that token.

let cachedToken: { accessToken: string; expiresAt: number } | null = null;

function getCredentials(): { clientId: string; clientSecret: string } {
  const clientId = process.env.WCL_CLIENT_ID;
  const clientSecret = process.env.WCL_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new WCLApiError(
      "Missing WCL_CLIENT_ID / WCL_CLIENT_SECRET. Create a client at " +
        "https://www.warcraftlogs.com/api/clients/ and add them to .env.local " +
        "(see .env.example)."
    );
  }
  return { clientId, clientSecret };
}

async function getAccessToken(): Promise<string> {
  // If we already have a token that isn't about to expire, reuse it
  // instead of logging in again on every single request.
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) {
    return cachedToken.accessToken;
  }

  // Send our client ID + secret to prove who we are (HTTP Basic auth).
  // No redirect, no user interaction - this all happens server-side.
  const { clientId, clientSecret } = getCredentials();
  const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basicAuth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
    // Tokens last about a day, so there's no need to cache this call itself.
    cache: "no-store",
  });

  if (!res.ok) {
    throw new WCLApiError(
      `Failed to obtain WCL access token (${res.status})`,
      res.status,
      await safeText(res)
    );
  }

  const json = (await res.json()) as { access_token: string; expires_in: number };
  cachedToken = {
    accessToken: json.access_token,
    expiresAt: Date.now() + json.expires_in * 1000,
  };
  return cachedToken.accessToken;
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

// --- Sending the actual GraphQL request -----------------------------------

// What Warcraft Logs sends back: either the `data` we asked for, or a list
// of `errors`. We treat any error as a failure, even if some data also
// came back.
interface GraphQLResponse<T> {
  data?: T;
  errors?: { message: string }[];
}

/**
 * Sends a GraphQL request (a way of asking an API for exactly the fields
 * you want, instead of a fixed response shape) to the Warcraft Logs API,
 * and returns the data.
 *
 * Pass `cacheKey` + `cacheTtlMs` to cache the response (a name for this
 * request, and how long to keep it, in milliseconds). `cacheTtlMs` can
 * also be a function that looks at the response and picks a TTL - e.g. an
 * old, finished report can be cached much longer than one still being
 * logged. Leave both out for a request you never want cached (like the
 * rate-limit check itself).
 */
export async function wclGraphQL<T>(
  query: string,
  variables: Record<string, unknown>,
  opts?: { cacheKey?: string; cacheTtlMs?: number | ((data: T) => number) }
): Promise<T> {
  // Step 1: if we already have a fresh cached copy of this exact request,
  // use that instead of calling the API again.
  const cacheKey = opts?.cacheKey ?? `${query}:${JSON.stringify(variables)}`;

  const cached = responseCache.get(cacheKey);
  if (cached !== undefined) return cached as T;

  // Step 2: make sure we're not sending too many requests too fast (see
  // REQUEST_THROTTLE above). A burst that's within this app's own safety
  // cap over time (e.g. fetching many guild reports at once) waits here for
  // its turn instead of failing outright -- a request that silently never
  // went out (and the raid night that quietly disappeared because of it) is
  // a worse outcome than this call taking a bit longer.
  await REQUEST_THROTTLE.acquire();

  // Step 3: log in (or reuse our saved token) and build the request body.
  const token = await getAccessToken();
  const body = JSON.stringify({ query, variables });

  if (process.env.NODE_ENV !== "production") {
    // Only prints in your local `npm run dev` terminal, never in the
    // browser, and never includes the token. Useful for seeing exactly
    // what we asked for when something goes wrong.
    console.log("[wcl] request variables:", variables);
  }

  // Step 4: actually send the request to Warcraft Logs.
  // `cache: "no-store"` turns off Next.js's own built-in fetch cache -
  // we're doing our own caching above and below instead.
  const res = await fetch(GRAPHQL_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body,
    cache: "no-store",
  });

  // Step 5: handle network-level failures first (a bad HTTP status). A
  // GraphQL-level error looks different - it comes back with a normal
  // 200 OK, and is checked separately in Step 6.
  if (res.status === 429) {
    throw new WCLApiError(
      "Warcraft Logs API rate limit hit. This API client's hourly point budget " +
        "is exhausted -- try again next hour, or use a Patreon-boosted client.",
      429
    );
  }

  if (!res.ok) {
    throw new WCLApiError(`WCL API request failed (${res.status})`, res.status, await safeText(res));
  }

  // Step 6: Warcraft Logs can report an error (like "report not found")
  // inside a normal 200 OK response, instead of using an HTTP error status.
  // So we have to check the response body itself for errors, not just
  // `res.ok`.
  const json = (await res.json()) as GraphQLResponse<T>;
  if (json.errors?.length) {
    console.error("[wcl] GraphQL error(s):", json.errors, "-- request body was:", body);
    throw new WCLApiError(json.errors.map((e) => e.message).join("; "), res.status, json.errors);
  }
  if (!json.data) {
    throw new WCLApiError("WCL API returned no data");
  }

  // Step 7: save the response to the cache, if the caller asked us to,
  // then return the data.
  if (opts?.cacheTtlMs !== undefined) {
    const ttl = typeof opts.cacheTtlMs === "function" ? opts.cacheTtlMs(json.data) : opts.cacheTtlMs;
    responseCache.set(cacheKey, json.data, ttl);
  }

  return json.data;
}

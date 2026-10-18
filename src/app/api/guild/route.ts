/**
 * This is ROUTING: this file defines what happens when the app requests
 * the URL /api/guild?name=...&server=...&region=.... It's a JSON API
 * endpoint - it sends back data, not a page a person looks at directly.
 *
 * It does the same work as guild/[region]/[server]/[name]/page.tsx (the
 * actual guild page), just returning JSON instead of HTML. This exists so
 * the same data can be re-fetched from the browser later (e.g. a future
 * "refresh" button) without duplicating the logic.
 *
 * It uses query params (?name=...) instead of a dynamic route segment like
 * [code], since this is a flat GET endpoint rather than a page URL.
 */
import { NextResponse } from "next/server";
import { handleWclError } from "@/app/api/_lib/errors";
import { buildGuildTrend } from "@/lib/wcl/service";

// Tells Next.js never to cache this route's own response - lib/cache.ts
// already handles caching, so we don't want two caches disagreeing.
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const name = searchParams.get("name");
  const serverSlug = searchParams.get("server");
  const serverRegion = searchParams.get("region");
  // Mirrors the guild page's own "Mythic only" toggle (?mythic=1).
  const mythicOnly = searchParams.get("mythic") === "1";
  // Mirrors the guild page's own sample-size controls (?nights=<a number>,
  // or the literal ?nights=tier for the "This tier" option). buildGuildTrend
  // clamps a number itself, so an invalid or missing value just falls back
  // to its default.
  const nightsParam = searchParams.get("nights");
  const sampleMode = nightsParam === "tier" ? "currentTier" : undefined;
  const nights = nightsParam && nightsParam !== "tier" ? Number(nightsParam) : undefined;

  // Unlike a dynamic route segment like [code], query params aren't
  // guaranteed to be present, so we have to check for them ourselves
  // before calling buildGuildTrend.
  if (!name || !serverSlug || !serverRegion) {
    return NextResponse.json(
      { error: "Missing required query params: name, server, region" },
      { status: 400 }
    );
  }

  try {
    const result = await buildGuildTrend(name, serverSlug, serverRegion, { mythicOnly, nights, sampleMode });
    return NextResponse.json(result);
  } catch (err) {
    return handleWclError(err);
  }
}

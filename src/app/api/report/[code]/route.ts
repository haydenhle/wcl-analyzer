/**
 * This is ROUTING: this file defines what happens when someone requests a
 * URL like /api/report/AbCdEfGh. The [code] in the folder name is a
 * Next.js dynamic route segment - it matches anything in that spot in the
 * URL and hands it to us as `params.code`.
 *
 * This is a JSON API endpoint, not a page - it returns the same data as
 * report/[code]/page.tsx (the actual report page), just as JSON instead
 * of HTML. This exists so the data can be re-fetched from the browser
 * later (e.g. a future "refresh" button) without duplicating the logic.
 */
import { NextResponse } from "next/server";
import { handleWclError } from "@/app/api/_lib/errors";
import { buildReportAnalysis } from "@/lib/wcl/service";

// Tells Next.js never to cache this route's own response - lib/cache.ts
// already handles caching, so we don't want two caches disagreeing.
export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ code: string }> }) {
  try {
    // The report code comes straight from the URL (the [code] part).
    const { code } = await params;
    // ?scope= narrows the report to a subset of fights (one boss, one
    // pull, etc.), same as the scope selector on the report page. No
    // scope in the URL means "show everything".
    const scope = new URL(req.url).searchParams.get("scope") ?? undefined;
    const analysis = await buildReportAnalysis(code, { scope });
    return NextResponse.json(analysis);
  } catch (err) {
    return handleWclError(err);
  }
}

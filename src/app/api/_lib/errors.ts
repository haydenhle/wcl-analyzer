import { NextResponse } from "next/server";
import { WCLApiError } from "@/lib/wcl/types";

/**
 * This file does one job: turn an error into a JSON error response, shared
 * by the API routes below. The folder name starts with `_` so Next.js
 * treats it as a plain helper folder, not a route of its own.
 */
export function handleWclError(err: unknown) {
  // A known, expected failure (bad report code, guild not found, rate
  // limit hit) -- show its message to the user, and reuse the HTTP status
  // Warcraft Logs gave us if we have one (e.g. 429 for "too many requests").
  if (err instanceof WCLApiError) {
    return NextResponse.json({ error: err.message }, { status: err.status ?? 500 });
  }
  // Anything else is an unexpected bug or network problem. Log the full
  // error on the server so it can be debugged, but don't show the details
  // to the user.
  console.error(err);
  return NextResponse.json({ error: "Unexpected server error" }, { status: 500 });
}

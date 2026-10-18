/**
 * Sample-size controls on the guild page: a number box for "analyze my last
 * N raid nights", plus a "This tier" button for "analyze every night from
 * my current raid tier, whatever that count is." Same URL-driven pattern as
 * MythicOnlyToggle -- neither one fetches anything itself, they just change
 * the page's `?nights=` query param, which makes the guild page re-run on
 * the server with a different sample.
 *
 * `?nights=` holds either a plain number ("16") or the literal word "tier".
 * Reusing one param (instead of two) means MythicOnlyToggle's existing
 * "merge into whatever's already in the URL" logic doesn't need to know
 * anything new.
 *
 * A free typed number replaced an earlier version of this that only offered
 * 3 fixed choices (8/16/24) -- too coarse for someone who actually wants,
 * say, 5 or 30. MAX_NIGHTS must match service.ts's MAX_NIGHTS_FOR_TREND --
 * this is just what the box will let you type; the real ceiling (and the
 * "This tier" cap) is enforced server-side either way.
 */
"use client";

import { useEffect, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

const DEFAULT_NIGHTS = 8;
const MAX_NIGHTS = 40;

export function NightsSampleSelector({ nights }: { nights: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const isTierMode = nights === "tier";

  // The number box's own typed-but-not-yet-submitted value. Only synced
  // FROM the URL when we're in plain-count mode -- while "This tier" is
  // active there's no specific count to show, so we just leave whatever
  // was last typed here (switching back to a number, by typing one, is
  // still how you get out of tier mode).
  const [draft, setDraft] = useState(isTierMode ? String(DEFAULT_NIGHTS) : nights);
  useEffect(() => {
    if (!isTierMode) setDraft(nights);
  }, [nights, isTierMode]);

  function pushNights(value: string) {
    const params = new URLSearchParams(searchParams.toString());
    if (value === String(DEFAULT_NIGHTS)) {
      // The default doesn't need to clutter the URL.
      params.delete("nights");
    } else {
      params.set("nights", value);
    }
    const query = params.toString();
    router.push(query ? `${pathname}?${query}` : pathname);
  }

  function commitDraft() {
    const parsed = Number(draft);
    if (!Number.isFinite(parsed)) {
      setDraft(isTierMode ? String(DEFAULT_NIGHTS) : nights); // reject junk input, reset it
      return;
    }
    const clamped = Math.min(Math.max(Math.trunc(parsed), 1), MAX_NIGHTS);
    setDraft(String(clamped));
    pushNights(String(clamped));
  }

  return (
    <div className="flex items-center gap-2">
      <label className="flex items-center gap-2 text-sm text-ink-secondary">
        Nights
        <input
          type="number"
          min={1}
          max={MAX_NIGHTS}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitDraft}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitDraft();
          }}
          className="w-16 rounded-lg border border-surface-border bg-surface px-2 py-2 text-sm text-ink-primary focus:border-sky-500 focus:outline-none"
        />
      </label>
      <button
        type="button"
        onClick={() => pushNights("tier")}
        aria-pressed={isTierMode}
        className={
          isTierMode
            ? "rounded-lg border border-sky-500 bg-sky-500 px-3 py-2 text-sm font-medium text-white"
            : "rounded-lg border border-surface-border bg-surface px-3 py-2 text-sm text-ink-primary hover:border-sky-500"
        }
      >
        This tier
      </button>
    </div>
  );
}

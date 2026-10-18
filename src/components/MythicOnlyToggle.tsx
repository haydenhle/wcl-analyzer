/**
 * A single toggle button on the guild page: "all difficulties" vs "Mythic
 * only". Same pattern as FightScopeSelector on the report page -- clicking
 * it doesn't fetch anything itself, it just changes the page's URL (adding
 * or removing `?mythic=1`), which makes the guild page re-run on the
 * server, scoped to just Mythic pulls. A button instead of a dropdown here
 * since there are only two states, not several.
 */
"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";

export function MythicOnlyToggle({ mythicOnly }: { mythicOnly: boolean }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  function toggle() {
    // Start from the CURRENT query string, not a fresh one -- this page
    // also has a nights-sample-size selector (?nights=...), and we don't
    // want clicking this button to silently erase that other filter.
    const params = new URLSearchParams(searchParams.toString());
    if (mythicOnly) {
      params.delete("mythic");
    } else {
      params.set("mythic", "1");
    }
    const query = params.toString();
    router.push(query ? `${pathname}?${query}` : pathname);
  }

  return (
    <button
      type="button"
      onClick={toggle}
      aria-pressed={mythicOnly}
      className={
        mythicOnly
          ? "rounded-lg border border-sky-500 bg-sky-500 px-3 py-2 text-sm font-medium text-white"
          : "rounded-lg border border-surface-border bg-surface px-3 py-2 text-sm text-ink-primary hover:border-sky-500"
      }
    >
      Mythic only
    </button>
  );
}

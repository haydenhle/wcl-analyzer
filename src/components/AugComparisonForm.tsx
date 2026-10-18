/**
 * The controls at the top of the Compare tab: who "you" are (if the pull
 * has more than one Augmentation Evoker), an empty box for pasting any
 * other Aug's Warcraft Logs link, and quick buttons that compare instantly
 * against the top-ranked Aug log or another Aug in the same raid.
 *
 * Nothing is compared until one of those is picked -- the analysis is the
 * most expensive thing this app fetches, so the tab doesn't run it just for
 * being opened.
 *
 * Same URL-param pattern as every other control on the report page: this
 * doesn't fetch anything itself, it MERGES its params into the current
 * query string (so `?scope=` and `?tab=` survive) and the server-rendered
 * page does the rest:
 *   analyze=<name>            who "you" are
 *   vs=top                    vs. the top-ranked Aug log
 *   vs=log&vsName=<name>      vs. another Aug in this same pull
 *   vs=link&compare=<url>[&compareName=<name>]   vs. a pasted log
 */
"use client";

import { useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

export type AugCompareMode = "top" | "log" | "link";

export function AugComparisonForm({
  augs,
  me,
  mode,
  vsName,
}: {
  augs: string[];
  me: string | null;
  mode: AugCompareMode | null;
  vsName: string | null;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [link, setLink] = useState(mode === "link" ? (searchParams.get("compare") ?? "") : "");
  const [name, setName] = useState(mode === "link" ? (searchParams.get("compareName") ?? "") : "");

  function go(changes: Record<string, string | null>) {
    const params = new URLSearchParams(searchParams.toString());
    for (const [key, value] of Object.entries(changes)) {
      if (value) params.set(key, value);
      else params.delete(key);
    }
    params.set("tab", "compare");
    router.push(`${pathname}?${params.toString()}`);
  }

  const clearComparison = { vs: null, vsName: null, compare: null, compareName: null };
  const others = augs.filter((a) => a !== me);

  const inputClass =
    "rounded-lg border border-surface-border bg-surface px-3 py-2 text-sm text-ink-primary placeholder:text-ink-muted focus:border-sky-500 focus:outline-none";
  const quickClass = (active: boolean) =>
    active
      ? "rounded-lg border border-sky-500 bg-sky-500 px-3 py-1.5 text-sm font-medium text-white"
      : "rounded-lg border border-surface-border bg-surface px-3 py-1.5 text-sm text-ink-primary hover:border-sky-500";

  return (
    <div className="card space-y-4">
      {augs.length > 1 ? (
        <label className="flex flex-wrap items-center gap-2 text-sm">
          <span className="label">You</span>
          <select
            value={me ?? ""}
            onChange={(e) => {
              const next = e.target.value;
              // Comparing yourself against yourself isn't a comparison --
              // drop an in-raid opponent that just became "you".
              go({ analyze: next, ...(mode === "log" && vsName === next ? clearComparison : {}) });
            }}
            className={inputClass}
          >
            {augs.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        </label>
      ) : null}

      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (!link.trim()) return;
          go({ ...clearComparison, vs: "link", compare: link.trim(), compareName: name.trim() || null });
        }}
      >
        <label className="flex min-w-[16rem] flex-1 flex-col gap-1">
          <span className="label">Compare against another Aug&apos;s pull</span>
          <input
            value={link}
            onChange={(e) => setLink(e.target.value)}
            placeholder="Paste a Warcraft Logs link to the pull, e.g. .../reports/AbCd...#fight=5"
            className={inputClass}
          />
        </label>
        <label className="flex w-40 flex-col gap-1">
          <span className="label">Their name (optional)</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Auto-detect" className={inputClass} />
        </label>
        <button
          type="submit"
          className="rounded-lg border border-sky-500 bg-sky-500 px-3 py-2 text-sm font-medium text-white hover:bg-sky-400"
        >
          Compare
        </button>
      </form>

      <div className="flex flex-wrap items-center gap-2">
        <span className="label">Quick compare</span>
        <button type="button" className={quickClass(mode === "top")} onClick={() => go({ ...clearComparison, vs: "top" })}>
          vs. #1 ranked Aug
        </button>
        {others.map((other) => (
          <button
            key={other}
            type="button"
            className={quickClass(mode === "log" && vsName === other)}
            onClick={() => go({ ...clearComparison, vs: "log", vsName: other })}
          >
            vs. {other} (your raid)
          </button>
        ))}
        {mode ? (
          <button
            type="button"
            className="ml-auto text-sm text-ink-muted hover:text-ink-secondary"
            onClick={() => {
              setLink("");
              setName("");
              go(clearComparison);
            }}
          >
            Clear comparison
          </button>
        ) : null}
      </div>
    </div>
  );
}

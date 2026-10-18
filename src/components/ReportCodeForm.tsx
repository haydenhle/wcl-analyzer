/**
 * The "search by report" form on the homepage. A reusable COMPONENT.
 *
 * Data flow: the user pastes either a full Warcraft Logs URL or just a
 * report code. On submit, `parseReportCode` pulls the code out of whatever
 * they typed, then this form sends the browser to "/report/[code]". The
 * report page itself does the actual fetching once it loads -- this form
 * never calls the Warcraft Logs API.
 */
// "use client" means this component runs in the browser (not on the
// server) so it can respond to typing and clicking, unlike most of this
// app which renders on the server before the page is sent to you.
"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { parseReportCode } from "@/lib/wcl/parseInput";

export function ReportCodeForm() {
  const router = useRouter();
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const code = parseReportCode(value);
    if (!code) {
      setError("Paste a Warcraft Logs report URL or a report code.");
      return;
    }
    setError(null);
    router.push(`/report/${code}`);
  }

  return (
    <form onSubmit={onSubmit} className="card space-y-3">
      <div>
        <h2 className="text-sm font-semibold text-ink-primary">Analyze a single log</h2>
        <p className="mt-1 text-sm text-ink-muted">
          Paste a report URL (e.g. warcraftlogs.com/reports/AbCdEfGh) or just the code.
        </p>
      </div>
      <input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="https://www.warcraftlogs.com/reports/..."
        className="w-full rounded-lg border border-surface-border bg-surface px-3 py-2 text-sm text-ink-primary placeholder:text-ink-muted focus:border-sky-500 focus:outline-none"
      />
      {error ? <p className="text-xs text-red-400">{error}</p> : null}
      <button
        type="submit"
        className="w-full rounded-lg bg-sky-500 px-3 py-2 text-sm font-medium text-white transition hover:bg-sky-400"
      >
        Analyze report
      </button>
    </form>
  );
}

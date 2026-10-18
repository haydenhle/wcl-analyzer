/**
 * The "search by guild" form on the homepage. A reusable COMPONENT.
 *
 * Data flow: the user types a guild name, realm, and picks a region. On
 * submit, this form checks the fields aren't empty, then sends the browser
 * to a new URL like "/guild/us/area-52/My%20Guild". That URL is the guild
 * page, which does the actual data fetching once it loads -- this form
 * never talks to the Warcraft Logs API itself.
 */
// "use client" means this component runs in the browser (not on the
// server) so it can respond to typing and clicking, unlike most of this
// app which renders on the server before the page is sent to you.
"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { slugifyServerName } from "@/lib/format";

const REGIONS = ["us", "eu", "kr", "tw", "cn"];

export function GuildSearchForm() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [server, setServer] = useState("");
  const [region, setRegion] = useState("us");
  const [error, setError] = useState<string | null>(null);

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || !server.trim()) {
      setError("Enter both a guild name and a realm.");
      return;
    }
    setError(null);
    // The realm name has to look like "area-52" (lowercase, dashes) to fit
    // in a URL, so it gets slugified. The guild name just gets URL-encoded
    // as-is, and the guild page decodes it back to normal text later.
    const serverSlug = slugifyServerName(server);
    router.push(`/guild/${region}/${serverSlug}/${encodeURIComponent(name.trim())}`);
  }

  return (
    <form onSubmit={onSubmit} className="card space-y-3">
      <div>
        <h2 className="text-sm font-semibold text-ink-primary">Analyze a guild&apos;s trend</h2>
        <p className="mt-1 text-sm text-ink-muted">
          Pulls the guild&apos;s recent raid nights and looks for patterns across them.
        </p>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Guild name"
          className="col-span-2 rounded-lg border border-surface-border bg-surface px-3 py-2 text-sm text-ink-primary placeholder:text-ink-muted focus:border-sky-500 focus:outline-none"
        />
        <input
          value={server}
          onChange={(e) => setServer(e.target.value)}
          placeholder="Realm (e.g. Area 52)"
          className="rounded-lg border border-surface-border bg-surface px-3 py-2 text-sm text-ink-primary placeholder:text-ink-muted focus:border-sky-500 focus:outline-none"
        />
        <select
          value={region}
          onChange={(e) => setRegion(e.target.value)}
          className="rounded-lg border border-surface-border bg-surface px-3 py-2 text-sm text-ink-primary focus:border-sky-500 focus:outline-none"
        >
          {REGIONS.map((r) => (
            <option key={r} value={r}>
              {r.toUpperCase()}
            </option>
          ))}
        </select>
      </div>
      {error ? <p className="text-xs text-red-400">{error}</p> : null}
      <button
        type="submit"
        className="w-full rounded-lg bg-sky-500 px-3 py-2 text-sm font-medium text-white transition hover:bg-sky-400"
      >
        Analyze guild
      </button>
    </form>
  );
}

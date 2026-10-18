/**
 * This is the homepage, shown at "/". It's just two search forms side by
 * side: one to look up a single report, one to look up a guild.
 *
 * This file itself doesn't fetch any data or handle any clicks -- it's a
 * Server Component (renders on the server, before your browser sees it),
 * so it just lays out the two form components. Each form handles its own
 * typing and validation, then sends the browser to a new URL.
 */
import { GuildSearchForm } from "@/components/GuildSearchForm";
import { ReportCodeForm } from "@/components/ReportCodeForm";

export default function HomePage() {
  return (
    <div>
      <div className="mb-10">
        <h1 className="text-3xl font-semibold tracking-tight text-ink-primary">
          Find the patterns in your raid logs.
        </h1>
        <p className="mt-3 max-w-2xl text-ink-secondary">
          WCL Analyzer pulls damage, healing, and death data straight from Warcraft Logs and
          surfaces what a raw parse doesn&apos;t show you: who&apos;s carrying the raid, what&apos;s
          killing people, and how a guild trends across raid nights.
        </p>
      </div>
      <div className="grid gap-6 md:grid-cols-2">
        <ReportCodeForm />
        <GuildSearchForm />
      </div>
    </div>
  );
}

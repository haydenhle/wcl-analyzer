/**
 * This file wraps EVERY page in the app. Next.js runs it once and puts
 * whichever page.tsx matches the current URL inside it as `{children}`.
 *
 * It's not a page you visit directly -- think of it as the outer frame:
 * the <html>/<body> tags, the header with the logo/link, and the footer.
 * It also sets the page title and loads the global CSS file.
 */
import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "WCL Analyzer",
  description:
    "Analyze Warcraft Logs reports and guild history for damage, healing, and death patterns.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className="dark">
      <body>
        <div className="mx-auto flex min-h-screen max-w-6xl flex-col px-6 py-8">
          <header className="mb-10 flex items-center justify-between">
            <a href="/" className="flex items-center gap-2">
              <span className="text-lg font-semibold tracking-tight">
                WCL <span className="text-sky-400">Analyzer</span>
              </span>
            </a>
            <a
              href="https://www.warcraftlogs.com"
              target="_blank"
              rel="noreferrer"
              className="label hover:text-ink-secondary"
            >
              Data from Warcraft Logs
            </a>
          </header>
          <main className="flex-1">{children}</main>
          <footer className="mt-16 border-t border-surface-border pt-6 text-xs text-ink-muted">
            Not affiliated with Warcraft Logs. Combat log data © their respective owners.
          </footer>
        </div>
      </body>
    </html>
  );
}

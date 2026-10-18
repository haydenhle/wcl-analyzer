/**
 * A reusable COMPONENT: a small "something went wrong" message box.
 *
 * Shown by the report page and the guild page when loading data fails
 * (bad code, report/guild not found, etc). The `message` text is passed
 * in as a prop -- this component just displays it in a styled box instead
 * of the app crashing to a blank error screen.
 */
export function ErrorState({ message }: { message: string }) {
  return (
    <div className="card border-red-900/40 bg-red-950/20">
      <div className="label text-red-400">Something went wrong</div>
      <p className="mt-2 text-sm text-ink-secondary">{message}</p>
    </div>
  );
}

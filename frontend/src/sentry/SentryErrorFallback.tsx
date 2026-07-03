/** Last-resort screen for Sentry.ErrorBoundary: the render tree crashed and the error is
 *  already reported — offer a reload instead of a white page. Kept dependency-free (no
 *  ui/ components) so a fault in those modules can't take the fallback down with it. */
export function SentryErrorFallback() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-3 bg-background p-8 text-center text-foreground">
      <h1 className="text-lg font-semibold">Something went wrong</h1>
      <p className="max-w-sm text-sm opacity-70">
        The crash has been reported. Reload to get back to the arena.
      </p>
      <button
        type="button"
        onClick={() => window.location.reload()}
        className="mt-2 rounded-md border px-4 py-2 text-sm font-medium hover:opacity-80"
      >
        Reload
      </button>
    </div>
  );
}

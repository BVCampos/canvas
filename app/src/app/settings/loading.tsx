export default function SettingsLoading() {
  return (
    <main className="mx-auto max-w-3xl px-4 sm:px-6 py-8 space-y-6">
      {/* Tab row (Workspace / Members / MCP) */}
      <div className="flex items-center gap-4 border-b border-border pb-3">
        <div className="h-5 w-20 animate-pulse rounded-[6px] bg-muted" />
        <div className="h-5 w-20 animate-pulse rounded-[6px] bg-muted" />
        <div className="h-5 w-16 animate-pulse rounded-[6px] bg-muted" />
      </div>

      <div className="space-y-2">
        <div className="h-7 w-40 animate-pulse rounded-[6px] bg-muted" />
        <div className="h-4 w-72 animate-pulse rounded-[6px] bg-muted" />
      </div>

      <div className="rounded-[12px] border border-border bg-card p-6 space-y-4">
        <div className="h-4 w-28 animate-pulse rounded-[6px] bg-muted" />
        <div className="h-10 w-full animate-pulse rounded-[8px] bg-muted" />
        <div className="h-10 w-full animate-pulse rounded-[8px] bg-muted" />
      </div>
    </main>
  );
}

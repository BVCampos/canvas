export default function CanvasesLoading() {
  return (
    <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6 space-y-6">
      {/* Mirror the real page header: stacked on mobile, row at sm+. */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-2">
          <div className="h-7 w-28 animate-pulse rounded-[6px] bg-muted" />
          <div className="h-4 w-64 max-w-full animate-pulse rounded-[6px] bg-muted" />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="h-9 w-28 animate-pulse rounded-[8px] bg-muted" />
          <div className="h-9 w-24 animate-pulse rounded-[8px] bg-muted" />
        </div>
      </div>

      <ul className="divide-y divide-border overflow-hidden rounded-[12px] border border-border bg-card">
        {Array.from({ length: 4 }).map((_, i) => (
          <li
            key={i}
            className="flex items-center justify-between gap-6 px-4 py-4 sm:px-5"
          >
            <div className="min-w-0 flex-1 space-y-2">
              <div className="h-4 w-1/3 animate-pulse rounded-[6px] bg-muted" />
              <div className="h-3 w-24 animate-pulse rounded-[6px] bg-muted" />
            </div>
            <div className="h-3 w-12 animate-pulse rounded-[6px] bg-muted" />
          </li>
        ))}
      </ul>
    </main>
  );
}

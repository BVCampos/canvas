export default function DeckLoading() {
  return (
    <div className="flex h-[calc(100dvh-56px)] w-full">
      <aside className="flex w-64 shrink-0 flex-col border-r border-border bg-card">
        <div className="border-b border-border px-4 py-3 space-y-2">
          <div className="h-3 w-10 animate-pulse rounded-[4px] bg-muted" />
          <div className="h-4 w-40 animate-pulse rounded-[6px] bg-muted" />
          <div className="h-3 w-24 animate-pulse rounded-[4px] bg-muted" />
        </div>
        <ul className="min-h-0 flex-1 overflow-hidden py-2">
          {Array.from({ length: 10 }).map((_, i) => (
            <li
              key={i}
              className="flex items-center gap-2 px-3 py-2"
            >
              <span className="w-6 text-right">
                <span className="ml-auto inline-block h-3 w-3 animate-pulse rounded-[3px] bg-muted" />
              </span>
              <span className="h-4 flex-1 animate-pulse rounded-[6px] bg-muted" />
            </li>
          ))}
        </ul>
      </aside>

      <section className="relative flex flex-1 flex-col bg-fog">
        <div className="flex items-center justify-between gap-3 border-b border-border bg-card px-4 py-2">
          <div className="space-y-2">
            <div className="h-3 w-16 animate-pulse rounded-[4px] bg-muted" />
            <div className="h-4 w-48 animate-pulse rounded-[6px] bg-muted" />
          </div>
          <div className="h-8 w-32 animate-pulse rounded-[8px] bg-muted" />
        </div>
        <div className="relative flex-1 p-6">
          <div className="h-full w-full animate-pulse rounded-[12px] bg-muted" />
        </div>
      </section>

      <aside className="flex w-80 shrink-0 flex-col border-l border-border bg-card">
        <div className="border-b border-border px-5 py-4 space-y-3">
          <div className="h-3 w-20 animate-pulse rounded-[4px] bg-muted" />
          {Array.from({ length: 3 }).map((_, i) => (
            <div
              key={i}
              className="space-y-2 rounded-[8px] border border-border bg-card p-3"
            >
              <div className="h-3 w-24 animate-pulse rounded-[4px] bg-muted" />
              <div className="h-4 w-full animate-pulse rounded-[6px] bg-muted" />
              <div className="h-3 w-2/3 animate-pulse rounded-[4px] bg-muted" />
            </div>
          ))}
        </div>
        <div className="px-5 py-4 space-y-3">
          <div className="h-3 w-20 animate-pulse rounded-[4px] bg-muted" />
          {Array.from({ length: 2 }).map((_, i) => (
            <div
              key={i}
              className="space-y-2 rounded-[8px] border border-border bg-card p-3"
            >
              <div className="h-3 w-28 animate-pulse rounded-[4px] bg-muted" />
              <div className="h-4 w-full animate-pulse rounded-[6px] bg-muted" />
            </div>
          ))}
        </div>
      </aside>
    </div>
  );
}

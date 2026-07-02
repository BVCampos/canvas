export default function InboxLoading() {
  return (
    <main className="mx-auto max-w-5xl space-y-8 px-4 py-8 sm:px-6">
      <div className="space-y-2">
        <div className="h-7 w-32 animate-pulse rounded-[6px] bg-muted" />
        <div className="h-4 w-96 max-w-full animate-pulse rounded-[6px] bg-muted" />
      </div>

      {(["To review", "My proposals"] as const).map((label) => (
        <section key={label} className="space-y-3">
          <div className="flex items-baseline justify-between">
            <div className="h-3 w-24 animate-pulse rounded-[4px] bg-muted" />
            <div className="h-3 w-16 animate-pulse rounded-[4px] bg-muted" />
          </div>
          <ul className="divide-y divide-border overflow-hidden rounded-[12px] border border-border bg-card">
            {Array.from({ length: 3 }).map((_, i) => (
              <li
                key={i}
                className="flex items-center justify-between gap-4 px-4 py-4 sm:px-5"
              >
                <div className="min-w-0 flex-1 space-y-2">
                  <div className="h-4 w-1/2 animate-pulse rounded-[6px] bg-muted" />
                  <div className="h-3 w-1/3 animate-pulse rounded-[6px] bg-muted" />
                </div>
                <div className="flex items-center gap-2">
                  <div className="h-5 w-16 animate-pulse rounded-full bg-muted" />
                  <div className="h-3 w-12 animate-pulse rounded-[6px] bg-muted" />
                </div>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </main>
  );
}

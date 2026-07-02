// Bounded-concurrency fan-out. Runs `worker` over every item with at most
// `limit` in flight at once. Use it instead of an `await` loop (serial, slow on
// N independent round-trips) or an unbounded `Promise.all` (opens N connections
// at once and can hammer the upstream).
//
// Semantics that callers rely on:
//   - The worker is invoked for every item exactly once (order of START is the
//     input order; order of COMPLETION is not guaranteed). Side effects keyed by
//     a stable id (e.g. a Map.set(asset.id, ...)) are therefore deterministic.
//   - Resolves once ALL workers settle. A `limit` <= 0 is treated as 1.
//   - It does NOT swallow errors: a throwing worker rejects the whole call, same
//     as `Promise.all`. Callers that want one bad item to degrade gracefully
//     keep their own per-item try/catch (the asset-download loop does this).
export async function mapWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  const bound = Math.max(1, Math.floor(limit));
  if (items.length === 0) return;

  let cursor = 0;
  // Each runner pulls the next index off the shared cursor until the list is
  // exhausted, so a slow item never blocks a free slot from picking up work.
  async function runner(): Promise<void> {
    while (cursor < items.length) {
      const index = cursor++;
      await worker(items[index], index);
    }
  }

  const runners = Array.from(
    { length: Math.min(bound, items.length) },
    () => runner(),
  );
  await Promise.all(runners);
}

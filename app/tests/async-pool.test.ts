// Unit test for mapWithConcurrency (src/lib/async/pool.ts) — the bounded-pool
// helper the deck export uses to download assets concurrently instead of in a
// serial loop. The export refactor relies on three guarantees this proves:
//   1. every item is processed exactly once (so the dataUrlByAssetId map is
//      identical to the old sequential one),
//   2. no more than `limit` workers run at once (so we don't flood Storage),
//   3. the call resolves only after ALL workers settle.

import { describe, expect, it } from "vitest";
import { mapWithConcurrency } from "../src/lib/async/pool";

describe("mapWithConcurrency", () => {
  it("runs every item exactly once", async () => {
    const items = Array.from({ length: 23 }, (_, i) => i);
    const seen: number[] = [];
    await mapWithConcurrency(items, 5, async (n) => {
      seen.push(n);
    });
    // Same multiset, regardless of completion order.
    expect([...seen].sort((a, b) => a - b)).toEqual(items);
  });

  it("never exceeds the concurrency limit in flight", async () => {
    const items = Array.from({ length: 30 }, (_, i) => i);
    let inFlight = 0;
    let peak = 0;
    await mapWithConcurrency(items, 4, async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      // Yield so multiple workers genuinely overlap before any resolves.
      await new Promise((r) => setTimeout(r, 1));
      inFlight--;
    });
    expect(peak).toBeLessThanOrEqual(4);
    // With 30 items and limit 4, the pool should actually saturate.
    expect(peak).toBe(4);
  });

  it("resolves only after all workers complete", async () => {
    const items = [1, 2, 3, 4, 5, 6];
    let completed = 0;
    await mapWithConcurrency(items, 2, async () => {
      await new Promise((r) => setTimeout(r, 1));
      completed++;
    });
    expect(completed).toBe(items.length);
  });

  it("is a no-op for an empty list and never invokes the worker", async () => {
    let calls = 0;
    await mapWithConcurrency([], 5, async () => {
      calls++;
    });
    expect(calls).toBe(0);
  });

  it("treats a limit <= 0 as serial (1 in flight)", async () => {
    const items = [1, 2, 3, 4];
    let inFlight = 0;
    let peak = 0;
    await mapWithConcurrency(items, 0, async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight--;
    });
    expect(peak).toBe(1);
  });

  it("caps active workers at the item count when limit exceeds it", async () => {
    const items = [1, 2];
    let inFlight = 0;
    let peak = 0;
    await mapWithConcurrency(items, 10, async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight--;
    });
    expect(peak).toBe(2);
  });

  it("rejects if a worker throws (does not swallow errors)", async () => {
    await expect(
      mapWithConcurrency([1, 2, 3], 2, async (n) => {
        if (n === 2) throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
  });
});

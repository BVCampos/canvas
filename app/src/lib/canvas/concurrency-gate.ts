// A tiny in-process concurrency gate for bounding how many memory-heavy
// operations run AT ONCE in a single Node process. The PDF export launches a
// headless Chromium and holds every slide screenshot (3840×2160 JPEGs) in an
// array; two or three of those concurrently on the single small box is the exact
// spike that OOM-killed it before. The gate caps concurrency so the box can't
// fall over.
//
// Two ways to handle the overflow — a caller that can't get a slot picks one:
//
//   run()        — NON-blocking. tryAcquire returns false, the caller surfaces a
//                  429 immediately ("export busy, retry"). Right for a heavy,
//                  user-initiated, one-at-a-time job (PDF/PPTX export) where a
//                  caller piling up awaiting requests is worse than a fast no.
//
//   runOrWait()  — BLOCKING with a bound. If no slot is free the caller WAITS in
//                  a FIFO queue until a slot frees or maxWaitMs elapses (or the
//                  queue is already maxQueue deep), then 429s only as a last
//                  resort. Right for a burst of small renders that all want to
//                  happen at once (a deck list firing every thumbnail on mount):
//                  queueing lets them complete in order at the SAME peak
//                  concurrency — a waiter holds no Chromium (the dominant cost),
//                  only its already-loaded inputs and a promise — so peak memory
//                  is essentially unchanged versus instant-reject while turning a
//                  wall of 429s into a brief wait. The cap keeps the queue from
//                  growing without bound.
export class ConcurrencyGate {
  private active = 0;
  // FIFO waiters parked by runOrWait, oldest first. Each carries the timer that
  // fires its maxWaitMs timeout so release() can hand a freed slot to the head
  // and cancel its timeout in one step.
  private readonly waiters: Array<{ wake: () => void; timer: ReturnType<typeof setTimeout> }> = [];

  constructor(private readonly max: number) {
    if (!Number.isInteger(max) || max < 1) {
      throw new Error(`ConcurrencyGate: max must be a positive integer, got ${max}`);
    }
  }

  // Returns true and reserves a slot if one is free; false if at capacity.
  tryAcquire(): boolean {
    if (this.active >= this.max) return false;
    this.active += 1;
    return true;
  }

  // Free a slot. If anyone is waiting (runOrWait), hand the just-freed slot
  // directly to the longest-waiting caller instead of dropping the count — so the
  // slot is never momentarily free for a fresh request to jump the queue, and
  // `active` stays pinned at capacity while work remains. Idempotently floored at
  // 0 so a double-release can't drive the count negative and silently raise the
  // ceiling.
  release(): void {
    const next = this.waiters.shift();
    if (next) {
      next.wake(); // transfers this slot to the waiter; active unchanged
      return;
    }
    if (this.active > 0) this.active -= 1;
  }

  get inUse(): number {
    return this.active;
  }

  // Number of callers parked in the wait queue (runOrWait). 0 for a gate only
  // ever driven by run()/tryAcquire().
  get queued(): number {
    return this.waiters.length;
  }

  // Run fn under a slot, releasing even if it throws. Returns {ok:false} if the
  // gate is saturated — NON-blocking (caller decides how to surface that, e.g. a
  // 429). Never waits.
  async run<T>(fn: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false }> {
    if (!this.tryAcquire()) return { ok: false };
    try {
      return { ok: true, value: await fn() };
    } finally {
      this.release();
    }
  }

  // Acquire a slot, waiting up to maxWaitMs in a bounded FIFO queue if none is
  // free. Resolves true once a slot is held, or false if the wait times out or
  // the queue is already maxQueue deep (caller surfaces a 429). A timed-out or
  // never-queued caller never holds a slot, so the count stays honest.
  private acquireOrWait(maxWaitMs: number, maxQueue: number): Promise<boolean> {
    if (this.tryAcquire()) return Promise.resolve(true);
    if (maxWaitMs <= 0 || this.waiters.length >= maxQueue) {
      return Promise.resolve(false);
    }
    return new Promise<boolean>((resolve) => {
      const entry = {
        wake: () => {
          clearTimeout(entry.timer);
          // release() already removed us from the queue via shift(); the slot it
          // freed is now ours (active was not decremented). Just resolve.
          resolve(true);
        },
        timer: setTimeout(() => {
          const i = this.waiters.indexOf(entry);
          if (i >= 0) this.waiters.splice(i, 1);
          resolve(false);
        }, maxWaitMs),
      };
      this.waiters.push(entry);
    });
  }

  // run(), but BLOCKING with a bound: wait for a slot (up to opts.maxWaitMs, queue
  // capped at opts.maxQueue) before giving up. Returns {ok:false} only if the wait
  // times out or the queue is full; releases the slot even if fn throws.
  async runOrWait<T>(
    fn: () => Promise<T>,
    opts: { maxWaitMs: number; maxQueue: number },
  ): Promise<{ ok: true; value: T } | { ok: false }> {
    if (!(await this.acquireOrWait(opts.maxWaitMs, opts.maxQueue))) {
      return { ok: false };
    }
    try {
      return { ok: true, value: await fn() };
    } finally {
      this.release();
    }
  }
}

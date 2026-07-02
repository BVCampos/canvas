import { describe, expect, it, vi } from "vitest";
import { ConcurrencyGate } from "../src/lib/canvas/concurrency-gate";

// Let queued microtasks (a runOrWait reaching the wait queue) settle.
const tick = () => Promise.resolve();

describe("ConcurrencyGate", () => {
  it("admits up to max, then refuses", () => {
    const gate = new ConcurrencyGate(2);
    expect(gate.tryAcquire()).toBe(true);
    expect(gate.tryAcquire()).toBe(true);
    expect(gate.tryAcquire()).toBe(false); // saturated
    expect(gate.inUse).toBe(2);
  });

  it("frees slots on release", () => {
    const gate = new ConcurrencyGate(1);
    expect(gate.tryAcquire()).toBe(true);
    expect(gate.tryAcquire()).toBe(false);
    gate.release();
    expect(gate.tryAcquire()).toBe(true);
  });

  it("floors at zero so a double-release can't raise the ceiling", () => {
    const gate = new ConcurrencyGate(1);
    gate.tryAcquire();
    gate.release();
    gate.release(); // extra release must not drive inUse negative
    expect(gate.inUse).toBe(0);
    expect(gate.tryAcquire()).toBe(true);
    expect(gate.tryAcquire()).toBe(false); // still capacity 1, not 2
  });

  it("run() releases the slot even when fn throws", async () => {
    const gate = new ConcurrencyGate(1);
    await expect(
      gate.run(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(gate.inUse).toBe(0);
  });

  it("run() returns {ok:false} when saturated and never calls fn", async () => {
    const gate = new ConcurrencyGate(1);
    expect(gate.tryAcquire()).toBe(true); // occupy the only slot
    let called = false;
    const result = await gate.run(async () => {
      called = true;
      return 1;
    });
    expect(result).toEqual({ ok: false });
    expect(called).toBe(false);
  });

  it("rejects a non-positive max", () => {
    expect(() => new ConcurrencyGate(0)).toThrow();
    expect(() => new ConcurrencyGate(-1)).toThrow();
  });

  describe("runOrWait (bounded wait queue)", () => {
    it("parks at capacity, then runs the waiter when a slot frees", async () => {
      const gate = new ConcurrencyGate(1);
      expect(gate.tryAcquire()).toBe(true); // occupy the only slot (an in-flight render)
      let ran = false;
      const p = gate.runOrWait(
        async () => {
          ran = true;
          return "done";
        },
        { maxWaitMs: 1000, maxQueue: 10 },
      );
      await tick();
      expect(gate.queued).toBe(1); // parked, not refused
      expect(ran).toBe(false); // fn doesn't run until a slot is handed over

      gate.release(); // free the occupied slot → handed directly to the waiter
      await expect(p).resolves.toEqual({ ok: true, value: "done" });
      expect(ran).toBe(true);
      expect(gate.inUse).toBe(0); // the waiter ran and released
      expect(gate.queued).toBe(0);
    });

    it("wakes waiters in FIFO order, one slot cascading through the queue", async () => {
      const gate = new ConcurrencyGate(1);
      expect(gate.tryAcquire()).toBe(true);
      const order: string[] = [];
      const pA = gate.runOrWait(
        async () => {
          order.push("A");
        },
        { maxWaitMs: 1000, maxQueue: 10 },
      );
      await tick();
      const pB = gate.runOrWait(
        async () => {
          order.push("B");
        },
        { maxWaitMs: 1000, maxQueue: 10 },
      );
      await tick();
      expect(gate.queued).toBe(2);

      gate.release(); // wakes A; A's own release then wakes B
      await Promise.all([pA, pB]);
      expect(order).toEqual(["A", "B"]);
      expect(gate.inUse).toBe(0);
    });

    it("with maxWaitMs:0 refuses immediately like run(), never queueing", async () => {
      const gate = new ConcurrencyGate(1);
      expect(gate.tryAcquire()).toBe(true);
      let called = false;
      const r = await gate.runOrWait(
        async () => {
          called = true;
          return 1;
        },
        { maxWaitMs: 0, maxQueue: 10 },
      );
      expect(r).toEqual({ ok: false });
      expect(called).toBe(false);
      expect(gate.queued).toBe(0);
    });

    it("refuses without waiting once the queue is maxQueue deep", async () => {
      const gate = new ConcurrencyGate(1);
      expect(gate.tryAcquire()).toBe(true); // slot taken
      let firstRan = false;
      const p1 = gate.runOrWait(
        async () => {
          firstRan = true;
          return "a";
        },
        { maxWaitMs: 1000, maxQueue: 1 },
      );
      await tick();
      expect(gate.queued).toBe(1); // queue now full (depth 1)

      // The next caller can't queue and isn't allowed a slot → instant refuse.
      const r2 = await gate.runOrWait(async () => "b", {
        maxWaitMs: 1000,
        maxQueue: 1,
      });
      expect(r2).toEqual({ ok: false });

      gate.release(); // the parked one still completes
      await expect(p1).resolves.toEqual({ ok: true, value: "a" });
      expect(firstRan).toBe(true);
    });

    it("gives up with {ok:false} after maxWaitMs when no slot ever frees", async () => {
      vi.useFakeTimers();
      try {
        const gate = new ConcurrencyGate(1);
        expect(gate.tryAcquire()).toBe(true); // slot held for the whole test
        let called = false;
        const p = gate.runOrWait(
          async () => {
            called = true;
            return 1;
          },
          { maxWaitMs: 50, maxQueue: 10 },
        );
        await tick();
        expect(gate.queued).toBe(1);

        await vi.advanceTimersByTimeAsync(50); // the wait elapses
        await expect(p).resolves.toEqual({ ok: false });
        expect(called).toBe(false);
        expect(gate.queued).toBe(0); // the timed-out waiter removed itself
      } finally {
        vi.useRealTimers();
      }
    });

    it("releases the slot even when the waiter's fn throws", async () => {
      const gate = new ConcurrencyGate(1);
      expect(gate.tryAcquire()).toBe(true);
      const p = gate.runOrWait(
        async () => {
          throw new Error("boom");
        },
        { maxWaitMs: 1000, maxQueue: 10 },
      );
      await tick();
      gate.release();
      await expect(p).rejects.toThrow("boom");
      expect(gate.inUse).toBe(0); // slot freed despite the throw
    });
  });
});

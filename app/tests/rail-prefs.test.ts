// Tests for the workspace rail-visibility store (lib/canvas/rail-prefs).
//
// Bug classes it guards: (1) a persisted "closed" must survive the
// read→write round-trip exactly (the deck workspace renders whatever
// readRailOpen returns after reconcileRailPrefs fires post-hydration);
// (2) blocked storage (private mode / SSR) must fail open — a rail the
// user can't reopen is far worse than one that forgot it was closed;
// (3) same-tab writes fire the subscriber notify (localStorage emits no
// events for them), or useSyncExternalStore consumers never re-render.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  readRailOpen,
  reconcileRailPrefs,
  setRailOpen,
  subscribeRailPrefs,
  toggleRail,
} from "../src/lib/canvas/rail-prefs";

function stubLocalStorage() {
  const store = new Map<string, string>();
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    },
  });
  return store;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("readRailOpen", () => {
  it("defaults to open when nothing is stored", () => {
    stubLocalStorage();
    expect(readRailOpen("slides")).toBe(true);
    expect(readRailOpen("activity")).toBe(true);
  });

  it("fails open when storage is unavailable (SSR / private mode)", () => {
    // No window stub at all — the node test env has none.
    expect(readRailOpen("slides")).toBe(true);
    expect(readRailOpen("activity")).toBe(true);
  });

  it("fails open when storage access throws", () => {
    vi.stubGlobal("window", {
      localStorage: {
        getItem: () => {
          throw new Error("denied");
        },
      },
    });
    expect(readRailOpen("activity")).toBe(true);
  });
});

describe("setRailOpen / toggleRail", () => {
  let store: Map<string, string>;
  beforeEach(() => {
    store = stubLocalStorage();
  });

  it("round-trips closed and open per side, independently", () => {
    setRailOpen("activity", false);
    expect(readRailOpen("activity")).toBe(false);
    expect(readRailOpen("slides")).toBe(true);

    setRailOpen("activity", true);
    expect(readRailOpen("activity")).toBe(true);
  });

  it("stores the documented values (a hand-edited key stays legible)", () => {
    setRailOpen("slides", false);
    setRailOpen("activity", true);
    expect(store.get("canvas:deck:slide-rail")).toBe("closed");
    expect(store.get("canvas:deck:activity-rail")).toBe("open");
  });

  it("toggleRail flips from the stored value, including the unset default", () => {
    toggleRail("slides"); // unset (open) -> closed
    expect(readRailOpen("slides")).toBe(false);
    toggleRail("slides");
    expect(readRailOpen("slides")).toBe(true);
  });

  it("swallows write failures so a toggle never throws into the UI", () => {
    vi.stubGlobal("window", {
      localStorage: {
        getItem: () => null,
        setItem: () => {
          throw new Error("quota");
        },
      },
    });
    expect(() => setRailOpen("slides", false)).not.toThrow();
  });
});

describe("subscription", () => {
  it("notifies on writes and reconcile, and stops after unsubscribe", () => {
    stubLocalStorage();
    const cb = vi.fn();
    const unsubscribe = subscribeRailPrefs(cb);

    setRailOpen("slides", false);
    expect(cb).toHaveBeenCalledTimes(1);
    toggleRail("activity");
    expect(cb).toHaveBeenCalledTimes(2);
    reconcileRailPrefs();
    expect(cb).toHaveBeenCalledTimes(3);

    unsubscribe();
    setRailOpen("slides", true);
    expect(cb).toHaveBeenCalledTimes(3);
  });
});

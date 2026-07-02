// Unit tests for the opaque per-browser session minter.
//
// The crux: whatever mintOpaqueSession returns MUST satisfy SESSION_RE, the
// single shape the public comment/track routes validate against — the minter
// and the validators share that one contract (imported here from engagement).
// The module reads window.localStorage + crypto only inside the function body,
// so we stub both globals per test (the vitest env is `node`: no window, real
// crypto).

import { afterEach, describe, expect, it, vi } from "vitest";
import { mintOpaqueSession } from "../src/lib/canvas/opaque-session";
import { SESSION_RE } from "../src/lib/canvas/engagement";

type Store = Map<string, string>;

// A minimal window.localStorage backed by a Map. `denied` makes getItem throw,
// standing in for private-mode / storage-blocked browsers.
function stubStorage(store: Store, denied = false) {
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (k: string) => {
        if (denied) throw new Error("SecurityError: storage disabled");
        return store.get(k) ?? null;
      },
      setItem: (k: string, v: string) => {
        if (denied) throw new Error("SecurityError: storage disabled");
        store.set(k, v);
      },
    },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("mintOpaqueSession", () => {
  it("mints a fresh crypto.randomUUID that satisfies the shared SESSION_RE", () => {
    const store: Store = new Map();
    stubStorage(store);
    const id = mintOpaqueSession("canvas.viewer.session", "s");
    // The randomUUID path — a hyphenated hex UUID — is inside SESSION_RE's
    // [A-Za-z0-9_-]{8,64} class.
    expect(SESSION_RE.test(id)).toBe(true);
    // Persisted under the caller's key and reused verbatim on the next call.
    expect(store.get("canvas.viewer.session")).toBe(id);
    expect(mintOpaqueSession("canvas.viewer.session", "s")).toBe(id);
  });

  it("falls back to a per-load id (still SESSION_RE-valid) when crypto.randomUUID is unavailable", () => {
    const store: Store = new Map();
    stubStorage(store);
    // Strip randomUUID so fresh() takes the string-composition branch.
    vi.stubGlobal("crypto", {});
    const id = mintOpaqueSession("canvas.guest.session", "g");
    expect(id.startsWith("g")).toBe(true);
    expect(SESSION_RE.test(id)).toBe(true);
  });

  it("reuses a stored id ONLY when it still matches the contract", () => {
    // A previously stored value that no longer parses (shape drift / tampering)
    // must be replaced, not returned.
    const store: Store = new Map([["canvas.guest.session", "not a valid session!!"]]);
    stubStorage(store);
    const id = mintOpaqueSession("canvas.guest.session", "g");
    expect(id).not.toBe("not a valid session!!");
    expect(SESSION_RE.test(id)).toBe(true);
    expect(store.get("canvas.guest.session")).toBe(id);
  });

  it("returns a fresh per-load id without throwing when storage is denied", () => {
    stubStorage(new Map(), /* denied */ true);
    const id = mintOpaqueSession("canvas.guest.session", "g");
    // Storage threw, so the id can't persist — but it's still a valid session.
    expect(SESSION_RE.test(id)).toBe(true);
  });
});

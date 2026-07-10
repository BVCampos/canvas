import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// deck-workspace reads two localStorage-backed stores through
// useSyncExternalStore: rail-prefs (rail visibility) and the fast-lane offer
// dismissal flag. On React 19 the SERVER snapshot ("rails open" / "offer
// dismissed") sticks after hydration until a store notify makes React re-read
// the client snapshot — so the workspace's mount effect must call BOTH
// reconcile functions. Deleting either call keeps every unit test green while
// silently reintroducing a prod bug; this class has hit twice (rail-prefs in
// PR #84, the fast-lane offer in PR #85 — its only other notifiers are the
// banner's own buttons, which never render, so the banner never shows at
// all).
//
// Mounting the ~4,800-line client component isn't feasible in this node-env
// suite (no DOM, no testing-library), so — like bridge-version-sync's pin —
// this is a text-level contract test on the source itself: crude, but it's
// the only guard that fails when the wiring is removed.

const here = dirname(fileURLToPath(import.meta.url));

describe("deck-workspace post-hydration reconcile wiring", () => {
  const src = readFileSync(
    join(here, "../src/app/canvases/[id]/deck-workspace.tsx"),
    "utf8",
  );

  it("a mount effect calls reconcileRailPrefs() and reconcileFastLaneOfferDismissal()", () => {
    // Both must appear as CALLS — the import lines alone don't satisfy this.
    expect(src).toContain("reconcileRailPrefs()");
    expect(src).toContain("reconcileFastLaneOfferDismissal()");

    // And both must sit inside one empty-deps (mount) effect, so they fire
    // once, after hydration. Whitespace-tolerant; body match is lazy so the
    // true mount effect (which closes with `}, [])` right after the two
    // calls) is captured whole.
    const mountEffectBodies = [
      ...src.matchAll(
        /useEffect\(\s*\(\)\s*=>\s*\{([\s\S]*?)\}\s*,\s*\[\]\s*\)/g,
      ),
    ].map((m) => m[1]);
    const wired = mountEffectBodies.some(
      (body) =>
        body.includes("reconcileRailPrefs()") &&
        body.includes("reconcileFastLaneOfferDismissal()"),
    );
    expect(
      wired,
      "deck-workspace.tsx must call reconcileRailPrefs() and " +
        "reconcileFastLaneOfferDismissal() together in a mount ([] deps) " +
        "effect. Without the notify, useSyncExternalStore keeps serving the " +
        "server snapshot: closed rails can never persist and the fast-lane " +
        "offer banner never shows.",
    ).toBe(true);
  });
});

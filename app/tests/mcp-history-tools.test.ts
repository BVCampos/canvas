// Unit tests for the snapshot-position comparison behind diff_snapshots.
//
// The DB-query halves of the history tools (read_snapshot / diff_slide_versions
// / diff_snapshots) mirror the already-tested read_slide_version / list_snapshots
// patterns (admin client + workspace filter + per-deck access gate) and the
// underlying tables are exercised by the pglite DB harness. The one piece of
// novel logic is the position set-diff, extracted here so it's covered directly.

import { describe, expect, it } from "vitest";
import { compareSnapshotPositions } from "../src/lib/canvas/mcp/tools";

const m = (entries: Array<[number, string]>) => new Map<number, string>(entries);

describe("compareSnapshotPositions", () => {
  it("identical snapshots show no changes", () => {
    const a = m([[0, "v1"], [1, "v2"]]);
    expect(compareSnapshotPositions(a, m([[0, "v1"], [1, "v2"]]))).toEqual({
      changed: [],
      added: [],
      removed: [],
    });
  });

  it("a position pointing at a different version is 'changed'", () => {
    const a = m([[0, "v1"], [1, "v2"]]);
    const b = m([[0, "v1"], [1, "v9"]]);
    expect(compareSnapshotPositions(a, b)).toEqual({ changed: [1], added: [], removed: [] });
  });

  it("a position only in b is 'added'; only in a is 'removed'", () => {
    const a = m([[0, "v1"], [1, "v2"]]);
    const b = m([[0, "v1"], [2, "v3"]]);
    expect(compareSnapshotPositions(a, b)).toEqual({ changed: [], added: [2], removed: [1] });
  });

  it("results are sorted by position", () => {
    const a = m([[5, "a"], [2, "b"], [9, "c"]]);
    const b = m([[5, "A"], [2, "b"], [9, "C"]]);
    expect(compareSnapshotPositions(a, b).changed).toEqual([5, 9]);
  });

  it("two empty snapshots compare clean", () => {
    expect(compareSnapshotPositions(m([]), m([]))).toEqual({ changed: [], added: [], removed: [] });
  });
});

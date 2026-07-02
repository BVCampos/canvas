import { describe, it, expect } from "vitest";
import {
  decideRemount,
  parseSlideSignature,
  selfAppliedKey,
} from "../src/lib/canvas/preview-remount";

// Signatures are "id:position:versionId" joined by "|". Version is the
// current_version_id (a UUID) or "0".
const sig = (parts: Array<[string, number, string]>) =>
  parts.map(([id, pos, v]) => `${id}:${pos}:${v}`).join("|");

describe("parseSlideSignature", () => {
  it("splits id / position / version even though ids and version ids are UUIDs", () => {
    const parsed = parseSlideSignature("aaaa-1111:0:vvvv-0001|bbbb-2222:1:0");
    expect(parsed).toEqual([
      { id: "aaaa-1111", position: 0, version: "vvvv-0001" },
      { id: "bbbb-2222", position: 1, version: "0" },
    ]);
  });
  it("returns [] for an empty signature", () => {
    expect(parseSlideSignature("")).toEqual([]);
  });
});

describe("decideRemount", () => {
  it("does not remount when the signature is unchanged", () => {
    const s = sig([["a", 0, "v1"]]);
    expect(decideRemount(s, s, new Set())).toEqual({ remount: false, consumed: [] });
  });

  it("remounts on a version bump that was NOT self-applied (teammate / agent / restore)", () => {
    const prev = sig([["a", 0, "v1"]]);
    const next = sig([["a", 0, "v2"]]);
    expect(decideRemount(prev, next, new Set())).toEqual({ remount: true });
  });

  it("skips the remount when the ONLY change is a self-applied version bump", () => {
    const prev = sig([["a", 0, "v1"], ["b", 1, "v9"]]);
    const next = sig([["a", 0, "v2"], ["b", 1, "v9"]]);
    const selfApplied = new Set([selfAppliedKey("a", "v2")]);
    expect(decideRemount(prev, next, selfApplied)).toEqual({
      remount: false,
      consumed: [selfAppliedKey("a", "v2")],
    });
  });

  it("remounts if any bumped slide in the change was NOT self-applied", () => {
    const prev = sig([["a", 0, "v1"], ["b", 1, "v1"]]);
    const next = sig([["a", 0, "v2"], ["b", 1, "v2"]]);
    // Only a's bump is ours; b's (a concurrent edit) forces a reload.
    const selfApplied = new Set([selfAppliedKey("a", "v2")]);
    expect(decideRemount(prev, next, selfApplied)).toEqual({ remount: true });
  });

  it("remounts on a structural change (slide added) regardless of self-applied set", () => {
    const prev = sig([["a", 0, "v1"]]);
    const next = sig([["a", 0, "v1"], ["b", 1, "v1"]]);
    expect(decideRemount(prev, next, new Set([selfAppliedKey("a", "v1")]))).toEqual({
      remount: true,
    });
  });

  it("remounts on a reorder (position moved) even if versions are unchanged", () => {
    const prev = sig([["a", 0, "v1"], ["b", 1, "v1"]]);
    const next = sig([["a", 1, "v1"], ["b", 0, "v1"]]);
    expect(decideRemount(prev, next, new Set())).toEqual({ remount: true });
  });

  it("remounts on a delete (slide removed)", () => {
    const prev = sig([["a", 0, "v1"], ["b", 1, "v1"]]);
    const next = sig([["a", 0, "v1"]]);
    expect(decideRemount(prev, next, new Set())).toEqual({ remount: true });
  });
});

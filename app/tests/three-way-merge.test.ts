import { describe, expect, it } from "vitest";
import { threeWayMergeText, threeWayMergeSlide } from "../src/lib/canvas/three-way-merge";

const lines = (...l: string[]) => l.join("\n");

describe("threeWayMergeText", () => {
  it("merges disjoint edits cleanly (nobody loses work)", () => {
    const base = lines("a", "b", "c", "d");
    const current = lines("A", "b", "c", "d"); // someone changed line 1
    const theirs = lines("a", "b", "C", "d"); // proposal changed line 3
    const r = threeWayMergeText(base, current, theirs);
    expect(r).toEqual({ clean: true, merged: lines("A", "b", "C", "d") });
  });

  it("conflicts when both sides change the SAME line differently", () => {
    const r = threeWayMergeText(lines("a", "b"), lines("X", "b"), lines("Y", "b"));
    expect(r).toEqual({ clean: false });
  });

  it("takes theirs when current is unchanged from base", () => {
    const base = lines("a", "b");
    expect(threeWayMergeText(base, base, lines("a", "B"))).toEqual({
      clean: true,
      merged: lines("a", "B"),
    });
  });

  it("keeps current when the proposal is a no-op vs its base", () => {
    const base = lines("a", "b");
    expect(threeWayMergeText(base, lines("A", "b"), base)).toEqual({
      clean: true,
      merged: lines("A", "b"),
    });
  });

  it("clean when both sides made the identical change", () => {
    const base = lines("a", "b");
    expect(threeWayMergeText(base, lines("a", "B"), lines("a", "B"))).toEqual({
      clean: true,
      merged: lines("a", "B"),
    });
  });
});

describe("threeWayMergeSlide", () => {
  const sc = (html_body: string, slide_styles: string) => ({ html_body, slide_styles });

  it("merges when html and styles each change disjoint regions", () => {
    const base = sc(lines("<h1>Title</h1>", "<p>body</p>"), lines(".a{}", ".b{}"));
    const current = sc(lines("<h1>New Title</h1>", "<p>body</p>"), lines(".a{}", ".b{}"));
    const theirs = sc(lines("<h1>Title</h1>", "<p>body</p>"), lines(".a{}", ".b{color:red}"));
    expect(threeWayMergeSlide(base, current, theirs)).toEqual({
      clean: true,
      html_body: lines("<h1>New Title</h1>", "<p>body</p>"),
      slide_styles: lines(".a{}", ".b{color:red}"),
    });
  });

  it("fails the whole slide if EITHER field conflicts (never half-applies)", () => {
    const base = sc(lines("a", "b"), ".x{}");
    const current = sc(lines("A", "b"), ".x{color:red}");
    const theirs = sc(lines("Z", "b"), ".x{color:blue}"); // both fields conflict
    expect(threeWayMergeSlide(base, current, theirs)).toEqual({ clean: false });
  });
});

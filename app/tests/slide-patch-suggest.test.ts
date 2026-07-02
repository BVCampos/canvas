// Unit tests for computeSlidePatch — the "actionable patch nudge" engine that
// turns a full before→after rewrite into the minimal propose_slide_patch edits.
// The load-bearing invariant: any patch it returns, applied to `before` by the
// real applySlidePatch, reproduces `after` exactly. If it can't guarantee that,
// it returns null (and the tool falls back to a prose hint).

import { describe, expect, it } from "vitest";
import { computeSlidePatch } from "../src/lib/canvas/slide-patch-suggest";
import { applySlidePatch } from "../src/lib/canvas/slide-patch";

const body = (lines: string[]) => `<section class="slide">\n${lines.join("\n")}\n</section>`;

// Apply a suggested patch the way the server would and return the produced field.
function reapply(before: string, patch: ReturnType<typeof computeSlidePatch>, field: "html_body" | "slide_styles" = "html_body") {
  expect(patch).not.toBeNull();
  const input = field === "slide_styles" ? { html_body: "", slide_styles: before } : { html_body: before, slide_styles: "" };
  const res = applySlidePatch(input, patch!);
  expect(res.ok).toBe(true);
  return res.ok ? (field === "slide_styles" ? res.slide_styles : res.html_body) : null;
}

describe("computeSlidePatch", () => {
  it("returns null when nothing changed", () => {
    const b = body(["a", "b", "c"]);
    expect(computeSlidePatch(b, b)).toBeNull();
  });

  it("reduces a one-line change to a single edit that reproduces after", () => {
    const before = body(Array.from({ length: 10 }, (_, i) => `<p>row ${i}</p>`));
    const after = before.replace("<p>row 4</p>", "<p>row four</p>");
    const patch = computeSlidePatch(before, after);
    expect(patch).toHaveLength(1);
    expect(patch![0].find).toContain("row 4");
    expect(patch![0].replace).toContain("row four");
    expect(reapply(before, patch)).toBe(after);
  });

  it("handles two separate changes as two edits", () => {
    const before = body(Array.from({ length: 10 }, (_, i) => `<p>row ${i}</p>`));
    let after = before.replace("<p>row 2</p>", "<p>row TWO</p>");
    after = after.replace("<p>row 7</p>", "<p>row SEVEN</p>");
    const patch = computeSlidePatch(before, after);
    expect(patch).toHaveLength(2);
    expect(reapply(before, patch)).toBe(after);
  });

  it("anchors a pure insertion with context and reproduces after", () => {
    const before = body(["alpha", "beta", "gamma"]);
    const after = body(["alpha", "beta", "beta-and-a-half", "gamma"]);
    const patch = computeSlidePatch(before, after);
    expect(patch).not.toBeNull();
    expect(reapply(before, patch)).toBe(after);
  });

  it("handles a pure deletion and reproduces after", () => {
    const before = body(["one", "two", "three", "four"]);
    const after = body(["one", "two", "four"]);
    const patch = computeSlidePatch(before, after);
    expect(patch).not.toBeNull();
    expect(reapply(before, patch)).toBe(after);
  });

  it("grows context to disambiguate a change on a non-unique line", () => {
    const before = body(["x", "dup", "y", "dup", "z"]);
    const after = body(["x", "DUP", "y", "dup", "z"]); // change only the FIRST dup
    const patch = computeSlidePatch(before, after);
    expect(patch).toHaveLength(1);
    // The bare "dup\n" isn't unique, so the find must carry context.
    expect(patch![0].find.length).toBeGreaterThan("dup\n".length);
    expect(reapply(before, patch)).toBe(after);
  });

  it("returns null for a genuine redesign (too many hunks)", () => {
    const before = body(Array.from({ length: 20 }, (_, i) => `<p>row ${i}</p>`));
    // Change every even row → 10 separate hunks, over the cap.
    const after = before.replace(/(<p>row )(\d*[02468])(<\/p>)/g, "$1n$2$3");
    expect(computeSlidePatch(before, after)).toBeNull();
  });

  it("tags slide_styles edits with in:'slide_styles' and reproduces after", () => {
    const before = [".a{color:red}", ".b{color:green}", ".c{color:blue}"].join("\n");
    const after = before.replace(".b{color:green}", ".b{color:teal}");
    const patch = computeSlidePatch(before, after, "slide_styles");
    expect(patch).toHaveLength(1);
    expect(patch![0].in).toBe("slide_styles");
    expect(reapply(before, patch, "slide_styles")).toBe(after);
  });

  it("invariant: every returned patch re-applies to exactly reproduce after", () => {
    const before = body(Array.from({ length: 14 }, (_, i) => `<li data-i="${i}">item ${i}</li>`));
    // A scattered but small set of edits (under the hunk cap).
    const after = before
      .replace('item 1</li>', 'item one</li>')
      .replace('item 9</li>', 'item nine</li>');
    const patch = computeSlidePatch(before, after);
    expect(patch).not.toBeNull();
    expect(reapply(before, patch)).toBe(after);
  });

  it("returns null when a unique-looking anchor would resolve to the wrong occurrence (verify step is the backstop)", () => {
    // "m\nn\nm\n" overlaps in the source, so the split-based occurrence count
    // reads it as unique and the per-hunk uniqueness check passes — only the
    // self-verify (real applySlidePatch + exact compare) catches that the built
    // edit would patch the FIRST (wrong) occurrence. Must degrade to null.
    // This test FAILS if the verify step (the module's core safety net) is removed.
    expect(computeSlidePatch("m\nn\nm\nn\nm\nn\n", "m\nn\nm\nNN\nm\nn\n")).toBeNull();
  });

  it("handles two interleaved changes that share identical context (ordered re-apply reproduces after)", () => {
    // Both hunks get find "P\nt\nP\n"; it only works because applySlidePatch
    // consumes the first match before the second edit searches. Guards that.
    const before = "P\nt\nP\nt\nP\n";
    const after = "P\nX\nP\nY\nP\n";
    const patch = computeSlidePatch(before, after);
    expect(patch).toHaveLength(2);
    expect(reapply(before, patch)).toBe(after);
  });

  it("returns null when a change can't be uniquely anchored within the context budget", () => {
    const A = "a\na\na\na";
    // Two identical X regions; the only distinguisher ('b') is >3 lines away, so
    // no anchor within SUGGEST_MAX_CONTEXT_LINES is unique → null (no crash).
    const before = `${A}\nX\n${A}\nb\n${A}\nX\n${A}`;
    const after = `${A}\nX\n${A}\nb\n${A}\nY\n${A}`; // change only the SECOND X
    expect(computeSlidePatch(before, after)).toBeNull();
  });

  it("preserves CRLF line endings in find/replace and reproduces after", () => {
    const before = "<section>\r\n<p>a</p>\r\n<p>b</p>\r\n</section>";
    const after = before.replace("<p>b</p>", "<p>B</p>");
    const patch = computeSlidePatch(before, after);
    expect(patch).toHaveLength(1);
    expect(patch![0].find).toContain("\r\n");
    expect(reapply(before, patch)).toBe(after);
  });

  it("handles a change on the first line and on the final newline-less line", () => {
    expect(reapply("first\nmid\nlast\n", computeSlidePatch("first\nmid\nlast\n", "FIRST\nmid\nlast\n"))).toBe("FIRST\nmid\nlast\n");
    expect(reapply("l1\nl2\nl3", computeSlidePatch("l1\nl2\nl3", "l1\nl2\nL3"))).toBe("l1\nl2\nL3");
  });

  it("returns null for a slide larger than the line bound (but still suggests for a small one)", () => {
    const big = Array.from({ length: 900 }, (_, i) => `<p>row ${i}</p>`).join("\n");
    expect(computeSlidePatch(big, big.replace("<p>row 10</p>", "<p>row ten</p>"))).toBeNull();
    const small = Array.from({ length: 20 }, (_, i) => `<p>row ${i}</p>`).join("\n");
    expect(computeSlidePatch(small, small.replace("<p>row 10</p>", "<p>row ten</p>"))).not.toBeNull();
  });
});

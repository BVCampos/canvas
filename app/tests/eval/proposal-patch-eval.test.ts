// Golden-corpus eval for the propose_slide_patch engine (applySlidePatch).
//
// The editing-10x discovery showed the patch path's real-world failure is the
// `find` not matching: on minified, entity-encoded, attribute-reordered imported
// HTML, the snippet Claude reads back and the snippet it sends differ by
// whitespace/encoding, the patch errors, and Claude falls back to a full rewrite
// (one heavy user made ZERO patch calls in their account's lifetime). The existing
// slide-patch.test.ts covers toy strings; this corpus exercises the engine on
// REALISTIC slide HTML so a change to the matching logic (e.g. whitespace
// tolerance) moves a measurable score instead of passing unnoticed.
//
// Each case is labelled with its expected OUTCOME; the suite asserts each and
// prints a pass-rate scorecard. To extend coverage, add a case — don't loosen
// an assertion.

import { describe, expect, it } from "vitest";
import { applySlidePatch, type SlidePatchEdit } from "../../src/lib/canvas/slide-patch";

type Outcome = "ok" | "not_found" | "ambiguous" | "noop";

// A representative imported slide: minified-ish, entity-encoded (&amp;, R$),
// repeated utility classes, attributes in mixed order.
const SLIDE = {
  html_body:
    '<section class="slide"><div class="row" data-x="1"><h2 class="t">Receita &amp; Margem</h2>' +
    '<span class="n">R$ 1.250</span></div><div class="row" data-x="2"><h2 class="t">Custos</h2>' +
    '<span class="n">R$ 980</span></div><p class="foot">Fonte: análise interna</p></section>',
  slide_styles: ".slide .n{font-weight:700}.slide .t{color:#0e1a2b}",
};

type Case = {
  name: string;
  edits: SlidePatchEdit[];
  expect: Outcome;
};

const CORPUS: Case[] = [
  {
    name: "exact verbatim find hits (the happy path)",
    edits: [{ find: "R$ 1.250", replace: "R$ 1.480" }],
    expect: "ok",
  },
  {
    name: "entity-encoded ampersand matched verbatim (must use &amp;, not &)",
    edits: [{ find: "Receita &amp; Margem", replace: "Receita &amp; Margem Bruta" }],
    expect: "ok",
  },
  {
    name: "raw & instead of the stored &amp; entity -> not found",
    edits: [{ find: "Receita & Margem", replace: "x" }],
    expect: "not_found",
  },
  {
    name: "collapsed whitespace between tags -> not found (the dominant real failure)",
    edits: [{ find: '<div class="row" data-x="1">\n  <h2', replace: "<div" }],
    expect: "not_found",
  },
  {
    name: "reordered attributes (data-x before class) -> not found",
    edits: [{ find: '<div data-x="1" class="row">', replace: "x" }],
    expect: "not_found",
  },
  {
    name: "ambiguous: a class that appears on multiple elements, no replace_all",
    edits: [{ find: '<h2 class="t">', replace: '<h2 class="t big">' }],
    expect: "ambiguous",
  },
  {
    name: "same ambiguous find succeeds with replace_all",
    edits: [{ find: '<h2 class="t">', replace: '<h2 class="t big">', replace_all: true }],
    expect: "ok",
  },
  {
    name: "ordered edits: the second find matches the first edit's output",
    edits: [
      { find: "Custos", replace: "Custos Totais" },
      { find: "Custos Totais", replace: "Custos Totais (R$)" },
    ],
    expect: "ok",
  },
  {
    name: "patch into slide_styles via in: field",
    edits: [{ find: "font-weight:700", replace: "font-weight:600", in: "slide_styles" }],
    expect: "ok",
  },
  {
    name: "no-op: replace equals find",
    edits: [{ find: "Custos", replace: "Custos" }],
    expect: "noop",
  },
];

function outcomeOf(edits: SlidePatchEdit[]): Outcome {
  const r = applySlidePatch(SLIDE, edits);
  if (r.ok) return "ok";
  if (/not found/.test(r.error)) return "not_found";
  if (/matches \d+ places/.test(r.error)) return "ambiguous";
  return "noop";
}

describe("propose_slide_patch — golden corpus", () => {
  let pass = 0;
  for (const c of CORPUS) {
    it(c.name, () => {
      const got = outcomeOf(c.edits);
      expect(got, c.name).toBe(c.expect);
      if (got === c.expect) pass += 1;
    });
  }

  it("scorecard: every case matched its expected outcome", () => {
    // Runs last; pass was incremented by the cases above. A regression in the
    // matcher shows up as a number that moved, not a silent green.
    console.log(`[patch-eval] ${pass}/${CORPUS.length} cases matched expected outcome`);
    expect(pass).toBe(CORPUS.length);
  });
});

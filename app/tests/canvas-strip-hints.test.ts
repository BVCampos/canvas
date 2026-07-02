import { describe, expect, it } from "vitest";
import { stripEditorHints } from "../src/lib/canvas/strip-hints";

describe("stripEditorHints", () => {
  it("removes a Portuguese editor-hint <div> overlay", () => {
    const html = `<section class="slide">
      <h1>Visão Geral</h1>
      <div class="hint-pill">CLIQUE NOS TEXTOS PARA EDITAR</div>
      <p>Some real content.</p>
    </section>`;
    const out = stripEditorHints(html);
    expect(out).not.toMatch(/CLIQUE NOS TEXTOS/i);
    expect(out).toContain("Visão Geral");
    expect(out).toContain("Some real content.");
  });

  it("removes an English 'click texts to edit' hint", () => {
    const html = `<div class="slide">
      <span class="editor-hint">Click the text to edit</span>
      <h2>Slide title</h2>
    </div>`;
    const out = stripEditorHints(html);
    expect(out).not.toMatch(/click the text to edit/i);
    expect(out).toContain("Slide title");
  });

  it("removes lowercase Portuguese 'clique no texto' variant", () => {
    const html = `<p>clique no texto</p><h1>Real</h1>`;
    const out = stripEditorHints(html);
    expect(out).not.toMatch(/clique no texto/i);
    expect(out).toContain("Real");
  });

  it("removes 'editar o texto' variant", () => {
    const html = `<small>Editar o texto</small><div>keep</div>`;
    const out = stripEditorHints(html);
    expect(out).not.toMatch(/editar o texto/i);
    expect(out).toContain("keep");
  });

  it("leaves the html untouched when no hint pattern is present", () => {
    const html = `<section class="slide"><h1>Title</h1><p>Body.</p></section>`;
    const out = stripEditorHints(html);
    expect(out).toBe(html);
  });

  it("does not strip elements that contain interactive children", () => {
    // The phrase happens to match but the element wraps a link — real content,
    // leave it alone.
    const html = `<div>Click the text to edit <a href="/help">help</a></div>`;
    const out = stripEditorHints(html);
    expect(out).toContain("Click the text to edit");
    expect(out).toContain("/help");
  });

  it("does not strip long blocks of text that happen to mention 'editar'", () => {
    const long =
      "Para editar o texto desta apresentação, abra-a no Claude Code via MCP — clique em Editar e siga as instruções.";
    const html = `<p>${long}</p>`;
    const out = stripEditorHints(html);
    // Length > 50 char threshold — must survive.
    expect(out).toContain(long);
  });

  it("strips multiple hint elements in the same slide", () => {
    const html = `<div>CLIQUE NOS TEXTOS PARA EDITAR</div>
      <h1>Slide</h1>
      <span>Click the texts to edit</span>
      <p>Body</p>`;
    const out = stripEditorHints(html);
    expect(out).not.toMatch(/CLIQUE NOS TEXTOS/i);
    expect(out).not.toMatch(/click the texts? to edit/i);
    expect(out).toContain("Slide");
    expect(out).toContain("Body");
  });

  it("preserves nested structure when the hint sits beside real content", () => {
    const html = `<section class="slide">
      <header><h1>Cover</h1></header>
      <div class="content">
        <p>Real paragraph one.</p>
        <div class="hint-corner">CLIQUE NOS TEXTOS PARA EDITAR</div>
        <p>Real paragraph two.</p>
      </div>
    </section>`;
    const out = stripEditorHints(html);
    expect(out).not.toMatch(/CLIQUE NOS TEXTOS/i);
    expect(out).toContain("Cover");
    expect(out).toContain("Real paragraph one.");
    expect(out).toContain("Real paragraph two.");
    // Section / header / content wrappers survive.
    expect(out).toMatch(/<section class="slide">/);
    expect(out).toMatch(/<div class="content">/);
  });

  it("does not strip a <section> even if its short text matches", () => {
    // We never strip structural tags — a hint inside a wrapping <section>
    // would just be a stray phrase but the section element itself is
    // semantic content.
    const html = `<section>CLIQUE NOS TEXTOS PARA EDITAR</section>`;
    const out = stripEditorHints(html);
    // The wrapping section stays; but inner text remains since we couldn't
    // identify a strippable child.
    expect(out).toContain("<section>");
  });

  it("is idempotent — running it twice has no further effect", () => {
    const html = `<section class="slide">
      <h1>X</h1>
      <div>CLIQUE NOS TEXTOS PARA EDITAR</div>
      <p>Y</p>
    </section>`;
    const once = stripEditorHints(html);
    const twice = stripEditorHints(once);
    expect(twice).toBe(once);
  });

  it("strips a <u>-wrapped hint (underline emphasis is in STRIPPABLE_TAGS)", () => {
    // The walker docstring claims <u> is allowed inline; make sure a leaf
    // <u> wrapper around a hint phrase actually gets stripped, matching
    // the behaviour of the sibling emphasis tags (em/strong/i/b).
    const html = `<u>Clique nos textos</u><h1>Keep me</h1>`;
    const out = stripEditorHints(html);
    expect(out).not.toMatch(/clique nos textos/i);
    expect(out).toContain("Keep me");
  });

  it("strips an <aside class='hint'> overlay containing only a hint phrase", () => {
    // Some decks wrap the hint pill in <aside>; ensure
    // we treat it as a strippable leaf rather than preserving it as
    // structural content.
    const html = `<section class="slide">
      <h1>Cover</h1>
      <aside class="hint">CLIQUE NOS TEXTOS PARA EDITAR</aside>
    </section>`;
    const out = stripEditorHints(html);
    expect(out).not.toMatch(/CLIQUE NOS TEXTOS/i);
    expect(out).not.toMatch(/<aside/i);
    expect(out).toContain("Cover");
  });

  it("strips a <label> overlay containing only a hint phrase", () => {
    // Same as <aside>: a stray <label> wrapping the hint is treated as a
    // leaf wrapper.
    const html = `<label class="hint">Click the text to edit</label><p>Body</p>`;
    const out = stripEditorHints(html);
    expect(out).not.toMatch(/click the text to edit/i);
    expect(out).not.toMatch(/<label/i);
    expect(out).toContain("Body");
  });

  it("does not throw on malformed HTML — returns a string for broken input", () => {
    // Pathological / partial markup should be handled gracefully by the
    // walker, not propagated as a thrown error. The importer's per-slide
    // try/catch is a backstop, but the walker itself should also be
    // resilient.
    const broken = `<<foo></`;
    expect(() => stripEditorHints(broken)).not.toThrow();
    const out = stripEditorHints(broken);
    expect(typeof out).toBe("string");
  });

  it("does not throw on hint-shaped malformed HTML", () => {
    // Hint pattern is present but tag soup is broken — the walker may or
    // may not strip anything, but it must not throw.
    const broken = `<<div>Clique nos textos</div`;
    expect(() => stripEditorHints(broken)).not.toThrow();
    const out = stripEditorHints(broken);
    expect(typeof out).toBe("string");
  });
});

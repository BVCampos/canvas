import { describe, expect, it } from "vitest";
import { DECK_TEMPLATES, getDeckTemplate } from "../src/lib/canvas/deck-templates";
import { parseDeckHtml } from "../src/lib/canvas/parser";

describe("deck templates", () => {
  it("has unique, url-safe ids and complete metadata", () => {
    const ids = DECK_TEMPLATES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const t of DECK_TEMPLATES) {
      expect(t.id).toMatch(/^[a-z][a-z0-9-]*$/);
      expect(t.name.length).toBeGreaterThan(0);
      expect(t.description.length).toBeGreaterThan(0);
    }
  });

  it("getDeckTemplate resolves known ids and rejects unknown", () => {
    expect(getDeckTemplate(DECK_TEMPLATES[0].id)?.id).toBe(DECK_TEMPLATES[0].id);
    expect(getDeckTemplate("does-not-exist")).toBeUndefined();
  });

  it("each template builds HTML that embeds the title and parses into multiple slides", () => {
    for (const t of DECK_TEMPLATES) {
      const html = t.build("My Q3 Deck");
      expect(html).toContain("My Q3 Deck"); // the cover reflects the real title
      const parsed = parseDeckHtml(html);
      // A template is only useful if it gives the user a real skeleton to edit.
      expect(parsed.slides.length, `${t.id} slide count`).toBeGreaterThan(1);
    }
  });

  it("escapes HTML-significant characters in the title", () => {
    const html = getDeckTemplate("proposal")!.build('Acme <b>"&" </b>');
    expect(html).toContain("&lt;b&gt;");
    expect(html).not.toContain("<b>");
  });
});

import { describe, expect, it } from "vitest";
import { importParsedDeck } from "../src/lib/canvas/importer";
import type { ParsedDeck } from "../src/lib/canvas/parser";

describe("importParsedDeck", () => {
  it("rejects a parsed deck with no slides before creating a DB row", async () => {
    const parsed: ParsedDeck = {
      title: "No slides",
      lang: "en",
      meta: {},
      theme_css: "",
      nav_js: "",
      slides: [],
      assets: [],
      chrome_html: "",
    };

    await expect(
      importParsedDeck(parsed, {
        workspace_id: "00000000-0000-0000-0000-000000000001",
        user_id: "00000000-0000-0000-0000-000000000002",
      }),
    ).rejects.toThrow(/no slides found/);
  });
});

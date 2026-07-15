import { beforeEach, describe, expect, it, vi } from "vitest";
import { importParsedDeck } from "../src/lib/canvas/importer";
import type { ParsedDeck } from "../src/lib/canvas/parser";

// The importer uploads each parsed asset with the parser-emitted mime as the
// storage contentType and derives the object's extension from it. Regression
// for the 2026-07-11 prod failure: a font/ttf asset must reach storage as a
// `.ttf` object with contentType `font/ttf` (allowed by the decks bucket
// since migration 0077) — not fall through mimeToExt's `.bin` default.
const uploads: Array<{ path: string; contentType: string | undefined }> = [];
let assetIdCounter = 0;

vi.mock("../src/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from(table: string) {
      return {
        insert(payload: Record<string, unknown> | Array<Record<string, unknown>>) {
          if (table === "canvas_deck_asset") {
            assetIdCounter += 1;
            const id = `00000000-0000-0000-0000-00000000000${assetIdCounter}`;
            return {
              select: () => ({ single: async () => ({ data: { id }, error: null }) }),
            };
          }
          if (table === "canvas_deck") {
            return {
              select: () => ({
                single: async () => ({ data: { id: "deck-1" }, error: null }),
              }),
            };
          }
          void payload;
          return Promise.resolve({ error: null });
        },
        update: () => ({ eq: async () => ({ error: null }) }),
        delete: () => ({ eq: async () => ({ error: null }) }),
      };
    },
    storage: {
      from: () => ({
        upload: async (
          path: string,
          _data: Uint8Array,
          opts?: { contentType?: string },
        ) => {
          uploads.push({ path, contentType: opts?.contentType });
          return { error: null };
        },
      }),
    },
  }),
}));

function parsedDeckWithFont(): ParsedDeck {
  return {
    title: "Font deck",
    lang: "en",
    meta: {},
    theme_css: '@font-face{font-family:X;src:url("__CANVAS_ASSET_0__")}',
    nav_js: "",
    chrome_html: "",
    assets: [
      {
        placeholder_id: "__CANVAS_ASSET_0__",
        original_src: "data:font/ttf;base64,a",
        mime_type: "font/ttf",
        data: new Uint8Array([0, 1, 0, 0]),
      },
    ],
    slides: [
      {
        position: 0,
        title: "One",
        html_body: "<h1>One</h1>",
        slide_styles: "",
        class_modifiers: [],
      },
    ],
  };
}

describe("importParsedDeck — asset upload mime", () => {
  beforeEach(() => {
    uploads.length = 0;
    assetIdCounter = 0;
  });

  it("uploads a TTF font asset with its real contentType and extension", async () => {
    await importParsedDeck(parsedDeckWithFont(), {
      workspace_id: "00000000-0000-0000-0000-000000000001",
      user_id: "00000000-0000-0000-0000-000000000002",
    });

    expect(uploads).toHaveLength(1);
    expect(uploads[0].contentType).toBe("font/ttf");
    expect(uploads[0].path).toMatch(/\.ttf$/);
  });
});

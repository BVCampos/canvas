import { beforeEach, describe, expect, it, vi } from "vitest";
import { importParsedDeck } from "../src/lib/canvas/importer";
import type { ParsedDeck } from "../src/lib/canvas/parser";

// Capture every table insert / storage upload the importer issues so the
// dedup behavior is observable: identical asset bytes must mint ONE
// canvas_deck_asset row + ONE storage object, and every duplicate
// placeholder must resolve to that single asset's URL.
const assetInserts: Array<Record<string, unknown>> = [];
const uploads: string[] = [];
let slideInserts: Array<Record<string, unknown>> = [];
let assetIdCounter = 0;

vi.mock("../src/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from(table: string) {
      return {
        insert(payload: Record<string, unknown> | Array<Record<string, unknown>>) {
          if (table === "canvas_deck_asset") {
            assetInserts.push(payload as Record<string, unknown>);
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
          if (table === "canvas_deck_slide") {
            slideInserts = payload as Array<Record<string, unknown>>;
            return Promise.resolve({ error: null });
          }
          return Promise.resolve({ error: null });
        },
        update: () => ({ eq: async () => ({ error: null }) }),
        delete: () => ({ eq: async () => ({ error: null }) }),
      };
    },
    storage: {
      from: () => ({
        upload: async (path: string) => {
          uploads.push(path);
          return { error: null };
        },
      }),
    },
  }),
}));

const LOGO = new Uint8Array([137, 80, 78, 71, 1, 2, 3, 4]);
const PHOTO = new Uint8Array([255, 216, 255, 224, 9, 9, 9]);

function parsedDeckWithRepeatedLogo(): ParsedDeck {
  return {
    title: "Dedup",
    lang: "pt-BR",
    meta: {},
    theme_css: "",
    nav_js: "",
    chrome_html: "",
    assets: [
      { placeholder_id: "__CANVAS_ASSET_0__", original_src: "data:image/png;base64,a", mime_type: "image/png", data: LOGO },
      { placeholder_id: "__CANVAS_ASSET_1__", original_src: "data:image/jpeg;base64,b", mime_type: "image/jpeg", data: PHOTO },
      { placeholder_id: "__CANVAS_ASSET_2__", original_src: "data:image/png;base64,a", mime_type: "image/png", data: new Uint8Array(LOGO) },
      { placeholder_id: "__CANVAS_ASSET_3__", original_src: "data:image/png;base64,a", mime_type: "image/png", data: new Uint8Array(LOGO) },
    ],
    slides: [
      {
        position: 0,
        title: "One",
        html_body: '<img src="__CANVAS_ASSET_0__"><img src="__CANVAS_ASSET_1__">',
        slide_styles: "", class_modifiers: [],
      },
      {
        position: 1,
        title: "Two",
        html_body: '<img src="__CANVAS_ASSET_2__"><img src="__CANVAS_ASSET_3__">',
        slide_styles: "", class_modifiers: [],
      },
    ],
  };
}

describe("importParsedDeck — asset dedup", () => {
  beforeEach(() => {
    assetInserts.length = 0;
    uploads.length = 0;
    slideInserts = [];
    assetIdCounter = 0;
  });

  it("mints one asset per unique content, not per occurrence", async () => {
    const result = await importParsedDeck(parsedDeckWithRepeatedLogo(), {
      workspace_id: "00000000-0000-0000-0000-0000000000aa",
      user_id: "00000000-0000-0000-0000-0000000000bb",
    });

    expect(assetInserts).toHaveLength(2);
    expect(uploads).toHaveLength(2);
    expect(result.asset_count).toBe(2);
  });

  it("points every duplicate occurrence at the first asset's URL", async () => {
    await importParsedDeck(parsedDeckWithRepeatedLogo(), {
      workspace_id: "00000000-0000-0000-0000-0000000000aa",
      user_id: "00000000-0000-0000-0000-0000000000bb",
    });

    const [one, two] = slideInserts;
    // Slide one: logo (asset 1) + photo (asset 2).
    expect(one.html_body).toContain("/api/canvas/asset/00000000-0000-0000-0000-000000000001");
    expect(one.html_body).toContain("/api/canvas/asset/00000000-0000-0000-0000-000000000002");
    // Slide two: both imgs are the logo — same URL as slide one's logo, twice.
    const logoRefs = String(two.html_body).match(
      /\/api\/canvas\/asset\/00000000-0000-0000-0000-000000000001/g,
    );
    expect(logoRefs).toHaveLength(2);
    expect(two.html_body).not.toContain("000000000003");
  });
});

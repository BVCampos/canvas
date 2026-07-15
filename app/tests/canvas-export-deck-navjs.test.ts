// nav_js is an asset surface too: a deck's nav script can reference
// /api/canvas/asset/{id} (image preloads, per-slide background swaps), and an
// un-inlined reference stays an authenticated URL — blank in the headless
// PDF/PPTX render, broken in the offline export. Guards the collectAssetIds +
// inlineAssetRefs coverage of nav_js in assembleSelfContainedDeck; the same
// family as the theme_css cover-image gap (PR #32).
import { describe, expect, it, vi } from "vitest";

const ASSET_ID = "11111111-2222-3333-4444-555555555555";

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    storage: {
      from: () => ({
        download: async () => ({
          data: new Blob([Buffer.from("PNGBYTES")]),
          error: null,
        }),
      }),
    },
  }),
}));

import { assembleSelfContainedDeck } from "@/lib/canvas/export-deck";

// Minimal thenable chain for the canvas_deck_asset lookup the assembler runs
// under the caller's client.
function assetClient() {
  return {
    from: () => ({
      select: () => ({
        in: async () => ({
          data: [
            { id: ASSET_ID, storage_path: "ws/deck/a.png", mime_type: "image/png" },
          ],
        }),
      }),
    }),
  } as never;
}

describe("assembleSelfContainedDeck — nav_js asset inlining", () => {
  it("re-inlines /api/canvas/asset references found only in nav_js", async () => {
    const { html, assetsInlined } = await assembleSelfContainedDeck(
      {
        title: "t",
        theme_css: ".slide{width:100vw}",
        nav_js: `var img = new Image(); img.src = "/api/canvas/asset/${ASSET_ID}";`,
        meta: {},
      },
      [
        {
          position: 0,
          title: "s",
          html_body: '<section class="slide">x</section>',
          slide_styles: null,
        },
      ],
      assetClient(),
    );
    expect(assetsInlined).toBe(1);
    expect(html).toContain("data:image/png;base64,");
    expect(html).not.toContain(`/api/canvas/asset/${ASSET_ID}`);
  });
});

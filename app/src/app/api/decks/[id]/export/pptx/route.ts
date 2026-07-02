// GET /api/decks/{id}/export/pptx — server-side PowerPoint export.
//
// Same capture as the PDF export: we screenshot each slide at its native size in
// headless Chromium (rasterizeDeckHtml) and assemble one full-bleed image per
// PowerPoint slide. The deck kit's zoom-scaled stage mis-reflows under any
// print/layout pass, so an image-per-slide deck is the only faithful render —
// see the PDF route header and slide-raster.ts for the full rationale.
//
// PPTX specifics:
//   - One 13.333in x 7.5in slide per deck slide (16:9 widescreen, the modern
//     PowerPoint default). The JPEG fills the slide edge-to-edge (x/y 0, w/h =
//     the slide box), so the deck's own 16:9 art maps 1:1 with no letterboxing.
//   - Each PPTX slide is NAMED with the Canvas slide's title (shows in the
//     PowerPoint slide navigator / outline). The file is named after the deck.
//   - The result is image-based (text isn't editable in PowerPoint). For a
//     visual deck that's the right trade — fidelity over editability — and it's
//     why the file opens identically everywhere, like the PDF.
//
// Auth, the pre_export snapshot, asset/font inlining, the render gate, and
// usage logging all mirror the PDF route exactly; only the assembly differs
// (pptxgenjs instead of pdf-lib).

import { NextResponse, type NextRequest } from "next/server";
import PptxGenJS from "pptxgenjs";
import { buildDeckExportHtml, sanitizeFilename } from "@/lib/canvas/export-deck";
import { logUsage } from "@/lib/usage/log";
import { renderGate } from "@/lib/canvas/render-gate";
import { rasterizeDeckHtml } from "@/lib/canvas/slide-raster";

// Headless Chromium boot + render of a many-slide deck can take a while.
export const maxDuration = 60;

// PPTX renders share the one box-wide render gate (renderGate) with the thumbnail,
// PDF, and MCP render paths — a slot is a slot regardless of which surface asked,
// so exports and thumbnails can't stack up to an OOM. Same non-blocking policy as
// the PDF route: if no slot is free, reject now rather than pile up awaiting
// requests that each hold memory and a connection.

// PowerPoint widescreen slide box, in inches. 13.333 x 7.5 is exactly 16:9.
const SLIDE_W_IN = 13.333;
const SLIDE_H_IN = 7.5;

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const started = Date.now();

  // Bound concurrent renders so two large exports can't OOM the box. Non-blocking
  // by design: if we can't get a slot, reject now rather than pile up awaiting
  // requests that each hold memory and a connection.
  if (!renderGate.tryAcquire()) {
    return new NextResponse(
      "Export busy — another PPTX is already rendering on this server. Retry in a moment.",
      { status: 429, headers: { "Retry-After": "10" } },
    );
  }

  try {
    return await renderPptx(id, started);
  } finally {
    renderGate.release();
  }
}

async function renderPptx(id: string, started: number): Promise<NextResponse> {
  const result = await buildDeckExportHtml(id);
  if (!result.ok) {
    return new NextResponse(result.message, { status: result.status });
  }

  let pptx: Uint8Array;
  try {
    // Headless Chromium launch + native-size per-slide screenshot loop. The
    // shared rasterizer closes the browser before it returns, so by the time we
    // assemble the .pptx the only memory live is the compressed JPEG bytes.
    const { shots } = await rasterizeDeckHtml(result.html);

    const pptxDoc = new PptxGenJS();
    pptxDoc.defineLayout({ name: "CANVAS_16x9", width: SLIDE_W_IN, height: SLIDE_H_IN });
    pptxDoc.layout = "CANVAS_16x9";
    // Deck-level metadata so the file identifies itself in PowerPoint's
    // Properties pane and the slide navigator title.
    pptxDoc.title = result.title;

    shots.forEach((shot, i) => {
      const slide = pptxDoc.addSlide();
      // Full-bleed image: the JPEG IS the slide. base64 with a mime prefix is
      // what pptxgenjs expects for inline image data (no temp file on disk).
      slide.addImage({
        data: `image/jpeg;base64,${Buffer.from(shot).toString("base64")}`,
        x: 0,
        y: 0,
        w: SLIDE_W_IN,
        h: SLIDE_H_IN,
      });
      // Speaker notes travel with the deliverable: the real talk track (0067)
      // when the slide has one; otherwise the Canvas slide title — the one
      // place a title stays searchable in PowerPoint (pptxgenjs 4.x has no
      // public slide-name API) — with a positional label as the last resort.
      const notes = result.slideNotes[i]?.trim();
      const title = result.slideTitles[i]?.trim();
      slide.addNotes(notes || title || `Slide ${i + 1}`);
    });

    // nodebuffer → a Node Buffer (a Uint8Array subclass) we can hand straight to
    // NextResponse without re-encoding.
    pptx = (await pptxDoc.write({ outputType: "nodebuffer" })) as Buffer;
  } catch (err) {
    console.error("[export:pptx]", err);
    logUsage({
      event: "deck.export",
      surface: "api",
      user_id: result.userId,
      workspace_id: result.workspaceId,
      deck_id: id,
      status: "error",
      duration_ms: Date.now() - started,
      error_code: "pptx_render_failed",
      // Carry the real failure text into telemetry — a generic error_code alone
      // can't distinguish a Chromium crash from a font hang from an assembly bug.
      props: { format: "pptx", slides: result.slideCount, message: String(err).slice(0, 300) },
    });
    return new NextResponse("PPTX render failed", { status: 500 });
  }

  const filename = sanitizeFilename(result.title) + ".pptx";

  logUsage({
    event: "deck.export",
    surface: "api",
    user_id: result.userId,
    workspace_id: result.workspaceId,
    deck_id: id,
    status: "ok",
    duration_ms: Date.now() - started,
    props: {
      format: "pptx",
      slides: result.slideCount,
      bytes: pptx.byteLength,
      assets_inlined: result.assetsInlined,
    },
  });

  return new NextResponse(Buffer.from(pptx), {
    status: 200,
    headers: {
      "Content-Type":
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}

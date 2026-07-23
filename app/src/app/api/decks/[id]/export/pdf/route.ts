// GET /api/decks/{id}/export/pdf — server-side PDF export.
//
// Renders the same self-contained HTML the /export route ships and returns a
// real .pdf, one slide per page, at the deck's native 16:9 size.
//
// Why we SCREENSHOT each slide and assemble images into the PDF instead of
// letting Chromium's print pipeline paginate the deck directly:
//   The 21x deck kit lays out a fixed 1920×1080 stage and scales it to the
//   viewport with the CSS `zoom` property (zoom reflows, unlike transform).
//   Chromium's printToPDF re-flows the document at the paper box, and that
//   reflow mishandles the zoom-scaled stage: flexbox columns collapse to
//   min-content (headings wrap one word per line, content jams into the
//   top-left). The SAME DOM screenshots perfectly in screen layout — only the
//   print reflow is wrong. So we capture each slide as it actually renders,
//   then place one image per page. The images are assembled into the PDF with
//   pdf-lib (pure JS) — there is NO print pass at all, so there's no flex/zoom
//   layout left for Chromium to get wrong. This is also why decks were coming
//   out cropped/shrunk before.
//
// Tradeoff: the PDF is image-based (text is not selectable). For a visual deck
// that's the right call — fidelity over selectability — and it's robust to any
// deck's CSS quirks (zoom, flex, container queries) instead of fighting them.
//
// Chromium sourcing differs by environment:
//   - EC2 (our AWS host): CHROMIUM_PATH points at a box-installed Chromium.
//     @sparticuz/chromium is x86_64-only and won't run on the Graviton/arm64
//     box, so the bootstrap installs an arm64 Chromium (via Playwright, which
//     ships arm64 Linux builds — Chrome-for-Testing does not) and exports its
//     path. Headless Chromium as a systemd service user needs --no-sandbox and
//     --disable-dev-shm-usage (EC2's /dev/shm is tiny). See app/infra.
//   - Vercel / AWS Lambda: @sparticuz/chromium ships a trimmed brotli'd
//     binary built for Amazon Linux. It (and puppeteer-core) stay external via
//     next.config.ts `serverExternalPackages`. NOTE: the AWS migration dropped
//     the `outputFileTracingIncludes` that force-bundled the brotli binary (EC2
//     uses CHROMIUM_PATH instead), so this branch is buildable but would need
//     that binary re-traced to actually run on Lambda again.
//   - Local dev: puppeteer-core resolves the system Chrome via the `chrome`
//     channel — no binary download, uses whatever Chrome the dev has.
//
// The page HTML is fully self-contained (assets are base64 data: URLs), so the
// only network a render may touch is web fonts a theme_css @imports — covered
// by the `load` wait + an explicit document.fonts.ready await before capture.
//
// The headless Chromium launch + per-slide screenshot loop now lives in
// @/lib/canvas/slide-raster (rasterizeDeckHtml) so the PPTX route and the
// render_slide MCP tool share the exact same capture. This route owns only the
// pdf-lib assembly of those shots into a one-image-per-page PDF.

import { NextResponse, type NextRequest } from "next/server";
import { PDFDocument } from "pdf-lib";
import { buildDeckExportHtml, sanitizeFilename } from "@/lib/canvas/export-deck";
import { logUsage } from "@/lib/usage/log";
import { renderGate } from "@/lib/canvas/render-gate";
import {
  rasterizeDeckHtml,
  EXPORT_DOC_SCALE,
  EXPORT_DOC_JPEG_QUALITY,
} from "@/lib/canvas/slide-raster";

// Headless Chromium boot + render of a many-slide deck can take a while;
// the Vercel default (10s on some plans) is not enough.
export const maxDuration = 60;

// PDF renders share the one box-wide render gate (renderGate) with the thumbnail,
// PPTX, and MCP render paths. Each render holds a Chromium and every slide
// screenshot in memory; two large decks at once (or a double-clicked export) is
// the OOM the pdf-lib rewrite was meant to escape. A user-initiated export takes
// the non-blocking policy: if no slot is free, reject now rather than pile up
// awaiting requests that each hold memory and a connection.

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
      "Export busy — another PDF is already rendering on this server. Retry in a moment.",
      { status: 429, headers: { "Retry-After": "10" } },
    );
  }

  try {
    return await renderPdf(id, started);
  } finally {
    renderGate.release();
  }
}

async function renderPdf(id: string, started: number): Promise<NextResponse> {
  const result = await buildDeckExportHtml(id);
  if (!result.ok) {
    return new NextResponse(result.message, { status: result.status });
  }

  let pdf: Uint8Array;
  try {
    // Headless Chromium launch + native-size per-slide screenshot loop. The
    // shared rasterizer closes the browser before it returns, so by the time we
    // assemble the PDF the only memory live is the compressed JPEG bytes.
    // Capture at the document-export resolution (1.5×/q80 by default) rather than
    // the rasterizer's 2×/q90 single-preview default: multiplied across a whole
    // deck that 2× is what made the PDF ~6MB. See EXPORT_DOC_* in slide-raster.
    const { size, shots, shotMeta } = await rasterizeDeckHtml(result.html, {
      scale: EXPORT_DOC_SCALE,
      jpegQuality: EXPORT_DOC_JPEG_QUALITY,
    });

    // Assemble with pdf-lib (pure JS) instead of a second Chromium page.
    //   The previous approach loaded all the slide JPEGs back into a fresh
    //   Chromium page and re-rendered them to PDF. At deviceScaleFactor 2 that
    //   second page held every 3840×2160 image decoded to a bitmap AT ONCE
    //   (~33MB each), on top of a still-live browser — a multi-hundred-MB spike
    //   that OOM-killed the lambda intermittently (worked warm at ~12s, died
    //   hard otherwise → a 504 with no error logged, since the process was
    //   terminated). pdf-lib embeds each JPEG as compressed bytes and never
    //   decodes them, so memory stays flat and there's no second render to
    //   mis-reflow. One image per page, page box = the native stage size.
    const doc = await PDFDocument.create();
    for (let i = 0; i < shots.length; i++) {
      const img = await doc.embedJpg(shots[i]);
      // Page box = THAT slide's own box, not the first slide's: a deck can mix
      // slide sizes, and forcing every image into one box stretched the
      // off-size ones. Fall back to the stage size if meta is missing.
      const w = shotMeta[i]?.w || size.w;
      const h = shotMeta[i]?.h || size.h;
      const pg = doc.addPage([w, h]);
      pg.drawImage(img, { x: 0, y: 0, width: w, height: h });
    }
    pdf = await doc.save();
  } catch (err) {
    console.error("[export:pdf]", err);
    logUsage({
      event: "deck.export",
      surface: "api",
      user_id: result.userId,
      workspace_id: result.workspaceId,
      deck_id: id,
      status: "error",
      duration_ms: Date.now() - started,
      error_code: "pdf_render_failed",
      // Carry the real failure text into telemetry — a generic error_code alone
      // can't distinguish a Chromium crash from a font hang from an assembly
      // bug. (A hard OOM/timeout still won't reach here; this covers the rest.)
      props: { format: "pdf", slides: result.slideCount, message: String(err).slice(0, 300) },
    });
    return new NextResponse("PDF render failed", { status: 500 });
  }

  const filename = sanitizeFilename(result.title) + ".pdf";

  logUsage({
    event: "deck.export",
    surface: "api",
    user_id: result.userId,
    workspace_id: result.workspaceId,
    deck_id: id,
    status: "ok",
    duration_ms: Date.now() - started,
    props: {
      format: "pdf",
      slides: result.slideCount,
      bytes: pdf.byteLength,
      assets_inlined: result.assetsInlined,
    },
  });

  return new NextResponse(Buffer.from(pdf), {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}

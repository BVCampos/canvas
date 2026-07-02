// The single, box-wide ceiling for EVERY headless-Chromium render — deck/slide
// thumbnails, PDF export, PPTX export, and the MCP render_* tools all acquire
// THIS gate before they rasterize.
//
// Why one gate and not four: each render surface used to own a private
// ConcurrencyGate (thumbnails 3, PDF 2, PPTX 2, MCP render 2). Each one, in
// isolation, looked like it protected the box — but they don't know about each
// other, so a thumbnail burst + a PDF export + an MCP render could put ~9
// Chromium renders in flight at once on the single small box. The per-surface
// caps bounded each surface, never the box. This module is the one ceiling that
// actually bounds the box: a slot here is a slot no matter which surface asked.
//
// The gate exposes both overflow policies (see ConcurrencyGate) and each caller
// keeps the one that fits it — thumbnails queue (runOrWait) so a deck-index
// burst drains instead of flashing 429s; user-initiated exports and MCP renders
// reject immediately (run/tryAcquire) rather than pile up awaiting requests.
//
// Cap defaults to 2 for the 2 GiB box and is env-tunable via
// RENDER_MAX_CONCURRENCY for a bigger one. It replaces the four old per-surface
// knobs (THUMBNAIL_MAX_CONCURRENCY, PDF_EXPORT_MAX_CONCURRENCY,
// PPTX_EXPORT_MAX_CONCURRENCY, MCP_RENDER_MAX_CONCURRENCY), which no longer do
// anything.
import { ConcurrencyGate } from "./concurrency-gate";

export const RENDER_MAX_CONCURRENCY = Math.max(
  1,
  Number(process.env.RENDER_MAX_CONCURRENCY) || 2,
);

export const renderGate = new ConcurrencyGate(RENDER_MAX_CONCURRENCY);

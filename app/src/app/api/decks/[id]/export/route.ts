// GET /api/decks/{id}/export — phase 6.
//
// Ships a deck as a single, self-contained HTML file. The heavy lifting
// (auth, pre_export snapshot, asset re-inlining, assembly) lives in
// lib/canvas/export-deck.ts, shared with the PDF route next door.

import { NextResponse, type NextRequest } from "next/server";
import { buildDeckExportHtml, sanitizeFilename } from "@/lib/canvas/export-deck";
import { logUsage } from "@/lib/usage/log";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const result = await buildDeckExportHtml(id);
  if (!result.ok) {
    return new NextResponse(result.message, { status: result.status });
  }

  const filename = sanitizeFilename(result.title) + ".html";

  logUsage({
    event: "deck.export",
    surface: "api",
    user_id: result.userId,
    workspace_id: result.workspaceId,
    deck_id: id,
    status: "ok",
    props: {
      format: "html",
      slides: result.slideCount,
      bytes: result.html.length,
      assets_inlined: result.assetsInlined,
    },
  });

  return new NextResponse(result.html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}

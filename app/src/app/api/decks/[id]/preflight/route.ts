// GET /api/decks/{id}/preflight — deterministic pre-flight audit of the
// rendered deck (docs/discovery/ideas/08-preflight-check.md, v0).
//
// One render-shaped pass, no screenshots: assemble the same self-contained
// HTML the exports ship (WITHOUT the pre_export snapshot — checking must not
// mint restore points), load it once in the shared Chromium behind the same
// box-wide render gate, and measure. Returns the findings ephemeral — v0
// stores nothing; a finding is only ever "as of now".
//
// Authorization mirrors the export routes exactly: buildDeckExportHtml reads
// the deck under the caller's RLS client, so a deck the user can't read 404s
// before any Chromium work happens.

import { NextResponse, type NextRequest } from "next/server";
import { buildDeckExportHtml } from "@/lib/canvas/export-deck";
import { runPreflightAudit } from "@/lib/canvas/preflight-audit";
import { renderGate } from "@/lib/canvas/render-gate";
import { logUsage } from "@/lib/usage/log";

// Chromium boot + a many-slide deck can take a moment (far less than PDF —
// no screenshot array — but the same order of magnitude on a cold pool).
export const maxDuration = 60;

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const started = Date.now();

  // User-initiated button: reject-busy like the exports, never queue.
  if (!renderGate.tryAcquire()) {
    return NextResponse.json(
      {
        ok: false,
        error:
          "The renderer is busy with another export. Try again in a moment.",
      },
      { status: 429, headers: { "Retry-After": "10" } },
    );
  }

  try {
    const build = await buildDeckExportHtml(id, { snapshot: false });
    if (!build.ok) {
      return NextResponse.json(
        { ok: false, error: build.message },
        { status: build.status },
      );
    }

    const report = await runPreflightAudit(build.html);

    logUsage({
      event: "deck.preflight",
      surface: "api",
      user_id: build.userId,
      workspace_id: build.workspaceId,
      deck_id: id,
      duration_ms: Date.now() - started,
      props: {
        findings: report.findings.length,
        blockers: report.findings.filter((f) => f.severity === "blocker").length,
        slide_count: report.slideCount,
      },
    });

    return NextResponse.json(
      { ok: true, report },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    console.error("[preflight]", err);
    logUsage({
      event: "deck.preflight",
      surface: "api",
      deck_id: id,
      status: "error",
      duration_ms: Date.now() - started,
      error_code: err instanceof Error ? err.name : "unknown",
    });
    return NextResponse.json(
      { ok: false, error: "Pre-flight render failed." },
      { status: 500 },
    );
  } finally {
    renderGate.release();
  }
}

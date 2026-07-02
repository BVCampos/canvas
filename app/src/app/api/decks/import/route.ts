// POST /api/decks/import — phase 1.
//
// Accepts a multipart/form-data body with:
//   - title: text (required)
//   - source: file (optional; if missing, an empty deck is created)
//
// On success returns 303 to /canvases/{id}. On failure, redirects back to
// /canvases/new with a `?error=...` query string the form can surface.

import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { importDeckFromHtml, importParsedDeck } from "@/lib/canvas/importer";
import { parseDeckHtml } from "@/lib/canvas/parser";
import { blankDeckHtml } from "@/lib/canvas/blank-deck";
import { getDeckTemplate } from "@/lib/canvas/deck-templates";
import { ACTIVE_WORKSPACE_COOKIE } from "@/lib/auth/workspace";
import { logUsage } from "@/lib/usage/log";
import { rateLimitOk } from "@/lib/canvas/rate-limit";
import { appOrigin } from "@/lib/app-url";

const MAX_HTML_BYTES = 10 * 1024 * 1024; // 10 MB; the seed deck is ~560KB.

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.redirect(new URL("/login?next=/canvases/new", appOrigin(request)), {
      status: 303,
    });
  }

  // Resolve the active workspace the same way getActiveWorkspace does: prefer
  // the canvas_active_workspace cookie if it names a workspace the user is
  // still a member of, otherwise fall back to the oldest membership.
  const { data: memberships } = await supabase
    .from("workspace_memberships")
    .select("workspace_id, joined_at")
    .eq("user_id", user.id)
    .order("joined_at", { ascending: true });

  if (!memberships || memberships.length === 0) {
    return NextResponse.redirect(new URL("/no-workspace", appOrigin(request)), { status: 303 });
  }

  const preferredId = request.cookies.get(ACTIVE_WORKSPACE_COOKIE)?.value;
  const membership =
    memberships.find((m) => m.workspace_id === preferredId) ?? memberships[0];

  // Per-user import rate limit — imports are heavy (HTML parse + asset uploads);
  // this only stops abuse/runaway, not normal use.
  if (!(await rateLimitOk(createAdminClient(), `import:${user.id}`, 20, 60))) {
    return redirectBack(request, "rate_limited");
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch (err) {
    return redirectBack(request, "invalid_form", err);
  }

  const title = (form.get("title") as string | null)?.trim() ?? "";
  if (!title) {
    return redirectBack(request, "missing_title");
  }

  // Visibility: optional. Anything other than 'private' falls back to the
  // workspace default so a malformed form never accidentally locks a deck.
  const rawVisibility = form.get("visibility");
  const visibility: "workspace" | "private" =
    rawVisibility === "private" ? "private" : "workspace";

  // Project: optional. The form only offers projects the user can see, so a
  // value that doesn't resolve inside the active workspace means a stale form
  // or tampering — fail loud rather than silently minting an ungrouped deck.
  // The lookup runs on the RLS client, so it doubles as the membership check
  // the admin-client importer can't do itself.
  const rawProject = form.get("project_id");
  let project_id: string | null = null;
  if (typeof rawProject === "string" && rawProject.trim() !== "") {
    const { data: project, error: projectErr } = await supabase
      .from("canvas_project")
      .select("id")
      .eq("id", rawProject.trim())
      .eq("workspace_id", membership.workspace_id)
      .maybeSingle();
    if (projectErr || !project) {
      return redirectBack(request, "invalid_project", projectErr);
    }
    project_id = project.id;
  }

  const source = form.get("source");
  const hasFile =
    source instanceof File && typeof source.size === "number" && source.size > 0;

  // Paste-HTML path: the New Deck form has a tabs control that swaps the
  // file input for a textarea named `source_html`. When the textarea is the
  // active source, the file field carries no value. The byte cap mirrors
  // the file path so neither input can wedge the parser with absurd input.
  const pastedHtmlRaw =
    typeof form.get("source_html") === "string" ? (form.get("source_html") as string) : "";
  const pastedHtml = pastedHtmlRaw.trim();
  const hasPaste = pastedHtml.length > 0;

  // Starter-template path: the form submits a template id, which we resolve to
  // in-repo seed HTML built with the real title (so the cover matches). Flows
  // through the same parser as file/paste.
  const templateId =
    typeof form.get("source_template") === "string"
      ? (form.get("source_template") as string).trim()
      : "";
  const template = templateId ? getDeckTemplate(templateId) : undefined;

  const started = Date.now();
  try {
    if (hasFile) {
      const file = source as File;
      if (file.size > MAX_HTML_BYTES) {
        logUsage({
          event: "deck.import",
          surface: "api",
          user_id: user.id,
          workspace_id: membership.workspace_id,
          status: "denied",
          duration_ms: Date.now() - started,
          error_code: "file_too_large",
          props: { had_file: true, file_size: file.size },
        });
        return redirectBack(request, "file_too_large");
      }
      const html = await file.text();
      // Parse here so we can override title before the importer commits.
      const parsed = parseDeckHtml(html);
      // Fail loud rather than minting a blank deck. A zero-slide parse means
      // the file didn't match any of the parser's slide shapes — surfacing
      // that beats silently redirecting the user to an empty deck.
      if (parsed.slides.length === 0) {
        logUsage({
          event: "deck.import",
          surface: "api",
          user_id: user.id,
          workspace_id: membership.workspace_id,
          status: "denied",
          duration_ms: Date.now() - started,
          error_code: "no_slides",
          props: { had_file: true, file_size: file.size },
        });
        return redirectBack(request, "no_slides");
      }
      parsed.title = title;
      const result = await importParsedDeck(parsed, {
        workspace_id: membership.workspace_id,
        user_id: user.id,
        title,
        visibility,
        project_id,
      });
      logUsage({
        event: "deck.import",
        surface: "api",
        user_id: user.id,
        workspace_id: membership.workspace_id,
        deck_id: result.deck_id,
        status: "ok",
        duration_ms: Date.now() - started,
        props: {
          had_file: true,
          file_size: file.size,
          slides: result.slide_count,
          assets: result.asset_count,
        },
      });
      return NextResponse.redirect(new URL(`/canvases/${result.deck_id}`, appOrigin(request)), { status: 303 });
    }

    if (hasPaste) {
      // Pasted HTML flows through the same parser/importer as the upload
      // path; only the source is different. We measure bytes via UTF-8
      // length since the textarea is JS string-typed (vs the File's raw
      // octets above).
      const pasteSize = new TextEncoder().encode(pastedHtml).length;
      if (pasteSize > MAX_HTML_BYTES) {
        logUsage({
          event: "deck.import",
          surface: "api",
          user_id: user.id,
          workspace_id: membership.workspace_id,
          status: "denied",
          duration_ms: Date.now() - started,
          error_code: "source_too_large",
          props: { had_paste: true, paste_size: pasteSize },
        });
        return redirectBack(request, "source_too_large");
      }
      const parsed = parseDeckHtml(pastedHtml);
      if (parsed.slides.length === 0) {
        logUsage({
          event: "deck.import",
          surface: "api",
          user_id: user.id,
          workspace_id: membership.workspace_id,
          status: "denied",
          duration_ms: Date.now() - started,
          error_code: "no_slides",
          props: { had_paste: true, paste_size: pasteSize },
        });
        return redirectBack(request, "no_slides");
      }
      parsed.title = title;
      const result = await importParsedDeck(parsed, {
        workspace_id: membership.workspace_id,
        user_id: user.id,
        title,
        visibility,
        project_id,
      });
      logUsage({
        event: "deck.import",
        surface: "api",
        user_id: user.id,
        workspace_id: membership.workspace_id,
        deck_id: result.deck_id,
        status: "ok",
        duration_ms: Date.now() - started,
        props: {
          had_paste: true,
          paste_size: pasteSize,
          slides: result.slide_count,
          assets: result.asset_count,
        },
      });
      return NextResponse.redirect(
        new URL(`/canvases/${result.deck_id}`, appOrigin(request)),
        { status: 303 },
      );
    }

    if (template) {
      // Seed HTML is authored in-repo, so a zero-slide parse is a bug, not user
      // input — but guard anyway rather than silently mint a blank deck.
      const html = template.build(title);
      const parsed = parseDeckHtml(html);
      if (parsed.slides.length === 0) {
        return redirectBack(request, "no_slides");
      }
      parsed.title = title;
      const result = await importParsedDeck(parsed, {
        workspace_id: membership.workspace_id,
        user_id: user.id,
        title,
        visibility,
        project_id,
      });
      logUsage({
        event: "deck.import",
        surface: "api",
        user_id: user.id,
        workspace_id: membership.workspace_id,
        deck_id: result.deck_id,
        status: "ok",
        duration_ms: Date.now() - started,
        props: { template: templateId, slides: result.slide_count, assets: result.asset_count },
      });
      return NextResponse.redirect(
        new URL(`/canvases/${result.deck_id}`, appOrigin(request)),
        { status: 303 },
      );
    }

    // Blank deck: synthesise a minimal HTML and import it. Cheap and keeps the
    // code path uniform — every deck flows through the parser. The empty-state
    // CTA used to live in this seed but moved to a live overlay on the deck
    // view — see `EmptyDeckCta` in deck-workspace.tsx.
    const seed = blankDeckHtml(title);
    const result = await importDeckFromHtml(seed, {
      workspace_id: membership.workspace_id,
      user_id: user.id,
      title,
      visibility,
      project_id,
    });
    logUsage({
      event: "deck.import",
      surface: "api",
      user_id: user.id,
      workspace_id: membership.workspace_id,
      deck_id: result.deck_id,
      status: "ok",
      duration_ms: Date.now() - started,
      props: { had_file: false, slides: result.slide_count, assets: result.asset_count },
    });
    return NextResponse.redirect(new URL(`/canvases/${result.deck_id}`, appOrigin(request)), { status: 303 });
  } catch (err) {
    logUsage({
      event: "deck.import",
      surface: "api",
      user_id: user.id,
      workspace_id: membership.workspace_id,
      status: "error",
      duration_ms: Date.now() - started,
      error_code: err instanceof Error ? err.name : "Error",
      props: { had_file: hasFile },
    });
    return redirectBack(request, "import_failed", err);
  }
}

function redirectBack(request: NextRequest, code: string, err?: unknown): NextResponse {
  if (err) {
    console.error("[/api/decks/import]", code, err);
  }
  const url = new URL("/canvases/new", appOrigin(request));
  url.searchParams.set("error", code);
  return NextResponse.redirect(url, { status: 303 });
}

// blankDeckHtml + its escapeHtml moved to @/lib/canvas/blank-deck so the MCP
// create_deck tool can produce identical greenfield decks.

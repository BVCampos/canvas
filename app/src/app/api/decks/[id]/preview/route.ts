// GET /api/decks/{id}/preview — phase 2.
//
// Assembles the deck's theme + ordered slides + nav into a single HTML
// response that the deck page renders inside an iframe. Cache-Control is
// `no-store` so every iframe refresh sees the latest state. Auth is the
// signed-in user; RLS gates membership.

import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { assembleDeckHtml } from "@/lib/canvas/assemble";
import { assetSigQuery } from "@/lib/canvas/asset-sign";
import { stripDrawOverlay } from "@/lib/canvas/draw/scene";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const supabase = await createClient();

  // Explicit auth check: RLS would already hide the row from anonymous callers
  // (resulting in 404), but returning 401 surfaces the real reason and lets
  // the iframe parent decide whether to redirect to login.
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return new NextResponse("Unauthorized", { status: 401 });

  const { data: deck, error: deckErr } = await supabase
    .from("canvas_deck")
    .select("title, theme_css, nav_js, meta")
    .eq("id", id)
    .maybeSingle();

  if (deckErr) {
    console.error("[preview]", deckErr);
    return new NextResponse("Deck lookup failed", { status: 500 });
  }
  if (!deck) return new NextResponse("Not found", { status: 404 });

  const { data: slides, error: slidesErr } = await supabase
    .from("canvas_deck_slide")
    .select("id, position, title, html_body, slide_styles")
    .eq("deck_id", id)
    .order("position", { ascending: true });

  if (slidesErr) {
    console.error("[preview:slides]", slidesErr);
    return new NextResponse("Slide lookup failed", { status: 500 });
  }

  // Inline proposal preview: when ?proposalId=... is on the URL and the row is
  // still pending under this deck, render the deck as it would look if the
  // proposal were applied. Stale / hidden / wrong-deck rows fall through to
  // the unmodified deck — caller may be on an out-of-date URL.
  //
  // Version preview: when ?versionId=... is on the URL, render the deck with
  // the named slide swapped to that historical version's content. Used by the
  // History page to preview a slide before restoring. Falls through silently
  // if the version doesn't exist or belongs to a different deck.
  const proposalId = request.nextUrl.searchParams.get("proposalId");
  const versionId = request.nextUrl.searchParams.get("versionId");
  // Present mode (/canvases/{id}/present) asks for the deck without the deck's
  // "click to edit" hint overlay — that affordance is editor-only (edits happen
  // via Claude/MCP), and surfacing it on a projector reads as a broken control.
  // assembleDeckHtml already knows how to suppress it; the flag is purely
  // additive and defaults off so the editor preview is unchanged.
  const present = request.nextUrl.searchParams.get("present") === "1";
  // Backdrop mode (?slideId=…): render just ONE slide, filling the frame with no
  // nav chrome. The draw surface loads this behind its drawing canvas so you can
  // sketch an overlay directly over the real, asset-signed slide render (the
  // fidelity a client-built srcDoc can't reach, since it can't sign asset URLs).
  const onlySlideId = request.nextUrl.searchParams.get("slideId");
  // ?stripOverlay=1 (only meaningful with slideId): drop the slide's saved
  // drawing overlay from the render. When RE-editing an annotation the draw
  // surface paints the editable scene itself, so a backdrop that still carries
  // the saved copy would ghost every move/delete until save. slideId mode stays
  // a faithful render without the flag.
  const stripOverlay = request.nextUrl.searchParams.get("stripOverlay") === "1";
  let themeCss = deck.theme_css ?? "";
  let navJs = deck.nav_js ?? "";
  let effectiveSlides = slides ?? [];

  if (proposalId) {
    const { data: edit } = await supabase
      .from("canvas_deck_edit")
      .select("id, slide_id, kind, new_content, new_slide_payload")
      .eq("id", proposalId)
      .eq("deck_id", id)
      .eq("status", "pending")
      .maybeSingle();

    if (edit) {
      if (edit.kind === "theme_css") {
        themeCss = edit.new_content;
      } else if (edit.kind === "nav_js") {
        navJs = edit.new_content;
      } else if (
        edit.kind === "slide_html" ||
        edit.kind === "slide_styles" ||
        edit.kind === "slide_title"
      ) {
        const targetIdx = effectiveSlides.findIndex((s) => s.id === edit.slide_id);
        if (targetIdx !== -1) {
          const patched = { ...effectiveSlides[targetIdx] };
          if (edit.kind === "slide_html") patched.html_body = edit.new_content;
          else if (edit.kind === "slide_styles") patched.slide_styles = edit.new_content;
          else patched.title = edit.new_content;
          effectiveSlides = [
            ...effectiveSlides.slice(0, targetIdx),
            patched,
            ...effectiveSlides.slice(targetIdx + 1),
          ];
        }
      } else if (edit.kind === "slide_edit") {
        // Bundled edit: the changed fields ride new_slide_payload (not
        // new_content). Mirror canvas_apply_edit's slide_edit merge so the Lens
        // overlay matches what approval would produce — a field PRESENT in the
        // payload overrides the slide (incl. an explicit "" clear); an ABSENT
        // field keeps the slide's current value.
        const targetIdx = effectiveSlides.findIndex((s) => s.id === edit.slide_id);
        const payload = (edit.new_slide_payload ?? null) as {
          html_body?: string;
          slide_styles?: string;
          title?: string;
        } | null;
        if (targetIdx !== -1 && payload) {
          const patched = { ...effectiveSlides[targetIdx] };
          if (typeof payload.html_body === "string") patched.html_body = payload.html_body;
          if (typeof payload.slide_styles === "string") patched.slide_styles = payload.slide_styles;
          if (typeof payload.title === "string") patched.title = payload.title;
          effectiveSlides = [
            ...effectiveSlides.slice(0, targetIdx),
            patched,
            ...effectiveSlides.slice(targetIdx + 1),
          ];
        }
      } else if (edit.kind === "slide_create") {
        // New-slide preview: insert the proposed slide at its position so the
        // Lens overlay shows the deck WITH the new slide, exactly as approval
        // would leave it. The reviewer wipes it against the slide currently at
        // that position (the base frame). Positions are renumbered to stay
        // sequential so each <section> gets a unique data-canvas-position (the
        // in-deck controller navigates by position index).
        const payload = (edit.new_slide_payload ?? null) as {
          position?: number;
          title?: string;
          html_body?: string;
          slide_styles?: string;
        } | null;
        if (payload && typeof payload.html_body === "string") {
          const insertAt = Math.max(
            0,
            Math.min(
              typeof payload.position === "number"
                ? payload.position
                : effectiveSlides.length,
              effectiveSlides.length,
            ),
          );
          effectiveSlides = [
            ...effectiveSlides.slice(0, insertAt),
            {
              id: `proposed-${edit.id}`,
              position: insertAt,
              title: payload.title ?? "",
              html_body: payload.html_body,
              slide_styles: payload.slide_styles ?? "",
            },
            ...effectiveSlides.slice(insertAt),
          ].map((s, i) => ({ ...s, position: i }));
        }
      }
    }
  } else if (versionId) {
    const { data: version } = await supabase
      .from("canvas_slide_version")
      .select("slide_id, deck_id, title, html_body, slide_styles")
      .eq("id", versionId)
      .eq("deck_id", id)
      .maybeSingle();

    if (version) {
      const targetIdx = effectiveSlides.findIndex((s) => s.id === version.slide_id);
      if (targetIdx !== -1) {
        effectiveSlides = [
          ...effectiveSlides.slice(0, targetIdx),
          {
            ...effectiveSlides[targetIdx],
            title: version.title,
            html_body: version.html_body,
            slide_styles: version.slide_styles,
          },
          ...effectiveSlides.slice(targetIdx + 1),
        ];
      }
    }
  }

  // Narrow to the one requested slide LAST, after any proposal/version patching,
  // so a backdrop reflects those too. A single-slide deck renders with no nav
  // chrome (assembleDeckHtml drops it under length 1) and fills the frame.
  if (onlySlideId) {
    effectiveSlides = effectiveSlides.filter((s) => s.id === onlySlideId);
    // A vanished slide (deleted between the caller capturing the id and this
    // render) is a 404, not an empty deck shell pretending to be the backdrop.
    if (effectiveSlides.length === 0) {
      return new NextResponse("Slide not found", { status: 404 });
    }
    if (stripOverlay) {
      effectiveSlides = effectiveSlides.map((s) => ({
        ...s,
        html_body: stripDrawOverlay(s.html_body),
      }));
    }
  }

  const html = assembleDeckHtml({
    title: deck.title,
    theme_css: themeCss,
    nav_js: navJs,
    meta: (deck.meta ?? {}) as Record<string, unknown>,
    slides: effectiveSlides,
    mode: "preview",
    // The backdrop is a clean canvas to draw over — never show the edit hint.
    suppressEditHint: present || Boolean(onlySlideId),
  });

  // The preview iframe is sandboxed to an opaque origin, so its <img> requests
  // to /api/canvas/asset/{id} won't carry the auth cookie. Sign each asset URL
  // (this route already passed RLS for the deck) so the asset route can serve
  // them without the cookie. See lib/canvas/asset-sign.ts.
  const now = Date.now();
  const signedHtml = html.replace(
    /\/api\/canvas\/asset\/([0-9a-fA-F-]{36})(?![0-9a-fA-F-])/g,
    (full, assetId: string) => `${full}?${assetSigQuery(assetId, now)}`,
  );

  return new NextResponse(signedHtml, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      // Allow the iframe in the deck page to load this on the same origin.
      "X-Frame-Options": "SAMEORIGIN",
      // SECURITY: this document is untrusted deck HTML. The `sandbox` CSP
      // directive forces it into an opaque origin (scripts may run, but cannot
      // touch the app's cookies/localStorage or same-origin endpoints) — even
      // when opened TOP-LEVEL (e.g. the History "Preview in new tab" link),
      // where the iframe `sandbox` attribute would not apply. `allow-scripts`
      // keeps deck nav working; deliberately no `allow-same-origin`.
      "Content-Security-Policy": "sandbox allow-scripts allow-popups;",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

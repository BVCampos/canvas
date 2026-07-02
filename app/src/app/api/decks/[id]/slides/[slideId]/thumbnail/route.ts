// GET /api/decks/{id}/slides/{slideId}/thumbnail — a small rendered preview of
// ONE slide, so the proposal-review surfaces (the inbox list + the per-slide
// chip) can show what a change looks like without the reviewer opening every
// proposal. Returns a JPEG.
//
// Why this exists as an on-demand route and not a stored thumbnail pipeline:
//   A reviewer triages a queue at a glance. They need a picture of the slide
//   each proposal touches, in the state the proposal would produce. Minting and
//   storing a thumbnail on every edit (a write pipeline + a migration) is far
//   more machinery than the job needs — the render is deterministic per
//   (slide content) and the result is immutable per version, so we render
//   on demand and let the HTTP cache make each version's thumbnail cost at most
//   one render. No migration, no storage writes.
//
// What it renders, by query param (mirrors the preview route's selection so a
// thumbnail matches the inline preview pixel-for-pixel):
//   - ?proposalId=<id> — the slide AS the pending proposal would leave it
//     (slide_html / slide_styles / slide_title via new_content; the bundled
//     slide_edit via new_slide_payload). The reviewer's common case.
//   - ?versionId=<id>  — a specific historical slide version (e.g. previewing a
//     restore from History). Immutable, so it gets a long immutable cache.
//   - neither          — the slide's CURRENT stored content.
//
// We assemble a SINGLE-SLIDE self-contained deck (assembleSelfContainedDeck with
// just the target slide) and rasterize it — NOT the whole deck. rasterizeDeckHtml
// returns one shot per slide, so a one-slide deck yields exactly the shot we
// want, at a fraction of a full-deck render's cost. Assets and fonts are inlined
// so the headless render touches no authenticated route, identical to the
// PDF/PPTX exports.
//
// Auth: cookie + RLS, same as the preview route. The select on canvas_deck /
// canvas_deck_slide is gated by workspace membership; a non-member 404s. We
// return an explicit 401 when there's no signed-in user so the <img> fails fast
// (the components fall back to a placeholder on any non-200).
//
// Concurrency: the render launches a headless Chromium, the same memory-heavy
// operation the PDF export bounds with a ConcurrencyGate. The deck index and a
// page full of proposal rows BOTH fire every thumbnail at once on mount — the
// exact burst that OOMs the box without a cap. But unlike a heavy one-off export,
// these are many small renders that all genuinely want to happen now, so we use
// the gate's BLOCKING runOrWait: overflow waits briefly in a bounded FIFO queue
// and renders in turn, instead of being shed with an instant 429. A waiter holds
// no Chromium (only the already-loaded slide data + a promise), so peak
// concurrency is identical to instant-reject and peak memory is essentially
// unchanged — a parked request holds KBs of slide data, not a Chromium — while we
// trade a wall of 429s for a short wait. Only when the queue itself is full or the
// wait times out do we 429, and the cache means we render each version at most once.
// (The deck-list <img> also retries a 429 client-side, so the rare shed request
// still recovers.)

import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { assembleSelfContainedDeck } from "@/lib/canvas/export-deck";
import { rasterizeDeckHtml } from "@/lib/canvas/slide-raster";
import { renderGate } from "@/lib/canvas/render-gate";
import { previewProposalOnSlide } from "@/lib/canvas/proposal-preview";

// A headless Chromium boot + single-slide screenshot is quick, but still well
// above the serverless default on some plans.
export const maxDuration = 30;

// Thumbnails are small — render at 1x (no retina) and a lower JPEG quality. A
// review surface shows them at ~160px wide; the export's 2x/q90 is wasted bytes
// and wasted render time here. ~480px of detail is plenty for a triage glance.
const THUMB_SCALE = 1;
const THUMB_JPEG_QUALITY = 70;

// Thumbnail renders share the one box-wide render gate (renderGate) with the PDF,
// PPTX, and MCP render paths — the single ceiling that actually bounds how many
// Chromium renders run at once, instead of four private caps that could stack. A
// grid of proposal rows fires a burst of these, so thumbnails take the queueing
// (runOrWait) overflow policy: they park and drain rather than flash 429s.

// Non-negative integer env knob, or the fallback when unset/blank/garbage. Unlike
// `Number(x) || fallback`, an explicit "0" is honored (so a caller — or a test —
// can force the old instant-reject behaviour with THUMBNAIL_QUEUE_WAIT_MS=0).
function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

// Wait-queue tuning, read per-request so tests (and ops) can override without a
// process restart. maxWaitMs: how long a thumbnail request waits for a render
// slot before giving up with a 429 — well under maxDuration (30s), long enough to
// drain a full deck-index burst at the render gate's width. maxQueue: how many requests may park
// at once before the rest are shed (the client retries those).
function thumbQueueOpts() {
  return {
    maxWaitMs: envInt("THUMBNAIL_QUEUE_WAIT_MS", 7000),
    maxQueue: envInt("THUMBNAIL_QUEUE_MAX", 32),
  };
}

// A slide-content snapshot the assembler can render: just the fields a
// single-slide deck needs.
type ThumbSlide = {
  position: number;
  title: string;
  html_body: string;
  slide_styles: string | null;
};

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; slideId: string }> },
) {
  const { id, slideId } = await params;
  const supabase = await createClient();

  // Explicit 401 (RLS would otherwise 404 an anonymous caller); the <img> falls
  // back to a placeholder on any non-200, so a fast, honest status is enough.
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return new NextResponse("Unauthorized", { status: 401 });

  // Load the deck (theme + nav + meta drive the slide's look) and the target
  // slide under the user's RLS. A non-member, or a slide that isn't in this
  // deck, comes back null → 404. This is the access gate; everything past here
  // has been confirmed readable by the caller.
  const { data: deck, error: deckErr } = await supabase
    .from("canvas_deck")
    .select("title, theme_css, nav_js, meta")
    .eq("id", id)
    .maybeSingle();
  if (deckErr) {
    console.error("[thumbnail:deck]", deckErr);
    return new NextResponse("Deck lookup failed", { status: 500 });
  }
  if (!deck) return new NextResponse("Not found", { status: 404 });

  const { data: slide, error: slideErr } = await supabase
    .from("canvas_deck_slide")
    .select("id, title, html_body, slide_styles")
    .eq("id", slideId)
    .eq("deck_id", id)
    .maybeSingle();
  if (slideErr) {
    console.error("[thumbnail:slide]", slideErr);
    return new NextResponse("Slide lookup failed", { status: 500 });
  }
  if (!slide) return new NextResponse("Not found", { status: 404 });

  // Start from the slide's current stored content; position is always 0 — a
  // single-slide deck. The proposal / version branches below overwrite the
  // content fields in place (same precedence the preview route uses).
  const target: ThumbSlide = {
    position: 0,
    title: (slide.title as string | null) ?? "",
    html_body: slide.html_body as string,
    slide_styles: (slide.slide_styles as string | null) ?? null,
  };

  // Whether the rendered content is immutable (a named version can never
  // change) so we can cache it forever, or mutable (current state / a pending
  // proposal that could be edited or withdrawn) so we cache only briefly.
  let immutable = false;

  const proposalId = request.nextUrl.searchParams.get("proposalId");
  const versionId = request.nextUrl.searchParams.get("versionId");

  if (proposalId) {
    // Render the slide as the PENDING proposal would leave it. Mirrors the
    // preview route's patching exactly so the thumbnail matches the inline
    // preview: a content field present in the proposal overrides the slide; an
    // absent field keeps the current value. Stale / wrong-deck / wrong-slide /
    // non-pending rows fall through to the current content (the caller may hold
    // an out-of-date URL).
    const { data: edit } = await supabase
      .from("canvas_deck_edit")
      .select("slide_id, kind, new_content, new_slide_payload")
      .eq("id", proposalId)
      .eq("deck_id", id)
      .eq("status", "pending")
      .maybeSingle();

    if (edit && edit.slide_id === slideId) {
      // Merge the proposal over the current slide exactly the way render_proposal
      // and canvas_apply_edit do (shared helper, so the three never drift). A
      // theme/nav/structural kind returns null → target stays the current
      // content, so its thumbnail is just the slide.
      const patched = previewProposalOnSlide(
        {
          title: target.title,
          html_body: target.html_body,
          slide_styles: target.slide_styles,
        },
        {
          kind: edit.kind as string,
          new_content: (edit.new_content as string | null) ?? null,
          new_slide_payload:
            (edit.new_slide_payload as {
              html_body?: string;
              slide_styles?: string;
              title?: string;
            } | null) ?? null,
        },
      );
      if (patched) {
        target.title = patched.title;
        target.html_body = patched.html_body;
        target.slide_styles = patched.slide_styles;
      }
    }
  } else if (versionId) {
    // Render a specific historical version of this slide. Falls through silently
    // to the current content when the version doesn't exist or belongs to a
    // different deck/slide.
    const { data: version } = await supabase
      .from("canvas_slide_version")
      .select("slide_id, title, html_body, slide_styles")
      .eq("id", versionId)
      .eq("deck_id", id)
      .maybeSingle();

    if (version && version.slide_id === slideId) {
      target.title = (version.title as string | null) ?? "";
      target.html_body = version.html_body as string;
      target.slide_styles = (version.slide_styles as string | null) ?? null;
      // A named version's content is frozen — safe to cache forever.
      immutable = true;
    }
  }

  // Assemble a SELF-CONTAINED single-slide deck (assets + fonts inlined) so the
  // headless render reaches no authenticated route, then rasterize it behind the
  // gate. One slide in → exactly one shot out.
  const outcome = await renderGate.runOrWait(async () => {
    const { html } = await assembleSelfContainedDeck(
      {
        title: deck.title as string,
        theme_css: (deck.theme_css as string | null) ?? "",
        nav_js: (deck.nav_js as string | null) ?? "",
        meta: (deck.meta as Record<string, unknown> | null) ?? {},
      },
      [target],
      supabase,
    );
    const { shots } = await rasterizeDeckHtml(html, {
      scale: THUMB_SCALE,
      jpegQuality: THUMB_JPEG_QUALITY,
    });
    if (shots.length === 0) throw new Error("no slide rendered");
    return shots[0];
  }, thumbQueueOpts());

  if (!outcome.ok) {
    // Waited out the queue (or it was already full) without getting a render
    // slot — shed this one rather than hold a connection any longer. The
    // deck-list <img> retries on its own, so a shed request still recovers.
    return new NextResponse(
      "Thumbnail render busy — retry in a moment.",
      { status: 429, headers: { "Retry-After": "5" } },
    );
  }
  const jpeg = outcome.value;

  return new NextResponse(Buffer.from(jpeg), {
    status: 200,
    headers: {
      "Content-Type": "image/jpeg",
      // A named version's content is frozen, so its thumbnail can be cached
      // forever (the URL carries the version id, so a new version = a new URL).
      // Current-state / pending-proposal thumbnails can change (an edit lands, a
      // proposal is revised), so cache them only briefly — long enough that a
      // page re-render or a quick scroll-back reuses the bytes, short enough that
      // the next visit re-renders fresh. `private` because the bytes are
      // workspace-scoped; no shared/CDN caching.
      "Cache-Control": immutable
        ? "private, max-age=31536000, immutable"
        : "private, max-age=60",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

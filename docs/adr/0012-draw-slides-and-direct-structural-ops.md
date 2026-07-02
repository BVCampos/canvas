# ADR-0012 — Draw-on-canvas slides + direct structural slide ops

**Status:** accepted  
**Date:** 2026-06-30  
**Extends:** ADR-0002 (deck decomposition), ADR-0005 (versioning)

## Context

Two in-app capabilities were missing from the editor:

1. **Reorder the storytelling.** The left rail listed slides but offered no way
   to change their order — you had to ask an agent (`propose_reorder_slides`)
   and approve the proposal. For the deck's own editor, dragging slides should
   just work.
2. **Sketch a slide.** There was no way to make a freehand / diagram slide
   inside Canvas (Excalidraw-style). A drawing also needs a representation that
   survives the existing render → export → thumbnail pipeline unchanged.

Until now the **only** writers of slide structure were `canvas_apply_edit`
(approving a `slide_create` / `slide_reorder` / `slide_delete` proposal) and the
direct **content** path `canvas_save_slide_direct` (ADR-0005 / migration 0033).
Routing every drag and every sketch through a proposal the same person then
self-approves is clunky, and the propose-first rule exists for a reason that
doesn't apply here.

## Decision

### A. A drawn slide is just SVG in `html_body`

A drawing is serialized to an `<svg viewBox="0 0 1280 720">` (the same 16:9 sheet
the PPTX/PDF export normalizes to) inside a normal
`<section class="slide canvas-draw-slide">`. Because the artifact is plain HTML,
**no pipeline changes are needed** — the preview iframe, PDF/PPTX export, deck
thumbnails, and the public viewer all render it as-is.

To keep a drawing **re-editable**, the structured scene (the element list) is
stashed URL-encoded on a `data-canvas-scene` attribute on the section; reopening
the surface decodes it back. The scene is the editing source of truth — a slide
whose payload was hand-edited away simply isn't offered "Edit drawing".

The drawing surface (`draw-canvas.tsx`) is **host-side React**, not a new mode in
the in-iframe `CANVAS_EDITOR` island, because the headline use is creating a
**new** slide (there is no slide to edit in place yet), and the serialization
core (`lib/canvas/draw/scene.ts`: scene → SVG, encode/decode, hit-testing) stays
pure and unit-tested. The committed scene is painted with the exact serializer
the saved slide uses, so there is zero WYSIWYG drift between editing and output.

### A′. Draw OVER an existing slide (an overlay layer)

A whole-slide drawing *is* the slide. Drawing over an existing HTML slide is the
same surface pointed at a different target: the scene serializes to an
absolutely-positioned `<svg class="canvas-draw-overlay" data-canvas-scene="…"
style="position:absolute;inset:0;pointer-events:none">` **injected as the last
child of the slide's `<section>`** (`injectDrawOverlay` in `scene.ts`), so it
paints on top of real content without touching it. The base HTML stays
independently editable (inline/agent), the overlay stays re-editable (same
`data-canvas-scene` payload, reopened by `parseSceneFromHtml`), and — being plain
HTML — export/thumbnails/the public viewer render it for free. An empty scene
strips the layer (`injectDrawOverlay` removes any prior overlay first, so
re-saving is idempotent and "erase all" round-trips to a clean slide). The one
DOM assumption is a positioning context: `injectDrawOverlay` adds
`position:relative` inline to the slide's `<section>` whenever it has no inline
`position` of its own (harmlessly redundant when a deck's theme CSS already sets
`.slide{position:relative}`; the fix that matters is for blank/template decks
whose `.slide` isn't positioned). It never touches a section that carries an
inline `position`, so an explicitly inline-placed slide is preserved — a themed
CSS `position` isn't inspected, but neither case occurs for real slides.

The editing surface renders the **live slide behind the canvas** as the backdrop
(`draw-canvas.tsx` `backdropSrc` → the preview route's new single-slide mode,
`GET /api/decks/{id}/preview?slideId=…&stripOverlay=1`). Reusing the preview
route means the backdrop is the real, **asset-signed** render (a client-built
`srcDoc` couldn't sign `/api/canvas/asset/*` URLs), and it fills the same 16:9
box the 1280×720 overlay maps onto, so what you draw over is what ships.
`stripOverlay=1` drops the slide's SAVED overlay from that render: when
re-editing an annotation the editable scene paints those same elements itself,
so a backdrop still carrying the saved copy would ghost every move/delete until
save. The flag is explicit (not implied by `slideId`) so single-slide mode stays
a faithful render for any other consumer.

Unlike a fresh drawn slide (additive → direct), an overlay **edits existing
content**, so its save routes through the **inline-edit gate**
(`canDirectEditSlide` → `saveSlideHtmlDirect` for direct editors,
`proposeSlideHtmlEdit` for a member who can't direct-save). No new migration:
the existing content-save RPCs already carry it, and the propose path stamps a
base version so a reviewer sees the annotation before it lands.

### B. Direct structural ops for deck editors

Migration 0061 adds two `SECURITY DEFINER` RPCs that apply immediately for any
caller who passes `canvas_can_edit_deck`, mirroring `canvas_save_slide_direct`:

- `canvas_create_slide_direct(_deck_id, _position, _title, _html_body, _slide_styles)`
  — inserts a slide (typically a drawing) at a position, shifting later slides
  right, and returns the trigger-versioned row.
- `canvas_reorder_slides_direct(_deck_id, _order uuid[])` — rewrites every
  slide's position from an exact permutation of the deck's slide ids.

Content edits stay **propose-first** (they clobber existing content, so a
reviewer must see *what* changed). Reorder is purely positional and trivially
reversible (drag it back); a freshly drawn slide is additive. Neither overwrites
anyone's work, so neither needs review. Authority is the **explicit**
`canvas_can_edit_deck` check inside the DEFINER body (which bypasses RLS) — the
same pattern `canvas_apply_edit` uses, exercised by the pglite DB harness. Both
RPCs lean on the `(deck_id, position)` unique constraint being
`deferrable initially deferred` (migration 0001) to pass through transient
position collisions during the shift / rewrite.

Agents are unaffected: the `propose_reorder_slides` / `propose_new_slide` MCP
tools still queue proposals into the review rail. Only the in-app human editor
goes direct. The UI offers both affordances under the same client gate used for
proposing a slide edit (`is_workspace_admin || member-on-workspace-deck`); the
RPC is the authoritative check.

## Consequences

- Drag-to-reorder and "Draw a slide" are instant for deck editors; non-editors
  and agents keep the reviewed propose path. The two paths share the exact
  permutation/shift contract, so they can't diverge.
- Drawn slides are first-class HTML — export (PDF/PPTX), thumbnails, and the
  public viewer work for free, no special-casing.
- The embedded `data-canvas-scene` is the re-edit source of truth; the rendered
  SVG is the visual truth. Two cheap marker-class loader flags drive the
  affordances without shipping `html_body` to the slide list: `is_drawn`
  (`canvas-draw-slide`) → "Edit drawing" for a whole-slide drawing, and
  `has_overlay` (`canvas-draw-overlay`) → "Edit annotation" for a normal slide
  carrying a drawing overlay. "Draw over slide" is offered on any other slide.
- Drawing over a slide needs **no migration** — it's a content edit on
  `html_body` through the existing gate, and its pure core (`injectDrawOverlay`,
  `stripDrawOverlay`, `sceneToOverlaySvg`, positioning) is unit-tested in
  `tests/draw-scene.test.ts` (append/replace/erase round-trips, and that an
  explicit inline `position` is never overridden).
- New surface area, new responsibility: 0061 ships with the deploy — since
  2026-07-01 CI applies migrations (`supabase db push`) before rollout; verify
  the RPCs exist in prod after the first deploy rather than trusting the green
  run. A direct structural write that bypasses RLS lives or dies by its in-body
  permission check, so both RPCs are covered by DB tests
  (`tests/db/canvas-direct-structural.test.ts`) that assert a non-editor is
  refused and positions stay 0-based contiguous.

## Addendum (2026-07-02) — duplicate + delete go direct too (migration 0071)

The original decision took reorder and create direct on the "additive /
trivially reversible ops don't need review" argument, but left **duplicate**
and **delete** on the propose→self-approve path — so a solo editor still paid
two full review cycles to copy or remove one slide (Canvas speed discovery
2026-07 #6). Duplicate is purely additive (it clobbers nobody's work) and
delete is recoverable (version-recoverable via snapshot restore, and the 0037
`BEFORE DELETE` activity trigger keeps the audit trail no matter which path
deleted the slide), so both now have a `SECURITY DEFINER` RPC with the same
in-body `canvas_can_edit_deck` gate:

- `canvas_duplicate_slide_direct(_slide_id)` — copies content verbatim (speaker
  notes excluded, matching the propose/copy tools) and inserts the copy right
  after its source, shifting later slides right.
- `canvas_delete_slide_direct(_slide_id)` — deletes and left-compacts positions,
  mirroring `canvas_apply_edit`'s `slide_delete` branch exactly (the only-slide
  guard included), so the direct and proposal delete paths can't diverge.

The in-app actions (`duplicateSlide`, `proposeDeleteSlide`) try the direct RPC
first and **fall back to the original propose path only on a `not_authorized`
refusal** — a member without direct rights still gets their copy/delete as a
pending proposal a reviewer approves; agents keep the propose-only MCP tools.
Both RPCs are covered by DB tests
(`tests/db/canvas-direct-duplicate-delete.test.ts`): a non-editor and a
read-only deck viewer are refused, the only-slide delete is refused, positions
stay contiguous, and the activity row is written on a direct delete.

Related inline-save change (migration 0072, not structural): the content-save
RPC `canvas_save_slide_direct` gained `_release_lock` so an inline edit
releases the editor's soft lock in the SAME transaction as the versioned write
— one round-trip and one revalidate instead of save + a separate
`releaseSlide` (speed discovery #5.4).

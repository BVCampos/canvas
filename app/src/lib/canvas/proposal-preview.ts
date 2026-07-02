// Preview a PENDING proposal on a slide — the one place that knows how a
// canvas_deck_edit row would change a slide's renderable content.
//
// Two surfaces need the exact same answer and must never drift: the reviewer's
// thumbnail route (?proposalId — "show me what this proposal looks like") and
// the MCP render_proposal tool (Claude verifying its own just-proposed change
// before telling the human it's done). Both render the slide AS the proposal
// would leave it, so both must merge the proposal payload over the current
// slide identically — and identically to how canvas_apply_edit will merge it on
// approval, or the preview lies about the eventual result.
//
// The merge rule mirrors canvas_apply_edit: a field PRESENT in the proposal
// overrides the current value (including an explicit "" clear); an ABSENT field
// keeps the current value. Only the four slide-body kinds change a single
// slide's rendered output; theme/nav/structural/deck-title kinds return null
// (there is nothing to preview as one slide image).

export type SlideRenderContent = {
  title: string;
  html_body: string;
  slide_styles: string | null;
};

// The subset of a canvas_deck_edit row this preview needs. `new_content` carries
// the value for the single-field kinds (slide_html / slide_styles / slide_title);
// `new_slide_payload` carries the bundled change for slide_edit.
export type ProposalPreviewRow = {
  kind: string;
  new_content: string | null;
  new_slide_payload:
    | { html_body?: string; slide_styles?: string; title?: string }
    | null;
};

// Returns `current` patched as the pending proposal would leave the slide, or
// null when the proposal kind doesn't change THIS slide's rendered body (a
// theme/nav/structural/deck-title kind, or a slide_edit whose payload carries no
// renderable field). Callers preview the patched content; a null result means
// "nothing to show as a single slide."
export function previewProposalOnSlide(
  current: SlideRenderContent,
  edit: ProposalPreviewRow,
): SlideRenderContent | null {
  switch (edit.kind) {
    case "slide_html":
      return typeof edit.new_content === "string"
        ? { ...current, html_body: edit.new_content }
        : null;
    case "slide_styles":
      return typeof edit.new_content === "string"
        ? { ...current, slide_styles: edit.new_content }
        : null;
    case "slide_title":
      return typeof edit.new_content === "string"
        ? { ...current, title: edit.new_content }
        : null;
    case "slide_edit": {
      const payload = edit.new_slide_payload;
      if (!payload) return null;
      const next = { ...current };
      let touched = false;
      if (typeof payload.html_body === "string") {
        next.html_body = payload.html_body;
        touched = true;
      }
      if (typeof payload.slide_styles === "string") {
        next.slide_styles = payload.slide_styles;
        touched = true;
      }
      if (typeof payload.title === "string") {
        next.title = payload.title;
        touched = true;
      }
      return touched ? next : null;
    }
    default:
      // slide_create / slide_reorder / slide_delete / theme_css / nav_js /
      // deck_title — none rewrite a single slide's body.
      return null;
  }
}

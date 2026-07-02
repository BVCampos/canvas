// Composer prompt builders for the in-app assistant (ADR-0006).
//
// The user types a plain instruction; before we queue it we expand it with the
// context they're looking at, so the agent doesn't have to guess (or make the
// user restate) which slide/element they mean. The expansion is baked into the
// message `content`, which is the one channel BOTH runtimes already read — the
// local `canvas-agent` bridge gets it verbatim as the prompt, and the
// server-side OpenRouter runner loads it from thread history (ADR-0010). So
// carrying context here makes the assistant slide-aware with no schema, runtime,
// or bridge change.
//
// Two levels of context, picked in the composer's send():
//   • buildPickedPrompt      — the user pinpointed a specific element (precise;
//                              biases toward propose_slide_patch on that anchor).
//   • buildSlideContextPrompt — nothing pinpointed, but a slide is selected in
//                              the editor (coarse; resolves "this slide"/"here").
//
// Kept in a pure module (no React) so both are unit-tested directly.

// An element the user "pinpointed" in the live preview (deck-workspace's pick
// mode). Routed into the composer as a context chip so the user can type a
// plain instruction ("make this bigger") and we expand it into a patch-biased
// prompt anchored on that exact element. See buildPickedPrompt.
export type AssistantPickTarget = {
  slideId: string;
  // 0-based deck position; we render +1 for the human "slide N" label.
  slidePosition: number;
  slideTitle: string | null;
  // CSS-ish descriptor from the iframe (e.g. "h2#title.lead").
  descriptor: string;
  // The element's cleaned outerHTML — the patch anchor.
  html: string;
};

// The slide the user currently has selected in the editor. Coarser than a pick
// (no element anchor) — it's the active VIEW, used to resolve deixis when the
// user hasn't pinpointed anything. deck-workspace derives this from its
// `selected` slide.
export type AssistantSlideContext = {
  slideId: string;
  // 0-based deck position; we render +1 for the human "slide N" label.
  slidePosition: number;
  slideTitle: string | null;
};

// The fixed guidance buildPickedPrompt appends after the user's instruction, and
// the lead-in of buildSlideContextPrompt's context line. Kept as constants so
// describeComposedPrompt (below) can strip the scaffolding back off when the
// chatbox renders the bubble — build and parse reference the same strings and
// can't drift (a round-trip test pins it).
const PICK_PROMPT_TRAILER =
  "read_slide to confirm the current content, then propose_slide_patch anchored on that exact snippet — don't rewrite the whole slide.";
const SLIDE_CONTEXT_LEAD = "Context — I'm currently viewing ";
const BRAND_CONTEXT_LEAD = "Workspace brand — ";

// Expand a pinpointed element + a plain-language instruction into the prompt we
// actually queue for the bridge. The user only types the instruction; this
// hands the agent the slide id, the descriptor, and a trimmed HTML anchor so it
// can read_slide + propose_slide_patch instead of rewriting the whole slide. The
// snippet is capped tighter than the clipboard path (600 vs 4000) to keep the
// chat bubble readable — the agent re-reads the slide for the exact text anyway.
export function buildPickedPrompt(
  target: AssistantPickTarget,
  instruction: string,
): string {
  const label = target.slideTitle ? ` ("${target.slideTitle}")` : "";
  const snippet =
    target.html.length > 600
      ? `${target.html.slice(0, 600)}\n<!-- …truncated: large element. -->`
      : target.html;
  return [
    `On slide ${target.slidePosition + 1}${label} (slide_id ${target.slideId}), I'm pointing at this ${target.descriptor}:`,
    "",
    "```html",
    snippet,
    "```",
    "",
    instruction,
    "",
    PICK_PROMPT_TRAILER,
  ].join("\n");
}

// Prepend the slide the user is currently viewing as context for a plain
// instruction (no pinpointed element). This resolves "this slide", "here", and
// bare instructions to the right slide without making the user restate it.
//
// Deliberately NON-COMMITTAL: it's the current VIEW, not a declared target, so a
// deck-wide ask ("make the theme darker", "reorder the slides") isn't wrongly
// pinned to this slide — the hint says as much, and the agent reads the slide
// itself for exact content before editing. We don't bias toward patch-vs-rewrite
// here (unlike buildPickedPrompt) because there's no element anchor to patch on.
export function buildSlideContextPrompt(
  slide: AssistantSlideContext,
  instruction: string,
): string {
  const label = slide.slideTitle ? ` ("${slide.slideTitle}")` : "";
  return [
    `${SLIDE_CONTEXT_LEAD}slide ${slide.slidePosition + 1}${label} (slide_id ${slide.slideId}). If I say "this slide", "here", or don't name a slide, I mean this one; for deck-wide changes (theme, reordering, other slides) follow my words over this hint.`,
    "",
    instruction,
  ].join("\n");
}

// Prepend the workspace brand blurb (buildBrandBlurb — colors, fonts, voice)
// to an already-composed message. Same content-seam trick as the slide
// context: both runtimes read `content`, so the agent is brand-aware with no
// schema, runtime, or bridge change. Null/empty blurb = message unchanged.
// describeComposedPrompt strips this block back off before parsing, so the
// chat bubble still shows just the instruction + context chip.
export function withBrandContext(blurb: string | null, content: string): string {
  if (!blurb) return content;
  return `${BRAND_CONTEXT_LEAD}${blurb}\nUse these tokens and voice when you generate or restyle content.\n\n${content}`;
}

// What the chatbox should show for a composed user message: the instruction the
// user actually typed, plus a short label of the context we folded in — for a
// quiet chip, not the raw slide_id / HTML snippet / tool hints.
export type ComposedPromptDisplay = {
  // A short context label for a chip (e.g. "Slide 4 · Por que agora" or
  // "Slide 3 · A solução · h2#title.lead"), or null when nothing was folded in.
  contextLabel: string | null;
  // The slide_id parsed back out of the composed prompt, so the chatbox can make
  // the chip link to that slide (reveal it on click). Null for a bare message or
  // a format we couldn't parse. Never shown to the user — the label is.
  slideId: string | null;
  // The instruction to render in the bubble.
  instruction: string;
};

// Inverse of buildSlideContextPrompt / buildPickedPrompt: recover the typed
// instruction and a context label from a stored message `content`, so the bubble
// shows what the user wrote with the context as a quiet chip instead of dumping
// the whole composed prompt. The agent-facing `content` is unchanged — this is
// presentation only. Unrecognized content (a bare message, or a format we don't
// know) falls back to rendering it verbatim, so the worst case is today's
// behavior, never an empty bubble.
export function describeComposedPrompt(content: string): ComposedPromptDisplay {
  // Brand preamble (withBrandContext) sits ABOVE any other scaffolding —
  // strip it first so the slide/pick parsers below see their expected shape.
  // The blurb is presentation-noise for the bubble (the user didn't type it).
  if (content.startsWith(BRAND_CONTEXT_LEAD)) {
    const sep = content.indexOf("\n\n");
    if (sep !== -1) {
      return describeComposedPrompt(content.slice(sep + 2));
    }
  }

  // Slide-context: a one-line preamble, a blank line, then the instruction. The
  // third group captures the slide_id so the chip can link to it (presentation
  // only — the label still drops it).
  if (content.startsWith(SLIDE_CONTEXT_LEAD)) {
    const sep = content.indexOf("\n\n");
    if (sep !== -1) {
      const instruction = content.slice(sep + 2).trim();
      const m = /viewing slide (\d+)(?: \("(.*?)"\))? \(slide_id ([^)]+)\)/.exec(
        content.slice(0, sep),
      );
      if (m && instruction) {
        return {
          contextLabel: contextChip(m[1], m[2]),
          slideId: m[3],
          instruction,
        };
      }
    }
  }

  // Picked element: a header line, a fenced HTML snippet, the instruction, then
  // the fixed trailer. Take what sits between the closing fence and the trailer.
  // Groups: 1 position, 2 title, 3 slide_id, 4 descriptor.
  const head =
    /^On slide (\d+)(?: \("(.*?)"\))? \(slide_id ([^)]+)\), I'm pointing at this (.+):$/m.exec(
      content,
    );
  if (head && content.includes(PICK_PROMPT_TRAILER)) {
    const afterFence = content.slice(content.lastIndexOf("```") + 3);
    const trailerAt = afterFence.lastIndexOf(PICK_PROMPT_TRAILER);
    const instruction = (
      trailerAt === -1 ? afterFence : afterFence.slice(0, trailerAt)
    ).trim();
    if (instruction) {
      return {
        contextLabel: contextChip(head[1], head[2], head[4]),
        slideId: head[3],
        instruction,
      };
    }
  }

  return { contextLabel: null, slideId: null, instruction: content };
}

// "Slide 4 · Por que agora · h2#title" — drop the parts that aren't present.
// `position` is already the 1-based number the prompt rendered.
function contextChip(
  position: string,
  title?: string,
  descriptor?: string,
): string {
  return [`Slide ${position}`, title || null, descriptor || null]
    .filter(Boolean)
    .join(" · ");
}

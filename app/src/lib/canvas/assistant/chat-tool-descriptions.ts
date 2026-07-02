// Chat-length tool descriptions for the in-app assistant runner.
//
// The canonical MCP descriptions (mcp/tools.ts) are written to onboard a COLD
// terminal agent — they restate the propose-first workflow, review semantics,
// and failure modes per tool, and cost ~15k prompt tokens per completion round
// when shipped wholesale (assistant speed discovery 2026-07 #3). The panel
// runner already carries those workflow rules once in its system prompt, and
// the steering that actually changed behavior lives in tool RESULTS
// (suggested_patch), which are untouched. So chat sends these one-liners
// instead; anything load-bearing a SHORT description must keep (exact match
// semantics, base_version_no echo, render-before-apply) is kept.
//
// Tools without an override fall back to their canonical description.
export const CHAT_TOOL_DESCRIPTIONS: Record<string, string> = {
  get_deck:
    "Deck metadata plus the ordered slide list (slide ids, positions, titles, current version numbers, locks). How “slide 5” becomes a slide_id. The deck payload's agent_fast_lane_enabled tells you if verified patches can self-apply.",
  read_slide:
    "One slide's html_body, slide_styles, title, speaker notes, and current_version_no.",
  read_theme: "The deck's shared theme CSS and nav script.",
  write_slide_notes:
    "Set a slide's speaker notes directly — presenter working text, not versioned, no review. Pass \"\" to clear.",
  read_brand:
    "The workspace brand kit (design tokens + voice guidance) to match when styling slides.",
  read_full_deck:
    "The whole deck in one read: theme plus every slide's full content. Slow and large — only for genuinely cross-slide work; otherwise read_slide.",
  list_sources:
    "Pinned reference sources on the deck (or one slide, via slide_id). Read these before drafting content they cover.",
  read_source: "One pinned source's full content by source_id.",
  render_slide:
    "Render one slide's CURRENT stored content to an image so you can see the real layout (fast single-slide render). Pending proposals are NOT reflected — use render_proposal for those.",
  render_deck:
    "Render every slide to labelled images in order — whole-deck visual review. Slow; prefer render_slide for one slide.",
  render_proposal:
    "Render a PENDING proposal's would-be result to an image. Do this after every visual proposal and inspect the image before reporting it ready; required before apply_trusted_proposal.",
  apply_trusted_proposal:
    "Apply your own render-verified patch proposal through the deck's opted-in trusted fast lane. Call only when render_proposal's response says the lane is open and the image is visually correct.",
  propose_slide_edit:
    "Propose a FULL slide replacement (redesigns; small changes belong in propose_slide_patch). Requires base_version_no echoed from your latest read_slide of that slide. Creates a pending proposal — nothing changes until review.",
  propose_slide_variants:
    "Propose 2–4 alternative versions of ONE slide as a set; the human picks exactly one (side-by-side card in the panel) and the rest are set aside.",
  propose_slide_patch:
    "Propose exact find/replace edits on one slide — the fast path for adjustments. Each edit is {find, replace, in?: 'html_body'|'slide_styles', replace_all?}; find must match the CURRENT content exactly (whitespace-sensitive) and uniquely unless replace_all. Include a rationale.",
  propose_deck_patch:
    "Find/replace edits across MULTIPLE slides in one reviewable batch (same edit shape as propose_slide_patch plus slide_id per edit). Atomic: if any snippet fails to resolve, nothing is proposed.",
  propose_new_slide:
    "Propose a brand-new slide (full html_body, optional slide_styles/title) at a position. Pending until review.",
  propose_duplicate_slide:
    "Propose copying an existing slide within the deck, optionally with find/replace edits applied to the copy at propose time — the cheap way to “add a slide like slide 4 but for Q3” without regenerating HTML. One proposal, one review.",
  propose_reorder_slides:
    "Propose a new slide order — pass the full permutation of the deck's slide ids.",
  propose_delete_slide: "Propose deleting a slide (a reviewer confirms).",
  propose_theme_edit:
    "Propose replacing the deck's shared theme CSS. Affects every slide; pending until review.",
  propose_deck_edit:
    "Propose a deck-level edit (theme CSS and/or nav JS replacement). Pending until review.",
  list_proposals: "Proposals on the deck with status (pending/applied/rejected/withdrawn).",
  get_proposal: "One proposal's full detail, including its proposed content.",
  comment_on_proposal: "Attach a review note to a pending proposal.",
  withdraw_proposal:
    "Withdraw your own pending proposal (e.g. after a render showed it wrong). Idempotent.",
  revert_proposal:
    "Propose reverting an APPLIED proposal back to its pre-apply content (forward-only restore).",
  list_comments: "Comment threads on the deck or a slide.",
  add_comment: "Comment on a slide or the deck (mentions as user ids).",
  reply_to_comment: "Reply in an existing comment thread.",
};

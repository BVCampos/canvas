"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { logUsage } from "@/lib/usage/log";
import { threeWayMergeSlide } from "@/lib/canvas/three-way-merge";

// Server actions for rebasing a STALE slide_edit proposal onto the slide's
// current content instead of clobbering newer edits on "approve anyway".
//
// The merge runs here (the tested node-diff3 core in lib/canvas/three-way-merge);
// the atomic apply + auth + base-moved guard live in the canvas_apply_merged_edit
// RPC (migration 0050, DB-harness-tested). All reads go through the caller's RLS
// client, so a user only ever merges a proposal on a deck they can see.

type MergeInputs = {
  slideId: string;
  currentVersionId: string;
  isStale: boolean;
  base: { html_body: string; slide_styles: string };
  current: { html_body: string; slide_styles: string };
  theirs: { html_body: string; slide_styles: string };
};

type SupabaseClient = Awaited<ReturnType<typeof createClient>>;

// Load the three sides of the merge (base = what the proposal was built from,
// current = what's stored now, theirs = the proposal's payload). Returns an
// error string for any state the merge doesn't apply to.
async function loadMergeInputs(
  supabase: SupabaseClient,
  editId: string,
): Promise<MergeInputs | { error: string }> {
  const { data: edit } = await supabase
    .from("canvas_deck_edit")
    .select("slide_id, kind, status, base_version_id, new_slide_payload")
    .eq("id", editId)
    .maybeSingle();
  if (!edit) return { error: "Proposal not found." };
  if (edit.kind !== "slide_edit" || !edit.slide_id) {
    return { error: "Only slide content proposals can be merged." };
  }
  if (edit.status !== "pending") return { error: "This proposal is no longer pending." };

  const { data: slide } = await supabase
    .from("canvas_deck_slide")
    .select("current_version_id")
    .eq("id", edit.slide_id as string)
    .maybeSingle();
  const currentVersionId = slide?.current_version_id as string | undefined;
  if (!currentVersionId) return { error: "Slide not found." };

  const baseId = (edit.base_version_id as string | null) ?? null;
  const ids = baseId ? [currentVersionId, baseId] : [currentVersionId];
  const { data: vers } = await supabase
    .from("canvas_slide_version")
    .select("id, html_body, slide_styles")
    .in("id", ids);
  const byId = new Map((vers ?? []).map((v) => [v.id as string, v]));
  const cur = byId.get(currentVersionId);
  const base = baseId ? byId.get(baseId) : cur; // no recorded base -> not stale
  if (!cur || !base) return { error: "Version history is unavailable for this slide." };

  const payload = (edit.new_slide_payload ?? {}) as {
    html_body?: string;
    slide_styles?: string;
  };
  const baseContent = {
    html_body: (base.html_body as string | null) ?? "",
    slide_styles: (base.slide_styles as string | null) ?? "",
  };
  // A proposal may only set some fields; an unset field is "unchanged from base".
  const theirs = {
    html_body: payload.html_body ?? baseContent.html_body,
    slide_styles: payload.slide_styles ?? baseContent.slide_styles,
  };

  return {
    slideId: edit.slide_id as string,
    currentVersionId,
    isStale: Boolean(baseId) && baseId !== currentVersionId,
    base: baseContent,
    current: {
      html_body: (cur.html_body as string | null) ?? "",
      slide_styles: (cur.slide_styles as string | null) ?? "",
    },
    theirs,
  };
}

export type MergePreview =
  | { ok: true; stale: boolean; canMerge: boolean }
  | { ok: false; error: string };

// Cheap check the chip can call when a proposal is stale: is a clean merge
// available, so we can offer "Merge & approve" instead of only "Approve anyway"?
export async function previewProposalMerge(editId: string): Promise<MergePreview> {
  const supabase = await createClient();
  const loaded = await loadMergeInputs(supabase, editId);
  if ("error" in loaded) return { ok: false, error: loaded.error };
  if (!loaded.isStale) return { ok: true, stale: false, canMerge: false };
  const merged = threeWayMergeSlide(loaded.base, loaded.current, loaded.theirs);
  return { ok: true, stale: true, canMerge: merged.clean };
}

export type MergeApproveResult =
  | { ok: true }
  | { ok: false; error: string; conflict?: boolean };

// Compute the merge server-side (never trust a client-sent merge) and, when it's
// clean, apply it atomically via the RPC. On a conflict we return early so the
// UI can fall back to the explicit approve-anyway/clobber path.
export async function mergeApproveProposal(
  editId: string,
  deckId: string,
): Promise<MergeApproveResult> {
  const started = Date.now();
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "not_authenticated" };

  const loaded = await loadMergeInputs(supabase, editId);
  if ("error" in loaded) return { ok: false, error: loaded.error };

  const merged = threeWayMergeSlide(loaded.base, loaded.current, loaded.theirs);
  if (!merged.clean) {
    return {
      ok: false,
      conflict: true,
      error:
        "The newer edits overlap this proposal, so it can't be merged cleanly. Approve anyway to overwrite them, or ask the author to rebuild it.",
    };
  }

  const { error } = await supabase.rpc("canvas_apply_merged_edit", {
    _edit_id: editId,
    _merged_html: merged.html_body,
    _merged_styles: merged.slide_styles,
    _expected_current_version_id: loaded.currentVersionId,
  });
  if (error) {
    console.error("[mergeApproveProposal]", error);
    logUsage({
      event: "proposal.merge_approve",
      surface: "action",
      user_id: user.id,
      deck_id: deckId,
      status: "error",
      duration_ms: Date.now() - started,
      error_code: error.code ?? "rpc_error",
      props: { edit_id: editId },
    });
    return {
      ok: false,
      error: error.message.includes("merge_base_moved")
        ? "The slide changed again while merging. Reopen the proposal and retry."
        : "Merge failed.",
    };
  }

  logUsage({
    event: "proposal.merge_approve",
    surface: "action",
    user_id: user.id,
    deck_id: deckId,
    status: "ok",
    duration_ms: Date.now() - started,
    props: { edit_id: editId },
  });
  revalidatePath("/canvases");
  revalidatePath(`/canvases/${deckId}`);
  return { ok: true };
}

"use server";

import { createHash } from "node:crypto";
import { createClient } from "@/lib/supabase/server";
import { getActiveWorkspace } from "@/lib/auth/workspace";
import { computeProposalPermissions } from "@/lib/canvas/proposal-permissions";
import { displayName } from "@/lib/utils";
import type {
  NewSlidePayload,
  SlideEditPayload,
  SlideEditBefore,
} from "@/components/proposal-diff";

// Server action that returns the full payload needed to render the proposal
// review sheet from any client component — the one full-read surface now
// that /proposals/[editId] is just a redirect. Lets the sheet reuse
// ProposalDiff without a separate API surface.

export type ProposalSheetData = {
  edit: {
    id: string;
    workspace_id: string;
    deck_id: string;
    slide_id: string | null;
    kind:
      | "slide_edit"
      | "slide_html"
      | "slide_styles"
      | "slide_title"
      | "slide_create"
      | "theme_css"
      | "nav_js"
      | "deck_title";
    proposed_by: string;
    proposed_by_kind: "user" | "claude";
    // new_content is null for slide_create rows (the payload lives in
    // new_slide_payload); non-null for every other kind per the DB CHECK
    // constraint added in migration 0010 / extended in 0012.
    new_content: string | null;
    new_slide_payload: NewSlidePayload | null;
    rationale: string | null;
    status: "pending" | "applied" | "rejected" | "superseded";
    base_version_id: string | null;
    base_theme_css_hash: string | null;
    base_nav_js_hash: string | null;
    base_deck_title: string | null;
    revision: number;
    created_at: string;
    resolved_at: string | null;
    resolved_by: string | null;
  };
  deck: {
    title: string;
    theme_css: string;
    nav_js: string;
    meta: Record<string, unknown>;
  };
  slide: {
    position: number;
    title: string;
    html_body: string;
    slide_styles: string;
  } | null;
  // Resolved content for the diff (handles "diff against current" for pending
  // vs "diff against base" for resolved proposals).
  oldContent: string;
  newContent: string;
  // Parsed slide_create payload, when applicable. null for every other kind.
  newSlidePayload: NewSlidePayload | null;
  // For kind === 'slide_edit': the changed fields and the before-state they
  // diff against. null for every other kind.
  slideEditPayload: SlideEditPayload | null;
  slideEditBefore: SlideEditBefore | null;
  staleness: { stale: boolean; message: string };
  // Author names keyed by user id.
  userById: Record<string, string>;
  reviewerName: string | null;
  proposerName: string;
  comments: Array<{
    id: string;
    author_id: string | null;
    author_kind: "user" | "claude";
    body: string;
    created_at: string;
  }>;
  // UI permission signals — the RPC re-checks at apply time, these are
  // affordance hints only.
  canApprove: boolean;
  canReject: boolean;
  canWithdraw: boolean;
  canEdit: boolean;
  // Current user id, useful for client-side comparisons.
  currentUserId: string;
};

export type ProposalSheetResult =
  | { ok: true; data: ProposalSheetData }
  | { ok: false; error: string };

export async function getProposalSheetData(
  editId: string,
  deckId: string,
): Promise<ProposalSheetResult> {
  const { user } = await getActiveWorkspace(`/canvases/${deckId}`);
  const supabase = await createClient();

  const { data: edit, error: editErr } = await supabase
    .from("canvas_deck_edit")
    .select(
      "id, workspace_id, deck_id, slide_id, kind, proposed_by, proposed_by_kind, new_content, new_slide_payload, rationale, status, base_version_id, base_theme_css_hash, base_nav_js_hash, base_deck_title, revision, created_at, resolved_at, resolved_by",
    )
    .eq("id", editId)
    .eq("deck_id", deckId)
    .maybeSingle();
  if (editErr) {
    console.error("[getProposalSheetData edit]", editErr);
    return { ok: false, error: editErr.message };
  }
  if (!edit) return { ok: false, error: "not_found" };

  const { data: deck } = await supabase
    .from("canvas_deck")
    .select("id, title, theme_css, nav_js, meta, created_by")
    .eq("id", deckId)
    .maybeSingle();
  if (!deck) return { ok: false, error: "deck_not_found" };

  const slide = edit.slide_id
    ? (
        await supabase
          .from("canvas_deck_slide")
          .select(
            "id, position, title, html_body, slide_styles, owner_id, created_by, current_version_id",
          )
          .eq("id", edit.slide_id)
          .maybeSingle()
      ).data
    : null;

  // Diff base: for pending proposals we compare against current; for resolved
  // ones we compare against the version that was the base at propose time so
  // the diff stays meaningful after apply.
  let baseVersionContent: {
    html_body: string;
    slide_styles: string;
    title: string;
  } | null = null;
  if (
    edit.status !== "pending" &&
    edit.base_version_id &&
    (edit.kind === "slide_edit" ||
      edit.kind === "slide_html" ||
      edit.kind === "slide_styles" ||
      edit.kind === "slide_title")
  ) {
    const { data } = await supabase
      .from("canvas_slide_version")
      .select("html_body, slide_styles, title")
      .eq("id", edit.base_version_id)
      .maybeSingle();
    baseVersionContent = data ?? null;
  }

  const { oldContent, newContent } = resolveDiffContent(
    edit,
    deck,
    slide,
    baseVersionContent,
  );

  // slide_create rows carry their content in new_slide_payload (jsonb). Narrow
  // the raw column into the typed shape ProposalDiff expects; null falls back
  // to the empty-render path in <NewSlideRender>.
  const newSlidePayload: NewSlidePayload | null =
    edit.kind === "slide_create" && edit.new_slide_payload
      ? parseNewSlidePayload(edit.new_slide_payload)
      : null;

  // slide_edit carries the touched fields in new_slide_payload; we diff them
  // against the base version (resolved rows) or the slide's current content
  // (pending rows). Both are passed through to ProposalDiff's combined card.
  const slideEditPayload: SlideEditPayload | null =
    edit.kind === "slide_edit"
      ? parseSlideEditPayload(edit.new_slide_payload)
      : null;
  const slideEditBefore: SlideEditBefore | null =
    edit.kind === "slide_edit"
      ? {
          html_body: baseVersionContent?.html_body ?? slide?.html_body ?? "",
          slide_styles:
            baseVersionContent?.slide_styles ?? slide?.slide_styles ?? "",
          title: baseVersionContent?.title ?? slide?.title ?? "",
        }
      : null;

  const staleness =
    edit.status === "pending"
      ? computeStaleness(edit, deck, slide)
      : { stale: false, message: "" };

  const { data: rawComments } = await supabase
    .from("canvas_edit_comment")
    .select("id, author_kind, author_id, body, created_at")
    .eq("edit_id", editId)
    .order("created_at", { ascending: true });

  const authorIds: string[] = [];
  for (const c of rawComments ?? []) {
    if (c.author_id) authorIds.push(c.author_id);
  }
  if (edit.proposed_by) authorIds.push(edit.proposed_by);
  if (edit.resolved_by) authorIds.push(edit.resolved_by);
  // For slide proposals name the slide's owner_id; when it's null any editor
  // or admin can approve, so leave the reviewer unnamed (badge shows the
  // generic "Pending review") instead of misnaming the deck creator. Theme/nav
  // proposals (no slide) fall back to deck.created_by, who can approve them.
  const reviewerId = slide ? slide.owner_id : deck.created_by ?? null;
  if (reviewerId) authorIds.push(reviewerId);
  const uniqueAuthorIds = Array.from(new Set(authorIds));

  const { data: usersData } = uniqueAuthorIds.length
    ? await supabase
        .from("users")
        .select("id, email, name")
        .in("id", uniqueAuthorIds)
    : { data: [] };

  const userById: Record<string, string> = {};
  for (const u of usersData ?? []) {
    userById[u.id] = displayName({ email: u.email ?? "", name: u.name ?? null });
  }

  const isProposer = edit.proposed_by === user.id;

  // Resolve admin status, deck-edit authority AND the self-approval opt-in
  // against the EDIT's workspace/deck — not getActiveWorkspace's
  // cookie-selected active one — so the affordance matches exactly what
  // canvas_apply_edit re-checks server-side (canvas_can_edit_deck +
  // is_workspace_admin_or_owner + canvas_allow_self_approval). RLS gates the
  // reads to members of that workspace.
  const [{ data: editMembership }, { data: editWorkspace }, { data: deckEdit }] =
    await Promise.all([
      supabase
        .from("workspace_memberships")
        .select("role")
        .eq("user_id", user.id)
        .eq("workspace_id", edit.workspace_id)
        .maybeSingle(),
      supabase
        .from("workspaces")
        .select("canvas_allow_self_approval")
        .eq("id", edit.workspace_id)
        .maybeSingle(),
      supabase.rpc("canvas_can_edit_deck", { _deck_id: edit.deck_id }),
    ]);
  const isWorkspaceAdmin =
    editMembership?.role === "owner" || editMembership?.role === "admin";
  const allowSelfApproval = editWorkspace?.canvas_allow_self_approval === true;

  const { canApprove, canReject, canWithdraw, canEdit } =
    computeProposalPermissions({
      isPending: edit.status === "pending",
      isProposer,
      isWorkspaceAdmin,
      canEditDeck: deckEdit === true,
      allowSelfApproval,
    });

  return {
    ok: true,
    data: {
      edit: edit as ProposalSheetData["edit"],
      deck: {
        title: deck.title,
        theme_css: deck.theme_css ?? "",
        nav_js: deck.nav_js ?? "",
        meta: (deck.meta ?? {}) as Record<string, unknown>,
      },
      slide: slide
        ? {
            position: slide.position,
            title: slide.title,
            html_body: slide.html_body,
            slide_styles: slide.slide_styles,
          }
        : null,
      oldContent,
      newContent,
      newSlidePayload,
      slideEditPayload,
      slideEditBefore,
      staleness,
      userById,
      reviewerName:
        edit.status === "pending" && !isProposer && reviewerId
          ? userById[reviewerId] ?? null
          : null,
      proposerName: userById[edit.proposed_by] ?? "Unknown",
      comments: rawComments ?? [],
      canApprove,
      canReject,
      canWithdraw,
      canEdit,
      currentUserId: user.id,
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers (kept in this module to match the standalone page's logic exactly)
// ---------------------------------------------------------------------------

type EditForDiff = {
  kind: string;
  new_content: string | null;
  new_slide_payload: unknown;
  base_version_id: string | null;
  base_theme_css_hash: string | null;
  base_nav_js_hash: string | null;
  base_deck_title: string | null;
};

function resolveDiffContent(
  edit: EditForDiff,
  deck: { title: string; theme_css: string | null; nav_js: string | null },
  slide: { html_body: string; slide_styles: string; title: string } | null,
  baseVersion: {
    html_body: string;
    slide_styles: string;
    title: string;
  } | null,
) {
  const newContent = edit.new_content ?? "";
  switch (edit.kind) {
    case "slide_edit": {
      // The combined card is driven by slideEditPayload + slideEditBefore, not
      // by oldContent/newContent. We still return the html before/after here so
      // the generic stats/fallback paths have something coherent.
      const payload = parseSlideEditPayload(edit.new_slide_payload) ?? {};
      const beforeHtml = baseVersion?.html_body ?? slide?.html_body ?? "";
      return { oldContent: beforeHtml, newContent: payload.html_body ?? beforeHtml };
    }
    case "slide_html":
      return {
        oldContent: baseVersion?.html_body ?? slide?.html_body ?? "",
        newContent,
      };
    case "slide_styles":
      return {
        oldContent: baseVersion?.slide_styles ?? slide?.slide_styles ?? "",
        newContent,
      };
    case "slide_title":
      // Same base resolution as slide_html/slide_styles: diff the new label
      // against the base version's title (resolved rows) or the slide's
      // current title (pending rows).
      return {
        oldContent: baseVersion?.title ?? slide?.title ?? "",
        newContent,
      };
    case "slide_create": {
      const payload = parseNewSlidePayload(edit.new_slide_payload);
      return { oldContent: "", newContent: payload?.html_body ?? "" };
    }
    case "theme_css":
      return { oldContent: deck.theme_css ?? "", newContent };
    case "nav_js":
      return { oldContent: deck.nav_js ?? "", newContent };
    case "deck_title":
      // For resolved proposals, prefer the captured base_deck_title so the
      // diff stays meaningful after the title was applied. Falls back to
      // the current deck title for pending rows or rows pre-migration.
      return {
        oldContent:
          edit.base_deck_title != null && edit.base_deck_title !== ""
            ? edit.base_deck_title
            : deck.title,
        newContent,
      };
    default:
      return { oldContent: "", newContent };
  }
}

// Parse the raw jsonb payload returned by Supabase into the typed shape we
// pass to ProposalDiff. Defensive: a malformed row should null out rather
// than throw, so the surrounding UI still renders.
function parseNewSlidePayload(value: unknown): NewSlidePayload | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (typeof v.position !== "number" || typeof v.html_body !== "string") {
    return null;
  }
  return {
    position: v.position,
    title: typeof v.title === "string" ? v.title : "",
    html_body: v.html_body,
    slide_styles: typeof v.slide_styles === "string" ? v.slide_styles : "",
  };
}

// Parse a slide_edit payload — only the keys the proposer actually set are
// present (each one a string). A missing key means "field untouched". Returns
// null when nothing usable is present so the caller can fall back gracefully.
function parseSlideEditPayload(value: unknown): SlideEditPayload | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const out: SlideEditPayload = {};
  if (typeof v.html_body === "string") out.html_body = v.html_body;
  if (typeof v.slide_styles === "string") out.slide_styles = v.slide_styles;
  if (typeof v.title === "string") out.title = v.title;
  return Object.keys(out).length > 0 ? out : null;
}

function computeStaleness(
  edit: EditForDiff,
  deck: { title: string; theme_css: string | null; nav_js: string | null },
  slide: { current_version_id: string | null } | null,
): { stale: boolean; message: string } {
  if (
    edit.kind === "slide_edit" ||
    edit.kind === "slide_html" ||
    edit.kind === "slide_styles" ||
    edit.kind === "slide_title"
  ) {
    if (!edit.base_version_id || !slide?.current_version_id) {
      return { stale: false, message: "" };
    }
    if (edit.base_version_id !== slide.current_version_id) {
      return {
        stale: true,
        message:
          "The slide has been updated since this proposal was made. Approving will create a new version on top of the current state — review carefully.",
      };
    }
  }
  if (edit.kind === "theme_css" && edit.base_theme_css_hash) {
    const currentHash = createHash("md5")
      .update(deck.theme_css ?? "")
      .digest("hex");
    if (currentHash !== edit.base_theme_css_hash) {
      return {
        stale: true,
        message:
          "The deck theme has changed since this proposal was made. Approving will overwrite the current theme.",
      };
    }
  }
  if (edit.kind === "nav_js" && edit.base_nav_js_hash) {
    const currentHash = createHash("md5")
      .update(deck.nav_js ?? "")
      .digest("hex");
    if (currentHash !== edit.base_nav_js_hash) {
      return {
        stale: true,
        message:
          "The deck navigation JS has changed since this proposal was made. Approving will overwrite the current nav.",
      };
    }
  }
  if (edit.kind === "deck_title" && edit.base_deck_title != null) {
    if (deck.title !== edit.base_deck_title) {
      return {
        stale: true,
        message:
          "The deck title has changed since this proposal was made. Approving will overwrite the current title.",
      };
    }
  }
  return { stale: false, message: "" };
}

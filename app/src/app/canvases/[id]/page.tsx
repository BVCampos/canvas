import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { buildBrandBlurb, normalizeBrandTokens } from "@/lib/canvas/brand";
import {
  asProposalKind,
  asProposerKind,
  compareReviewOrder,
  type ProposalBase,
} from "@/lib/canvas/proposal-types";
import {
  parseWorkspaceRole,
  type WorkspaceRole,
} from "@/lib/auth/workspace";
import { DeckWorkspace } from "./deck-workspace";
import { DeckPresenceTracker } from "./deck-presence-tracker";
import type { MentionMember } from "@/lib/canvas/mention";
import { isMcpTokenExpired } from "@/lib/canvas/mcp-token";
import { getOpenRouterConfigSummary } from "@/lib/canvas/assistant/openrouter-config";
import { DRAW_SLIDE_CLASS, DRAW_OVERLAY_CLASS } from "@/lib/canvas/draw/scene";

// Re-exported so existing consumers (deck-workspace.tsx) keep importing it
// from this module; the canonical declaration lives in @/lib/auth/workspace.
export type { WorkspaceRole };

// /canvases/{id} — the deck editor. Three-pane layout (slide list / preview /
// sidebar) lives in the client `DeckWorkspace`. This server component is a
// thin loader: deck + slides + locks + version metadata are fetched here and
// passed down.

export type SlideRow = {
  id: string;
  position: number;
  title: string;
  owner_id: string | null;
  current_version_id: string | null;
  current_version_no: number | null;
  lock: {
    locked_by: string;
    locked_by_kind: "user" | "agent";
    expires_at: string;
    user_email: string | null;
    user_name: string | null;
  } | null;
  pending_proposals: number;
  // True when the WHOLE slide is a re-editable drawing (class `canvas-draw-slide`)
  // — what "Edit drawing" reopens. Derived cheaply in the loader by matching the
  // marker class; the full html_body never rides the slide list.
  is_drawn: boolean;
  // True when a normal slide carries a re-editable drawing OVERLAY (class
  // `canvas-draw-overlay`) — an annotation layer on top of real content, edited
  // via "Edit annotation". Mutually exclusive with `is_drawn` in practice.
  has_overlay: boolean;
};

export type CommentRow = {
  id: string;
  deck_id: string;
  slide_id: string | null;
  parent_id: string | null;
  body: string;
  author_id: string | null;
  // 'client' = anonymous link visitor (migration 0064): author_id is null and
  // author_name/author_email come from the stored, unverified attribution
  // columns instead of a resolved user profile.
  author_kind: "user" | "claude" | "client";
  author_email: string | null;
  author_name: string | null;
  anchor_x: number | null;
  anchor_y: number | null;
  resolved: boolean;
  resolved_at: string | null;
  created_at: string;
};

export type PendingProposalRow = ProposalBase & {
  slide_id: string | null;
  slide_position: number | null;
  slide_title: string | null;
  proposed_by: string;
  // The slide version this proposal was based on — lets the editor flag a
  // slide_html/slide_styles proposal as stale (slide moved on since) without a
  // round-trip. Null for theme/nav/title kinds (their staleness is hashed
  // server-side and surfaced in the full proposal sheet).
  base_version_id: string | null;
  // For slide_create only: the position the new slide is proposed to land at,
  // read from new_slide_payload. Lets the workspace drive the Lens overlay to
  // the new slide and snap the base frame to whatever slide is there now (the
  // "before"). Null for every other kind.
  new_slide_position: number | null;
  // Trusted-fast-lane signals (migration 0057). auto_apply_eligible: this is a
  // deterministic patch proposal. agent_rendered_at: the agent render-verified
  // it. Together with proposed_by_kind='claude' they mark an approval the
  // fast-lane inline offer counts (deck-workspace).
  auto_apply_eligible: boolean;
  agent_rendered_at: string | null;
};

export default async function CanvasDeckPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ proposal?: string; full?: string; slide?: string }>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const requestedProposalId = sp.proposal ?? null;
  const initialFullSheet = sp.full === "1";
  // ?slide= mirrors the editor's selection (deck-workspace URL-sync effect):
  // restores the slide across refreshes and remounts. Validated client-side
  // against the slide list, so a stale id just falls back to slide 1.
  const initialSlideId = sp.slide ?? null;
  const supabase = await createClient();

  // TIER 1 — every read that needs nothing but the route param `id`. These are
  // independent, so we fire them together instead of awaiting one at a time
  // (the old code paid ~7 serial round-trips here). The `notFound()` gate still
  // runs the instant the deck resolves, just after this batch settles; the
  // other reads scoped by `deck_id` return empty under RLS when the deck is
  // absent, and that empty data is never consumed because notFound() throws.
  const [
    proposalLookup,
    deckResult,
    slidesResult,
    pendingResult,
    commentsResult,
    userResult,
    totalProposalsResult,
  ] = await Promise.all([
    // Optional: only when ?proposal= is present. Mirrors the old conditional.
    requestedProposalId
      ? supabase
          .from("canvas_deck_edit")
          .select("id, status")
          .eq("id", requestedProposalId)
          .eq("deck_id", id)
          .maybeSingle()
      : Promise.resolve({ data: null }),
    supabase
      .from("canvas_deck")
      .select(
        "id, workspace_id, title, status, theme_css, created_at, updated_at, visibility, created_by, agent_fast_lane_enabled, archived_at",
      )
      .eq("id", id)
      .maybeSingle(),
    supabase
      .from("canvas_deck_slide")
      .select("id, position, title, owner_id, current_version_id")
      .eq("deck_id", id)
      .order("position", { ascending: true }),
    // Pending proposals scoped to this deck. We fetch enough columns to render
    // an inline preview list in the right rail (slide ref, kind, rationale,
    // proposer) plus a per-slide count for the left-rail badges. Theme/nav
    // proposals (slide_id = null) still appear in the right-rail list but
    // don't get a slide badge.
    supabase
      .from("canvas_deck_edit")
      .select(
        "id, slide_id, kind, rationale, proposed_by, proposed_by_kind, created_at, base_version_id, new_slide_payload, auto_apply_eligible, agent_rendered_at",
      )
      .eq("deck_id", id)
      .eq("status", "pending")
      .order("created_at", { ascending: false })
      .limit(50),
    // Comments — open threads come back first (newest unresolved at top), then
    // recent resolved for context. Limit keeps the initial payload small; a
    // future "show all resolved" toggle can re-fetch on demand.
    supabase
      .from("canvas_comment")
      .select(
        "id, deck_id, slide_id, parent_id, body, author_id, author_kind, author_name, author_email, anchor_x, anchor_y, resolved, resolved_at, created_at",
      )
      .eq("deck_id", id)
      .order("resolved", { ascending: true })
      .order("created_at", { ascending: true })
      .limit(500),
    supabase.auth.getUser(),
    // Fresh-deck heuristic input. `head: true` avoids paying for row data.
    supabase
      .from("canvas_deck_edit")
      .select("id", { count: "exact", head: true })
      .eq("deck_id", id),
  ]);

  let initialProposalId: string | null = null;
  let resolvedInitialFullSheet = initialFullSheet;
  const proposalRow = proposalLookup.data;
  if (proposalRow) {
    initialProposalId = proposalRow.id;
    // Resolved proposals (applied / rejected / superseded) don't have a
    // meaningful inline preview — there's no "what would this look like
    // applied" because it already happened (or never will). Open the full
    // sheet instead so the reviewer sees the diff + outcome.
    if (proposalRow.status !== "pending") {
      resolvedInitialFullSheet = true;
    }
  }

  const { data: deck, error: deckErr } = deckResult;
  if (deckErr) {
    console.error("[deck page]", deckErr);
  }
  if (!deck) notFound();

  const { data: slidesRaw } = slidesResult;

  const slideRows = (slidesRaw ?? []) as Array<{
    id: string;
    position: number;
    title: string;
    owner_id: string | null;
    current_version_id: string | null;
  }>;

  const { data: pendingRaw } = pendingResult;
  const pendingRows = pendingRaw ?? [];
  const pendingBySlide = new Map<string, number>();
  for (const row of pendingRows) {
    if (!row.slide_id) continue;
    pendingBySlide.set(row.slide_id, (pendingBySlide.get(row.slide_id) ?? 0) + 1);
  }
  const deckPendingCount = pendingRows.length;

  // TIER 2 — reads keyed by ids harvested from the Tier-1 results (slide version
  // pointers, slide ids, proposer ids). They have disjoint dependencies, so they
  // fan out together. lockerProfiles stays in Tier 3 below: it needs the lock
  // rows this batch returns.
  const versionIds = slideRows
    .map((s) => s.current_version_id)
    .filter((v): v is string => Boolean(v));
  const slideIds = slideRows.map((s) => s.id);
  const proposerIds = Array.from(new Set(pendingRows.map((r) => r.proposed_by)));

  const [versionsResult, locksResult, proposerUsersResult, drawnResult, overlayResult] = await Promise.all([
    versionIds.length > 0
      ? supabase
          .from("canvas_slide_version")
          .select("id, version_no, slide_id")
          .in("id", versionIds)
      : Promise.resolve({ data: [] as { id: string; version_no: number; slide_id: string }[] }),
    // Filter expired locks at the DB layer (`gt('expires_at', now())`) — keeps
    // the Server Component pure (the React 19 lint rule flags `Date.now()` /
    // `new Date()` calls during render).
    slideIds.length > 0
      ? supabase
          .from("canvas_deck_slide_lock")
          .select("slide_id, locked_by, locked_by_kind, expires_at")
          .in("slide_id", slideIds)
          .gt("expires_at", "now()")
      : Promise.resolve({
          data: [] as {
            slide_id: string;
            locked_by: string;
            locked_by_kind: "user" | "agent";
            expires_at: string;
          }[],
        }),
    proposerIds.length
      ? supabase
          .from("users")
          .select("id, email, name")
          .in("id", proposerIds)
      : Promise.resolve({ data: [] as { id: string; email: string | null; name: string | null }[] }),
    // Which slides are WHOLE-slide drawings ("Edit drawing" reopens these) —
    // matched by the marker class, which the drawn-slide serializer always emits
    // in a `class="… canvas-draw-slide"` attribute. The trailing `"` anchors the
    // match to the real class attribute: user-drawn TEXT rides `data-canvas-scene`
    // URL-encoded, where a literal `"` becomes `%22`, so a self-referential
    // annotation containing the marker string can't spoof this (which would
    // mis-route it into the destructive whole-slide "Edit drawing"). Class-matched
    // (not `data-canvas-scene`, which overlays share). Ids only — html_body never
    // rides the slide list, cheap on a big deck.
    slideIds.length > 0
      ? supabase
          .from("canvas_deck_slide")
          .select("id")
          .eq("deck_id", id)
          .ilike("html_body", `%${DRAW_SLIDE_CLASS}"%`)
      : Promise.resolve({ data: [] as { id: string }[] }),
    // Which normal slides carry a drawing OVERLAY ("Edit annotation" reopens
    // these) — the overlay's `class="canvas-draw-overlay"`, same trailing-`"`
    // anchor so drawn text can't spoof it.
    slideIds.length > 0
      ? supabase
          .from("canvas_deck_slide")
          .select("id")
          .eq("deck_id", id)
          .ilike("html_body", `%${DRAW_OVERLAY_CLASS}"%`)
      : Promise.resolve({ data: [] as { id: string }[] }),
  ]);

  const versions = versionsResult.data ?? [];
  const locksRaw = locksResult.data ?? [];
  const { data: proposerUsers } = proposerUsersResult;
  const drawnIds = new Set((drawnResult.data ?? []).map((r) => r.id as string));
  const overlayIds = new Set((overlayResult.data ?? []).map((r) => r.id as string));

  // TIER 3 — needs the lock rows from Tier 2 to know which user profiles to load.
  const activeLockUserIds = Array.from(
    new Set(locksRaw.map((l) => l.locked_by)),
  );
  const lockerProfiles = activeLockUserIds.length > 0
    ? (await supabase
        .from("users")
        .select("id, email, name")
        .in("id", activeLockUserIds)).data ?? []
    : [];
  const lockerEmailById = new Map(
    lockerProfiles.map((u) => [u.id, u.email as string | null]),
  );
  const lockerNameById = new Map(
    lockerProfiles.map((u) => [u.id, (u.name as string | null) ?? null]),
  );

  const versionByCurrentId = new Map(versions.map((v) => [v.id, v.version_no]));

  const proposerById = new Map(
    (proposerUsers ?? []).map((u) => [
      u.id,
      u.name?.trim() || u.email || "Unknown",
    ]),
  );
  const slideById = new Map(
    slideRows.map((s) => [s.id, { position: s.position, title: s.title }]),
  );
  const pendingProposals: PendingProposalRow[] = pendingRows.map((row) => {
    const slideInfo = row.slide_id ? slideById.get(row.slide_id) : null;
    // slide_create carries its target position in new_slide_payload (jsonb).
    // Pull just the position out for the Lens; the full payload is loaded
    // lazily by the proposal sheet/diff panel when the reviewer opens it.
    const createPayload =
      row.kind === "slide_create"
        ? ((row as { new_slide_payload: { position?: number } | null })
            .new_slide_payload ?? null)
        : null;
    return {
      id: row.id,
      slide_id: row.slide_id,
      slide_position: slideInfo?.position ?? null,
      slide_title: slideInfo?.title ?? null,
      new_slide_position:
        typeof createPayload?.position === "number"
          ? createPayload.position
          : null,
      // Narrow Supabase's raw `string` enum values into the literal unions
      // at the boundary — see `lib/canvas/proposal-types.ts` for the
      // fall-back-with-warn policy.
      kind: asProposalKind(row.kind),
      rationale: row.rationale,
      proposer_name: proposerById.get(row.proposed_by) ?? null,
      proposed_by_kind: asProposerKind(row.proposed_by_kind),
      proposed_by: row.proposed_by,
      created_at: row.created_at,
      base_version_id: (row as { base_version_id: string | null }).base_version_id ?? null,
      auto_apply_eligible: Boolean(
        (row as { auto_apply_eligible?: boolean }).auto_apply_eligible,
      ),
      agent_rendered_at:
        (row as { agent_rendered_at?: string | null }).agent_rendered_at ?? null,
    };
    // Re-order from the DB's `created_at DESC` into review order: structural
    // edits first, then slide-by-slide top-to-bottom. Every downstream
    // consumer (right-rail list, per-slide chip, J/K auto-advance) derives
    // from this array via `.filter()`, which preserves order — so sorting once
    // here fixes the whole review flow. See `compareReviewOrder`.
  }).sort(compareReviewOrder);

  const slides: SlideRow[] = slideRows.map((s) => {
    // locksRaw already excludes expired rows (DB-side filter above), so a
    // matching row is always active.
    const active = locksRaw.find((l) => l.slide_id === s.id) ?? null;
    return {
      id: s.id,
      position: s.position,
      title: s.title,
      owner_id: s.owner_id,
      current_version_id: s.current_version_id,
      current_version_no: s.current_version_id
        ? versionByCurrentId.get(s.current_version_id) ?? null
        : null,
      lock: active
        ? {
            locked_by: active.locked_by,
            locked_by_kind:
              active.locked_by_kind === "agent" ? "agent" : "user",
            expires_at: active.expires_at,
            user_email: lockerEmailById.get(active.locked_by) ?? null,
            user_name: lockerNameById.get(active.locked_by) ?? null,
          }
        : null,
      pending_proposals: pendingBySlide.get(s.id) ?? 0,
      is_drawn: drawnIds.has(s.id),
      has_overlay: overlayIds.has(s.id),
    };
  });

  // `commentsRaw`, `user`, and the deck were all loaded in Tier 1. The comment
  // author profiles + the three deck/user-scoped lookups (role, self-approval,
  // MCP token) depend only on those, with disjoint inputs, so they fan out as a
  // second Tier-2 batch here rather than four more serial round-trips.
  const { data: commentsRaw } = commentsResult;
  const commentRowsRaw = (commentsRaw ?? []) as Array<{
    id: string;
    deck_id: string;
    slide_id: string | null;
    parent_id: string | null;
    body: string;
    author_id: string | null;
    author_kind: "user" | "claude" | "client";
    author_name: string | null;
    author_email: string | null;
    anchor_x: number | null;
    anchor_y: number | null;
    resolved: boolean;
    resolved_at: string | null;
    created_at: string;
  }>;

  const commentAuthorIds = Array.from(
    new Set(commentRowsRaw.map((c) => c.author_id).filter((v): v is string => Boolean(v))),
  );

  const {
    data: { user },
  } = userResult;
  const deckWorkspaceId = (deck as { workspace_id?: string | null }).workspace_id;

  const [
    authorProfilesResult,
    membershipResult,
    wsRowResult,
    tokenRowResult,
    membersResult,
    openRouterConfig,
    fastLaneCountResult,
  ] = await Promise.all([
      commentAuthorIds.length > 0
        ? supabase
            .from("users")
            .select("id, email, name")
            .in("id", commentAuthorIds)
        : Promise.resolve({ data: [] as { id: string; email: string | null; name: string | null }[] }),
      // Resolve the caller's role on the deck's workspace. Used in the right
      // rail to decide whether to render the "Force release" affordance on a
      // lock held by someone else. Mirrors `getActiveWorkspace` but anchors on
      // the deck's workspace (not the user's first membership), so admins of
      // *this* deck see the override even if it isn't their primary workspace.
      // We keep `error` separately (read below) so a real DB failure surfaces
      // in logs rather than silently demoting an admin to a member.
      user && deckWorkspaceId
        ? supabase
            .from("workspace_memberships")
            .select("role")
            .eq("user_id", user.id)
            .eq("workspace_id", deckWorkspaceId)
            .maybeSingle()
        : Promise.resolve({ data: null, error: null }),
      // Per-workspace self-approval opt-in for this deck's workspace. Feeds the
      // inline proposal chip's affordance hints (the apply RPC re-checks).
      deckWorkspaceId
        ? supabase
            .from("workspaces")
            .select("canvas_allow_self_approval")
            .eq("id", deckWorkspaceId)
            .maybeSingle()
        : Promise.resolve({ data: null }),
      // Does the caller already have a usable MCP token in this workspace?
      user && deckWorkspaceId
        ? supabase
            .from("canvas_mcp_token")
            .select("token, expires_at")
            .eq("user_id", user.id)
            .eq("workspace_id", deckWorkspaceId)
            .is("revoked_at", null)
        : Promise.resolve({ data: [] as { token: string; expires_at: string | null }[] }),
      // Full workspace member roster (id + name + email) for the comment
      // composer's @mention autocomplete. The embedded `users` join rides RLS
      // the same way the role lookup above does. Guests aren't full members, so
      // they don't appear as mention targets — matching the server resolver,
      // which only resolves against workspace_memberships.
      deckWorkspaceId
        ? supabase
            .from("workspace_memberships")
            .select("user:users(id, email, name)")
            .eq("workspace_id", deckWorkspaceId)
        : Promise.resolve({ data: [] as { user: MentionMember | null }[] }),
      user
        ? getOpenRouterConfigSummary(user.id, deckWorkspaceId)
        : Promise.resolve({
            configured: false,
            source: null,
            provider: "openrouter" as const,
            encryptionReady: false,
            keyHint: null,
            modelId: "openrouter/auto",
            defaultRuntime: "bridge" as const,
            validatedAt: null,
          }),
      // Historical qualifying self-approvals by THIS viewer on THIS deck — the
      // seed count for the inline fast-lane offer. Derived from the DB (not a
      // client-side tally) so every approve surface counts — single chip,
      // multi-select, the inbox — and the count survives browsers and reloads.
      // The filters mirror approvalCountsTowardFastLaneOffer's proposal shape;
      // the context half (lane off, can manage, self-approval on) is the
      // workspace's job at render time. Skipped once the lane is on.
      user && !(deck as { agent_fast_lane_enabled?: boolean }).agent_fast_lane_enabled
        ? supabase
            .from("canvas_deck_edit")
            .select("id", { count: "exact", head: true })
            .eq("deck_id", id)
            .eq("status", "applied")
            .eq("proposed_by_kind", "claude")
            .eq("auto_apply_eligible", true)
            .not("agent_rendered_at", "is", null)
            .eq("proposed_by", user.id)
            .eq("resolved_by", user.id)
        : Promise.resolve({ count: 0 }),
    ]);

  const authorProfiles = authorProfilesResult.data ?? [];
  const emailByAuthorId = new Map(
    authorProfiles.map((u) => [u.id, u.email as string | null]),
  );
  const nameByAuthorId = new Map(
    authorProfiles.map((u) => [u.id, (u.name as string | null) ?? null]),
  );

  const comments: CommentRow[] = commentRowsRaw.map((c) => ({
    ...c,
    // Members resolve to their live profile; client comments keep the stored,
    // unverified attribution they were posted with.
    author_email: c.author_id
      ? emailByAuthorId.get(c.author_id) ?? null
      : (c.author_email as string | null) ?? null,
    author_name: c.author_id
      ? nameByAuthorId.get(c.author_id) ?? null
      : (c.author_name as string | null) ?? null,
  }));

  const { data: membership, error: membershipErr } = membershipResult as {
    data: { role: string | null } | null;
    error: { message: string } | null;
  };
  if (membershipErr) {
    console.error("[deck page] role lookup", membershipErr);
  }
  const currentUserRole: WorkspaceRole | null =
    user && deckWorkspaceId ? parseWorkspaceRole(membership?.role) : null;

  const allowSelfApproval =
    (wsRowResult.data as { canvas_allow_self_approval?: boolean } | null)
      ?.canvas_allow_self_approval === true;

  // Pull the current user's profile name so the "new comment" preview and
  // similar own-attribution sites read "Jane Smith" instead of
  // "jane.smith". Falls back to `user_metadata` so we work even if
  // the profile row hasn't been backfilled yet.
  const currentUserName = user
    ? ((user.user_metadata?.name as string | null | undefined) ??
        (user.user_metadata?.full_name as string | null | undefined) ??
        (nameByAuthorId.get(user.id) ?? null)) ?? null
    : null;

  // Fresh-deck heuristic — drives the guided first-deck overlay.
  // A deck counts as fresh iff it still has just the seed: one slide at v1,
  // no comments, and zero proposals across all statuses. The moment anything
  // happens (an applied edit, a rejected proposal, a comment) the overlay
  // disappears for good. The count came back in the Tier-1 batch (`head: true`,
  // so no row data is paid for).
  const totalProposals = (totalProposalsResult as { count: number | null }).count ?? 0;
  const isFreshDeck =
    slides.length === 1 &&
    slides[0].current_version_no === 1 &&
    comments.length === 0 &&
    totalProposals === 0;

  // The active-MCP-token probe rode in the deck/user Tier-2 batch above; a
  // matching row means the caller is past onboarding, so we hide the CTA.
  const hasActiveMcpToken = (tokenRowResult.data ?? []).some(
    (token) => !isMcpTokenExpired(token.expires_at),
  );

  // Flatten the membership→users join into the bare {id,name,email} the
  // composer's mention autocomplete needs. Drop rows whose user join didn't
  // resolve (deleted profile) and members with no id. Supabase types an
  // embedded to-one join as a possibly-array, so we normalize either shape.
  const memberRowsRaw = (membersResult.data ?? []) as Array<{
    user: MentionMember | MentionMember[] | null;
  }>;
  const members: MentionMember[] = memberRowsRaw
    .map((r) => (Array.isArray(r.user) ? r.user[0] ?? null : r.user))
    .filter((u): u is MentionMember => Boolean(u?.id));

  // Workspace brand kit (0065) → the compact blurb the assistant folds into
  // every turn. Read under the caller's RLS (full members; guests get null).
  // One tiny unique-index lookup, deliberately outside the perf tiers.
  let brandBlurb: string | null = null;
  if (deckWorkspaceId) {
    const { data: brandRow } = await supabase
      .from("canvas_brand")
      .select("name, tokens, voice")
      .eq("workspace_id", deckWorkspaceId)
      .maybeSingle();
    if (brandRow) {
      brandBlurb = buildBrandBlurb({
        name: (brandRow.name as string | null) ?? null,
        tokens: normalizeBrandTokens(brandRow.tokens),
        voice: (brandRow.voice as string | null) ?? null,
      });
    }
  }

  return (
    <>
      {/*
        Live presence: tells the layout's PresenceProvider which deck is open
        and who the viewer is, so the topbar shows the active collaborators on
        this deck. Renders nothing itself.
      */}
      <DeckPresenceTracker
        deckId={deck.id}
        userId={user?.id ?? null}
        userName={currentUserName}
        userEmail={user?.email ?? null}
      />
      <DeckWorkspace
        deck={{
          id: deck.id,
          workspace_id: deck.workspace_id,
          title: deck.title,
          status: deck.status,
          updated_at: deck.updated_at,
          visibility: (deck.visibility === "private" ? "private" : "workspace"),
          created_by: deck.created_by,
          agent_fast_lane_enabled: deck.agent_fast_lane_enabled ?? false,
          archived_at: deck.archived_at ?? null,
        }}
        slides={slides}
        comments={comments}
        currentUserId={user?.id ?? null}
        currentUserEmail={user?.email ?? null}
        currentUserRole={currentUserRole}
        currentUserName={currentUserName}
        allowSelfApproval={allowSelfApproval}
        deckPendingCount={deckPendingCount}
        pendingProposals={pendingProposals}
        initialProposalId={initialProposalId}
        initialFullSheet={resolvedInitialFullSheet}
        initialSlideId={initialSlideId}
        isFreshDeck={isFreshDeck}
        hasActiveMcpToken={hasActiveMcpToken}
        openRouterReady={
          openRouterConfig.configured && openRouterConfig.encryptionReady
        }
        openRouterModel={openRouterConfig.modelId}
        initialAssistantRuntime={openRouterConfig.defaultRuntime}
        brandBlurb={brandBlurb}
        members={members}
        fastLaneQualifyingCount={fastLaneCountResult.count ?? 0}
      />
    </>
  );
}

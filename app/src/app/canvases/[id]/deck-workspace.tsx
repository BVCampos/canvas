"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
} from "react";
import {
  Camera,
  Check,
  ChevronDown,
  ClipboardCheck,
  Code2,
  Copy,
  FileDown,
  GripVertical,
  History as HistoryIcon,
  Keyboard,
  Lock,
  MessageSquare,
  MoreHorizontal,
  Pencil,
  Play,
  Plus,
  Presentation,
  RefreshCw,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  Unlock,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MenuSurface } from "@/components/ui/menu-surface";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { cn, displayName, relativeDate } from "@/lib/utils";
import type { MentionMember } from "@/lib/canvas/mention";
import { eligibleForBatch } from "@/lib/canvas/batch-approve";
import { computeProposalPermissions } from "@/lib/canvas/proposal-permissions";
import {
  createSlideDirect,
  deleteDeck,
  duplicateDeck,
  duplicateSlide,
  forceReleaseSlide,
  getSlideHtml,
  lockSlide,
  proposeDeleteSlide,
  releaseSlide,
  renewSlideLock,
  renameDeck,
  reorderSlidesDirect,
  saveSlideHtmlDirect,
  setDeckStatus,
  setDeckAgentFastLane,
  type DeckStatus,
} from "./actions";
import {
  approveProposal,
  revertProposal,
  proposeSlideHtmlEdit,
} from "@/app/canvases/proposal-actions";
import { DeckChrome } from "./deck-chrome";
import { DrawCanvas } from "./draw-canvas";
import {
  sceneToSlideHtml,
  parseSceneFromHtml,
  injectDrawOverlay,
  hasDrawOverlayHtml,
  emptyScene,
  type DrawScene,
} from "@/lib/canvas/draw/scene";
import { ElementInspector, type InspectSnapshot } from "./element-inspector";
import { ShareDeckDialog } from "./share-dialog";
import { SlideCommentsOverlay } from "./slide-comments-overlay";
import { UnpinnedNotes } from "./unpinned-notes";
import type {
  CommentRow,
  PendingProposalRow,
  SlideRow,
  WorkspaceRole,
} from "./page";
import {
  ProposalChip,
  ResultStripView,
  type DecisionStrip,
  type ProposalDecision,
} from "./proposal-chip";
import { ProposalSheet } from "./proposal-sheet";
import { SnapshotDialog } from "./snapshot-dialog";
import { PreflightDialog } from "./preflight-dialog";
import { CopySlideDialog } from "./copy-slide-dialog";
import type { RealtimePostgresChangesPayload } from "@supabase/supabase-js";
import {
  useDeckRealtime,
  type DeckRealtimeStatus,
  type CommentRealtimeRow,
  type LockRealtimeRow,
  type SlideRealtimeRow,
} from "./use-deck-realtime";
import {
  applyCommentRealtime,
  applyLockRealtime,
  applySlideRealtime,
  type ActorResolver,
} from "@/lib/canvas/realtime-patch";
import { decideRemount, selfAppliedKey } from "@/lib/canvas/preview-remount";
import {
  approvalCountsTowardFastLaneOffer,
  FAST_LANE_OFFER_THRESHOLD,
} from "@/lib/canvas/fast-lane-offer";
import { AssistantPanel, type AssistantPickTarget } from "./assistant-panel";
import { LENS_KINDS } from "@/lib/canvas/proposal-types";

type DeckMeta = {
  id: string;
  workspace_id: string;
  title: string;
  status: string;
  updated_at: string;
  visibility: "workspace" | "private";
  created_by: string | null;
  agent_fast_lane_enabled: boolean;
};

type ExportJob = {
  format: "PDF" | "PowerPoint";
  status: "running" | "success" | "error";
  startedAt: number;
  error?: string;
};

// LENS_KINDS — the change kinds the preview route (api/decks/[id]/preview/route.ts)
// can render with ?proposalId applied, i.e. the ones the Lens shows as a proposed
// overlay frame — is the single source in proposal-types.ts (imported above,
// shared with proposal-chip.tsx and assistant-panel.tsx). slide_create IS in it
// (the route inserts the new slide and the Lens wipes it against the slide
// currently at that position); slide_reorder / slide_delete are NOT — the route
// can't assemble them, so they fall back to the source modal.

// How long the post-decision strip stays up. Long enough to read and hit
// Undo (U) after an approve; no countdown text — the decision is already
// committed, the strip is a receipt, not a timer.
const DECISION_STRIP_MS = 8000;

export function DeckWorkspace({
  deck,
  // The server-loaded slides + comments are the AUTHORITATIVE base; realtime
  // events patch a local overlay on top (see slidesProp/commentsProp below) so
  // a teammate's comment or lock doesn't force a loader re-run that would
  // disturb in-flight UI. Each refresh re-seeds the overlay from these props.
  slides: slidesProp,
  comments: commentsProp,
  currentUserId,
  currentUserEmail,
  currentUserRole,
  currentUserName,
  allowSelfApproval = false,
  deckPendingCount,
  pendingProposals,
  initialProposalId = null,
  initialFullSheet = false,
  initialSlideId = null,
  isFreshDeck = false,
  hasActiveMcpToken = false,
  openRouterReady = false,
  openRouterModel = "openrouter/auto",
  initialAssistantRuntime = "bridge",
  brandBlurb = null,
  members = [],
}: {
  deck: DeckMeta;
  slides: SlideRow[];
  comments: CommentRow[];
  currentUserId: string | null;
  currentUserEmail: string | null;
  currentUserRole: WorkspaceRole | null;
  currentUserName: string | null;
  allowSelfApproval?: boolean;
  deckPendingCount: number;
  pendingProposals: PendingProposalRow[];
  // Workspace member roster for the comment composer's @mention autocomplete.
  members?: MentionMember[];
  initialProposalId?: string | null;
  initialFullSheet?: boolean;
  // ?slide= deep link, mirrored into the URL by the sync effect below — a
  // workspace remount (e.g. a refresh racing a decision) restores the slide
  // the user was on instead of bouncing to slide 1.
  initialSlideId?: string | null;
  isFreshDeck?: boolean;
  hasActiveMcpToken?: boolean;
  openRouterReady?: boolean;
  openRouterModel?: string;
  initialAssistantRuntime?: "bridge" | "openrouter";
  // Compact workspace-brand context for the assistant (see buildBrandBlurb).
  brandBlurb?: string | null;
}) {
  const router = useRouter();

  // --- Realtime overlay: local comment + lock state patched from the realtime
  // payload (see useDeckRealtime + lib/canvas/realtime-patch). The server props
  // (slidesProp / commentsProp) are authoritative; these mirror them and absorb
  // surgical patches so a teammate's comment or lock claim doesn't trigger the
  // heavy loader re-run that would disturb a half-typed reply or an open menu.
  // A structural change still calls router.refresh(), which delivers a new prop
  // identity — the render-phase reconcile below re-seeds the overlay from it, so
  // the patches never drift away from the server's truth.
  const [comments, setComments] = useState<CommentRow[]>(commentsProp);
  const [slides, setSlides] = useState<SlideRow[]>(slidesProp);
  // Reconcile on prop-identity change (React's "adjust state on prop change"
  // pattern — same idiom as the selectedProposalIds reconcile below). A new
  // commentsProp/slidesProp reference means the loader re-ran; adopt it wholesale
  // and discard any now-superseded local patches.
  const [seenCommentsProp, setSeenCommentsProp] = useState(commentsProp);
  if (seenCommentsProp !== commentsProp) {
    setSeenCommentsProp(commentsProp);
    setComments(commentsProp);
  }
  const [seenSlidesProp, setSeenSlidesProp] = useState(slidesProp);
  if (seenSlidesProp !== slidesProp) {
    setSeenSlidesProp(slidesProp);
    setSlides(slidesProp);
  }

  // Latest overlay snapshots for the realtime patch callbacks. The callbacks
  // must read the CURRENT comments/slides AND return a boolean to the hook
  // (handled-locally vs fall-back-to-refresh) in the same call, which the
  // functional setState updater can't express — so we read the freshest value
  // off a ref. Ref writes happen in an effect (React-19 forbids writing a ref
  // during render).
  const commentsRef = useRef<CommentRow[]>(comments);
  const slidesRef = useRef<SlideRow[]>(slides);
  useEffect(() => {
    commentsRef.current = comments;
  }, [comments]);
  useEffect(() => {
    slidesRef.current = slides;
  }, [slides]);

  // Resolve a user id → (email, name) for realtime attribution, from the cached
  // member roster + the current user. Returns null for an id outside the roster
  // (e.g. a guest), which makes the patch defer to a refresh so the loader's
  // users-join fills the name in. Stable identity (keyed on the roster + self)
  // so the realtime callbacks below don't re-bind the websocket each render.
  const resolveActor = useCallback<ActorResolver>(
    (userId) => {
      if (!userId) return null;
      if (userId === currentUserId) {
        return { email: currentUserEmail, name: currentUserName };
      }
      const m = members.find((mem) => mem.id === userId);
      if (m) return { email: m.email ?? null, name: m.name ?? null };
      return null;
    },
    [members, currentUserId, currentUserEmail, currentUserName],
  );

  const isWorkspaceAdmin =
    currentUserRole === "admin" || currentUserRole === "owner";
  const canForceRelease = isWorkspaceAdmin;
  const canManageFastLane =
    isWorkspaceAdmin || deck.created_by === currentUserId;
  // Any full member can moderate (delete/resolve) any comment — mirrors the
  // 0036 RLS policy. Guests only get author-level rights via the per-comment
  // isOwn check.
  const canModerateComments =
    isWorkspaceAdmin || currentUserRole === "member";
  // When the page is seeded with a pending proposal targeting a specific
  // slide, open on that slide so the chip's preview swap renders in place.
  // Resolved proposals route through the sheet (initialFullSheet) and don't
  // need a slide snap.
  const [selectedId, setSelectedId] = useState<string | null>(() => {
    if (!initialFullSheet && initialProposalId) {
      const target = pendingProposals.find((p) => p.id === initialProposalId);
      if (target?.slide_id) {
        const slide = slides.find((s) => s.id === target.slide_id);
        if (slide) return slide.id;
      }
      // A slide_create has no slide of its own. Open on whatever slide currently
      // sits at its insert position so the Lens base frame shows that slide as
      // the "before" — matching the activation-time snap for the chip path. The
      // proposed overlay shows the new slide at the same seam.
      if (
        target?.kind === "slide_create" &&
        target.new_slide_position != null &&
        slides.length > 0
      ) {
        const idx = Math.min(
          Math.max(target.new_slide_position, 0),
          slides.length - 1,
        );
        return slides[idx].id;
      }
    }
    if (initialSlideId && slides.some((s) => s.id === initialSlideId)) {
      return initialSlideId;
    }
    return slides[0]?.id ?? null;
  });
  const [previewKey, setPreviewKey] = useState(0);
  // Tracks the iframe load state so we can cover the blank window during
  // serverless cold start (the /api/decks/{id}/preview route can take 2-5s on
  // a fresh Vercel function instance) with a pulse skeleton instead of a
  // blank white pane. Goes false again whenever the iframe re-mounts via
  // previewKey or src change.
  const [previewLoaded, setPreviewLoaded] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [promptCopied, setPromptCopied] = useState(false);
  const [commentMode, setCommentMode] = useState(false);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [showResolved, setShowResolved] = useState(false);
  const [snapshotOpen, setSnapshotOpen] = useState(false);
  const [deckMenuOpen, setDeckMenuOpen] = useState(false);
  // Overflow popover for the share/navigate cluster (Refresh, Snapshot,
  // History). Mirrors the deckMenu pattern — outside-click + Esc dismiss.
  const [shareMenuOpen, setShareMenuOpen] = useState(false);
  // Edit ▾ flyout (Ask agent / edit text / edit HTML). Same dismissal
  // contract as the deck/share menus, and the same key-guard treatment.
  const [editMenuOpen, setEditMenuOpen] = useState(false);
  const [exportMenuOpen, setExportMenuOpen] = useState(false);
  // Pre-flight findings dialog (opened from the Export menu — the "check
  // before it leaves the building" step). The dialog owns its own fetch.
  const [preflightOpen, setPreflightOpen] = useState(false);
  // Cross-deck slide copy picker (slide library v0).
  const [copySlideOpen, setCopySlideOpen] = useState(false);
  // True while the server renders the PDF (headless Chromium — seconds, not
  // ms), so the Export button can show progress and block double-fires.
  const [pdfExporting, setPdfExporting] = useState(false);
  // Same for the PPTX render (also a headless-Chromium screenshot pass).
  const [pptxExporting, setPptxExporting] = useState(false);
  const [exportJob, setExportJob] = useState<ExportJob | null>(null);
  const [exportElapsed, setExportElapsed] = useState(0);
  useEffect(() => {
    if (exportJob?.status !== "running") return;
    const tick = () =>
      setExportElapsed(Math.max(0, Math.floor((Date.now() - exportJob.startedAt) / 1000)));
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [exportJob]);
  useEffect(() => {
    if (exportJob?.status !== "success") return;
    const id = window.setTimeout(() => setExportJob(null), 5000);
    return () => window.clearTimeout(id);
  }, [exportJob]);
  // Deck-level dialogs: rename + delete confirmation. The delete confirm
  // replaces the prior `window.confirm()` so destructive actions live inside
  // the design system (matches SnapshotDialog's pattern: backdrop + Esc-to-
  // close + body-scroll-lock). Rename is opt-in from the same overflow menu.
  const [renameOpen, setRenameOpen] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  // Per-slide delete confirm (left rail). Holds the target slide so the dialog
  // can name it; null = closed. Confirming raises a slide_delete PROPOSAL —
  // the actual removal happens when a reviewer approves it.
  const [deleteSlideTarget, setDeleteSlideTarget] = useState<SlideRow | null>(
    null,
  );
  // Left-rail drag-to-reorder. `draggingSlideId` is the row being dragged;
  // `dropTarget` marks where it would land (the hovered row + whether the seam
  // is below it) so we can paint an insertion line. Both clear on drop/end.
  const [draggingSlideId, setDraggingSlideId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{
    overId: string;
    below: boolean;
  } | null>(null);
  // Draw surface (Excalidraw-style). `drawOpen` mounts the modal; a null
  // `drawScene` means "new blank slide", a non-null one re-opens an existing
  // drawn slide. `drawEditingSlideId` null = create (direct insert), set =
  // editing that slide (direct save). `drawBaseVersionId` is the optimistic-
  // concurrency base for the edit save.
  const [drawOpen, setDrawOpen] = useState(false);
  const [drawSaving, setDrawSaving] = useState(false);
  const [drawScene, setDrawScene] = useState<DrawScene | null>(null);
  const [drawEditingSlideId, setDrawEditingSlideId] = useState<string | null>(
    null,
  );
  const [drawInitialTitle, setDrawInitialTitle] = useState("");
  const [drawBaseVersionId, setDrawBaseVersionId] = useState<string | null>(null);
  // Overlay mode: draw ON TOP of an existing slide. `drawOverlay` flips the
  // surface into overlay chrome; `drawBaseHtml` is the slide's html_body the new
  // overlay is injected into at save time; `drawBackdropSrc` renders that slide
  // behind the canvas. When set, `drawEditingSlideId` is the annotated slide and
  // the save routes through the same edit gate as an inline HTML edit (direct if
  // you can direct-save the slide, a proposal otherwise) — an overlay IS a
  // content edit, unlike an additive fresh drawing.
  const [drawOverlay, setDrawOverlay] = useState(false);
  const [drawBaseHtml, setDrawBaseHtml] = useState("");
  const [drawBackdropSrc, setDrawBackdropSrc] = useState<string | null>(null);
  // The slide's version NUMBER at overlay-open time — the base the propose path
  // stale-checks against, so a concurrent body edit between open and save is
  // caught rather than silently reverted on approval. (The direct path uses the
  // version ID `drawBaseVersionId` for the same guard.)
  const [drawBaseVersionNo, setDrawBaseVersionNo] = useState<number | null>(null);
  const [shareDialogOpen, setShareDialogOpen] = useState(false);
  // Keyboard-shortcuts reference overlay (opened from the overflow menu or the
  // "?" key). Surfaces the shortcuts that already exist but were invisible:
  // arrow nav, Present (P), comment Esc, Alt-compare.
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [isPending, startTransition] = useTransition();
  // Tracks whether the realtime subscription is healthy. We only render the
  // degrade banner on the failure states (CHANNEL_ERROR / TIMED_OUT); a fresh
  // SUBSCRIBED clears it.
  const [realtimeDegraded, setRealtimeDegraded] = useState(false);
  // Inline proposal review state. `activeProposalId` drives the Lens: the base
  // frame stays on the current deck and a proposed overlay frame renders the
  // change, wiped between by `reveal` (declared below near the iframe refs).
  // Hold Alt (momentary) or drag the seam (sticky) to reveal the current
  // state beneath the proposal.
  // `fullSheetId` controls the full-diff ProposalSheet — opened from the chip
  // or seeded via ?full=1 on initial load.
  const [activeProposalId, setActiveProposalId] = useState<string | null>(
    // When the page is loading a resolved proposal (sheet auto-opens via
    // initialFullSheet), keep the chip out of the way — its preview swap is
    // pending-only. The user can still pick a pending proposal afterwards.
    initialFullSheet ? null : initialProposalId,
  );
  const [fullSheetId, setFullSheetId] = useState<string | null>(
    initialFullSheet ? initialProposalId : null,
  );
  // Responsive drawers. The native left + right rails are hidden below the
  // lg (1024px) breakpoint to give the preview enough room to honour the
  // 16:9 aspect at narrower widths; these flags mirror them as slide-over
  // overlays driven by the hamburger (top-left of the chrome) and the
  // "Comments" tab button (in the toolbar cluster) respectively. On <640px
  // the right rail flips to a bottom sheet — same component, different
  // anchoring class — so the affordance stays reachable when the right edge
  // would clip toolbar buttons. Both drawers are no-ops at xl since the
  // triggers are display:none above lg.
  const [mobileSlideListOpen, setMobileSlideListOpen] = useState(false);
  const [mobileRailOpen, setMobileRailOpen] = useState(false);
  // The permanent right rail is mode-aware: the assistant owns the space while
  // creating, and Activity expands when proposals arrive or the user asks for
  // it. Either section can still be collapsed independently.
  const [assistantOpen, setAssistantOpen] = useState(true);
  const [activityOpen, setActivityOpen] = useState(deckPendingCount > 0);
  const [seenPendingCount, setSeenPendingCount] = useState(deckPendingCount);
  if (seenPendingCount !== deckPendingCount) {
    setSeenPendingCount(deckPendingCount);
    if (deckPendingCount > 0) setActivityOpen(true);
    else if (seenPendingCount > 0) setActivityOpen(false);
  }
  // The element the user pinpointed in the preview (toolbar "Ask agent" pick
  // mode), handed to the assistant composer as a context chip. `pickNonce`
  // bumps on every fresh pick so the panel can focus its composer (and open the
  // floating shape on mobile) even when the target is reference-equal.
  const [assistantTarget, setAssistantTarget] =
    useState<AssistantPickTarget | null>(null);
  const [assistantPickNonce, setAssistantPickNonce] = useState(0);
  const openAssistant = () => {
    setAssistantOpen(true);
    setAssistantPickNonce((n) => n + 1);
  };
  // Below lg the right rail — where the `feedback` line renders — sits inside
  // the closed Activity sheet, so confirmations like "Link copied." were
  // invisible exactly where the ⋯ menu is most used. Mirror the latest
  // message as a transient bottom-center pill over the preview (~3s,
  // seam-caption styling — no new toast system). Render-phase adjust + a
  // timer-only effect, same pattern as the other prop-change resets.
  const [lastFeedback, setLastFeedback] = useState<string | null>(feedback);
  const [mobileFeedbackShown, setMobileFeedbackShown] = useState(false);
  if (lastFeedback !== feedback) {
    setLastFeedback(feedback);
    if (feedback) setMobileFeedbackShown(true);
  }
  useEffect(() => {
    if (!mobileFeedbackShown) return;
    const id = window.setTimeout(() => setMobileFeedbackShown(false), 3000);
    return () => window.clearTimeout(id);
    // Re-arm on lastFeedback so a new message restarts the 3s window even
    // while the pill is already up.
  }, [mobileFeedbackShown, lastFeedback]);
  // iframeRef is the CURRENT (base) deck frame — the navigation + selection
  // authority and the comment-bounds source. When a proposal is active the
  // PROPOSED deck renders in a SECOND, warm overlay frame (proposedIframeRef)
  // stacked on top; we never swap a single frame's src to compare, so before↔
  // after is a CSS wipe with zero reload. This is the "Lens".
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const proposedIframeRef = useRef<HTMLIFrameElement | null>(null);
  // `reveal` ∈ [0,1] = how much of the slide, from the left, shows CURRENT
  // (before) instead of PROPOSED (after). 0 = entirely proposed (the resting
  // state when a proposal is active); 1 = entirely current. The proposed
  // overlay is clipped by inset(left = reveal). Driven by the seam drag
  // (sticky) and Alt-hold (momentary peek).
  const [reveal, setReveal] = useState(0);
  // True only while the user is dragging the seam — disables the clip-path
  // transition so the wipe tracks the pointer 1:1 instead of lagging behind it.
  const [wipeDragging, setWipeDragging] = useState(false);
  // The proposed overlay loads independently of the base; until it's painted we
  // keep it transparent so the base (current) shows through cleanly rather than
  // flashing a half-loaded frame.
  const [proposedLoaded, setProposedLoaded] = useState(false);
  const previewWrapRef = useRef<HTMLDivElement | null>(null);
  const deckMenuRef = useRef<HTMLDivElement | null>(null);
  const shareMenuRef = useRef<HTMLDivElement | null>(null);
  const editMenuRef = useRef<HTMLDivElement | null>(null);
  const exportMenuRef = useRef<HTMLDivElement | null>(null);

  // Direct (non-proposal) inline editing of the selected slide's HTML.
  //   "visual" — the base iframe's <section> is made contentEditable in place
  //              (CANVAS_EDITOR in assemble.ts); on save the iframe serializes
  //              the slide HTML back to us over postMessage.
  //   "code"   — a raw-HTML textarea overlay sourced from getSlideHtml.
  //   "inspect" — the direct-manipulation inspector ("Adjust"): click an
  //              element in the preview, get font/color/spacing/width controls
  //              + arrow-key nudge; the iframe applies styles in place.
  // All commit through saveSlideHtmlDirect, which versions the slide just like
  // a proposal approval. `editingSlideId` pins the edit to one slide so
  // navigating away can abandon it cleanly. `editBaseVersionId` is the version
  // we opened against — passed back as the optimistic-concurrency base on save.
  const [editMode, setEditMode] = useState<
    "none" | "visual" | "code" | "inspect"
  >("none");
  // Element pick mode: the user clicks an element in the live preview and it's
  // handed to the in-app Ask agent composer as a context chip anchored on that
  // exact snippet. Bridges designer language ("make this block bigger") to
  // propose_slide_patch instead of a full rewrite from a stale context.
  const [pickingPrompt, setPickingPrompt] = useState(false);
  // Confirmation popover for a picked element. Anchored ON the element the
  // user just clicked (coordinates relative to previewWrapRef — the iframe
  // fills that wrapper 1:1, so the rect the iframe posts needs no scaling)
  // instead of the sidebar feedback line, which is where nobody is looking
  // mid-pick. `above` flips the popover over the element when the anchor is
  // too close to the frame's bottom edge.
  const [pickPopover, setPickPopover] = useState<{
    x: number;
    y: number;
    above: boolean;
    text: string;
    error: boolean;
  } | null>(null);
  // The inspector's current selection (descriptor + computed-style snapshot
  // posted by the iframe). `inspectSeq` keys the panel so each new selection
  // remounts it with fresh control state.
  const [inspectSel, setInspectSel] = useState<{
    descriptor: string;
    styles: InspectSnapshot;
  } | null>(null);
  const [inspectSeq, setInspectSeq] = useState(0);
  // True while the selected element's text is being typed in place (double-click
  // or the inspector's "Edit text" button → canvas:inspect-text-state). Drives
  // the toolbar hint copy and the inspector's text-button pressed state. The
  // typed text rides the slide HTML on Save — no separate text payload.
  const [inspectTextEditing, setInspectTextEditing] = useState(false);
  const [editingSlideId, setEditingSlideId] = useState<string | null>(null);
  const [editSaving, setEditSaving] = useState(false);
  const [codeDraft, setCodeDraft] = useState("");
  const [codeLoading, setCodeLoading] = useState(false);
  const [editBaseVersionId, setEditBaseVersionId] = useState<string | null>(null);
  // Mirror "am I editing?" into a ref so effects that must NOT re-run on
  // editMode (e.g. the slide-signature remount) can read it without taking a
  // setState-on-state-change dependency the React-19 purity lint forbids.
  // Ref-only mutation in an effect is not a set-state-in-effect violation.
  const editingRef = useRef(false);
  useEffect(() => {
    editingRef.current = editMode !== "none";
  }, [editMode]);

  // `${slideId}:${versionNo}` keys for versions THIS tab just produced via an
  // inline direct-save. When the revalidated props echo one back as a version
  // bump, the preview iframe already shows that content in place (the editor
  // committed it and dropped contenteditable), so the signature effect skips
  // the remount for it instead of reloading the whole deck (speed #5.2).
  const selfAppliedVersionsRef = useRef<Set<string>>(new Set());

  // React 19.2 batches Suspense reveals via $RC → $RB → $RV: the resolved
  // boundary content sits in <div hidden id="S:N"> off body until the next
  // requestAnimationFrame swaps it into place. The iframe inside that buffer
  // would otherwise fire /api/decks/{id}/preview and post canvas:state messages
  // before being moved into the visible tree — duplicate request, cross-mount
  // chatter, and an extra iframe reload from insertBefore. Gating `src` on the
  // wrapper's offsetParent (null while any ancestor is display:none) keeps the
  // request held until the swap actually happens. RAF-polling is throttled in
  // hidden tabs alongside $RV, so the wait costs nothing while parked.
  const [srcReady, setSrcReady] = useState(false);
  useEffect(() => {
    let rafId: number | null = null;
    const tick = () => {
      if (previewWrapRef.current?.offsetParent != null) {
        setSrcReady(true);
        return;
      }
      rafId = requestAnimationFrame(tick);
    };
    tick();
    return () => {
      if (rafId != null) cancelAnimationFrame(rafId);
    };
  }, []);

  // Live multiplayer: subscribe to Supabase Realtime for this deck's tables.
  // Hot, small-payload events (a comment, a lock claim/release) are PATCHED into
  // the local overlay from the realtime row — no loader re-run, so a half-typed
  // reply or an open menu survives. Structural changes (slide version bumps,
  // reorder, proposal lifecycle) still call router.refresh() (debounced ~400ms)
  // because they reshape the join the loader assembles. A patch that can't be
  // resolved locally (an author/holder outside the cached roster) returns false
  // and falls back to that same refresh, so attribution is never wrong. The
  // onStatusChange callback surfaces a non-blocking "live updates paused" banner
  // if the websocket drops.
  //
  // The patch callbacks return true when they handled the event locally. They
  // read the latest overlay via the functional setState updater, so they don't
  // need `comments`/`slides` in a dependency list (which would re-bind the
  // socket on every comment). resolveActor is stable.
  const handleCommentRealtime = useCallback(
    (payload: RealtimePostgresChangesPayload<CommentRealtimeRow>): boolean => {
      const result = applyCommentRealtime(
        commentsRef.current,
        payload,
        resolveActor,
      );
      if (result.kind === "refresh") return false;
      // Identity unchanged (no-op patch / already applied) — skip the setState.
      if (result.comments !== commentsRef.current) setComments(result.comments);
      return true;
    },
    [resolveActor],
  );
  const handleLockRealtime = useCallback(
    (payload: RealtimePostgresChangesPayload<LockRealtimeRow>): boolean => {
      const result = applyLockRealtime(slidesRef.current, payload, resolveActor);
      // "ignore" = a lock for another deck in the workspace: handled (no
      // refresh) but nothing to patch. "refresh" = couldn't resolve the holder.
      if (result.kind === "refresh") return false;
      if (result.kind === "ignore") return true;
      if (result.slides !== slidesRef.current) setSlides(result.slides);
      return true;
    },
    [resolveActor],
  );
  const handleSlideRealtime = useCallback(
    (payload: RealtimePostgresChangesPayload<SlideRealtimeRow>): boolean => {
      // Never fold a slide row in under an in-progress inline edit — the
      // contentEditable DOM is the source of truth until Save, and rewriting
      // `slides` (→ the remount signature) mid-edit would yank the iframe. Defer
      // to a refresh, which the signature effect already suppresses while editing.
      if (editingRef.current) return false;
      const result = applySlideRealtime(slidesRef.current, payload);
      if (result.kind === "refresh") return false;
      if (result.slides !== slidesRef.current) setSlides(result.slides);
      // 'patched-refresh' = the id landed in place (preview remounts now) but
      // current_version_no is stale on the row; return false so the debounced
      // loader refresh re-derives it. Pure 'patched' handled fully in place.
      return result.kind === "patched";
    },
    [],
  );

  useDeckRealtime(deck.id, deck.workspace_id, {
    onStatusChange: (status: DeckRealtimeStatus) => {
      if (status === "SUBSCRIBED") setRealtimeDegraded(false);
      else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT")
        setRealtimeDegraded(true);
    },
    onCommentChange: handleCommentRealtime,
    onLockChange: handleLockRealtime,
    onSlideChange: handleSlideRealtime,
  });

  // Build the deck's absolute URL only client-side so SSR doesn't try to read
  // `window`. The URL is just the current page's location — every deck has a
  // stable UUID id (`canvas_deck.id` defaults to `gen_random_uuid()`), so
  // workspace members can paste this anywhere to deep-link the deck.
  const handleCopyLink = async () => {
    if (typeof window === "undefined") return;
    try {
      await navigator.clipboard.writeText(window.location.href);
      // The trigger lives in the ⋯ menu (which closes on click), so confirm
      // through the feedback line instead of an in-place label swap.
      setFeedback("Link copied.");
    } catch (err) {
      console.error("[copy link]", err);
      setFeedback("Could not copy link — copy from the address bar.");
    }
  };

  // Copy a paste-ready prompt that points any external MCP agent at this deck.
  // user doesn't have to fish the UUID out of the address bar. The MCP tools
  // (get_deck / read_full_deck) all key off deck_id, so this prompt is
  // immediately actionable. Used by the overflow menu and the empty-deck CTA.
  const handleCopyPrompt = async () => {
    if (typeof window === "undefined") return;
    const url = `${window.location.origin}/canvases/${deck.id}`;
    const prompt = `Open Canvas deck ${deck.id} ("${deck.title}") with the canvas MCP server — get_deck for the slide list, read_slide for the slides you work on (read_full_deck only if you truly need the whole deck), and help me draft slides. Propose edits (propose_slide_patch for targeted tweaks, propose_slide_edit for redesigns) and I'll approve them in Canvas.\n${url}`;
    try {
      await navigator.clipboard.writeText(prompt);
      setPromptCopied(true);
      setFeedback("Prompt for agent copied — paste it into your MCP client.");
      setTimeout(() => setPromptCopied(false), 1800);
    } catch (err) {
      console.error("[copy prompt]", err);
      setFeedback("Could not copy — copy the deck ID from the address bar.");
    }
  };

  // Deck status (draft / in review / final), set from the deck overflow menu.
  // Mirrors the duplicate-deck handler's useTransition + feedback pattern; the
  // server action re-checks permission via RLS, so a denied write just toasts.
  const handleSetStatus = (next: DeckStatus) => {
    if (next === ((deck.status as DeckStatus) ?? "draft")) return;
    setFeedback(null);
    startTransition(async () => {
      const res = await setDeckStatus(deck.id, next);
      if (res.ok) {
        setFeedback(
          next === "final"
            ? "Status set to Final"
            : next === "in_review"
              ? "Status set to In review"
              : "Status set to Draft",
        );
        router.refresh();
      } else {
        setFeedback(`Status change failed: ${res.error}`);
      }
    });
  };

  // Per-slide duplicate (left rail). DIRECT for deck editors since migration
  // 0071 (a copy is additive — nobody's work is clobbered); a member the RPC
  // refuses still gets the pending proposal a reviewer approves. The action
  // reports which path ran so the feedback is honest. The action revalidates
  // the route, so no explicit refresh is needed here.
  const handleDuplicateSlide = (slideId: string) => {
    setFeedback(null);
    startTransition(async () => {
      const res = await duplicateSlide(deck.id, slideId);
      if (!res.ok) {
        setFeedback(`Duplicate failed: ${res.error}`);
        return;
      }
      setFeedback(
        res.mode === "direct"
          ? "Slide duplicated."
          : "Slide duplicate proposed — pending review",
      );
    });
  };

  // Per-slide delete (left rail). DIRECT for deck editors since 0071 (it's
  // recoverable via snapshot restore and audited by the activity log); a
  // member the RPC refuses falls back to the pending slide_delete proposal.
  // Called from the ConfirmDialog, never directly.
  const handleProposeDeleteSlide = (slideId: string) => {
    setFeedback(null);
    startTransition(async () => {
      const res = await proposeDeleteSlide(deck.id, slideId);
      if (res.ok) {
        setFeedback(
          res.mode === "direct"
            ? "Slide deleted."
            : "Slide delete proposed — pending review",
        );
        return;
      }
      // Translate the action's known codes into user language; anything else
      // is a raw DB message (already logged server-side) the user can't act on.
      const friendly: Record<string, string> = {
        cannot_delete_only_slide: "Can't delete the deck's only slide.",
        slide_not_found: "That slide no longer exists — reload the page.",
        not_authenticated: "Your session expired — sign in again.",
      };
      console.error("[proposeDeleteSlide]", res.error);
      setFeedback(
        friendly[res.error] ??
          "Couldn't delete the slide — you may not have permission to edit this deck.",
      );
    });
  };

  const selected = useMemo(
    () => slides.find((s) => s.id === selectedId) ?? slides[0] ?? null,
    [slides, selectedId],
  );

  // Label a slide id for the assistant's inline proposal cards ("Slide N —
  // Title"), and reveal a slide after an inline approval so the result shows in
  // place — both passed to AssistantPanel.
  const slideLabel = useCallback(
    (slideId: string | null) => {
      if (!slideId) return null;
      const s = slides.find((x) => x.id === slideId);
      return s ? `Slide ${s.position + 1}${s.title ? ` — ${s.title}` : ""}` : null;
    },
    [slides],
  );

  // --- Direct inline editing: derived state + handlers --------------------
  // Who may DIRECT-save a slide (commit immediately via saveSlideHtmlDirect):
  // the slide owner / a slide with no owner / a workspace admin. The RPC + the
  // canvas_deck_slide UPDATE RLS are the authoritative gate; this just decides
  // which save path the inline editor takes. created_by isn't in SlideRow, so a
  // creator-who-isn't-owner falls through to the RPC (which still allows them) —
  // they'll route through a proposal here and the reviewer approves, which is a
  // safe over-restriction, never an escalation.
  const isAdminViewer =
    currentUserRole === "admin" || currentUserRole === "owner";
  const canDirectEditSlide = useCallback(
    (slide: SlideRow | null | undefined): boolean =>
      Boolean(
        slide &&
          (isAdminViewer ||
            slide.owner_id === currentUserId ||
            slide.owner_id === null),
      ),
    [isAdminViewer, currentUserId],
  );
  const canEditSelected = canDirectEditSlide(selected);
  // Whether a member who CAN'T direct-save may still PROPOSE a hand edit. The
  // in-place edit surfaces open to anyone who can edit the deck (the
  // "editors propose edits" RLS, mirrored client-side: full member on a
  // workspace-visible deck, or any admin). A member who can't even propose
  // (e.g. a viewer) sees no Edit menu at all.
  const canProposeSlideEdit =
    isAdminViewer ||
    (currentUserRole === "member" && deck.visibility === "workspace");
  // Drag-to-reorder and draw-a-new-slide go DIRECT (the 0061 RPCs enforce
  // canvas_can_edit_deck); gate the affordances with the same client
  // approximation used for proposing an edit. Reorder is suppressed while an
  // inline edit or element-pick is in flight so a drag can't fight that gesture.
  const canCreateSlide = canProposeSlideEdit;
  const canReorderSlides =
    canProposeSlideEdit && editMode === "none" && !pickingPrompt;
  // The inline Edit menu is offered when the user can either direct-save the
  // selected slide OR propose a change to it. Save routes to the right path.
  const canEnterEdit = Boolean(selected) && (canEditSelected || canProposeSlideEdit);
  // True while an edit is open whose Save will land as a PROPOSAL (the editor
  // can't direct-save the slide being edited). Drives the Save button's label
  // ("Propose change" vs "Save"). Keyed on the pinned editing slide so the
  // label is correct even if it differs from the current selection.
  const editingProposes =
    editingSlideId != null &&
    !canDirectEditSlide(slides.find((s) => s.id === editingSlideId));

  // Best-effort 15-min soft lock before editing, so teammates + Claude see the
  // slide is being hand-edited. Returns false (with feedback) only when someone
  // ELSE holds a live lock; a lock we already hold is fine to reuse.
  const acquireEditLock = async (slide: SlideRow): Promise<boolean> => {
    const lock = await lockSlide(slide.id, deck.id);
    if (lock.ok) return true;
    if (lock.kind === "already_locked") {
      const mine =
        !!lock.holder_email &&
        !!currentUserEmail &&
        lock.holder_email === currentUserEmail;
      if (mine) return true;
      const who =
        lock.holder_name || lock.holder_email
          ? displayName({
              name: lock.holder_name,
              email: lock.holder_email ?? "",
            })
          : "another user";
      setFeedback(
        `Can't edit — ${who} is editing this slide (lock expires ${relativeDate(lock.expires_at)}).`,
      );
      return false;
    }
    setFeedback(`Couldn't lock the slide: ${lock.error}`);
    return false;
  };

  // Drop any active proposal compare so the base iframe shows live, editable
  // content (not the Lens wipe overlay) before we hand it to the editor.
  const clearProposalReview = () => {
    setActiveProposalId(null);
    setReveal(0);
  };

  // --- Element-anchored prompt: pick an element in the preview -------------
  // Enters the iframe's pick mode (CANVAS_EDITOR in assemble.ts): elements
  // under the cursor highlight, a click sends the cleaned outerHTML back via
  // canvas:element-picked, and the effect below hands it to the in-app Ask
  // Claude composer as a context chip. Esc (in either frame) cancels.
  const startElementPick = () => {
    if (!selected || editMode !== "none" || pickingPrompt) return;
    setFeedback(null);
    setPickPopover(null);
    clearProposalReview();
    setPickingPrompt(true);
    iframeRef.current?.contentWindow?.postMessage(
      { type: "canvas:pick-start", position: selected.position },
      "*",
    );
  };

  const cancelElementPick = useCallback(() => {
    setPickingPrompt(false);
    iframeRef.current?.contentWindow?.postMessage(
      { type: "canvas:pick-cancel" },
      "*",
    );
  }, []);

  // Pick-mode message channel. Separate from the big nav/state effect so its
  // dependency list stays small. Builds the prompt from the POSTED position
  // (not `selected`) so a race with slide switching can't mislabel the slide.
  useEffect(() => {
    if (!pickingPrompt) return;
    function handlePickMessage(event: MessageEvent) {
      const frame = iframeRef.current;
      if (!frame || event.source !== frame.contentWindow) return;
      const data = event.data;
      if (!data || typeof data.type !== "string") return;
      if (data.type === "canvas:pick-ready" && data.ok === false) {
        setPickingPrompt(false);
        setFeedback(
          "Couldn't enter element-pick mode — refresh the preview and try again.",
        );
        return;
      }
      if (data.type === "canvas:pick-cancelled") {
        setPickingPrompt(false);
        return;
      }
      if (data.type === "canvas:element-picked") {
        setPickingPrompt(false);
        const slide = slides.find((s) => s.position === data.position);
        if (!slide || typeof data.html !== "string") return;
        const descriptor =
          typeof data.descriptor === "string" && data.descriptor
            ? data.descriptor
            : "element";
        // Anchor point for the confirmation popover, computed from the rect
        // the iframe posted (viewport-relative = wrapper-relative, see the
        // pickPopover comment). Null when the rect is missing — a preview
        // frame loaded before this protocol shipped — which falls back to the
        // sidebar feedback line.
        const rect = data.rect;
        let anchor: { x: number; y: number; above: boolean } | null = null;
        const wrap = previewWrapRef.current;
        if (
          wrap &&
          rect &&
          typeof rect.x === "number" &&
          typeof rect.y === "number" &&
          typeof rect.width === "number" &&
          typeof rect.height === "number"
        ) {
          const w = wrap.clientWidth;
          const h = wrap.clientHeight;
          const x = Math.min(Math.max(rect.x + rect.width / 2, 16), w - 16);
          const below = rect.y + rect.height + 10;
          // Flip above the element when there's no room for the popover
          // (~3 lines of text) under it.
          const above = below > h - 72;
          const y = above
            ? Math.min(Math.max(rect.y - 10, 12), h - 12)
            : Math.min(below, h - 12);
          anchor = { x, y, above };
        }
        const showPickResult = (text: string, error: boolean) => {
          if (anchor) setPickPopover({ ...anchor, text, error });
          else setFeedback(text);
        };
        // Hand the picked element to the in-app assistant as a composer chip
        // (the panel expands it into a patch-biased prompt on send — see
        // buildPickedPrompt). The nonce bump focuses the composer and opens the
        // floating shape on mobile; assistantOpen un-collapses the rail dock.
        setAssistantTarget({
          slideId: slide.id,
          slidePosition: slide.position,
          slideTitle: slide.title,
          descriptor,
          html: data.html,
        });
        setAssistantPickNonce((n) => n + 1);
        setAssistantOpen(true);
        showPickResult(
          `Pinpointed ${descriptor} — describe the change in Ask agent.`,
          false,
        );
      }
    }
    window.addEventListener("message", handlePickMessage);
    return () => window.removeEventListener("message", handlePickMessage);
  }, [pickingPrompt, slides, deck.id, deck.title]);

  // The pick popover self-dismisses; it's pointer-events-none so there's no
  // close affordance. Longer than the 3s mobile feedback window because the
  // text is instructional ("paste it into Claude Code…"), not a status blip.
  useEffect(() => {
    if (!pickPopover) return;
    const id = window.setTimeout(() => setPickPopover(null), 7000);
    return () => window.clearTimeout(id);
  }, [pickPopover]);

  // Esc cancels pick mode when the HOST has focus (the iframe handles its own
  // Esc and replies canvas:pick-cancelled).
  useEffect(() => {
    if (!pickingPrompt) return;
    function handleKey(event: KeyboardEvent) {
      if (event.key === "Escape") cancelElementPick();
    }
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [pickingPrompt, cancelElementPick]);

  const enterVisualEdit = () => {
    if (!selected || editMode !== "none") return;
    setFeedback(null);
    setPickPopover(null);
    if (pickingPrompt) cancelElementPick();
    clearProposalReview();
    const slide = selected;
    startTransition(async () => {
      if (!(await acquireEditLock(slide))) return;
      setEditingSlideId(slide.id);
      setEditBaseVersionId(slide.current_version_id ?? null);
      setEditMode("visual");
      iframeRef.current?.contentWindow?.postMessage(
        { type: "canvas:edit-start", position: slide.position },
        "*",
      );
    });
  };

  // Enter the direct-manipulation inspector ("Adjust"). Same contract as
  // visual edit — edit lock first, commits via saveSlideHtmlDirect on Save,
  // discard-by-remount on Cancel — but the in-iframe mode is element
  // selection + style controls instead of contentEditable.
  const enterInspect = () => {
    if (!selected || editMode !== "none") return;
    setFeedback(null);
    setPickPopover(null);
    if (pickingPrompt) cancelElementPick();
    clearProposalReview();
    const slide = selected;
    startTransition(async () => {
      if (!(await acquireEditLock(slide))) return;
      setEditingSlideId(slide.id);
      setEditBaseVersionId(slide.current_version_id ?? null);
      setInspectSel(null);
      setInspectTextEditing(false);
      setEditMode("inspect");
      iframeRef.current?.contentWindow?.postMessage(
        { type: "canvas:inspect-start", position: slide.position },
        "*",
      );
    });
  };

  // Inspect-mode message channel (selection lifecycle). The slide-html save
  // reply is handled by the shared persist effect below, same as visual edit.
  useEffect(() => {
    if (editMode !== "inspect") return;
    function handleInspectMessage(event: MessageEvent) {
      const frame = iframeRef.current;
      if (!frame || event.source !== frame.contentWindow) return;
      const data = event.data;
      if (!data || typeof data.type !== "string") return;
      if (data.type === "canvas:inspect-ready" && data.ok === false) {
        const slideId = editingSlideId;
        setEditMode("none");
        setEditingSlideId(null);
        setInspectSel(null);
        setInspectTextEditing(false);
        setFeedback(
          "Couldn't enter adjust mode — refresh the preview and try again.",
        );
        if (slideId) {
          void releaseSlide(slideId, deck.id);
        }
        return;
      }
      if (data.type === "canvas:element-selected") {
        if (typeof data.descriptor !== "string" || !data.styles) return;
        setInspectSel({
          descriptor: data.descriptor,
          styles: data.styles as InspectSnapshot,
        });
        setInspectSeq((s) => s + 1);
        // A fresh snapshot also arrives when a text edit COMMITS (the box may
        // have resized); the text-state message below is what actually flips the
        // editing flag, so don't reset it here or a commit-then-snapshot race
        // could clear it early.
        return;
      }
      if (data.type === "canvas:inspect-text-state") {
        setInspectTextEditing(data.editing === true);
        return;
      }
      if (data.type === "canvas:inspect-deselected") {
        setInspectSel(null);
        setInspectTextEditing(false);
      }
    }
    window.addEventListener("message", handleInspectMessage);
    return () => window.removeEventListener("message", handleInspectMessage);
  }, [editMode, editingSlideId, deck.id]);

  const enterCodeEdit = () => {
    if (!selected || editMode !== "none") return;
    setFeedback(null);
    setPickPopover(null);
    if (pickingPrompt) cancelElementPick();
    clearProposalReview();
    const slide = selected;
    setCodeLoading(true);
    setEditingSlideId(slide.id);
    setEditMode("code");
    startTransition(async () => {
      if (!(await acquireEditLock(slide))) {
        setEditMode("none");
        setEditingSlideId(null);
        setCodeLoading(false);
        return;
      }
      const res = await getSlideHtml(deck.id, slide.id);
      if (!res.ok) {
        setFeedback(`Couldn't load slide HTML: ${res.error}`);
        setEditMode("none");
        setEditingSlideId(null);
        setCodeLoading(false);
        await releaseSlide(slide.id, deck.id);
        return;
      }
      setCodeDraft(res.html);
      setEditBaseVersionId(res.versionId);
      setCodeLoading(false);
    });
  };

  // Commit a slide's edited HTML from any in-place surface (code / visual /
  // inspect). Routes by who's saving: a direct editor commits immediately via
  // saveSlideHtmlDirect (unchanged behaviour); a member who can't direct-save
  // sends the SAME html through proposeSlideHtmlEdit, which lands a pending
  // slide_edit a reviewer approves. On success the lock is released, the edit
  // mode closes, and the deck refreshes; on failure the mode stays open with an
  // inline message so the work isn't lost. `optionalStyles` carries the
  // inspector's scoped-CSS change when one is present (the visual/code editors
  // pass html only). Returns nothing — it owns the post-save UI transitions so
  // the two callers don't duplicate them.
  const commitSlideHtmlEdit = async (
    target: SlideRow,
    html: string,
    baseVersionId: string | null,
    // True ONLY when the base iframe's DOM already shows `html` (the
    // visual/inspect editors serialize the iframe's own edited DOM back).
    // The code editor saves a <textarea> draft the iframe never received, so
    // it passes false and the signature effect remounts the preview to load
    // the new version — skipping that remount left the preview showing
    // pre-edit content after every code-view save.
    iframeAlreadyCurrent: boolean,
    optionalStyles?: string,
  ): Promise<void> => {
    if (canDirectEditSlide(target)) {
      // One round-trip: the RPC releases the caller's lock in the same
      // transaction (migration 0072), and the action's own revalidatePath
      // already streams the fresh RSC tree back in this response — an explicit
      // router.refresh() here would re-run the ~19-query loader a second time
      // for the same state (speed discovery 2026-07 #5).
      const res = await saveSlideHtmlDirect(
        target.id,
        deck.id,
        html,
        baseVersionId,
        undefined,
        true,
      );
      setEditSaving(false);
      if (!res.ok) {
        setFeedback(res.kind === "stale" ? res.error : `Save failed: ${res.error}`);
        return;
      }
      // When the iframe already renders this exact content in place (the
      // editor committed it and dropped contenteditable on save), record the
      // new version so the signature effect absorbs the revalidated prop echo
      // without remounting — no whole-deck reload for one edited slide.
      if (res.versionId && iframeAlreadyCurrent) {
        selfAppliedVersionsRef.current.add(selfAppliedKey(target.id, res.versionId));
      }
      setEditMode("none");
      setEditingSlideId(null);
      setCodeDraft("");
      setInspectSel(null);
      setInspectTextEditing(false);
      setFeedback("Slide updated.");
      return;
    }

    // Member without direct rights: route the same edit through a proposal.
    const res = await proposeSlideHtmlEdit({
      slideId: target.id,
      deckId: deck.id,
      htmlBody: html,
      slideStyles: optionalStyles,
      baseVersionNo: target.current_version_no,
    });
    setEditSaving(false);
    if (!res.ok) {
      setFeedback(`Couldn't propose change: ${res.error}`);
      return;
    }
    // The propose action revalidates the deck route itself; releaseSlide is
    // fire-and-forget (its realtime DELETE clears the pill everywhere).
    void releaseSlide(target.id, deck.id);
    setEditMode("none");
    setEditingSlideId(null);
    setCodeDraft("");
    setInspectSel(null);
    setInspectTextEditing(false);
    setFeedback("Proposed — waiting for a reviewer to approve it.");
  };

  // Latest-closure ref for the postMessage persist effect. commitSlideHtmlEdit
  // is a fresh function each render (it closes over current state); pinning it
  // in a ref lets the message effect call the current version without listing
  // it as a dependency (which would re-add/remove the window listener every
  // render). Ref write happens in an effect, not during render (React-19 rule).
  const commitSlideHtmlEditRef = useRef(commitSlideHtmlEdit);
  useEffect(() => {
    commitSlideHtmlEditRef.current = commitSlideHtmlEdit;
  });

  // Ask the iframe to serialize the edited slide; it replies with
  // canvas:slide-html, which the message effect below persists.
  const requestSaveVisual = () => {
    if (!editingSlideId || editSaving) return;
    const slide = slides.find((s) => s.id === editingSlideId);
    if (!slide) return;
    setEditSaving(true);
    iframeRef.current?.contentWindow?.postMessage(
      { type: "canvas:edit-save", position: slide.position },
      "*",
    );
  };

  // Inspector save — same serialize-and-reply round-trip as visual edit;
  // the iframe strips the selection markers before serializing.
  const requestSaveInspect = () => {
    if (!editingSlideId || editSaving) return;
    const slide = slides.find((s) => s.id === editingSlideId);
    if (!slide) return;
    setEditSaving(true);
    iframeRef.current?.contentWindow?.postMessage(
      { type: "canvas:inspect-save", position: slide.position },
      "*",
    );
  };

  const saveCodeEdit = () => {
    if (!editingSlideId || editSaving) return;
    const target = slides.find((s) => s.id === editingSlideId);
    if (!target) return;
    setEditSaving(true);
    startTransition(async () => {
      // The draft lives in the textarea, not the iframe — remount on save.
      await commitSlideHtmlEdit(target, codeDraft, editBaseVersionId, false);
    });
  };

  const cancelEdit = () => {
    const slideId = editingSlideId;
    if (editMode === "visual") {
      iframeRef.current?.contentWindow?.postMessage(
        { type: "canvas:edit-cancel" },
        "*",
      );
    } else if (editMode === "inspect") {
      iframeRef.current?.contentWindow?.postMessage(
        { type: "canvas:inspect-cancel" },
        "*",
      );
    }
    setEditMode("none");
    setEditingSlideId(null);
    setInspectSel(null);
    setInspectTextEditing(false);
    setEditSaving(false);
    setCodeDraft("");
    // Remount the base iframe so any in-place contentEditable changes are
    // discarded — we only ever persist on Save.
    setPreviewLoaded(false);
    setPreviewKey((k) => k + 1);
    if (slideId) {
      startTransition(async () => {
        await releaseSlide(slideId, deck.id);
      });
    }
  };

  // --- Left-rail drag-to-reorder ------------------------------------------
  // Move `draggedId` to `insertionIndex` (an index into the position-sorted
  // list, computed before removal), optimistically reflow positions so the rail
  // updates instantly, then persist via reorderSlidesDirect. The RPC re-checks
  // edit rights + the permutation, so a stale list fails loudly; either way we
  // refresh to reconcile with the server (and other clients see it via realtime).
  const handleReorder = (draggedId: string, insertionIndex: number) => {
    const ordered = [...slides].sort((a, b) => a.position - b.position);
    const ids = ordered.map((s) => s.id);
    const from = ids.indexOf(draggedId);
    if (from === -1) return;
    let to = insertionIndex;
    if (from < insertionIndex) to -= 1; // account for removing the dragged row
    if (to === from) return; // dropped back where it started — no-op
    const without = ids.filter((id) => id !== draggedId);
    without.splice(to, 0, draggedId);
    const byId = new Map(ordered.map((s) => [s.id, s]));
    setSlides(without.map((id, i) => ({ ...byId.get(id)!, position: i })));
    setFeedback(null);
    startTransition(async () => {
      try {
        const res = await reorderSlidesDirect(deck.id, without);
        if (!res.ok) setFeedback(res.error);
      } catch (err) {
        // A rejected action (offline / 500) would otherwise leave the optimistic
        // order shown as if it saved. Surface it and let the finally reconcile.
        console.error("[handleReorder]", err);
        setFeedback("Couldn't save the new order — check your connection and try again.");
      } finally {
        // Reconcile to server truth either way: on any failure the render-phase
        // reconcile re-seeds `slides` from the fresh prop, reverting the
        // optimistic reorder; on success it just confirms it.
        router.refresh();
      }
    });
  };

  // --- Draw surface: open (new / edit) + save -----------------------------
  const openDrawNew = () => {
    clearProposalReview();
    setDrawScene(null); // null → the surface starts from a blank scene
    setDrawEditingSlideId(null);
    setDrawBaseVersionId(null);
    setDrawInitialTitle("");
    setDrawOverlay(false);
    setDrawBaseHtml("");
    setDrawBackdropSrc(null);
    setDrawBaseVersionNo(null);
    setMobileSlideListOpen(false);
    setDrawOpen(true);
  };

  // Draw OVER an existing slide: open the surface in overlay mode with the slide
  // rendered behind the canvas. Reuses any existing overlay as the starting
  // scene (so it's re-editable) and a blank transparent one otherwise.
  const openDrawOverlay = (slide: SlideRow) => {
    setFeedback(null);
    setEditMenuOpen(false);
    startTransition(async () => {
      const res = await getSlideHtml(deck.id, slide.id);
      if (!res.ok) {
        setFeedback(`Couldn't load the slide: ${res.error}`);
        return;
      }
      // Reopen the existing overlay if there is one; otherwise start blank. Force
      // a transparent background either way — the slide behind IS the background.
      const existing = parseSceneFromHtml(res.html);
      // Guard the "Edit annotation" case (same as the whole-slide openDrawEdit):
      // if the slide carries an overlay marker but its scene won't decode (its
      // payload was hand-edited/corrupted), starting blank would erase the still-
      // rendered drawing on save. Refuse instead of silently clobbering it.
      if (!existing && hasDrawOverlayHtml(res.html)) {
        setFeedback(
          "This slide's annotation can't be re-opened (its saved data was altered). Left as-is so it isn't overwritten.",
        );
        return;
      }
      const scene: DrawScene = existing
        ? { ...existing, background: "transparent" }
        : emptyScene("transparent");
      clearProposalReview();
      setDrawScene(scene);
      setDrawOverlay(true);
      setDrawEditingSlideId(slide.id);
      setDrawBaseHtml(res.html);
      setDrawBaseVersionId(res.versionId);
      setDrawBaseVersionNo(slide.current_version_no);
      // stripOverlay=1: the backdrop must NOT carry the saved overlay — the
      // editable scene above it paints those same elements, and a stale copy
      // behind the canvas would ghost every move/delete until save.
      setDrawBackdropSrc(
        `/api/decks/${deck.id}/preview?slideId=${slide.id}&stripOverlay=1`,
      );
      setDrawInitialTitle(slide.title ?? "");
      setMobileSlideListOpen(false);
      setDrawOpen(true);
    });
  };

  // Re-open an existing drawn slide. Its html_body isn't on SlideRow, so fetch
  // it and decode the embedded scene; a slide without one isn't a drawing.
  const openDrawEdit = (slide: SlideRow) => {
    setFeedback(null);
    setEditMenuOpen(false);
    startTransition(async () => {
      const res = await getSlideHtml(deck.id, slide.id);
      if (!res.ok) {
        setFeedback(`Couldn't load the drawing: ${res.error}`);
        return;
      }
      const scene = parseSceneFromHtml(res.html);
      if (!scene) {
        setFeedback("This slide isn't an editable drawing.");
        return;
      }
      clearProposalReview();
      setDrawScene(scene);
      setDrawOverlay(false);
      setDrawBaseHtml("");
      setDrawBackdropSrc(null);
      setDrawBaseVersionNo(null);
      setDrawEditingSlideId(slide.id);
      setDrawBaseVersionId(res.versionId);
      setDrawInitialTitle(slide.title ?? "");
      setMobileSlideListOpen(false);
      setDrawOpen(true);
    });
  };

  const handleDrawSave = (scene: DrawScene, titleOut: string) => {
    // Draw-over-slide: inject the overlay into the slide's html_body and route
    // through the inline-edit gate — direct if you can direct-save it, a
    // proposal otherwise. Split out from the drawn-slide paths below because it
    // edits existing content rather than creating/replacing a whole drawing.
    if (drawOverlay && drawEditingSlideId) {
      const target = slides.find((s) => s.id === drawEditingSlideId);
      if (!target) {
        setFeedback("That slide is no longer in the deck.");
        return;
      }
      const nextHtml = injectDrawOverlay(drawBaseHtml, scene);
      setDrawSaving(true);
      setFeedback(null);
      startTransition(async () => {
        try {
          if (canDirectEditSlide(target)) {
            const res = await saveSlideHtmlDirect(
              target.id,
              deck.id,
              nextHtml,
              drawBaseVersionId,
              "Drawing overlay",
            );
            if (!res.ok) {
              setFeedback(
                res.kind === "stale" ? res.error : `Save failed: ${res.error}`,
              );
              return;
            }
            setDrawOpen(false);
            setSelectedId(target.id);
            setFeedback("Annotation saved.");
            router.refresh();
            return;
          }
          const res = await proposeSlideHtmlEdit({
            slideId: target.id,
            deckId: deck.id,
            htmlBody: nextHtml,
            // The OPEN-time version (what the overlay was injected over), not the
            // save-time one — so a concurrent body edit trips the staleness echo
            // check instead of being silently reverted when the proposal lands.
            baseVersionNo: drawBaseVersionNo,
            rationale: "Drawing annotation over the slide",
          });
          if (!res.ok) {
            setFeedback(`Couldn't propose the annotation: ${res.error}`);
            return;
          }
          setDrawOpen(false);
          setSelectedId(target.id);
          setFeedback("Proposed — waiting for a reviewer to approve it.");
          router.refresh();
        } catch (err) {
          console.error("[handleDrawSave:overlay]", err);
          setFeedback(
            "Couldn't save the annotation — check your connection and try again.",
          );
        } finally {
          setDrawSaving(false);
        }
      });
      return;
    }

    const html = sceneToSlideHtml(scene);
    setDrawSaving(true);
    setFeedback(null);
    startTransition(async () => {
      try {
        if (drawEditingSlideId) {
          // Editing an existing drawn slide → versioned direct save (same path
          // as the inline editors), so History + restore keep working.
          const res = await saveSlideHtmlDirect(
            drawEditingSlideId,
            deck.id,
            html,
            drawBaseVersionId,
            "Drawing edit",
          );
          if (!res.ok) {
            setFeedback(
              res.kind === "stale" ? res.error : `Save failed: ${res.error}`,
            );
            return;
          }
          setDrawOpen(false);
          setSelectedId(drawEditingSlideId);
          setFeedback("Drawing updated.");
          router.refresh();
          return;
        }
        // New drawn slide → direct insert at the end of the deck.
        const res = await createSlideDirect(deck.id, {
          position: slides.length,
          title: titleOut,
          html_body: html,
        });
        if (!res.ok) {
          setFeedback(res.error);
          return;
        }
        setDrawOpen(false);
        setSelectedId(res.slideId);
        setFeedback("Slide added.");
        router.refresh();
      } catch (err) {
        // Without this, a rejected save never resets drawSaving, leaving the
        // modal stuck with Save AND Cancel disabled (the drawing trapped).
        console.error("[handleDrawSave]", err);
        setFeedback("Couldn't save the drawing — check your connection and try again.");
      } finally {
        setDrawSaving(false); // always frees the modal
      }
    });
  };

  // --- Inline proposal review: derived state ------------------------------
  // Affordance hints for the chip. RPCs re-enforce permissions on the server,
  // so worst case is a button that returns an error — never a privilege
  // escalation. Approval authority (0039) is canvas_can_edit_deck; the client
  // approximation is "full workspace member on a workspace-visible deck"
  // (guest deck-editors aren't modeled here — the full sheet resolves them via
  // the RPC-backed query, and the RPC is the source of truth either way).
  const permissionsById = useMemo(() => {
    const out: Record<
      string,
      { canApprove: boolean; canReject: boolean; canWithdraw: boolean }
    > = {};
    const isWorkspaceAdmin =
      currentUserRole === "admin" || currentUserRole === "owner";
    const canEditDeck =
      isWorkspaceAdmin ||
      (currentUserRole === "member" && deck.visibility === "workspace");
    for (const p of pendingProposals) {
      out[p.id] = computeProposalPermissions({
        isPending: true,
        isProposer: p.proposed_by === currentUserId,
        isWorkspaceAdmin,
        canEditDeck,
        allowSelfApproval,
      });
    }
    return out;
  }, [
    pendingProposals,
    currentUserId,
    currentUserRole,
    deck.visibility,
    allowSelfApproval,
  ]);

  // Staleness hints for the chip's warning. A slide_edit/slide_html/
  // slide_styles/slide_title proposal is stale when the slide moved on since it was proposed
  // — i.e. the slide's current version no longer matches the version the
  // proposal was based on. Approving a stale proposal stacks on top of current
  // state (canvas_apply_edit never blocks), silently discarding the newer
  // content, so this is the warning to surface before Approve. theme/nav/
  // deck_title staleness needs server-side hashing and is surfaced by the full
  // proposal sheet instead.
  const stalenessById = useMemo(() => {
    const out: Record<string, { stale: boolean; message: string }> = {};
    for (const p of pendingProposals) {
      if (!p.slide_id) continue;
      if (
        p.kind !== "slide_edit" &&
        p.kind !== "slide_html" &&
        p.kind !== "slide_styles" &&
        p.kind !== "slide_title"
      )
        continue;
      if (p.base_version_id == null) continue;
      const slide = slides.find((s) => s.id === p.slide_id);
      if (!slide || slide.current_version_id == null) continue;
      if (slide.current_version_id !== p.base_version_id) {
        out[p.id] = {
          stale: true,
          message:
            "This slide changed since this proposal was made — approving overwrites the newer version.",
        };
      }
    }
    return out;
  }, [pendingProposals, slides]);

  // Candidates for a one-click "approve all from Claude" batch. The
  // eligibility rule (claude-authored, non-stale, target has exactly one
  // pending) is shared with the inbox via lib/canvas/batch-approve so both
  // bulk buttons carry the same safety semantics; the editor adds its local
  // canApprove permission hint on top.
  const claudeBatch = useMemo(() => {
    const currentVersionBySlide = new Map(
      slides.map((s) => [s.id, s.current_version_id]),
    );
    return eligibleForBatch(
      pendingProposals,
      currentVersionBySlide,
      (p) => permissionsById[p.id]?.canApprove ?? false,
    );
  }, [pendingProposals, slides, permissionsById]);

  const handleApproveClaudeBatch = () => {
    if (isPending || claudeBatch.length === 0) return;
    setFeedback(null);
    const batch = claudeBatch;
    startTransition(async () => {
      let approved = 0;
      let failed = 0;
      // Sequential so each apply sees the prior's committed state. Targets are
      // distinct (see claudeBatch), so order doesn't affect correctness.
      for (const p of batch) {
        const result = await approveProposal(p.id, deck.id);
        if (result.ok) approved += 1;
        else failed += 1;
      }
      setActiveProposalId(null);
      setFeedback(
        failed === 0
          ? `Approved ${approved} proposal${approved === 1 ? "" : "s"} from agents.`
          : `Approved ${approved}; ${failed} failed — review the rest in the inbox.`,
      );
      router.refresh();
    });
  };

  // ---- Human multi-select approve ---------------------------------------
  // A human-driven bulk approve to complement the auto "Approve N from Claude":
  // the reviewer ticks the chips they want and approves them in one action.
  // Owned here (not in the chip) so the selection survives the chip remounting
  // as its variant flips, and so the bulk handler can reuse approveProposal the
  // same way handleApproveClaudeBatch does. Keyed by edit id.
  const [selectedProposalIds, setSelectedProposalIds] = useState<Set<string>>(
    new Set(),
  );
  // The last proposal toggled ON, for shift-range selection. Cleared when its
  // proposal leaves the queue.
  const [lastToggledId, setLastToggledId] = useState<string | null>(null);

  // Reconcile the selection against the live pending universe (render-phase
  // adjust, same pattern the chip uses for `dismissed`): once a proposal is
  // resolved and drops out of pendingProposals, its id has no selection meaning
  // left. Without this the set would pin stale ids across a long review session.
  const pendingIdSet = useMemo(
    () => new Set(pendingProposals.map((p) => p.id)),
    [pendingProposals],
  );
  if ([...selectedProposalIds].some((id) => !pendingIdSet.has(id))) {
    setSelectedProposalIds(
      new Set([...selectedProposalIds].filter((id) => pendingIdSet.has(id))),
    );
  }
  if (lastToggledId != null && !pendingIdSet.has(lastToggledId)) {
    setLastToggledId(null);
  }

  // Toggle a proposal's checkbox. A plain click flips just that id; a
  // shift-click selects the contiguous RANGE from the last toggled-on id to
  // this one, in the order the chip queue presents them (pendingProposals).
  // Mirrors the inbox/file-list shift-range idiom. `order` is the queue the
  // chip is currently showing so the range matches what the reviewer sees.
  const toggleProposalSelect = useCallback(
    (id: string, shiftKey: boolean, order: string[]) => {
      setSelectedProposalIds((cur) => {
        const next = new Set(cur);
        if (shiftKey && lastToggledId && lastToggledId !== id) {
          const from = order.indexOf(lastToggledId);
          const to = order.indexOf(id);
          if (from !== -1 && to !== -1) {
            const [lo, hi] = from < to ? [from, to] : [to, from];
            for (let i = lo; i <= hi; i += 1) next.add(order[i]);
            return next;
          }
        }
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
      // Anchor the next shift-range on the most recent single toggle.
      setLastToggledId(id);
    },
    [lastToggledId],
  );

  // The selected proposals the current user may actually approve. The bulk
  // button counts + acts on these only — selecting a proposal you can't approve
  // (someone else's, in a no-self-approval workspace) never offers to approve it.
  const selectedApprovable = useMemo(
    () =>
      pendingProposals.filter(
        (p) =>
          selectedProposalIds.has(p.id) &&
          (permissionsById[p.id]?.canApprove ?? false),
      ),
    [pendingProposals, selectedProposalIds, permissionsById],
  );

  const handleApproveSelected = () => {
    if (isPending || selectedApprovable.length === 0) return;
    setFeedback(null);
    const batch = selectedApprovable;
    startTransition(async () => {
      let approved = 0;
      let failed = 0;
      // Sequential, like the Claude batch: each apply sees the prior's
      // committed state, and concurrent canvas_apply_edit on the same slide
      // would race the optimistic-version guard. approveProposal re-checks
      // authority + staleness server-side, so a now-ineligible row just fails.
      for (const p of batch) {
        const result = await approveProposal(p.id, deck.id);
        if (result.ok) approved += 1;
        else failed += 1;
      }
      setSelectedProposalIds(new Set());
      setLastToggledId(null);
      setActiveProposalId(null);
      setFeedback(
        failed === 0
          ? `Approved ${approved} selected proposal${approved === 1 ? "" : "s"}.`
          : `Approved ${approved}; ${failed} failed — review the rest individually.`,
      );
      router.refresh();
    });
  };

  const activeProposal = useMemo(
    () => pendingProposals.find((p) => p.id === activeProposalId) ?? null,
    [pendingProposals, activeProposalId],
  );
  // "Deck-scope" = not anchored to an existing slide: theme_css / nav_js /
  // deck_title / slide_reorder / slide_create. They review in the deck
  // banner chip — without this, clicking "Review N pending" on (say) a
  // slide_create activated a proposal NO chip rendered: a dead click.
  const isDeckProposalActive =
    activeProposal != null && activeProposal.slide_id == null;

  const proposalsForSlide = useMemo(
    () =>
      selected
        ? pendingProposals.filter((p) => p.slide_id === selected.id)
        : [],
    [pendingProposals, selected],
  );
  const deckScopeProposals = useMemo(
    () => pendingProposals.filter((p) => p.slide_id == null),
    [pendingProposals],
  );
  // Variant selection: when a deck-scope proposal is active, the deck banner
  // wins. Otherwise prefer the slide-scoped floating chip if the current
  // slide has pendings; fall back to the deck banner so deck-scope proposals
  // still surface on slides that have nothing slide-specific to review.
  // Kinds the Lens can't render (slide_reorder / deck_title) still get the full
  // chip — rationale, Approve/Reject, and Diff (D) for the change detail; only
  // the visual wipe overlay is absent (LENS_KINDS). slide_create now renders in
  // the Lens (new slide vs the slide currently at its position).
  const chipVariant: "deck" | "slide" = isDeckProposalActive
    ? "deck"
    : proposalsForSlide.length > 0
      ? "slide"
      : "deck";
  const chipProposals =
    chipVariant === "deck" ? deckScopeProposals : proposalsForSlide;
  // Whether each chip is mounted — also gates the standalone decision-strip
  // card (rendered only when NO chip is up to host the strip in its slot).
  const deckChipVisible = chipVariant === "deck" && chipProposals.length > 0;
  const slideChipVisible = chipVariant === "slide" && chipProposals.length > 0;

  // ---- Lens: dual warm iframes (current base + proposed overlay) -------
  // The base frame (iframeRef) ALWAYS renders the CURRENT deck — a stable src,
  // so it never reloads when a proposal toggles. When a proposal of an
  // assemblable kind is active, the PROPOSED deck renders in a second warm
  // overlay frame (proposedIframeRef); we wipe between them with CSS, never
  // swapping a src, so before↔after has zero reload flash. slide_create
  // assembles too (the new slide vs the slide currently at its position).
  // Kinds the preview route can't assemble yet (slide_reorder / slide_delete)
  // get NO overlay — review those via the source modal (D) until the route
  // learns to render them.
  const lensActive =
    activeProposal != null && LENS_KINDS.has(activeProposal.kind);
  const baseSrc = `/api/decks/${deck.id}/preview`;
  const proposedSrc = lensActive
    ? `/api/decks/${deck.id}/preview?proposalId=${activeProposalId}`
    : null;

  // `comparing` = the wipe has been pulled past the midpoint, so CURRENT is
  // mostly showing. It drives the chip's Compare button pressed state. The
  // toggle is the discoverable counterpart to the seam drag + Alt-hold: click
  // wipes fully to current (reveal 1), click again snaps back to proposed
  // (reveal 0). setReveal is stable, so the callback never needs to re-create.
  const comparing = reveal > 0.5;
  const toggleCompare = useCallback(
    () => setReveal((r) => (r > 0.5 ? 0 : 1)),
    [],
  );

  // The chip's "Diff" / D shortcut opens the source modal — the rare, deliberate
  // "show me the actual markup" case. The default review act is the visual wipe,
  // which is always present, so this is no longer the primary path.
  const openSource = useCallback((id: string) => setFullSheetId(id), []);

  // Compare a proposal from the assistant panel's inline card: reveal the slide,
  // then drive the SAME Lens the chip uses. First click activates the proposal
  // (preview swaps to the proposed version); repeat clicks toggle current↔proposed
  // ("go back and forth"). Kinds the Lens can't render fall back to the diff sheet.
  const compareProposal = useCallback(
    (editId: string, slideId: string | null) => {
      if (slideId) setSelectedId(slideId);
      const p = pendingProposals.find((x) => x.id === editId);
      if (p && LENS_KINDS.has(p.kind)) {
        if (activeProposalId === editId) {
          toggleCompare();
        } else {
          setActiveProposalId(editId);
          setReveal(0); // start on the proposed side
        }
      } else {
        setFullSheetId(editId);
      }
    },
    [pendingProposals, activeProposalId, toggleCompare],
  );

  // "Review N pending" (right rail) and the toolbar Review pill both jump
  // into the chip: activate the first proposal in review order — the same
  // path J takes from a no-selection state. No-op while a proposal is
  // already active.
  const activateReview = useCallback(() => {
    setActivityOpen(true);
    if (activeProposalId != null) return;
    const first = pendingProposals[0];
    if (!first) return;
    if (first.slide_id && first.slide_id !== selectedId) {
      setSelectedId(first.slide_id);
    }
    setActiveProposalId(first.id);
  }, [activeProposalId, pendingProposals, selectedId]);

  // Post-decision strip ("Approved · Undo (U)"). Owned HERE, not by the
  // chip: approving a slide's last pending unmounts that chip when
  // router.refresh drops the row (queue empties / variant flips), and a
  // chip-local strip died with it before Undo could be used. The chips
  // render the strip in their top slot while mounted; a standalone floating
  // card (below, in the preview frame) takes over when neither chip is up.
  const [decisionStrip, setDecisionStrip] = useState<DecisionStrip | null>(
    null,
  );
  const decisionStripRef = useRef<DecisionStrip | null>(null);
  useEffect(() => {
    decisionStripRef.current = decisionStrip;
  }, [decisionStrip]);
  const stripTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return () => {
      if (stripTimerRef.current) clearTimeout(stripTimerRef.current);
    };
  }, []);

  // Freshest snapshots for handleDecided (a stable []-dep callback): the pending
  // proposals it looks the just-approved row up in, and the fast-lane offer
  // context. Ref writes happen in an effect (React-19 forbids writing in render).
  const pendingProposalsRef = useRef(pendingProposals);
  const fastLaneCtxRef = useRef({
    deckFastLaneEnabled: deck.agent_fast_lane_enabled,
    canManageFastLane,
    workspaceSelfApproval: allowSelfApproval,
  });
  useEffect(() => {
    pendingProposalsRef.current = pendingProposals;
    fastLaneCtxRef.current = {
      deckFastLaneEnabled: deck.agent_fast_lane_enabled,
      canManageFastLane,
      workspaceSelfApproval: allowSelfApproval,
    };
  }, [pendingProposals, deck.agent_fast_lane_enabled, canManageFastLane, allowSelfApproval]);

  // Inline fast-lane offer (speed #1): after the Nth hand-approval of a
  // render-verified agent patch on a deck the owner could opt in, offer the
  // one-click enable where the pain is — not the buried ⋯ toggle. Count +
  // "already offered" flag are per-deck localStorage so they survive reloads
  // and never re-nag once actioned/dismissed.
  const [showFastLaneOffer, setShowFastLaneOffer] = useState(false);
  const fastLaneCountKey = `canvas:flcount:${deck.id}`;
  const fastLaneOfferedKey = `canvas:floffered:${deck.id}`;

  const handleDecided = useCallback(
    (decision: ProposalDecision) => {
      if (stripTimerRef.current) clearTimeout(stripTimerRef.current);
      setDecisionStrip({ ...decision, undoing: false, undoError: null });
      stripTimerRef.current = setTimeout(() => {
        stripTimerRef.current = null;
        setDecisionStrip(null);
      }, DECISION_STRIP_MS);

      // Tally qualifying approvals toward the fast-lane offer.
      if (decision.type !== "approve") return;
      if (typeof window === "undefined") return;
      try {
        if (window.localStorage.getItem(fastLaneOfferedKey)) return;
        const proposal = pendingProposalsRef.current.find(
          (p) => p.id === decision.editId,
        );
        if (
          !proposal ||
          !approvalCountsTowardFastLaneOffer(proposal, fastLaneCtxRef.current)
        ) {
          return;
        }
        const next = Number(window.localStorage.getItem(fastLaneCountKey) ?? "0") + 1;
        window.localStorage.setItem(fastLaneCountKey, String(next));
        if (next >= FAST_LANE_OFFER_THRESHOLD) setShowFastLaneOffer(true);
      } catch {
        // localStorage blocked (private mode / quota) — the offer is a nicety,
        // never let it break the approve flow.
      }
    },
    [fastLaneCountKey, fastLaneOfferedKey],
  );

  const dismissFastLaneOffer = useCallback(() => {
    setShowFastLaneOffer(false);
    try {
      window.localStorage.setItem(fastLaneOfferedKey, "1");
    } catch {
      /* ignore */
    }
  }, [fastLaneOfferedKey]);

  const acceptFastLaneOffer = useCallback(() => {
    dismissFastLaneOffer();
    setFeedback(null);
    startTransition(async () => {
      const result = await setDeckAgentFastLane(deck.id, true);
      setFeedback(
        result.ok
          ? "Trusted agent patches can now apply after render verification."
          : "Couldn't enable the trusted agent fast lane.",
      );
      if (result.ok) router.refresh();
    });
  }, [deck.id, dismissFastLaneOffer, router]);

  // Undo (strip button or U while it shows): revert the just-applied edit
  // via revertProposal. The anti-clobber guard in the action means a slide
  // that moved on since the approve fails here — the strip swaps to the
  // error with a History link rather than force-reverting.
  const undoDecision = useCallback(() => {
    const s = decisionStripRef.current;
    if (!s || !s.canUndo || s.undoing) return;
    if (stripTimerRef.current) {
      clearTimeout(stripTimerRef.current);
      stripTimerRef.current = null;
    }
    setDecisionStrip({ ...s, undoing: true });
    startTransition(async () => {
      let result: Awaited<ReturnType<typeof revertProposal>>;
      try {
        result = await revertProposal(s.editId, deck.id);
      } catch {
        result = {
          ok: false,
          error: "could not reach the server — try again",
        };
      }
      if (!result.ok) {
        // "needs_reviewer" (the apply RPC's self-approval guard) gets its
        // own copy — "Can't undo — you can't approve your own proposal"
        // would read as nonsense. Everything else keeps the generic prefix.
        const message =
          "code" in result && result.code === "needs_reviewer"
            ? "Undo needs a reviewer in this workspace."
            : `Can't undo — ${result.error}`;
        setDecisionStrip({
          ...s,
          undoing: false,
          canUndo: false,
          undoError: message,
        });
        return;
      }
      setDecisionStrip(null);
      router.refresh();
    });
  }, [deck.id, router]);

  // U undoes the last approve while its strip is up. Lives here (not in the
  // chip's capture handler) for the same reason the strip does — it must
  // keep working after the chip unmounts. Guards mirror the chip's: skip
  // while typing or while any modal owns the keyboard.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.altKey || e.metaKey || e.ctrlKey) return;
      if (e.key.toLowerCase() !== "u") return;
      const el = e.target as HTMLElement | null;
      const tag = el?.tagName;
      if (
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        tag === "SELECT" ||
        el?.isContentEditable
      ) {
        return;
      }
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      const s = decisionStripRef.current;
      if (!s || !s.canUndo || s.undoing) return;
      e.preventDefault();
      undoDecision();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undoDecision]);

  // Review mode: any pending proposal puts the deck "in review" — the toolbar
  // grows the copper Review pill and Edit ▾ / Comment collapse to icons.
  // Nothing else dims, moves, or disappears; the chip renders as always.
  const reviewMode = deckPendingCount > 0;

  // Drag the wipe seam across the preview to scrub between current and proposed.
  // Measures against the preview frame rect (captured at pointer-down; the frame
  // doesn't move mid-drag) and disables the clip transition while dragging so
  // the wipe tracks the pointer 1:1.
  const onSeamPointerDown = useCallback(
    (e: React.PointerEvent) => {
      const frame = previewWrapRef.current;
      if (!frame) return;
      e.preventDefault();
      const rect = frame.getBoundingClientRect();
      const toReveal = (clientX: number) =>
        Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
      setWipeDragging(true);
      setReveal(toReveal(e.clientX));
      const onMove = (ev: PointerEvent) => setReveal(toReveal(ev.clientX));
      const onUp = () => {
        setWipeDragging(false);
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [],
  );

  // Comments scoped to the active slide. Roots = top-level pinned threads;
  // we count by including their replies for the badge in the right rail.
  const commentsForSlide = useMemo(
    () => comments.filter((c) => c.slide_id === selected?.id),
    [comments, selected?.id],
  );
  // Deck-level threads (not tied to any slide) — agents can open these via the
  // MCP add_comment tool with no slide_id, and they were rendered nowhere.
  // Surfaced in a deck-wide "Deck notes" rail section regardless of selection.
  const deckLevelComments = useMemo(
    () => comments.filter((c) => c.slide_id == null),
    [comments],
  );
  const rootsForSlide = useMemo(
    () =>
      commentsForSlide.filter(
        (c) => c.parent_id == null && c.anchor_x != null && c.anchor_y != null,
      ),
    [commentsForSlide],
  );
  const repliesByRoot = useMemo(() => {
    const map = new Map<string, CommentRow[]>();
    for (const c of commentsForSlide) {
      if (!c.parent_id) continue;
      const arr = map.get(c.parent_id);
      if (arr) arr.push(c);
      else map.set(c.parent_id, [c]);
    }
    return map;
  }, [commentsForSlide]);
  const visibleRoots = useMemo(
    () =>
      showResolved
        ? rootsForSlide
        : rootsForSlide.filter((r) => !r.resolved),
    [rootsForSlide, showResolved],
  );
  const unresolvedCount = rootsForSlide.filter((r) => !r.resolved).length;

  // Unpinned roots per scope, respecting the resolved filter — drive the
  // merged Comments section's group sub-labels (only rendered when the group
  // is non-empty) and its single empty state.
  const visibleSlideNoteCount = useMemo(
    () =>
      commentsForSlide.filter(
        (c) =>
          c.parent_id == null &&
          c.anchor_x == null &&
          c.anchor_y == null &&
          (showResolved || !c.resolved),
      ).length,
    [commentsForSlide, showResolved],
  );
  const visibleDeckNoteCount = useMemo(
    () =>
      deckLevelComments.filter(
        (c) => c.parent_id == null && (showResolved || !c.resolved),
      ).length,
    [deckLevelComments, showResolved],
  );
  // Header counts for the merged Comments section span every group it shows
  // (pinned + slide notes + deck notes), unfiltered by the resolved toggle.
  const allCommentRoots = useMemo(
    () => [
      ...rootsForSlide,
      ...commentsForSlide.filter(
        (c) => c.parent_id == null && c.anchor_x == null && c.anchor_y == null,
      ),
      ...deckLevelComments.filter((c) => c.parent_id == null),
    ],
    [rootsForSlide, commentsForSlide, deckLevelComments],
  );
  const commentRootsTotal = allCommentRoots.length;
  const commentRootsOpen = allCommentRoots.filter((r) => !r.resolved).length;
  // Nothing visible in the merged Comments section (every group empty under the
  // current resolved filter). When that holds AND the user isn't actively
  // commenting, the rail collapses Comments to a slim header row — matching an
  // empty Review and handing the spare height to the Ask agent dock. While
  // commenting we keep the body so the "drop a pin" hint stays as live feedback.
  const commentsEmpty =
    visibleRoots.length === 0 &&
    visibleSlideNoteCount === 0 &&
    visibleDeckNoteCount === 0;
  const commentsCollapsed = commentsEmpty && !commentMode;

  // Drop any open thread when the user switches slides — its pin lives on
  // the previous slide, so leaving the popover open would be confusing.
  // Done during render (React's "adjusting state on prop change" pattern)
  // so the popover never paints against the new slide before clearing.
  // Also drop an active slide-scoped proposal — its preview swap belongs to
  // the slide we just left. Theme/nav proposals (slide_id null) stay active
  // since they're deck-global.
  const [lastSlideId, setLastSlideId] = useState<string | null>(selected?.id ?? null);
  if (lastSlideId !== (selected?.id ?? null)) {
    setLastSlideId(selected?.id ?? null);
    setActiveThreadId(null);
    setCommentMode(false);
    if (
      activeProposal &&
      activeProposal.slide_id !== null &&
      activeProposal.slide_id !== (selected?.id ?? null)
    ) {
      setActiveProposalId(null);
      // The reveal/proposed-overlay reset is handled by the activeProposalId
      // effect; clearing the active proposal here is enough.
    }
    // Switched slides mid-pick: the pick is anchored to the previous slide's
    // <section>, so drop it (same render-phase pattern). We can't postMessage
    // during render; the iframe cancels its own pick mode on the
    // canvas:navigate the slide switch sends it (see CANVAS_EDITOR).
    if (pickingPrompt) {
      setPickingPrompt(false);
    }
    // A pick confirmation is anchored to coordinates on the PREVIOUS slide —
    // meaningless over the new one, so drop it rather than let it time out.
    if (pickPopover) {
      setPickPopover(null);
    }
    // Switched slides mid-edit: abandon the in-place edit (render-phase state
    // adjustment, same pattern as the resets above). The previewKey bump
    // remounts the base frame, dropping the orphaned contentEditable section;
    // the edited slide's soft lock simply lapses on its 15-min TTL.
    if (editMode !== "none") {
      setEditMode("none");
      setEditingSlideId(null);
      setInspectSel(null);
      setEditSaving(false);
      setCodeDraft("");
      setPreviewLoaded(false);
      setPreviewKey((k) => k + 1);
    }
  }

  // Toolbar "Refresh" — re-mounts the iframe (its `key` advances, forcing a
  // reload of /api/decks/{id}/preview so CSS or asset URL changes take
  // effect) AND also triggers a server refresh, so comments / locks / version
  // metadata pull fresh data. Realtime usually beats users to this, but the
  // button stays useful as a manual escape hatch when a subscription drops.
  const refreshPreview = () => {
    setPreviewLoaded(false);
    setPreviewKey((k) => k + 1);
    router.refresh();
  };

  // Auto-remount the iframe when the slide list materially changes — slide
  // added, removed, reordered, or its content_version bumped (i.e. an edit
  // was approved). `router.refresh()` (fired by the realtime hook) gives us
  // fresh `slides` props but doesn't reload the iframe; without this effect
  // the sidebar updates while the preview stays stale until the user clicks
  // Refresh manually. Excludes lock state (`slide.lock`) from the signature —
  // claiming/releasing doesn't change rendered HTML, so we don't want to
  // flash the iframe on every Claim click.
  const slideSignature = slides
    .map((s) => `${s.id}:${s.position}:${s.current_version_id ?? "0"}`)
    .join("|");
  const lastSlideSignatureRef = useRef(slideSignature);
  useEffect(() => {
    if (lastSlideSignatureRef.current === slideSignature) return;
    // Don't yank the base iframe out from under an in-progress inline edit — a
    // remount would discard the contentEditable changes. Defer (leave the ref
    // stale) so a later change still remounts once editing ends; the explicit
    // remount in cancelEdit / the render-phase abandon path covers the rest.
    if (editingRef.current) return;
    // A change that is PURELY this tab's own inline-save version bumps needs no
    // remount: the iframe already shows that content in place. Anything
    // structural (add/remove/reorder) or a version bump we didn't author still
    // reloads. See lib/canvas/preview-remount.ts.
    const decision = decideRemount(
      lastSlideSignatureRef.current,
      slideSignature,
      selfAppliedVersionsRef.current,
    );
    lastSlideSignatureRef.current = slideSignature;
    if (!decision.remount) {
      for (const key of decision.consumed) {
        selfAppliedVersionsRef.current.delete(key);
      }
      return;
    }
    setPreviewLoaded(false);
    setPreviewKey((k) => k + 1);
  }, [slideSignature]);

  // Persist a visual / inspector inline edit. The base iframe replies to
  // canvas:edit-save (or canvas:inspect-save) with canvas:slide-html carrying
  // the cleaned <section> HTML; we commit it through commitSlideHtmlEdit, which
  // either direct-saves (versions the slide) or routes a member's change to a
  // proposal — then releases the lock and refreshes. Scoped to the base frame
  // by event.source so the Lens overlay frame can't be mistaken for it.
  // commitSlideHtmlEdit is read via the latest-closure ref so this effect
  // doesn't re-bind on every render (it isn't memoized).
  useEffect(() => {
    function onMessage(event: MessageEvent) {
      const frame = iframeRef.current;
      if (!frame || event.source !== frame.contentWindow) return;
      const data = event.data;
      if (!data || data.type !== "canvas:slide-html") return;
      const html = typeof data.html === "string" ? data.html : null;
      const target =
        slides.find((s) => s.id === editingSlideId) ??
        slides.find((s) => s.position === data.position) ??
        null;
      if (!html || !target) {
        setEditSaving(false);
        setFeedback("Couldn't read the edited slide — try again.");
        return;
      }
      void commitSlideHtmlEditRef.current(
        target,
        html,
        editBaseVersionId ?? target.current_version_id ?? null,
        // The iframe serialized its own edited DOM — it already shows this.
        true,
      );
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [slides, editingSlideId, editBaseVersionId]);


  // Page-level keyboard nav between slides. ArrowLeft / ArrowRight move
  // selection by ±1 within the slide list. Mounted on `window` (not the
  // iframe) so the host always owns the gesture even when iframe focus is
  // elsewhere. We skip the shortcut when:
  //   - focus is in an editable surface (input / textarea / contenteditable)
  //     so users typing in the comment composer or rename dialog don't
  //     accidentally page through the deck
  //   - a modal-ish surface is open: snapshot dialog, rename dialog, delete
  //     confirm, the full proposal sheet, or the slide-comments thread
  //     popover. Each of these owns its own keyboard contract.
  //   - the share/deck overflow popovers are open (they handle Esc + the
  //     deck menu doesn't have an arrow-key contract today)
  // When focus is on the host, this listener fires directly. When focus is
  // inside the iframe, the deck's own keydown handler is silenced by
  // EMBEDDED_GUARD (see assemble.ts), and CANVAS_CONTROLLER forwards the
  // key up via `canvas:key` — the message handler effect replicates the
  // same advance/regress logic so both focus contexts behave identically.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      const target = e.target as HTMLElement | null;
      if (target) {
        const tag = target.tagName;
        if (
          tag === "INPUT" ||
          tag === "TEXTAREA" ||
          tag === "SELECT" ||
          target.isContentEditable
        ) {
          return;
        }
      }
      if (
        snapshotOpen ||
        renameOpen ||
        deleteConfirmOpen ||
        fullSheetId != null ||
        activeThreadId != null ||
        commentMode ||
        deckMenuOpen ||
        shareMenuOpen ||
        editMenuOpen ||
        exportMenuOpen ||
        shareDialogOpen ||
        shortcutsOpen ||
        // Edit surfaces own arrows: the inspector nudges its selection with
        // them, and paging slides would abandon an in-progress edit anyway.
        editMode !== "none"
      ) {
        return;
      }
      if (e.altKey || e.metaKey || e.ctrlKey) return;
      if (slides.length < 2) return;
      const currentIdx = slides.findIndex((s) => s.id === selectedId);
      if (currentIdx < 0) return;
      const delta = e.key === "ArrowLeft" ? -1 : 1;
      const nextIdx = Math.max(0, Math.min(slides.length - 1, currentIdx + delta));
      if (nextIdx === currentIdx) return;
      e.preventDefault();
      setSelectedId(slides[nextIdx].id);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    slides,
    selectedId,
    snapshotOpen,
    renameOpen,
    deleteConfirmOpen,
    fullSheetId,
    activeThreadId,
    commentMode,
    deckMenuOpen,
    shareMenuOpen,
    editMenuOpen,
    exportMenuOpen,
    shareDialogOpen,
    shortcutsOpen,
    editMode,
  ]);

  // Single-key shortcuts: "P" enters Present mode, "?" opens the shortcuts
  // reference. Same guards as the arrow-nav handler — ignored while typing in
  // an editable surface or while any modal/popover owns the keyboard — so they
  // never fire mid-edit. Modifier combos are skipped so browser/OS shortcuts
  // pass through untouched.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.altKey || e.metaKey || e.ctrlKey) return;
      const target = e.target as HTMLElement | null;
      if (target) {
        const tag = target.tagName;
        if (
          tag === "INPUT" ||
          tag === "TEXTAREA" ||
          tag === "SELECT" ||
          target.isContentEditable
        ) {
          return;
        }
      }
      if (
        snapshotOpen ||
        renameOpen ||
        deleteConfirmOpen ||
        shareDialogOpen ||
        shortcutsOpen ||
        fullSheetId != null ||
        activeThreadId != null ||
        commentMode ||
        deckMenuOpen ||
        shareMenuOpen ||
        editMenuOpen ||
        exportMenuOpen ||
        mobileRailOpen ||
        mobileSlideListOpen ||
        // Inspect mode has no editable focus to shield it, so "p" would
        // otherwise yank the user to Present mode mid-edit.
        editMode !== "none"
      ) {
        return;
      }
      if (e.key === "?") {
        e.preventDefault();
        setShortcutsOpen(true);
      } else if (e.key === "p" || e.key === "P") {
        e.preventDefault();
        router.push(`/canvases/${deck.id}/present`);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    snapshotOpen,
    renameOpen,
    deleteConfirmOpen,
    shareDialogOpen,
    shortcutsOpen,
    fullSheetId,
    activeThreadId,
    commentMode,
    deckMenuOpen,
    shareMenuOpen,
    editMenuOpen,
    exportMenuOpen,
    mobileRailOpen,
    mobileSlideListOpen,
    editMode,
    router,
    deck.id,
  ]);

  // Proposal-review shortcuts. When the inline chip is showing pending
  // proposals, J/] steps to the next and K/[ to the previous; A approves the
  // active one (if the caller can approve). Same guard set as the other key
  // handlers — ignored while typing or while a modal/popover owns the keyboard,
  // and modifier combos pass through. Reject stays mouse-driven: it needs a
  // typed reason in the chip's composer.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.altKey || e.metaKey || e.ctrlKey) return;
      const target = e.target as HTMLElement | null;
      if (target) {
        const tag = target.tagName;
        if (
          tag === "INPUT" ||
          tag === "TEXTAREA" ||
          tag === "SELECT" ||
          target.isContentEditable
        ) {
          return;
        }
      }
      if (
        snapshotOpen ||
        renameOpen ||
        deleteConfirmOpen ||
        shareDialogOpen ||
        shortcutsOpen ||
        fullSheetId != null ||
        activeThreadId != null ||
        commentMode ||
        deckMenuOpen ||
        shareMenuOpen ||
        editMenuOpen ||
        exportMenuOpen ||
        mobileRailOpen ||
        mobileSlideListOpen
      ) {
        return;
      }
      if (chipProposals.length === 0) return;
      const key = e.key.toLowerCase();
      if (key !== "j" && key !== "k" && key !== "a" && key !== "[" && key !== "]")
        return;
      // Raw index: -1 when nothing (or a foreign id) is active. Using the raw
      // value (not Math.max(0, …)) lets J land on the FIRST proposal from a
      // no-selection state instead of skipping it — matching K and the chip's
      // own visual fallback.
      const idx = chipProposals.findIndex((p) => p.id === activeProposalId);
      const goTo = (target: (typeof chipProposals)[number] | undefined) => {
        if (!target) return;
        if (target.slide_id && target.slide_id !== selectedId)
          setSelectedId(target.slide_id);
        setActiveProposalId(target.id);
      };
      if (key === "j" || key === "]") {
        e.preventDefault();
        goTo(
          chipProposals[idx < 0 ? 0 : Math.min(chipProposals.length - 1, idx + 1)],
        );
      } else if (key === "k" || key === "[") {
        e.preventDefault();
        goTo(chipProposals[idx <= 0 ? 0 : idx - 1]);
      } else if (key === "a") {
        // Block while any action is mid-flight so a double-press can't fire
        // approveProposal twice on the same id before router.refresh lands.
        if (isPending) return;
        const activeIdx = idx < 0 ? 0 : idx;
        const activeId = chipProposals[activeIdx]?.id ?? null;
        if (!activeId) return;
        if (!permissionsById[activeId]?.canApprove) {
          setFeedback("You don't have permission to approve this proposal.");
          return;
        }
        e.preventDefault();
        setFeedback(null);
        // Advance to the next (or previous) pending proposal rather than null:
        // the chip's optimistic-hide is internal to it, so clearing to null
        // would let its auto-activate effect briefly re-select the
        // just-approved row until router.refresh lands.
        const advanceId =
          chipProposals[activeIdx + 1]?.id ??
          chipProposals[activeIdx - 1]?.id ??
          null;
        startTransition(async () => {
          const result = await approveProposal(activeId, deck.id);
          if (!result.ok) {
            setFeedback(`Approve failed: ${result.error}`);
            return;
          }
          setActiveProposalId(advanceId);
          router.refresh();
        });
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    chipProposals,
    activeProposalId,
    permissionsById,
    isPending,
    selectedId,
    snapshotOpen,
    renameOpen,
    deleteConfirmOpen,
    shareDialogOpen,
    shortcutsOpen,
    fullSheetId,
    activeThreadId,
    commentMode,
    deckMenuOpen,
    shareMenuOpen,
    editMenuOpen,
    exportMenuOpen,
    mobileRailOpen,
    mobileSlideListOpen,
    router,
    deck.id,
  ]);

  // Document-level Escape fallback for exiting comment mode.
  //
  // The overlay binds a `window` keydown handler with a "peel one layer at a
  // time" ladder (pending pin → active thread → exit comment mode). That's
  // the canonical UX. Symptom in the wild: after a user enters comment mode
  // and then clicks the toolbar Refresh button (moving focus to a `<button>`
  // outside the iframe / overlay), pressing Esc sometimes fails to exit
  // comment mode. The overlay's effect re-binds whenever any of (pending,
  // activeThreadId, commentMode, …) flips, and there's a brief window where
  // the listener isn't attached.
  //
  // The fallback below catches that case at the page level. Capture phase on
  // `document` means we still see the key even if a parent calls
  // `stopPropagation` on bubble. We defer to the overlay's ladder by:
  //   - returning early when an `<input>`, `<textarea>`, or contenteditable
  //     has focus (pending comment draft or reply draft — overlay owns that)
  //   - returning early when there's an active thread open (the overlay
  //     should close that first)
  // Otherwise we just exit comment mode. This is idempotent with the
  // overlay's handler — if both fire, both set commentMode to false.
  useEffect(() => {
    if (!commentMode) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const target = e.target as HTMLElement | null;
      if (target) {
        const tag = target.tagName;
        if (
          tag === "INPUT" ||
          tag === "TEXTAREA" ||
          tag === "SELECT" ||
          target.isContentEditable
        ) {
          return;
        }
      }
      if (activeThreadId) return;
      setCommentMode(false);
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [commentMode, activeThreadId]);

  // Keep the URL in sync with the active proposal AND the selected slide so
  // refresh / share-link / a remount preserves the review state and the
  // slide the user was on (the slide-1 bounce after an approve traced to a
  // remount re-running the selection initializer with nothing to restore
  // from). `replaceState` keeps the back-button history clean — neither is
  // a navigation event.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    if (activeProposalId) url.searchParams.set("proposal", activeProposalId);
    else url.searchParams.delete("proposal");
    if (selectedId) url.searchParams.set("slide", selectedId);
    else url.searchParams.delete("slide");
    // The `?full=1` flag only matters on initial load; drop it after we've
    // honoured it so the URL doesn't keep reopening the sheet on every
    // refresh.
    url.searchParams.delete("full");
    window.history.replaceState({}, "", url.toString());
  }, [activeProposalId, selectedId]);

  // Reset the wipe to "showing proposed" (reveal 0) whenever the active
  // proposal changes or clears, and drop the proposed-loaded flag so a brand
  // new overlay fades in cleanly instead of flashing the prior proposal. Done
  // as a render-phase "adjust state on change" (mirrors the lastSlideId block
  // below) rather than an effect — React's purity lint forbids unconditional
  // setState in an effect body.
  const [lastActiveProposalId, setLastActiveProposalId] =
    useState(activeProposalId);
  if (lastActiveProposalId !== activeProposalId) {
    setLastActiveProposalId(activeProposalId);
    setReveal(0);
    setProposedLoaded(false);
    // A slide_create has no slide of its own, so activating it would otherwise
    // leave the base frame (and the chrome — rail highlight, title) on an
    // unrelated slide. Snap the selection to whatever slide currently sits at
    // the new slide's insert position so the base frame shows that slide as the
    // "before"; the overlay shows the new slide at the same seam (see
    // proposedTargetPosition). slide_id is null on a create, so the slide-switch
    // reconcile below won't deactivate the proposal.
    const nextActive =
      activeProposalId != null
        ? pendingProposals.find((p) => p.id === activeProposalId)
        : null;
    if (
      nextActive?.kind === "slide_create" &&
      nextActive.new_slide_position != null &&
      slides.length > 0
    ) {
      const idx = Math.min(
        Math.max(nextActive.new_slide_position, 0),
        slides.length - 1,
      );
      const snapTo = slides[idx];
      if (snapTo && snapTo.id !== selectedId) setSelectedId(snapTo.id);
    }
  }

  // Lens compare gesture on the preview: HOLD Alt → momentarily reveal the
  // CURRENT slide beneath the proposal (reveal 1), snap back to proposed on
  // release (Docs-style peek). The seam drag (below, near the iframe) is the
  // sticky variant. Skips when focus is in a text input so composer typing
  // doesn't flip the wipe. Window blur clears a held Alt so the wipe can't
  // get stuck on "before" after an Alt-tab.
  useEffect(() => {
    if (!activeProposalId) return;
    const inEditable = (t: EventTarget | null) => {
      const el = t as HTMLElement | null;
      return !!(
        el &&
        (el.tagName === "INPUT" ||
          el.tagName === "TEXTAREA" ||
          el.isContentEditable)
      );
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (inEditable(e.target)) return;
      if (e.key === "Alt") {
        setReveal(1);
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === "Alt") setReveal(0);
    };
    const onBlur = () => setReveal(0);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    };
  }, [activeProposalId]);

  // Sync the iframe's in-deck navigation to the slide selected in the left
  // list. The assembled HTML ships with a small controller that listens for
  // `canvas:navigate` messages and clicks the matching dot (or falls back to
  // scrollIntoView). See `lib/canvas/assemble.ts`.
  const targetPosition = selected?.position ?? null;
  // The proposed (overlay) frame usually shares the base frame's position, so
  // the wipe compares the same slide before/after. The one exception is a
  // slide_create: the new slide lives one slot beyond any current slide, so the
  // overlay (rendered against the +1-length proposed deck) aims at the insert
  // position while the base stays on the nearest current slide — the "before".
  const proposedTargetPosition =
    activeProposal?.kind === "slide_create" &&
    activeProposal.new_slide_position != null
      ? Math.max(0, Math.min(activeProposal.new_slide_position, slides.length))
      : targetPosition;
  useEffect(() => {
    // Drive BOTH Lens frames so the current (base) and proposed (overlay) decks
    // show the right slide under the wipe. They share a position for every kind
    // except slide_create (see proposedTargetPosition), where the overlay sits
    // one slot ahead on the new slide.
    if (targetPosition != null) {
      iframeRef.current?.contentWindow?.postMessage(
        { type: "canvas:navigate", position: targetPosition },
        "*",
      );
    }
    if (proposedTargetPosition != null) {
      proposedIframeRef.current?.contentWindow?.postMessage(
        { type: "canvas:navigate", position: proposedTargetPosition },
        "*",
      );
    }
  }, [targetPosition, proposedTargetPosition, previewKey, activeProposalId]);

  // Reverse-sync: when CANVAS_CONTROLLER broadcasts the current position
  // (after a navigate, on load, on resize), update selectedId so the host
  // chrome + sidebar reflect reality. Also handles `canvas:key` — the
  // iframe forwards arrow / Space / PageUp / PageDown / Home / End up
  // here since EMBEDDED_GUARD silenced the deck's own keydown handler.
  // We replicate the modal/interlock checks from the window onKey listener
  // so an iframe-focused arrow press behaves the same as a host-focused
  // one. State comparison before setSelectedId avoids the iframe → host →
  // iframe loop the navigate effect would trigger when state matches.
  useEffect(() => {
    function handleMessage(event: MessageEvent) {
      const frame = iframeRef.current;
      if (!frame || event.source !== frame.contentWindow) return;
      const data = event.data;
      if (!data) return;
      if (data.type === "canvas:state") {
        const incoming = data.position;
        if (typeof incoming !== "number") return;
        // The host is the sole navigation authority — the iframe only ever
        // moves when we post canvas:navigate, so canvas:state is a confirmation
        // echo, NOT an independent source of truth. The one exception is the
        // controller's initial scheduleBounds(0) broadcast, fired on every
        // (re)load BEFORE our onLoad navigate lands: it asserts position 0
        // regardless of what's selected. Honour it and we snap selection to the
        // first slide every time the preview reloads — which happens whenever a
        // proposal preview toggles on/off as you click between slides while
        // reviewing. So ignore any state that contradicts the slide we have
        // selected; a real in-iframe nav (arrow keys) routes through the host
        // first (canvas:key), so by the time its state echoes back it matches.
        const intended =
          slides.find((s) => s.id === selectedId)?.position ?? null;
        if (intended != null && incoming !== intended) return;
        const match = slides.find((s) => s.position === incoming);
        if (match && match.id !== selectedId) {
          setSelectedId(match.id);
        }
        return;
      }
      if (data.type === "canvas:key") {
        // Modal/popover interlocks own their own keyboard contracts; defer.
        // Edit surfaces too — mirrors the window arrow-nav handler, so an
        // iframe-focused arrow can't page slides out from under an edit.
        if (
          snapshotOpen ||
          renameOpen ||
          deleteConfirmOpen ||
          fullSheetId != null ||
          activeThreadId != null ||
          commentMode ||
          deckMenuOpen ||
          shareMenuOpen ||
          editMenuOpen ||
          exportMenuOpen ||
          shareDialogOpen ||
          shortcutsOpen ||
          editMode !== "none"
        ) {
          return;
        }
        if (slides.length < 2) return;
        const currentIdx = slides.findIndex((s) => s.id === selectedId);
        if (currentIdx < 0) return;
        let nextIdx = currentIdx;
        switch (data.key) {
          case "ArrowLeft":
          case "PageUp":
            nextIdx = currentIdx - 1;
            break;
          case "ArrowRight":
          case "PageDown":
          case " ":
            nextIdx = currentIdx + 1;
            break;
          case "Home":
            nextIdx = 0;
            break;
          case "End":
            nextIdx = slides.length - 1;
            break;
          default:
            return;
        }
        nextIdx = Math.max(0, Math.min(slides.length - 1, nextIdx));
        if (nextIdx !== currentIdx) setSelectedId(slides[nextIdx].id);
        return;
      }
    }
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [
    slides,
    selectedId,
    snapshotOpen,
    renameOpen,
    deleteConfirmOpen,
    fullSheetId,
    activeThreadId,
    commentMode,
    deckMenuOpen,
    shareMenuOpen,
    editMenuOpen,
    exportMenuOpen,
    shareDialogOpen,
    shortcutsOpen,
    editMode,
  ]);

  // Close the deck overflow menu on outside click or Escape. Lives near
  // the deck title in the left sidebar — keeps the destructive Delete
  // action discoverable but out of reach of the Next.js dev indicator
  // that used to obscure it at the bottom of the viewport.
  useEffect(() => {
    if (!deckMenuOpen) return;
    function handleClickOutside(event: MouseEvent) {
      const root = deckMenuRef.current;
      if (root && !root.contains(event.target as Node)) {
        setDeckMenuOpen(false);
      }
    }
    function handleKey(event: KeyboardEvent) {
      if (event.key === "Escape") setDeckMenuOpen(false);
    }
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleKey);
    };
  }, [deckMenuOpen]);

  // Close the mobile slide-list drawer on Escape and when the user picks a
  // slide (the drawer should feel transient — pick + dismiss matches the
  // mobile pattern). The drawer trigger is `lg:hidden`, so this state is
  // never read at xl. Body scroll lock is intentionally NOT used here: the
  // host page is already constrained to viewport height (`h-[calc(100dvh-56px)]`)
  // so nothing scrolls behind the drawer anyway, and the ProposalSheet
  // already locks body scroll if both end up open at once.
  useEffect(() => {
    if (!mobileSlideListOpen && !mobileRailOpen) return;
    function handleKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        // Prefer to close whichever overlay is on top — the rail trigger
        // is rendered on top of the slide-list drawer trigger semantically,
        // so close it first if both happen to be open.
        if (mobileRailOpen) setMobileRailOpen(false);
        else setMobileSlideListOpen(false);
      }
    }
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [mobileSlideListOpen, mobileRailOpen]);

  // Same dismissal contract for the share/navigate overflow popover.
  useEffect(() => {
    if (!shareMenuOpen) return;
    function handleClickOutside(event: MouseEvent) {
      const root = shareMenuRef.current;
      if (root && !root.contains(event.target as Node)) {
        setShareMenuOpen(false);
      }
    }
    function handleKey(event: KeyboardEvent) {
      if (event.key === "Escape") setShareMenuOpen(false);
    }
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleKey);
    };
  }, [shareMenuOpen]);

  // Same dismissal contract for the Edit ▾ flyout.
  useEffect(() => {
    if (!editMenuOpen) return;
    function handleClickOutside(event: MouseEvent) {
      const root = editMenuRef.current;
      if (root && !root.contains(event.target as Node)) {
        setEditMenuOpen(false);
      }
    }
    function handleKey(event: KeyboardEvent) {
      if (event.key === "Escape") setEditMenuOpen(false);
    }
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleKey);
    };
  }, [editMenuOpen]);

  // Same dismissal contract for the Export format popover.
  useEffect(() => {
    if (!exportMenuOpen) return;
    function handleClickOutside(event: MouseEvent) {
      const root = exportMenuRef.current;
      if (root && !root.contains(event.target as Node)) {
        setExportMenuOpen(false);
      }
    }
    function handleKey(event: KeyboardEvent) {
      if (event.key === "Escape") setExportMenuOpen(false);
    }
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleKey);
    };
  }, [exportMenuOpen]);

  // Server-rendered exports (PDF, PPTX) go through fetch (not a bare
  // <a download>) because the render takes seconds — headless Chromium boot +
  // paint — and an anchor gives zero feedback in the meantime. The blob
  // round-trip lets the toolbar show "Exporting…" and surface failures in the
  // feedback banner. Shared by the PDF and PPTX handlers; only the path,
  // default extension, busy flag, and failure copy differ.
  const downloadServerExport = async (
    path: string,
    fallbackExt: string,
    format: ExportJob["format"],
    setBusy: (v: boolean) => void,
    errorMessage: string,
  ) => {
    setBusy(true);
    setFeedback(null);
    setExportElapsed(0);
    setExportJob({ format, status: "running", startedAt: Date.now() });
    try {
      const res = await fetch(path);
      if (!res.ok) throw new Error(`${path} ${res.status}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      const disposition = res.headers.get("Content-Disposition") ?? "";
      a.download =
        disposition.match(/filename="([^"]+)"/)?.[1] ??
        `${deck.title || "deck"}.${fallbackExt}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setExportJob((current) =>
        current ? { ...current, status: "success" } : null,
      );
      setFeedback(`${format} downloaded.`);
    } catch (err) {
      console.error(`[export:${fallbackExt}]`, err);
      setExportJob((current) =>
        current ? { ...current, status: "error", error: errorMessage } : null,
      );
      setFeedback(errorMessage);
    } finally {
      setBusy(false);
    }
  };

  const handleExportPdf = async () => {
    if (pdfExporting) return;
    await downloadServerExport(
      `/api/decks/${deck.id}/export/pdf`,
      "pdf",
      "PDF",
      setPdfExporting,
      "PDF export failed — try again, or export HTML and print it to PDF.",
    );
  };

  const handleExportPptx = async () => {
    if (pptxExporting) return;
    await downloadServerExport(
      `/api/decks/${deck.id}/export/pptx`,
      "pptx",
      "PowerPoint",
      setPptxExporting,
      "PowerPoint export failed — try again, or export PDF instead.",
    );
  };

  const handleLock = (slide: SlideRow) => {
    setFeedback(null);
    startTransition(async () => {
      const result = await lockSlide(slide.id, deck.id);
      if (result.ok) {
        refreshPreview();
        return;
      }
      switch (result.kind) {
        case "already_locked": {
          // Race: the slide was claimed between this client's render and the
          // click. Surface the actual holder + when the lock lifts, and pull
          // fresh server state so the "Claim slide" button gives way to the
          // lock badge without a manual refresh. We prefer the holder's
          // display name (matching the lock badge above) and fall back to a
          // generic phrasing if the user lookup failed.
          const holderLabel =
            result.holder_name || result.holder_email
              ? displayName({
                  name: result.holder_name,
                  email: result.holder_email ?? "",
                })
              : null;
          setFeedback(
            holderLabel
              ? `Already being edited by ${holderLabel}. Lock expires ${relativeDate(result.expires_at)}.`
              : `Already being edited by another user. Try again in 15 min.`,
          );
          router.refresh();
          return;
        }
        case "other":
          setFeedback(`Lock failed: ${result.error}`);
          return;
      }
    });
  };

  const handleRelease = (slide: SlideRow) => {
    setFeedback(null);
    startTransition(async () => {
      const result = await releaseSlide(slide.id, deck.id);
      if (!result.ok) {
        setFeedback(`Release failed: ${result.error}`);
      } else {
        refreshPreview();
      }
    });
  };

  const handleForceRelease = (slide: SlideRow) => {
    // Match the lock badge above: prefer the holder's display name, fall back
    // to "another user" when we don't know who they are. Never surface the
    // raw email — that's the polish gap this fix closes.
    const holder =
      slide.lock && (slide.lock.user_name || slide.lock.user_email)
        ? displayName({
            name: slide.lock.user_name,
            email: slide.lock.user_email ?? "",
          })
        : "another user";
    if (
      !confirm(
        `Force-release this slide? ${holder} is currently editing — their unsaved changes may be lost.`,
      )
    ) {
      return;
    }
    setFeedback(null);
    startTransition(async () => {
      const result = await forceReleaseSlide(slide.id, deck.id);
      if (result.ok) {
        setFeedback(`Released ${holder}'s lock.`);
        refreshPreview();
        return;
      }
      // Map each failure category to a message the user can act on.
      switch (result.kind) {
        case "lock_not_found":
          setFeedback("Lock already released — refreshing.");
          router.refresh();
          return;
        case "not_authorized":
          setFeedback(
            "You need to be an admin or owner of this workspace to force-release a lock.",
          );
          return;
        case "not_authenticated":
          setFeedback("Your session expired. Reload the page and sign in again.");
          return;
        case "slide_not_found":
          setFeedback("This slide no longer exists — refreshing.");
          router.refresh();
          return;
        case "rpc_error":
        case "slide_lookup_failed":
        case "delete_failed":
          setFeedback(
            `Force release failed — please try again. ${result.error ?? ""}`.trim(),
          );
          return;
      }
    });
  };

  const lockedByMe = selected?.lock?.locked_by === currentUserId;
  const hasActiveLock = Boolean(selected?.lock);

  // Live countdown shown next to the "Editing" pill when the current user
  // holds the slide's lock. The 15-minute soft lock has its `expires_at`
  // already in slide props (no extra fetch). React 19's purity lint forbids
  // `Date.now()` during render, so the "now" timestamp lives in state and
  // is bumped by a self-rescheduling timeout. That cadence is cheap and
  // accurate enough that users see a sub-minute remaining warning before
  // the lock lapses, without per-second jitter or wasted renders. The
  // initial state is computed in a lazy initialiser so SSR sees a stable
  // value, and the effect only schedules the next tick (no setState on
  // mount → no `set-state-in-effect` lint trip).
  //
  // Initial-render clamp. The lazy `lockNow` is captured before the server's
  // `expires_at` lands in props for a slide claimed in this same render, so
  // `expires - lockNow` can briefly exceed the 15min lease window (clock
  // drift + RPC latency). Clamping the remaining time to the lease keeps
  // that first frame from flashing "16m 55s" before the next tick settles
  // the value below 15min.
  const [lockNow, setLockNow] = useState<number>(() => Date.now());
  const lockCountdownActive = lockedByMe && hasActiveLock;
  // Lock heartbeat. The soft lock is a flat 15-min TTL with no renewal, so an
  // edit running past 15 minutes used to have its hold lapse silently — and
  // then another user or Claude could claim the slide mid-edit. We piggyback
  // renewal on the SAME interval that drives the countdown display (no second
  // timer): every tick we bump `lockNow` for the label, and once ~5 minutes of
  // wall time has passed since the last renewal we push the lock's `expires_at`
  // forward by a fresh lease. We only renew the slide the user is ACTIVELY
  // editing (`editingSlideId`) and only while the tab is visible — a backgrounded
  // tab shouldn't keep a lock alive forever, and `renewSlideLock` is
  // holder-scoped server-side so it can only ever extend the caller's own hold.
  // `renewed: false` (the lock lapsed or was force-released out from under us)
  // is left to the next server refresh / realtime tick to reconcile the badge;
  // we just stop pushing on a hold we no longer own.
  const RENEW_INTERVAL_MS = 5 * 60 * 1000;
  // 0 until the hold starts; the effect stamps the real clock on (re)acquire.
  // (Initializing with Date.now() would be an impure read during render.)
  const lastRenewRef = useRef<number>(0);
  useEffect(() => {
    if (!lockCountdownActive) return;
    // Reset the renewal clock whenever the active hold (re)starts so we don't
    // immediately fire a renew on a lock that was just freshly acquired.
    lastRenewRef.current = Date.now();
    const id = window.setInterval(() => {
      const now = Date.now();
      setLockNow(now);
      if (
        editingSlideId &&
        document.visibilityState === "visible" &&
        now - lastRenewRef.current >= RENEW_INTERVAL_MS
      ) {
        lastRenewRef.current = now;
        void renewSlideLock(editingSlideId, deck.id);
      }
    }, 20_000);
    return () => window.clearInterval(id);
  }, [lockCountdownActive, editingSlideId, deck.id, RENEW_INTERVAL_MS]);

  // Release-on-unload. A lock held by a tab that's closed (or navigated away)
  // used to linger for the full 15-min TTL, blocking everyone else from the
  // slide. When the user is mid-edit (`editingSlideId` set) we best-effort
  // release the held slide the moment the tab is torn down or hidden, so the
  // lock clears immediately instead of waiting out the lease.
  //
  // We register two signals because they cover different teardown paths and
  // neither is universally reliable: `visibilitychange → hidden` is the modern,
  // dependable signal (it fires on tab close, tab switch, and mobile
  // backgrounding while the page is still alive enough to send), and
  // `beforeunload` backstops a hard reload / same-tab navigation. We call the
  // existing `releaseSlide` server action with `void` (fire-and-forget); on a
  // real close the request may be cut short, but the renewal heartbeat above
  // has already stopped, so the worst case degrades to the original 15-min
  // lapse rather than an indefinitely stuck lock. A mere tab-switch that
  // releases the lock is acceptable: the user can re-claim on return, and a
  // freed lock is strictly better for collaborators than a stale one.
  // Mirror editingSlideId into a ref so the unload listeners (registered once)
  // always read the latest held slide without re-registering. Synced in an
  // effect, not during render (assigning a ref during render is impure).
  const editingSlideRef = useRef<string | null>(null);
  useEffect(() => {
    editingSlideRef.current = editingSlideId;
  }, [editingSlideId]);
  useEffect(() => {
    const releaseHeld = () => {
      const held = editingSlideRef.current;
      if (held) void releaseSlide(held, deck.id);
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") releaseHeld();
    };
    window.addEventListener("beforeunload", releaseHeld);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("beforeunload", releaseHeld);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [deck.id]);
  const lockExpiresAt = selected?.lock?.expires_at ?? null;
  const lockCountdownLabel = useMemo(() => {
    if (!(lockCountdownActive && lockExpiresAt)) return null;
    const expires = new Date(lockExpiresAt).getTime();
    // `LOCK_DURATION_MINUTES = 15` (see `./actions.ts`). Clamp to that
    // window so an initial render where lazy `lockNow` is older than the
    // freshly-issued `expires_at` doesn't paint "16m 55s".
    const LEASE_MS = 15 * 60 * 1000;
    const remainMs = Math.min(LEASE_MS, Math.max(0, expires - lockNow));
    if (remainMs <= 0) return "expired";
    const totalSeconds = Math.floor(remainMs / 1000);
    const m = Math.floor(totalSeconds / 60);
    const s = totalSeconds % 60;
    if (m >= 1) return `expires in ${m}m ${s.toString().padStart(2, "0")}s`;
    return `expires in ${s}s`;
  }, [lockCountdownActive, lockExpiresAt, lockNow]);

  // Auto-scroll the persistent rail's selected slide into view when the
  // selection changes from outside a click (e.g. ArrowLeft/Right keyboard
  // nav, a right-rail proposal row that targets an off-screen slide, or a
  // resolved-proposal deep link landing on a deck with many slides). Scoped
  // to the rail via `data-slide-id` so the mobile drawer copy is ignored —
  // it scrolls naturally via the user's own gesture inside the slide-over.
  // `block: 'nearest'` keeps the scroll minimal: if the button is already
  // visible, no scrolling happens.
  useEffect(() => {
    if (!selectedId) return;
    const btn = document.querySelector<HTMLButtonElement>(
      `[data-slide-id="${selectedId}"]`,
    );
    btn?.scrollIntoView({ block: "nearest" });
  }, [selectedId]);

  // Slide-list panel content. Rendered twice in the tree: once as the
  // permanent left rail (`lg:flex` and up — desktop / wide laptop) and once
  // inside the mobile drawer overlay (`< lg` — tablet / phone). Extracted
  // into a closure to avoid drifting between the two copies; both reuse the
  // same slide-pick handler (which closes the drawer if it's open).
  const renderSlideListBody = (variant: "rail" | "drawer") => (
    <>
      <div className="border-b border-border px-4 py-3">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-sm font-medium text-foreground">
              {deck.title}
            </h2>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <div className="relative" ref={variant === "rail" ? deckMenuRef : undefined}>
              <button
                type="button"
                aria-label="Deck actions"
                aria-haspopup="menu"
                aria-expanded={variant === "rail" ? deckMenuOpen : false}
                onClick={() =>
                  variant === "rail" ? setDeckMenuOpen((v) => !v) : undefined
                }
                disabled={variant !== "rail"}
                className="inline-flex h-7 w-7 items-center justify-center rounded-[6px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
              >
                <MoreHorizontal aria-hidden className="h-4 w-4" />
              </button>
              {variant === "rail" && deckMenuOpen ? (
                <MenuSurface
                  onClose={() => setDeckMenuOpen(false)}
                  className="absolute right-0 top-full z-40 mt-1 min-w-[180px] overflow-hidden rounded-[8px] border border-border bg-card shadow-lg"
                >
                  <button
                    role="menuitem"
                    type="button"
                    disabled={isPending}
                    onClick={() => {
                      setDeckMenuOpen(false);
                      setRenameOpen(true);
                    }}
                    className="flex w-full items-center px-3 py-2 text-left text-xs text-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    Rename deck
                  </button>
                  <button
                    role="menuitem"
                    type="button"
                    disabled={isPending}
                    onClick={() => {
                      setDeckMenuOpen(false);
                      setShareDialogOpen(true);
                    }}
                    className="flex w-full items-center justify-between px-3 py-2 text-left text-xs text-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <span>Share with people</span>
                    <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                      {deck.visibility === "private" ? "Private" : "Workspace"}
                    </span>
                  </button>
                  <button
                    role="menuitem"
                    type="button"
                    disabled={isPending}
                    onClick={() => {
                      setDeckMenuOpen(false);
                      setFeedback(null);
                      startTransition(async () => {
                        const result = await duplicateDeck(deck.id);
                        if (result.ok && result.newDeckId) {
                          router.push(`/canvases/${result.newDeckId}`);
                          return;
                        }
                        if (!result.ok)
                          setFeedback(`Duplicate failed: ${result.error}`);
                      });
                    }}
                    className="flex w-full items-center px-3 py-2 text-left text-xs text-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    Duplicate deck
                  </button>
                  <div aria-hidden className="h-px w-full bg-border" />
                  {/* Editorial status (draft / in review / final). A radio
                      group modeled on the visibility chip. Each pick is a
                      one-shot choice, so we close the menu on select like the
                      other items rather than keeping it open. */}
                  <div className="px-3 pb-1 pt-2 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                    Status
                  </div>
                  {(
                    [
                      ["draft", "Draft"],
                      ["in_review", "In review"],
                      ["final", "Final"],
                    ] as const
                  ).map(([value, label]) => {
                    const active = ((deck.status as DeckStatus) ?? "draft") === value;
                    return (
                      <button
                        key={value}
                        role="menuitemradio"
                        aria-checked={active}
                        type="button"
                        disabled={isPending}
                        onClick={() => {
                          setDeckMenuOpen(false);
                          handleSetStatus(value);
                        }}
                        className="flex w-full items-center justify-between px-3 py-2 text-left text-xs text-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        <span>{label}</span>
                        {active ? (
                          <span aria-hidden className="text-[color:var(--accent)]">
                            ✓
                          </span>
                        ) : null}
                      </button>
                    );
                  })}
                  <div aria-hidden className="h-px w-full bg-border" />
                  <button
                    role="menuitemcheckbox"
                    aria-checked={deck.agent_fast_lane_enabled}
                    type="button"
                    disabled={isPending || !canManageFastLane || !allowSelfApproval}
                    onClick={() => {
                      setDeckMenuOpen(false);
                      setFeedback(null);
                      startTransition(async () => {
                        const enabled = !deck.agent_fast_lane_enabled;
                        const result = await setDeckAgentFastLane(deck.id, enabled);
                        setFeedback(
                          result.ok
                            ? enabled
                              ? "Trusted agent patches can apply after visual verification."
                              : "Trusted agent fast lane disabled."
                            : "Couldn't update the trusted agent fast lane.",
                        );
                        if (result.ok) router.refresh();
                      });
                    }}
                    className="flex w-full items-start justify-between gap-3 px-3 py-2 text-left text-xs text-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
                    title={
                      allowSelfApproval
                        ? "Only deterministic agent patches can use this after render verification"
                        : "Enable workspace self-approval in Settings first"
                    }
                  >
                    <span>
                      <span className="block">Trusted agent patches</span>
                      <span className="mt-0.5 block text-[10px] leading-snug text-muted-foreground">
                        Apply after visual verification
                      </span>
                    </span>
                    <span aria-hidden className="text-[color:var(--accent)]">
                      {deck.agent_fast_lane_enabled ? "✓" : ""}
                    </span>
                  </button>
                  <div aria-hidden className="h-px w-full bg-border" />
                  <button
                    role="menuitem"
                    type="button"
                    disabled={isPending}
                    onClick={() => {
                      setDeckMenuOpen(false);
                      setDeleteConfirmOpen(true);
                    }}
                    className="flex w-full items-center px-3 py-2 text-left text-xs text-[color:var(--danger)] transition-colors hover:bg-[color:var(--danger)]/10 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    Delete deck
                  </button>
                </MenuSurface>
              ) : null}
            </div>
            {variant === "drawer" ? (
              <button
                type="button"
                aria-label="Close slide list"
                onClick={() => setMobileSlideListOpen(false)}
                className="inline-flex h-7 w-7 items-center justify-center rounded-[6px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <span aria-hidden className="text-base leading-none">
                  ×
                </span>
              </button>
            ) : null}
          </div>
        </div>
        <div className="font-machine mt-1 text-[11px] text-muted-foreground">
          Updated {relativeDate(deck.updated_at)} · {slides.length} slide
          {slides.length === 1 ? "" : "s"}
        </div>
      </div>
      <ul
        className={cn(
          "min-h-0 flex-1 overflow-y-auto py-2",
          // Drawer variant runs full-height (inset-y-0) over the viewport, so
          // pad the scroll body past the home indicator. The rail variant is
          // inside the desktop chrome and never touches the device edge.
          variant === "drawer" && "pb-safe",
        )}
      >
        {slides.map((slide) => {
          const isSel = slide.id === selected?.id;
          const lockedByAgent = slide.lock?.locked_by_kind === "agent";
          // Count both pinned and unpinned agent-note unresolved roots.
          // Lock + open-comment state ride in the row tooltip / aria-label
          // now — the copper pending badge is the row's only visible mark,
          // so the rail carries exactly one signal: "needs a decision".
          const slideUnresolved = comments.filter(
            (c) =>
              c.slide_id === slide.id &&
              c.parent_id == null &&
              !c.resolved,
          ).length;
          const lockHolder = slide.lock
            ? lockedByAgent
              ? "Agent"
              : slide.lock.user_name || slide.lock.user_email
                ? displayName({
                    name: slide.lock.user_name,
                    email: slide.lock.user_email ?? "",
                  })
                : "another user"
            : null;
          const rowLabel = `${slide.title || "Untitled slide"}${
            lockHolder ? ` — locked by ${lockHolder}` : ""
          }${
            slideUnresolved > 0
              ? ` — ${slideUnresolved} open comment${slideUnresolved === 1 ? "" : "s"}`
              : ""
          }`;
          return (
            <li key={slide.id}>
              {/* `group` + `relative` lets the slide actions (Duplicate /
                  Delete) overlay the row and reveal on hover/focus. We can't
                  nest the action <button>s inside the selection <button>
                  (invalid HTML), so they sit as siblings positioned over the
                  row's right edge. */}
              <div
                className={cn(
                  "group relative",
                  draggingSlideId === slide.id && "opacity-50",
                )}
                draggable={canReorderSlides}
                onDragStart={
                  canReorderSlides
                    ? (e) => {
                        setDraggingSlideId(slide.id);
                        e.dataTransfer.effectAllowed = "move";
                        e.dataTransfer.setData("text/plain", slide.id);
                      }
                    : undefined
                }
                onDragOver={
                  canReorderSlides
                    ? (e) => {
                        if (!draggingSlideId || draggingSlideId === slide.id)
                          return;
                        e.preventDefault();
                        e.dataTransfer.dropEffect = "move";
                        const rect = e.currentTarget.getBoundingClientRect();
                        const below = e.clientY > rect.top + rect.height / 2;
                        setDropTarget((cur) =>
                          cur && cur.overId === slide.id && cur.below === below
                            ? cur
                            : { overId: slide.id, below },
                        );
                      }
                    : undefined
                }
                onDrop={
                  canReorderSlides
                    ? (e) => {
                        e.preventDefault();
                        const draggedId =
                          draggingSlideId || e.dataTransfer.getData("text/plain");
                        if (draggedId && draggedId !== slide.id) {
                          const below =
                            dropTarget?.overId === slide.id
                              ? dropTarget.below
                              : false;
                          handleReorder(
                            draggedId,
                            slide.position + (below ? 1 : 0),
                          );
                        }
                        setDraggingSlideId(null);
                        setDropTarget(null);
                      }
                    : undefined
                }
                onDragEnd={() => {
                  setDraggingSlideId(null);
                  setDropTarget(null);
                }}
              >
                {/* Insertion line shown while a dragged row hovers this one. */}
                {dropTarget?.overId === slide.id ? (
                  <div
                    aria-hidden
                    className={cn(
                      "pointer-events-none absolute inset-x-1 z-10 h-0.5 rounded-full bg-[color:var(--accent)]",
                      dropTarget.below ? "-bottom-px" : "-top-px",
                    )}
                  />
                ) : null}
                <button
                  type="button"
                  // `data-slide-id` is set only on the rail variant so the
                  // selected-into-view effect below can find the button
                  // without picking up the mobile drawer's copy (which
                  // scrolls naturally via the drawer's own gesture).
                  data-slide-id={variant === "rail" ? slide.id : undefined}
                  onClick={() => {
                    setSelectedId(slide.id);
                    // Mobile drawer closes on pick; the rail doesn't (selection
                    // changes in place there).
                    if (variant === "drawer") setMobileSlideListOpen(false);
                  }}
                  // Sidebar buttons truncate long slide titles ("Cronograma de
                  // Entrevist…"); a native title attr is the cheapest
                  // hover-to-reveal. It also carries the lock holder and
                  // open-comment count that used to be badges on the row.
                  title={rowLabel}
                  aria-label={rowLabel}
                  className={[
                    "flex h-9 w-full items-center gap-3 px-4 text-left",
                    canReorderSlides ? "cursor-grab active:cursor-grabbing" : "",
                    isSel
                      ? "bg-[color:var(--accent-wash)] text-foreground"
                      : "text-muted-foreground hover:bg-muted hover:text-foreground",
                  ].join(" ")}
                >
                  <span className="font-machine w-8 shrink-0 text-right text-[11px]">
                    {slide.position + 1}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-sm">{slide.title}</span>
                  {slide.pending_proposals > 0 ? (
                    <span
                      className="font-machine inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-[color:var(--accent-warm)]/15 px-1 text-[10px] font-semibold text-[color:var(--accent-warm)] ring-1 ring-[color:var(--accent-warm)]/40"
                      aria-label={`${slide.pending_proposals} pending proposal${slide.pending_proposals === 1 ? "" : "s"}`}
                      title={`${slide.pending_proposals} pending proposal${slide.pending_proposals === 1 ? "" : "s"}`}
                    >
                      {slide.pending_proposals}
                    </span>
                  ) : null}
                </button>
                {/* Duplicate/delete go DIRECT for deck editors (the 0071 RPCs
                  * enforce canvas_can_edit_deck) — offer them under the same
                  * client gate as the other direct structural ops (ADR-0012),
                  * so a viewer isn't shown buttons that can only error. */}
                {canProposeSlideEdit ? (
                  <div
                    className={cn(
                      "absolute right-2 top-1/2 hidden -translate-y-1/2 items-center gap-1 group-hover:flex focus-within:flex",
                      // Touch has no hover, so the hover/focus-only reveal above
                      // leaves the actions unreachable on a phone. Reveal them on
                      // the *selected* row only on coarse (touch) pointers —
                      // keeps them discoverable (tap a slide → its actions
                      // appear) without permanently covering every row's
                      // proposal/lock badges.
                      isSel && "pointer-coarse:flex",
                    )}
                  >
                    {canReorderSlides ? (
                      <span
                        aria-hidden
                        title="Drag to reorder"
                        className="flex cursor-grab items-center justify-center p-1 text-muted-foreground/50"
                      >
                        <GripVertical className="h-3.5 w-3.5" />
                      </span>
                    ) : null}
                    <button
                      type="button"
                      aria-label={`Duplicate slide ${slide.position + 1}`}
                      onClick={(e) => {
                        // Stop the click from also selecting the row.
                        e.stopPropagation();
                        handleDuplicateSlide(slide.id);
                      }}
                      disabled={isPending}
                      className={cn(
                        "flex items-center justify-center rounded-[6px] bg-card/90 p-1 text-muted-foreground shadow-sm transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
                        // Enlarge to a 32px tap target to fit the 36px (h-9) row.
                        isSel &&
                          "pointer-coarse:h-8 pointer-coarse:w-8 pointer-coarse:p-0",
                      )}
                    >
                      <Copy aria-hidden className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      aria-label={`Delete slide ${slide.position + 1}`}
                      title={
                        slides.length === 1
                          ? "Can't delete the deck's only slide"
                          : "Delete this slide"
                      }
                      onClick={(e) => {
                        e.stopPropagation();
                        setDeleteSlideTarget(slide);
                      }}
                      disabled={isPending || slides.length === 1}
                      className={cn(
                        "flex items-center justify-center rounded-[6px] bg-card/90 p-1 text-muted-foreground shadow-sm transition-colors hover:bg-destructive/10 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
                        isSel &&
                          "pointer-coarse:h-8 pointer-coarse:w-8 pointer-coarse:p-0",
                      )}
                    >
                      <Trash2 aria-hidden className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
      {canCreateSlide ? (
        <div className="flex gap-2 border-t border-border p-2">
          <button
            type="button"
            onClick={openDrawNew}
            disabled={isPending}
            className="flex min-w-0 flex-1 items-center justify-center gap-2 rounded-[8px] border border-dashed border-border px-3 py-2 text-xs font-medium text-muted-foreground transition-colors hover:border-[color:var(--accent)]/50 hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
            title="Create a new slide and draw on it"
          >
            <Plus aria-hidden className="h-3.5 w-3.5" />
            <span className="truncate">Draw a slide</span>
          </button>
          {/* Cross-deck reuse: the team/pricing/case-study slide you already
            * built lands here instead of being hand-ported between files. */}
          <button
            type="button"
            onClick={() => setCopySlideOpen(true)}
            disabled={isPending}
            className="flex min-w-0 flex-1 items-center justify-center gap-2 rounded-[8px] border border-dashed border-border px-3 py-2 text-xs font-medium text-muted-foreground transition-colors hover:border-[color:var(--accent)]/50 hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
            title="Copy a slide from another deck in this workspace"
          >
            <Copy aria-hidden className="h-3.5 w-3.5" />
            <span className="truncate">From a deck</span>
          </button>
        </div>
      ) : null}
    </>
  );

  // Right rail content (comments list + proposals + degraded banner +
  // feedback). Mirrored into the mobile sheet via the same closure pattern
  // as the slide list; `variant === "sheet"` is the mobile/tablet overlay,
  // `"rail"` is the permanent xl/lg sidebar.
  const renderRightRailBody = (variant: "rail" | "sheet") => (
    <>
      {variant === "sheet" ? (
        <div className="flex items-center justify-between border-b border-border px-5 py-3">
          <div className="eyebrow text-muted-foreground">Activity</div>
          <button
            type="button"
            aria-label="Close activity panel"
            onClick={() => setMobileRailOpen(false)}
            className="inline-flex h-7 w-7 items-center justify-center rounded-[6px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span aria-hidden className="text-base leading-none">
              ×
            </span>
          </button>
        </div>
      ) : null}
      {/* Review — the one queue. Decisions happen in the chip; this section
       * routes into it (and to the cross-deck inbox) instead of mirroring
       * the queue as a second row list. */}
      <div
        className={cn(
          "border-b border-border px-5",
          deckPendingCount > 0 ? "py-4" : "py-3",
        )}
      >
        <div className="flex items-center justify-between">
          <div className="eyebrow text-muted-foreground">Review</div>
          <div className="flex items-center gap-2">
            {deckPendingCount > 0 && (
              <span
                className="font-machine inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-[color:var(--accent-warm)]/15 px-1.5 text-[10px] font-semibold text-[color:var(--accent-warm)] ring-1 ring-[color:var(--accent-warm)]/40"
                aria-label={`${deckPendingCount} pending`}
              >
                {deckPendingCount}
              </span>
            )}
            <Link
              href="/canvases/inbox"
              className="text-xs font-medium text-[color:var(--accent)] hover:underline"
            >
              All proposals →
            </Link>
          </div>
        </div>

        {deckPendingCount > 0 ? (
          <>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="mt-3 w-full"
              onClick={() => {
                activateReview();
                if (variant === "sheet") setMobileRailOpen(false);
              }}
              title="Jump to the first pending proposal in review order"
            >
              Review {deckPendingCount} pending
            </Button>
            {claudeBatch.length > 0 ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="mt-2 w-full"
                disabled={isPending}
                onClick={handleApproveClaudeBatch}
                title="Approve every eligible agent proposal whose slide has one pending edit"
              >
                Approve {claudeBatch.length} from agents
              </Button>
            ) : null}
          </>
        ) : null}
      </div>

      {/* Comments — ONE section for every comment surface: pinned threads on
       * the current slide, its unpinned notes (e.g. Claude's review notes),
       * and deck-wide notes. Tiny sub-labels group them; one empty state
       * covers the lot. */}
      {selected ? (
        <div
          className={cn(
            "flex flex-col border-b border-border",
            !commentsCollapsed && "max-h-[40dvh]",
          )}
        >
          <div
            className={cn(
              "flex items-center justify-between px-5",
              commentsCollapsed ? "py-3" : "pt-4",
            )}
          >
            <div className="eyebrow text-muted-foreground">
              Comments
              {commentRootsTotal > 0 ? (
                <span className="ml-2 text-muted-foreground">
                  {commentRootsOpen} open · {commentRootsTotal} total
                </span>
              ) : null}
            </div>
            {/* One toggle governs every comment surface (this merged list +
                the slide pins), so it appears whenever ANY root thread in the
                deck is resolved — not just pinned ones on this slide. */}
            {comments.some((c) => c.parent_id == null && c.resolved) ? (
              <button
                type="button"
                onClick={() => setShowResolved((v) => !v)}
                className="text-[10px] uppercase tracking-wide text-muted-foreground hover:text-foreground"
              >
                {showResolved ? "Hide resolved" : "Show resolved"}
              </button>
            ) : null}
          </div>
          {commentsCollapsed ? null : (
          <div className="flex-1 overflow-y-auto px-5 pb-3 pt-2">
            {commentsEmpty ? (
              <div className="flex items-start gap-2 rounded-[10px] bg-muted px-3 py-3 text-[11px] text-muted-foreground">
                {/* Inline pin glyph — solid blue (humans/collaboration). */}
                <svg
                  aria-hidden
                  viewBox="0 0 16 16"
                  className="mt-[1px] h-3.5 w-3.5 shrink-0 text-[color:var(--accent)]"
                  fill="currentColor"
                >
                  <path d="M8 1.5c-2.21 0-4 1.79-4 4 0 2.7 2.96 6.84 3.55 7.64a.56.56 0 0 0 .9 0C9.04 12.34 12 8.2 12 5.5c0-2.21-1.79-4-4-4Zm0 5.6a1.6 1.6 0 1 1 0-3.2 1.6 1.6 0 0 1 0 3.2Z" />
                </svg>
                <span>Click anywhere on the slide to drop a pin.</span>
              </div>
            ) : (
              <div className="space-y-3">
                {visibleRoots.length > 0 ? (
                  <div>
                    <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                      Pinned
                    </div>
                    <ul className="mt-1 space-y-1">
                      {visibleRoots.map((root) => {
                        const replies = repliesByRoot.get(root.id) ?? [];
                        const isActive = activeThreadId === root.id;
                        return (
                          <li key={root.id}>
                            <button
                              type="button"
                              onClick={() => {
                                setActiveThreadId(isActive ? null : root.id);
                                setCommentMode(false);
                                if (variant === "sheet") setMobileRailOpen(false);
                              }}
                              className={cn(
                                "flex w-full items-start gap-2 rounded-[8px] px-2 py-2 text-left transition",
                                isActive
                                  ? "bg-[color:var(--accent-wash)]"
                                  : "hover:bg-muted",
                              )}
                            >
                              <span
                                className={cn(
                                  "mt-[2px] inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1 text-[10px] font-semibold",
                                  root.resolved
                                    ? "bg-muted text-muted-foreground"
                                    : "bg-[color:var(--accent)] text-white",
                                )}
                              >
                                {replies.length + 1}
                              </span>
                              <div className="min-w-0 flex-1">
                                <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                                  <span className="truncate font-medium text-foreground">
                                    {root.author_kind === "claude"
                                      ? "Agent"
                                      : displayName({
                                          name: root.author_name,
                                          email: root.author_email ?? "?",
                                        })}
                                  </span>
                                  <span>·</span>
                                  <span
                                    suppressHydrationWarning
                                    title={new Date(root.created_at).toLocaleString()}
                                  >
                                    {relativeDate(root.created_at)}
                                  </span>
                                </div>
                                <p className="mt-0.5 line-clamp-2 text-xs text-foreground">
                                  {root.body}
                                </p>
                              </div>
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                ) : null}
                {visibleSlideNoteCount > 0 ? (
                  <div>
                    <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                      Notes
                    </div>
                    <div className="mt-1">
                      <UnpinnedNotes
                        deckId={deck.id}
                        slideId={selected.id}
                        comments={commentsForSlide}
                        currentUserId={currentUserId}
                        canModerate={canModerateComments}
                        showResolved={showResolved}
                        embedded
                      />
                    </div>
                  </div>
                ) : null}
                {visibleDeckNoteCount > 0 ? (
                  <div>
                    <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                      Deck notes
                    </div>
                    <div className="mt-1">
                      <UnpinnedNotes
                        deckId={deck.id}
                        slideId={null}
                        comments={deckLevelComments}
                        currentUserId={currentUserId}
                        canModerate={canModerateComments}
                        showResolved={showResolved}
                        embedded
                      />
                    </div>
                  </div>
                ) : null}
              </div>
            )}
          </div>
          )}
        </div>
      ) : null}


      {realtimeDegraded ? (
        /* True conflict/degradation state — keep amber. Per the locked-in
         * semantics, amber belongs to "stale, contested, or conflict". A
         * dropped realtime subscription means the editor may now be showing
         * stale state, which is exactly what amber is for. */
        <div
          role="status"
          className="border-t border-[color:var(--warning)]/30 bg-[color:var(--warning)]/10 px-5 py-2 text-xs text-[color:var(--warning)]"
        >
          Live updates paused — use Refresh to pull changes manually.
        </div>
      ) : null}
      {feedback ? (
        <div className="px-5 py-3 text-xs text-muted-foreground">{feedback}</div>
      ) : null}
    </>
  );

  return (
    <div className="flex h-[calc(100dvh-56px)] w-full">
      {/* Left — slide list (xl/lg only). Below lg the drawer overlay
       * (further down) replaces it, opened by the hamburger button at the
       * top-left of the preview chrome. */}
      <aside className="hidden w-64 shrink-0 flex-col border-r border-border bg-card lg:flex">
        {renderSlideListBody("rail")}
      </aside>

      {/* Middle — live preview.
       * Background is transparent so the body-level .app-shell-atmosphere
       * (radial blue glow, mounted in layout.tsx) shows through. The slide
       * itself sits inside .slide-preview-frame below, which provides its
       * own paper-white surface and visual containment. */}
      <section className="relative z-[1] flex min-w-0 flex-1 flex-col bg-transparent">
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b border-border bg-card px-3 py-2 sm:px-4">
          {/* Left: hamburger (below lg) + active slide identity. Hamburger
           * mirrors the slide list at narrow widths since the left rail is
           * hidden there; rolls up via `setMobileSlideListOpen(true)`. */}
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <button
              type="button"
              aria-label="Open slide list"
              aria-haspopup="dialog"
              aria-expanded={mobileSlideListOpen}
              onClick={() => setMobileSlideListOpen(true)}
              className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-[8px] text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring lg:hidden"
            >
              {/* Three-line hamburger glyph — SVG so it scales with text. */}
              <svg
                aria-hidden
                viewBox="0 0 16 16"
                className="h-4 w-4"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              >
                <path d="M2 4h12M2 8h12M2 12h12" />
              </svg>
            </button>
            <div className="min-w-0 flex-1">
              {selected ? (
                <>
                  <h3 className="truncate text-sm font-semibold text-foreground">
                    {selected.title || "Untitled slide"}
                  </h3>
                  <p className="mt-0.5 text-[11px] text-muted-foreground">
                    <span className="font-machine">
                      Position {selected.position + 1}
                    </span>
                    <span> · </span>
                    {selected.current_version_no ? (
                      <Link
                        href={`/canvases/${deck.id}/history?slide=${selected.id}`}
                        title="View this slide's version history"
                        className="font-machine text-[color:var(--accent)] hover:underline"
                      >
                        v{selected.current_version_no}
                      </Link>
                    ) : (
                      <span className="font-machine">unversioned</span>
                    )}
                  </p>
                </>
              ) : (
                <span className="text-xs text-muted-foreground">No slides yet</span>
              )}
            </div>
          </div>

          {/*
           * Right cluster.
           *
           * One flat cluster, one divider before the output pair:
           *   [Review pill?] [Edit ▾] [Comment] [lock pill?] [Activity <lg] [⋯]
           *   | [Present] [Export]
           * The three "change this slide" mechanisms live behind Edit ▾; the
           * rare/expert acts (claim, copy link, Claude prompt, snapshot,
           * history, shortcuts) live in the ⋯ overflow.
           */}
          <div className="flex flex-wrap items-center gap-1.5 sm:gap-2">
            {/* Review pill — present only while proposals are pending (review
             * mode). Copper = decisions. Click jumps into the chip on the
             * first proposal in review order; no-op if one is already active.
             * Collapses to the bare count below sm. */}
            {reviewMode ? (
              <button
                type="button"
                onClick={activateReview}
                className="font-machine inline-flex h-8 items-center rounded-full bg-[color:var(--accent-warm)]/15 px-3 text-[11px] font-semibold text-[color:var(--accent-warm)] ring-1 ring-[color:var(--accent-warm)]/40 transition-colors hover:bg-[color:var(--accent-warm)]/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                title={`Review ${deckPendingCount} pending proposal${deckPendingCount === 1 ? "" : "s"}`}
                aria-label={`Review ${deckPendingCount} pending`}
              >
                <span className="hidden sm:inline">Review&nbsp;·&nbsp;</span>
                {deckPendingCount}
              </button>
            ) : null}

            {/* Edit ▾ — entry point for the three in-place "change this slide"
             * mechanisms: text editing, the Adjust inspector (click an element
             * → size/color/spacing controls + arrow-key nudge), and raw HTML.
             * Asking Claude to change a specific element lives in the Ask
             * Claude composer (the "Point at an element" button), not here.
             * While picking or editing, the slot swaps in place for that mode's
             * cluster. Hidden during comment mode. In review mode the text
             * label hides at all widths (icon + chevron only); the tooltip
             * keeps the words. */}
            {editMode === "none" && selected && !commentMode ? (
              pickingPrompt ? (
                <div className="flex items-center gap-1.5">
                  <span className="hidden text-[11px] text-muted-foreground md:inline">
                    Click an element on the slide
                  </span>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={cancelElementPick}
                    title="Stop picking (Esc)"
                  >
                    <X aria-hidden className="h-3.5 w-3.5" />
                    <span className="hidden sm:inline">Cancel</span>
                  </Button>
                </div>
              ) : canEnterEdit ? (
                <div className="relative" ref={editMenuRef}>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={isPending}
                    aria-haspopup="menu"
                    aria-expanded={editMenuOpen}
                    onClick={() => setEditMenuOpen((v) => !v)}
                    // A member who can't direct-save still gets the same Edit
                    // menu; their Save lands as a proposal (see the Save button
                    // label below), so the tooltip names that outcome.
                    title={
                      canEditSelected
                        ? "Edit this slide — edit text, adjust an element, or edit HTML"
                        : "Edit this slide — your changes are proposed for a reviewer to approve"
                    }
                  >
                    <Pencil
                      aria-hidden
                      className={cn("h-3.5 w-3.5", !reviewMode && "hidden")}
                    />
                    <span className={cn(reviewMode && "hidden")}>Edit</span>
                    <ChevronDown aria-hidden className="h-3.5 w-3.5" />
                  </Button>
                  {editMenuOpen ? (
                    <MenuSurface
                      onClose={() => setEditMenuOpen(false)}
                      className="absolute right-0 top-full z-40 mt-1 min-w-[230px] overflow-hidden rounded-[8px] border border-border bg-card shadow-lg"
                    >
                      {selected?.is_drawn ? (
                        <button
                          role="menuitem"
                          type="button"
                          onClick={() => {
                            setEditMenuOpen(false);
                            if (selected) openDrawEdit(selected);
                          }}
                          className="flex w-full items-center gap-2 border-b border-border px-3 py-2 text-left text-xs text-foreground transition-colors hover:bg-muted"
                        >
                          <Pencil aria-hidden className="h-3.5 w-3.5 text-[color:var(--accent)]" />
                          <span>Edit drawing</span>
                        </button>
                      ) : (
                        // Draw over a NORMAL slide (a whole-slide drawing is edited
                        // via "Edit drawing" above, so this is offered only when
                        // the slide isn't itself a drawing).
                        <button
                          role="menuitem"
                          type="button"
                          onClick={() => {
                            setEditMenuOpen(false);
                            if (selected) openDrawOverlay(selected);
                          }}
                          className="flex w-full items-center gap-2 border-b border-border px-3 py-2 text-left text-xs text-foreground transition-colors hover:bg-muted"
                        >
                          <Pencil aria-hidden className="h-3.5 w-3.5 text-[color:var(--accent)]" />
                          <span>{selected?.has_overlay ? "Edit annotation" : "Draw over slide"}</span>
                        </button>
                      )}
                      <button
                        role="menuitem"
                        type="button"
                        onClick={() => {
                          setEditMenuOpen(false);
                          enterVisualEdit();
                        }}
                        className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-foreground transition-colors hover:bg-muted"
                      >
                        <Pencil aria-hidden className="h-3.5 w-3.5 text-muted-foreground" />
                        <span>Edit text on slide</span>
                      </button>
                      <button
                        role="menuitem"
                        type="button"
                        onClick={() => {
                          setEditMenuOpen(false);
                          enterInspect();
                        }}
                        className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-foreground transition-colors hover:bg-muted"
                      >
                        <SlidersHorizontal aria-hidden className="h-3.5 w-3.5 text-muted-foreground" />
                        <span>Adjust an element</span>
                      </button>
                      <button
                        role="menuitem"
                        type="button"
                        onClick={() => {
                          setEditMenuOpen(false);
                          enterCodeEdit();
                        }}
                        className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-foreground transition-colors hover:bg-muted"
                      >
                        <Code2 aria-hidden className="h-3.5 w-3.5 text-muted-foreground" />
                        <span>Edit slide HTML</span>
                      </button>
                    </MenuSurface>
                  ) : null}
                </div>
              ) : null
            ) : null}

            {/* While editing, the Edit ▾ slot becomes Save / Cancel. */}
            {editMode !== "none" ? (
              <div className="flex items-center gap-1.5">
                {editMode === "visual" ? (
                  <span className="hidden text-[11px] text-muted-foreground md:inline">
                    Click text on the slide to edit
                  </span>
                ) : editMode === "inspect" ? (
                  <span className="hidden text-[11px] text-muted-foreground md:inline">
                    {inspectTextEditing
                      ? "Editing text — Enter or Esc to finish"
                      : inspectSel
                        ? "Adjust or double-click to edit text, then Save"
                        : "Click an element on the slide"}
                  </span>
                ) : null}
                <Button
                  type="button"
                  size="sm"
                  disabled={editSaving || codeLoading}
                  onClick={
                    editMode === "visual"
                      ? requestSaveVisual
                      : editMode === "inspect"
                        ? requestSaveInspect
                        : saveCodeEdit
                  }
                  // The label names the OUTCOME: a direct editor's Save commits
                  // a new version; a member's "Propose change" lands a pending
                  // proposal for a reviewer. Keyed on the editing slide's direct
                  // rights (selection is pinned while editing, so this matches
                  // canEditSelected); falls back to canEditSelected when the
                  // editing target isn't found.
                  title={
                    editingProposes
                      ? "Propose this change — a reviewer approves it before it goes live"
                      : "Save your changes (creates a new version)"
                  }
                >
                  <Check aria-hidden className="h-3.5 w-3.5" />
                  {editSaving
                    ? editingProposes
                      ? "Proposing…"
                      : "Saving…"
                    : editingProposes
                      ? "Propose change"
                      : "Save"}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={editSaving}
                  onClick={cancelEdit}
                  title="Discard changes"
                >
                  <X aria-hidden className="h-3.5 w-3.5" />
                  <span className="hidden sm:inline">Cancel</span>
                </Button>
              </div>
            ) : null}

            {/* Comment toggle. When armed, becomes a high-contrast blue
             * pill with a 2px copper top-bar slot indicator — visibly
             * different from the dark Export pill. The unresolved badge here
             * is the ONLY place the open-comment count appears. In review
             * mode the label collapses to the glyph; tooltip keeps it. */}
            <div className="relative">
              {commentMode ? (
                <span
                  aria-hidden
                  className="pointer-events-none absolute inset-x-1 -top-[3px] h-[2px] rounded-full bg-[color:var(--accent-warm)]"
                />
              ) : null}
              <Button
                type="button"
                variant={commentMode ? "default" : "ghost"}
                onClick={() => {
                  setCommentMode((m) => !m);
                  setActiveThreadId(null);
                }}
                title={commentMode ? "Exit comment mode (Esc)" : "Drop a comment on the slide"}
                aria-label={commentMode ? "Exit comment mode" : "Comment"}
                className={
                  commentMode
                    ? "bg-[color:var(--accent)] text-white hover:bg-[color:var(--accent-dim)]"
                    : undefined
                }
              >
                <MessageSquare
                  aria-hidden
                  className={cn("h-3.5 w-3.5", !reviewMode && "hidden")}
                />
                <span className={cn(reviewMode && "hidden")}>
                  {commentMode ? "Exit comments" : "Comment"}
                </span>
                {unresolvedCount > 0 && !commentMode ? (
                  <span className="ml-1 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-[color:var(--accent)] px-1 text-[10px] font-semibold text-white">
                    {unresolvedCount}
                  </span>
                ) : null}
              </Button>
            </div>

            {/* Passive lock pill — information, not a mode control; visible
             * in both preview and review modes. Claiming/releasing moved to
             * the ⋯ menu; force-release stays inline for admins. */}
            {selected && hasActiveLock ? (
              lockedByMe ? (
                /* You hold the lock — semantically "you're editing" =
                 * collaboration/human signal. Blue, not amber. Amber is
                 * reserved for stale/conflict states. */
                <div
                  className="flex min-w-0 items-center gap-2 rounded-[8px] border border-[color:var(--accent)]/30 bg-[color:var(--accent-wash)] px-2.5 py-1 text-[11px] text-[color:var(--accent-dim)]"
                  title={`Editing — expires ${relativeDate(selected.lock!.expires_at)}`}
                >
                  <span className="font-medium">Editing</span>
                  {lockCountdownLabel ? (
                    // Lock soft-expires after 15 min; surfacing a live
                    // countdown lets the user re-claim before silently
                    // losing their hold. Mono digits keep the label
                    // stable as the seconds roll.
                    <span className="font-machine text-[10px] text-[color:var(--accent-dim)]/80 tabular-nums">
                      {lockCountdownLabel}
                    </span>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => handleRelease(selected)}
                    disabled={isPending}
                    className="text-[color:var(--accent-dim)]/70 underline hover:text-[color:var(--accent-dim)] disabled:opacity-50"
                  >
                    Release
                  </button>
                </div>
              ) : (
                (() => {
                  const lockerLabel =
                    selected.lock && (selected.lock.user_name || selected.lock.user_email)
                      ? displayName({
                          name: selected.lock.user_name,
                          email: selected.lock.user_email ?? "",
                        })
                      : null;
                  const agentHolds = selected.lock?.locked_by_kind === "agent";
                  return (
                    /* Locked by someone else. Agent → copper; human → blue.
                     * Either way, no amber — amber is for conflict only. */
                    <div
                      className={cn(
                        // min-w-0 + truncation on the label below so a long
                        // holder name can shrink instead of pushing the
                        // toolbar past a 390px viewport edge.
                        "flex min-w-0 items-center gap-2 rounded-[8px] border px-2.5 py-1 text-[11px]",
                        agentHolds
                          ? "border-[color:var(--accent-warm)]/30 bg-[color:var(--accent-warm)]/10 text-[color:var(--copper-deep)]"
                          : "border-[color:var(--accent)]/30 bg-[color:var(--accent-wash)] text-[color:var(--accent-dim)]",
                      )}
                      title={`Held by ${lockerLabel ?? (agentHolds ? "an agent" : "another user")} until ${relativeDate(selected.lock!.expires_at)}`}
                    >
                      <span className="min-w-0 truncate">
                        Locked by {agentHolds ? "an agent" : lockerLabel ?? "another user"}
                      </span>
                      {canForceRelease ? (
                        <button
                          type="button"
                          onClick={() => handleForceRelease(selected)}
                          disabled={isPending}
                          className={cn(
                            "underline disabled:opacity-50",
                            agentHolds
                              ? "text-[color:var(--copper-deep)]/70 hover:text-[color:var(--copper-deep)]"
                              : "text-[color:var(--accent-dim)]/70 hover:text-[color:var(--accent-dim)]",
                          )}
                        >
                          Force release
                        </button>
                      ) : null}
                    </div>
                  );
                })()
              )
            ) : null}

            {/* Mobile/tablet "Activity" trigger — opens the right rail
             * (review + comments) as a slide-over sheet. Only rendered
             * below lg since the rail is permanently visible at and above
             * that breakpoint. Badges ONLY the pending-proposal count
             * (copper — decisions), not comments: one number, one meaning. */}
            <Button
              type="button"
              variant="ghost"
              onClick={() => setMobileRailOpen(true)}
              className="lg:hidden"
              aria-label={`Activity${deckPendingCount > 0 ? ` — ${deckPendingCount} pending` : ""}`}
            >
              Activity
              {deckPendingCount > 0 ? (
                <span className="font-machine ml-1 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-[color:var(--accent-warm)]/15 px-1 text-[10px] font-semibold text-[color:var(--accent-warm)] ring-1 ring-[color:var(--accent-warm)]/40">
                  {deckPendingCount}
                </span>
              ) : null}
            </Button>

            {/* ⋯ overflow — the rare/expert acts, in fixed order: claim or
             * release, refresh, copy link, Claude prompt, snapshot, history,
             * shortcuts. */}
            <div className="relative" ref={shareMenuRef}>
              <button
                type="button"
                aria-label="More — claim, refresh, copy link, snapshot, history, shortcuts"
                aria-haspopup="menu"
                aria-expanded={shareMenuOpen}
                onClick={() => setShareMenuOpen((v) => !v)}
                className="inline-flex h-9 w-9 items-center justify-center rounded-[8px] text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <MoreHorizontal aria-hidden className="h-4 w-4" />
              </button>
              {shareMenuOpen ? (
                <MenuSurface
                  onClose={() => setShareMenuOpen(false)}
                  className="absolute right-0 top-full z-40 mt-1 min-w-[200px] overflow-hidden rounded-[8px] border border-border bg-card shadow-lg"
                >
                  {/* Claiming without editing is a rare, expert act (Edit ▾
                   * auto-acquires the lock); release mirrors it when you hold
                   * the lock. Locked-by-someone-else shows neither — the
                   * passive pill (+ admin force-release) covers that. */}
                  {selected && !hasActiveLock ? (
                    <button
                      role="menuitem"
                      type="button"
                      onClick={() => {
                        setShareMenuOpen(false);
                        handleLock(selected);
                      }}
                      className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-foreground transition-colors hover:bg-muted"
                    >
                      <Lock aria-hidden className="h-3.5 w-3.5 text-muted-foreground" />
                      <span>Claim slide (15 min)</span>
                    </button>
                  ) : null}
                  {selected && lockedByMe ? (
                    <button
                      role="menuitem"
                      type="button"
                      onClick={() => {
                        setShareMenuOpen(false);
                        handleRelease(selected);
                      }}
                      className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-foreground transition-colors hover:bg-muted"
                    >
                      <Unlock aria-hidden className="h-3.5 w-3.5 text-muted-foreground" />
                      <span>Release slide</span>
                    </button>
                  ) : null}
                  <button
                    role="menuitem"
                    type="button"
                    onClick={() => {
                      setShareMenuOpen(false);
                      refreshPreview();
                    }}
                    className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-foreground transition-colors hover:bg-muted"
                  >
                    <RefreshCw aria-hidden className="h-3.5 w-3.5 text-muted-foreground" />
                    <span>Refresh</span>
                  </button>
                  <button
                    role="menuitem"
                    type="button"
                    onClick={() => {
                      setShareMenuOpen(false);
                      handleCopyLink();
                    }}
                    className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-foreground transition-colors hover:bg-muted"
                  >
                    <Copy aria-hidden className="h-3.5 w-3.5 text-muted-foreground" />
                    <span>Copy link</span>
                  </button>
                  <button
                    role="menuitem"
                    type="button"
                    onClick={() => {
                      setShareMenuOpen(false);
                      handleCopyPrompt();
                    }}
                    className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-foreground transition-colors hover:bg-muted"
                  >
                    <Sparkles aria-hidden className="h-3.5 w-3.5 text-muted-foreground" />
                    <span>Copy prompt for agent</span>
                  </button>
                  <button
                    role="menuitem"
                    type="button"
                    onClick={() => {
                      setShareMenuOpen(false);
                      setSnapshotOpen(true);
                    }}
                    className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-foreground transition-colors hover:bg-muted"
                  >
                    <Camera aria-hidden className="h-3.5 w-3.5 text-muted-foreground" />
                    <span>Save snapshot</span>
                  </button>
                  <Link
                    role="menuitem"
                    href={`/canvases/${deck.id}/history`}
                    onClick={() => setShareMenuOpen(false)}
                    className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-foreground transition-colors hover:bg-muted"
                  >
                    <HistoryIcon aria-hidden className="h-3.5 w-3.5 text-muted-foreground" />
                    <span>History</span>
                  </Link>
                  <button
                    role="menuitem"
                    type="button"
                    onClick={() => {
                      setShareMenuOpen(false);
                      setShortcutsOpen(true);
                    }}
                    className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-foreground transition-colors hover:bg-muted"
                  >
                    <Keyboard aria-hidden className="h-3.5 w-3.5 text-muted-foreground" />
                    <span>Keyboard shortcuts</span>
                  </button>
                </MenuSurface>
              ) : null}
            </div>

            {/* The one divider — before the output pair. Hidden below sm so
             * the condensed mobile toolbar doesn't carry stray hairlines. */}
            <span aria-hidden className="hidden h-6 w-px bg-border sm:block" />

            {/* Output actions: Present (view) + Export (ship) */}
            <Button asChild variant="outline">
              <Link
                href={`/canvases/${deck.id}/present`}
                title="Present full screen (P)"
                aria-label="Present full screen"
              >
                <Play aria-hidden className="h-4 w-4" />
                {/* Icon-only on phones — the Play glyph is self-explanatory
                 * and dropping the label keeps the toolbar to two rows. */}
                <span className="hidden sm:inline">Present</span>
              </Link>
            </Button>
            <div className="relative" ref={exportMenuRef}>
              <Button
                type="button"
                aria-haspopup="menu"
                aria-expanded={exportMenuOpen}
                disabled={pdfExporting || pptxExporting}
                onClick={() => setExportMenuOpen((v) => !v)}
              >
                {pdfExporting || pptxExporting ? "Exporting…" : "Export"}
                <ChevronDown aria-hidden className="h-3.5 w-3.5" />
              </Button>
              {exportMenuOpen ? (
                <MenuSurface
                  onClose={() => setExportMenuOpen(false)}
                  className="absolute right-0 top-full z-40 mt-1 min-w-[180px] overflow-hidden rounded-[8px] border border-border bg-card shadow-lg"
                >
                  {/* The step in front of shipping: render + audit the deck
                   * for clipped text / dead images / JS errors. Soft — it
                   * informs, never blocks the formats below. */}
                  <button
                    role="menuitem"
                    type="button"
                    onClick={() => {
                      setExportMenuOpen(false);
                      setPreflightOpen(true);
                    }}
                    className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-foreground transition-colors hover:bg-muted"
                  >
                    <ClipboardCheck aria-hidden className="h-3.5 w-3.5 text-muted-foreground" />
                    <span>Check deck first</span>
                  </button>
                  <div aria-hidden className="mx-2 my-1 h-px bg-border" />
                  <a
                    role="menuitem"
                    href={`/api/decks/${deck.id}/export`}
                    download
                    onClick={() => setExportMenuOpen(false)}
                    className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-foreground transition-colors hover:bg-muted"
                  >
                    <Code2 aria-hidden className="h-3.5 w-3.5 text-muted-foreground" />
                    <span>HTML file</span>
                  </a>
                  <button
                    role="menuitem"
                    type="button"
                    onClick={() => {
                      setExportMenuOpen(false);
                      void handleExportPdf();
                    }}
                    className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-foreground transition-colors hover:bg-muted"
                  >
                    <FileDown aria-hidden className="h-3.5 w-3.5 text-muted-foreground" />
                    <span>PDF</span>
                  </button>
                  <button
                    role="menuitem"
                    type="button"
                    onClick={() => {
                      setExportMenuOpen(false);
                      void handleExportPptx();
                    }}
                    className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-foreground transition-colors hover:bg-muted"
                  >
                    <Presentation aria-hidden className="h-3.5 w-3.5 text-muted-foreground" />
                    <span>PowerPoint</span>
                  </button>
                </MenuSurface>
              ) : null}
            </div>
          </div>
        </div>
        {deckChipVisible ? (
          <ProposalChip
            proposals={chipProposals}
            activeProposalId={activeProposalId}
            onActivate={setActiveProposalId}
            onOpenFull={openSource}
            deckId={deck.id}
            variant="deck"
            permissionsById={permissionsById}
            stalenessById={stalenessById}
            strip={decisionStrip}
            onDecided={handleDecided}
            onUndo={undoDecision}
            compareAvailable={lensActive}
            compareActive={comparing}
            onToggleCompare={toggleCompare}
            selectedIds={selectedProposalIds}
            onToggleSelect={toggleProposalSelect}
            onApproveSelected={handleApproveSelected}
            selectedApprovableCount={selectedApprovable.length}
          />
        ) : null}
        {showFastLaneOffer &&
        !deck.agent_fast_lane_enabled &&
        canManageFastLane &&
        allowSelfApproval ? (
          <div className="mx-3 mb-2 flex flex-wrap items-center justify-between gap-3 rounded-[10px] border border-[color:var(--accent)]/40 bg-[color:var(--accent-wash)] px-3.5 py-2.5 sm:mx-6">
            <p className="min-w-0 flex-1 text-xs leading-relaxed text-foreground">
              You&apos;ve approved {FAST_LANE_OFFER_THRESHOLD} render-verified agent
              patches on this deck. Let them apply themselves after the agent
              renders and checks them? You can turn this off anytime in the deck
              menu.
            </p>
            <div className="flex shrink-0 items-center gap-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={dismissFastLaneOffer}
                disabled={isPending}
              >
                Not now
              </Button>
              <Button
                type="button"
                size="sm"
                onClick={acceptFastLaneOffer}
                disabled={isPending}
              >
                Trust verified patches
              </Button>
            </div>
          </div>
        ) : null}
        {/* Slide canvas. The outer div is padded so the atmosphere shows
         * around the framed slide; the inner .slide-preview-frame supplies
         * the rim, drop shadow, and rounded corners.
         *
         * Layout behaviour:
         *  - xl (≥1280px): preserve the original "fill the pane" behaviour
         *    (h-full w-full). The middle column there is shaped roughly
         *    16:9 by the surrounding rails so the deck content fits well.
         *  - <xl: switch to a centred 16:9 box (aspect-video w-full
         *    max-h-full). Without rails to balance the column, a tall
         *    narrow phone preview would otherwise stretch vertically and
         *    squish slide content; aspect-video keeps the deck legible
         *    and lets vertical space below the frame stay empty.
         * Padding is smaller at narrow widths so the frame can use as
         * much of the column as possible. */}
        <div className="relative flex flex-1 items-center justify-center px-3 pb-4 pt-3 sm:px-6 sm:pb-6 sm:pt-4 xl:block">
          <div
            ref={previewWrapRef}
            className="slide-preview-frame relative aspect-video max-h-full w-full xl:aspect-auto xl:h-full"
          >
            <iframe
              ref={iframeRef}
              key={previewKey}
              // BASE frame: always the CURRENT deck. Its src never swaps for a
              // compare, so it never reloads when a proposal toggles — the
              // reload "flash" the founder hit is gone by construction. This is
              // also the navigation + selection authority and the comment-bounds
              // source. Do NOT make this src proposal-aware again.
              src={srcReady ? baseSrc : undefined}
              // SECURITY: deck HTML is untrusted (imported wholesale / authored
              // by anyone's Claude). `allow-scripts` WITHOUT `allow-same-origin`
              // runs the deck's nav_js in an opaque origin, so it cannot read
              // the app's cookies/localStorage or reach window.parent's origin.
              // The postMessage nav protocol still works (it validates by
              // event.source, not origin). Do NOT add allow-same-origin — that
              // re-grants origin access and lets the frame remove its own
              // sandbox. Mirrors components/proposal-iframe.tsx.
              sandbox="allow-scripts"
              title="Deck preview"
              className="absolute inset-0 h-full w-full border-0 bg-white"
              onLoad={() => {
                setPreviewLoaded(true);
                // Re-fire the message after the iframe finishes loading; the
                // useEffect above only catches selection changes that happen
                // after mount, not the initial selection.
                if (targetPosition == null) return;
                iframeRef.current?.contentWindow?.postMessage(
                  { type: "canvas:navigate", position: targetPosition },
                  "*",
                );
              }}
            />
            {!previewLoaded ? (
              // Cold-start cover. The Vercel preview function returns 503 on a
              // cold hit (and a 200 a few hundred ms later once warm); without
              // this overlay the user sees a blank white pane for 2-5 seconds.
              // Mirrors the pattern in components/proposal-iframe.tsx.
              <div
                aria-hidden
                className="pointer-events-none absolute inset-0 z-[1] animate-pulse bg-muted/40"
              />
            ) : null}

            {/* Code view — raw-HTML editor overlay for the structural edits
             * the inline text editor can't make. Sits above the preview;
             * sourced from getSlideHtml and saved via the same
             * saveSlideHtmlDirect path (so it versions the slide too). */}
            {editMode === "code" ? (
              <div className="absolute inset-0 z-[6] flex flex-col bg-card">
                <div className="flex items-center justify-between border-b border-border px-3 py-2">
                  <span className="truncate text-xs font-medium text-foreground">
                    Editing HTML — {selected?.title || "slide"}
                  </span>
                  <span className="font-machine shrink-0 pl-2 text-[10px] text-muted-foreground tabular-nums">
                    {codeLoading ? "loading…" : `${codeDraft.length} chars`}
                  </span>
                </div>
                <textarea
                  value={codeDraft}
                  onChange={(e) => setCodeDraft(e.target.value)}
                  spellCheck={false}
                  disabled={codeLoading || editSaving}
                  autoFocus
                  className="h-full w-full flex-1 resize-none bg-card p-3 font-mono text-xs leading-relaxed text-foreground focus:outline-none disabled:opacity-60"
                  placeholder={'<section class="slide">…</section>'}
                />
              </div>
            ) : null}

            {/* Direct-manipulation inspector panel. Floats over the preview
             * while an element is selected in Adjust mode; every control posts
             * straight into the iframe (canvas:inspect-set / -nudge), so the
             * slide itself is the live preview. Keyed by inspectSeq so each
             * new selection remounts it with that element's snapshot. */}
            {editMode === "inspect" && inspectSel ? (
              <ElementInspector
                key={inspectSeq}
                descriptor={inspectSel.descriptor}
                snapshot={inspectSel.styles}
                textEditing={inspectTextEditing}
                onStyle={(styles) =>
                  iframeRef.current?.contentWindow?.postMessage(
                    { type: "canvas:inspect-set", styles },
                    "*",
                  )
                }
                onNudge={(dx, dy) =>
                  iframeRef.current?.contentWindow?.postMessage(
                    { type: "canvas:inspect-nudge", dx, dy },
                    "*",
                  )
                }
                onEditText={() =>
                  iframeRef.current?.contentWindow?.postMessage(
                    { type: "canvas:inspect-text" },
                    "*",
                  )
                }
                onSelectParent={() =>
                  iframeRef.current?.contentWindow?.postMessage(
                    { type: "canvas:inspect-parent" },
                    "*",
                  )
                }
                onDeselect={() => {
                  iframeRef.current?.contentWindow?.postMessage(
                    { type: "canvas:inspect-deselect" },
                    "*",
                  );
                  setInspectSel(null);
                  setInspectTextEditing(false);
                }}
              />
            ) : null}

            {/* PROPOSED overlay — the second warm frame (the Lens). It renders
             * the deck WITH the active proposal applied and is clipped from the
             * left by `reveal`, so dragging the seam / holding Alt wipes between
             * proposed (reveal 0) and current (reveal 1) with pure CSS — no src
             * swap, no reload. Kept pointer-events-none so comment-pin clicks
             * fall through to the overlay below. Fades in once loaded so a fresh
             * proposal doesn't flash a half-painted frame. */}
            {lensActive && proposedSrc ? (
              <div
                aria-hidden
                className="pointer-events-none absolute inset-0 z-[2] bg-white"
                style={{
                  clipPath: `inset(0 0 0 ${reveal * 100}%)`,
                  WebkitClipPath: `inset(0 0 0 ${reveal * 100}%)`,
                  opacity: proposedLoaded ? 1 : 0,
                  transition: wipeDragging
                    ? "opacity 180ms ease"
                    : "clip-path 180ms ease, -webkit-clip-path 180ms ease, opacity 180ms ease",
                }}
              >
                <iframe
                  ref={proposedIframeRef}
                  key={`proposed-${activeProposalId}-${previewKey}`}
                  src={srcReady ? proposedSrc : undefined}
                  // Same untrusted-content sandbox as the base frame.
                  sandbox="allow-scripts"
                  title="Proposed change preview"
                  className="absolute inset-0 h-full w-full border-0 bg-white"
                  onLoad={() => {
                    setProposedLoaded(true);
                    if (proposedTargetPosition == null) return;
                    proposedIframeRef.current?.contentWindow?.postMessage(
                      { type: "canvas:navigate", position: proposedTargetPosition },
                      "*",
                    );
                  }}
                />
              </div>
            ) : null}

            {/* The wipe SEAM — the visible before↔after affordance. Drag it to
             * scrub; Alt-hold drives the same `reveal` as a momentary peek.
             * Only shown when a proposed overlay exists. */}
            {lensActive ? (
              <div className="pointer-events-none absolute inset-0 z-[6]">
                <div
                  className="absolute inset-y-0"
                  style={{
                    left: `${reveal * 100}%`,
                    transform: "translateX(-50%)",
                    transition: wipeDragging ? "none" : "left 180ms ease",
                  }}
                >
                  <div className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-foreground/50" />
                  <button
                    type="button"
                    onPointerDown={onSeamPointerDown}
                    className="pointer-events-auto absolute top-1/2 left-1/2 flex h-7 w-7 -translate-x-1/2 -translate-y-1/2 cursor-ew-resize items-center justify-center rounded-full border border-border bg-card text-machine-copper shadow-md transition-colors hover:bg-muted"
                    aria-label="Drag to compare current and proposed"
                    title="Drag to wipe · hold Alt to peek current"
                  >
                    <span aria-hidden className="text-[11px] leading-none">
                      ⇆
                    </span>
                  </button>
                </div>
                {/* Orientation caption — which side is which. Pinned to the TOP
                    so it clears the deck's bottom nav chrome (arrows + dots +
                    position counter), which it used to overlap at bottom-2. */}
                <div className="absolute top-2 left-1/2 -translate-x-1/2 rounded-full border border-border bg-card/90 px-2.5 py-0.5 text-[10px] text-muted-foreground shadow-sm backdrop-blur-sm">
                  <span className={reveal > 0.5 ? "text-machine-copper" : ""}>
                    Current
                  </span>
                  <span className="mx-1.5 text-muted-foreground/50">|</span>
                  <span className={reveal <= 0.5 ? "text-machine-copper" : ""}>
                    Proposed
                  </span>
                </div>
              </div>
            ) : null}
            {slideChipVisible ? (
              <ProposalChip
                proposals={chipProposals}
                activeProposalId={activeProposalId}
                onActivate={setActiveProposalId}
                onOpenFull={openSource}
                deckId={deck.id}
                variant="slide"
                permissionsById={permissionsById}
                stalenessById={stalenessById}
                strip={decisionStrip}
                onDecided={handleDecided}
                onUndo={undoDecision}
                compareAvailable={lensActive}
                compareActive={comparing}
                onToggleCompare={toggleCompare}
                selectedIds={selectedProposalIds}
                onToggleSelect={toggleProposalSelect}
                onApproveSelected={handleApproveSelected}
                selectedApprovableCount={selectedApprovable.length}
              />
            ) : null}
            {/* Standalone decision strip — after the last pending resolves,
             * both chips unmount on refresh; the strip (and its Undo) must
             * survive that, so it floats here in the slide-chip slot until
             * it times out or Undo runs. */}
            {decisionStrip && !slideChipVisible && !deckChipVisible ? (
              <div className="pointer-events-auto absolute top-3 right-3 z-20 w-[min(340px,calc(100vw-1.5rem))] max-w-[92%] overflow-hidden rounded-[14px] border border-border bg-card/95 shadow-lg backdrop-blur-sm">
                <ResultStripView
                  strip={decisionStrip}
                  deckId={deck.id}
                  onUndo={undoDecision}
                />
              </div>
            ) : null}
            {selected ? (
              <SlideCommentsOverlay
                // Remount per slide so `bounds`, `pending`, `draft`, and other
                // local overlay state can't leak into the next slide. Carousel-style
                // decks lay slides out as a horizontal flex strip, so each slide's
                // getBoundingClientRect is offset by N*100vw — reusing the
                // previous slide's cached rect paints new pins at the old screen
                // coordinates until the iframe re-broadcasts bounds, which reads
                // as "old pins stuck on the new slide".
                key={selected.id}
                deckId={deck.id}
                slideId={selected.id}
                slidePosition={selected.position}
                iframeRef={iframeRef}
                comments={commentsForSlide}
                commentMode={commentMode}
                activeThreadId={activeThreadId}
                onActiveThreadChange={setActiveThreadId}
                onExitCommentMode={() => setCommentMode(false)}
                currentUserId={currentUserId}
                canModerate={canModerateComments}
                showResolved={showResolved}
                currentUserEmail={currentUserEmail}
                currentUserName={currentUserName}
                members={members}
              />
            ) : null}
            {/* Element-pick confirmation — anchored ON the element the user
             * just clicked (wrapper-relative coords from the iframe's rect,
             * see pickPopover). The user's eyes are on the element they
             * picked, not the sidebar; the next step ("paste into Claude
             * Code") reads from where they're already looking. Click-through
             * (pointer-events-none) + 7s self-dismiss. */}
            {pickPopover ? (
              <div
                role="status"
                className={cn(
                  "pointer-events-none absolute z-20 w-max max-w-[280px] -translate-x-1/2 rounded-lg border bg-card/95 px-3 py-2 text-xs leading-snug shadow-lg backdrop-blur-sm",
                  pickPopover.above && "-translate-y-full",
                  pickPopover.error
                    ? "border-destructive/50 text-destructive"
                    : "border-border text-foreground",
                )}
                style={{ left: pickPopover.x, top: pickPopover.y }}
              >
                <span className="flex items-start gap-1.5">
                  {!pickPopover.error ? (
                    <Check
                      aria-hidden
                      className="mt-0.5 h-3.5 w-3.5 shrink-0 text-machine-copper"
                    />
                  ) : null}
                  <span>{pickPopover.text}</span>
                </span>
              </div>
            ) : null}
            {/* <lg feedback pill — transient mirror of the rail's feedback
             * line (see mobileFeedbackShown above). Seam-caption styling;
             * sits above the caption/DeckChrome band so both stay legible. */}
            {mobileFeedbackShown && feedback ? (
              <div
                role="status"
                className="pointer-events-none absolute bottom-10 left-1/2 z-[7] max-w-[85%] -translate-x-1/2 truncate rounded-full border border-border bg-card/90 px-2.5 py-0.5 text-[10px] text-muted-foreground shadow-sm backdrop-blur-sm lg:hidden"
              >
                {feedback}
              </div>
            ) : null}
            {isFreshDeck ? (
              <EmptyDeckCta
                hasActiveMcpToken={hasActiveMcpToken || openRouterReady}
                onCopyPrompt={handleCopyPrompt}
                promptCopied={promptCopied}
                onOpenAssistant={openAssistant}
              />
            ) : null}
            <DeckChrome
              slides={slides}
              selectedId={selectedId}
              onSelect={setSelectedId}
            />
          </div>
        </div>
      </section>

      {/* Right — sidebar (xl/lg only). Below lg the rail collapses to the
       * "Activity" tab button in the toolbar and opens as a slide-over
       * sheet (mobile/tablet at right; bottom on <sm phones). The lg
       * width is narrower (~288px) than the xl width (~320px) to give the
       * preview more breathing room at laptop widths. */}
      <aside className="hidden shrink-0 flex-col border-l border-border bg-card lg:flex lg:w-72 xl:w-80">
        {/* Activity expands automatically for review work. In create mode its
            compact header leaves the full rail to the agent conversation. */}
        <div
          className={cn(
            "flex flex-col",
            activityOpen
              ? assistantOpen
                ? "max-h-[52%] shrink-0"
                : "min-h-0 flex-1"
              : "shrink-0",
          )}
        >
          <button
            type="button"
            onClick={() => setActivityOpen((value) => !value)}
            aria-expanded={activityOpen}
            className="flex shrink-0 items-center justify-between border-b border-border px-4 py-2.5 text-left transition-colors hover:bg-muted/50"
          >
            <span className="flex items-center gap-2 text-xs font-semibold text-foreground">
              <MessageSquare aria-hidden className="h-4 w-4 text-muted-foreground" />
              Activity
              {deckPendingCount > 0 ? (
                <span className="font-machine inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-[color:var(--accent-warm)]/15 px-1.5 text-[10px] font-semibold text-[color:var(--accent-warm)]">
                  {deckPendingCount}
                </span>
              ) : null}
            </span>
            <ChevronDown
              aria-hidden
              className={cn(
                "h-4 w-4 text-muted-foreground transition-transform",
                !activityOpen && "-rotate-90",
              )}
            />
          </button>
          {activityOpen ? (
            <div className="min-h-0 overflow-y-auto">
              {renderRightRailBody("rail")}
            </div>
          ) : null}
        </div>
        <div
          className={cn(
            "flex flex-col border-t-2 border-border",
            assistantOpen ? "min-h-0 flex-1" : "shrink-0",
          )}
        >
          <button
            type="button"
            onClick={() => setAssistantOpen((v) => !v)}
            aria-expanded={assistantOpen}
            className="flex shrink-0 items-center justify-between px-4 py-2.5 text-left transition-colors hover:bg-muted/50"
            title={assistantOpen ? "Collapse Ask agent" : "Expand Ask agent"}
          >
            <span className="flex items-center gap-2 text-xs font-semibold text-foreground">
              <Sparkles aria-hidden className="h-4 w-4 text-[color:var(--accent)]" />
              Ask agent
            </span>
            <ChevronDown
              aria-hidden
              className={cn(
                "h-4 w-4 text-muted-foreground transition-transform",
                !assistantOpen && "-rotate-90",
              )}
            />
          </button>
          {assistantOpen ? (
            <AssistantPanel
              inline
              deckId={deck.id}
              currentUserId={currentUserId}
              hasActiveMcpToken={hasActiveMcpToken}
              openRouterReady={openRouterReady}
              openRouterModel={openRouterModel}
              initialRuntime={initialAssistantRuntime}
              brandBlurb={brandBlurb}
              pickedTarget={assistantTarget}
              currentSlide={
                selected
                  ? {
                      slideId: selected.id,
                      slidePosition: selected.position,
                      slideTitle: selected.title,
                    }
                  : null
              }
              pickNonce={assistantPickNonce}
              onClearTarget={() => setAssistantTarget(null)}
              onPickElement={
                selected && editMode === "none" ? startElementPick : undefined
              }
              picking={pickingPrompt}
              onCancelPick={cancelElementPick}
              slideLabel={slideLabel}
              onRevealSlide={setSelectedId}
              onCompare={compareProposal}
              activePreviewProposalId={activeProposalId}
              comparing={comparing}
            />
          ) : null}
        </div>
      </aside>

      {/* Mobile / tablet slide-list drawer. Mirrors the same Sheet primitive
       * pattern used by ProposalSheet — full-bleed scrim + side-anchored
       * panel — but lives inline here because the slide list is so tightly
       * coupled to deck-workspace state (selection, lock badges, comment
       * counts) that lifting it out would shred the closure. Hidden at
       * lg+ via the `lg:hidden` outer class so it can never accidentally
       * paint on top of the permanent rail. */}
      {mobileSlideListOpen ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Slide list"
          className="fixed inset-0 z-50 lg:hidden"
        >
          <button
            type="button"
            aria-label="Close slide list"
            onClick={() => setMobileSlideListOpen(false)}
            className="absolute inset-0 bg-foreground/40 backdrop-blur-[1px]"
          />
          <aside className="absolute inset-y-0 left-0 flex w-[min(85vw,320px)] flex-col border-r border-border bg-card shadow-2xl">
            {renderSlideListBody("drawer")}
          </aside>
        </div>
      ) : null}

      {/* Mobile / tablet activity sheet (comments + proposals). Right-side
       * anchored at sm+ to match desktop muscle memory; bottom-sheet on
       * pure mobile (<640px / sm) because the right edge there is too
       * close to the system swipe-back gesture and the bottom anchor is
       * a more reachable thumb target. Same z-index as the slide drawer;
       * the Esc handler closes whichever overlay was opened last. */}
      {mobileRailOpen ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Comments and proposals"
          className="fixed inset-0 z-50 lg:hidden"
        >
          <button
            type="button"
            aria-label="Close activity panel"
            onClick={() => setMobileRailOpen(false)}
            className="absolute inset-0 bg-foreground/40 backdrop-blur-[1px]"
          />
          <aside
            className={cn(
              // Below sm: bottom sheet, capped at 80dvh (dynamic viewport so
              // mobile Safari's URL bar doesn't push the cap off-screen) and
              // pb-safe so the last comment/proposal clears the home indicator.
              // sm and up: side sheet anchored right, capped at 360px (matches
              // the lg xl rail width range).
              "absolute flex flex-col overflow-y-auto border-border bg-card shadow-2xl pb-safe",
              "inset-x-0 bottom-0 max-h-[80dvh] rounded-t-2xl border-t",
              "sm:inset-y-0 sm:right-0 sm:bottom-auto sm:max-h-none sm:w-[min(85vw,360px)] sm:rounded-none sm:border-l sm:border-t-0",
            )}
          >
            {renderRightRailBody("sheet")}
          </aside>
        </div>
      ) : null}

      {exportJob ? (
        <div
          role={exportJob.status === "error" ? "alert" : "status"}
          aria-live="polite"
          className="fixed bottom-5 right-5 z-[70] w-[min(360px,calc(100vw-2.5rem))] rounded-[12px] border border-border bg-card p-4 shadow-2xl"
        >
          <div className="flex items-start gap-3">
            <span
              className={cn(
                "mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full",
                exportJob.status === "error"
                  ? "bg-destructive/10 text-destructive"
                  : exportJob.status === "success"
                    ? "bg-emerald-500/10 text-emerald-600"
                    : "bg-[color:var(--accent-wash)] text-[color:var(--accent)]",
              )}
            >
              {exportJob.status === "success" ? (
                <Check aria-hidden className="h-4 w-4" />
              ) : exportJob.status === "error" ? (
                <X aria-hidden className="h-4 w-4" />
              ) : (
                <RefreshCw aria-hidden className="h-4 w-4 animate-spin" />
              )}
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-foreground">
                {exportJob.status === "success"
                  ? `${exportJob.format} downloaded`
                  : exportJob.status === "error"
                    ? `${exportJob.format} export failed`
                    : exportElapsed < 2
                      ? "Preparing deck"
                      : exportElapsed < 10
                        ? "Rendering slides"
                        : "Packaging file"}
              </p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {exportJob.status === "running"
                  ? `${exportJob.format} · ${exportElapsed}s elapsed`
                  : exportJob.status === "error"
                    ? exportJob.error
                    : "The file is ready in your downloads."}
              </p>
              {exportJob.status === "error" ? (
                <div className="mt-3 flex items-center gap-2">
                  <Button
                    type="button"
                    size="sm"
                    onClick={() =>
                      void (exportJob.format === "PDF"
                        ? handleExportPdf()
                        : handleExportPptx())
                    }
                  >
                    Retry
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => setExportJob(null)}
                  >
                    Dismiss
                  </Button>
                </div>
              ) : null}
            </div>
            {exportJob.status === "success" ? (
              <button
                type="button"
                aria-label="Dismiss export status"
                onClick={() => setExportJob(null)}
                className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <X aria-hidden className="h-4 w-4" />
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

      <CopySlideDialog
        open={copySlideOpen}
        deckId={deck.id}
        onClose={() => setCopySlideOpen(false)}
        onCopied={(slideId) => {
          setCopySlideOpen(false);
          setSelectedId(slideId);
          setFeedback("Slide copied — its styles came along; the theme is this deck's.");
          router.refresh();
        }}
      />

      <PreflightDialog
        open={preflightOpen}
        deckId={deck.id}
        onClose={() => setPreflightOpen(false)}
        slideTitleByPosition={
          new Map(slides.map((s) => [s.position, s.title || ""]))
        }
        onGoToSlide={(position) => {
          const target = slides.find((s) => s.position === position);
          if (target) setSelectedId(target.id);
          setPreflightOpen(false);
        }}
      />

      <SnapshotDialog
        open={snapshotOpen}
        deckId={deck.id}
        onClose={() => setSnapshotOpen(false)}
        onSuccess={() => {
          setSnapshotOpen(false);
          setFeedback("Snapshot saved.");
          // Bumps the cached deck page so the History page sees the new
          // row next time it's visited.
          router.refresh();
        }}
      />

      <ProposalSheet
        editId={fullSheetId}
        deckId={deck.id}
        onClose={() => setFullSheetId(null)}
      />

      <ShareDeckDialog
        open={shareDialogOpen}
        deckId={deck.id}
        currentUserId={currentUserId}
        onClose={() => {
          setShareDialogOpen(false);
          // Server actions inside the dialog already revalidate the deck page,
          // but the visibility chip on the menu reads from `deck.visibility`
          // which is server-rendered — a router.refresh keeps it in sync after
          // a flip without forcing the user to navigate away.
          router.refresh();
        }}
      />

      <RenameDeckDialog
        open={renameOpen}
        currentTitle={deck.title}
        onClose={() => setRenameOpen(false)}
        onSubmit={(next) =>
          new Promise<void>((resolve) => {
            startTransition(async () => {
              const result = await renameDeck(deck.id, next);
              if (!result.ok) {
                setFeedback(`Rename failed: ${result.error}`);
              } else {
                router.refresh();
              }
              resolve();
            });
          })
        }
      />

      <ConfirmDialog
        open={deleteConfirmOpen}
        title="Delete deck?"
        body={`"${deck.title}" — all slides, versions, snapshots, and storage assets are removed. This cannot be undone.`}
        confirmLabel="Delete deck"
        destructive
        pending={isPending}
        onCancel={() => setDeleteConfirmOpen(false)}
        onConfirm={() => {
          setDeleteConfirmOpen(false);
          startTransition(async () => {
            const result = await deleteDeck(deck.id);
            if (!result.ok)
              setFeedback(`Delete failed: ${result.error}`);
            // On success the action redirects to /canvases.
          });
        }}
      />

      {/* The entry button is gated on canProposeSlideEdit, the client mirror
        * of the RPC's canvas_can_edit_deck gate — so everyone who can open
        * this dialog gets the DIRECT delete. (The old copy predicted the path
        * with canEditSelected, a per-slide CONTENT gate on the SELECTED slide
        * — the wrong predicate on the wrong slide.) In the rare corner where
        * the server still refuses (rights revoked mid-session), the action
        * falls back to a proposal and the toast says so. */}
      <ConfirmDialog
        open={deleteSlideTarget !== null}
        title="Delete this slide?"
        body={`"${deleteSlideTarget?.title || "Untitled slide"}" will be removed from the deck. You can restore it from a snapshot in History.`}
        confirmLabel="Delete slide"
        destructive
        pending={isPending}
        onCancel={() => setDeleteSlideTarget(null)}
        onConfirm={() => {
          const target = deleteSlideTarget;
          setDeleteSlideTarget(null);
          if (target) handleProposeDeleteSlide(target.id);
        }}
      />

      <ShortcutsDialog
        open={shortcutsOpen}
        onClose={() => setShortcutsOpen(false)}
      />

      {/* Mobile only: floating "Ask agent" launcher (ADR-0006/0010). On lg+ the
          assistant docks under Activity in the right rail instead, so there's
          one surface per breakpoint rather than a button overlapping the rail.
          A pinpoint (pickNonce) opens this slide-over automatically. */}
      <div className="lg:hidden">
        <AssistantPanel
          deckId={deck.id}
          currentUserId={currentUserId}
          hasActiveMcpToken={hasActiveMcpToken}
          openRouterReady={openRouterReady}
          openRouterModel={openRouterModel}
          initialRuntime={initialAssistantRuntime}
          brandBlurb={brandBlurb}
          pickedTarget={assistantTarget}
          currentSlide={
            selected
              ? {
                  slideId: selected.id,
                  slidePosition: selected.position,
                  slideTitle: selected.title,
                }
              : null
          }
          pickNonce={assistantPickNonce}
          onClearTarget={() => setAssistantTarget(null)}
          onPickElement={
            selected && editMode === "none" ? startElementPick : undefined
          }
          picking={pickingPrompt}
          onCancelPick={cancelElementPick}
          slideLabel={slideLabel}
          onRevealSlide={setSelectedId}
          onCompare={compareProposal}
          activePreviewProposalId={activeProposalId}
          comparing={comparing}
        />
      </div>

      {/* Excalidraw-style draw surface — opened from "Draw a slide" (new whole
          drawing), "Edit drawing" (existing drawn slide), or "Draw over slide"
          (an overlay layer on a normal slide). The first two save via the direct
          create / direct save paths; the overlay saves through the inline-edit
          gate. The result is always plain SVG in the slide body. */}
      {drawOpen ? (
        <DrawCanvas
          initialScene={drawScene}
          title={drawInitialTitle}
          saving={drawSaving}
          onSave={handleDrawSave}
          onCancel={() => {
            if (!drawSaving) setDrawOpen(false);
          }}
          overlay={drawOverlay}
          backdropSrc={drawBackdropSrc}
          saveLabel={drawOverlay ? "Save annotation" : "Add to deck"}
        />
      ) : null}
    </div>
  );
}

// Centered modal for renaming the deck. Same shape as SnapshotDialog: body
// scroll lock, Esc-to-close, autofocus, focus-restore. Submission is wrapped
// in a transition so the loading state mirrors the rest of the action UX.
function RenameDeckDialog({
  open,
  currentTitle,
  onClose,
  onSubmit,
}: {
  open: boolean;
  currentTitle: string;
  onClose: () => void;
  onSubmit: (next: string) => Promise<void>;
}) {
  const [value, setValue] = useState(currentTitle);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Reset + focus on open transition (matches SnapshotDialog).
  const [wasOpen, setWasOpen] = useState(open);
  if (wasOpen !== open) {
    setWasOpen(open);
    if (open) {
      setValue(currentTitle);
      setError(null);
    }
  }

  useEffect(() => {
    if (!open) return;
    const previouslyFocused =
      typeof document !== "undefined"
        ? (document.activeElement as HTMLElement | null)
        : null;
    inputRef.current?.focus();
    inputRef.current?.select();
    return () => {
      if (
        previouslyFocused &&
        previouslyFocused.isConnected &&
        typeof previouslyFocused.focus === "function"
      ) {
        previouslyFocused.focus();
      }
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open]);

  if (!open) return null;

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = value.trim();
    if (!trimmed) {
      setError("Title is required.");
      return;
    }
    if (trimmed === currentTitle) {
      onClose();
      return;
    }
    setError(null);
    setPending(true);
    try {
      await onSubmit(trimmed);
      onClose();
    } finally {
      setPending(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="rename-deck-title"
      className="fixed inset-0 z-50 flex items-center justify-center px-4"
    >
      <button
        type="button"
        aria-label="Close rename dialog"
        onClick={onClose}
        className="absolute inset-0 bg-foreground/40 backdrop-blur-[1px]"
      />
      <div className="relative w-full max-w-md rounded-[12px] border border-border bg-card shadow-2xl">
        <header className="border-b border-border px-5 py-4">
          <h2
            id="rename-deck-title"
            className="text-base font-semibold text-foreground"
          >
            Rename deck
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Updates the deck title across the editor, /canvases list, and the
            tab title. Slide content is untouched.
          </p>
        </header>
        <form onSubmit={handleSubmit} className="space-y-4 px-5 py-4">
          <div className="space-y-1.5">
            <label
              htmlFor="rename-deck-input"
              className="text-xs font-medium text-foreground"
            >
              Deck title
            </label>
            <Input
              id="rename-deck-input"
              ref={inputRef}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              maxLength={200}
              required
              disabled={pending}
            />
          </div>
          {error ? (
            <p
              role="alert"
              className="rounded-[6px] border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger-fg"
            >
              {error}
            </p>
          ) : null}
          <div className="flex items-center justify-end gap-2 pt-1">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onClose}
              disabled={pending}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              size="sm"
              disabled={pending || !value.trim()}
            >
              {pending ? "Saving…" : "Save"}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}

// Keyboard-shortcuts reference. Same modal shell as ConfirmDialog (backdrop +
// Esc-to-close + body-scroll-lock + focus restore); the body is a static
// key→action table surfacing shortcuts that already work but were previously
// undiscoverable.
function ShortcutsDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const closeRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const previouslyFocused =
      typeof document !== "undefined"
        ? (document.activeElement as HTMLElement | null)
        : null;
    closeRef.current?.focus();
    return () => {
      if (
        previouslyFocused &&
        previouslyFocused.isConnected &&
        typeof previouslyFocused.focus === "function"
      ) {
        previouslyFocused.focus();
      }
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open]);

  if (!open) return null;

  const rows: { keys: string[]; action: string }[] = [
    { keys: ["←", "→"], action: "Previous / next slide" },
    { keys: ["Space"], action: "Next slide" },
    { keys: ["Home", "End"], action: "First / last slide" },
    { keys: ["P"], action: "Present full screen" },
    { keys: ["J", "K"], action: "Next / previous proposal (also ] / [)" },
    { keys: ["A"], action: "Approve the active proposal" },
    { keys: ["R"], action: "Reject — opens the reason composer" },
    { keys: ["X"], action: "Quick reject, no reason" },
    { keys: ["U"], action: "Undo the last approve (while the strip shows)" },
    { keys: ["D"], action: "Open the full diff" },
    { keys: ["Alt", "(hold)"], action: "Peek current under a proposal" },
    { keys: ["Esc"], action: "Exit comment / pick mode, close dialogs" },
    { keys: ["?"], action: "Show this help" },
  ];

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="shortcuts-dialog-title"
      className="fixed inset-0 z-50 flex items-center justify-center px-4"
    >
      <button
        type="button"
        aria-label="Close shortcuts"
        onClick={onClose}
        className="absolute inset-0 bg-foreground/40 backdrop-blur-[1px]"
      />
      <div className="relative w-full max-w-md rounded-[12px] border border-border bg-card shadow-2xl">
        <header className="flex items-center justify-between border-b border-border px-5 py-4">
          <h2
            id="shortcuts-dialog-title"
            className="text-base font-semibold text-foreground"
          >
            Keyboard shortcuts
          </h2>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="inline-flex h-7 w-7 items-center justify-center rounded-[6px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span aria-hidden className="text-base leading-none">
              ×
            </span>
          </button>
        </header>
        <ul className="divide-y divide-border px-5 py-2">
          {rows.map((row) => (
            <li
              key={row.action}
              className="flex items-center justify-between gap-4 py-2.5"
            >
              <span className="text-sm text-foreground">{row.action}</span>
              <span className="flex shrink-0 items-center gap-1">
                {row.keys.map((k) => (
                  <kbd
                    key={k}
                    className="font-machine inline-flex h-6 min-w-6 items-center justify-center rounded-[6px] border border-border bg-muted px-1.5 text-[11px] text-muted-foreground"
                  >
                    {k}
                  </kbd>
                ))}
              </span>
            </li>
          ))}
        </ul>
        <footer className="border-t border-border px-5 py-3 text-[11px] text-muted-foreground">
          Editing can happen in any MCP-compatible agent — these shortcuts drive the
          preview, navigation, and review surfaces.
        </footer>
      </div>
    </div>
  );
}

// Empty-deck nudge. A fresh deck offers the shortest path first (the in-app
// conversation) and keeps the external-agent prompt one click away.
function EmptyDeckCta({
  hasActiveMcpToken,
  onCopyPrompt,
  promptCopied,
  onOpenAssistant,
}: {
  hasActiveMcpToken: boolean;
  onCopyPrompt: () => void;
  promptCopied: boolean;
  onOpenAssistant: () => void;
}) {
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-12 z-10 flex justify-center px-6">
      <div className="pointer-events-auto flex max-w-xl flex-col items-center gap-4 rounded-2xl border border-border bg-card/95 px-7 py-6 text-center shadow-lg backdrop-blur">
        {hasActiveMcpToken ? (
          <>
            <p className="text-sm text-muted-foreground">
              Start with the Canvas chat, or hand this deck to any connected
              MCP agent. Changes arrive here for review.
            </p>
            <div className="flex flex-wrap items-center justify-center gap-2">
              <button
                type="button"
                onClick={onOpenAssistant}
                className="inline-flex items-center gap-2 rounded-full bg-[color:var(--accent)] px-5 py-2 text-sm font-semibold text-white transition-colors hover:bg-[color:var(--accent-dim)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
              >
                <Sparkles aria-hidden className="h-4 w-4" />
                Start in Canvas
              </button>
              <button
                type="button"
                onClick={onCopyPrompt}
                className="inline-flex items-center gap-2 rounded-full border border-border bg-card px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <Copy aria-hidden className="h-4 w-4" />
                {promptCopied ? "Prompt copied" : "Copy prompt for an agent"}
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="text-sm text-muted-foreground">
              Connect the agent you already use, then draft slides in Canvas or
              from any MCP-compatible client.
            </p>
            <Link
              href="/settings/mcp"
              className="inline-flex items-center gap-2 rounded-full bg-[color:var(--accent)] px-5 py-2 text-sm font-semibold text-white transition-colors hover:bg-[color:var(--accent-dim)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              Connect an agent
            </Link>
          </>
        )}
      </div>
    </div>
  );
}

"use client";

// In-app assistant chatbox (see ADR-0006, ADR-0007).
//
// Renders in two shapes from one component:
//   • inline   — docked in the deck editor's right rail (desktop "Ask agent" tab)
//   • floating — a launcher + slide-over (mobile, where the rail is a bottom sheet)
//
// Either way it's a thin front-end: the user chooses the local `canvas-agent`
// bridge or their encrypted personal OpenRouter connection, and the prompt is
// queued with that immutable runtime. We render the thread live via Supabase
// Realtime (RLS scopes each user to their own rows). Proposed edits show up in
// the normal review rail for approval.
//
// A conversation is a `canvas_assistant_thread` (ADR-0007): the header switcher
// picks which one is active, "+ New" starts a fresh one (clean context — born on
// the first send, titled from it), and deleting drops a thread without touching
// the others. Each thread carries its own Claude session, so switching never
// drags one task's context into another.

import { useCallback, useEffect, useId, useMemo, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowUpRight,
  Check,
  ChevronDown,
  Crosshair,
  MessageSquare,
  Plus,
  Sparkles,
  Square,
  Trash2,
  TriangleAlert,
  Undo2,
  Wrench,
  X,
} from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { cn, relativeDate } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  sendAssistantMessage,
  deleteAssistantThread,
  cancelAssistantTurn,
  sweepAssistantTurns,
} from "./assistant-actions";
import {
  buildPickedPrompt,
  buildSlideContextPrompt,
  describeComposedPrompt,
  withBrandContext,
  type AssistantPickTarget,
  type AssistantSlideContext,
} from "./assistant-prompt";
import {
  applyVariant,
  approveProposal,
  rejectProposal,
  revertProposal,
  type ProposalActionResult,
} from "@/app/canvases/proposal-actions";
import { VariantGroupCard } from "./variant-group-card";
import {
  asProposalKind,
  LENS_KINDS,
  REVERTABLE_KINDS,
  type ProposalKind,
  type ProposalStatus,
} from "@/lib/canvas/proposal-types";

type MsgStatus =
  | "queued"
  | "running"
  | "streaming"
  | "complete"
  | "error"
  | "canceled";

type Msg = {
  id: string;
  role: "user" | "assistant";
  content: string;
  status: MsgStatus;
  error: string | null;
  created_at: string;
  updated_at: string;
  execution_runtime: "bridge" | "openrouter";
  provider_model: string | null;
  // The model's visible thinking stream (reasoning models over OpenRouter,
  // migration 0070). Streams in before any content — rendering it is what
  // keeps the panel alive through the reasoning phase instead of a dead
  // spinner. Null for user rows, bridge turns, and non-reasoning models.
  reasoning: string | null;
};

// One conversation in the switcher. title is null only for the blink before the
// first message lands; updated_at drives the most-recently-active ordering.
type Thread = {
  id: string;
  title: string | null;
  updated_at: string;
};

// A proposal the assistant produced during a turn (canvas_deck_edit linked by
// assistant_message_id, migration 0043). Surfaced inline under the reply bubble
// so the gate is one click away — Approve/Reject/Undo all run the SAME server
// actions the review chip uses (proposal-actions.ts), so there's no second
// approve code path (the UI-clarity one-act-one-path rule).
//
// `kind`/`status` reuse the canonical unions from proposal-types.ts (the DB
// `canvas_deck_edit.kind` / `canvas_edit_status` columns) so this view can't
// drift from the rail's. REVERTABLE_KINDS / LENS_KINDS live there too.
type AssistantProposal = {
  id: string;
  kind: ProposalKind;
  slide_id: string | null;
  status: ProposalStatus;
  rationale: string | null;
  created_at: string;
  assistant_message_id: string;
  // Non-null when this proposal is one of an A/B variant set (0066). Two or
  // more PENDING members of one group render as a single pick-one card.
  variant_group_id: string | null;
};

// The raw canvas_deck_edit row as Supabase returns it — `kind` is a bare string
// until narrowed through asProposalKind at the fetch boundary into the union.
type AssistantProposalRow = Omit<AssistantProposal, "kind"> & { kind: string };

// Short labels for non-slide kinds shown on the inline card (slide kinds use the
// deck's live slide label via the slideLabel prop instead).
const KIND_CARD_LABEL: Record<string, string> = {
  slide_edit: "Slide edit",
  slide_html: "Slide HTML",
  slide_styles: "Slide styles",
  slide_title: "Slide label",
  slide_create: "New slide",
  slide_reorder: "Reorder slides",
  slide_delete: "Delete slide",
  theme_css: "Theme CSS",
  nav_js: "Nav JS",
  deck_title: "Deck title",
};

// Map the stable error codes the server actions return to friendly text. Never
// surface a raw Postgres message; the action already logs that server-side.
function friendlyError(code: string): string {
  switch (code) {
    case "too_long":
      return "That message is too long.";
    case "openrouter_not_configured":
      return "Connect OpenRouter in Settings → Connections before using the API runtime.";
    case "rate_limited":
      return "Too many API turns started at once. Wait a moment and retry.";
    default:
      return "Something went wrong — please try again.";
  }
}

// The composer prompt builders (buildPickedPrompt / buildSlideContextPrompt) and
// their context types live in ./assistant-prompt now (pure + unit-tested).
// Re-exported here so deck-workspace keeps importing the types from this module.
export type { AssistantPickTarget, AssistantSlideContext } from "./assistant-prompt";

// If the newest prompt has sat unanswered this long, the bridge is probably not
// running — surface a hint instead of an indefinite spinner.
const BRIDGE_STALE_MS = 12_000;

export function AssistantPanel({
  deckId,
  currentUserId,
  hasActiveMcpToken,
  openRouterReady = false,
  openRouterModel = "openrouter/auto",
  initialRuntime = "bridge",
  inline = false,
  pickedTarget = null,
  pickNonce = 0,
  currentSlide = null,
  onClearTarget,
  onPickElement,
  picking = false,
  onCancelPick,
  slideLabel,
  onRevealSlide,
  onCompare,
  activePreviewProposalId = null,
  comparing = false,
  brandBlurb = null,
}: {
  deckId: string;
  currentUserId: string | null;
  hasActiveMcpToken: boolean;
  openRouterReady?: boolean;
  openRouterModel?: string;
  initialRuntime?: "bridge" | "openrouter";
  // Compact workspace-brand context (buildBrandBlurb) folded into every
  // outgoing turn via withBrandContext. Null = no brand kit configured.
  brandBlurb?: string | null;
  // inline: render as a rail-docked column (no launcher/overlay).
  inline?: boolean;
  // The element the user pinpointed in the preview, surfaced as a composer chip
  // (deck-workspace owns the pick; this just renders + sends it). pickNonce
  // bumps on every fresh pick so we can focus the composer (and open the
  // floating shape) even when the target object is reference-equal.
  pickedTarget?: AssistantPickTarget | null;
  pickNonce?: number;
  // The slide the user currently has selected in the editor (deck-workspace's
  // `selected`). When nothing is pinpointed we fold this into the queued prompt
  // so the agent knows which slide "this slide"/"here" refers to without the
  // user restating it. Null on an empty deck.
  currentSlide?: AssistantSlideContext | null;
  onClearTarget?: () => void;
  // Pinpoint lifecycle (deck-workspace owns the iframe pick). onPickElement
  // starts a pick; `picking` is true while one is in progress; onCancelPick
  // aborts it. The composer renders a "Point at an element" button when
  // onPickElement is supplied (a slide is selected and nothing else is being
  // edited) — this is the primary way to start a pinpoint.
  onPickElement?: () => void;
  picking?: boolean;
  onCancelPick?: () => void;
  // Resolve a slide id to its "Slide N — Title" label for the inline proposal
  // cards (deck-workspace owns the live slide list). Optional: cards fall back
  // to a kind label when absent.
  slideLabel?: (slideId: string | null) => string | null;
  // Select + scroll to a slide after an inline approval so the result shows in
  // place (Phase 3). deck-workspace wires this to its slide selection.
  onRevealSlide?: (slideId: string) => void;
  // Drive the preview's before↔after Lens from a card: first call shows the
  // proposed version, repeat calls toggle current↔proposed. deck-workspace owns
  // the wipe; non-lensable kinds fall back to the diff sheet there.
  onCompare?: (editId: string, slideId: string | null) => void;
  // Which proposal the preview is currently lensing, and whether the wipe is
  // pulled to "current" — so a card can show its Compare button's state.
  activePreviewProposalId?: string | null;
  comparing?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [assistantRuntime, setAssistantRuntime] = useState<
    "bridge" | "openrouter"
  >(
    initialRuntime === "openrouter" && openRouterReady
      ? "openrouter"
      : "bridge",
  );
  if (assistantRuntime === "openrouter" && !openRouterReady) {
    setAssistantRuntime("bridge");
  }
  // Both shapes are always mounted for responsiveness: the inline (rail) panel
  // lives in an `lg:flex` aside, the floating (mobile) panel in a `lg:hidden`
  // wrapper. At lg+ the floating wrapper is `display:none` but the component is
  // still mounted and its state still runs — so without this gate a pinpoint
  // (pickNonce) would `setOpen(true)` on the hidden desktop panel, taking it
  // active, opening a SECOND set of Realtime channels and re-running the
  // one-time auto-pick that races the visible inline panel. We mirror the
  // `lg:hidden` breakpoint (Tailwind lg = 1024px) here so the floating shape is
  // only ever active when it's actually the visible surface. inline ignores it.
  const [belowLg, setBelowLg] = useState(false);
  useEffect(() => {
    if (inline) return; // the rail panel doesn't gate on viewport width
    const mq = window.matchMedia("(max-width: 1023px)");
    const update = () => setBelowLg(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, [inline]);
  const [messages, setMessages] = useState<Msg[]>([]);
  // Whether the active thread's initial message load has resolved. Gates the
  // empty-state CTA so a populated thread shows a skeleton (not the first-run
  // "Try these" prompts) while it hydrates on switch (#1).
  const [hydrated, setHydrated] = useState(false);
  const [input, setInput] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);
  // Optimistic flag for the Stop button (ADR-0008): true from the click until the
  // turn actually leaves the in-flight set (the bridge settles it to 'canceled',
  // or it completes/errors in the same instant). Reset in render-phase below.
  const [stopping, setStopping] = useState(false);
  const [, startTransition] = useTransition();
  const router = useRouter();
  // Proposals the assistant produced this thread, grouped by the reply message
  // they're linked to (0043). proposalNonce forces a refetch after a card
  // action flips a status.
  const [proposalsByMsg, setProposalsByMsg] = useState<
    Map<string, AssistantProposal[]>
  >(new Map());
  const [proposalNonce, setProposalNonce] = useState(0);
  // Last time this user's local bridge polled (0044), in epoch ms — drives the
  // header presence dot. Null until the first heartbeat is seen.
  const [bridgeLastSeen, setBridgeLastSeen] = useState<number | null>(null);
  // Whether the initial presence read has resolved. We only surface the
  // "bridge offline, can't send" warning AFTER this is true, so the composer
  // doesn't flash a false offline state during the first load.
  const [bridgeChecked, setBridgeChecked] = useState(false);
  // The version the local bridge last reported (migration 0051); null = an older
  // bridge that doesn't send it. Surfaced in the presence-dot tooltip.
  const [bridgeVersion, setBridgeVersion] = useState<string | null>(null);
  const [bridgeProvider, setBridgeProvider] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // Both shapes (inline rail + floating sheet) are mounted at once for
  // responsiveness, and createClient() is a singleton — so two channels with
  // the same topic would be the SAME cached channel object, and the second
  // .on()-after-.subscribe() throws. A per-instance id keeps the topics
  // distinct. (RLS + the filter still scope each subscription to this user.)
  const channelId = useId().replace(/[^a-z0-9]/gi, "");

  // The user's conversations for this deck (switcher list) and which one is
  // active. activeThreadId === null is a fresh, not-yet-created conversation —
  // the thread row is born on the first send (so empty threads never persist).
  const [threads, setThreads] = useState<Thread[]>([]);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  // Which conversation's delete is awaiting confirmation in the switcher — a
  // two-step guard, since delete cascades the messages and there's no undo. The
  // popover toggle resets it, so a stale confirm never survives a reopen.
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  // Switching threads must never show the previous thread's messages. We wipe
  // during render on the id change (React's "adjust state on change" pattern,
  // like deck-workspace's lastSlideId) — not in the effect, which the
  // set-state-in-effect lint forbids; the effect only re-hydrates from the DB.
  const [lastThreadId, setLastThreadId] = useState<string | null>(activeThreadId);
  if (lastThreadId !== activeThreadId) {
    setLastThreadId(activeThreadId);
    setMessages([]);
    // The switched-in thread hasn't loaded yet — show the skeleton, not the CTA.
    setHydrated(false);
    // Drop the previous thread's proposal cards here (render-phase) so a switch
    // never shows them; the fetch effect re-hydrates for the new thread.
    setProposalsByMsg(new Map());
  }
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  // Have we resolved the initial active thread yet? A ref (not state) so the
  // one-time auto-pick in the loader doesn't fight a deliberate "+ New" (which
  // sets activeThreadId back to null) on later list refreshes.
  const pickedRef = useRef(false);
  // Synchronous double-send guard (a startTransition isPending flag propagates
  // too late to stop an Enter+click race — prod logged one prompt twice).
  const sendInFlightRef = useRef(false);

  // A fresh pinpoint (pickNonce bumps) should reveal the composer. Opening the
  // floating shape is a state change, so we react to it during render the way
  // the rest of this file handles prop changes — comparing the last seen nonce
  // — rather than in an effect (which the set-state-in-effect lint forbids).
  // inline (rail) is always visible, so it needs no open.
  const [seenPickNonce, setSeenPickNonce] = useState(pickNonce);
  if (seenPickNonce !== pickNonce) {
    setSeenPickNonce(pickNonce);
    // Only the visible floating shape opens. At lg+ the floating
    // panel is `display:none` (the inline rail handles the pick), so opening it
    // would activate a hidden duplicate — gate on belowLg.
    if (!inline && belowLg) setOpen(true);
  }
  // Focusing the textarea is a DOM side effect (and must wait for the opened
  // panel to mount), so that part stays in an effect keyed on the pick.
  useEffect(() => {
    const id = requestAnimationFrame(() => textareaRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [pickNonce]);

  // Auto-grow the composer with its content, up to the CSS max-height cap
  // (then it scrolls inside). Keyed on `input` so programmatic changes — an
  // example prompt, the post-send clear, the restore-on-error — resize too,
  // not just keystrokes. The min/max bounds live on the className.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [input]);

  // Only run the subscription when the chat is actually visible: always for the
  // inline (rail) mount, and only while open AND below lg for the floating
  // (mobile) mount. The `&& belowLg` keeps the always-mounted-but-hidden
  // floating panel inert at lg+ (where the inline rail is the live surface), so
  // it never opens a duplicate set of Realtime channels (I6).
  const active = inline || (open && belowLg);

  const mergeRow = useCallback((row: Msg) => {
    setMessages((prev) => {
      const next = prev.filter((m) => m.id !== row.id);
      next.push(row);
      next.sort((a, b) => a.created_at.localeCompare(b.created_at));
      return next;
    });
  }, []);

  const mergeThread = useCallback((row: Thread) => {
    setThreads((prev) => {
      const next = prev.filter((t) => t.id !== row.id);
      next.push(row);
      // Most-recently-active first (matches the loader + the deck_user index).
      next.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
      return next;
    });
  }, []);

  // Load this deck's threads for the switcher + keep the list live. On the first
  // resolution we open the most-recent thread (or leave a fresh one if there are
  // none); later refreshes never override a deliberate switch / "+ New".
  useEffect(() => {
    if (!currentUserId || !active) return;
    const supabase = createClient();
    let alive = true;

    void supabase
      .from("canvas_assistant_thread")
      .select("id, title, updated_at")
      .eq("deck_id", deckId)
      .eq("user_id", currentUserId)
      .order("updated_at", { ascending: false })
      .limit(100)
      .then(({ data, error }) => {
        if (!alive) return;
        if (error || !data) {
          // A failed thread load (RLS/network/schema) would otherwise leave an
          // empty switcher with no signal — surface it instead of going silent.
          console.error("[assistant] thread load failed", error);
          setActionError("Couldn't load your conversations — please reload.");
          return;
        }
        setThreads(data as Thread[]);
        if (!pickedRef.current) {
          pickedRef.current = true;
          setActiveThreadId(data.length > 0 ? (data[0].id as string) : null);
        }
      });

    const channel = supabase
      .channel(`assistant-threads:${deckId}:${currentUserId}:${channelId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "canvas_assistant_thread",
          filter: `deck_id=eq.${deckId}`,
        },
        (payload) => {
          if (payload.eventType === "DELETE") {
            const oldId = (payload.old as { id?: string })?.id;
            if (oldId) setThreads((prev) => prev.filter((t) => t.id !== oldId));
            return;
          }
          const row = payload.new as Thread & { user_id: string };
          if (row.user_id !== currentUserId) return;
          mergeThread({ id: row.id, title: row.title, updated_at: row.updated_at });
        },
      )
      .subscribe();

    return () => {
      alive = false;
      supabase.removeChannel(channel);
    };
  }, [deckId, currentUserId, active, mergeThread, channelId]);

  // Hydrate + subscribe to the ACTIVE thread's messages. We clear first on every
  // (thread) change so one thread's messages can never bleed into another's
  // list; RLS still restricts every read/broadcast to this user's own rows.
  useEffect(() => {
    if (!currentUserId || !active || !activeThreadId) return;
    const supabase = createClient();
    let alive = true;

    void supabase
      .from("canvas_assistant_message")
      .select(
        "id, role, content, status, error, created_at, updated_at, execution_runtime, provider_model, reasoning",
      )
      .eq("thread_id", activeThreadId)
      .order("created_at", { ascending: true })
      .limit(500)
      .then(({ data, error }) => {
        if (!alive) return;
        // The load attempt resolved (success or failure) — clear the skeleton
        // either way; on failure the error banner below carries the message.
        setHydrated(true);
        if (error || !data) {
          // Without this, a failed message load renders an empty conversation
          // as if the thread were genuinely empty — surface the failure.
          console.error("[assistant] message load failed", error);
          setActionError("Couldn't load this conversation — please reload.");
          return;
        }
        setMessages(data as Msg[]);
      });

    // Expire this thread's ghost rows (prompts queued into a dead runtime,
    // turns stranded by a mid-turn restart). Fire-and-forget maintenance: any
    // rows the sweep settles flow back through the subscription below.
    void sweepAssistantTurns(deckId, activeThreadId);

    const channel = supabase
      .channel(`assistant:${activeThreadId}:${channelId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "canvas_assistant_message",
          filter: `thread_id=eq.${activeThreadId}`,
        },
        (payload) => {
          if (payload.eventType === "DELETE") {
            const oldId = (payload.old as { id?: string })?.id;
            if (oldId) setMessages((prev) => prev.filter((m) => m.id !== oldId));
            return;
          }
          // Fail CLOSED: user_id is required, and any row that isn't
          // explicitly this user's (including an absent user_id) is dropped.
          const row = payload.new as Msg & { user_id: string };
          if (row.user_id !== currentUserId) return;
          mergeRow({
            id: row.id,
            role: row.role,
            content: row.content,
            status: row.status,
            error: row.error,
            created_at: row.created_at,
            updated_at: row.updated_at,
            execution_runtime: row.execution_runtime,
            provider_model: row.provider_model,
            reasoning: row.reasoning ?? null,
          });
        },
      )
      .subscribe();

    return () => {
      alive = false;
      supabase.removeChannel(channel);
    };
  }, [activeThreadId, currentUserId, active, mergeRow, channelId, deckId]);

  // Fetch the proposals each assistant turn produced (0043). canvas_deck_edit
  // IS realtime-published (use-deck-realtime subscribes to it, filtered by
  // deck_id), but that path only calls router.refresh() — it doesn't change any
  // dep here, so an external approve/reject/withdraw wouldn't update these
  // inline cards on its own. We refetch on a key that changes when the turn SET
  // changes or a turn's status flips — not on every streamed delta — plus
  // proposalNonce, which a card action AND the canvas_deck_edit subscription
  // below bump, so external proposal changes re-hydrate the cards too. RLS
  // scopes the read to edits on decks this user can see.
  const proposalFetchKey = useMemo(
    () =>
      messages
        .filter((m) => m.role === "assistant")
        .map((m) => `${m.id}:${m.status}`)
        .join(","),
    [messages],
  );
  useEffect(() => {
    if (!active || !currentUserId) return;
    const assistantIds = messages
      .filter((m) => m.role === "assistant")
      .map((m) => m.id);
    // No turns yet — nothing to fetch. Don't clear here (set-state-in-effect is
    // forbidden); the render-phase thread-change reconcile already wiped the map,
    // and entries are keyed by message id so any leftover is inert.
    if (assistantIds.length === 0) return;
    const supabase = createClient();
    let alive = true;
    void supabase
      .from("canvas_deck_edit")
      .select(
        "id, kind, slide_id, status, rationale, created_at, assistant_message_id, variant_group_id",
      )
      .in("assistant_message_id", assistantIds)
      .order("created_at", { ascending: true })
      .then(({ data, error }) => {
        if (!alive) return;
        if (error || !data) {
          // The worst silent failure: a failed canvas_deck_edit read hides REAL
          // pending proposals (no cards render at all). Surface it loudly.
          console.error("[assistant] proposal load failed", error);
          setActionError("Couldn't load this turn's proposals — please reload.");
          return;
        }
        const next = new Map<string, AssistantProposal[]>();
        for (const raw of data as AssistantProposalRow[]) {
          // Narrow the DB string into the ProposalKind union at the boundary
          // (logs + falls back rather than throwing on an unknown kind).
          const row: AssistantProposal = {
            ...raw,
            kind: asProposalKind(raw.kind),
          };
          const list = next.get(row.assistant_message_id) ?? [];
          list.push(row);
          next.set(row.assistant_message_id, list);
        }
        setProposalsByMsg(next);
      });
    return () => {
      alive = false;
    };
    // `messages` is read via closure; proposalFetchKey drives WHEN (turn set or
    // a status change) and proposalNonce forces a post-action refetch. Depending
    // on `messages` directly would refetch on every delta.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, currentUserId, proposalFetchKey, proposalNonce]);

  // Keep the inline cards honest when a proposal changes from ANOTHER surface
  // (rail, inbox, floating chip, another client). canvas_deck_edit is realtime-
  // published (filtered by deck_id); on any change we bump proposalNonce, which
  // triggers the fetch effect above to re-hydrate the cards — so a proposal
  // approved/rejected/withdrawn elsewhere stops showing live Approve/Reject
  // here. RLS scopes the broadcast to edits on decks this user can see; the
  // per-instance channelId keeps this distinct from the deck workspace channel.
  useEffect(() => {
    if (!active || !deckId) return;
    const supabase = createClient();
    let alive = true;
    const channel = supabase
      .channel(`assistant-edits:${deckId}:${channelId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "canvas_deck_edit",
          filter: `deck_id=eq.${deckId}`,
        },
        () => {
          if (!alive) return;
          setProposalNonce((n) => n + 1);
        },
      )
      .subscribe();
    return () => {
      alive = false;
      supabase.removeChannel(channel);
    };
  }, [active, deckId, channelId]);

  // Close the switcher popover on outside-click / Esc (matches the deck menus).
  useEffect(() => {
    if (!menuOpen) return;
    function onDocClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setMenuOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  // Tick while the panel is open so both the "bridge offline?" hint (during a
  // turn) and the presence dot (which ages out the last heartbeat) stay current.
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 2000);
    return () => clearInterval(t);
  }, [active]);

  // Bridge presence (0044): hydrate the last heartbeat and keep it live. The
  // poll endpoint upserts last_seen every ~2.5s while the bridge runs; we age it
  // out against `now` (ticking above) to flip the dot to offline when it stops.
  useEffect(() => {
    if (!active || !currentUserId) return;
    const supabase = createClient();
    let alive = true;
    void supabase
      .from("canvas_assistant_bridge_presence")
      .select("last_seen_at, bridge_version, agent_provider")
      .eq("user_id", currentUserId)
      .maybeSingle()
      .then(({ data, error }) => {
        if (!alive) return;
        // The read resolved (row, no row, or error) — we now know enough to
        // trust the offline state and gate sending on it.
        setBridgeChecked(true);
        if (error) {
          // A presence read failure leaves the dot stuck offline with no clue
          // why. Don't block the whole panel with actionError (the offline dot
          // already conveys "no bridge"), but log so it isn't fully silent.
          console.error("[assistant] bridge presence load failed", error);
          return;
        }
        // A missing row (data === null) is normal — the bridge just never
        // registered; the dot reads offline, which is correct.
        if (data?.last_seen_at) {
          setBridgeLastSeen(new Date(data.last_seen_at as string).getTime());
        }
        setBridgeVersion((data?.bridge_version as string | null) ?? null);
        setBridgeProvider((data?.agent_provider as string | null) ?? null);
      });
    const channel = supabase
      .channel(`assistant-presence:${currentUserId}:${channelId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "canvas_assistant_bridge_presence",
          filter: `user_id=eq.${currentUserId}`,
        },
        (payload) => {
          // A DELETE clears the heartbeat immediately rather than waiting for
          // the 8s age-out, so the dot flips offline as soon as the row is gone.
          if (payload.eventType === "DELETE") {
            setBridgeLastSeen(null);
            setBridgeVersion(null);
            setBridgeProvider(null);
            return;
          }
          const row = payload.new as
            | {
                last_seen_at?: string;
                bridge_version?: string | null;
                agent_provider?: string | null;
              }
            | null;
          if (row?.last_seen_at) {
            setBridgeLastSeen(new Date(row.last_seen_at).getTime());
          }
          if (row && "bridge_version" in row) {
            setBridgeVersion(row.bridge_version ?? null);
          }
          if (row && "agent_provider" in row) {
            setBridgeProvider(row.agent_provider ?? null);
          }
        },
      )
      .subscribe();
    return () => {
      alive = false;
      supabase.removeChannel(channel);
    };
  }, [active, currentUserId, channelId]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, open]);

  const lastUser = useMemo(
    () => [...messages].reverse().find((m) => m.role === "user"),
    [messages],
  );

  // The newest still-in-flight row (a queued/running prompt OR a streaming
  // reply). We watch ITS updated_at: the bridge bumps updated_at on every
  // delta (~600ms apart) and on claim, so a live turn is never stale — only a
  // dead/missing bridge lets the freshest in-flight row go quiet. This now
  // catches a stalled STREAM too, not just an unclaimed prompt.
  const newestInFlight = useMemo(() => {
    const inFlight = messages.filter(
      (m) =>
        (m.role === "user" && (m.status === "queued" || m.status === "running")) ||
        (m.role === "assistant" && m.status === "streaming"),
    );
    if (inFlight.length === 0) return undefined;
    return inFlight.reduce((a, b) => (a.updated_at > b.updated_at ? a : b));
  }, [messages]);

  // Clear the optimistic Stop state once the turn has actually left the in-flight
  // set (settled to canceled/complete/error). Adjusting state during render — the
  // file's pattern (see lastThreadId); React bails when the value is unchanged, so
  // this can't loop.
  if (stopping && !newestInFlight) setStopping(false);

  const turnStalled =
    !!newestInFlight &&
    now - new Date(newestInFlight.updated_at).getTime() >
      (newestInFlight.execution_runtime === "openrouter"
        ? 30_000
        : BRIDGE_STALE_MS);

  // The bridge polls every ~2.5s; treat 3 missed beats (8s) as offline. Null
  // last-seen (never registered) reads as offline.
  const bridgeOnline = bridgeLastSeen != null && now - bridgeLastSeen < 8000;
  // The local agent bridge isn't connected. Gates sending: a queued
  // prompt would sit unanswered with no agent to claim it, so we warn and block
  // instead of letting it disappear. Only after the first presence read, so we
  // don't flash the warning before we actually know.
  const bridgeOffline = bridgeChecked && !bridgeOnline;
  const runtimeUnavailable =
    assistantRuntime === "bridge" ? bridgeOffline : !openRouterReady;
  const runtimeReady =
    assistantRuntime === "bridge" ? bridgeOnline : openRouterReady;
  // The bridge version we ship (keep in sync with bridge/package.json). An online
  // bridge reporting an older version (migration 0051) gets an "update available"
  // nudge in the tooltip; a null version is a pre-0051 bridge we don't annotate.
  const LATEST_BRIDGE_VERSION = "0.3.1";
  const bridgeOutdated =
    bridgeOnline && bridgeVersion != null && bridgeVersion !== LATEST_BRIDGE_VERSION;

  const launchOpenRouterTurn = async (userMessageId: string) => {
    try {
      const response = await fetch("/api/assistant/openrouter/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_message_id: userMessageId }),
      });
      const body = (await response.json().catch(() => null)) as {
        error?: string;
      } | null;
      if (!response.ok && response.status !== 409) {
        setActionError(friendlyError(body?.error ?? "openrouter_failed"));
      }
    } catch {
      // A dropped browser connection does not prove the server turn stopped —
      // Realtime remains authoritative. Surface the uncertainty without
      // rewriting/canceling a turn that may still be running successfully.
      setActionError(
        "Lost contact while starting OpenRouter. The turn may still finish here; use Stop if it remains stuck.",
      );
    }
  };

  const send = () => {
    const text = input.trim();
    if (!text) return;
    // The bridge has to be online to claim the prompt — block here so it can't
    // be queued into the void (the composer also disables Send + Enter offline).
    if (runtimeUnavailable) return;
    // Double-send guard: prod logged the same prompt starting twice in one
    // second (Enter + click racing before the transition state propagates).
    // The ref flips synchronously, so the second submit is dropped here.
    if (sendInFlightRef.current) return;
    sendInFlightRef.current = true;
    // When an element is pinpointed, the user types only the instruction; we
    // expand it into the anchored prompt that's actually queued. With no pick
    // but a slide selected, fold in that slide as coarse context so "this
    // slide"/"here" resolves without the user restating it (both runtimes read
    // this content). Empty deck (no selection) → send the bare text.
    const target = pickedTarget;
    // Brand rides OUTSIDE the slide/pick composition (withBrandContext
    // prepends a strippable preamble) so describeComposedPrompt still
    // recovers the instruction + context chip for the bubble.
    const content = withBrandContext(
      brandBlurb,
      target
        ? buildPickedPrompt(target, text)
        : currentSlide
          ? buildSlideContextPrompt(currentSlide, text)
          : text,
    );
    setInput("");
    setActionError(null);
    startTransition(async () => {
      try {
        const res = await sendAssistantMessage(
          deckId,
          activeThreadId,
          content,
          assistantRuntime,
        );
        if (res.ok) {
          onClearTarget?.(); // drop the chip once the turn is queued
          // First message of a new conversation: adopt the thread the action just
          // created (so we subscribe to it) and show it in the switcher at once.
          if (res.threadId !== activeThreadId) {
            mergeThread({
              // Match the server's title — both name the thread from the user's
              // instruction via describeComposedPrompt (not the folded context), so
              // the optimistic row doesn't flicker when realtime reconciles it.
              id: res.threadId,
              title: describeComposedPrompt(content).instruction.slice(0, 80),
              updated_at: new Date().toISOString(),
            });
            setActiveThreadId(res.threadId);
          }
          if (assistantRuntime === "openrouter") {
            void launchOpenRouterTurn(res.id);
          }
        } else {
          setInput(text); // restore the words; keep the chip so they can retry
          setActionError(friendlyError(res.error));
        }
      } finally {
        sendInFlightRef.current = false;
      }
    });
  };

  // Re-enqueue the last user prompt verbatim — used by the Retry affordance when
  // a turn stalled or errored. The stored content is already the full prompt
  // (the picked-element expansion happened at send time), so we send it as-is,
  // back into the same (active) thread.
  const retry = () => {
    const text = lastUser?.content?.trim();
    if (!text) return;
    if (sendInFlightRef.current) return;
    sendInFlightRef.current = true;
    setActionError(null);
    startTransition(async () => {
      try {
        const res = await sendAssistantMessage(
          deckId,
          activeThreadId,
          text,
          assistantRuntime,
        );
        if (res.ok && assistantRuntime === "openrouter") {
          void launchOpenRouterTurn(res.id);
        }
        if (!res.ok) setActionError(friendlyError(res.error));
      } finally {
        sendInFlightRef.current = false;
      }
    });
  };

  // Stop the in-flight turn (ADR-0008) — the Stop button shown while a turn runs.
  // Optimistically flag "Stopping…"; cancelAssistantTurn interrupts whichever
  // runtime owns the turn and settles dead workers itself. `stopping` clears in
  // render-phase once the row leaves the in-flight set.
  const stop = () => {
    if (!activeThreadId || stopping) return;
    setStopping(true);
    setActionError(null);
    startTransition(async () => {
      const res = await cancelAssistantTurn(deckId, activeThreadId);
      if (!res.ok) {
        setStopping(false);
        setActionError(friendlyError(res.error ?? "cancel_failed"));
      }
    });
  };

  // Inline proposal actions — the SAME server actions the review chip uses, so
  // approving in the panel and approving in the rail are one code path. On
  // success: reveal the touched slide so the result shows in place (Phase 3),
  // router.refresh() so the rail + preview pick up the new version, and bump
  // proposalNonce so the card reflects the new status.
  const settleProposal = useCallback(
    (res: ProposalActionResult, slideId: string | null) => {
      if (res.ok) {
        if (slideId) onRevealSlide?.(slideId);
        router.refresh();
        setProposalNonce((n) => n + 1);
      }
      return res;
    },
    [router, onRevealSlide],
  );
  const approveCardProposal = useCallback(
    async (editId: string, slideId: string | null) =>
      settleProposal(await approveProposal(editId, deckId), slideId),
    [deckId, settleProposal],
  );
  const rejectCardProposal = useCallback(
    async (editId: string, slideId: string | null) =>
      settleProposal(await rejectProposal(editId, deckId), slideId),
    [deckId, settleProposal],
  );
  const undoCardProposal = useCallback(
    async (editId: string, slideId: string | null) =>
      settleProposal(await revertProposal(editId, deckId), slideId),
    [deckId, settleProposal],
  );
  // Variant set actions (0066). Pick = canvas_apply_variant (supersedes the
  // pending siblings transactionally, then applies the chosen one). The generic
  // apply path is fail-closed only WHILE siblings are pending — a last surviving
  // member lands through it normally — so what's guaranteed is that two siblings
  // can never both apply. Discard = reject every pending member; sequential so
  // the RPCs never race.
  const pickVariantProposal = useCallback(
    async (editId: string, slideId: string | null) =>
      settleProposal(await applyVariant(editId, deckId), slideId),
    [deckId, settleProposal],
  );
  const discardVariantProposals = useCallback(
    async (editIds: string[], slideId: string | null) => {
      let last: ProposalActionResult = { ok: true };
      for (const id of editIds) {
        last = await rejectProposal(id, deckId);
        if (!last.ok) break;
      }
      return settleProposal(last, slideId);
    },
    [deckId, settleProposal],
  );

  // Start a pinpoint from the composer. On the floating (mobile) shape the
  // panel covers the slide, so close it first — the picked element reopens it
  // via pickNonce. The inline rail sits beside the preview, so it stays put.
  const startPick = () => {
    if (!onPickElement) return;
    if (!inline) setOpen(false);
    onPickElement();
  };

  // Start a fresh conversation: clear the active selection so the composer is
  // empty and the next send creates a new, cleanly-scoped thread. Nothing is
  // written until that send, so abandoning a blank "new conversation" costs
  // nothing (no empty threads pile up).
  const newThread = () => {
    setMenuOpen(false);
    setActionError(null);
    setActiveThreadId(null);
    setMessages([]);
    requestAnimationFrame(() => textareaRef.current?.focus());
  };

  const switchThread = (id: string) => {
    setMenuOpen(false);
    if (id === activeThreadId) return;
    setActionError(null);
    setActiveThreadId(id);
    // The message effect clears + re-hydrates on the id change.
  };

  // Delete one conversation (its messages cascade with it, 0042). Optimistically
  // drop it from the list; if it was active, fall back to the next most-recent
  // thread, else a fresh one.
  const deleteThread = (id: string) => {
    setActionError(null);
    // Snapshot what we're about to optimistically drop so a failed delete can
    // restore it — otherwise the thread vanishes from the UI but still exists
    // server-side and reappears on reload (I5).
    const removed = threads.find((t) => t.id === id) ?? null;
    const wasActive = id === activeThreadId;
    const remaining = threads.filter((t) => t.id !== id);
    setThreads(remaining);
    if (wasActive) {
      setActiveThreadId(remaining[0]?.id ?? null);
      setMessages([]);
    }
    startTransition(async () => {
      const res = await deleteAssistantThread(deckId, id);
      if (!res.ok) {
        // Roll the optimistic removal back: re-insert the thread (re-sorted by
        // mergeThread) and, if it was active, re-select it so its messages
        // re-hydrate via the load effect.
        if (removed) mergeThread(removed);
        if (wasActive) setActiveThreadId(id);
        setActionError(friendlyError(res.error ?? "delete_failed"));
      }
    });
  };

  if (!currentUserId) return null;

  const activeThread = threads.find((t) => t.id === activeThreadId) ?? null;
  const activeTitle =
    activeThreadId == null
      ? "New conversation"
      : activeThread?.title?.trim() || "Untitled";

  // Retry is offered only when there's a prompt to re-send and nothing is
  // currently in flight (a live turn shouldn't show a retry button).
  const canRetry = !!lastUser && !newestInFlight;

  // Header controls shared by both shapes: a thread title + ▾ that opens the
  // recent-conversations popover, and a "+ New" button. Kept in the one header
  // row both shapes already render, so threads cost no extra rail height.
  const threadControls = (
    <>
      <div ref={menuRef} className="relative min-w-0 flex-1">
        <button
          type="button"
          onClick={() => {
            // Reset any pending delete-confirm so reopening the popover is clean.
            setConfirmDeleteId(null);
            setMenuOpen((v) => !v);
          }}
          className="flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-xs font-medium text-muted-foreground hover:bg-muted/60 hover:text-foreground"
          aria-haspopup="dialog"
          aria-expanded={menuOpen}
          title="Switch conversation"
        >
          <MessageSquare aria-hidden className="h-3.5 w-3.5 shrink-0 text-[color:var(--accent-warm)]" />
          <span className="min-w-0 flex-1 truncate">{activeTitle}</span>
          <ChevronDown
            aria-hidden
            className={cn(
              "h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform",
              menuOpen && "rotate-180",
            )}
          />
        </button>
        {menuOpen && (
          <div
            role="dialog"
            aria-label="Recent conversations"
            className="absolute left-0 top-full z-40 mt-1 max-h-[280px] w-[260px] overflow-y-auto rounded-[10px] border border-border bg-card p-1 shadow-xl"
          >
            {threads.length === 0 ? (
              <p className="px-2 py-2 text-xs text-muted-foreground">
                No past conversations yet.
              </p>
            ) : (
              threads.map((t) => (
                <div
                  key={t.id}
                  className={cn(
                    "group flex items-center gap-1 rounded-md",
                    t.id === activeThreadId && "bg-muted",
                  )}
                >
                  <button
                    type="button"
                    onClick={() => switchThread(t.id)}
                    className="flex min-w-0 flex-1 flex-col items-start px-2 py-1.5 text-left"
                  >
                    <span className="w-full truncate text-xs font-medium text-foreground">
                      {t.title?.trim() || "Untitled"}
                    </span>
                    <span className="text-[10px] text-muted-foreground">
                      {relativeDate(t.updated_at)}
                    </span>
                  </button>
                  {confirmDeleteId === t.id ? (
                    // Two-step confirm — delete is irreversible (messages cascade).
                    // Red "Delete" is the heavier element; a plain "Cancel" reads
                    // unambiguously as the way out (clearer than a bare ✕). (#11)
                    <div className="mr-1 flex shrink-0 items-center gap-1">
                      <button
                        type="button"
                        onClick={() => {
                          setConfirmDeleteId(null);
                          deleteThread(t.id);
                        }}
                        className="rounded px-1.5 py-0.5 text-[11px] font-medium text-[color:var(--danger)] hover:bg-[color:var(--danger)]/10"
                        title="Delete this conversation permanently"
                        aria-label="Confirm delete conversation"
                      >
                        Delete
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmDeleteId(null)}
                        className="rounded px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground hover:text-foreground"
                        aria-label="Cancel delete"
                        title="Cancel"
                      >
                        Cancel
                      </button>
                    </div>
                  ) : (
                    // Always visible (not hover-only) so the affordance is
                    // findable; /70 + p-1.5 clears the contrast + 24px target
                    // floors while staying quiet at rest. (#2)
                    <button
                      type="button"
                      onClick={() => setConfirmDeleteId(t.id)}
                      className="mr-1 shrink-0 rounded p-1.5 text-muted-foreground/70 transition-colors hover:text-[color:var(--danger)] focus-visible:text-[color:var(--danger)]"
                      aria-label="Delete conversation"
                      title="Delete conversation"
                    >
                      <Trash2 aria-hidden className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              ))
            )}
          </div>
        )}
      </div>
      <button
        type="button"
        onClick={newThread}
        disabled={activeThreadId == null && messages.length === 0}
        className="inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
        title="New conversation"
        aria-label="New conversation"
      >
        <Plus aria-hidden className="h-4 w-4" />
      </button>
    </>
  );

  // Runtime selector + health dot. Moved out of the cramped title row (#3) into
  // the composer: per-turn runtime choice belongs by the composer, and the
  // helper text under it already explains the selected runtime.
  const runtimeControl = (
    <div className="mt-2 flex items-center gap-2">
      <select
        value={assistantRuntime}
        onChange={(event) =>
          setAssistantRuntime(event.target.value as "bridge" | "openrouter")
        }
        disabled={Boolean(newestInFlight)}
        aria-label="Assistant runtime"
        title="Choose where this conversation's next turn runs"
        className="h-7 max-w-[120px] shrink-0 rounded-md border border-border bg-card px-1.5 text-[11px] font-medium text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-55"
      >
        <option value="bridge">Local</option>
        <option value="openrouter" disabled={!openRouterReady}>
          OpenRouter
        </option>
      </select>
      {/* Runtime health: local follows bridge presence; OpenRouter is ready when
          a validated encrypted key is available on the server. */}
      <span
        role="status"
        className="flex shrink-0 items-center"
        title={
          assistantRuntime === "openrouter"
            ? openRouterReady
              ? `OpenRouter ready · ${openRouterModel}`
              : "OpenRouter is not connected — see Connections"
            : bridgeOnline
              ? bridgeOutdated
                ? `Local assistant connected (v${bridgeVersion}) — update available: restart the npx command from Connections`
                : bridgeVersion
                  ? `${providerLabel(bridgeProvider)} connected (bridge v${bridgeVersion})`
                  : `${providerLabel(bridgeProvider)} connected`
              : "Local agent offline — run canvas-agent (see Connections)"
        }
        aria-label={runtimeReady ? "Assistant ready" : "Assistant unavailable"}
      >
        <span
          className={cn(
            "h-2 w-2 rounded-full",
            runtimeReady
              ? "bg-[color:var(--accent-warm)]"
              : "bg-muted-foreground/40",
          )}
        />
      </span>
    </div>
  );

  const messageArea = (
    <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto px-4 py-4">
      {messages.length > 0 ? (
        messages.map((m) => (
          <Bubble
            key={m.id}
            msg={m}
            onRetry={canRetry ? retry : undefined}
            onRevealSlide={onRevealSlide}
            proposals={
              m.role === "assistant" ? proposalsByMsg.get(m.id) : undefined
            }
            slideLabel={slideLabel}
            deckId={deckId}
            onApprove={approveCardProposal}
            onReject={rejectCardProposal}
            onUndo={undoCardProposal}
            onPickVariant={pickVariantProposal}
            onDiscardVariants={discardVariantProposals}
            onCompare={onCompare}
            activePreviewProposalId={activePreviewProposalId}
            comparing={comparing}
          />
        ))
      ) : activeThreadId != null && !hydrated ? (
        // A populated thread is still loading — show a skeleton, never the
        // first-run CTA (which otherwise flashes on every switch). (#1)
        <MessageSkeleton />
      ) : !actionError ? (
        // Genuinely new conversation (no active thread) or an empty one — the
        // CTA is the invitation to start. Suppressed when a load error is shown.
        <EmptyState
          hasAssistantConnection={hasActiveMcpToken || openRouterReady}
          runtime={assistantRuntime}
          currentSlide={currentSlide}
          onUseExample={(text) => {
            setInput(text);
            requestAnimationFrame(() => textareaRef.current?.focus());
          }}
        />
      ) : null}

      {turnStalled && newestInFlight?.execution_runtime !== "openrouter" ? (
        <BridgeOfflineHint onRetry={lastUser ? retry : null} />
      ) : turnStalled ? (
        <OpenRouterStalledHint />
      ) : null}

      {actionError && (
        <div className="flex items-start justify-between gap-2 rounded-[10px] border border-[color:var(--danger)]/40 bg-[color:var(--danger)]/10 px-3 py-2 text-xs text-[color:var(--danger)]">
          <span>{actionError}</span>
          <button
            type="button"
            onClick={() => setActionError(null)}
            className="shrink-0 rounded p-0.5 hover:opacity-70"
            aria-label="Dismiss"
          >
            <X aria-hidden className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
    </div>
  );

  const composer = (
    <div className="border-t border-border p-3">
      {/* Bridge offline (0044): the local agent isn't connected, so a
          sent prompt would have nothing to claim it. Warn and block sending
          instead of letting the message vanish into the queue. */}
      {assistantRuntime === "bridge" && bridgeOffline && (
        <div className="mb-2 flex items-start gap-2 rounded-[8px] border border-[color:var(--danger)]/40 bg-[color:var(--danger)]/10 px-2.5 py-1.5 text-[11px] leading-relaxed">
          <TriangleAlert
            aria-hidden
            className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[color:var(--danger)]"
          />
          <span className="min-w-0 flex-1 text-foreground">
            Your local agent isn&apos;t connected.{" "}
            {hasActiveMcpToken ? (
              <>
                Start <code className="font-mono">canvas-agent</code> to send —
                see{" "}
              </>
            ) : (
              <>Set it up to send — see{" "}</>
            )}
            <Link
              href="/settings/mcp"
              className="font-medium text-[color:var(--accent)] hover:underline"
            >
              Connections
            </Link>
            .
          </span>
        </div>
      )}
      {assistantRuntime === "openrouter" && !openRouterReady ? (
        <div className="mb-2 flex items-start gap-2 rounded-[8px] border border-[color:var(--danger)]/40 bg-[color:var(--danger)]/10 px-2.5 py-1.5 text-[11px] leading-relaxed">
          <TriangleAlert
            aria-hidden
            className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[color:var(--danger)]"
          />
          <span className="min-w-0 flex-1 text-foreground">
            Connect a personal OpenRouter API key in{" "}
            <Link
              href="/settings/mcp"
              className="font-medium text-[color:var(--accent)] hover:underline"
            >
              Connections
            </Link>{" "}
            before using the API runtime.
          </span>
        </div>
      ) : null}
      {/* Pinpoint chip — the element the user clicked in the preview. They type
          a plain instruction below; we anchor it to this element on send. */}
      {pickedTarget ? (
        <div className="mb-2 flex items-center gap-2 rounded-[8px] border border-[color:var(--accent)]/40 bg-[color:var(--accent-wash)] px-2.5 py-1.5 text-[11px]">
          <Crosshair aria-hidden className="h-3.5 w-3.5 shrink-0 text-[color:var(--accent)]" />
          <span className="min-w-0 flex-1 truncate text-foreground">
            Slide {pickedTarget.slidePosition + 1}
            {pickedTarget.slideTitle ? ` · ${pickedTarget.slideTitle}` : ""} —{" "}
            <span className="font-mono text-muted-foreground">
              {pickedTarget.descriptor}
            </span>
          </span>
          <button
            type="button"
            onClick={() => onClearTarget?.()}
            className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground"
            aria-label="Remove pinpointed element"
            title="Remove pinpointed element"
          >
            <X aria-hidden className="h-3.5 w-3.5" />
          </button>
        </div>
      ) : picking ? (
        <div className="mb-2 flex items-center justify-between gap-2 rounded-[8px] border border-[color:var(--accent)]/50 bg-[color:var(--accent-wash)] px-2.5 py-1.5 text-[11px] text-foreground">
          <span className="flex items-center gap-1.5">
            <Crosshair aria-hidden className="h-3.5 w-3.5 shrink-0 text-[color:var(--accent)]" />
            Click an element on the slide…
          </span>
          <button
            type="button"
            onClick={() => onCancelPick?.()}
            className="shrink-0 font-medium text-muted-foreground hover:text-foreground"
          >
            Cancel
          </button>
        </div>
      ) : onPickElement ? (
        <button
          type="button"
          onClick={startPick}
          className="mb-2 flex w-full items-center gap-2 rounded-[8px] border border-dashed border-border px-2.5 py-1.5 text-[11px] text-muted-foreground transition-colors hover:border-[color:var(--accent)]/60 hover:text-foreground"
          title="Point at an element on the slide, then describe the change"
        >
          <Crosshair aria-hidden className="h-3.5 w-3.5 shrink-0" />
          Point at an element to change
        </button>
      ) : null}
      <div className="flex items-end gap-2">
        <textarea
          ref={textareaRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              // While a turn is in flight the button is Stop, not Send — don't let
              // Enter queue a second prompt mid-run (Stop first, then send).
              if (!newestInFlight) send();
            }
          }}
          rows={3}
          placeholder={
            pickedTarget
              ? "Describe the change to this element…"
              : "Ask your agent to edit this deck…"
          }
          className="max-h-[40vh] min-h-[76px] flex-1 resize-none overflow-y-auto rounded-[10px] border border-border bg-paper-soft px-3 py-2 text-sm outline-none transition-colors focus-visible:border-[color:var(--accent)]/50 focus-visible:ring-2 focus-visible:ring-ring"
        />
        {newestInFlight ? (
          // A turn is running — the button becomes Stop (ADR-0008), mirroring the
          // Claude app: interrupt the in-flight turn, then send the next message.
          <Button
            type="button"
            variant="outline"
            onClick={stop}
            disabled={stopping}
            className="shrink-0 gap-1.5"
            title="Stop the running turn"
          >
            <Square aria-hidden className="h-3.5 w-3.5 fill-current" />
            {stopping ? "Stopping…" : "Stop"}
          </Button>
        ) : (
          <Button
            type="button"
            onClick={send}
            disabled={!input.trim() || runtimeUnavailable}
            title={
              runtimeUnavailable
                ? assistantRuntime === "bridge"
                  ? "Your local agent isn’t connected — start canvas-agent to send"
                  : "Connect OpenRouter in Settings → Connections to send"
                : undefined
            }
            className="shrink-0 bg-[color:var(--accent)] text-white hover:bg-[color:var(--accent-dim)] hover:opacity-100"
          >
            Send
          </Button>
        )}
      </div>
      {runtimeControl}
      <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
        {pickedTarget
          ? "Point at any element with “Ask agent” in the toolbar, then say what to change."
          : assistantRuntime === "openrouter"
            ? `Runs through ${openRouterModel} with your encrypted personal key. Proposed edits still land in Review.`
            : "Runs on your machine with your chosen provider. Proposed edits land here and in Review for you to approve."}
      </p>
    </div>
  );

  // Inline (rail-docked) shape — fills the rail column under the tab bar. The
  // thread switcher always shows (even on an empty conversation) so "which
  // thread am I in?" is never ambiguous.
  if (inline) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex items-center gap-1 border-b border-border px-2 py-1.5">
          {threadControls}
        </div>
        {messageArea}
        {composer}
      </div>
    );
  }

  // Floating shape — launcher + slide-over (mobile).
  return (
    <>
      {!open && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="fixed bottom-6 right-6 z-30 inline-flex items-center gap-2 rounded-full bg-[color:var(--accent)] px-4 py-3 text-sm font-semibold text-white shadow-lg transition-colors hover:bg-[color:var(--accent-dim)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          aria-label="Open the in-app assistant"
        >
          <Sparkles aria-hidden className="h-4 w-4" />
          Ask agent
        </button>
      )}

      {open && (
        <div className="fixed inset-y-0 right-0 z-30 flex w-full max-w-[400px] flex-col border-l border-border bg-card shadow-2xl">
          <header className="flex items-center gap-1 border-b border-border px-3 py-2.5">
            {threadControls}
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="shrink-0 rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
              aria-label="Close"
            >
              <X aria-hidden className="h-4 w-4" />
            </button>
          </header>
          {messageArea}
          {composer}
        </div>
      )}
    </>
  );
}

// The model's visible thinking (reasoning models stream it BEFORE any reply
// content — for glm-5.2 that phase is most of the turn). Live: open, streaming
// the tail so the panel shows continuous progress from the first second.
// Settled: collapsed to one line, expandable. Content is plain text.
function ThinkingBlock({ reasoning, live }: { reasoning: string; live: boolean }) {
  const [userToggled, setUserToggled] = useState<boolean | null>(null);
  const open = userToggled ?? live;
  const tailRef = useRef<HTMLDivElement>(null);

  // Keep the live tail pinned to the newest thought.
  useEffect(() => {
    if (live && open) {
      tailRef.current?.scrollTo({ top: tailRef.current.scrollHeight });
    }
  }, [reasoning, live, open]);

  return (
    <div className="mb-1.5">
      <button
        type="button"
        onClick={() => setUserToggled(!open)}
        className="inline-flex items-center gap-1 text-[11px] font-medium text-muted-foreground hover:text-foreground"
        aria-expanded={open}
      >
        <ChevronDown
          aria-hidden
          className={cn("h-3 w-3 transition-transform", open ? "" : "-rotate-90")}
        />
        {live ? <span className="animate-pulse">Thinking…</span> : "Thinking"}
      </button>
      {open ? (
        <div
          ref={tailRef}
          className="mt-1 max-h-40 overflow-y-auto whitespace-pre-wrap rounded-md bg-muted/50 px-2 py-1.5 text-xs leading-relaxed text-muted-foreground"
        >
          {reasoning}
        </div>
      ) : null}
    </div>
  );
}

function Bubble({
  msg,
  onRetry,
  onRevealSlide,
  proposals,
  slideLabel,
  deckId,
  onApprove,
  onReject,
  onUndo,
  onPickVariant,
  onDiscardVariants,
  onCompare,
  activePreviewProposalId,
  comparing,
}: {
  msg: Msg;
  onRetry?: () => void;
  // Select + scroll to the slide a user message was anchored to, when its
  // context chip is clicked (#9). Threaded from the panel's onRevealSlide.
  onRevealSlide?: (slideId: string) => void;
  proposals?: AssistantProposal[];
  slideLabel?: (slideId: string | null) => string | null;
  deckId?: string;
  onApprove?: ProposalActionHandler;
  onReject?: ProposalActionHandler;
  onUndo?: ProposalActionHandler;
  // Variant set actions (0066) — pick one / discard the whole group. Both
  // resolve to the action result so VariantGroupCard can surface a failure.
  onPickVariant?: (
    editId: string,
    slideId: string | null,
  ) => Promise<ProposalActionResult>;
  onDiscardVariants?: (
    editIds: string[],
    slideId: string | null,
  ) => Promise<ProposalActionResult>;
  onCompare?: (editId: string, slideId: string | null) => void;
  activePreviewProposalId?: string | null;
  comparing?: boolean;
}) {
  const isUser = msg.role === "user";

  // Split this turn's proposals into pick-one variant groups (two or more
  // PENDING members sharing a variant_group_id) and everything else. Settled
  // members (applied / superseded / rejected) fall back to normal cards so
  // history reads with the standard status chips. A pending member with no
  // slide_id can't render as a pick-one card (the card needs a slide to
  // thumbnail), so it too falls to `loose` rather than vanishing.
  const variantGroups = new Map<string, AssistantProposal[]>();
  const loose: AssistantProposal[] = [];
  for (const p of proposals ?? []) {
    if (p.variant_group_id && p.status === "pending" && p.slide_id) {
      const bucket = variantGroups.get(p.variant_group_id) ?? [];
      bucket.push(p);
      variantGroups.set(p.variant_group_id, bucket);
    } else {
      loose.push(p);
    }
  }
  for (const [groupId, members] of [...variantGroups.entries()]) {
    if (members.length < 2) {
      // A lone pending survivor isn't a choice anymore — normal card.
      loose.push(...members);
      variantGroups.delete(groupId);
    }
  }
  return (
    <div className={cn("flex flex-col gap-1.5", isUser ? "items-end" : "items-start")}>
      <div
        className={cn(
          "max-w-[85%] break-words rounded-[12px] px-3 py-2 text-sm",
          isUser
            ? "bg-[color:var(--accent)] text-white"
            : "border border-border bg-paper text-foreground",
        )}
      >
        {/* Thinking stream, above the reply it produced. Skipped when the
            salvage path promoted the reasoning INTO the content (identical
            text twice reads as a glitch). */}
        {!isUser && msg.reasoning && msg.reasoning !== msg.content ? (
          <ThinkingBlock
            reasoning={msg.reasoning}
            live={msg.status === "streaming" && !msg.content}
          />
        ) : null}
        {msg.status === "error" ? (
          <span className="text-[color:var(--danger)]">
            {msg.error || "Something went wrong."}
            {onRetry && (
              <>
                {" "}
                <button
                  type="button"
                  onClick={onRetry}
                  className="font-medium underline hover:opacity-70"
                >
                  Retry
                </button>
              </>
            )}
          </span>
        ) : msg.content ? (
          isUser ? (
            <ComposedUserContent content={msg.content} onRevealSlide={onRevealSlide} />
          ) : (
            <RichText content={msg.content} />
          )
        ) : msg.role === "assistant" && msg.status === "streaming" ? (
          msg.reasoning ? null : (
            <span className="text-muted-foreground">Your agent is working…</span>
          )
        ) : msg.status === "canceled" ? (
          <span className="text-muted-foreground/70">Stopped before any reply.</span>
        ) : (
          <span className="text-muted-foreground/70">…</span>
        )}
      </div>

      {/* Stopped turn (ADR-0008): a muted "Stopped" tag under the bubble, keeping
          whatever partial output is above it. Retry (re-enqueues the prompt) sits
          on the user bubble, where the prompt that would be re-sent lives. */}
      {msg.status === "canceled" ? (
        <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
          <span className="inline-flex items-center gap-1">
            <Square aria-hidden className="h-3 w-3" />
            Stopped
          </span>
          {isUser && onRetry ? (
            <button
              type="button"
              onClick={onRetry}
              className="font-medium underline hover:opacity-70"
            >
              Retry
            </button>
          ) : null}
        </div>
      ) : null}

      {!isUser && msg.execution_runtime === "openrouter" && msg.provider_model ? (
        <div className="text-[10px] text-muted-foreground">
          via {msg.provider_model}
        </div>
      ) : null}

      {/* Proposals this turn produced — the gate, one click away in the panel.
        * A pending variant set renders as ONE pick-one card; everything else
        * (ordinary proposals, settled variant members) keeps the stack. */}
      {!isUser && proposals && proposals.length > 0 ? (
        <div className="w-full max-w-[85%] space-y-1.5">
          {deckId && onPickVariant && onDiscardVariants
            ? [...variantGroups.entries()].map(([groupId, members]) => {
                const slideId = members[0]?.slide_id ?? null;
                // A variant set is always for one existing slide, but never
                // drop a member if slide_id is somehow null — that would make
                // the whole group vanish from the transcript. Such members are
                // routed into `loose` above and render as ordinary cards.
                if (!slideId) return null;
                return (
                  <VariantGroupCard
                    key={groupId}
                    deckId={deckId}
                    slideId={slideId}
                    slideLabel={slideLabel?.(slideId) ?? null}
                    variants={members.map((m) => ({
                      id: m.id,
                      // The propose tool stores "label — rationale"; the label
                      // half is the caption.
                      label: m.rationale ? m.rationale.split(" — ")[0] : null,
                    }))}
                    onPick={(editId) => onPickVariant(editId, slideId)}
                    onDiscardAll={() =>
                      onDiscardVariants(
                        members.map((m) => m.id),
                        slideId,
                      )
                    }
                  />
                );
              })
            : null}
          {loose.map((p) => (
            <ProposalCard
              key={p.id}
              proposal={p}
              slideLabel={slideLabel}
              onApprove={onApprove}
              onReject={onReject}
              onUndo={onUndo}
              onCompare={onCompare}
              previewing={activePreviewProposalId === p.id}
              comparing={comparing ?? false}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

// Signature of the inline proposal action handlers (approve/reject/undo). They
// return the server action's result so the card can surface a failure in place.
type ProposalActionHandler = (
  editId: string,
  slideId: string | null,
) => Promise<ProposalActionResult>;

// One proposal, reviewable inline. Approve/Reject/Undo run the shared server
// actions (no second approve path). The status is optimistic: a successful
// action flips the card before the parent's refetch lands, then the refetch
// reconciles. Undo only shows for revertable kinds (mirrors the review chip).
function ProposalCard({
  proposal,
  slideLabel,
  onApprove,
  onReject,
  onUndo,
  onCompare,
  previewing = false,
  comparing = false,
}: {
  proposal: AssistantProposal;
  slideLabel?: (slideId: string | null) => string | null;
  onApprove?: ProposalActionHandler;
  onReject?: ProposalActionHandler;
  onUndo?: ProposalActionHandler;
  onCompare?: (editId: string, slideId: string | null) => void;
  // This proposal is the one the preview is currently lensing, and whether the
  // wipe is pulled to "current" — drives the compare button's label/pressed state.
  previewing?: boolean;
  comparing?: boolean;
}) {
  const [override, setOverride] = useState<ProposalStatus | null>(null);
  const [undone, setUndone] = useState(false);
  const [busy, setBusy] = useState<null | "approve" | "reject" | "undo">(null);
  const [error, setError] = useState<string | null>(null);

  const status = override ?? proposal.status;
  const label =
    (proposal.slide_id ? slideLabel?.(proposal.slide_id) : null) ||
    KIND_CARD_LABEL[proposal.kind] ||
    proposal.kind;
  const revertable = REVERTABLE_KINDS.has(proposal.kind);
  const lensable = LENS_KINDS.has(proposal.kind);

  const run = async (action: "approve" | "reject" | "undo", fn?: ProposalActionHandler) => {
    if (!fn || busy) return;
    setBusy(action);
    setError(null);
    let res: ProposalActionResult;
    try {
      res = await fn(proposal.id, proposal.slide_id);
    } catch {
      res = { ok: false, error: "could not reach the server — try again" };
    }
    setBusy(null);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    if (action === "approve") setOverride("applied");
    else if (action === "reject") setOverride("rejected");
    else setUndone(true);
  };

  return (
    <div className="rounded-[10px] border border-border bg-card/80 px-2.5 py-2 text-[11px]">
      <div className="flex items-center gap-1.5">
        <span className="shrink-0 rounded-[5px] border border-border bg-muted/40 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-muted-foreground">
          {KIND_CARD_LABEL[proposal.kind] ?? proposal.kind}
        </span>
        <span className="min-w-0 flex-1 truncate font-medium text-foreground">
          {label}
        </span>
      </div>

      {proposal.rationale ? (
        <p className="mt-1 line-clamp-2 leading-relaxed text-muted-foreground">
          {proposal.rationale}
        </p>
      ) : null}

      {status === "pending" ? (
        <>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {onCompare ? (
              <Button
                variant="ghost"
                size="sm"
                className={cn(
                  "h-7 px-2.5 text-[11px]",
                  previewing && "bg-muted text-foreground",
                )}
                aria-pressed={previewing}
                onClick={() => onCompare(proposal.id, proposal.slide_id)}
                title={
                  lensable
                    ? "Toggle the preview between the current slide and this change"
                    : "Open the before/after diff"
                }
              >
                {lensable ? "Compare" : "Diff"}
              </Button>
            ) : null}
            <Button
              size="sm"
              className="h-7 px-2.5 text-[11px]"
              disabled={busy !== null}
              onClick={() => run("approve", onApprove)}
              title="Apply this proposal — creates a new slide version"
            >
              {busy === "approve" ? "Approving…" : "Approve"}
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-7 px-2.5 text-[11px]"
              disabled={busy !== null}
              onClick={() => run("reject", onReject)}
            >
              {busy === "reject" ? "Rejecting…" : "Reject"}
            </Button>
          </div>
          {previewing && lensable ? (
            <p className="mt-1.5 text-[10.5px] text-muted-foreground">
              {comparing
                ? "Showing the current slide — click Compare for the change."
                : "Showing the proposed change — click Compare for the current slide."}
            </p>
          ) : null}
        </>
      ) : status === "applied" ? (
        <div className="mt-2 flex items-center gap-2">
          <span className="inline-flex items-center gap-1 font-medium text-success">
            <Check aria-hidden className="h-3.5 w-3.5" />
            {undone ? "Undone" : "Approved"}
          </span>
          {revertable && !undone ? (
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => run("undo", onUndo)}
              className="inline-flex items-center gap-1 font-medium text-muted-foreground hover:text-foreground disabled:opacity-50"
            >
              <Undo2 aria-hidden className="h-3.5 w-3.5" />
              {busy === "undo" ? "Undoing…" : "Undo"}
            </button>
          ) : null}
        </div>
      ) : (
        <div className="mt-2 capitalize text-muted-foreground">{status}</div>
      )}

      {error ? (
        <p
          role="alert"
          className="mt-1.5 rounded-[6px] border border-[color:var(--danger)]/30 bg-[color:var(--danger)]/10 px-2 py-1 text-[10.5px] text-[color:var(--danger)]"
        >
          {error}
        </p>
      ) : null}
    </div>
  );
}

// ---- Assistant message rendering ----------------------------------------
// The bridge stores one turn as a single `content` string mixing prose,
// markdown, and tool-call markers it emits as `_…toolName_` on their own line
// (canvas-agent.mjs). Rather than dump that raw, we split out the tool calls
// into chips and render the prose as light markdown. No markdown dependency:
// we parse into React nodes ourselves (so nothing is dangerouslySetInnerHTML).

// Matches a tool marker: `_…get_deck_` (the bridge uses U+2026; we also accept
// three literal dots in case a font/transport normalised it). Tool names are
// snake_case / PascalCase, so the inner `[\w-]+` may contain underscores — the
// trailing `_` is the closing delimiter.
const TOOL_RE = /_(?:…|\.\.\.)\s*([\w-]+)_/g;

type ContentSegment =
  | { kind: "tool"; name: string }
  | { kind: "prose"; text: string };

function splitToolSegments(content: string): ContentSegment[] {
  const out: ContentSegment[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  TOOL_RE.lastIndex = 0;
  while ((m = TOOL_RE.exec(content)) !== null) {
    const pre = content.slice(last, m.index);
    if (pre.trim()) out.push({ kind: "prose", text: pre });
    out.push({ kind: "tool", name: m[1] });
    last = m.index + m[0].length;
  }
  const rest = content.slice(last);
  if (rest.trim()) out.push({ kind: "prose", text: rest });
  return out;
}

// Friendly labels for the Canvas MCP tools (+ the SDK's own ToolSearch). The
// bridge strips the mcp__canvas__ prefix before emitting the marker, so these
// are bare names. Unknown tools fall back to a de-snaked name.
const TOOL_LABELS: Record<string, string> = {
  ToolSearch: "Searching tools",
  get_deck: "Reading the deck",
  read_slide: "Reading a slide",
  read_full_deck: "Reading the full deck",
  read_theme: "Reading the theme",
  read_slide_version: "Reading a slide version",
  list_slide_versions: "Listing slide versions",
  list_proposals: "Listing proposals",
  list_comments: "Reading comments",
  list_snapshots: "Listing snapshots",
  propose_slide_patch: "Proposing a patch",
  propose_slide_edit: "Proposing a slide edit",
  propose_new_slide: "Proposing a new slide",
  propose_delete_slide: "Proposing a slide deletion",
  propose_duplicate_slide: "Proposing a duplicate",
  propose_reorder_slides: "Proposing a reorder",
  propose_theme_edit: "Proposing a theme edit",
  propose_deck_edit: "Proposing a deck edit",
  add_comment: "Adding a comment",
  reply_to_comment: "Replying to a comment",
  resolve_comment: "Resolving a comment",
  create_snapshot: "Saving a snapshot",
  AskUserQuestion: "Asking a question",
};

function toolLabel(name: string): string {
  return TOOL_LABELS[name] ?? name.replace(/[_-]+/g, " ");
}

function ToolChip({ name }: { name: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-muted/60 px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
      <Wrench aria-hidden className="h-3 w-3 shrink-0" />
      {toolLabel(name)}
    </span>
  );
}

// A user bubble: show the instruction the user typed, with any folded slide /
// element context (assistant-prompt.ts) as a quiet chip rather than dumping the
// whole composed prompt — raw slide_id, HTML anchor, tool hints — into the
// bubble. describeComposedPrompt falls back to the verbatim content when nothing
// was folded in, so a plain message renders exactly as before.
function ComposedUserContent({
  content,
  onRevealSlide,
}: {
  content: string;
  onRevealSlide?: (slideId: string) => void;
}) {
  const { contextLabel, instruction, slideId } = describeComposedPrompt(content);
  // The crosshair + label stay white on the user's blue bubble (this is the
  // human's message — #5 leaves it blue/white). Bumped to white/80 for contrast
  // (#8). When we recovered a slide id and the editor gave us a reveal handler,
  // the chip becomes a button that selects/scrolls to that slide (#9).
  const chipInner = (
    <>
      <Crosshair aria-hidden className="h-3 w-3 shrink-0" />
      <span className="min-w-0 truncate">{contextLabel}</span>
    </>
  );
  return (
    <>
      {contextLabel ? (
        slideId && onRevealSlide ? (
          <button
            type="button"
            onClick={() => onRevealSlide(slideId)}
            className="-mx-1 mb-1 flex max-w-full items-center gap-1 rounded px-1 text-[11px] text-white/80 transition-colors hover:bg-white/10 hover:text-white focus-visible:bg-white/10"
            title="Go to this slide"
          >
            {chipInner}
          </button>
        ) : (
          <span className="mb-1 flex items-center gap-1 text-[11px] text-white/80">
            {chipInner}
          </span>
        )
      ) : null}
      <RichText content={instruction} />
    </>
  );
}

function RichText({ content }: { content: string }) {
  const segments = splitToolSegments(content);
  return (
    <div className="space-y-2">
      {segments.map((seg, i) =>
        seg.kind === "tool" ? (
          <div key={i}>
            <ToolChip name={seg.name} />
          </div>
        ) : (
          <div key={i} className="space-y-2">
            {renderProse(seg.text)}
          </div>
        ),
      )}
    </div>
  );
}

// Inline markdown: **bold**, *italic*, `code`. Bold/code only — underscores are
// left alone because the bridge uses them for tool markers (already stripped
// upstream of here). Returns a node array TS infers as (string | element)[].
function renderInline(text: string) {
  const nodes: Array<string | React.JSX.Element> = [];
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\n]+\*)/g;
  let last = 0;
  let key = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith("`")) {
      nodes.push(
        <code
          key={key++}
          className="rounded bg-foreground/10 px-1 py-0.5 font-mono text-[0.85em]"
        >
          {tok.slice(1, -1)}
        </code>,
      );
    } else if (tok.startsWith("**")) {
      nodes.push(
        <strong key={key++} className="font-semibold">
          {tok.slice(2, -2)}
        </strong>,
      );
    } else {
      nodes.push(<em key={key++}>{tok.slice(1, -1)}</em>);
    }
    last = m.index + tok.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

// Block-level prose: fenced code, bullet/numbered lists, and paragraphs (single
// newlines preserved). Line-based so a fenced block can span blank lines.
function renderProse(text: string) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const blocks: React.JSX.Element[] = [];
  let i = 0;
  let key = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^```/.test(line.trim())) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i].trim())) {
        buf.push(lines[i]);
        i++;
      }
      i++; // consume the closing fence (or fall off the end mid-stream)
      blocks.push(
        <pre
          key={key++}
          className="overflow-x-auto rounded-[8px] bg-foreground/10 px-2.5 py-2 font-mono text-[0.8em] leading-relaxed"
        >
          {buf.join("\n")}
        </pre>,
      );
      continue;
    }
    if (line.trim() === "") {
      i++;
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*]\s+/, ""));
        i++;
      }
      blocks.push(
        <ul key={key++} className="list-disc space-y-0.5 pl-4">
          {items.map((it, j) => (
            <li key={j}>{renderInline(it)}</li>
          ))}
        </ul>,
      );
      continue;
    }
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+\.\s+/, ""));
        i++;
      }
      blocks.push(
        <ol key={key++} className="list-decimal space-y-0.5 pl-4">
          {items.map((it, j) => (
            <li key={j}>{renderInline(it)}</li>
          ))}
        </ol>,
      );
      continue;
    }
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !/^```/.test(lines[i].trim()) &&
      !/^\s*[-*]\s+/.test(lines[i]) &&
      !/^\s*\d+\.\s+/.test(lines[i])
    ) {
      para.push(lines[i]);
      i++;
    }
    blocks.push(
      <p key={key++} className="whitespace-pre-wrap leading-relaxed">
        {renderInline(para.join("\n"))}
      </p>,
    );
  }
  return blocks;
}

// The deck-level starters that don't depend on the selected slide; the first,
// slide-aware starter is built per-render in EmptyState so it never hardcodes
// "slide 1" (#6).
const STARTER_PROMPTS_TAIL = [
  "Make the theme darker",
  "Suggest 3 ways to sharpen this deck",
];

// Placeholder bubbles shown while a switched-in thread's history loads, so a
// populated conversation never flashes the first-run "Try these" CTA (#1).
// Mirrors the real bubble shapes — user (right, accent-tinted) and assistant
// (left, bordered). aria-hidden on the shapes + an SR-only status keep it quiet
// for assistive tech; motion-reduce stills the pulse.
function MessageSkeleton() {
  return (
    <div className="space-y-3">
      <span className="sr-only" role="status">
        Loading conversation…
      </span>
      <div aria-hidden className="flex justify-end">
        <div className="h-12 w-[70%] animate-pulse rounded-[12px] bg-[color:var(--accent)]/15 motion-reduce:animate-none" />
      </div>
      <div aria-hidden className="flex justify-start">
        <div className="h-24 w-[82%] animate-pulse rounded-[12px] border border-border bg-muted/50 motion-reduce:animate-none" />
      </div>
      <div aria-hidden className="flex justify-end">
        <div className="h-10 w-[55%] animate-pulse rounded-[12px] bg-[color:var(--accent)]/15 motion-reduce:animate-none" />
      </div>
    </div>
  );
}

function providerLabel(provider: string | null): string {
  if (!provider) return "Local agent";
  if (provider.toLowerCase() === "codex") return "Codex";
  if (provider.toLowerCase() === "claude") return "Claude Code";
  return provider;
}

function EmptyState({
  hasAssistantConnection,
  runtime,
  currentSlide,
  onUseExample,
}: {
  hasAssistantConnection: boolean;
  runtime: "bridge" | "openrouter";
  currentSlide: AssistantSlideContext | null;
  onUseExample: (text: string) => void;
}) {
  // First starter names the slide the user is actually on, instead of a
  // hardcoded "slide 1" (#6). The composer folds this slide into the prompt on
  // send anyway; naming it here just makes the suggestion match what they see.
  const starters = [
    currentSlide
      ? `Tighten the headline on slide ${currentSlide.slidePosition + 1}`
      : "Tighten the deck's opening headline",
    ...STARTER_PROMPTS_TAIL,
  ];
  return (
    <div className="flex flex-col items-center gap-4 px-2 py-10 text-center">
      {/* Agent-identity mark in copper (--accent-warm), the app's "agent /
          machine layer" color, on a warm wash to match (#5). */}
      <span className="flex h-11 w-11 items-center justify-center rounded-full bg-[color:var(--accent-warm)]/12">
        <Sparkles aria-hidden className="h-5 w-5 text-[color:var(--accent-warm)]" />
      </span>
      <div className="space-y-1">
        <p className="text-sm font-semibold text-foreground">
          What should the agent change?
        </p>
        <p className="text-xs leading-relaxed text-muted-foreground">
          {runtime === "openrouter"
            ? "Your OpenRouter model reads the deck with Canvas tools and proposes edits you approve here."
            : "Your local agent reads the deck and proposes edits you approve here."}
        </p>
      </div>
      <div className="w-full space-y-1.5 text-left">
        <p className="eyebrow text-[10px]">Try</p>
        {starters.map((prompt) => (
          <button
            key={prompt}
            type="button"
            onClick={() => onUseExample(prompt)}
            className="group flex w-full items-center gap-2 rounded-[8px] border border-border bg-muted/30 px-3 py-2 text-left text-xs text-foreground transition-colors hover:border-[color:var(--accent)]/50 hover:bg-[color:var(--accent-wash)]"
          >
            <ArrowUpRight
              aria-hidden
              className="h-3.5 w-3.5 shrink-0 text-muted-foreground transition-colors group-hover:text-[color:var(--accent)]"
            />
            <span className="min-w-0 flex-1">{prompt}</span>
          </button>
        ))}
      </div>
      {!hasAssistantConnection && (
        <p className="text-xs leading-relaxed text-muted-foreground">
          First,{" "}
          <Link href="/settings/mcp" className="text-[color:var(--accent)] hover:underline">
            set up your assistant
          </Link>
          . Choose the local bridge or add a personal OpenRouter key.
        </p>
      )}
    </div>
  );
}

function OpenRouterStalledHint() {
  return (
    <div className="rounded-[10px] border border-[color:var(--accent)]/40 bg-[color:var(--accent-wash)] px-3 py-2 text-xs leading-relaxed text-muted-foreground">
      OpenRouter is taking longer than expected. You can keep waiting, or use
      Stop and retry with another model from{" "}
      <Link href="/settings/mcp" className="text-[color:var(--accent)] hover:underline">
        Connections
      </Link>
      .
    </div>
  );
}

// Shown when a prompt has sat unanswered long enough that the local bridge is
// probably not running. Recovery happens IN the deck: the run command (with a
// token placeholder — the panel can't re-read the secret) and the two failure
// modes that actually bite, plus Retry, instead of bouncing the user to a setup
// page mid-task. The real token + ready-to-paste command live on /settings/mcp.
function BridgeOfflineHint({ onRetry }: { onRetry: (() => void) | null }) {
  const [copied, setCopied] = useState(false);
  // window.location is safe here — this file is a client component.
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const command = `CANVAS_AGENT_PROVIDER=codex CANVAS_MCP_TOKEN=<your token> CANVAS_URL=${origin} npx @21xventures/canvas-agent`;

  const copy = () => {
    void navigator.clipboard.writeText(command);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  };

  return (
    <div className="space-y-2 rounded-[10px] border border-[color:var(--accent)]/40 bg-[color:var(--accent-wash)] px-3 py-2 text-xs text-muted-foreground">
      <p>
        Still waiting for your local assistant.{" "}
        <code className="font-mono text-foreground">canvas-agent</code> is
        probably not running.
      </p>
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded-[6px] border border-border bg-paper px-2 py-1 font-mono text-[11px] text-foreground">
          {command}
        </code>
        <button
          type="button"
          onClick={copy}
          className="shrink-0 font-medium text-[color:var(--accent)] hover:underline"
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <ul className="ml-3 list-disc space-y-0.5">
        <li>Not running? Paste the command above in any terminal.</li>
        <li>
          Running but still offline? Your token may be wrong, or the selected
          provider may not be installed and signed in locally.
        </li>
      </ul>
      <p>
        Get your token from{" "}
        <Link href="/settings/mcp" className="text-[color:var(--accent)] hover:underline">
          Connections
        </Link>
        .
        {onRetry && (
          <>
            {" "}
            <button
              type="button"
              onClick={onRetry}
              className="font-medium text-[color:var(--accent)] hover:underline"
            >
              Retry
            </button>
          </>
        )}
      </p>
    </div>
  );
}

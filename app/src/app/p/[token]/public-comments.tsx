"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { MessageSquare, Send, X } from "lucide-react";
import { cn, relativeDate } from "@/lib/utils";
import type { PublicCommentThread } from "@/lib/canvas/public-comment-types";
import { mintOpaqueSession } from "@/lib/canvas/opaque-session";

// Comment layer for the PUBLIC share viewer. Lives entirely in the host page
// (never inside the sandboxed deck iframe, so comments can't leak into
// exports), as a sheet that sits above DeckViewer's chrome: a right-side
// panel on desktop, a bottom sheet on a phone.
//
// v0 semantics: slide-scoped comment list + composer, no pins. Identity is a
// one-time name gate (name required, email optional) remembered in
// localStorage and labeled for what it is — unverified attribution the deck
// owner sees.
//
// A separate opaque "guest session" key (also localStorage) rides every read
// and write: the read route uses it to show this recipient only their OWN
// threads, so a link sent to several people doesn't leak one guest's feedback
// to another. It is privacy-by-default between recipients, not authorization —
// see the route's partition note.

const IDENTITY_KEY = "canvas:guest-identity";
const GUEST_SESSION_KEY = "canvas:guest-session";

// Mint (or reuse) the per-browser guest session id. Mirrors use-view-tracking's
// mintSession: a persistent opaque key, no cookie, no PII, with a per-load
// fallback when storage is denied (private mode). Its own storage key and 'g'
// fallback prefix keep it a DISTINCT identity from the view-tracking session.
function mintGuestSession(): string {
  return mintOpaqueSession(GUEST_SESSION_KEY, "g");
}

// Per-load memo so reads (list) and writes (post) always carry the SAME id
// even when storage is denied and mintGuestSession's fallback can't persist.
// Called only from effects and handlers — never during render/SSR.
let guestSession: string | null = null;
function guestSessionId(): string {
  guestSession ??= mintGuestSession();
  return guestSession;
}

type GuestIdentity = { name: string; email: string };

function loadIdentity(): GuestIdentity | null {
  try {
    const raw = window.localStorage.getItem(IDENTITY_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<GuestIdentity>;
    if (typeof parsed.name !== "string" || parsed.name.trim() === "") return null;
    return {
      name: parsed.name,
      email: typeof parsed.email === "string" ? parsed.email : "",
    };
  } catch {
    return null;
  }
}

function storeIdentity(identity: GuestIdentity) {
  try {
    window.localStorage.setItem(IDENTITY_KEY, JSON.stringify(identity));
  } catch {
    // Private mode — the gate just reappears next visit.
  }
}

// All comment state for the public viewer, lifted so the pill button can show
// a per-slide count while the sheet owns the list + composer.
export function usePublicComments(token: string, enabled: boolean) {
  const [threads, setThreads] = useState<PublicCommentThread[]>([]);
  const [loadError, setLoadError] = useState(false);
  const loadedRef = useRef(false);

  const refresh = useCallback(async () => {
    if (!enabled) return;
    // Session is localStorage-derived, so it's minted at call time (refresh
    // only ever runs from effects/handlers, i.e. client-side post-mount).
    const session = guestSessionId();
    try {
      const res = await fetch(
        `/api/public/deck/${token}/comments?session=${encodeURIComponent(session)}`,
        { cache: "no-store" },
      );
      if (!res.ok) {
        // A non-2xx (including 429) is a real failure, not an empty deck —
        // surface it so the sheet can offer a retry instead of claiming there
        // are no comments.
        setLoadError(true);
        return;
      }
      const data = (await res.json()) as { ok?: boolean; threads?: PublicCommentThread[] };
      if (data.ok && Array.isArray(data.threads)) {
        setThreads(data.threads);
        setLoadError(false);
      } else {
        setLoadError(true);
      }
    } catch {
      // Network/parse failure: keep the last known list but flag the error.
      setLoadError(true);
    }
  }, [token, enabled]);

  useEffect(() => {
    if (!enabled || loadedRef.current) return;
    loadedRef.current = true;
    void refresh();
  }, [enabled, refresh]);

  return { threads, refresh, loadError };
}

export function PublicCommentsButton({
  count,
  open,
  onToggle,
}: {
  count: number;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-label={open ? "Close comments" : "Open comments"}
      aria-expanded={open}
      title="Comments"
      className={cn(
        "relative flex h-10 w-10 items-center justify-center rounded-full text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:h-8 sm:w-8",
        open && "bg-muted",
      )}
    >
      <MessageSquare aria-hidden className="h-4 w-4" />
      {count > 0 ? (
        <span className="font-machine absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-[color:var(--accent)] px-1 text-[9px] font-semibold tabular-nums text-white">
          {count > 9 ? "9+" : count}
        </span>
      ) : null}
    </button>
  );
}

export function PublicCommentsSheet({
  token,
  deckTitle,
  slideTitle,
  slideId,
  slidePosition,
  threads,
  loadError,
  onPosted,
  onRetry,
  onClose,
}: {
  token: string;
  deckTitle: string;
  slideTitle: string;
  slideId: string | null;
  slidePosition: number;
  threads: PublicCommentThread[];
  loadError: boolean;
  onPosted: () => void;
  onRetry: () => void;
  onClose: () => void;
}) {
  // The sheet mounts on a user click — after hydration, client only — so the
  // localStorage read is safe (and cheap) in the initializer. No effect, no
  // "loaded" flag, no react-hooks/set-state-in-effect trip.
  const [identity, setIdentity] = useState<GuestIdentity | null>(loadIdentity);
  const [nameDraft, setNameDraft] = useState("");
  const [emailDraft, setEmailDraft] = useState("");
  const [draft, setDraft] = useState("");
  // Honeypot: bound to the hidden "website" input below. Humans never see it,
  // so a non-empty value on submit is a form-scraping bot.
  const [botTrap, setBotTrap] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  const slideThreads = useMemo(
    () => threads.filter((t) => t.slide_id === slideId),
    [threads, slideId],
  );

  // Keep the newest message in view when the list grows.
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [slideThreads.length]);

  const needsIdentity = identity === null;

  async function handleSubmit() {
    setError(null);
    let active = identity;
    if (needsIdentity) {
      const name = nameDraft.trim();
      if (name === "") {
        setError("Add your name so the team knows who's asking.");
        return;
      }
      active = { name, email: emailDraft.trim() };
      storeIdentity(active);
      setIdentity(active);
    }
    const body = draft.trim();
    if (body === "" || !active) return;
    setSubmitting(true);
    try {
      const res = await fetch(`/api/public/deck/${token}/comment`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: active.name,
          email: active.email || undefined,
          body,
          slide_id: slideId ?? undefined,
          session: guestSessionId(),
          website: botTrap, // honeypot — hidden from humans, empty unless a bot fills it
        }),
      });
      const data = (await res.json().catch(() => null)) as
        | { ok?: boolean; error?: string }
        | null;
      if (!res.ok || !data?.ok) {
        setError(
          res.status === 429
            ? "Too many comments right now — give it a minute."
            : "Couldn't send your comment. Try again.",
        );
        return;
      }
      setDraft("");
      onPosted();
    } catch {
      setError("Couldn't send your comment. Try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-label={`Comments on ${deckTitle}`}
      className={cn(
        "fixed z-[60] flex flex-col border border-border bg-card shadow-2xl",
        // Desktop: right rail. Phone: bottom sheet.
        "sm:bottom-4 sm:right-4 sm:top-4 sm:w-[360px] sm:rounded-[14px]",
        "max-sm:inset-x-0 max-sm:bottom-0 max-sm:max-h-[72dvh] max-sm:rounded-t-[16px]",
      )}
    >
      <header className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
        <div className="min-w-0">
          <div className="font-machine text-[11px] uppercase tracking-wide text-muted-foreground">
            Comments · Slide {slidePosition + 1}
          </div>
          <div className="truncate text-sm font-medium text-foreground">
            {slideTitle || "Untitled slide"}
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close comments"
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <X aria-hidden className="h-4 w-4" />
        </button>
      </header>

      <div ref={listRef} className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4">
        {loadError && threads.length === 0 ? (
          // A failed read must not masquerade as "no comments yet". We know
          // nothing landed, so offer a retry instead of asserting emptiness.
          <div className="py-6 text-center text-sm text-muted-foreground">
            <p>Couldn&apos;t load comments.</p>
            <button
              type="button"
              onClick={onRetry}
              className="mt-2 rounded-[8px] border border-border px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              Retry
            </button>
          </div>
        ) : slideThreads.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            No comments on this slide yet.
            <br />
            Spotted something? Tell the team below.
          </p>
        ) : (
          slideThreads.map((thread) => (
            <div key={thread.id} className="space-y-2">
              <CommentEntry
                author={thread.author}
                createdAt={thread.created_at}
                body={thread.body}
                resolved={thread.resolved}
              />
              {thread.replies.map((reply) => (
                <div key={reply.id} className="ml-5 border-l-2 border-border pl-3">
                  <CommentEntry
                    author={reply.author}
                    createdAt={reply.created_at}
                    body={reply.body}
                    team
                  />
                </div>
              ))}
            </div>
          ))
        )}
      </div>

      <footer className="space-y-2 border-t border-border px-4 py-3">
        {/* Honeypot: off-screen, tab-skipped, hidden from assistive tech.
            Humans never fill it; a form-scraping bot will, and the server
            silently drops any submission that carries a value. */}
        <div
          aria-hidden
          className="pointer-events-none absolute left-[-9999px] top-[-9999px] h-0 w-0 overflow-hidden"
        >
          <label>
            Website
            <input
              type="text"
              name="website"
              tabIndex={-1}
              autoComplete="off"
              value={botTrap}
              onChange={(e) => setBotTrap(e.target.value)}
            />
          </label>
        </div>
        {needsIdentity ? (
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">
              Add your name so the deck&apos;s team knows who&apos;s asking.
              Visible to them, nobody else.
            </p>
            <div className="flex gap-2">
              <input
                type="text"
                value={nameDraft}
                onChange={(e) => setNameDraft(e.target.value)}
                placeholder="Your name"
                maxLength={80}
                className="min-w-0 flex-1 rounded-[8px] border border-border bg-background px-3 py-1.5 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
              <input
                type="email"
                value={emailDraft}
                onChange={(e) => setEmailDraft(e.target.value)}
                placeholder="Email (optional)"
                maxLength={120}
                className="min-w-0 flex-1 rounded-[8px] border border-border bg-background px-3 py-1.5 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
            </div>
          </div>
        ) : identity ? (
          <p className="text-xs text-muted-foreground">
            Commenting as{" "}
            <strong className="font-medium text-foreground">{identity.name}</strong>
            {" · "}
            <button
              type="button"
              onClick={() => {
                setIdentity(null);
                setNameDraft(identity.name);
                setEmailDraft(identity.email);
              }}
              className="underline underline-offset-2 transition-colors hover:text-foreground"
            >
              change
            </button>
          </p>
        ) : null}

        <div className="flex items-end gap-2">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void handleSubmit();
              }
            }}
            placeholder={`Comment on slide ${slidePosition + 1}…`}
            rows={2}
            maxLength={4000}
            className="min-h-[3rem] w-full resize-none rounded-[8px] border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          <button
            type="button"
            onClick={() => void handleSubmit()}
            disabled={submitting || draft.trim() === ""}
            aria-label="Send comment"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[color:var(--accent)] text-white transition-opacity hover:opacity-90 disabled:opacity-40"
          >
            <Send aria-hidden className="h-4 w-4" />
          </button>
        </div>
        {error ? <p className="text-xs text-[color:var(--danger)]">{error}</p> : null}
      </footer>
    </div>
  );
}

function CommentEntry({
  author,
  createdAt,
  body,
  resolved = false,
  team = false,
}: {
  author: string;
  createdAt: string;
  body: string;
  resolved?: boolean;
  team?: boolean;
}) {
  return (
    <div>
      <div className="flex items-baseline gap-2 text-[11px]">
        <span className="font-semibold text-foreground">{author}</span>
        {team ? (
          <span className="rounded-full bg-muted px-1.5 py-[1px] text-[10px] uppercase tracking-wide text-muted-foreground">
            team
          </span>
        ) : null}
        <span
          className="text-muted-foreground"
          suppressHydrationWarning
          title={new Date(createdAt).toLocaleString()}
        >
          {relativeDate(createdAt)}
        </span>
        {resolved ? (
          <span className="rounded-full bg-[color:var(--accent-wash)] px-1.5 py-[1px] text-[10px] uppercase tracking-wide text-[color:var(--accent)]">
            resolved
          </span>
        ) : null}
      </div>
      <p className="mt-0.5 whitespace-pre-wrap break-words text-sm text-foreground">
        {body}
      </p>
    </div>
  );
}

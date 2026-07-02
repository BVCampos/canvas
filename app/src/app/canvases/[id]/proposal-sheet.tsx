"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useTransition,
} from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import {
  ProposalDiff,
  type EditKind,
  type NewSlidePayload,
} from "@/components/proposal-diff";
import { ProposalEditForm } from "@/components/proposal-edit-form";
import { displayName as _ignored, relativeDate } from "@/lib/utils";
import {
  getProposalSheetData,
  type ProposalSheetData,
} from "@/app/canvases/proposal-queries";
import { loadProposalSheet } from "@/app/canvases/load-proposal-sheet";
import {
  approveProposal,
  rejectProposal,
  withdrawProposal,
  commentOnProposal,
} from "@/app/canvases/proposal-actions";

// Suppress unused import — kept for parity if we ever need it inline.
void _ignored;

// ---------------------------------------------------------------------------
// Sheet — slide-over panel anchored to the right of the viewport. Loads its
// payload via the getProposalSheetData server action when opened; reuses the
// existing diff + actions + comment-form components.
//
// Exported so the inbox (which spans multiple decks) can reuse it for a
// read-only review surface on past proposals — the sheet's internals already
// hide the approve/reject bar when status !== "pending".
// ---------------------------------------------------------------------------

export function ProposalSheet({
  editId,
  deckId,
  onClose,
}: {
  editId: string | null;
  deckId: string;
  onClose: () => void;
}) {
  const router = useRouter();
  const [data, setData] = useState<ProposalSheetData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const closeBtnRef = useRef<HTMLButtonElement | null>(null);

  // Clear cached state synchronously when the selected proposal changes
  // (or closes). Doing this during render — React's "adjusting state on
  // prop change" pattern — avoids a one-frame flash of the previous
  // proposal's content while the new fetch is in flight.
  const [lastEditId, setLastEditId] = useState(editId);
  if (lastEditId !== editId) {
    setLastEditId(editId);
    setData(null);
    setError(null);
  }

  // `loading` is derived, not stored: we're loading exactly when a
  // proposal is selected and we have neither data nor an error for it.
  // (Refetches initiated by retry/onAfterAction keep the previous `data`
  // visible until the new result arrives — same behaviour as before.)
  const loading = editId != null && data == null && error == null;

  // Initial load on editId change. Inlined (rather than calling a
  // useCallback wrapper) so the React-hooks lint can see that every state
  // change happens after the awaited promise resolves — calling a callback
  // that transitively setStates is flagged as a cascading-render hazard.
  useEffect(() => {
    if (!editId) return;
    let cancelled = false;
    void (async () => {
      // loadProposalSheet catches a REJECTED server action (5xx / timeout /
      // thrown redirect) and turns it into a surfaced error. Without it a
      // thrown call sets neither data nor error, pinning the panel on its
      // skeleton forever (no error, no Retry) — see load-proposal-sheet.ts.
      const { data, error } = await loadProposalSheet(() =>
        getProposalSheetData(editId, deckId),
      );
      if (cancelled) return;
      setData(data);
      setError(error);
    })();
    return () => {
      cancelled = true;
    };
  }, [editId, deckId]);

  // Explicit refresh path used by Retry and by mutation callbacks.
  const fetchData = useCallback(
    async (id: string) => {
      const { data, error } = await loadProposalSheet(() =>
        getProposalSheetData(id, deckId),
      );
      setData(data);
      setError(error);
    },
    [deckId],
  );

  // Close on Escape; auto-focus the close button on open.
  useEffect(() => {
    if (!editId) return;
    closeBtnRef.current?.focus();
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [editId, onClose]);

  // Lock body scroll while the sheet is open.
  useEffect(() => {
    if (!editId) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [editId]);

  if (!editId) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Proposal review"
      className="fixed inset-0 z-50"
    >
      <button
        type="button"
        aria-label="Close proposal"
        onClick={onClose}
        className="absolute inset-0 bg-foreground/40 backdrop-blur-[1px] transition-opacity"
      />
      <aside className="absolute inset-y-0 right-0 flex w-full max-w-3xl flex-col border-l border-border bg-card shadow-2xl">
        {/* Body height tracks the dynamic viewport so the panel's internal
            scroll region (and its action bar) stays reachable on mobile Safari
            where the URL bar makes 100vh overshoot the visible area. */}
        {loading && !data && <SheetSkeleton onClose={onClose} ref={closeBtnRef} />}
        {error && (
          <SheetError
            error={error}
            onRetry={() => editId && fetchData(editId)}
            onClose={onClose}
            ref={closeBtnRef}
          />
        )}
        {data && (
          <SheetBody
            data={data}
            deckId={deckId}
            onClose={onClose}
            onAfterAction={async () => {
              if (editId) await fetchData(editId);
              router.refresh();
            }}
            closeBtnRef={closeBtnRef}
          />
        )}
      </aside>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sheet body
// ---------------------------------------------------------------------------

function SheetBody({
  data,
  deckId,
  onClose,
  onAfterAction,
  closeBtnRef,
}: {
  data: ProposalSheetData;
  deckId: string;
  onClose: () => void;
  onAfterAction: () => Promise<void>;
  closeBtnRef: React.RefObject<HTMLButtonElement | null>;
}) {
  const {
    edit,
    deck,
    slide,
    oldContent,
    newContent,
    staleness,
    comments,
    newSlidePayload,
    slideEditPayload,
    slideEditBefore,
  } = data;

  const title = titleForEdit(edit.kind, slide, newSlidePayload);
  const createdAbsolute = new Date(edit.created_at).toLocaleString();
  const resolvedAbsolute = edit.resolved_at
    ? new Date(edit.resolved_at).toLocaleString()
    : null;

  return (
    <>
      {/* Sticky header */}
      <header className="sticky top-0 z-10 flex items-start justify-between gap-3 border-b border-border bg-card px-4 py-4 sm:px-6">
        <div className="min-w-0 flex-1">
          <nav
            aria-label="Breadcrumb"
            className="flex items-center gap-2 text-[11px] text-muted-foreground"
          >
            <Link href="/canvases/inbox" className="hover:text-foreground">
              Proposals
            </Link>
            <span aria-hidden>·</span>
            <Link href={`/canvases/${deckId}`} className="hover:text-foreground">
              {deck.title}
            </Link>
          </nav>
          <h2 className="mt-1 truncate text-lg font-semibold tracking-tight">
            {title}
          </h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Proposed by{" "}
            <span className="text-foreground">{data.proposerName}</span>
            {edit.proposed_by_kind === "claude" ? " via agent" : ""}
            {" · "}
            <span title={createdAbsolute}>{relativeDate(edit.created_at)}</span>
          </p>
        </div>
        <div className="flex items-center gap-2">
          <StatusBadge
            status={edit.status}
            reviewerName={
              edit.status === "pending" && data.canReject
                ? data.reviewerName
                : null
            }
          />
          <Button
            ref={closeBtnRef}
            type="button"
            variant="ghost"
            size="icon"
            onClick={onClose}
            aria-label="Close"
          >
            <span aria-hidden className="text-base leading-none">
              ×
            </span>
          </Button>
        </div>
      </header>

      {/* Scrollable body — px-4 gutter on mobile so the diff/cards don't run
          to the screen edge; pb-safe keeps the last action/comment clear of
          the iPhone home indicator since the panel spans the full height. */}
      <div className="flex-1 space-y-5 overflow-y-auto px-4 py-5 pb-safe sm:px-6">
        <div className="rounded-[12px] border border-border bg-card p-4">
          <div className="eyebrow text-muted-foreground">Rationale</div>
          {edit.rationale ? (
            <p className="mt-2 whitespace-pre-wrap text-sm text-foreground">
              {edit.rationale}
            </p>
          ) : (
            <p className="mt-2 text-sm italic text-muted-foreground">
              No rationale provided.
              {edit.proposed_by_kind === "claude"
                ? " Agent proposals without rationale are worth a closer look."
                : ""}
            </p>
          )}
        </div>

        {staleness.stale && (
          <div
            role="alert"
            className="rounded-[12px] border border-warning/30 bg-warning/10 p-4 text-sm text-warning-fg"
          >
            <strong className="font-semibold">Heads up:</strong>{" "}
            {staleness.message}
          </div>
        )}

        <ProposalDiff
          kind={edit.kind as EditKind}
          oldContent={oldContent}
          newContent={newContent}
          deck={
            edit.kind === "slide_html" ||
            edit.kind === "slide_edit" ||
            edit.kind === "slide_create"
              ? {
                  title: deck.title,
                  theme_css: deck.theme_css,
                  nav_js: deck.nav_js,
                  meta: deck.meta,
                }
              : null
          }
          slide={
            (edit.kind === "slide_html" || edit.kind === "slide_edit") && slide
              ? {
                  position: slide.position,
                  title: slide.title,
                  slide_styles: slide.slide_styles,
                }
              : null
          }
          newSlidePayload={newSlidePayload}
          slideEditPayload={slideEditPayload}
          slideEditBefore={slideEditBefore}
        />

        {edit.status === "pending" && (
          <InlineActionsBar
            editId={edit.id}
            deckId={deckId}
            canApprove={data.canApprove}
            canReject={data.canReject}
            canWithdraw={data.canWithdraw}
            canEdit={data.canEdit}
            kind={edit.kind as EditKind}
            revision={edit.revision}
            editInitial={{
              new_content: edit.new_content,
              new_slide_payload:
                (edit.new_slide_payload as Record<string, unknown> | null) ??
                null,
              rationale: edit.rationale,
            }}
            onAfterAction={onAfterAction}
          />
        )}

        {edit.status !== "pending" && (
          <ResolvedFooter
            status={edit.status}
            resolvedAt={edit.resolved_at}
            resolvedAbsolute={resolvedAbsolute}
            resolvedByName={
              edit.resolved_by
                ? data.userById[edit.resolved_by] ?? "Unknown"
                : null
            }
          />
        )}

        <section className="space-y-3">
          <div className="eyebrow text-muted-foreground">
            Comments ({comments.length})
          </div>
          {comments.length === 0 ? (
            <div className="rounded-[12px] border border-dashed border-border bg-card/50 p-4 text-sm italic text-muted-foreground">
              No comments yet.
            </div>
          ) : (
            <ul className="space-y-2">
              {comments.map((c) => (
                <li
                  key={c.id}
                  className="rounded-[12px] border border-border bg-card p-3"
                >
                  <div className="text-xs text-muted-foreground">
                    <span className="text-foreground">
                      {c.author_id
                        ? data.userById[c.author_id] ?? "Unknown"
                        : "—"}
                    </span>
                    {c.author_kind === "claude" ? " (agent)" : ""}
                    {" · "}
                    <span title={new Date(c.created_at).toLocaleString()}>
                      {relativeDate(c.created_at)}
                    </span>
                  </div>
                  <p className="mt-1 whitespace-pre-wrap text-sm">{c.body}</p>
                </li>
              ))}
            </ul>
          )}

          <InlineCommentForm
            editId={edit.id}
            deckId={deckId}
            onPosted={onAfterAction}
          />
        </section>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Inline actions + comment form (sheet-local so we can refresh sheet data
// after each mutation, not just the underlying page).
// ---------------------------------------------------------------------------

function InlineActionsBar({
  editId,
  deckId,
  canApprove,
  canReject,
  canWithdraw,
  canEdit,
  kind,
  revision,
  editInitial,
  onAfterAction,
}: {
  editId: string;
  deckId: string;
  canApprove: boolean;
  canReject: boolean;
  canWithdraw: boolean;
  canEdit: boolean;
  kind: EditKind;
  revision: number;
  editInitial: {
    new_content: string | null;
    new_slide_payload: Record<string, unknown> | null;
    rationale: string | null;
  };
  onAfterAction: () => Promise<void>;
}) {
  const [isPending, startTransition] = useTransition();
  const [rejectOpen, setRejectOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);

  const hasAnyAction = canApprove || canReject || canWithdraw || canEdit;

  function runApprove() {
    setError(null);
    setStale(false);
    startTransition(async () => {
      const result = await approveProposal(editId, deckId, revision);
      if (!result.ok) {
        if (result.code === "stale") setStale(true);
        setError(`Approve failed: ${result.error}`);
        return;
      }
      await onAfterAction();
    });
  }
  function runReject() {
    setError(null);
    startTransition(async () => {
      const result = await rejectProposal(editId, deckId, reason || undefined);
      if (!result.ok) {
        setError(`Reject failed: ${result.error}`);
        return;
      }
      setRejectOpen(false);
      setReason("");
      await onAfterAction();
    });
  }
  function runWithdraw() {
    setError(null);
    startTransition(async () => {
      const result = await withdrawProposal(editId, deckId);
      if (!result.ok) {
        setError(`Withdraw failed: ${result.error}`);
        return;
      }
      await onAfterAction();
    });
  }

  if (editing && canEdit) {
    return (
      <ProposalEditForm
        editId={editId}
        deckId={deckId}
        kind={kind}
        revision={revision}
        initial={editInitial}
        onCancel={() => setEditing(false)}
        onSaved={async () => {
          setEditing(false);
          await onAfterAction();
        }}
      />
    );
  }

  return (
    <div className="rounded-[12px] border border-border bg-card p-4">
      {!hasAnyAction ? (
        <p className="text-sm text-muted-foreground">
          You don&apos;t have permission to act on this proposal. The slide owner
          (or a workspace admin) reviews and approves. You can still leave a
          comment below.
        </p>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            {canEdit && (
              <Button
                variant="outline"
                onClick={() => {
                  setError(null);
                  setStale(false);
                  setEditing(true);
                }}
                disabled={isPending}
                title="Revise this proposal before it's reviewed"
              >
                Edit
              </Button>
            )}
            {canWithdraw && (
              <Button
                variant="ghost"
                onClick={runWithdraw}
                disabled={isPending}
                title="Cancel this proposal you authored"
              >
                Withdraw
              </Button>
            )}
            {canReject && (
              <Button
                variant="outline"
                onClick={() => setRejectOpen((v) => !v)}
                disabled={isPending}
              >
                Reject
              </Button>
            )}
          </div>
          {canApprove && (
            <Button
              onClick={runApprove}
              disabled={isPending}
              title="Apply this proposal — creates a new slide version on top of the current state"
            >
              Approve &amp; apply
            </Button>
          )}
        </div>
      )}

      {rejectOpen && canReject && (
        <div className="mt-4 space-y-2 rounded-[8px] border border-border bg-background/40 p-3">
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Optional: leave a reason. It'll be posted as a comment so the proposer sees the why."
            rows={3}
            // text-base on mobile so iOS Safari doesn't auto-zoom on focus; 14px on desktop.
            className="w-full rounded-[8px] border border-border bg-card p-2 text-base focus:outline-none focus:ring-2 focus:ring-ring sm:text-sm"
          />
          <div className="flex items-center gap-2">
            <Button
              onClick={runReject}
              disabled={isPending}
              variant="destructive"
            >
              Confirm reject
            </Button>
            <Button
              onClick={() => {
                setRejectOpen(false);
                setReason("");
              }}
              disabled={isPending}
              variant="ghost"
              size="sm"
            >
              Cancel
            </Button>
          </div>
        </div>
      )}

      {error && (
        <div
          role="alert"
          className="mt-3 space-y-2 rounded-[6px] border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger-fg"
        >
          <p>{error}</p>
          {stale && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => void onAfterAction()}
            >
              Reload latest
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

function InlineCommentForm({
  editId,
  deckId,
  onPosted,
}: {
  editId: string;
  deckId: string;
  onPosted: () => Promise<void>;
}) {
  const [body, setBody] = useState("");
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function submit() {
    const trimmed = body.trim();
    if (!trimmed) return;
    setError(null);
    startTransition(async () => {
      const result = await commentOnProposal(editId, trimmed, deckId);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setBody("");
      await onPosted();
    });
  }

  return (
    <div className="space-y-2">
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder="Comment on this proposal…"
        rows={3}
        // text-base on mobile so iOS Safari doesn't auto-zoom on focus; 14px on desktop.
        className="w-full rounded-[8px] border border-border bg-card p-2 text-base focus:outline-none focus:ring-2 focus:ring-ring sm:text-sm"
      />
      <div className="flex items-center justify-between gap-3">
        {error ? (
          <p
            role="alert"
            className="rounded-[6px] border border-danger/30 bg-danger/10 px-2.5 py-1.5 text-xs text-danger-fg"
          >
            {error}
          </p>
        ) : (
          <span />
        )}
        <Button
          onClick={submit}
          disabled={isPending || !body.trim()}
          size="sm"
        >
          Post comment
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Status + footer + skeleton + error
// ---------------------------------------------------------------------------

function StatusBadge({
  status,
  reviewerName,
}: {
  status: string;
  reviewerName?: string | null;
}) {
  const cls =
    status === "pending"
      ? "bg-warning/15 text-warning-fg border-warning/40"
      : status === "applied"
        ? "bg-success/15 text-success-fg border-success/40"
        : status === "rejected"
          ? "bg-danger/15 text-danger-fg border-danger/40"
          : "bg-muted text-muted-foreground border-border";
  const label =
    status === "pending"
      ? reviewerName
        ? `Pending — ${reviewerName} to review`
        : "Pending review"
      : status.charAt(0).toUpperCase() + status.slice(1);
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-[11px] font-medium ${cls}`}
    >
      {label}
    </span>
  );
}

function ResolvedFooter({
  status,
  resolvedAt,
  resolvedAbsolute,
  resolvedByName,
}: {
  status: string;
  resolvedAt: string | null;
  resolvedAbsolute: string | null;
  resolvedByName: string | null;
}) {
  const verb =
    status === "applied"
      ? "Applied"
      : status === "rejected"
        ? "Rejected"
        : "Superseded";
  const tone =
    status === "applied"
      ? "border-success/30 bg-success/10 text-success-fg"
      : status === "rejected"
        ? "border-danger/30 bg-danger/10 text-danger-fg"
        : "border-border bg-card text-muted-foreground";
  return (
    <div
      className={`flex items-center gap-2 rounded-[12px] border p-4 text-sm ${tone}`}
    >
      <span aria-hidden>
        {status === "applied" ? "✓" : status === "rejected" ? "✕" : "↪"}
      </span>
      <span>
        <strong className="font-semibold">{verb}</strong>
        {resolvedAt ? (
          <>
            {" "}
            <span title={resolvedAbsolute ?? undefined}>
              {relativeDate(resolvedAt)}
            </span>
          </>
        ) : null}
        {resolvedByName ? ` by ${resolvedByName}` : ""}
      </span>
    </div>
  );
}

const SheetSkeleton = function SheetSkeleton({
  ref,
  onClose,
}: {
  ref: React.RefObject<HTMLButtonElement | null>;
  onClose: () => void;
}) {
  return (
    <>
      <header className="flex items-start justify-between border-b border-border bg-card px-4 py-4 sm:px-6">
        <div className="space-y-2">
          <div className="h-3 w-24 animate-pulse rounded bg-muted" />
          <div className="h-5 w-64 animate-pulse rounded bg-muted" />
          <div className="h-3 w-40 animate-pulse rounded bg-muted" />
        </div>
        <Button
          ref={ref}
          type="button"
          variant="ghost"
          size="icon"
          onClick={onClose}
          aria-label="Close"
        >
          <span aria-hidden className="text-base leading-none">
            ×
          </span>
        </Button>
      </header>
      <div className="space-y-4 px-4 py-5 sm:px-6">
        <div className="h-24 animate-pulse rounded-[12px] bg-muted" />
        <div className="h-64 animate-pulse rounded-[12px] bg-muted" />
        <div className="h-32 animate-pulse rounded-[12px] bg-muted" />
      </div>
    </>
  );
};

const SheetError = function SheetError({
  ref,
  error,
  onClose,
  onRetry,
}: {
  ref: React.RefObject<HTMLButtonElement | null>;
  error: string;
  onClose: () => void;
  onRetry: () => void;
}) {
  return (
    <>
      <header className="flex items-start justify-between border-b border-border bg-card px-4 py-4 sm:px-6">
        <h2 className="text-base font-semibold">Couldn&apos;t load proposal</h2>
        <Button
          ref={ref}
          type="button"
          variant="ghost"
          size="icon"
          onClick={onClose}
          aria-label="Close"
        >
          <span aria-hidden className="text-base leading-none">
            ×
          </span>
        </Button>
      </header>
      <div className="px-4 py-5 sm:px-6">
        <p className="text-sm text-muted-foreground">{error}</p>
        <Button onClick={onRetry} variant="outline" className="mt-3">
          Retry
        </Button>
      </div>
    </>
  );
};

function titleForEdit(
  kind: string,
  slide: { position: number; title: string } | null,
  newSlidePayload?: NewSlidePayload | null,
): string {
  switch (kind) {
    case "slide_edit":
      return slide?.title
        ? `Slide ${slide.position + 1} — ${slide.title}`
        : "Slide edit";
    case "slide_html":
      return slide?.title
        ? `Slide ${slide.position + 1} — ${slide.title}`
        : "Slide HTML change";
    case "slide_styles":
      return "Slide CSS change";
    case "slide_title":
      return slide?.title
        ? `Slide ${slide.position + 1} label — ${slide.title}`
        : "Slide label change";
    case "slide_create":
      return newSlidePayload
        ? `New slide at position ${newSlidePayload.position + 1}${
            newSlidePayload.title ? ` — ${newSlidePayload.title}` : ""
          }`
        : "New slide";
    case "theme_css":
      return "Theme CSS change";
    case "nav_js":
      return "Navigation JS change";
    case "deck_title":
      return "Deck title change";
    case "slide_reorder":
      return "Reorder slides";
    case "slide_delete":
      return slide?.title
        ? `Delete slide ${slide.position + 1} — ${slide.title}`
        : "Delete slide";
    default:
      return "Change";
  }
}

"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { cn, relativeDate } from "@/lib/utils";
import {
  addDeckMember,
  getDeckShareState,
  inviteGuestToDeck,
  removeDeckMember,
  revokeGuestInvite,
  rotateDeckPublicShareLink,
  setDeckPublicComments,
  setDeckPublicShare,
  setDeckVisibility,
  updateDeckMemberRole,
  type DeckGuestInvite,
  type DeckMemberRole,
  type DeckShareCandidate,
  type DeckVisibility,
} from "./actions";

// Share dialog for a single deck. Mirrors RenameDeckDialog's container shape
// (backdrop + Esc + body scroll lock) so the editor stays consistent.
//
// State lives entirely client-side once the initial getDeckShareState() loads:
// each mutation calls the corresponding server action, then either patches the
// local state optimistically or refetches if something failed. The server
// actions themselves revalidate the deck page, but the dialog also keeps its
// own copy so the list re-orders without a hard reload.

export function ShareDeckDialog({
  open,
  deckId,
  currentUserId,
  onClose,
}: {
  open: boolean;
  deckId: string;
  currentUserId: string | null;
  onClose: () => void;
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // null until getDeckShareState resolves — never render a default visibility
  // (e.g. "Workspace") before we know the deck's real one, or a private deck
  // could briefly read as workspace-shared.
  const [visibility, setVisibilityState] = useState<DeckVisibility | null>(null);
  const [candidates, setCandidates] = useState<DeckShareCandidate[]>([]);
  const [guestInvites, setGuestInvites] = useState<DeckGuestInvite[]>([]);
  const [canManage, setCanManage] = useState(false);
  const [canManagePublicShare, setCanManagePublicShare] = useState(false);
  // Public "anyone with the link" state, loaded from getDeckShareState.
  const [publicEnabled, setPublicEnabled] = useState(false);
  const [publicUrl, setPublicUrl] = useState<string | null>(null);
  // Engagement rollup for the public link (opens + last opened).
  const [publicOpens, setPublicOpens] = useState(0);
  const [publicLastOpenedAt, setPublicLastOpenedAt] = useState<string | null>(null);
  // Guest commenting on the public link (off by default).
  const [publicCommentsEnabled, setPublicCommentsEnabled] = useState(false);
  const [copied, setCopied] = useState(false);
  const [query, setQuery] = useState("");
  // External-reviewer invite form (only shown to people who can manage the deck).
  const [guestEmail, setGuestEmail] = useState("");
  const [guestRole, setGuestRole] = useState<DeckMemberRole>("viewer");
  const [guestNotice, setGuestNotice] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      // setState calls go inside the async callback (not the effect body) so
      // we don't trigger cascading renders — see react-hooks/set-state-in-effect.
      setLoading(true);
      setError(null);
      const res = await getDeckShareState(deckId);
      if (cancelled) return;
      if (res.ok) {
        setVisibilityState(res.visibility);
        setCandidates(res.candidates);
        setGuestInvites(res.guestInvites);
        setCanManage(res.canManage);
        setCanManagePublicShare(res.canManagePublicShare);
        setPublicEnabled(res.publicShareEnabled);
        setPublicUrl(res.publicShareUrl);
        setPublicOpens(res.publicOpens);
        setPublicLastOpenedAt(res.publicLastOpenedAt);
        setPublicCommentsEnabled(res.publicCommentsEnabled);
      } else {
        setError(res.error);
      }
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [open, deckId]);

  // Esc closes; body scroll lock while open.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  // People who can open the deck right now: explicitly-added members plus
  // workspace admins/owners (who always have access). This is the list that
  // answers "who can see this?" — kept separate from the invite picker so an
  // invitable member never reads as someone who already has access.
  const withAccess = useMemo(
    () =>
      candidates.filter(
        (c) =>
          c.deck_role != null ||
          c.workspace_role === "owner" ||
          c.workspace_role === "admin",
      ),
    [candidates],
  );

  // Workspace members not yet on the deck — the only people the "+ Viewer /
  // + Editor" buttons apply to. Filtered by the search box. Once added, a
  // candidate's deck_role flips non-null and it moves up to withAccess.
  const addable = useMemo(() => {
    const q = query.trim().toLowerCase();
    return candidates.filter((c) => {
      if (c.deck_role != null) return false;
      if (c.workspace_role === "owner" || c.workspace_role === "admin") return false;
      if (!q) return true;
      return `${c.name ?? ""} ${c.email ?? ""}`.toLowerCase().includes(q);
    });
  }, [candidates, query]);

  if (!open) return null;

  const handleVisibility = (next: DeckVisibility) => {
    if (next === visibility) return;
    setError(null);
    setVisibilityState(next);
    startTransition(async () => {
      const res = await setDeckVisibility(deckId, next);
      if (!res.ok) {
        // Roll back the local state so the radios reflect reality.
        setVisibilityState(visibility);
        setError(`Couldn't change visibility: ${res.error}`);
      }
    });
  };

  const handleTogglePublic = (next: boolean) => {
    setError(null);
    const prevEnabled = publicEnabled;
    const prevUrl = publicUrl;
    // Optimistic: flip immediately; the URL only arrives from the server (it's
    // minted there), so we clear it on disable and wait for it on enable.
    setPublicEnabled(next);
    if (!next) setPublicUrl(null);
    startTransition(async () => {
      const res = await setDeckPublicShare(deckId, next);
      if (res.ok) {
        setPublicEnabled(res.enabled);
        setPublicUrl(res.url);
      } else {
        setPublicEnabled(prevEnabled);
        setPublicUrl(prevUrl);
        setError(`Couldn't update the public link: ${res.error}`);
      }
    });
  };

  const handleToggleComments = (next: boolean) => {
    setError(null);
    const prev = publicCommentsEnabled;
    setPublicCommentsEnabled(next);
    startTransition(async () => {
      const res = await setDeckPublicComments(deckId, next);
      if (!res.ok) {
        setPublicCommentsEnabled(prev);
        setError(`Couldn't update guest comments: ${res.error}`);
      }
    });
  };

  const handleCopyPublic = async () => {
    if (!publicUrl) return;
    try {
      await navigator.clipboard.writeText(publicUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setError("Couldn't copy automatically — select the link and copy it.");
    }
  };

  const handleRotatePublic = () => {
    setError(null);
    startTransition(async () => {
      const res = await rotateDeckPublicShareLink(deckId);
      if (res.ok) {
        setPublicEnabled(res.enabled);
        setPublicUrl(res.url);
        setCopied(false);
      } else {
        setError(`Couldn't reset the link: ${res.error}`);
      }
    });
  };

  const handleAdd = (userId: string, role: DeckMemberRole) => {
    setError(null);
    setCandidates((prev) =>
      prev.map((c) => (c.user_id === userId ? { ...c, deck_role: role } : c)),
    );
    startTransition(async () => {
      const res = await addDeckMember(deckId, userId, role);
      if (!res.ok) {
        setCandidates((prev) =>
          prev.map((c) => (c.user_id === userId ? { ...c, deck_role: null } : c)),
        );
        setError(`Couldn't add member: ${res.error}`);
      }
    });
  };

  const handleRoleChange = (userId: string, role: DeckMemberRole) => {
    setError(null);
    const previous = candidates.find((c) => c.user_id === userId)?.deck_role ?? null;
    setCandidates((prev) =>
      prev.map((c) => (c.user_id === userId ? { ...c, deck_role: role } : c)),
    );
    startTransition(async () => {
      const res = await updateDeckMemberRole(deckId, userId, role);
      if (!res.ok) {
        setCandidates((prev) =>
          prev.map((c) =>
            c.user_id === userId ? { ...c, deck_role: previous } : c,
          ),
        );
        setError(`Couldn't update role: ${res.error}`);
      }
    });
  };

  const handleRemove = (userId: string) => {
    setError(null);
    const previous = candidates.find((c) => c.user_id === userId)?.deck_role ?? null;
    setCandidates((prev) =>
      prev.map((c) => (c.user_id === userId ? { ...c, deck_role: null } : c)),
    );
    startTransition(async () => {
      const res = await removeDeckMember(deckId, userId);
      if (!res.ok) {
        setCandidates((prev) =>
          prev.map((c) =>
            c.user_id === userId ? { ...c, deck_role: previous } : c,
          ),
        );
        setError(`Couldn't remove member: ${res.error}`);
      }
    });
  };

  const handleInviteGuest = () => {
    const email = guestEmail.trim();
    if (!email) return;
    setError(null);
    setGuestNotice(null);
    startTransition(async () => {
      const res = await inviteGuestToDeck(deckId, email, guestRole);
      if (res.ok) {
        setGuestEmail("");
        // Refetch so the new pending invite shows up under "People with access".
        const next = await getDeckShareState(deckId);
        if (next.ok) setGuestInvites(next.guestInvites);
        setGuestNotice(
          res.warning ?? `Invite sent to ${email}. They'll get an email link.`,
        );
      } else {
        setError(`Couldn't send invite: ${res.error}`);
      }
    });
  };

  const handleRevokeGuest = (inviteId: string) => {
    setError(null);
    setGuestNotice(null);
    const previous = guestInvites;
    setGuestInvites((prev) => prev.filter((g) => g.id !== inviteId));
    startTransition(async () => {
      const res = await revokeGuestInvite(deckId, inviteId);
      if (!res.ok) {
        setGuestInvites(previous);
        setError(`Couldn't revoke invite: ${res.error}`);
      }
    });
  };

  return (
    // `pointer-events-auto` makes the dialog immune to ancestors that disable
    // pointer events (e.g. the deck-list row cluster uses `pointer-events-none`
    // so the stretched link receives clicks behind the badges; the dialog
    // mounts there as a sibling of the chip button, so without an explicit
    // override it would inherit `none` and reject every click inside).
    <div
      className="pointer-events-auto fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Share deck"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        // Cap the dialog to the dynamic viewport and lay out as a column so the
        // middle section can scroll internally (below) — that keeps the header
        // and the Done footer reachable on short mobile screens with long
        // member/invite lists.
        className="flex max-h-[85dvh] w-full max-w-lg flex-col overflow-hidden rounded-[14px] border border-border bg-card shadow-2xl"
      >
        <div className="border-b border-border px-5 py-4">
          <h2 className="text-base font-semibold">Share deck</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Workspace admins always have access. Members lose access when removed
            from the workspace.
          </p>
        </div>

        {/* Scrollable middle: flex-1 + overflow-y-auto so the dialog body
            scrolls within the capped height instead of pushing the footer off
            a short mobile screen. */}
        <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4">
          <fieldset className="space-y-2">
            <legend className="text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">
              Visibility
            </legend>
            {visibility === null ? (
              <div
                aria-hidden
                className="h-[72px] animate-pulse rounded-[10px] bg-muted/40"
              />
            ) : (
              <div className="grid gap-2 sm:grid-cols-2">
                <VisibilityCard
                  checked={visibility === "workspace"}
                  label="Workspace"
                  description="Everyone in this workspace can view and edit."
                  onClick={() => handleVisibility("workspace")}
                  disabled={isPending}
                />
                <VisibilityCard
                  checked={visibility === "private"}
                  label="Private"
                  description="Only invited people (plus admins) can access."
                  onClick={() => handleVisibility("private")}
                  disabled={isPending}
                />
              </div>
            )}
          </fieldset>

          {/* Public link — independent of workspace/private visibility, exactly
           * like Google Slides' "General access". Anyone holding the link can
           * view (read-only, no sign-in). Only managers can toggle/reset it;
           * everyone who can open the dialog sees the current state. */}
          <div className="space-y-2 border-t border-border pt-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                  Anyone with the link
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {publicEnabled
                    ? "Anyone with the link can view this deck — no sign-in needed. View only."
                    : "Create a link so people outside the workspace can view this deck without signing in."}
                </p>
              </div>
              {visibility === null ? (
                <div
                  aria-hidden
                  className="h-5 w-9 shrink-0 animate-pulse rounded-full bg-muted/50"
                />
              ) : canManagePublicShare ? (
                <ToggleSwitch
                  checked={publicEnabled}
                  onChange={handleTogglePublic}
                  disabled={isPending}
                  label="Anyone with the link can view"
                />
              ) : (
                <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                  {publicEnabled ? "On" : "Off"}
                </span>
              )}
            </div>

            {publicEnabled && publicUrl ? (
              <div className="space-y-1.5">
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    readOnly
                    value={publicUrl}
                    onFocus={(e) => e.currentTarget.select()}
                    aria-label="Public view link"
                    className="min-w-0 flex-1 rounded-[8px] border border-border bg-muted/40 px-3 py-1.5 text-xs text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  />
                  <Button type="button" size="sm" onClick={handleCopyPublic}>
                    {copied ? "Copied" : "Copy link"}
                  </Button>
                </div>
                {/* Guest comments — the talk-back channel on the same link.
                 * Off by default; the primary abuse kill-switch is right here
                 * next to the link it guards. */}
                <div className="flex items-start justify-between gap-3 pt-1">
                  <div className="min-w-0">
                    <p className="text-xs font-medium text-foreground">
                      Visitors can comment
                    </p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      People with the link can leave per-slide feedback with
                      their name — it lands in this deck&apos;s comments.
                    </p>
                  </div>
                  {canManagePublicShare ? (
                    <ToggleSwitch
                      checked={publicCommentsEnabled}
                      onChange={handleToggleComments}
                      disabled={isPending}
                      label="Visitors can comment"
                    />
                  ) : (
                    <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                      {publicCommentsEnabled ? "On" : "Off"}
                    </span>
                  )}
                </div>
                <div className="flex items-center justify-between gap-2">
                  {canManagePublicShare ? (
                    <button
                      type="button"
                      onClick={handleRotatePublic}
                      disabled={isPending}
                      title="Generate a new link and disable the old one"
                      className="text-xs text-muted-foreground underline-offset-2 transition-colors hover:text-foreground hover:underline disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      Reset link
                    </button>
                  ) : (
                    <span />
                  )}
                  {/* The DocSend line: glanceable engagement at the moment of
                   * sending. Zero opens reads as encouragement, not absence. */}
                  <a
                    href={`/canvases/${deckId}/engagement`}
                    className="text-xs tabular-nums text-muted-foreground underline-offset-2 transition-colors hover:text-foreground hover:underline"
                    title="Open the engagement report"
                  >
                    {publicOpens > 0 && publicLastOpenedAt
                      ? `${publicOpens} ${publicOpens === 1 ? "open" : "opens"} · last opened ${relativeDate(publicLastOpenedAt)}`
                      : "No opens yet"}
                  </a>
                </div>
              </div>
            ) : null}
          </div>

          {visibility === "private" ? (
            <div className="space-y-4">
              <div className="space-y-1.5">
                <label className="text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                  People with access
                </label>
                {loading ? (
                  <p className="text-xs text-muted-foreground">Loading…</p>
                ) : (
                  <div className="space-y-1 overflow-hidden rounded-[10px] border border-border">
                    {withAccess.length === 0 && guestInvites.length === 0 ? (
                      <p className="px-3 py-4 text-center text-xs text-muted-foreground">
                        No one yet — invite someone below.
                      </p>
                    ) : (
                      <>
                        {withAccess.map((c) => (
                          <MemberRow
                            key={c.user_id}
                            candidate={c}
                            disabled={isPending}
                            isSelf={c.user_id === currentUserId}
                            onAdd={(role) => handleAdd(c.user_id, role)}
                            onRoleChange={(role) =>
                              handleRoleChange(c.user_id, role)
                            }
                            onRemove={() => handleRemove(c.user_id)}
                          />
                        ))}
                        {guestInvites.map((g) => (
                          <GuestInviteRow
                            key={g.id}
                            invite={g}
                            disabled={isPending}
                            canManage={canManage}
                            onRevoke={() => handleRevokeGuest(g.id)}
                          />
                        ))}
                      </>
                    )}
                  </div>
                )}
              </div>

              <div className="space-y-1.5">
                <label className="text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                  Add from this workspace
                </label>
                <input
                  type="text"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Name or email"
                  // text-base on mobile so iOS Safari doesn't zoom on focus; 14px on sm+.
                  className="block w-full rounded-[8px] border border-border bg-background px-3 py-1.5 text-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:text-sm"
                />
                {loading ? (
                  <p className="text-xs text-muted-foreground">Loading members…</p>
                ) : (
                  <div className="max-h-[220px] space-y-1 overflow-y-auto rounded-[10px] border border-border">
                    {addable.length === 0 ? (
                      <p className="px-3 py-4 text-center text-xs text-muted-foreground">
                        {query.trim()
                          ? "No matches."
                          : "Everyone in this workspace already has access."}
                      </p>
                    ) : (
                      addable.map((c) => (
                        <MemberRow
                          key={c.user_id}
                          candidate={c}
                          disabled={isPending}
                          isSelf={c.user_id === currentUserId}
                          onAdd={(role) => handleAdd(c.user_id, role)}
                          onRoleChange={(role) =>
                            handleRoleChange(c.user_id, role)
                          }
                          onRemove={() => handleRemove(c.user_id)}
                        />
                      ))
                    )}
                  </div>
                )}
              </div>

              {canManage ? (
                <div className="space-y-1.5 border-t border-border pt-3">
                  <label className="text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                    Invite someone outside 21x
                  </label>
                  <p className="text-xs text-muted-foreground">
                    They get an email link and can view + comment on this deck
                    only — not the rest of the workspace.
                  </p>
                  {/* Stack the invite controls on mobile: the email field gets
                      its own full-width row, then the role select + Invite
                      button share a row. On sm+ everything sits inline as
                      before. */}
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                    <input
                      type="email"
                      value={guestEmail}
                      onChange={(e) => setGuestEmail(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          handleInviteGuest();
                        }
                      }}
                      placeholder="name@company.com"
                      // text-base on mobile so iOS Safari doesn't zoom on focus; 14px on sm+.
                      className="min-w-0 flex-1 rounded-[8px] border border-border bg-background px-3 py-1.5 text-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:text-sm"
                    />
                    <div className="flex items-center gap-2">
                      <select
                        value={guestRole}
                        onChange={(e) =>
                          setGuestRole(e.target.value as DeckMemberRole)
                        }
                        disabled={isPending}
                        aria-label="Reviewer access level"
                        // text-base on mobile (avoids iOS zoom); flex-1 so it fills the row width next to the button.
                        className="flex-1 rounded-[6px] border border-border bg-background px-2 py-1.5 text-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 sm:flex-none sm:text-xs"
                      >
                        <option value="viewer">Viewer</option>
                        <option value="editor">Editor</option>
                      </select>
                      <Button
                        type="button"
                        size="sm"
                        onClick={handleInviteGuest}
                        disabled={isPending || !guestEmail.trim()}
                      >
                        Invite
                      </Button>
                    </div>
                  </div>
                  {guestNotice ? (
                    <p className="text-xs text-muted-foreground">
                      {guestNotice}
                    </p>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : null}

          {error ? (
            <div className="rounded-[10px] border border-[color:var(--danger)]/30 bg-[color:var(--danger)]/5 px-3 py-2 text-xs text-[color:var(--danger)]">
              {error}
            </div>
          ) : null}
        </div>

        {/* shrink-0 keeps the footer pinned below the scroll region; pb-safe
            clears the iPhone home indicator when the dialog reaches the bottom
            of the screen on a tall (85dvh) mobile layout. */}
        <div className="flex shrink-0 items-center justify-end gap-2 border-t border-border bg-muted/30 px-5 py-3 pb-safe sm:pb-3">
          <Button type="button" variant="ghost" onClick={onClose}>
            Done
          </Button>
        </div>
      </div>
    </div>
  );
}

function VisibilityCard({
  checked,
  label,
  description,
  onClick,
  disabled,
}: {
  checked: boolean;
  label: string;
  description: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={checked}
      className={cn(
        "flex items-start gap-2 rounded-[10px] border bg-card p-3 text-left text-sm transition-colors",
        checked
          ? "border-ring bg-mist/60"
          : "border-border hover:border-ring/40",
        disabled && "cursor-not-allowed opacity-60",
      )}
    >
      <span
        aria-hidden
        className={cn(
          "mt-0.5 inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border",
          checked ? "border-foreground bg-foreground" : "border-border",
        )}
      >
        {checked ? <span className="h-1.5 w-1.5 rounded-full bg-card" /> : null}
      </span>
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="font-medium">{label}</span>
        <span className="text-xs text-muted-foreground">{description}</span>
      </span>
    </button>
  );
}

// Accessible on/off switch (role="switch"). Used for the public-link toggle —
// the only true boolean control in the dialog, so it lives here rather than in
// a shared ui/ component until a second caller appears.
function ToggleSwitch({
  checked,
  onChange,
  disabled,
  label,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card",
        checked ? "bg-foreground" : "bg-muted-foreground/30",
        disabled && "cursor-not-allowed opacity-50",
      )}
    >
      <span
        aria-hidden
        className={cn(
          "inline-block h-4 w-4 transform rounded-full bg-card shadow transition-transform",
          checked ? "translate-x-[18px]" : "translate-x-0.5",
        )}
      />
    </button>
  );
}

function MemberRow({
  candidate,
  disabled,
  isSelf,
  onAdd,
  onRoleChange,
  onRemove,
}: {
  candidate: DeckShareCandidate;
  disabled?: boolean;
  isSelf: boolean;
  onAdd: (role: DeckMemberRole) => void;
  onRoleChange: (role: DeckMemberRole) => void;
  onRemove: () => void;
}) {
  const label = candidate.name?.trim() || candidate.email || "Unknown user";
  const isAdmin =
    candidate.workspace_role === "owner" || candidate.workspace_role === "admin";
  // An accepted outside reviewer (workspace_role 'guest' with a deck grant).
  // Flag it so the inviter doesn't mistake them for an internal teammate.
  const isGuest = candidate.workspace_role === "guest";
  const roleLocked = Boolean(candidate.deck_role && isSelf);

  return (
    <div className="flex items-center justify-between gap-3 border-b border-border/60 px-3 py-2 last:border-b-0">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 truncate text-sm text-foreground">
          <span className="truncate font-medium">{label}</span>
          {isAdmin ? (
            <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
              {candidate.workspace_role}
            </span>
          ) : null}
          {isGuest ? (
            <span
              title="Outside reviewer — only has access to this deck"
              className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground"
            >
              Guest
            </span>
          ) : null}
          {isSelf ? (
            <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
              (you)
            </span>
          ) : null}
        </div>
        {candidate.name && candidate.email ? (
          <div className="truncate text-xs text-muted-foreground">
            {candidate.email}
          </div>
        ) : null}
      </div>

      <div className="flex items-center gap-2">
        {candidate.deck_role ? (
          <>
            <select
              value={candidate.deck_role}
              onChange={(e) =>
                onRoleChange(e.target.value as DeckMemberRole)
              }
              disabled={disabled || roleLocked}
              title={roleLocked ? "You can't change your own deck role" : undefined}
              className="rounded-[6px] border border-border bg-background px-2 py-1 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
            >
              <option value="viewer">Viewer</option>
              <option value="editor">Editor</option>
            </select>
            <button
              type="button"
              onClick={onRemove}
              disabled={disabled || isSelf}
              title={isSelf ? "You can't remove yourself" : "Remove from deck"}
              className="text-xs text-muted-foreground transition-colors hover:text-[color:var(--danger)] disabled:cursor-not-allowed disabled:opacity-50"
            >
              Remove
            </button>
          </>
        ) : isAdmin ? (
          <span className="text-xs text-muted-foreground">Always has access</span>
        ) : (
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => onAdd("viewer")}
              disabled={disabled}
              className="rounded-[6px] border border-border bg-background px-2 py-1 text-xs text-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
            >
              + Viewer
            </button>
            <button
              type="button"
              onClick={() => onAdd("editor")}
              disabled={disabled}
              className="rounded-[6px] border border-border bg-background px-2 py-1 text-xs text-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
            >
              + Editor
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// A pending outside-reviewer invite: shown under "People with access" so the
// inviter sees it's in flight, with a Revoke affordance for managers.
function GuestInviteRow({
  invite,
  disabled,
  canManage,
  onRevoke,
}: {
  invite: DeckGuestInvite;
  disabled?: boolean;
  canManage: boolean;
  onRevoke: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-border/60 px-3 py-2 last:border-b-0">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 truncate text-sm text-foreground">
          <span className="truncate font-medium">{invite.email}</span>
          <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
            Guest
          </span>
        </div>
        <div className="truncate text-xs text-muted-foreground">
          Invited as {invite.deck_role} · pending
        </div>
      </div>

      {canManage ? (
        <button
          type="button"
          onClick={onRevoke}
          disabled={disabled}
          title="Revoke invite"
          className="text-xs text-muted-foreground transition-colors hover:text-[color:var(--danger)] disabled:cursor-not-allowed disabled:opacity-50"
        >
          Revoke
        </button>
      ) : null}
    </div>
  );
}

"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  createWorkspaceAction,
  setActiveWorkspaceAction,
} from "@/lib/auth/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { ListboxSurface } from "@/components/ui/menu-surface";

type Workspace = {
  id: string;
  name: string;
  slug: string;
  role: "owner" | "admin" | "member" | "guest";
};

const CREATE_ERROR_COPY: Record<string, string> = {
  name_required: "Workspace name is required.",
  name_too_long: "Workspace name must be 60 characters or fewer.",
  not_authenticated: "Your session expired — sign in again.",
};

// Workspace names often start with digits or numerals ("21x Ventures"), and a
// single-character avatar then looks like a count badge. Strip leading digits
// and punctuation, then take the first letter of up to two words.
function workspaceInitials(name: string): string {
  const cleaned = name.replace(/^[\d\s\p{P}\p{S}]+/u, "").trim();
  const source = cleaned || name.trim();
  const words = source.split(/\s+/).filter(Boolean);
  const letters = words
    .slice(0, 2)
    .map((w) => w[0])
    .filter(Boolean)
    .join("");
  if (letters.length >= 2) return letters.toUpperCase();
  if (letters.length === 1 && words[0] && words[0].length >= 2) {
    return words[0].slice(0, 2).toUpperCase();
  }
  if (letters.length === 1) return letters.toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

function ChevronDown({ className }: { className?: string }) {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 10 10"
      fill="none"
      aria-hidden
      className={className}
    >
      <path
        d="M2.25 3.75L5 6.25L7.75 3.75"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function Check({ className }: { className?: string }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 12 12"
      fill="none"
      aria-hidden
      className={className}
    >
      <path
        d="M2.5 6.25L4.75 8.5L9.5 3.75"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function Plus({ className }: { className?: string }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 12 12"
      fill="none"
      aria-hidden
      className={className}
    >
      <path
        d="M6 2.5V9.5M2.5 6H9.5"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function WorkspaceSwitcher({
  workspaces,
  activeId,
}: {
  workspaces: Workspace[];
  activeId: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [createOpen, setCreateOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onClickOutside(e: MouseEvent) {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false);
    }
    function onEscape(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onClickOutside);
    document.addEventListener("keydown", onEscape);
    return () => {
      document.removeEventListener("mousedown", onClickOutside);
      document.removeEventListener("keydown", onEscape);
    };
  }, [open]);

  const active = workspaces.find((w) => w.id === activeId) ?? workspaces[0];
  // A deck-scoped guest is an outside reviewer; nudging them to spin up their
  // own workspace is noise. Hide the create affordance for them.
  const isGuest = active?.role === "guest";

  function handleSelect(id: string) {
    if (id === activeId) {
      setOpen(false);
      return;
    }
    setError(null);
    startTransition(async () => {
      const result = await setActiveWorkspaceAction(id);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setOpen(false);
      // Route may be scoped to the previous workspace (e.g. a deck the user
      // can no longer see) — land them on the workspace's deck list.
      router.push("/canvases");
    });
  }

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="listbox"
        className={cn(
          "group flex h-8 items-center gap-1.5 rounded-md border border-transparent px-2.5 text-[13px] font-medium text-foreground transition-all hover:border-border hover:bg-paper hover:shadow-[0_1px_2px_rgba(14,26,43,0.04)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          open &&
            "border-border bg-paper shadow-[0_1px_2px_rgba(14,26,43,0.04)]",
        )}
      >
        <span className="truncate max-w-[120px] sm:max-w-[180px]">{active?.name ?? "Workspace"}</span>
        <ChevronDown
          className={cn(
            "text-steel transition-transform duration-150",
            open ? "rotate-180" : "group-hover:translate-y-px",
          )}
        />
      </button>

      {open && (
        <ListboxSurface
          onClose={() => setOpen(false)}
          // Cap at the viewport width (minus a 1.5rem gutter) so the
          // left-anchored panel can't clip past the right edge on a narrow
          // phone; falls back to the full 18rem (w-72) wherever it fits.
          className="absolute left-0 top-full z-50 mt-2 w-[min(18rem,calc(100vw-1.5rem))] origin-top-left animate-in fade-in slide-in-from-top-1 duration-150 rounded-lg border border-border bg-paper p-1 shadow-[0_10px_30px_-12px_rgba(14,26,43,0.22),0_2px_6px_-2px_rgba(14,26,43,0.08)]"
        >
          <div className="px-2 pb-1 pt-1.5 text-[9px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
            Switch workspace
          </div>
          <div className="flex flex-col">
            {workspaces.map((w) => {
              const isActive = w.id === activeId;
              return (
                <button
                  key={w.id}
                  type="button"
                  role="option"
                  aria-selected={isActive}
                  onClick={() => handleSelect(w.id)}
                  disabled={pending}
                  className={cn(
                    "flex w-full items-center gap-3 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-fog focus-visible:outline-none focus-visible:bg-fog disabled:cursor-default",
                    pending && "opacity-60",
                  )}
                >
                  <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-fog text-[11px] font-semibold tracking-tight text-foreground ring-1 ring-inset ring-border">
                    {workspaceInitials(w.name)}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] font-medium text-foreground">
                      {w.name}
                    </div>
                    <div className="text-[9px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                      {w.role}
                    </div>
                  </div>
                  <div className="flex h-4 w-4 items-center justify-center">
                    {isActive && <Check className="text-brand" />}
                  </div>
                </button>
              );
            })}
          </div>
          {error && (
            <div className="mx-2 mb-1 mt-2 rounded-md border border-destructive/30 bg-destructive/5 px-2 py-1.5 text-[11px] text-destructive">
              {error === "not_a_member"
                ? "You no longer have access to that workspace."
                : "Couldn't switch workspaces — please try again."}
            </div>
          )}

          {/* Divider + "New workspace" affordance. Opens the create modal,
              which lives outside the dropdown so click-outside dismissal
              on the dropdown doesn't take the modal down with it. Hidden for
              guests (outside reviewers). */}
          {!isGuest && (
            <>
              <div className="mx-2 my-1 border-t border-border" />
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  setCreateOpen(true);
                }}
                className="flex w-full items-center gap-3 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-fog focus-visible:outline-none focus-visible:bg-fog"
              >
                <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-fog text-muted-foreground ring-1 ring-inset ring-border">
                  <Plus />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] font-medium text-foreground">
                    New workspace
                  </div>
                  <div className="text-[10px] text-muted-foreground">
                    You become the Owner
                  </div>
                </div>
              </button>
            </>
          )}
        </ListboxSurface>
      )}

      <CreateWorkspaceModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={() => {
          setCreateOpen(false);
          // The action set the active-workspace cookie + revalidated the
          // layout — refresh and bounce to /canvases (matches the switcher's
          // existing post-select behavior, and avoids landing on a deck the
          // new workspace doesn't have).
          router.refresh();
          router.push("/canvases");
        }}
      />
    </div>
  );
}

// Centered modal hosting the create-workspace form. Same dismissal
// affordances as the deck-workspace ConfirmDialog (Escape, backdrop click,
// focus management). Inline here rather than in a shared component to keep
// the topbar self-contained.
function CreateWorkspaceModal({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset transient state on the open->closed edge. Adjusting state during
  // render (compared against a previous-prop snapshot) avoids the
  // react-hooks/set-state-in-effect lint rule that bans setState inside an
  // effect body.
  const [wasOpen, setWasOpen] = useState(open);
  if (wasOpen !== open) {
    setWasOpen(open);
    if (!open) {
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

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    setPending(true);
    setError(null);
    const fd = new FormData(form);
    const result = await createWorkspaceAction(fd);
    if (!result.ok) {
      setError(CREATE_ERROR_COPY[result.error] ?? result.error);
      setPending(false);
      return;
    }
    setPending(false);
    onCreated();
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="create-workspace-modal-title"
      className="fixed inset-0 z-50 flex items-center justify-center px-4"
    >
      <button
        type="button"
        aria-label="Close create workspace dialog"
        onClick={() => (pending ? undefined : onClose())}
        className="absolute inset-0 bg-foreground/40 backdrop-blur-[1px]"
      />
      <div className="relative w-full max-w-md rounded-[12px] border border-border bg-card shadow-2xl">
        <header className="border-b border-border px-5 py-4">
          <h2
            id="create-workspace-modal-title"
            className="text-base font-semibold text-foreground"
          >
            New workspace
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">
            You&rsquo;ll be the Owner. Invite teammates from Settings →
            Members after.
          </p>
        </header>
        <form onSubmit={handleSubmit} className="space-y-4 px-5 py-4">
          <div className="space-y-1.5">
            <label
              htmlFor="topbar-create-workspace-input"
              className="text-xs font-medium text-foreground"
            >
              Workspace name
            </label>
            <Input
              id="topbar-create-workspace-input"
              ref={inputRef}
              name="name"
              required
              maxLength={60}
              placeholder="Acme Inc."
              disabled={pending}
            />
          </div>
          {error && (
            <p className="text-xs text-destructive" role="alert">
              {error}
            </p>
          )}
          <div className="flex items-center justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onClose}
              disabled={pending}
            >
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={pending}>
              {pending ? "Creating…" : "Create workspace"}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}

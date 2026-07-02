"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  deleteWorkspaceAction,
  renameWorkspaceAction,
  setSelfApprovalAction,
} from "@/lib/auth/actions";
import type { WorkspaceRole } from "@/lib/auth/workspace";
import { cn } from "@/lib/utils";

const RENAME_ERROR_COPY: Record<string, string> = {
  name_required: "Workspace name is required.",
  name_too_long: "Workspace name must be 60 characters or fewer.",
  not_authorized: "Only Admins and Owners can rename the workspace.",
};

const DELETE_ERROR_COPY: Record<string, string> = {
  not_authorized: "Only the Owner can delete the workspace.",
};

// WorkspaceForm renders the two sections of /settings/workspace: identity
// (name + slug, rename for admin/owner) and the owner-only danger zone
// (delete). Splitting them into two sections in one client component keeps
// the page's server boundary minimal — just data fetch + role gate.
export function WorkspaceForm({
  name,
  slug,
  role,
  allowSelfApproval,
}: {
  name: string;
  slug: string;
  role: WorkspaceRole;
  allowSelfApproval: boolean;
}) {
  const canRename = role === "owner" || role === "admin";
  const canManage = role === "owner" || role === "admin";
  const canDelete = role === "owner";

  return (
    <>
      <section className="rounded-[12px] border border-border bg-card p-6 space-y-4">
        <div className="eyebrow">Workspace</div>
        {canRename ? (
          <RenameInline name={name} slug={slug} />
        ) : (
          <ReadonlyIdentity name={name} slug={slug} />
        )}
      </section>

      <section className="rounded-[12px] border border-border bg-card p-6 space-y-4">
        <div className="eyebrow">Proposals</div>
        <SelfApprovalBlock
          allowSelfApproval={allowSelfApproval}
          canManage={canManage}
        />
      </section>

      {canDelete && (
        <section className="rounded-[12px] border border-destructive/30 bg-card p-6 space-y-3">
          <div className="eyebrow text-destructive">Danger zone</div>
          <DeleteWorkspaceBlock name={name} />
        </section>
      )}
    </>
  );
}

function ReadonlyIdentity({ name, slug }: { name: string; slug: string }) {
  return (
    <dl className="grid grid-cols-[6rem_1fr] gap-x-4 gap-y-2 text-sm">
      <dt className="text-muted-foreground">Name</dt>
      <dd className="font-medium text-foreground">{name}</dd>
      <dt className="text-muted-foreground">Slug</dt>
      <dd className="font-mono text-xs text-foreground">{slug}</dd>
    </dl>
  );
}

function RenameInline({ name, slug }: { name: string; slug: string }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(name);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function startEditing() {
    setValue(name);
    setError(null);
    setEditing(true);
  }

  function cancel() {
    setEditing(false);
    setError(null);
    setValue(name);
  }

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    setPending(true);
    setError(null);
    const fd = new FormData(form);
    const result = await renameWorkspaceAction(fd);
    setPending(false);
    if (!result.ok) {
      setError(RENAME_ERROR_COPY[result.error] ?? result.error);
      return;
    }
    setEditing(false);
    router.refresh();
  }

  if (!editing) {
    return (
      <div className="flex items-start justify-between gap-4">
        <dl className="grid grid-cols-[6rem_1fr] gap-x-4 gap-y-2 text-sm">
          <dt className="text-muted-foreground">Name</dt>
          <dd className="font-medium text-foreground">{name}</dd>
          <dt className="text-muted-foreground">Slug</dt>
          <dd className="font-mono text-xs text-foreground">{slug}</dd>
        </dl>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={startEditing}
        >
          Rename
        </Button>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      <div className="space-y-1.5">
        <label
          htmlFor="workspace-rename-input"
          className="text-xs font-medium text-foreground"
        >
          Workspace name
        </label>
        <Input
          id="workspace-rename-input"
          name="name"
          autoFocus
          required
          maxLength={60}
          defaultValue={value}
          disabled={pending}
        />
        <p className="text-[11px] text-muted-foreground">
          Slug stays as{" "}
          <code className="font-mono text-foreground">{slug}</code> — slugs are
          immutable once a workspace exists.
        </p>
      </div>
      <div className="flex items-center gap-2">
        <Button type="submit" size="sm" disabled={pending}>
          {pending ? "Saving…" : "Save"}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={cancel}
          disabled={pending}
        >
          Cancel
        </Button>
      </div>
      {error && (
        <p className="text-xs text-destructive" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}

// Self-approval opt-in. Off by default: a member's proposal needs a teammate
// (or admin) to approve it. On: any member can approve/reject their own
// proposals. The slide/deck RLS still gates the underlying write, so this only
// removes the "needs a second reviewer" requirement. Admin/owner-only to
// change; members see the current state read-only.
function SelfApprovalBlock({
  allowSelfApproval,
  canManage,
}: {
  allowSelfApproval: boolean;
  canManage: boolean;
}) {
  const router = useRouter();
  // Optimistic local state. On success the value already equals what the
  // server returns; on error we revert. (We deliberately don't sync from the
  // prop in an effect — that trips react-hooks/set-state-in-effect and the
  // optimistic path keeps this in step; a full navigation re-seeds it.)
  const [enabled, setEnabled] = useState(allowSelfApproval);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleToggle(next: boolean) {
    if (!canManage || pending) return;
    setPending(true);
    setError(null);
    setEnabled(next); // optimistic
    const result = await setSelfApprovalAction(next);
    setPending(false);
    if (!result.ok) {
      setEnabled(!next); // revert
      setError(
        result.error === "not_authorized"
          ? "Only Admins and Owners can change this."
          : result.error,
      );
      return;
    }
    router.refresh();
  }

  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <p className="text-sm font-medium text-foreground">
            Members can approve their own proposals
          </p>
          <p className="text-xs text-muted-foreground">
            {enabled
              ? "Any member can approve or reject their own pending proposals on slides they can edit."
              : "A member's proposal needs another member or an admin to approve it. Admins and owners can always approve their own."}
          </p>
        </div>
        <ToggleSwitch
          checked={enabled}
          onChange={handleToggle}
          disabled={!canManage || pending}
          label="Members can approve their own proposals"
        />
      </div>
      {!canManage && (
        <p className="text-[11px] text-muted-foreground">
          Only Admins and Owners can change this setting.
        </p>
      )}
      {error && (
        <p className="text-xs text-destructive" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

// Local copy of the share-dialog ToggleSwitch so this page doesn't pull the
// editor bundle (same rationale as the inlined ConfirmDialog below).
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

function DeleteWorkspaceBlock({ name }: { name: string }) {
  const router = useRouter();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleDelete() {
    setPending(true);
    setError(null);
    const result = await deleteWorkspaceAction();
    if (!result.ok) {
      setError(DELETE_ERROR_COPY[result.error] ?? result.error);
      setPending(false);
      return;
    }
    // On success the cookie has been cleared; refresh so the next request
    // resolves the user's remaining membership (or routes to /no-workspace).
    router.refresh();
    router.push("/no-workspace");
  }

  return (
    <>
      <p className="text-sm text-muted-foreground">
        Permanently delete{" "}
        <strong className="font-medium text-foreground">{name}</strong>. All
        decks, slides, versions, snapshots, comments, and storage assets in
        this workspace are removed. This cannot be undone.
      </p>
      <Button
        type="button"
        variant="destructive"
        size="sm"
        onClick={() => setConfirmOpen(true)}
        disabled={pending}
      >
        Delete workspace
      </Button>
      {error && (
        <p className="text-xs text-destructive" role="alert">
          {error}
        </p>
      )}
      <ConfirmDialog
        open={confirmOpen}
        title="Delete workspace?"
        body={`"${name}" and everything inside it — decks, comments, snapshots, members — is removed forever.`}
        confirmLabel="Delete workspace"
        pending={pending}
        onCancel={() => setConfirmOpen(false)}
        onConfirm={() => {
          setConfirmOpen(false);
          void handleDelete();
        }}
      />
    </>
  );
}

// Local copy of the destructive confirm pattern from deck-workspace.tsx.
// Inlined here so /settings/workspace doesn't pull the whole editor bundle.
function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel,
  pending = false,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  body: string;
  confirmLabel: string;
  pending?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const previouslyFocused =
      typeof document !== "undefined"
        ? (document.activeElement as HTMLElement | null)
        : null;
    cancelRef.current?.focus();
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
      if (e.key === "Escape") onCancel();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onCancel]);

  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-delete-workspace"
      className="fixed inset-0 z-50 flex items-center justify-center px-4"
    >
      <button
        type="button"
        aria-label="Cancel"
        onClick={onCancel}
        className="absolute inset-0 bg-foreground/40 backdrop-blur-[1px]"
      />
      <div className="relative w-full max-w-md rounded-[12px] border border-border bg-card shadow-2xl">
        <header className="border-b border-border px-5 py-4">
          <h2
            id="confirm-delete-workspace"
            className="text-base font-semibold text-foreground"
          >
            {title}
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">{body}</p>
        </header>
        <div className="flex items-center justify-end gap-2 px-5 py-4">
          <Button
            ref={cancelRef}
            type="button"
            variant="ghost"
            size="sm"
            onClick={onCancel}
            disabled={pending}
          >
            Cancel
          </Button>
          <Button
            type="button"
            size="sm"
            variant="destructive"
            onClick={onConfirm}
            disabled={pending}
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}

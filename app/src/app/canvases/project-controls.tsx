"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, FolderPlus, Pencil, Share2, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { DialogShell } from "@/components/dialog-shell";
import { ShareProjectDialog } from "./share-project-dialog";
import {
  createProject,
  deleteProject,
  renameProject,
  setDeckProject,
} from "./project-actions";

// Client affordances for Canvas Projects on the /canvases index:
//   - NewProjectButton    — header button, opens a name dialog → createProject
//   - ProjectRowActions   — rename / delete on a project section header
//   - ProjectMoveDialog   — "move deck to project" picker, opened from the
//                           per-row ⋯ menu (deck-row-menu.tsx)
//
// All three are dialogs (the shared DialogShell, same shell ConfirmDialog
// uses) rather than anchored dropdowns: the deck rows live inside
// overflow-hidden <ul>s, which would clip an absolutely-positioned menu. The
// server re-checks permissions on every action — these components only
// decide what's worth showing.

export type ProjectOption = { id: string; name: string };

// Name dialog used by both create and rename — submits on Enter, surfaces the
// server error inline (e.g. the unique-name violation) instead of closing.
function ProjectNameDialog({
  title,
  confirmLabel,
  initialName,
  onSubmit,
  onClose,
}: {
  title: string;
  confirmLabel: string;
  initialName?: string;
  onSubmit: (name: string) => Promise<{ ok: true } | { ok: false; error: string }>;
  onClose: () => void;
}) {
  const [name, setName] = useState(initialName ?? "");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function submit() {
    if (!name.trim() || isPending) return;
    setError(null);
    startTransition(async () => {
      const result = await onSubmit(name);
      if (result.ok) onClose();
      else setError(result.error);
    });
  }

  return (
    <DialogShell title={title} onClose={onClose}>
      <form
        className="space-y-3 px-5 py-4"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Acme proposal"
          maxLength={120}
        />
        {error && (
          <p className="text-xs text-[color:var(--danger)]">{error}</p>
        )}
        <div className="flex items-center justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" size="sm" onClick={onClose} disabled={isPending}>
            Cancel
          </Button>
          <Button type="submit" size="sm" disabled={isPending || !name.trim()}>
            {confirmLabel}
          </Button>
        </div>
      </form>
    </DialogShell>
  );
}

export function NewProjectButton({ workspaceId }: { workspaceId: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        <FolderPlus aria-hidden className="mr-1.5 h-3.5 w-3.5" />
        New project
      </Button>
      {open && (
        <ProjectNameDialog
          title="New project"
          confirmLabel="Create project"
          onSubmit={(name) => createProject(workspaceId, name)}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

// Share affordance on a project header. Shown to everyone who can see the
// project (the dialog gates management server-side, exactly like the deck row's
// "Share…"). On close we router.refresh() so a visibility change — which
// revalidates /canvases server-side — re-renders the grouped list.
export function ProjectShareButton({
  projectId,
  projectName,
  currentUserId,
}: {
  projectId: string;
  projectName: string;
  currentUserId: string | null;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);

  const iconButton =
    "inline-flex h-7 w-7 items-center justify-center rounded-[6px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

  return (
    <>
      <button
        type="button"
        title="Share project"
        aria-label={`Share ${projectName}`}
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
        className={iconButton}
      >
        <Share2 aria-hidden className="h-3.5 w-3.5" />
      </button>
      <ShareProjectDialog
        open={open}
        projectId={projectId}
        projectName={projectName}
        currentUserId={currentUserId}
        onClose={() => {
          setOpen(false);
          router.refresh();
        }}
      />
    </>
  );
}

export function ProjectRowActions({
  projectId,
  projectName,
}: {
  projectId: string;
  projectName: string;
}) {
  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const iconButton =
    "inline-flex h-7 w-7 items-center justify-center rounded-[6px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

  return (
    <span className="flex items-center gap-1">
      <button
        type="button"
        title="Rename project"
        aria-label={`Rename ${projectName}`}
        onClick={() => setRenaming(true)}
        className={iconButton}
      >
        <Pencil aria-hidden className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        title="Delete project"
        aria-label={`Delete ${projectName}`}
        onClick={() => {
          setDeleteError(null);
          setDeleting(true);
        }}
        className={`${iconButton} hover:bg-[color:var(--danger)]/10 hover:text-[color:var(--danger)]`}
      >
        <Trash2 aria-hidden className="h-3.5 w-3.5" />
      </button>

      {renaming && (
        <ProjectNameDialog
          title="Rename project"
          confirmLabel="Rename"
          initialName={projectName}
          onSubmit={(name) => renameProject(projectId, name)}
          onClose={() => setRenaming(false)}
        />
      )}

      <ConfirmDialog
        open={deleting}
        title="Delete project?"
        body={
          deleteError
            ? `Delete failed: ${deleteError}`
            : `"${projectName}" is removed. Its decks are NOT deleted — they move back to the ungrouped list.`
        }
        confirmLabel="Delete project"
        destructive
        pending={isPending}
        onCancel={() => setDeleting(false)}
        onConfirm={() => {
          setDeleteError(null);
          startTransition(async () => {
            const result = await deleteProject(projectId);
            if (result.ok) setDeleting(false);
            else setDeleteError(result.error);
          });
        }}
      />
    </span>
  );
}

export function ProjectMoveDialog({
  deckId,
  deckTitle,
  currentProjectId,
  projects,
  onClose,
}: {
  deckId: string;
  deckTitle: string;
  currentProjectId: string | null;
  projects: ProjectOption[];
  onClose: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function move(projectId: string | null) {
    if (isPending || projectId === currentProjectId) return;
    setError(null);
    startTransition(async () => {
      const result = await setDeckProject(deckId, projectId);
      if (result.ok) onClose();
      else setError(result.error);
    });
  }

  const optionClass =
    "flex w-full items-center justify-between gap-3 px-5 py-2.5 text-left text-sm transition-colors hover:bg-[color:var(--accent-wash)] disabled:opacity-50";

  return (
    <DialogShell title={`Move "${deckTitle}" to…`} onClose={onClose}>
      <div className="max-h-80 overflow-y-auto py-1">
        {projects.map((p) => (
          <button
            key={p.id}
            type="button"
            disabled={isPending}
            onClick={() => move(p.id)}
            className={optionClass}
          >
            <span className="truncate">{p.name}</span>
            {p.id === currentProjectId && (
              <Check aria-hidden className="h-3.5 w-3.5 shrink-0 text-[color:var(--accent)]" />
            )}
          </button>
        ))}
        <button
          type="button"
          disabled={isPending}
          onClick={() => move(null)}
          className={`${optionClass} text-muted-foreground`}
        >
          <span>No project</span>
          {currentProjectId === null && (
            <Check aria-hidden className="h-3.5 w-3.5 shrink-0 text-[color:var(--accent)]" />
          )}
        </button>
      </div>
      {error && (
        <p className="border-t border-border px-5 py-3 text-xs text-[color:var(--danger)]">
          {error}
        </p>
      )}
    </DialogShell>
  );
}

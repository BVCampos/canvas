"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Archive,
  ArchiveRestore,
  FolderInput,
  MoreHorizontal,
  Play,
  Share2,
  Trash2,
} from "lucide-react";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { DialogShell } from "@/components/dialog-shell";
import { Button } from "@/components/ui/button";
import { ShareDeckDialog } from "./[id]/share-dialog";
import { deleteDeck, setDeckArchived } from "./[id]/actions";
import { ProjectMoveDialog, type ProjectOption } from "./project-controls";

// Per-row "⋯" for the /canvases deck index — the row's only control besides
// the inert pending badge. Present / move-to-project / share / delete used to
// be four separate inline affordances on every row; they now live behind one
// action sheet so the list reads as "title · updated · pending badge".
//
// The menu is a DialogShell action sheet, not an anchored popover: the rows
// live inside overflow-hidden <ul>s, which would clip an absolutely-
// positioned menu (see the note in project-controls.tsx). Each item either
// navigates (Present) or hands off to the existing dialog for that act —
// the server re-checks permissions on every action regardless.
export function DeckRowMenu({
  deckId,
  deckTitle,
  canManageDeck,
  canMoveToProject,
  currentProjectId,
  projects,
  currentUserId,
  archived,
}: {
  deckId: string;
  deckTitle: string;
  // Admins/owners manage any deck; members only the decks they created.
  canManageDeck: boolean;
  // Move needs the deck to belong to the active workspace and somewhere to
  // move it to (or out of) — the page computes this, mirroring the old
  // inline DeckListProjectMove visibility rule.
  canMoveToProject: boolean;
  currentProjectId: string | null;
  projects: ProjectOption[];
  currentUserId: string | null;
  // True when this row is on the archived shelf — flips the menu item between
  // "Archive deck" and "Unarchive deck" (same canManageDeck gate as delete).
  archived: boolean;
}) {
  const router = useRouter();
  const [menuOpen, setMenuOpen] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  // Archive rarely fails (same gate as the visible affordance), so it needs no
  // confirm step — it's reversible. A failure surfaces in a small notice.
  const [archiveError, setArchiveError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleToggleArchive() {
    setMenuOpen(false);
    setArchiveError(null);
    startTransition(async () => {
      const result = await setDeckArchived(deckId, !archived);
      if (result.ok) {
        // setDeckArchived revalidates /canvases server-side; refresh pulls the
        // deck onto (or off) the archived shelf without a full navigation.
        router.refresh();
        return;
      }
      setArchiveError(
        result.error === "not_authorized"
          ? "You don't have permission to change this deck."
          : `Couldn't ${archived ? "unarchive" : "archive"} the deck: ${result.error}`,
      );
    });
  }

  const itemClass =
    "flex w-full items-center gap-3 px-5 py-2.5 text-left text-sm transition-colors hover:bg-[color:var(--accent-wash)]";

  return (
    <>
      <button
        type="button"
        title="Deck actions"
        aria-label={`Actions for ${deckTitle}`}
        aria-haspopup="dialog"
        onClick={() => setMenuOpen(true)}
        // `pointer-events-auto relative z-[1]` re-enables clicks for this
        // control while its parent cluster keeps `pointer-events-none`, so the
        // surrounding row area still falls through to the deck-opening link.
        className="pointer-events-auto relative z-[1] inline-flex h-8 w-8 items-center justify-center rounded-[6px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:h-7 sm:w-7"
      >
        <MoreHorizontal aria-hidden className="h-3.5 w-3.5" />
      </button>

      {menuOpen && (
        <DialogShell title={deckTitle} onClose={() => setMenuOpen(false)}>
          <div className="py-1">
            <Link
              href={`/canvases/${deckId}/present`}
              onClick={() => setMenuOpen(false)}
              className={itemClass}
            >
              <Play aria-hidden className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span>Present</span>
            </Link>
            {canMoveToProject && (
              <button
                type="button"
                onClick={() => {
                  setMenuOpen(false);
                  setMoveOpen(true);
                }}
                className={itemClass}
              >
                <FolderInput aria-hidden className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <span>Move to project…</span>
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                setMenuOpen(false);
                setShareOpen(true);
              }}
              className={itemClass}
            >
              <Share2 aria-hidden className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span>Share…</span>
            </button>
            {canManageDeck && (
              <button
                type="button"
                onClick={handleToggleArchive}
                className={itemClass}
              >
                {archived ? (
                  <ArchiveRestore
                    aria-hidden
                    className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
                  />
                ) : (
                  <Archive
                    aria-hidden
                    className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
                  />
                )}
                <span>{archived ? "Unarchive deck" : "Archive deck"}</span>
              </button>
            )}
            {canManageDeck && (
              <button
                type="button"
                onClick={() => {
                  setMenuOpen(false);
                  setDeleteError(null);
                  setDeleteOpen(true);
                }}
                className={`${itemClass} text-[color:var(--danger)] hover:bg-[color:var(--danger)]/10`}
              >
                <Trash2 aria-hidden className="h-3.5 w-3.5 shrink-0" />
                <span>Delete deck</span>
              </button>
            )}
          </div>
        </DialogShell>
      )}

      {archiveError && (
        <DialogShell
          title={archived ? "Couldn't unarchive deck" : "Couldn't archive deck"}
          onClose={() => setArchiveError(null)}
        >
          <div className="space-y-3 px-5 py-4">
            <p className="text-sm text-muted-foreground">{archiveError}</p>
            <div className="flex justify-end">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setArchiveError(null)}
              >
                Close
              </Button>
            </div>
          </div>
        </DialogShell>
      )}

      {moveOpen && (
        <ProjectMoveDialog
          deckId={deckId}
          deckTitle={deckTitle}
          currentProjectId={currentProjectId}
          projects={projects}
          onClose={() => setMoveOpen(false)}
        />
      )}

      <ShareDeckDialog
        open={shareOpen}
        deckId={deckId}
        currentUserId={currentUserId}
        onClose={() => {
          setShareOpen(false);
          // setDeckVisibility revalidates /canvases server-side; router.refresh
          // pulls fresh data without forcing a full navigation.
          router.refresh();
        }}
      />

      <ConfirmDialog
        open={deleteOpen}
        title="Delete deck?"
        body={
          deleteError
            ? `Delete failed: ${deleteError}`
            : `"${deckTitle}" — all slides, versions, snapshots, and storage assets are removed. This cannot be undone.`
        }
        confirmLabel="Delete deck"
        destructive
        pending={isPending}
        onCancel={() => setDeleteOpen(false)}
        onConfirm={() => {
          setDeleteError(null);
          startTransition(async () => {
            const result = await deleteDeck(deckId);
            // On success deleteDeck redirects to /canvases (refreshing the
            // list); only the failure branch returns here.
            if (!result.ok) setDeleteError(result.error);
          });
        }}
      />
    </>
  );
}

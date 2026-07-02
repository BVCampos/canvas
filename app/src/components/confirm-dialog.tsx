"use client";

import { useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { DialogShell } from "@/components/dialog-shell";

// Generic confirm dialog — DialogShell (backdrop + Esc-to-close +
// body-scroll-lock + focus restore) plus a Cancel/Confirm footer. Used for
// destructive confirms (deck delete) and non-destructive-but-consequential
// ones (snapshot / version restore). Default-focuses Cancel so the safer
// path lights up on Enter.
//
// Extracted from deck-workspace.tsx so any route can reuse the same affordance
// instead of falling back to the native window.confirm().
export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel,
  destructive = false,
  pending = false,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  body: string;
  confirmLabel: string;
  destructive?: boolean;
  pending?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!open) return;
    // Default-focus the cancel button so the safer path lights up on Enter.
    // Mirrors the convention macOS uses for destructive system prompts.
    // (DialogShell restores focus to the prior element on close.)
    cancelRef.current?.focus();
  }, [open]);

  if (!open) return null;

  return (
    <DialogShell title={title} description={body} onClose={onCancel}>
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
          variant={destructive ? "destructive" : "default"}
          onClick={onConfirm}
          disabled={pending}
        >
          {confirmLabel}
        </Button>
      </div>
    </DialogShell>
  );
}

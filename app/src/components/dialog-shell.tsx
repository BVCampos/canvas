"use client";

import { useEffect, useId } from "react";
import { createPortal } from "react-dom";

// The house modal shell: backdrop + Esc-to-close + body-scroll-lock + focus
// restore on unmount. ConfirmDialog and the project dialogs all render
// through this, so modal a11y behaviour lives in one place. Render it only
// while open (`{open && <DialogShell …>}` or an early return) — mounting is
// what arms the effects. `description` is the muted line under the title;
// children render below the header.
//
// Portaled to <body>: triggers often live inside `pointer-events-none`
// clusters (deck-row actions) or `overflow-hidden` lists, and an inline
// dialog inherits both — clicks would fall through the modal onto the
// stretched row links behind it. `pointer-events-auto` guards the same
// inheritance if a portal target is ever inert.
export function DialogShell({
  title,
  description,
  onClose,
  children,
}: {
  title: string;
  description?: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const titleId = useId();

  // Restore focus to whatever had it before the dialog opened. Mirrors the
  // behaviour ConfirmDialog has always had; a caller can still steal focus
  // to its own control (e.g. Cancel, an input) after mount.
  useEffect(() => {
    const previouslyFocused =
      typeof document !== "undefined"
        ? (document.activeElement as HTMLElement | null)
        : null;
    return () => {
      if (
        previouslyFocused &&
        previouslyFocused.isConnected &&
        typeof previouslyFocused.focus === "function"
      ) {
        previouslyFocused.focus();
      }
    };
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      className="pointer-events-auto fixed inset-0 z-50 flex items-center justify-center px-4"
    >
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="absolute inset-0 bg-foreground/40 backdrop-blur-[1px]"
      />
      <div className="relative w-full max-w-md rounded-[12px] border border-border bg-card shadow-2xl">
        <header className="border-b border-border px-5 py-4">
          <h2 id={titleId} className="text-base font-semibold text-foreground">
            {title}
          </h2>
          {description !== undefined && (
            <p className="mt-1 text-xs text-muted-foreground">{description}</p>
          )}
        </header>
        {children}
      </div>
    </div>,
    document.body,
  );
}

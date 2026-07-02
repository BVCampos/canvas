"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ImageOff,
  RefreshCw,
  Scissors,
  TerminalSquare,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type {
  PreflightCheck,
  PreflightFinding,
  PreflightReport,
} from "@/lib/canvas/preflight-audit";

// Pre-flight findings dialog — "check before it leaves the building".
// Opened from the Export menu; runs the deterministic audit
// (/api/decks/{id}/preflight) and lists what a client would see broken:
// clipped text, dead images, slide-JS errors. Soft by design: it informs the
// export decision, it never blocks it (the fast solo loop would route around
// a wall).
//
// Findings are ephemeral — "as of now". Any edit invalidates them, which is
// why the dialog re-runs rather than caches.

// Static map, not a function — selecting a component via a call in render
// trips react-hooks/static-components (it can't prove the ref is stable).
const CHECK_ICONS: Partial<Record<PreflightCheck, typeof AlertTriangle>> = {
  overflow: Scissors,
  broken_image: ImageOff,
};

export function PreflightDialog({
  deckId,
  open,
  onClose,
  onGoToSlide,
  slideTitleByPosition,
}: {
  deckId: string;
  open: boolean;
  onClose: () => void;
  // Jump the editor to the finding's slide (and close the dialog).
  onGoToSlide: (position: number) => void;
  slideTitleByPosition: Map<number, string>;
}) {
  const [report, setReport] = useState<PreflightReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ranForOpenRef = useRef(false);

  const run = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/decks/${deckId}/preflight`, {
        cache: "no-store",
      });
      const data = (await res.json().catch(() => null)) as
        | { ok?: boolean; report?: PreflightReport; error?: string }
        | null;
      if (!res.ok || !data?.ok || !data.report) {
        setReport(null);
        setError(
          data?.error ??
            (res.status === 429
              ? "The renderer is busy — try again in a moment."
              : "Pre-flight failed. Try again."),
        );
        return;
      }
      setReport(data.report);
    } catch {
      setReport(null);
      setError("Pre-flight failed. Try again.");
    } finally {
      setLoading(false);
    }
  }, [deckId]);

  // Auto-run once per open. The ref (not state) gates it so Strict Mode's
  // double-invoke can't fire two renders at the gate's expense.
  useEffect(() => {
    if (!open) {
      ranForOpenRef.current = false;
      return;
    }
    if (ranForOpenRef.current) return;
    ranForOpenRef.current = true;
    void run();
  }, [open, run]);

  // Esc closes (matches the sibling dialogs' contract).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const blockers = report?.findings.filter((f) => f.severity === "blocker") ?? [];
  const warnings = report?.findings.filter((f) => f.severity === "warning") ?? [];
  const clean = report !== null && report.findings.length === 0;

  return (
    <div
      className="pointer-events-auto fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Pre-flight check"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="flex max-h-[85dvh] w-full max-w-lg flex-col overflow-hidden rounded-[14px] border border-border bg-card shadow-2xl">
        <div className="border-b border-border px-5 py-4">
          <h2 className="text-base font-semibold">Pre-flight check</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Renders every slide and flags what a recipient would see broken —
            clipped text, dead images, script errors. Advisory, not a gate.
          </p>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {loading ? (
            <div className="flex flex-col items-center gap-3 py-10 text-center">
              <div
                aria-hidden
                className="h-6 w-6 animate-spin rounded-full border-2 border-border border-t-foreground"
              />
              <p className="text-sm text-muted-foreground">
                Rendering the deck at full size…
              </p>
            </div>
          ) : error ? (
            <div className="py-8 text-center">
              <p className="text-sm text-[color:var(--danger)]">{error}</p>
            </div>
          ) : clean ? (
            <div className="flex flex-col items-center gap-3 py-10 text-center">
              <CheckCircle2
                aria-hidden
                className="h-8 w-8 text-[color:var(--accent)]"
              />
              <div>
                <p className="text-sm font-medium text-foreground">
                  Nothing broken found
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {report.slideCount} slides checked at{" "}
                  {report.stage.w}×{report.stage.h} in{" "}
                  {(report.durationMs / 1000).toFixed(1)}s. Deterministic checks
                  only — it can&apos;t judge taste.
                </p>
              </div>
            </div>
          ) : report ? (
            <div className="space-y-4">
              <p className="text-xs text-muted-foreground">
                {blockers.length > 0
                  ? `${blockers.length} visible ${blockers.length === 1 ? "defect" : "defects"}`
                  : "No visible defects"}
                {warnings.length > 0
                  ? ` · ${warnings.length} runtime ${warnings.length === 1 ? "warning" : "warnings"}`
                  : ""}{" "}
                · {report.slideCount} slides checked in{" "}
                {(report.durationMs / 1000).toFixed(1)}s
              </p>
              <ul className="space-y-2">
                {report.findings.map((finding, i) => (
                  <FindingRow
                    key={i}
                    finding={finding}
                    slideTitle={
                      finding.position != null
                        ? slideTitleByPosition.get(finding.position) ?? ""
                        : ""
                    }
                    onGoToSlide={onGoToSlide}
                  />
                ))}
              </ul>
            </div>
          ) : null}
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-border px-5 py-3">
          <button
            type="button"
            onClick={() => void run()}
            disabled={loading}
            className="inline-flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
          >
            <RefreshCw aria-hidden className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
            Re-run
          </button>
          <Button type="button" size="sm" onClick={onClose}>
            Done
          </Button>
        </div>
      </div>
    </div>
  );
}

function FindingRow({
  finding,
  slideTitle,
  onGoToSlide,
}: {
  finding: PreflightFinding;
  slideTitle: string;
  onGoToSlide: (position: number) => void;
}) {
  const Icon =
    finding.severity === "blocker"
      ? (CHECK_ICONS[finding.check] ?? TerminalSquare)
      : AlertTriangle;
  return (
    <li className="flex items-start gap-3 rounded-[10px] border border-border bg-background px-3 py-2.5">
      <Icon
        aria-hidden
        className={cn(
          "mt-0.5 h-4 w-4 shrink-0",
          finding.severity === "blocker"
            ? "text-[color:var(--danger)]"
            : "text-muted-foreground",
        )}
      />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          {finding.position != null ? (
            <button
              type="button"
              onClick={() => onGoToSlide(finding.position!)}
              title={slideTitle || undefined}
              className="font-machine shrink-0 rounded-full bg-muted px-2 py-[1px] text-[10px] uppercase tracking-wide text-muted-foreground transition-colors hover:bg-[color:var(--accent-wash)] hover:text-foreground"
            >
              Slide {finding.position + 1}
            </button>
          ) : (
            <span className="font-machine shrink-0 rounded-full bg-muted px-2 py-[1px] text-[10px] uppercase tracking-wide text-muted-foreground">
              Deck
            </span>
          )}
          <span className="text-sm text-foreground">{finding.message}</span>
        </div>
        {finding.detail ? (
          <p className="mt-0.5 truncate text-xs text-muted-foreground" title={finding.detail}>
            {finding.detail}
          </p>
        ) : null}
      </div>
    </li>
  );
}

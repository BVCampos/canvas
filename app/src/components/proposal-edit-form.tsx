"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { updateProposal } from "@/app/canvases/proposal-actions";
import type { EditKind } from "@/components/proposal-diff";
import {
  buildProposalEditPatch,
  isBuildError,
  TEXT_CONTENT_KINDS,
  SINGLE_LINE_KINDS,
} from "@/lib/canvas/proposal-edit";

// In-place editor for a PENDING proposal. Rendered by both the standalone
// proposal page and the review sheet, gated behind `canEdit` (proposer or
// approver). It branches by kind: text kinds (slide HTML/CSS/label, theme CSS,
// nav JS, deck title) edit the single new_content string; slide_edit edits the
// touched subset of html/css/title; slide_create edits position + content;
// slide_reorder / slide_delete have no editable content in this surface, so
// only the rationale is editable (the backend RPC supports full payload edits
// for them — that's a richer-UI follow-up).
//
// On save it calls updateProposal, which re-bases the diff to current target
// state and bumps the proposal's revision. `expected_revision` guards against a
// concurrent edit (the RPC returns code: "stale" on a mismatch). The per-kind
// payload shaping lives in buildProposalEditPatch (pure + unit-tested).

type Initial = {
  new_content: string | null;
  new_slide_payload: Record<string, unknown> | null;
  rationale: string | null;
};

type Props = {
  editId: string;
  deckId: string;
  kind: EditKind;
  revision: number;
  initial: Initial;
  onCancel: () => void;
  // Called after a successful save. The parent re-fetches / refreshes so the
  // diff and revision reflect the new state.
  onSaved: () => void | Promise<void>;
};

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

export function ProposalEditForm({
  editId,
  deckId,
  kind,
  revision,
  initial,
  onCancel,
  onSaved,
}: Props) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);

  // --- Field state, seeded from the proposal's current content. ---
  const payload = initial.new_slide_payload ?? {};

  const [content, setContent] = useState(initial.new_content ?? "");
  const [rationale, setRationale] = useState(initial.rationale ?? "");

  // slide_edit: only the keys the proposal actually touched are editable. We
  // record which keys are present so save rebuilds exactly that subset.
  const editKeys = {
    html_body: typeof payload.html_body === "string",
    slide_styles: typeof payload.slide_styles === "string",
    title: typeof payload.title === "string",
  };
  const [seHtml, setSeHtml] = useState(asString(payload.html_body));
  const [seCss, setSeCss] = useState(asString(payload.slide_styles));
  const [seTitle, setSeTitle] = useState(asString(payload.title));

  // slide_create.
  const [position, setPosition] = useState(
    typeof payload.position === "number" ? payload.position : 0,
  );
  const [scTitle, setScTitle] = useState(asString(payload.title));
  const [scHtml, setScHtml] = useState(asString(payload.html_body));
  const [scCss, setScCss] = useState(asString(payload.slide_styles));

  function submit() {
    setError(null);
    setStale(false);
    const built = buildProposalEditPatch(kind, revision, {
      content,
      rationale,
      editKeys,
      slideEdit: { html_body: seHtml, slide_styles: seCss, title: seTitle },
      slideCreate: {
        position,
        title: scTitle,
        html_body: scHtml,
        slide_styles: scCss,
      },
      reorderPayload: payload,
    });
    if (isBuildError(built)) {
      setError(built.error);
      return;
    }
    startTransition(async () => {
      const result = await updateProposal(editId, deckId, built);
      if (!result.ok) {
        if (result.code === "stale") setStale(true);
        setError(result.error);
        return;
      }
      await onSaved();
    });
  }

  return (
    <div className="space-y-4 rounded-[12px] border border-[color:var(--accent)]/40 bg-[color:var(--accent-wash)] p-4">
      <div className="flex items-center justify-between">
        <div className="eyebrow text-muted-foreground">Edit proposal</div>
        <span className="text-[11px] text-muted-foreground">rev {revision}</span>
      </div>

      {/* ---- Per-kind fields ---- */}
      {TEXT_CONTENT_KINDS.includes(kind) &&
        (SINGLE_LINE_KINDS.includes(kind) ? (
          <Field label={kind === "deck_title" ? "Deck title" : "Slide label"}>
            <input
              value={content}
              onChange={(e) => setContent(e.target.value)}
              className="w-full rounded-[8px] border border-border bg-card p-2 text-base focus:outline-none focus:ring-2 focus:ring-ring sm:text-sm"
            />
          </Field>
        ) : (
          <Field label={codeLabel(kind)}>
            <CodeArea value={content} onChange={setContent} />
          </Field>
        ))}

      {kind === "slide_edit" && (
        <>
          {editKeys.title && (
            <Field label="Slide label">
              <input
                value={seTitle}
                onChange={(e) => setSeTitle(e.target.value)}
                className="w-full rounded-[8px] border border-border bg-card p-2 text-base focus:outline-none focus:ring-2 focus:ring-ring sm:text-sm"
              />
            </Field>
          )}
          {editKeys.html_body && (
            <Field label="HTML">
              <CodeArea value={seHtml} onChange={setSeHtml} />
            </Field>
          )}
          {editKeys.slide_styles && (
            <Field label="CSS">
              <CodeArea value={seCss} onChange={setSeCss} />
            </Field>
          )}
        </>
      )}

      {kind === "slide_create" && (
        <>
          <Field label="Position (0-based)">
            <input
              type="number"
              min={0}
              value={position}
              onChange={(e) => setPosition(Number(e.target.value))}
              className="w-32 rounded-[8px] border border-border bg-card p-2 text-base focus:outline-none focus:ring-2 focus:ring-ring sm:text-sm"
            />
          </Field>
          <Field label="Slide label">
            <input
              value={scTitle}
              onChange={(e) => setScTitle(e.target.value)}
              className="w-full rounded-[8px] border border-border bg-card p-2 text-base focus:outline-none focus:ring-2 focus:ring-ring sm:text-sm"
            />
          </Field>
          <Field label="HTML">
            <CodeArea value={scHtml} onChange={setScHtml} />
          </Field>
          <Field label="CSS">
            <CodeArea value={scCss} onChange={setScCss} />
          </Field>
        </>
      )}

      {(kind === "slide_reorder" || kind === "slide_delete") && (
        <p className="rounded-[8px] border border-border bg-card/60 p-3 text-xs text-muted-foreground">
          {kind === "slide_reorder"
            ? "The slide order can't be changed here — withdraw and re-propose to change it. You can still revise the rationale below."
            : "A delete proposal has no editable content. You can revise the rationale below, or withdraw the proposal."}
        </p>
      )}

      {/* ---- Rationale (every kind) ---- */}
      <Field label="Rationale">
        <textarea
          value={rationale}
          onChange={(e) => setRationale(e.target.value)}
          rows={3}
          placeholder="Why this change? The reviewer reads this in the diff."
          className="w-full rounded-[8px] border border-border bg-card p-2 text-base focus:outline-none focus:ring-2 focus:ring-ring sm:text-sm"
        />
      </Field>

      {error && (
        <div
          role="alert"
          className="space-y-2 rounded-[6px] border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger-fg"
        >
          <p>{error}</p>
          {stale && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => router.refresh()}
            >
              Reload latest
            </Button>
          )}
        </div>
      )}

      <div className="flex items-center gap-2">
        <Button onClick={submit} disabled={isPending}>
          Save changes
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={onCancel}
          disabled={isPending}
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block space-y-1.5">
      <span className="eyebrow text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

function CodeArea({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <textarea
      value={value}
      onChange={(e) => onChange(e.target.value)}
      rows={12}
      spellCheck={false}
      className="w-full rounded-[8px] border border-border bg-card p-2 font-mono text-xs leading-relaxed focus:outline-none focus:ring-2 focus:ring-ring"
    />
  );
}

function codeLabel(kind: EditKind): string {
  switch (kind) {
    case "slide_html":
      return "HTML";
    case "slide_styles":
      return "CSS";
    case "theme_css":
      return "Theme CSS";
    case "nav_js":
      return "Navigation JS";
    default:
      return "Content";
  }
}

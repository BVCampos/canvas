"use client";

import { useRef, useState } from "react";
import { DECK_TEMPLATES } from "@/lib/canvas/deck-templates";

// Tabs control for the New Deck form's source input.
//
// Renders the existing file-upload affordance behind one tab, a textarea behind
// a second, and a starter-template picker behind a third. Only the active tab's
// form field carries a non-empty name so the importer route sees exactly one
// source on submit; the inactive field is `disabled` (browsers skip disabled
// fields in multipart submission) AND has its name suppressed, defending against
// the browser ignoring `disabled` on weird input types. The template tab submits
// a `source_template` id; the route builds it with the real title (so the cover
// matches) and runs the same parser as the file/paste paths.
//
// This is a client component because the tab switch is purely visual state;
// the surrounding `<form>` (in page.tsx) stays a normal HTML form submission
// — no JS handler hijacks the submit.

type Mode = "file" | "paste" | "template";
const MODES: Mode[] = ["file", "paste", "template"];

export function NewDeckSourceTabs({
  onSuggestedTitle,
}: {
  onSuggestedTitle?: (title: string) => void;
}) {
  const [mode, setMode] = useState<Mode>("file");
  const [template, setTemplate] = useState<string>(DECK_TEMPLATES[0]?.id ?? "");
  const [fileName, setFileName] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const selectFile = (file: File | null) => {
    if (!file) {
      setFileName(null);
      return;
    }
    if (!file.name.toLowerCase().endsWith(".html") && file.type !== "text/html") {
      // Drag-drop assigns the file to the input before validation (and bypasses
      // its `accept` filter), so an invalid file must be detached here or it
      // stays attached and submittable. Clearing the input covers both the
      // drop and picker paths.
      if (fileRef.current) fileRef.current.value = "";
      setFileName(null);
      setFileError("Choose an HTML file.");
      return;
    }
    setFileError(null);
    setFileName(file.name);
    onSuggestedTitle?.(file.name.replace(/\.html?$/i, "").replace(/[-_]+/g, " "));
  };

  const onTabKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const current = MODES.indexOf(mode);
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? MODES.length - 1
          : (current + (event.key === "ArrowRight" ? 1 : -1) + MODES.length) %
            MODES.length;
    const nextMode = MODES[next];
    setMode(nextMode);
    requestAnimationFrame(() => document.getElementById(`source-tab-${nextMode}-button`)?.focus());
  };

  return (
    <div className="space-y-3">
      <div>
        <label className="text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">
          Source HTML (optional)
        </label>
        <div
          role="tablist"
          aria-label="Deck source"
          onKeyDown={onTabKeyDown}
          className="mt-2 inline-flex rounded-[8px] border border-border bg-muted p-0.5 text-xs"
        >
          <TabButton
            active={mode === "file"}
            onClick={() => setMode("file")}
            controls="source-tab-file"
            id="source-tab-file-button"
          >
            Upload file
          </TabButton>
          <TabButton
            active={mode === "paste"}
            onClick={() => setMode("paste")}
            controls="source-tab-paste"
            id="source-tab-paste-button"
          >
            Paste HTML
          </TabButton>
          <TabButton
            active={mode === "template"}
            onClick={() => setMode("template")}
            controls="source-tab-template"
            id="source-tab-template-button"
          >
            Template
          </TabButton>
        </div>
      </div>

      <div
        id="source-tab-file"
        role="tabpanel"
        aria-labelledby="source-tab-file-button"
        aria-hidden={mode !== "file"}
        hidden={mode !== "file"}
        className="space-y-2"
      >
        <label
          htmlFor="new-deck-source-file"
          onDragEnter={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragOver={(event) => event.preventDefault()}
          onDragLeave={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
              setDragging(false);
            }
          }}
          onDrop={(event) => {
            event.preventDefault();
            setDragging(false);
            const file = event.dataTransfer.files[0] ?? null;
            if (!file || !fileRef.current) return;
            const transfer = new DataTransfer();
            transfer.items.add(file);
            fileRef.current.files = transfer.files;
            selectFile(file);
          }}
          className={[
            "flex min-h-32 cursor-pointer flex-col items-center justify-center rounded-[10px] border border-dashed px-5 py-6 text-center transition-colors",
            dragging
              ? "border-[color:var(--accent)] bg-[color:var(--accent-wash)]"
              : "border-border bg-muted/30 hover:border-[color:var(--accent)]/60 hover:bg-muted/50",
          ].join(" ")}
        >
          <span className="text-sm font-medium text-foreground">
            {fileName ?? "Drop an HTML deck here"}
          </span>
          <span className="mt-1 text-xs text-muted-foreground">
            {fileName ? "Click to choose a different file" : "or click to browse · up to 10 MB"}
          </span>
        </label>
        <input
          ref={fileRef}
          id="new-deck-source-file"
          type="file"
          // The inactive panel still mounts but with a benign name so the
          // request body doesn't carry stale entries. Only the active panel
          // carries `name="source"`.
          name={mode === "file" ? "source" : "source_file_inactive"}
          accept=".html,text/html"
          disabled={mode !== "file"}
          onChange={(event) => selectFile(event.target.files?.[0] ?? null)}
          className="sr-only"
        />
        {fileError ? <p className="text-xs text-destructive">{fileError}</p> : null}
        <p className="text-xs text-muted-foreground">
          We&apos;ll split it into slides and bring its images and styling
          along. Leave empty to start blank.
        </p>
      </div>

      <div
        id="source-tab-paste"
        role="tabpanel"
        aria-labelledby="source-tab-paste-button"
        aria-hidden={mode !== "paste"}
        hidden={mode !== "paste"}
        className="space-y-2"
      >
        <textarea
          name={mode === "paste" ? "source_html" : "source_html_inactive"}
          placeholder="<!DOCTYPE html>&#10;<html>&#10;  …"
          rows={10}
          disabled={mode !== "paste"}
          // text-base on mobile prevents iOS Safari's focus auto-zoom (raw
          // textarea, not the shared Input); sm:text-xs restores the compact
          // monospace size on desktop.
          className="block w-full rounded-[8px] border border-border bg-card px-3 py-2 font-mono text-base text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50 sm:text-xs"
        />
        <p className="text-xs text-muted-foreground">
          Paste a full HTML deck (exported, hand-written, or agent-generated).
          Same parser as the upload path. Cap is 10 MB.
        </p>
      </div>

      <div
        id="source-tab-template"
        role="tabpanel"
        aria-labelledby="source-tab-template-button"
        aria-hidden={mode !== "template"}
        hidden={mode !== "template"}
        className="space-y-2"
      >
        {/* The selected id rides one hidden field, named source_template only
            while this tab is active so the route sees a single source. */}
        <input
          type="hidden"
          name={mode === "template" ? "source_template" : "source_template_inactive"}
          value={template}
        />
        <div
          role="radiogroup"
          aria-label="Starter template"
          className="grid gap-3 sm:grid-cols-3"
        >
          {DECK_TEMPLATES.map((t) => {
            const active = template === t.id;
            return (
              <button
                key={t.id}
                type="button"
                role="radio"
                aria-checked={active}
                onClick={() => setTemplate(t.id)}
                className={[
                  "overflow-hidden rounded-[10px] border text-left transition-colors",
                  active
                    ? "border-[color:var(--accent)] bg-[color:var(--accent-wash)]"
                    : "border-border bg-card hover:border-[color:var(--accent)]/50",
                ].join(" ")}
              >
                <TemplatePreview id={t.id} />
                <div className="px-3 py-2.5">
                  <div className="text-sm font-medium text-foreground">{t.name}</div>
                  <div className="mt-0.5 text-xs text-muted-foreground">
                    {t.description}
                  </div>
                </div>
              </button>
            );
          })}
        </div>
        <p className="text-xs text-muted-foreground">
          Starts from a ready-made skeleton you can edit. Same parser as the
          upload path; your title fills the cover.
        </p>
      </div>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  controls,
  id,
  children,
}: {
  active: boolean;
  onClick: () => void;
  controls: string;
  id: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      id={id}
      role="tab"
      aria-selected={active}
      aria-controls={controls}
      tabIndex={active ? 0 : -1}
      onClick={onClick}
      className={[
        "rounded-[6px] px-3 py-1 transition-colors",
        active
          ? "bg-card text-foreground shadow-sm"
          : "text-muted-foreground hover:text-foreground",
      ].join(" ")}
    >
      {children}
    </button>
  );
}

function TemplatePreview({ id }: { id: string }) {
  const tone =
    id === "pitch"
      ? "from-slate-950 to-blue-950 text-white"
      : id === "report"
        ? "from-stone-100 to-amber-50 text-stone-900"
        : "from-blue-50 to-white text-slate-900";
  return (
    <div className={`aspect-video bg-gradient-to-br p-3 ${tone}`} aria-hidden>
      <div className="h-1 w-8 rounded-full bg-current opacity-30" />
      <div className="mt-4 h-2 w-3/4 rounded-full bg-current opacity-80" />
      <div className="mt-1.5 h-1.5 w-1/2 rounded-full bg-current opacity-30" />
      <div className="mt-4 flex gap-1.5">
        <div className="h-7 flex-1 rounded border border-current opacity-20" />
        <div className="h-7 flex-1 rounded border border-current opacity-20" />
      </div>
    </div>
  );
}

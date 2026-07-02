"use client";

import { useMemo, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { ProposalDiff } from "@/components/proposal-diff";
import {
  getSlideVersionContents,
  restoreSlideVersion,
  restoreSnapshot,
} from "../actions";

// Click-to-toggle expansion for long rationales. Default collapsed to keep the
// version list scannable; once expanded, the whole prompt is readable inline.
// We compare against `line-clamp-2` rendered height by simply checking the
// underlying text length — a cheap heuristic that avoids measuring DOM.
const RATIONALE_CLAMP_CHARS = 140;

type VersionContent = {
  title: string;
  html_body: string;
  slide_styles: string | null;
};

// Pick which field a version changed and the before/after to feed ProposalDiff.
// Proposals change exactly one of html_body / slide_styles / title per version,
// so we surface that field — otherwise a label-only version (from a slide_title
// edit) or a styles-only version would render a misleading "No changes" against
// the html body. Restores can touch several fields at once; html takes
// precedence, then styles, then the label.
function historyVersionDiff(
  prior: VersionContent,
  current: VersionContent,
): { kind: "slide_html" | "slide_styles" | "slide_title"; oldContent: string; newContent: string } {
  if (prior.html_body !== current.html_body) {
    return { kind: "slide_html", oldContent: prior.html_body, newContent: current.html_body };
  }
  if ((prior.slide_styles ?? "") !== (current.slide_styles ?? "")) {
    return {
      kind: "slide_styles",
      oldContent: prior.slide_styles ?? "",
      newContent: current.slide_styles ?? "",
    };
  }
  if (prior.title !== current.title) {
    return { kind: "slide_title", oldContent: prior.title, newContent: current.title };
  }
  // Identical content (shouldn't happen for adjacent versions) — fall back to
  // the html diff, which renders "No changes."
  return { kind: "slide_html", oldContent: prior.html_body, newContent: current.html_body };
}

type Snapshot = {
  id: string;
  label: string;
  description: string | null;
  kind: string;
  created_at: string;
  created_at_formatted: string;
  created_at_relative: string;
  created_by: string | null;
  // Pre-resolved display label (name preferred, email-prefix fallback). The
  // server already applied `displayName()` so this view doesn't need to know
  // about the user profile shape.
  created_by_label: string | null;
  // How many of the deck's current slides differ from this snapshot (computed
  // server-side), surfaced in the restore confirm so users restore knowingly.
  changed_count: number;
  total_slides: number;
};

type Slide = {
  id: string;
  position: number;
  title: string;
  current_version_id: string | null;
};

type SlideVersion = {
  id: string;
  slide_id: string;
  version_no: number;
  author_kind: string;
  source_prompt: string | null;
  created_by: string | null;
  created_by_label: string | null;
  created_at: string;
  created_at_formatted: string;
  created_at_relative: string;
};

export function HistoryView({
  deckId,
  deckTitle,
  themeCss,
  navJs,
  deckMeta,
  initialSlideId,
  snapshots,
  slides,
  versions,
}: {
  deckId: string;
  deckTitle: string;
  themeCss: string;
  navJs: string;
  deckMeta: Record<string, unknown> | null;
  initialSlideId: string | null;
  snapshots: Snapshot[];
  slides: Slide[];
  versions: SlideVersion[];
}) {
  // Seed from the ?slide= deep-link when it names a real slide, else the first.
  const [selectedSlideId, setSelectedSlideId] = useState<string | null>(
    (initialSlideId && slides.some((s) => s.id === initialSlideId)
      ? initialSlideId
      : slides[0]?.id) ?? null,
  );
  // Which version's diff (vs its immediately-prior version) is expanded inline.
  const [diffVersionId, setDiffVersionId] = useState<string | null>(null);
  // Lazily-fetched version content keyed by version id — the page ships only
  // metadata, so we pull bodies on demand when a diff is expanded (cached
  // after). diffLoadingId marks the in-flight expand.
  const [diffContent, setDiffContent] = useState<
    Record<
      string,
      { title: string; html_body: string; slide_styles: string | null }
    >
  >({});
  const [diffLoadingId, setDiffLoadingId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  // A single confirm-dialog instance, driven by whichever restore was clicked.
  // Replaces the native window.confirm() so restores live inside the design
  // system (and can later carry an impact count / diff).
  const [confirmDialog, setConfirmDialog] = useState<{
    title: string;
    body: string;
    confirmLabel: string;
    onConfirm: () => void;
  } | null>(null);
  // Per-version rationale expansion. Keyed by version id; absent = collapsed.
  const [expandedRationales, setExpandedRationales] = useState<
    Record<string, boolean>
  >({});

  const slideVersions = useMemo(
    () => versions.filter((v) => v.slide_id === selectedSlideId),
    [versions, selectedSlideId],
  );

  const selectedSlide = slides.find((s) => s.id === selectedSlideId) ?? null;

  // Expand/collapse a version's diff vs its prior version, lazily fetching both
  // versions' content the first time (then cached, so re-toggling is free).
  const toggleDiff = async (v: SlideVersion, prior: SlideVersion) => {
    if (diffVersionId === v.id) {
      setDiffVersionId(null);
      return;
    }
    setDiffVersionId(v.id);
    const need = [v.id, prior.id].filter((id) => !diffContent[id]);
    if (need.length === 0) return;
    setDiffLoadingId(v.id);
    const result = await getSlideVersionContents(deckId, need);
    setDiffLoadingId(null);
    if (result.ok) {
      setDiffContent((prev) => ({ ...prev, ...result.versions }));
    } else {
      setFeedback(`Couldn't load diff: ${result.error}`);
      setDiffVersionId(null);
    }
  };

  const handleRestoreSnapshot = (snapshot: Snapshot) => {
    setConfirmDialog({
      title: "Restore snapshot?",
      body: `${
        snapshot.changed_count === 0
          ? `No slides currently differ from "${snapshot.label}".`
          : `Restoring "${snapshot.label}" changes ${snapshot.changed_count} of ${snapshot.total_slides} slide${snapshot.total_slides === 1 ? "" : "s"} to match it.`
      } Canvas first auto-snapshots the current state, then advances every slide forward — history stays intact.`,
      confirmLabel: "Restore snapshot",
      onConfirm: () => {
        setConfirmDialog(null);
        setFeedback(null);
        startTransition(async () => {
          const result = await restoreSnapshot(snapshot.id, deckId);
          setFeedback(
            result.ok
              ? `Restored snapshot "${snapshot.label}".`
              : `Restore failed: ${result.error}`,
          );
        });
      },
    });
  };

  const handleRestoreVersion = (version: SlideVersion) => {
    setConfirmDialog({
      title: "Restore this version?",
      body: `Restore this slide to v${version.version_no}? Canvas creates a new version with that content — history stays intact.`,
      confirmLabel: "Restore version",
      onConfirm: () => {
        setConfirmDialog(null);
        setFeedback(null);
        startTransition(async () => {
          const result = await restoreSlideVersion(
            version.slide_id,
            version.id,
            deckId,
          );
          setFeedback(
            result.ok
              ? `Restored slide to v${version.version_no} (new version created).`
              : `Restore failed: ${result.error}`,
          );
        });
      },
    });
  };

  return (
    <div className="space-y-8">
      {feedback ? (
        <div className="rounded-[10px] border border-border bg-card px-4 py-3 text-sm text-foreground">
          {feedback}
        </div>
      ) : null}

      <section className="rounded-[12px] border border-border bg-card">
        <div className="flex items-center justify-between border-b border-border px-5 py-3">
          <div>
            <div className="eyebrow text-muted-foreground">Deck snapshots</div>
            <p className="mt-1 text-xs text-muted-foreground">
              Named cuts you can restore in one click.
            </p>
          </div>
        </div>
        {snapshots.length === 0 ? (
          <div className="px-5 py-6 text-sm text-muted-foreground">
            No snapshots yet. Save one from the deck editor before risky edits.
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {snapshots.map((snap) => (
              <li key={snap.id} className="flex items-start justify-between gap-3 px-4 py-4 sm:gap-4 sm:px-5">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                    <span className="truncate">{snap.label}</span>
                    <span className="rounded-full border border-border px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.06em] text-muted-foreground">
                      {snap.kind}
                    </span>
                  </div>
                  {snap.description ? (
                    <p className="mt-1 text-xs text-muted-foreground">{snap.description}</p>
                  ) : null}
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    {snap.created_by_label ?? "Unknown user"} · {snap.created_at_formatted} ·{" "}
                    {snap.created_at_relative}
                  </p>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  disabled={isPending}
                  onClick={() => handleRestoreSnapshot(snap)}
                  // shrink-0 so a long snapshot label can't squeeze the button;
                  // 40px tap target on mobile, compact h-9 at sm+.
                  className="h-10 shrink-0 sm:h-9"
                >
                  Restore
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="rounded-[12px] border border-border bg-card">
        <div className="border-b border-border px-5 py-3">
          <div className="eyebrow text-muted-foreground">Slide history</div>
          <p className="mt-1 text-xs text-muted-foreground">
            Every approved proposal creates an immutable version row. Restore
            also creates a new version — never overwrites.
          </p>
        </div>

        {/* Below md the 260px sidebar + content can't coexist at 360px without
            horizontal scroll, so stack: the slide picker sits on top as a
            horizontally-scrollable row, the version list below. md+ keeps the
            original two-column grid. */}
        <div className="grid grid-cols-1 md:grid-cols-[260px_1fr]">
          <aside className="border-b border-border bg-fog/40 md:border-b-0 md:border-r">
            {/* On mobile the slide list scrolls horizontally as a chip row;
                md+ restores the vertical list. */}
            <ul className="flex overflow-x-auto py-2 md:block">
              {slides.map((slide) => {
                const isSel = slide.id === selectedSlideId;
                return (
                  // shrink-0 on mobile keeps each chip from being squeezed in
                  // the horizontal scroll row; md+ it's a normal list item.
                  <li key={slide.id} className="shrink-0 md:shrink">
                    <button
                      type="button"
                      onClick={() => setSelectedSlideId(slide.id)}
                      className={[
                        // Auto width as a chip on mobile (max-w caps a long
                        // title), full-width row at md+.
                        "flex h-10 max-w-[60vw] items-center gap-3 px-4 py-2 text-left md:h-auto md:w-full md:max-w-none",
                        isSel
                          ? "bg-[color:var(--accent-wash)] text-foreground"
                          : "text-muted-foreground hover:bg-muted hover:text-foreground",
                      ].join(" ")}
                    >
                      <span className="tabular-nums w-6 text-right text-[11px] font-medium opacity-70">
                        {slide.position + 1}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-sm">{slide.title}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </aside>

          <div className="min-h-[280px] p-5">
            {!selectedSlide ? (
              <p className="text-sm text-muted-foreground">Pick a slide on the left.</p>
            ) : slideVersions.length === 0 ? (
              <p className="text-sm text-muted-foreground">No versions yet.</p>
            ) : (
              <ul className="space-y-3">
                {slideVersions.map((v) => {
                  const isCurrent = selectedSlide.current_version_id === v.id;
                  const rationale = v.source_prompt ?? "";
                  const isLong = rationale.length > RATIONALE_CLAMP_CHARS;
                  const isExpanded = expandedRationales[v.id] === true;
                  // Immediately-prior version (same slide) to diff against —
                  // "what did this edit change". v1 has none, so no diff button.
                  const prior =
                    slideVersions.find(
                      (p) => p.version_no === v.version_no - 1,
                    ) ?? null;
                  const showDiff = diffVersionId === v.id;
                  return (
                    <li
                      key={v.id}
                      className="rounded-[10px] border border-border bg-paper px-4 py-3"
                    >
                      {/* Stack metadata above the action buttons on mobile so
                          the up-to-3 buttons get a full-width wrapping row
                          instead of crushing the version metadata. sm+ keeps
                          the original side-by-side layout. */}
                      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
                        <div className="min-w-0">
                        <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                          <span>v{v.version_no}</span>
                          {isCurrent ? (
                            <span className="rounded-full bg-[color:var(--accent-wash)] px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.06em] text-[color:var(--accent-dim)]">
                              current
                            </span>
                          ) : null}
                          {v.author_kind === "claude" ? (
                            <span className="rounded-full border border-border px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.06em] text-muted-foreground">
                              via agent
                            </span>
                          ) : null}
                        </div>
                        {rationale ? (
                          <p
                            className={`mt-1 whitespace-pre-wrap text-xs text-muted-foreground${
                              isLong && !isExpanded ? " line-clamp-2" : ""
                            }`}
                          >
                            “{rationale}”
                          </p>
                        ) : null}
                        {isLong ? (
                          <button
                            type="button"
                            onClick={() =>
                              setExpandedRationales((prev) => ({
                                ...prev,
                                [v.id]: !isExpanded,
                              }))
                            }
                            className="mt-1 text-[11px] font-medium text-[color:var(--accent)] hover:underline"
                          >
                            {isExpanded ? "Show less" : "Show more"}
                          </button>
                        ) : null}
                        <p className="mt-1 text-[11px] text-muted-foreground">
                          {v.created_by_label ?? "Unknown user"} · {v.created_at_formatted} ·{" "}
                          {v.created_at_relative}
                        </p>
                      </div>
                        {/* Wrap on mobile so 3 buttons never push past the
                            viewport; shrink-0 at sm+ keeps the desktop row. */}
                        <div className="flex flex-wrap items-center gap-2 sm:shrink-0 sm:flex-nowrap">
                          {prior ? (
                            <Button
                              type="button"
                              variant="ghost"
                              onClick={() => toggleDiff(v, prior)}
                              title={`Compare v${v.version_no} with v${prior.version_no}`}
                              className="h-10 sm:h-9"
                            >
                              {showDiff ? "Hide diff" : "View diff"}
                            </Button>
                          ) : null}
                          {!isCurrent ? (
                            <>
                              <Button
                                asChild
                                variant="ghost"
                                title="Open this version in a new tab"
                                className="h-10 sm:h-9"
                              >
                                <a
                                  href={`/api/decks/${deckId}/preview?versionId=${v.id}`}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                >
                                  Preview
                                </a>
                              </Button>
                              <Button
                                type="button"
                                variant="outline"
                                disabled={isPending}
                                onClick={() => handleRestoreVersion(v)}
                                className="h-10 sm:h-9"
                              >
                                Restore
                              </Button>
                            </>
                          ) : null}
                        </div>
                      </div>
                      {showDiff && prior ? (
                        <div className="mt-4 border-t border-border pt-4">
                          {diffContent[v.id] && diffContent[prior.id] ? (
                            (() => {
                              const vdiff = historyVersionDiff(
                                diffContent[prior.id],
                                diffContent[v.id],
                              );
                              return (
                                <>
                                  <p className="eyebrow mb-3 text-muted-foreground">
                                    Changes from v{prior.version_no} → v
                                    {v.version_no}
                                  </p>
                                  <ProposalDiff
                                    kind={vdiff.kind}
                                    oldContent={vdiff.oldContent}
                                    newContent={vdiff.newContent}
                                    deck={{
                                      title: deckTitle,
                                      theme_css: themeCss,
                                      nav_js: navJs,
                                      meta: deckMeta,
                                    }}
                                    slide={{
                                      position: selectedSlide.position,
                                      title: diffContent[v.id].title,
                                      slide_styles:
                                        diffContent[v.id].slide_styles ?? "",
                                    }}
                                    beforeSlide={{
                                      position: selectedSlide.position,
                                      title: diffContent[prior.id].title,
                                      slide_styles:
                                        diffContent[prior.id].slide_styles ?? "",
                                    }}
                                  />
                                </>
                              );
                            })()
                          ) : (
                            <p className="text-xs text-muted-foreground">
                              {diffLoadingId === v.id
                                ? "Loading diff…"
                                : "Couldn't load this diff."}
                            </p>
                          )}
                        </div>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
      </section>

      <ConfirmDialog
        open={confirmDialog != null}
        title={confirmDialog?.title ?? ""}
        body={confirmDialog?.body ?? ""}
        confirmLabel={confirmDialog?.confirmLabel ?? "Confirm"}
        pending={isPending}
        onConfirm={() => confirmDialog?.onConfirm()}
        onCancel={() => setConfirmDialog(null)}
      />
    </div>
  );
}

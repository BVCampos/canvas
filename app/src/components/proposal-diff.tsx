import { diffLines, diffWordsWithSpace, type Change } from "diff";
import { assembleDeckHtml } from "@/lib/canvas/assemble";
import { ProposalIframe } from "@/components/proposal-iframe";

// Visual diff for a canvas_deck_edit proposal.
//
// For slide_html kinds we render before/after iframes (each one a single
// slide assembled with the deck's theme) on top, then a GitHub-style split
// diff below: two columns with line numbers, red/green tinted rows for
// removed/added lines, word-level highlights inside changed pairs, and
// collapsed gaps over long unchanged regions.
//
// For slide_styles, theme_css, and nav_js we skip the iframes (a per-slide
// preview doesn't tell the right story for theme-wide edits) and just show
// the split diff.
//
// Removed lines use `bg-rose-50 text-rose-900`; added use `bg-emerald-50
// text-emerald-900`; inline word highlights bump to 100/200 backgrounds with
// 900 text for contrast. Each carries an explicit `dark:` override.
//
// NOTE: these rose/emerald palettes are DELIBERATELY literal and are NOT
// migrated to the --danger/--success state tokens (which the rest of the app
// uses). A diff is a code-review surface where the universal red=removed /
// green=added convention reads more clearly than the brand's muted
// brick-red / teal-green. Don't "tokenize" these in a future cleanup.

export type EditKind =
  | "slide_edit"
  | "slide_html"
  | "slide_styles"
  | "slide_title"
  | "slide_create"
  | "slide_reorder"
  | "slide_delete"
  | "theme_css"
  | "nav_js"
  | "deck_title";

export type DiffDeck = {
  title: string;
  theme_css: string;
  nav_js: string;
  meta?: Record<string, unknown> | null;
};

export type DiffSlide = {
  position: number;
  title: string;
  slide_styles: string;
};

// Payload for slide_create proposals. The fields mirror canvas_deck_edit's
// new_slide_payload jsonb column. position + html_body are guaranteed by the
// CHECK constraint; title + slide_styles fall back to empty strings.
export type NewSlidePayload = {
  position: number;
  title: string;
  html_body: string;
  slide_styles: string;
};

// Changed fields carried by a slide_edit proposal — any non-empty subset of
// the slide's html_body / slide_styles / title. A field PRESENT here is one
// the proposer touched (and gets its own sub-diff + counts toward the preview);
// a field ABSENT is left untouched on approval. Mirrors the new_slide_payload
// jsonb for kind='slide_edit'.
export type SlideEditPayload = {
  html_body?: string;
  slide_styles?: string;
  title?: string;
};

// The slide's state BEFORE a slide_edit — what each present payload field is
// diffed against. For pending proposals this is the current slide; for resolved
// ones it's the base version captured at propose time.
export type SlideEditBefore = {
  html_body: string;
  slide_styles: string;
  title: string;
};

type ProposalDiffProps = {
  kind: EditKind;
  oldContent: string;
  newContent: string;
  deck?: DiffDeck | null;
  slide?: DiffSlide | null;
  // Optional separate metadata (title + slide_styles) for the BEFORE pane.
  // When omitted, both panes share `slide` (the proposal case, where only
  // html_body differs). The History version-diff sets this so the Before pane
  // renders the PRIOR version's own styles/title, not the new version's.
  beforeSlide?: DiffSlide | null;
  // Only used when kind === 'slide_create' — drives the single-pane preview
  // and the "no diff to render" path (creates have no before state).
  newSlidePayload?: NewSlidePayload | null;
  // Used when kind === 'slide_edit' — the changed fields and the before-state
  // they diff against. Renders one combined card: a before/after preview
  // reflecting the WHOLE bundle (new html + new css together) plus a sub-diff
  // for each touched field.
  slideEditPayload?: SlideEditPayload | null;
  slideEditBefore?: SlideEditBefore | null;
};

const COLLAPSE_THRESHOLD = 6; // collapse unchanged runs longer than this
const COLLAPSE_CONTEXT = 3; // keep this many context lines around each gap

export function ProposalDiff({
  kind,
  oldContent,
  newContent,
  deck,
  slide,
  beforeSlide,
  newSlidePayload,
  slideEditPayload,
  slideEditBefore,
}: ProposalDiffProps) {
  // slide_edit bundles any subset of html_body / slide_styles / title into one
  // proposal. Render a combined card: a before/after preview that reflects the
  // whole bundle, then a sub-diff per touched field. Falls back to oldContent /
  // slide when the dedicated before-state props aren't supplied.
  if (kind === "slide_edit") {
    return (
      <SlideEditDiff
        deck={deck ?? null}
        before={
          slideEditBefore ?? {
            html_body: oldContent,
            slide_styles: slide?.slide_styles ?? "",
            title: slide?.title ?? "",
          }
        }
        payload={slideEditPayload ?? {}}
      />
    );
  }

  // slide_create has no "before" state — render a single preview pane plus
  // the new slide's HTML body in a single-column code block (no diff).
  if (kind === "slide_create") {
    return (
      <NewSlideRender
        deck={deck ?? null}
        payload={newSlidePayload ?? null}
        fallbackBody={newContent}
      />
    );
  }

  // deck_title / slide_title are single strings — a line-oriented split diff
  // would be overkill. Render the old value struck through and the new value
  // bold so the change reads at a glance. slide_title is the slide's sidebar
  // label, so an emptied "after" reads as "(no label)" rather than "(empty)".
  if (kind === "deck_title") {
    return <TitleDiff label="Deck title" oldTitle={oldContent} newTitle={newContent} />;
  }
  if (kind === "slide_title") {
    return (
      <TitleDiff
        label="Slide label"
        oldTitle={oldContent}
        newTitle={newContent}
        emptyAfter="(no label)"
      />
    );
  }

  // Structural ops have no line-oriented content diff — render a summary card.
  // The exact change (target order / which slide) lives in the proposer's
  // rationale, shown by the sheet/detail page around this component.
  if (kind === "slide_reorder") {
    return (
      <StructuralNote
        label="Slide order"
        body="Approving rewrites the deck's slide order to the proposed sequence. The exact order is in the rationale below; open the deck to preview the result."
      />
    );
  }
  if (kind === "slide_delete") {
    return (
      <StructuralNote
        tone="danger"
        label="Slide deletion"
        body="Approving permanently removes this slide and its entire version history (and any comments on it) — it cannot be restored. See the rationale below."
      />
    );
  }

  const showPreview = kind === "slide_html" && deck && slide;
  const language = labelForKind(kind);

  return (
    <div className="space-y-6">
      {showPreview && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <SlidePreview
            label="Before"
            deck={deck!}
            slide={{ ...(beforeSlide ?? slide!), html_body: oldContent }}
          />
          <SlidePreview
            label="After"
            deck={deck!}
            slide={{ ...slide!, html_body: newContent }}
          />
        </div>
      )}

      <div className="space-y-2">
        <div className="flex items-baseline justify-between">
          <div className="eyebrow text-muted-foreground">{language}</div>
          <DiffStats oldContent={oldContent} newContent={newContent} />
        </div>
        <SplitDiff oldContent={oldContent} newContent={newContent} />
      </div>
    </div>
  );
}

// Combined diff for a slide_edit proposal — the bundled-change review surface.
// The proposal carries any subset of { html_body, slide_styles, title }; we
// render exactly the touched fields:
//   - a before/after slide preview when html or CSS changed, where the AFTER
//     pane composes BOTH the new html AND the new CSS so the reviewer sees the
//     true combined result (not one half at a time);
//   - a title before/after when the label changed;
//   - a split code diff per touched field below.
// This is the whole point of bundling: one card, one decision, no partial-
// approval gap between coupled markup and styles.
function SlideEditDiff({
  deck,
  before,
  payload,
}: {
  deck: DiffDeck | null;
  before: SlideEditBefore;
  payload: SlideEditPayload;
}) {
  const htmlChanged = payload.html_body !== undefined;
  const stylesChanged = payload.slide_styles !== undefined;
  const titleChanged = payload.title !== undefined;

  const afterHtml = payload.html_body ?? before.html_body;
  const afterStyles = payload.slide_styles ?? before.slide_styles;
  const afterTitle = payload.title ?? before.title;

  // A scoped-CSS change is visible on the slide too, so we show the preview
  // whenever html OR styles moved (only a title-only change skips it — the
  // label doesn't render on the slide).
  const showPreview = (htmlChanged || stylesChanged) && deck;

  return (
    <div className="space-y-6">
      {showPreview && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <SlidePreview
            label="Before"
            deck={deck!}
            slide={{
              position: 0,
              title: before.title,
              slide_styles: before.slide_styles,
              html_body: before.html_body,
            }}
          />
          <SlidePreview
            label="After"
            deck={deck!}
            slide={{
              position: 0,
              title: afterTitle,
              slide_styles: afterStyles,
              html_body: afterHtml,
            }}
          />
        </div>
      )}

      {titleChanged && (
        <TitleDiff
          label="Slide label"
          oldTitle={before.title}
          newTitle={afterTitle}
          emptyAfter="(no label)"
        />
      )}

      {htmlChanged && (
        <div className="space-y-2">
          <div className="flex items-baseline justify-between">
            <div className="eyebrow text-muted-foreground">Slide HTML</div>
            <DiffStats oldContent={before.html_body} newContent={afterHtml} />
          </div>
          <SplitDiff oldContent={before.html_body} newContent={afterHtml} />
        </div>
      )}

      {stylesChanged && (
        <div className="space-y-2">
          <div className="flex items-baseline justify-between">
            <div className="eyebrow text-muted-foreground">Slide CSS</div>
            <DiffStats
              oldContent={before.slide_styles}
              newContent={afterStyles}
            />
          </div>
          <SplitDiff
            oldContent={before.slide_styles}
            newContent={afterStyles}
          />
        </div>
      )}
    </div>
  );
}

// Single-pane preview for slide_create proposals. Renders the proposed slide
// inside the deck's theme (so the reviewer sees what they'd be approving in
// context) and shows the raw HTML body below for code review. Missing deck or
// payload data falls back to a plain code block so the page still renders.
function NewSlideRender({
  deck,
  payload,
  fallbackBody,
}: {
  deck: DiffDeck | null;
  payload: NewSlidePayload | null;
  fallbackBody: string;
}) {
  const htmlBody = payload?.html_body ?? fallbackBody;
  const title = payload?.title ?? "";
  const slideStyles = payload?.slide_styles ?? "";

  return (
    <div className="space-y-6">
      {deck && payload && (
        <SlidePreview
          label={`New slide${
            payload.title ? ` — ${payload.title}` : ""
          } (position ${payload.position + 1})`}
          deck={deck}
          slide={{
            position: payload.position,
            title,
            slide_styles: slideStyles,
            html_body: htmlBody,
          }}
        />
      )}

      <div className="space-y-2">
        <div className="eyebrow text-muted-foreground">Slide HTML</div>
        {/* The body wraps (whitespace-pre-wrap break-words), so on mobile we
            drop the 640px min-width that would otherwise force horizontal
            scroll; md+ keeps the desktop min-width. */}
        <div className="overflow-x-auto rounded-[8px] border border-border bg-card text-xs font-mono leading-relaxed">
          <pre className="whitespace-pre-wrap break-words p-3 text-emerald-900 dark:text-emerald-200 md:min-w-[640px]">
            {htmlBody || "(empty body)"}
          </pre>
        </div>
        {slideStyles ? (
          <>
            <div className="eyebrow mt-4 text-muted-foreground">Slide CSS</div>
            <div className="overflow-x-auto rounded-[8px] border border-border bg-card text-xs font-mono leading-relaxed">
              <pre className="whitespace-pre-wrap break-words p-3 text-emerald-900 dark:text-emerald-200 md:min-w-[640px]">
                {slideStyles}
              </pre>
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}

// Single-string before/after for title proposals (deck_title and slide_title).
// Matches the visual language of the rest of the file (rose-tinted "removed",
// emerald-tinted "added") but skips the line-numbered grid since a title is a
// single short value. `label` names the field; `emptyAfter` is the placeholder
// shown when the proposal clears the value.
function TitleDiff({
  label,
  oldTitle,
  newTitle,
  emptyAfter = "(empty)",
}: {
  label: string;
  oldTitle: string;
  newTitle: string;
  emptyAfter?: string;
}) {
  return (
    <div className="space-y-2">
      <div className="eyebrow text-muted-foreground">{label}</div>
      <div className="overflow-hidden rounded-[8px] border border-border bg-card text-sm">
        <div className="flex items-baseline gap-3 border-b border-border/40 bg-rose-50 px-3 py-2 text-rose-900 dark:bg-rose-500/10 dark:text-rose-200">
          <span className="w-12 shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground">
            Before
          </span>
          <span className="min-w-0 flex-1 truncate text-muted-foreground line-through">
            {oldTitle || "(untitled)"}
          </span>
        </div>
        <div className="flex items-baseline gap-3 bg-emerald-50 px-3 py-2 text-emerald-900 dark:bg-emerald-500/10 dark:text-emerald-200">
          <span className="w-12 shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground">
            After
          </span>
          <span className="min-w-0 flex-1 truncate font-semibold">
            {newTitle || emptyAfter}
          </span>
        </div>
      </div>
    </div>
  );
}

function SlidePreview({
  label,
  deck,
  slide,
}: {
  label: string;
  deck: DiffDeck;
  slide: DiffSlide & { html_body: string };
}) {
  const html = assembleDeckHtml({
    title: deck.title,
    theme_css: deck.theme_css,
    nav_js: deck.nav_js,
    meta: deck.meta ?? {},
    slides: [
      {
        position: 0,
        title: slide.title,
        html_body: slide.html_body,
        slide_styles: slide.slide_styles,
      },
    ],
    // Proposal before/after iframes are read-only previews — the click-to-
    // edit hint baked into the deck's theme/nav reads as a false promise
    // here (editing happens via Claude/MCP only). Live editor preview
    // doesn't pass this flag.
    suppressEditHint: true,
  });
  return (
    <div className="space-y-2">
      <div className="eyebrow text-muted-foreground">{label}</div>
      <ProposalIframe
        html={html}
        title={`${label} preview`}
        className="aspect-video w-full"
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Split diff rendering
// ---------------------------------------------------------------------------

type WordSeg = { text: string; changed: boolean };

type SplitRow =
  | {
      kind: "context";
      oldLine: number;
      newLine: number;
      text: string;
    }
  | {
      kind: "changed";
      oldLine: number | null;
      newLine: number | null;
      oldText: string | null;
      newText: string | null;
      // Inline word-level highlights when both sides exist; null otherwise.
      oldHighlights: WordSeg[] | null;
      newHighlights: WordSeg[] | null;
    }
  | { kind: "gap"; hidden: number };

function splitLines(value: string): string[] {
  const parts = value.split("\n");
  if (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
  return parts;
}

function buildSplitRows(oldContent: string, newContent: string): SplitRow[] {
  const chunks: Change[] = diffLines(oldContent, newContent);
  const rows: SplitRow[] = [];
  let oldLineNo = 1;
  let newLineNo = 1;

  let i = 0;
  while (i < chunks.length) {
    const chunk = chunks[i];
    const next = chunks[i + 1];

    if (!chunk.added && !chunk.removed) {
      for (const line of splitLines(chunk.value)) {
        rows.push({
          kind: "context",
          oldLine: oldLineNo++,
          newLine: newLineNo++,
          text: line,
        });
      }
      i += 1;
      continue;
    }

    // Pair a "removed" chunk with an immediately-following "added" chunk so
    // each pair of changed lines lands on the same row — that's what makes
    // the split view scannable.
    if (chunk.removed && next?.added) {
      const removed = splitLines(chunk.value);
      const added = splitLines(next.value);
      const max = Math.max(removed.length, added.length);
      for (let j = 0; j < max; j++) {
        const oldLine = j < removed.length ? removed[j] : null;
        const newLine = j < added.length ? added[j] : null;
        let oldHighlights: WordSeg[] | null = null;
        let newHighlights: WordSeg[] | null = null;
        if (oldLine !== null && newLine !== null) {
          const wordDiff = diffWordsWithSpace(oldLine, newLine);
          oldHighlights = wordDiff
            .filter((w) => !w.added)
            .map((w) => ({ text: w.value, changed: Boolean(w.removed) }));
          newHighlights = wordDiff
            .filter((w) => !w.removed)
            .map((w) => ({ text: w.value, changed: Boolean(w.added) }));
        }
        rows.push({
          kind: "changed",
          oldLine: oldLine !== null ? oldLineNo++ : null,
          newLine: newLine !== null ? newLineNo++ : null,
          oldText: oldLine,
          newText: newLine,
          oldHighlights,
          newHighlights,
        });
      }
      i += 2;
      continue;
    }

    if (chunk.removed) {
      for (const line of splitLines(chunk.value)) {
        rows.push({
          kind: "changed",
          oldLine: oldLineNo++,
          newLine: null,
          oldText: line,
          newText: null,
          oldHighlights: null,
          newHighlights: null,
        });
      }
      i += 1;
      continue;
    }

    // chunk.added
    for (const line of splitLines(chunk.value)) {
      rows.push({
        kind: "changed",
        oldLine: null,
        newLine: newLineNo++,
        oldText: null,
        newText: line,
        oldHighlights: null,
        newHighlights: null,
      });
    }
    i += 1;
  }

  return rows;
}

function collapseContext(rows: SplitRow[]): SplitRow[] {
  const out: SplitRow[] = [];
  let i = 0;
  while (i < rows.length) {
    if (rows[i].kind !== "context") {
      out.push(rows[i]);
      i++;
      continue;
    }
    let j = i;
    while (j < rows.length && rows[j].kind === "context") j++;
    const run = j - i;
    const atStart = i === 0;
    const atEnd = j === rows.length;
    const leadKeep = atStart ? 0 : COLLAPSE_CONTEXT;
    const tailKeep = atEnd ? 0 : COLLAPSE_CONTEXT;
    if (run > leadKeep + tailKeep + 1) {
      for (let k = 0; k < leadKeep; k++) out.push(rows[i + k]);
      out.push({ kind: "gap", hidden: run - leadKeep - tailKeep });
      for (let k = run - tailKeep; k < run; k++) out.push(rows[i + k]);
    } else {
      for (let k = 0; k < run; k++) out.push(rows[i + k]);
    }
    i = j;
  }
  return out;
}

function SplitDiff({
  oldContent,
  newContent,
}: {
  oldContent: string;
  newContent: string;
}) {
  const rows = collapseContext(buildSplitRows(oldContent, newContent));

  if (rows.length === 0 || rows.every((r) => r.kind === "context")) {
    return (
      <div className="rounded-[8px] border border-border bg-card p-4 text-xs text-muted-foreground">
        No changes.
      </div>
    );
  }

  // Below md the two-column split would force a 640px min-width and horizontal
  // scroll — a poor mobile read. So we STACK to a single-column unified view on
  // mobile (Before line above After line per change) and only switch to the
  // side-by-side grid (with its scroll-protecting min-width) at md+. The header
  // labels are redundant in the stacked view (each cell self-labels via its
  // ± sign and tint), so they're hidden below md.
  return (
    <div className="overflow-x-auto rounded-[8px] border border-border bg-card text-xs font-mono leading-relaxed">
      <div className="md:min-w-[640px]">
        <div className="hidden grid-cols-2 border-b border-border bg-muted/40 text-[10px] uppercase tracking-wide text-muted-foreground md:grid">
          <div className="border-r border-border px-3 py-1.5">Before</div>
          <div className="px-3 py-1.5">After</div>
        </div>
        <div>
          {rows.map((row, idx) => (
            <SplitRowView key={idx} row={row} />
          ))}
        </div>
      </div>
    </div>
  );
}

function SplitRowView({ row }: { row: SplitRow }) {
  if (row.kind === "gap") {
    return (
      <div className="border-y border-border/60 bg-muted/30 px-3 py-1 text-center text-[10px] uppercase tracking-wide text-muted-foreground">
        · · · {row.hidden} unchanged line{row.hidden === 1 ? "" : "s"} · · ·
      </div>
    );
  }

  if (row.kind === "context") {
    // Context lines are identical on both sides — show one copy on mobile
    // (the right cell is hidden below md), the side-by-side pair at md+.
    return (
      <div className="flex flex-col border-t border-border/40 md:grid md:grid-cols-2">
        <DiffCell
          side="left"
          lineNo={row.oldLine}
          tone="context"
          text={row.text}
        />
        <div className="hidden md:block">
          <DiffCell
            side="right"
            lineNo={row.newLine}
            tone="context"
            text={row.text}
          />
        </div>
      </div>
    );
  }

  // Stacked on mobile: removed line above added line. Empty cells (the opposite
  // side of an unpaired add/remove) are hidden below md so a pure addition/
  // removal doesn't render a meaningless blank box on its own row. At md+ the
  // empty cell reappears to keep the two columns aligned.
  return (
    <div className="flex flex-col border-t border-border/40 md:grid md:grid-cols-2">
      <div className={row.oldText === null ? "hidden md:block" : undefined}>
        <DiffCell
          side="left"
          lineNo={row.oldLine}
          tone={row.oldText === null ? "empty" : "removed"}
          text={row.oldText}
          highlights={row.oldHighlights}
          highlightTone="removed"
        />
      </div>
      <div className={row.newText === null ? "hidden md:block" : undefined}>
        <DiffCell
          side="right"
          lineNo={row.newLine}
          tone={row.newText === null ? "empty" : "added"}
          text={row.newText}
          highlights={row.newHighlights}
          highlightTone="added"
        />
      </div>
    </div>
  );
}

type CellTone = "context" | "removed" | "added" | "empty";

function DiffCell({
  side,
  lineNo,
  text,
  tone,
  highlights,
  highlightTone,
}: {
  side: "left" | "right";
  lineNo: number | null;
  text: string | null;
  tone: CellTone;
  highlights?: WordSeg[] | null;
  highlightTone?: "removed" | "added";
}) {
  // Light-theme tints: pale tinted background, dark ink for the text. Empty
  // cells (the opposite side of an unpaired remove/add) get a subtle muted
  // bg so the eye reads them as "no content here, intentionally."
  const bg =
    tone === "removed"
      ? "bg-rose-50 dark:bg-rose-500/10"
      : tone === "added"
        ? "bg-emerald-50 dark:bg-emerald-500/10"
        : tone === "empty"
          ? "bg-muted/30"
          : "";
  const textColor =
    tone === "removed"
      ? "text-rose-900 dark:text-rose-200"
      : tone === "added"
        ? "text-emerald-900 dark:text-emerald-200"
        : "text-foreground/80";
  const sign = tone === "removed" ? "−" : tone === "added" ? "+" : " ";
  // The column divider only makes sense in the side-by-side (md+) layout; in
  // the stacked mobile view the left cell is full-width, so scope it to md+.
  const borderClass = side === "left" ? "md:border-r md:border-border" : "";
  return (
    <div className={`flex min-w-0 ${bg} ${borderClass}`}>
      <span className="w-10 shrink-0 select-none border-r border-border/40 px-2 py-0.5 text-right text-[11px] tabular-nums text-muted-foreground/70">
        {lineNo ?? ""}
      </span>
      <span className="w-4 shrink-0 select-none px-1.5 py-0.5 text-center text-muted-foreground/60">
        {sign}
      </span>
      <span
        className={`min-w-0 flex-1 whitespace-pre-wrap break-words px-2 py-0.5 ${textColor}`}
      >
        {text === null ? (
          ""
        ) : highlights && highlights.length > 0 ? (
          <HighlightedLine segments={highlights} tone={highlightTone!} />
        ) : (
          text || " "
        )}
      </span>
    </div>
  );
}

function HighlightedLine({
  segments,
  tone,
}: {
  segments: WordSeg[];
  tone: "removed" | "added";
}) {
  const highlightBg =
    tone === "removed"
      ? "bg-rose-200 text-rose-950 dark:bg-rose-400/30 dark:text-rose-100"
      : "bg-emerald-200 text-emerald-950 dark:bg-emerald-400/30 dark:text-emerald-100";
  // If everything is "changed", drop the inner highlights — the row-level
  // background already conveys the change and the inner spans add no signal.
  const allChanged = segments.every((s) => s.changed);
  return (
    <>
      {segments.map((seg, idx) =>
        seg.changed && !allChanged ? (
          <span key={idx} className={`${highlightBg} rounded-[2px]`}>
            {seg.text}
          </span>
        ) : (
          <span key={idx}>{seg.text}</span>
        ),
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Header stats
// ---------------------------------------------------------------------------

function DiffStats({
  oldContent,
  newContent,
}: {
  oldContent: string;
  newContent: string;
}) {
  const parts = diffLines(oldContent, newContent);
  let added = 0;
  let removed = 0;
  for (const part of parts) {
    if (part.added) added += part.count ?? 0;
    else if (part.removed) removed += part.count ?? 0;
  }
  return (
    <div className="text-xs font-mono tabular-nums">
      <span className="text-emerald-700 dark:text-emerald-300">+{added}</span>
      <span className="mx-1 text-muted-foreground">/</span>
      <span className="text-rose-700 dark:text-rose-300">−{removed}</span>
    </div>
  );
}

function labelForKind(kind: EditKind): string {
  switch (kind) {
    case "slide_edit":
      return "Slide edit";
    case "slide_html":
      return "Slide HTML";
    case "slide_styles":
      return "Slide CSS";
    case "slide_title":
      return "Slide label";
    case "slide_create":
      return "New slide";
    case "slide_reorder":
      return "Slide order";
    case "slide_delete":
      return "Delete slide";
    case "theme_css":
      return "Theme CSS";
    case "nav_js":
      return "Nav JS";
    case "deck_title":
      return "Deck title";
  }
}

// Summary card for structural ops (slide_reorder / slide_delete) that have no
// content diff to render.
function StructuralNote({
  label,
  body,
  tone = "info",
}: {
  label: string;
  body: string;
  tone?: "info" | "danger";
}) {
  return (
    <div
      className={`rounded-[12px] border p-4 text-sm ${
        tone === "danger"
          ? "border-danger/30 bg-danger/10 text-danger-fg"
          : "border-border bg-card text-foreground"
      }`}
    >
      <div className="eyebrow mb-1 text-muted-foreground">{label}</div>
      <p>{body}</p>
    </div>
  );
}

// Unused but kept as a documentation hook for future tweaking.
export { COLLAPSE_THRESHOLD, COLLAPSE_CONTEXT };

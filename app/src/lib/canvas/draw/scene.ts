// ============================================================
// Drawing scene model — the pure core of the Excalidraw-style draw surface.
// ============================================================
// A drawn slide is just an SVG inside a normal `<section class="slide">`, so it
// renders in the preview iframe, PDF/PPTX export, and thumbnails with ZERO
// pipeline changes (it's HTML). To make a drawing RE-EDITABLE we also stash the
// structured scene (the element list) on the section as a `data-canvas-scene`
// attribute (URL-encoded JSON); reopening the draw surface decodes it back.
//
// This module is deliberately pure + DOM-free (no React, no `document`) so the
// serialization, encode/decode round-trip, and hit-testing are unit-tested in
// isolation (tests/draw-scene.test.ts). The interactive surface
// (draw-canvas.tsx) owns pointer handling and id generation; it only ever hands
// fully-formed elements to these functions.
//
// Coordinate system: every element lives in a fixed 1280×720 (16:9) space — the
// same sheet the PPTX/PDF export normalizes to (lib/canvas/export-chrome.ts).
// The SVG carries that as its viewBox and sizes responsively (width:100%,
// height:auto preserves the aspect), so a drawn slide fits any deck width.
// ============================================================

export const DRAW_W = 1280;
export const DRAW_H = 720;

export type ElementType =
  | "freehand"
  | "line"
  | "arrow"
  | "rect"
  | "ellipse"
  | "text";

type ElementBase = {
  id: string;
  type: ElementType;
};

export type FreehandElement = ElementBase & {
  type: "freehand";
  // Flat [x0, y0, x1, y1, …] in the 1280×720 space — compact in JSON.
  points: number[];
  stroke: string;
  strokeWidth: number;
  opacity?: number;
};

export type LinearElement = ElementBase & {
  type: "line" | "arrow";
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  stroke: string;
  strokeWidth: number;
  opacity?: number;
};

export type BoxElement = ElementBase & {
  type: "rect" | "ellipse";
  // Top-left + size; w/h may be negative mid-drag and are normalized on render.
  x: number;
  y: number;
  w: number;
  h: number;
  stroke: string;
  strokeWidth: number;
  fill: string; // "none" or a hex colour
  opacity?: number;
};

export type TextElement = ElementBase & {
  type: "text";
  // Top-left of the text block.
  x: number;
  y: number;
  text: string;
  fontSize: number;
  color: string;
  fontFamily?: string;
};

export type DrawElement =
  | FreehandElement
  | LinearElement
  | BoxElement
  | TextElement;

export type DrawScene = {
  version: 1;
  width: number;
  height: number;
  background: string; // hex; "" or "transparent" leaves the slide background
  elements: DrawElement[];
};

export const DEFAULT_FONT_FAMILY =
  "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

export function emptyScene(background = "#ffffff"): DrawScene {
  return { version: 1, width: DRAW_W, height: DRAW_H, background, elements: [] };
}

// ------------------------------------------------------------
// Geometry helpers (pure)
// ------------------------------------------------------------

/** Round to 1 decimal and drop a trailing ".0" so the SVG/JSON stays small. */
function fmt(n: number): string {
  const r = Math.round(n * 10) / 10;
  return Object.is(r, -0) ? "0" : String(r);
}

/** Normalize a possibly-negative box to top-left + positive size. */
export function normalizeBox(x: number, y: number, w: number, h: number) {
  return {
    x: Math.min(x, x + w),
    y: Math.min(y, y + h),
    w: Math.abs(w),
    h: Math.abs(h),
  };
}

function pairs(points: number[]): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let i = 0; i + 1 < points.length; i += 2) out.push([points[i], points[i + 1]]);
  return out;
}

/** Shortest distance from point (px,py) to segment (ax,ay)-(bx,by). */
function distToSegment(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(px - ax, py - ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

const textLines = (t: string): string[] => t.split("\n");

/** Axis-aligned bounding box of an element, normalized. */
export function elementBounds(el: DrawElement): {
  x: number;
  y: number;
  w: number;
  h: number;
} {
  switch (el.type) {
    case "freehand": {
      const ps = pairs(el.points);
      if (ps.length === 0) return { x: 0, y: 0, w: 0, h: 0 };
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const [x, y] of ps) {
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
      return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
    }
    case "line":
    case "arrow":
      return normalizeBox(el.x1, el.y1, el.x2 - el.x1, el.y2 - el.y1);
    case "rect":
    case "ellipse":
      return normalizeBox(el.x, el.y, el.w, el.h);
    case "text": {
      const lines = textLines(el.text);
      const longest = lines.reduce((m, l) => Math.max(m, l.length), 0);
      return {
        x: el.x,
        y: el.y,
        w: Math.max(longest * el.fontSize * 0.6, el.fontSize),
        h: lines.length * el.fontSize * 1.25,
      };
    }
  }
}

/**
 * Topmost element under (px,py), or null. Later elements paint on top, so we
 * scan back-to-front. `tolerance` is the slop in scene units for hitting a thin
 * stroke; the surface passes a fixed value (8 for select, 10 for the eraser).
 */
export function hitTest(
  scene: DrawScene,
  px: number,
  py: number,
  tolerance = 8,
): string | null {
  for (let i = scene.elements.length - 1; i >= 0; i -= 1) {
    if (hitElement(scene.elements[i], px, py, tolerance)) {
      return scene.elements[i].id;
    }
  }
  return null;
}

function hitElement(
  el: DrawElement,
  px: number,
  py: number,
  tol: number,
): boolean {
  switch (el.type) {
    case "freehand": {
      const ps = pairs(el.points);
      const slop = tol + el.strokeWidth / 2;
      if (ps.length === 1) return Math.hypot(px - ps[0][0], py - ps[0][1]) <= slop;
      for (let i = 0; i + 1 < ps.length; i += 1) {
        if (distToSegment(px, py, ps[i][0], ps[i][1], ps[i + 1][0], ps[i + 1][1]) <= slop) {
          return true;
        }
      }
      return false;
    }
    case "line":
    case "arrow":
      return (
        distToSegment(px, py, el.x1, el.y1, el.x2, el.y2) <= tol + el.strokeWidth / 2
      );
    case "rect": {
      const b = normalizeBox(el.x, el.y, el.w, el.h);
      const inside = px >= b.x && px <= b.x + b.w && py >= b.y && py <= b.y + b.h;
      if (el.fill && el.fill !== "none") return inside;
      const slop = tol + el.strokeWidth / 2;
      // Near any of the four edges.
      const nearV =
        (Math.abs(px - b.x) <= slop || Math.abs(px - (b.x + b.w)) <= slop) &&
        py >= b.y - slop &&
        py <= b.y + b.h + slop;
      const nearH =
        (Math.abs(py - b.y) <= slop || Math.abs(py - (b.y + b.h)) <= slop) &&
        px >= b.x - slop &&
        px <= b.x + b.w + slop;
      return nearV || nearH;
    }
    case "ellipse": {
      const b = normalizeBox(el.x, el.y, el.w, el.h);
      const rx = b.w / 2;
      const ry = b.h / 2;
      if (rx <= 0 || ry <= 0) return false;
      const cx = b.x + rx;
      const cy = b.y + ry;
      const norm = ((px - cx) / rx) ** 2 + ((py - cy) / ry) ** 2;
      if (el.fill && el.fill !== "none") return norm <= 1;
      // Border band: distance from the unit ellipse, scaled back to px.
      const slop = tol + el.strokeWidth / 2;
      return Math.abs(Math.sqrt(norm) - 1) * Math.min(rx, ry) <= slop;
    }
    case "text": {
      const b = elementBounds(el);
      return px >= b.x && px <= b.x + b.w && py >= b.y && py <= b.y + b.h;
    }
  }
}

/** Return a copy of `el` translated by (dx,dy). */
export function translateElement(
  el: DrawElement,
  dx: number,
  dy: number,
): DrawElement {
  switch (el.type) {
    case "freehand":
      return {
        ...el,
        points: el.points.map((v, i) => (i % 2 === 0 ? v + dx : v + dy)),
      };
    case "line":
    case "arrow":
      return { ...el, x1: el.x1 + dx, y1: el.y1 + dy, x2: el.x2 + dx, y2: el.y2 + dy };
    case "rect":
    case "ellipse":
      return { ...el, x: el.x + dx, y: el.y + dy };
    case "text":
      return { ...el, x: el.x + dx, y: el.y + dy };
  }
}

// ------------------------------------------------------------
// SVG serialization (pure → string)
// ------------------------------------------------------------

function escAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const opacityAttr = (o: number | undefined): string =>
  o != null && o < 1 ? ` opacity="${fmt(o)}"` : "";

/** SVG path `d` for a freehand stroke, smoothed via midpoint quadratics. */
export function freehandPathD(points: number[]): string {
  const ps = pairs(points);
  if (ps.length === 0) return "";
  if (ps.length === 1) return `M ${fmt(ps[0][0])} ${fmt(ps[0][1])}`;
  if (ps.length === 2) {
    return `M ${fmt(ps[0][0])} ${fmt(ps[0][1])} L ${fmt(ps[1][0])} ${fmt(ps[1][1])}`;
  }
  let d = `M ${fmt(ps[0][0])} ${fmt(ps[0][1])}`;
  for (let i = 1; i < ps.length - 1; i += 1) {
    const mx = (ps[i][0] + ps[i + 1][0]) / 2;
    const my = (ps[i][1] + ps[i + 1][1]) / 2;
    d += ` Q ${fmt(ps[i][0])} ${fmt(ps[i][1])} ${fmt(mx)} ${fmt(my)}`;
  }
  const last = ps[ps.length - 1];
  d += ` L ${fmt(last[0])} ${fmt(last[1])}`;
  return d;
}

function arrowHeadPath(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  strokeWidth: number,
): string {
  const angle = Math.atan2(y2 - y1, x2 - x1);
  const len = Math.min(Math.max(strokeWidth * 3.5 + 6, 12), 48);
  const spread = Math.PI / 7;
  const ax = x2 - len * Math.cos(angle - spread);
  const ay = y2 - len * Math.sin(angle - spread);
  const bx = x2 - len * Math.cos(angle + spread);
  const by = y2 - len * Math.sin(angle + spread);
  return `M ${fmt(ax)} ${fmt(ay)} L ${fmt(x2)} ${fmt(y2)} L ${fmt(bx)} ${fmt(by)}`;
}

/** SVG markup for a single element — exported so the live editor overlay can
 * preview an in-progress shape with the exact serialization the saved slide
 * uses (no WYSIWYG drift between editing and output). */
export function elementToSvg(el: DrawElement): string {
  switch (el.type) {
    case "freehand": {
      const ps = pairs(el.points);
      const common = `stroke="${escAttr(el.stroke)}" stroke-width="${fmt(el.strokeWidth)}" stroke-linecap="round" stroke-linejoin="round"${opacityAttr(el.opacity)}`;
      if (ps.length === 1) {
        // A single tap = a dot.
        return `<circle cx="${fmt(ps[0][0])}" cy="${fmt(ps[0][1])}" r="${fmt(el.strokeWidth / 2)}" fill="${escAttr(el.stroke)}"${opacityAttr(el.opacity)} />`;
      }
      return `<path d="${freehandPathD(el.points)}" fill="none" ${common} />`;
    }
    case "line":
      return `<line x1="${fmt(el.x1)}" y1="${fmt(el.y1)}" x2="${fmt(el.x2)}" y2="${fmt(el.y2)}" stroke="${escAttr(el.stroke)}" stroke-width="${fmt(el.strokeWidth)}" stroke-linecap="round"${opacityAttr(el.opacity)} />`;
    case "arrow": {
      const common = `stroke="${escAttr(el.stroke)}" stroke-width="${fmt(el.strokeWidth)}" stroke-linecap="round" stroke-linejoin="round" fill="none"${opacityAttr(el.opacity)}`;
      return (
        `<line x1="${fmt(el.x1)}" y1="${fmt(el.y1)}" x2="${fmt(el.x2)}" y2="${fmt(el.y2)}" ${common} />` +
        `<path d="${arrowHeadPath(el.x1, el.y1, el.x2, el.y2, el.strokeWidth)}" ${common} />`
      );
    }
    case "rect": {
      const b = normalizeBox(el.x, el.y, el.w, el.h);
      return `<rect x="${fmt(b.x)}" y="${fmt(b.y)}" width="${fmt(b.w)}" height="${fmt(b.h)}" rx="2" fill="${escAttr(el.fill || "none")}" stroke="${escAttr(el.stroke)}" stroke-width="${fmt(el.strokeWidth)}"${opacityAttr(el.opacity)} />`;
    }
    case "ellipse": {
      const b = normalizeBox(el.x, el.y, el.w, el.h);
      return `<ellipse cx="${fmt(b.x + b.w / 2)}" cy="${fmt(b.y + b.h / 2)}" rx="${fmt(b.w / 2)}" ry="${fmt(b.h / 2)}" fill="${escAttr(el.fill || "none")}" stroke="${escAttr(el.stroke)}" stroke-width="${fmt(el.strokeWidth)}"${opacityAttr(el.opacity)} />`;
    }
    case "text": {
      const lines = textLines(el.text);
      const family = el.fontFamily || DEFAULT_FONT_FAMILY;
      const tspans = lines
        .map((ln, i) => {
          // Absolute per-line baseline (top-left anchor → first baseline ~0.8em
          // down) so we don't depend on dominant-baseline support in headless
          // Chromium.
          const y = el.y + el.fontSize * 0.8 + i * el.fontSize * 1.25;
          return `<tspan x="${fmt(el.x)}" y="${fmt(y)}">${escText(ln) || " "}</tspan>`;
        })
        .join("");
      return `<text font-family="${escAttr(family)}" font-size="${fmt(el.fontSize)}" fill="${escAttr(el.color)}"${opacityAttr((el as TextElement & { opacity?: number }).opacity)} style="white-space:pre">${tspans}</text>`;
    }
  }
}

/** Full `<svg>…</svg>` markup for a scene. */
export function sceneToSvg(scene: DrawScene): string {
  const w = scene.width || DRAW_W;
  const h = scene.height || DRAW_H;
  const bg =
    scene.background && scene.background !== "transparent"
      ? `<rect x="0" y="0" width="${w}" height="${h}" fill="${escAttr(scene.background)}" />`
      : "";
  const body = scene.elements.map(elementToSvg).join("");
  // width:100% + height:auto keeps the 16:9 aspect at any container width
  // without depending on the deck's .slide sizing.
  return `<svg class="canvas-draw-svg" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid meet" style="display:block;width:100%;height:auto">${bg}${body}</svg>`;
}

// ------------------------------------------------------------
// Scene <-> slide HTML (the re-editable payload)
// ------------------------------------------------------------

export const DRAW_SLIDE_CLASS = "canvas-draw-slide";
const SCENE_ATTR = "data-canvas-scene";

/** URL-encoded JSON — safe inside a double-quoted HTML attribute (no " < >). */
export function encodeScene(scene: DrawScene): string {
  return encodeURIComponent(JSON.stringify(scene));
}

export function decodeScene(encoded: string): DrawScene | null {
  try {
    const parsed = JSON.parse(decodeURIComponent(encoded));
    if (!isDrawScene(parsed)) return null;
    // `data-canvas-scene` is hand-editable HTML, and isDrawScene only validates
    // the envelope. The SVG serializer reads element fields without
    // optional-chaining, so a malformed element on a known `type` would throw
    // mid-render when the slide is re-opened. Drop any element that wouldn't
    // serialize safely — a tampered/corrupt scene degrades to its valid parts
    // instead of crashing the editor.
    return { ...parsed, elements: parsed.elements.filter(isDrawElement) };
  } catch {
    return null;
  }
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function isDrawScene(v: unknown): v is DrawScene {
  if (!v || typeof v !== "object") return false;
  const s = v as Record<string, unknown>;
  return (
    s.version === 1 &&
    typeof s.width === "number" &&
    typeof s.height === "number" &&
    typeof s.background === "string" &&
    Array.isArray(s.elements)
  );
}

// Structural guard for a single decoded element — keep in lockstep with the
// DrawElement union and the fields elementToSvg reads.
function isDrawElement(v: unknown): v is DrawElement {
  if (!v || typeof v !== "object") return false;
  const e = v as Record<string, unknown>;
  if (typeof e.id !== "string") return false;
  switch (e.type) {
    case "freehand":
      return (
        Array.isArray(e.points) &&
        e.points.every(isFiniteNumber) &&
        typeof e.stroke === "string" &&
        isFiniteNumber(e.strokeWidth)
      );
    case "line":
    case "arrow":
      return (
        isFiniteNumber(e.x1) &&
        isFiniteNumber(e.y1) &&
        isFiniteNumber(e.x2) &&
        isFiniteNumber(e.y2) &&
        typeof e.stroke === "string" &&
        isFiniteNumber(e.strokeWidth)
      );
    case "rect":
    case "ellipse":
      return (
        isFiniteNumber(e.x) &&
        isFiniteNumber(e.y) &&
        isFiniteNumber(e.w) &&
        isFiniteNumber(e.h) &&
        typeof e.stroke === "string" &&
        isFiniteNumber(e.strokeWidth) &&
        typeof e.fill === "string"
      );
    case "text":
      return (
        isFiniteNumber(e.x) &&
        isFiniteNumber(e.y) &&
        typeof e.text === "string" &&
        isFiniteNumber(e.fontSize) &&
        typeof e.color === "string"
      );
    default:
      return false;
  }
}

/** Wrap a scene as a complete, re-editable drawn slide `<section>`. */
export function sceneToSlideHtml(scene: DrawScene): string {
  const bg =
    scene.background && scene.background !== "transparent" ? scene.background : "transparent";
  return (
    `<section class="slide ${DRAW_SLIDE_CLASS}" ${SCENE_ATTR}="${encodeScene(scene)}"` +
    ` style="background:${escAttr(bg)};display:flex;align-items:center;justify-content:center;overflow:hidden">` +
    `${sceneToSvg(scene)}</section>`
  );
}

/** True if this slide HTML carries a (re-editable) drawing scene. */
export function isDrawnSlideHtml(html: string | null | undefined): boolean {
  if (!html) return false;
  return html.includes(DRAW_SLIDE_CLASS) || new RegExp(`${SCENE_ATTR}="`).test(html);
}

// ------------------------------------------------------------
// Draw OVER an existing slide (an overlay layer, not a whole drawn slide)
// ------------------------------------------------------------
// A whole-slide drawing (above) IS the slide — its <section> is one SVG. An
// overlay is different: it's a transparent drawing layer that rides on top of a
// normal slide's existing HTML, so you can annotate/sketch over real content.
// It serializes to an absolutely-positioned <svg class="canvas-draw-overlay">
// injected as the last child of the slide's <section>. Because it's still plain
// HTML in html_body, export / thumbnails / the public viewer render it for free
// — same "no pipeline changes" property as a drawn slide.

export const DRAW_OVERLAY_CLASS = "canvas-draw-overlay";

/**
 * `<svg>` markup for an overlay layer. Unlike `sceneToSvg` it (a) never paints a
 * background — the slide underneath shows through — and (b) positions itself to
 * cover the slide and opts out of pointer events, so it can be dropped straight
 * into an existing `<section>`. The re-editable scene rides on the same
 * `data-canvas-scene` attribute the whole-slide path uses, so `parseSceneFromHtml`
 * reopens both.
 */
export function sceneToOverlaySvg(scene: DrawScene): string {
  const w = scene.width || DRAW_W;
  const h = scene.height || DRAW_H;
  const body = scene.elements.map(elementToSvg).join("");
  return (
    `<svg class="${DRAW_OVERLAY_CLASS}" xmlns="http://www.w3.org/2000/svg"` +
    ` ${SCENE_ATTR}="${encodeScene(scene)}"` +
    ` viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid meet"` +
    ` style="position:absolute;inset:0;width:100%;height:100%;pointer-events:none">` +
    `${body}</svg>`
  );
}

// A whole overlay <svg> … </svg>. The encoded scene never contains `<`/`>` and
// the overlay body holds no nested <svg>, so the first `</svg>` closes it — a
// non-greedy match is safe and won't swallow other SVGs in the slide.
const OVERLAY_RE = new RegExp(
  `<svg class="${DRAW_OVERLAY_CLASS}"[\\s\\S]*?<\\/svg>`,
  "gi",
);

/** True if this slide HTML carries a drawing OVERLAY (an annotation layer on top
 *  of normal content), as opposed to a whole-slide drawing. */
export function hasDrawOverlayHtml(html: string | null | undefined): boolean {
  if (!html) return false;
  return html.includes(DRAW_OVERLAY_CLASS);
}

/** Remove any existing overlay layer(s) from a slide's html_body. */
export function stripDrawOverlay(html: string): string {
  return html.replace(OVERLAY_RE, "");
}

// The slide's root `<section …>` — captured as one match so we position the SAME
// section we inject into. Quote-aware (`"…" | '…' | [^>]`) so a `>` inside an
// attribute value (e.g. aria-label="a > b") can't truncate the opening tag.
// Groups: 1 lead (before the section, normally empty) · 2 opening tag ·
// 3 inner content · 4 closing </section> · 5 trailing (normally empty). Inner is
// greedy, so group 4 binds the LAST </section> — the root's own close even when
// the slide nests <section>s. Assumes a single-rooted section body (what the
// importer always produces); a bodyless/multi-root body falls to the append path.
const ROOT_SECTION_RE =
  /^([\s\S]*?)(<section\b(?:"[^"]*"|'[^']*'|[^>])*>)([\s\S]*)(<\/section>)([\s\S]*?)$/i;

/**
 * Give a section's OPENING TAG a positioning context so an `inset:0` overlay
 * covers it — add `position:relative` inline UNLESS the tag already carries an
 * inline `position:` (an explicitly-placed section is preserved; a class-based
 * `.slide{position:…}` from theme CSS is not inspected here, so a redundant
 * inline `relative` is harmless and a themed `absolute` would be overridden —
 * neither occurs for real slides). Quote-agnostic for `"`/`'` style values; a
 * function replacer keeps `$&`/`$$` in the tag from being reinterpreted.
 */
function positionSectionTag(openTag: string): string {
  if (/\bposition\s*:/i.test(openTag)) return openTag; // explicit inline position — leave it
  if (/\sstyle\s*=\s*["']/i.test(openTag)) {
    return openTag.replace(/\sstyle\s*=\s*["']/i, (m) => `${m}position:relative;`);
  }
  return openTag.replace(/^<section\b/i, '<section style="position:relative"');
}

/**
 * Inject (or replace) a drawing overlay inside an existing slide's html_body.
 * The overlay is appended as the last child of the slide's `<section>` so it
 * paints on top of the content, and that same section is made a positioning
 * context when it isn't already one. An empty scene (no elements) strips the
 * overlay entirely — that's how "erase the annotation" round-trips to a clean
 * slide. Any prior overlay is removed first, so re-saving is idempotent (never
 * stacks layers). A body with no single-rooted `<section>` (never a real slide)
 * degrades to appending the overlay.
 */
export function injectDrawOverlay(html: string, scene: DrawScene): string {
  const base = stripDrawOverlay(html);
  if (scene.elements.length === 0) return base; // nothing drawn → no layer
  const overlay = sceneToOverlaySvg(scene);
  const m = base.match(ROOT_SECTION_RE);
  if (!m) return `${base}${overlay}`; // no single-rooted <section> — best-effort append
  const [, lead, openTag, inner, close, trailing] = m;
  return `${lead}${positionSectionTag(openTag)}${inner}${overlay}${close}${trailing}`;
}

/**
 * Recover the editable scene from a drawn slide's HTML, or null when the slide
 * isn't a drawing (or its payload was hand-edited away). The encoded value never
 * contains a double quote, so a plain attribute regex is safe.
 */
export function parseSceneFromHtml(html: string | null | undefined): DrawScene | null {
  if (!html) return null;
  const m = html.match(new RegExp(`${SCENE_ATTR}="([^"]*)"`));
  if (!m) return null;
  return decodeScene(m[1]);
}

// Pre-flight deck audit — the deterministic half of "check before it leaves
// the building" (docs/discovery/ideas/08-preflight-check.md).
//
// Rides the EXACT render pass the exports use: one page load in the shared
// Chromium (same warm pool, same render gate — acquired by the caller), the
// same native-stage viewport with zoom:1, and one extra page.evaluate that
// measures instead of screenshots. No JPEG array, so an audit costs a
// fraction of a PDF export.
//
// v0 checks — only the fully deterministic, low-false-positive classes:
//   * text overflow / clipping — a TEXT-BEARING element cut by a scroll box
//     or sticking out past the slide's stage rect. Decorative bleeds
//     (overflow:hidden, no text) are deliberately not flagged.
//   * broken images — <img> that completed with naturalWidth 0, plus
//     network-level request failures observed during the load.
//   * slide-JS errors — pageerror / console.error fired while the deck ran.
//
// Judgment checks (tone, layout awkwardness) are NOT here and never will be:
// they belong to the user's own agent runtime (ADR-0006/0010). Brand
// conformance (is this the brand font) belongs to the brand kit's lint; this
// module only measures internal facts. Findings are ephemeral in v0 —
// computed on click, returned in the response, stored nowhere.

import type { Page } from "puppeteer-core";
import { rasterizeDeckHtml, type RasterStageSize } from "./slide-raster";

export type PreflightCheck =
  | "overflow"
  | "broken_image"
  | "page_error"
  | "console_error"
  | "request_failed";

export type PreflightSeverity = "blocker" | "warning";

export type PreflightFinding = {
  check: PreflightCheck;
  severity: PreflightSeverity;
  /** 0-based slide position; null = deck-level (runtime errors). */
  position: number | null;
  message: string;
  /** Element descriptor / URL / stack head — whatever pins the finding. */
  detail: string | null;
};

export type PreflightReport = {
  findings: PreflightFinding[];
  slideCount: number;
  stage: RasterStageSize;
  durationMs: number;
};

// What the in-page evaluate returns per issue, before classification.
type RawDomFinding = {
  kind: "overflow" | "broken_image";
  position: number;
  descriptor: string;
  message: string;
};

// Injected alongside the raster's standard style tag: freeze animations and
// transitions so a keyframe caught mid-cycle can't read as displaced content.
export const AUDIT_FREEZE_STYLE =
  "*,*::before,*::after{animation:none !important;transition:none !important}";

// The DOM audit, executed inside the rendered page at the native stage
// viewport with zoom:1 (the raster's own frame — measuring the fit-scaled
// preview instead is the #1 false-positive trap). Self-contained: no closure
// over module scope, everything serializable.
//
// Overflow rule — text CUT MID-ELEMENT, nothing else. Deck designs routinely
// hold more content than the visible box (timeline strips, pagers, decorative
// bleeds), so "exists beyond the edge" is hopeless noise (a real slide fired
// 55 of those). The defect a recipient actually sees is a text element the
// clip boundary slices through: partially visible, partially gone. So for
// every text-bearing element we intersect its rect with every clipping
// ancestor's rect (the slide root always clips — it IS the stage):
//   * fully visible   -> fine
//   * fully hidden    -> deliberate (overflow content / pager) — skip
//   * partially cut   -> the finding
function auditDom(): RawDomFinding[] {
  const OUT: RawDomFinding[] = [];
  const CUT_TOLERANCE_PX = 4; // subpixel + descender slack
  const MAX_PER_SLIDE = 10;

  function describe(el: Element): string {
    const tag = el.tagName.toLowerCase();
    const cls = (el.getAttribute("class") ?? "")
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .join(".");
    const text = (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 60);
    return `${tag}${cls ? `.${cls}` : ""}${text ? ` “${text}”` : ""}`;
  }

  function hasOwnText(el: Element): boolean {
    for (const node of el.childNodes) {
      if (node.nodeType === Node.TEXT_NODE && (node.textContent ?? "").trim() !== "") {
        return true;
      }
    }
    return false;
  }

  function clips(cs: CSSStyleDeclaration): { x: boolean; y: boolean } {
    const cut = (v: string) => v === "hidden" || v === "clip" || v === "auto" || v === "scroll";
    return { x: cut(cs.overflowX), y: cut(cs.overflowY) };
  }

  const slides = Array.from(document.querySelectorAll("[data-canvas-position]"));
  for (const slide of slides) {
    const position = Number(slide.getAttribute("data-canvas-position"));
    if (!Number.isFinite(position)) continue;
    const slideRect = slide.getBoundingClientRect();
    let slideFindings = 0;
    const flagged = new Set<Element>();

    for (const img of Array.from(slide.querySelectorAll("img"))) {
      if (slideFindings >= MAX_PER_SLIDE) break;
      if (img.complete && img.naturalWidth === 0) {
        const src = (img.getAttribute("src") ?? "").slice(0, 140);
        OUT.push({
          kind: "broken_image",
          position,
          descriptor: src || describe(img),
          message: "Image failed to load",
        });
        slideFindings += 1;
      }
    }

    for (const el of Array.from(slide.querySelectorAll("*"))) {
      if (slideFindings >= MAX_PER_SLIDE) break;
      if (!hasOwnText(el)) continue;
      // A flagged ancestor already reported this cut; don't echo per child.
      let ancestorFlagged = false;
      for (let p = el.parentElement; p; p = p.parentElement) {
        if (flagged.has(p)) {
          ancestorFlagged = true;
          break;
        }
      }
      if (ancestorFlagged) continue;

      const cs = getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) === 0) {
        continue;
      }
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;

      // Visible rect = rect ∩ every clipping ancestor up to (and including)
      // the slide root.
      let vTop = rect.top;
      let vBottom = rect.bottom;
      let vLeft = rect.left;
      let vRight = rect.right;
      for (let p = el.parentElement; p; p = p.parentElement) {
        const isSlide = p === slide;
        const pcs = getComputedStyle(p);
        const c = isSlide ? { x: true, y: true } : clips(pcs);
        if (c.x || c.y) {
          const pr = p.getBoundingClientRect();
          if (c.y) {
            vTop = Math.max(vTop, pr.top);
            vBottom = Math.min(vBottom, pr.bottom);
          }
          if (c.x) {
            vLeft = Math.max(vLeft, pr.left);
            vRight = Math.min(vRight, pr.right);
          }
        }
        if (isSlide) break;
      }

      const visibleW = Math.max(0, vRight - vLeft);
      const visibleH = Math.max(0, vBottom - vTop);
      // Fully hidden = deliberate overflow content (pager, strip) — skip.
      if (visibleW === 0 || visibleH === 0) continue;

      const cutX = rect.width - visibleW;
      const cutY = rect.height - visibleH;
      const worst = Math.max(cutX, cutY);
      if (worst > CUT_TOLERANCE_PX) {
        const atStage =
          vBottom === slideRect.bottom ||
          vRight === slideRect.right ||
          vTop === slideRect.top ||
          vLeft === slideRect.left;
        OUT.push({
          kind: "overflow",
          position,
          descriptor: describe(el),
          message: atStage
            ? `Text is cut off at the slide edge (${Math.round(worst)}px hidden)`
            : `Text is cut off mid-element (${Math.round(worst)}px hidden)`,
        });
        flagged.add(el);
        slideFindings += 1;
      }
    }
  }
  return OUT;
}

// Pure classifier — maps the raw signals (DOM findings + runtime events) into
// the final report rows. Split out so severity/dedupe/caps are unit-testable
// without Chromium.
export function classifyFindings(input: {
  dom: RawDomFinding[];
  pageErrors: string[];
  consoleErrors: string[];
  failedRequests: string[];
}): PreflightFinding[] {
  const findings: PreflightFinding[] = [];

  for (const f of input.dom) {
    findings.push({
      check: f.kind,
      severity: "blocker",
      position: f.position,
      message: f.message,
      detail: f.descriptor,
    });
  }

  // Runtime signals are deck-level: the deck's nav/slide JS runs as one
  // document, so an error can't be pinned to a slide reliably.
  const seen = new Set<string>();
  for (const msg of input.pageErrors) {
    const key = `pe:${msg}`;
    if (seen.has(key)) continue;
    seen.add(key);
    findings.push({
      check: "page_error",
      severity: "warning",
      position: null,
      message: "Deck JavaScript threw during load",
      detail: msg.slice(0, 300),
    });
  }
  for (const msg of input.consoleErrors) {
    const key = `ce:${msg}`;
    if (seen.has(key)) continue;
    seen.add(key);
    findings.push({
      check: "console_error",
      severity: "warning",
      position: null,
      message: "Console error while the deck ran",
      detail: msg.slice(0, 300),
    });
  }
  for (const url of input.failedRequests) {
    const key = `rf:${url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    findings.push({
      check: "request_failed",
      severity: "warning",
      position: null,
      message: "A resource the deck references failed to load",
      detail: url.slice(0, 200),
    });
  }

  // Blockers first, then by slide order; deck-level rows sink to the end.
  return findings.sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === "blocker" ? -1 : 1;
    const ap = a.position ?? Number.MAX_SAFE_INTEGER;
    const bp = b.position ?? Number.MAX_SAFE_INTEGER;
    return ap - bp;
  });
}

// Run the full audit over self-contained deck HTML (the same string
// buildDeckExportHtml produces). The CALLER holds the render gate — this
// function only owns the page work, mirroring how the export routes call
// rasterizeDeckHtml.
export async function runPreflightAudit(html: string): Promise<PreflightReport> {
  const started = Date.now();
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  const failedRequests: string[] = [];
  let dom: RawDomFinding[] = [];
  let slideCount = 0;

  const { size } = await rasterizeDeckHtml(html, {
    skipShots: true,
    scale: 1, // measurements don't need retina
    extraStyle: AUDIT_FREEZE_STYLE,
    onPageCreated: (page: Page) => {
      page.on("pageerror", (err) => {
        pageErrors.push(err instanceof Error ? err.message : String(err));
      });
      page.on("console", (msg) => {
        if (msg.type() === "error") consoleErrors.push(msg.text());
      });
      page.on("requestfailed", (req) => {
        // data: URLs can't fail; anything here is a live reference the
        // inliner missed or a genuinely dead URL.
        failedRequests.push(req.url());
      });
    },
    onPageReady: async (page: Page) => {
      dom = await page.evaluate(auditDom);
      slideCount = await page.evaluate(
        () => document.querySelectorAll("[data-canvas-position]").length,
      );
    },
  });

  return {
    findings: classifyFindings({ dom, pageErrors, consoleErrors, failedRequests }),
    slideCount,
    stage: size,
    durationMs: Date.now() - started,
  };
}

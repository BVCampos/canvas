// Standalone navigation chrome inlined into exported deck HTML.
//
// Why this exists separately from the React DeckChrome: inside Canvas, the
// host renders chrome and drives the iframe via postMessage. The exported
// .html file has no host — it has to navigate on its own. Rather than
// asking deck authors to remember to style `.navbar` (which is exactly the
// bug that triggered this refactor), we ship a small platform-owned bundle
// here.
//
// All classes are prefixed `.cv-` so the deck's own theme_css can't
// accidentally style or break them. The script runs after the deck's own
// nav.js, so if the deck has its own navigation it still works — we just
// add a parallel set of controls anchored to the bottom of the viewport.

export const EXPORT_CHROME_CSS = `
  .cv-chrome {
    position: fixed;
    left: 50%;
    bottom: 16px;
    transform: translateX(-50%);
    z-index: 2147483000;
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 6px 10px;
    background: rgba(255, 255, 255, 0.92);
    border: 1px solid rgba(0, 0, 0, 0.08);
    border-radius: 9999px;
    box-shadow: 0 4px 14px rgba(0, 0, 0, 0.08), 0 1px 2px rgba(0, 0, 0, 0.04);
    backdrop-filter: blur(8px);
    -webkit-backdrop-filter: blur(8px);
    font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    color: #1a1a1a;
  }
  .cv-chrome-btn {
    appearance: none;
    border: 0;
    background: transparent;
    width: 28px;
    height: 28px;
    border-radius: 9999px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: 14px;
    line-height: 1;
    color: inherit;
    cursor: pointer;
    transition: background-color 120ms ease, opacity 120ms ease;
  }
  .cv-chrome-btn:hover:not(:disabled) { background: rgba(0, 0, 0, 0.06); }
  .cv-chrome-btn:disabled { opacity: 0.3; cursor: default; }
  .cv-chrome-dots {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .cv-chrome-dot {
    appearance: none;
    border: 0;
    padding: 0;
    width: 6px;
    height: 6px;
    border-radius: 9999px;
    background: rgba(0, 0, 0, 0.25);
    cursor: pointer;
    transition: background-color 120ms ease, width 120ms ease;
  }
  .cv-chrome-dot:hover { background: rgba(0, 0, 0, 0.5); }
  .cv-chrome-dot[aria-current="true"] {
    width: 16px;
    background: #1a1a1a;
  }
  .cv-chrome-counter {
    font-size: 11px;
    font-variant-numeric: tabular-nums;
    color: rgba(0, 0, 0, 0.55);
    letter-spacing: 0.02em;
    min-width: 32px;
    text-align: center;
  }
  .cv-chrome-counter strong { color: #1a1a1a; font-weight: 600; }
  @media print { .cv-chrome { display: none; } }
`.trim();

// Print stylesheet for the standalone export, injected by assemble.ts in
// export mode only (never preview). This is the half of "Export HTML → Save
// as PDF" that actually makes a usable PDF.
//
// Why it's needed: the exported deck is a single-viewport carousel — slides
// laid out in a `display:flex` strip, only the current one visible via
// `transform: translateX(-i*100vw)`, inside the theme's
// `html,body{height:100vh;overflow:hidden}`. Print has no notion of that
// horizontal carousel, and with nothing overriding it the browser prints the
// one visible viewport on ONE page at its default geometry (US Letter
// PORTRAIT). So a 12-slide deck "exported to PDF" came out as a single
// squashed portrait page of slide 1. (Vertical-stack decks fared slightly
// better — they paginated — but still portrait, wrong aspect, fragile breaks.)
//
// What this does, entirely inside paged media (both the `media="print"` on the
// <style> AND the `@media print` wrapper — belt-and-suspenders so the on-screen
// carousel, the deck's nav.js, and the .cv-* chrome are byte-for-byte
// unchanged when the file is merely opened in a browser):
//   1. `@page { size: 1280px 720px; margin: 0 }` — a fixed 16:9 landscape sheet
//      (1280×720 CSS px == 13.333in × 7.5in == PowerPoint widescreen), zero
//      margin so each slide is full-bleed. NOTE: do NOT write
//      `size: 1280px 720px landscape` — combining explicit lengths with the
//      `landscape` keyword is invalid CSS and Chrome silently falls back to
//      Letter PORTRAIT, i.e. it reintroduces the very bug this fixes.
//      KNOWN DIVERGENCE from the server PDF export: this manual path lays the
//      deck out at 1280px paper width while the raster route (slide-raster)
//      captures at the deck's NATIVE size (1920 for the kit) — a deck with
//      media-query breakpoints between the two widths prints differently here
//      than the Export→PDF button renders. Deliberate: this stylesheet must be
//      deck-independent (it ships inside the exported file), 1280×720 is the
//      PowerPoint-widescreen sheet, and paper width drives media queries — so
//      the sheet stays fixed and the server route stays the fidelity path.
//   2. Unclip the deck: `html,body` height:auto/overflow:visible defeats the
//      theme's full-viewport clip that was hiding every slide past the first.
//   3. Collapse the carousel: `.deck/.slides/#slides` → display:block +
//      transform:none erases the flex strip and the nav.js translateX so slides
//      stack in document order for pagination.
//   4. One slide per page: every `[data-canvas-position]` (assemble's tagSection
//      stamps this on EVERY slide — carousel, stack, single-slide, and the
//      div-wrapped fallback) becomes a 1280px-wide, ≥720px-tall page with
//      break-after:page + break-inside:avoid. min-height (not a fixed/max
//      height) keeps a normal slide to exactly one page while letting an
//      over-tall slide spill to a second page rather than silently cropping
//      its content. We target ONLY `[data-canvas-position]` (never a bare
//      `.slide`, which could match a nested badge in slide content) so stray
//      inner elements can't inject phantom page breaks.
//   5. No trailing blank page: `:last-child` resets break-after to auto.
//   6. Paint backgrounds: print-color-adjust:exact so dark/gradient slides
//      aren't dropped to white. (This is the CSS half; an interactive Cmd+P
//      still depends on the user's "Background graphics" toggle — headless /
//      programmatic print honors it outright.)
//   7. Hide every screen-only interactive affordance: the floating `.cv-chrome`
//      nav, the click-to-edit hints (both the `#hint` stub and the per-slide
//      `.edit-hint` chips the seed Claude decks bake into slide bodies), and
//      the whole re-injected deck chrome wrapper (`[data-canvas="deck-chrome"]`
//      — modal overlays, dots rails, the autosave "Restaurar original" button).
//      None of them mean anything on paper, and the autosave button was
//      literally printing onto cover slides.
export const EXPORT_PRINT_CSS = `
@page { size: 1280px 720px; margin: 0; }

@media print {
  html, body {
    height: auto !important;
    min-height: 0 !important;
    max-height: none !important;
    width: auto !important;
    overflow: visible !important;
    margin: 0 !important;
    padding: 0 !important;
    -webkit-print-color-adjust: exact !important;
    print-color-adjust: exact !important;
  }

  .deck, .slides, #slides {
    display: block !important;
    position: static !important;
    height: auto !important;
    min-height: 0 !important;
    max-height: none !important;
    width: auto !important;
    max-width: none !important;
    overflow: visible !important;
    transform: none !important;
    flex: none !important;
  }

  [data-canvas-position] {
    box-sizing: border-box !important;
    width: 1280px !important;
    min-height: 720px !important;
    margin: 0 !important;
    overflow: hidden !important;
    position: relative !important;
    left: auto !important;
    top: auto !important;
    right: auto !important;
    bottom: auto !important;
    float: none !important;
    flex: none !important;
    transform: none !important;
    -webkit-print-color-adjust: exact !important;
    print-color-adjust: exact !important;
    break-inside: avoid;
    page-break-inside: avoid;
    break-after: page;
    page-break-after: always;
  }

  [data-canvas-position]:last-child {
    break-after: auto !important;
    page-break-after: auto !important;
  }

  .cv-chrome, .hint, #hint, .edit-hint,
  [data-canvas="deck-chrome"] { display: none !important; }

  /* Neutralize the on-screen letterbox zoom (EXPORT_FIT_JS sets --slide-zoom
     to a fit-both value < 1). Paged media lays each slide out at native size
     one-per-page, so the screen zoom must not shrink it into the printed
     page. Independent of --slide-zoom's current value. */
  [data-canvas-position], .slide { zoom: 1 !important; }
}
`.trim();

// Print-fit script, injected by assemble.ts in export mode (always — same
// gate as EXPORT_PRINT_CSS, including single-slide decks).
//
// Why: on screen an over-tall slide scrolls (`.slide{height:100%;
// overflow-y:auto}` in the source theme); paper doesn't scroll. The print
// stylesheet's `min-height: 720px` lets such a slide spill onto a second
// page, which fragments it mid-card and leaves a mostly-blank orphan page —
// a real 13-slide weekly deck printed as 17 pages. This script measures each
// slide's natural content height at print width (1280px) and, when it
// overflows one 720px page, scales the slide down to fit — PowerPoint's
// "fit to page". transform paints AFTER layout, so pagination still sees a
// 720px-tall box (exactly one page) while the content shrinks visually,
// centered. Slides over ~2 pages tall (z < 0.5) are left to paginate
// naturally: microtext is worse than a page break.
//
// Wiring: browsers fire beforeprint/afterprint around Cmd+P, so the manual
// "open exported HTML → print" path self-applies and self-reverts. Headless
// CDP printToPDF does NOT fire those events, so the PDF route calls
// `window.__canvasPrintFit()` explicitly before page.pdf(). fit() is
// idempotent (data-canvas-print-fit marker) — safe if both happen.
//
// Mechanics — why a WRAPPER and not a transform on the section itself: the
// print CSS keeps the section as the page box (720px, overflow:hidden). An
// element's own overflow clips its children in its LOCAL coordinate space,
// BEFORE its own transform paints — so scaling the section directly clips
// the content at 720px first and then shrinks the already-truncated result
// (cut card + white band at the foot of the page). An ANCESTOR's overflow,
// by contrast, clips descendants by their post-transform painted geometry.
// So we move the section's children into a wrapper at natural height,
// scale the wrapper (painted height = exactly 720px → fits the section's
// clip box), and pin the section itself to one page. The wrapper copies the
// section's inner-layout properties (display/flex/gap/padding — the section
// keeps only its background) so the move is visually a no-op, and the
// section's padding moves WITH the content so it scales uniformly.
//
// The inline styles use setProperty(..., 'important') because
// EXPORT_PRINT_CSS pins its geometry with !important — inline !important is
// the only thing that outranks it.
export const EXPORT_PRINT_JS = `
(function () {
  var PAGE_W = 1280, PAGE_H = 720;
  var fitted = []; // { el, wrap, style } — for afterprint undo

  // Natural content height at print geometry (width 1280, height free),
  // independent of the on-screen window size — a Cmd+P from a half-width
  // window must measure the same as the headless renderer.
  function measure(el) {
    var prev = el.getAttribute('style');
    // box-sizing matters: the print CSS forces border-box on the section, so
    // 1280px there means 1280 - padding of content width. Measuring without
    // it (a content-box theme) lays text out wider → wraps shorter → a slide
    // can measure 704px here yet overflow 720 in print and spill anyway.
    el.style.setProperty('box-sizing', 'border-box', 'important');
    el.style.setProperty('width', PAGE_W + 'px', 'important');
    el.style.setProperty('height', 'auto', 'important');
    el.style.setProperty('min-height', '0', 'important');
    el.style.setProperty('max-height', 'none', 'important');
    el.style.setProperty('flex', 'none', 'important');
    el.style.setProperty('overflow', 'visible', 'important');
    var h = el.scrollHeight;
    if (prev === null) el.removeAttribute('style');
    else el.setAttribute('style', prev);
    return h;
  }

  function fit() {
    var sections = document.querySelectorAll('[data-canvas-position]');
    for (var i = 0; i < sections.length; i++) {
      var el = sections[i];
      if (el.getAttribute('data-canvas-print-fit')) continue;
      var h = measure(el);
      // +4: borders/subpixel rounding shouldn't trigger a 0.99 scale.
      if (h <= PAGE_H + 4) continue;
      var z = PAGE_H / h;
      if (z < 0.5) continue; // 2+ pages of content — let it paginate

      var cs = getComputedStyle(el);
      var wrap = document.createElement('div');
      // Reproduce the section's inner layout so re-parenting the children
      // is visually a no-op; the padding moves here so it scales with the
      // content instead of pushing it past the clip box. Copy display as
      // computed — assuming flex-or-block collapsed grid slides to a block
      // stack — normalizing inline-level variants to their block-level pair
      // (the wrapper fills the page box). Grid template/auto tracks come
      // along as their computed (used px) values, freezing the layout the
      // children already have.
      var disp = cs.display.indexOf('inline-') === 0 ? cs.display.slice(7) : cs.display;
      wrap.style.display = disp === 'inline' ? 'block' : (disp || 'block');
      wrap.style.flexDirection = cs.flexDirection;
      wrap.style.flexWrap = cs.flexWrap;
      wrap.style.justifyContent = cs.justifyContent;
      wrap.style.alignItems = cs.alignItems;
      wrap.style.alignContent = cs.alignContent;
      wrap.style.justifyItems = cs.justifyItems;
      wrap.style.gridTemplateColumns = cs.gridTemplateColumns;
      wrap.style.gridTemplateRows = cs.gridTemplateRows;
      wrap.style.gridTemplateAreas = cs.gridTemplateAreas;
      wrap.style.gridAutoFlow = cs.gridAutoFlow;
      wrap.style.gridAutoRows = cs.gridAutoRows;
      wrap.style.gridAutoColumns = cs.gridAutoColumns;
      wrap.style.gap = cs.gap;
      wrap.style.padding = cs.padding;
      wrap.style.boxSizing = 'border-box';
      wrap.style.width = PAGE_W + 'px';
      wrap.style.height = h + 'px';
      wrap.style.transform = 'scale(' + z + ')';
      wrap.style.transformOrigin = 'top center';
      while (el.firstChild) wrap.appendChild(el.firstChild);
      el.appendChild(wrap);

      el.setAttribute('data-canvas-print-fit', '1');
      var prevStyle = el.getAttribute('style');
      el.style.setProperty('height', PAGE_H + 'px', 'important');
      el.style.setProperty('padding', '0', 'important');
      fitted.push({ el: el, wrap: wrap, style: prevStyle });
    }
  }

  function undo() {
    for (var i = 0; i < fitted.length; i++) {
      var f = fitted[i];
      while (f.wrap.firstChild) f.el.appendChild(f.wrap.firstChild);
      f.wrap.remove();
      if (f.style === null) f.el.removeAttribute('style');
      else f.el.setAttribute('style', f.style);
      f.el.removeAttribute('data-canvas-print-fit');
    }
    fitted = [];
  }

  window.__canvasPrintFit = fit;
  window.addEventListener('beforeprint', fit);
  window.addEventListener('afterprint', undo);
})();
`.trim();

// Empty container — the script populates it on DOMContentLoaded so the
// dot count matches whatever data-canvas-position sections the deck has.
export const EXPORT_CHROME_HTML = `<div class="cv-chrome" role="group" aria-label="Deck navigation" hidden></div>`;

export const EXPORT_CHROME_JS = `
(function () {
  function init() {
    var root = document.querySelector('.cv-chrome');
    if (!root) return;
    var sections = document.querySelectorAll('[data-canvas-position]');
    if (!sections || sections.length < 2) return;

    var total = sections.length;
    var current = 0;

    var prev = document.createElement('button');
    prev.type = 'button';
    prev.className = 'cv-chrome-btn';
    prev.setAttribute('aria-label', 'Previous slide');
    prev.textContent = '←';

    var dotsWrap = document.createElement('div');
    dotsWrap.className = 'cv-chrome-dots';
    var dots = [];
    for (var i = 0; i < total; i++) {
      (function (idx) {
        var d = document.createElement('button');
        d.type = 'button';
        d.className = 'cv-chrome-dot';
        d.setAttribute('aria-label', 'Slide ' + (idx + 1));
        d.addEventListener('click', function () { go(idx); });
        dotsWrap.appendChild(d);
        dots.push(d);
      })(i);
    }
    // Beyond a dozen slides, dots become noise; hide them and lean on counter.
    if (total > 12) dotsWrap.style.display = 'none';

    var counter = document.createElement('span');
    counter.className = 'cv-chrome-counter';

    var next = document.createElement('button');
    next.type = 'button';
    next.className = 'cv-chrome-btn';
    next.setAttribute('aria-label', 'Next slide');
    next.textContent = '→';

    root.appendChild(prev);
    root.appendChild(dotsWrap);
    root.appendChild(counter);
    root.appendChild(next);
    root.hidden = false;

    function render() {
      for (var j = 0; j < dots.length; j++) {
        if (j === current) dots[j].setAttribute('aria-current', 'true');
        else dots[j].removeAttribute('aria-current');
      }
      counter.innerHTML = '<strong>' + (current + 1) + '</strong> <span style="opacity:.6">/</span> ' + total;
      prev.disabled = current <= 0;
      next.disabled = current >= total - 1;
    }

    function dispatchKey(key) {
      try {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: key, bubbles: true }));
      } catch (err) { /* old browser — ignore */ }
    }

    function go(target) {
      if (target < 0 || target >= total || target === current) {
        render();
        return;
      }
      // Strategy 0 — the assembled deck ships CANVAS_CONTROLLER (assemble.ts),
      // whose navigate() writes the carousel transform directly and already
      // handles zoom scaling, sparse positions, and vertical-stack decks. A
      // standalone export has no Canvas host posting canvas:navigate, so we
      // call it ourselves. THIS is the path that actually moves the slides;
      // A/B/C below are fallbacks for decks assembled before it was exposed.
      if (typeof window.__canvasNavigate === 'function') {
        var sec = sections[target];
        var pos = sec && sec.getAttribute ? sec.getAttribute('data-canvas-position') : null;
        window.__canvasNavigate(pos !== null && pos !== '' ? parseInt(pos, 10) : target);
        current = target;
        render();
        return;
      }
      // Strategy A — if the deck's own nav.js renders #dotsNav buttons, click
      // the matching one so its internal state (animations, active dot, any
      // goTo hooks) updates. Hidden iframe-stubs from assemble.ts also match
      // this selector but a click on them is a no-op, so we cleanly fall
      // through to B / C below.
      var dotsNav = document.getElementById('dotsNav');
      if (dotsNav) {
        var deckDots = dotsNav.querySelectorAll('button, .dot-nav');
        if (deckDots && deckDots[target] && deckDots[target].offsetParent !== null) {
          deckDots[target].click();
          current = target;
          render();
          return;
        }
      }
      // Strategy B — most deck nav.js scripts listen for ArrowLeft/Right.
      // Dispatch the right number of presses to walk to the target.
      var steps = target - current;
      var key = steps > 0 ? 'ArrowRight' : 'ArrowLeft';
      for (var s = 0; s < Math.abs(steps); s++) dispatchKey(key);
      current = target;
      render();
      // Strategy C — pure vertical-scroll decks (no goTo, no keyboard) get
      // a scrollIntoView so the chrome still feels responsive.
      var section = sections[target];
      if (section && typeof section.scrollIntoView === 'function') {
        section.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    }

    prev.addEventListener('click', function () { go(current - 1); });
    next.addEventListener('click', function () { go(current + 1); });

    // The deck's own keyboard handler may flip slides; mirror that into our
    // counter so the chrome doesn't drift out of sync. We bind in capture
    // so we run before the deck's listener and can pre-compute the next
    // index without depending on its return value.
    document.addEventListener('keydown', function (e) {
      if (!e) return;
      if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') {
        if (current < total - 1) { current++; render(); }
      } else if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
        if (current > 0) { current--; render(); }
      } else if (e.key === 'Home') {
        current = 0; render();
      } else if (e.key === 'End') {
        current = total - 1; render();
      }
    });

    render();
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
`.trim();

// Standalone letterbox — screen-only, injected by assemble.ts in export mode
// ONLY for decks that use `--slide-zoom` (the kit's zoom-scaled carousel). See
// the exportFitStyle/Script gate in assemble.ts for why.
//
// The stage: .deck is pinned to exactly one RENDERED slide (--cv-fit-w/h) and
// centered, with overflow:hidden. That does two things at once —
//   1. clips the strip so the next slide (which sits one rendered-slide-width
//      away) can't bleed into a viewport wider than the fitted slide, and
//   2. centers the fitted slide so the letterbox margin is symmetric; the bars
//      show the deck's own body background.
// EXPORT_FIT_JS fills --cv-fit-w/h. The 100vw/100vh fallbacks keep .deck full-
// bleed until the script runs (and if it somehow doesn't). All @media screen,
// so EXPORT_PRINT_CSS (paged media) governs the print/PDF path untouched.
export const EXPORT_FIT_CSS = `
@media screen {
  html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; }
  .deck {
    position: absolute !important;
    top: 50% !important;
    left: 50% !important;
    width: var(--cv-fit-w, 100vw) !important;
    height: var(--cv-fit-h, 100vh) !important;
    transform: translate(-50%, -50%) !important;
    overflow: hidden !important;
  }
}
`.trim();

// The fit driver. Kit decks scale `.slide { zoom: var(--slide-zoom) }` and
// their nav.js sets --slide-zoom = innerWidth/1920 (WIDTH-fit), which crops
// vertically in a window shorter than 16:9. We recompute a fit-BOTH zoom and
// size the .deck stage (consumed by EXPORT_FIT_CSS) to one rendered slide.
//
// Winning the tug-of-war with the deck's own setZoom: the deck re-asserts its
// width-only value on load, deferred timers (~200/800ms), and resize. We
// re-run on the same triggers AND observe the <html> style attribute, so any
// write of a value that isn't our fit value is corrected. The guard (skip when
// --slide-zoom already equals our value) stops the observer from looping on
// our own writes. Changing --slide-zoom also nudges CANVAS_CONTROLLER's own
// style MutationObserver, which re-runs navigate(lastPosition) at the new
// scale — so the strip re-centers on the current slide for free.
export const EXPORT_FIT_JS = `
(function () {
  function design() {
    // The WORST-CASE slide footprint in design px, so no slide crops at the
    // chosen zoom. offsetWidth/Height are the UNZOOMED layout box (zoom scales
    // render, not offset*), and getComputedStyle margins are design px too. We
    // add margins because the kit gives non-first slides a top margin (e.g.
    // margin-top:32) that sits ABOVE the 1080px box — ignore it and that slide
    // overflows the fitted stage by margin*zoom. Max across slides covers a
    // deck whose slides differ (first slide margin:0 vs the rest). Falls back
    // to the kit's 1920x1080 before layout settles.
    var secs = document.querySelectorAll('[data-canvas-position]');
    var w = 0, h = 0;
    for (var i = 0; i < secs.length; i++) {
      var s = secs[i], cs = window.getComputedStyle(s);
      var sw = s.offsetWidth + (parseFloat(cs.marginLeft) || 0) + (parseFloat(cs.marginRight) || 0);
      var sh = s.offsetHeight + (parseFloat(cs.marginTop) || 0) + (parseFloat(cs.marginBottom) || 0);
      if (sw > w) w = sw;
      if (sh > h) h = sh;
    }
    return { w: w || 1920, h: h || 1080 };
  }
  function apply() {
    var d = design();
    if (!d.w || !d.h) return;
    var z = Math.min(window.innerWidth / d.w, window.innerHeight / d.h);
    if (!(z > 0) || !isFinite(z)) return;
    var zs = z.toFixed(5);
    var root = document.documentElement.style;
    // Already fitted at this scale — bail (breaks the observer feedback loop).
    if (root.getPropertyValue('--slide-zoom').trim() === zs &&
        root.getPropertyValue('--cv-fit-w')) return;
    root.setProperty('--slide-zoom', zs);
    root.setProperty('--cv-fit-w', Math.round(z * d.w) + 'px');
    root.setProperty('--cv-fit-h', Math.round(z * d.h) + 'px');
  }
  window.addEventListener('resize', apply);
  window.addEventListener('load', apply);
  // Re-assert over the kit's deferred setZoom (fires ~load / +200 / +800).
  [0, 60, 250, 850, 1200].forEach(function (ms) { setTimeout(apply, ms); });
  try {
    if (typeof MutationObserver !== 'undefined') {
      var mo = new MutationObserver(function () { apply(); });
      mo.observe(document.documentElement, { attributes: true, attributeFilter: ['style'] });
    }
  } catch (e) { /* no MutationObserver / non-DOM env */ }
  apply();
})();
`.trim();

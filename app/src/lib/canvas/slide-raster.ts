// Shared headless-Chromium slide rasterizer.
//
// Born out of the PDF export route (app/src/app/api/decks/[id]/export/pdf):
// it screenshots each slide at its native size so the PDF is image-based and
// immune to the print-reflow bug that mangles the kit's zoom-scaled stage. The
// PPTX export and the render_slide MCP tool need the EXACT same capture (a
// faithful image of each slide as it renders on screen), so the launch + screen
// capture lives here and all three callers share it.
//
// Why we SCREENSHOT each slide rather than letting Chromium paginate/print:
//   The 21x deck kit lays out a fixed 1920x1080 stage and scales it to the
//   viewport with the CSS `zoom` property (zoom reflows, unlike transform).
//   Any print/reflow pass at a different box mishandles the zoom-scaled stage
//   (flex columns collapse to min-content, content jams top-left). The SAME DOM
//   screenshots perfectly in screen layout, so we capture each slide as it
//   actually renders and let the caller assemble the images.
//
// Chromium sourcing differs by environment (kept identical to the PDF route's
// original launch logic — see that route's header for the full rationale):
//   - EC2 (our AWS host): CHROMIUM_PATH points at a box-installed arm64
//     Chromium; headless as a systemd user needs --no-sandbox and
//     --disable-dev-shm-usage (EC2's /dev/shm is tiny).
//   - Vercel / AWS Lambda: @sparticuz/chromium ships a trimmed binary, kept
//     external via next.config.ts `serverExternalPackages`.
//   - Local dev: puppeteer-core resolves the system Chrome via the `chrome`
//     channel.
//
// The page HTML must be fully self-contained (assets + web fonts as base64 data:
// URLs — export-deck inlines both); the only network a render should touch is a
// web font that inlining missed (best-effort), and the `load` wait + a BOUNDED
// document.fonts.ready await (FONT_READY_TIMEOUT_MS) keep that from hanging the
// render. Chromium is launched once and reused across renders via a warm pool.

import { accessSync, constants } from "node:fs";
import puppeteer, { type Browser, type Page } from "puppeteer-core";

// Non-negative integer env knob, or the fallback when unset/blank/garbage. An
// explicit "0" is honored (so RENDER_BROWSER_IDLE_MS=0 forces close-on-idle and
// FONT_READY_TIMEOUT_MS=0 skips the wait entirely).
function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

// Positive float env knob (e.g. a deviceScaleFactor of 1.5), or the fallback
// when unset/blank/garbage. Zero is rejected — a scale of 0 has no meaning and
// would collapse the capture — so this is strictly > 0, unlike envInt.
function envFloat(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// How long we wait for `document.fonts.ready` before capturing anyway. The
// export/render HTML inlines web fonts as data: URLs (export-deck), so fonts
// normally settle in a few ms with no network. But inlining is best-effort — a
// font from a non-allowlisted host, or one whose fetch failed at assembly time,
// stays a LIVE reference, and an unbounded `await document.fonts.ready` then
// hangs the whole render on that CDN (this is what stretched renders to ~17s).
// The bound caps that tail: past the timeout we capture with whatever faces
// loaded (fallback glyphs for the stragglers) rather than block. Env-tunable.
const FONT_READY_TIMEOUT_MS = envInt("FONT_READY_TIMEOUT_MS", 3_000);

// Warm-browser pool tuning. Launching Chromium cold on every render was the
// dominant avoidable cost on the box; we keep one browser warm and reuse it
// across renders, opening a fresh page per render (pages are cheap; a process
// launch is not). RENDER_BROWSER_IDLE_MS: close the shared browser this long
// after the last render finishes, so an idle box reclaims the ~150MB rather than
// holding Chromium forever. RENDER_BROWSER_MAX_RENDERS: recycle (relaunch) the
// browser after this many renders so a long-lived Chromium can't accumulate leaks.
const RENDER_BROWSER_IDLE_MS = envInt("RENDER_BROWSER_IDLE_MS", 30_000);
const RENDER_BROWSER_MAX_RENDERS = envInt("RENDER_BROWSER_MAX_RENDERS", 40);

// Capture geometry. Decks author a fixed 16:9 stage; we read the real size off
// the first slide at runtime (1920x1080 for the 21x kit, but any deck works)
// and fall back to 720p. deviceScaleFactor 2 -> retina-crisp text; JPEG keeps
// the file emailable (PNG ran ~2.5x larger with no visible gain on flat art).
const FALLBACK = { w: 1280, h: 720 };
const DEFAULT_SCALE = 2;
const DEFAULT_JPEG_QUALITY = 90;

// Capture resolution for the whole-deck DOCUMENT exports (PDF, PPTX). The deck
// stage is a fixed 1920×1080 and is presented/printed at 1080p, so the 2×
// default (3840×2160 JPEGs — right for a single crisp MCP/thumbnail preview,
// where bytes are trivial) is pure oversampling once multiplied across a 12-slide
// file: on the 21x institutional deck that default produced a 6.21MB PDF, which
// users flagged as too large. 1.25× (2400×1350) still supersamples — above the
// native 1080p, so text and thin SVG strokes stay crisp on a retina/4K projector
// — while cutting pixel count to ~39%; quality 78 on the kit's flat vector art
// is visually lossless (verified: no artifacts on the dark case-divider's navy
// gradient) and shaves the rest. Measured end-to-end on that deck: 6.21MB → 2.32MB
// (−63%). Both are env-tunable so a one-off max-res export needs no redeploy
// (EXPORT_DOC_SCALE=2 EXPORT_DOC_JPEG_QUALITY=92 restores the original size).
export const EXPORT_DOC_SCALE = envFloat("EXPORT_DOC_SCALE", 1.25);
export const EXPORT_DOC_JPEG_QUALITY = envInt("EXPORT_DOC_JPEG_QUALITY", 78);

export type RasterStageSize = { w: number; h: number };

export type RasterizeOptions = {
  /** deviceScaleFactor for the capture viewport. Defaults to 2 (retina). */
  scale?: number;
  /** JPEG quality 0-100 for each slide screenshot. Defaults to 90. */
  jpegQuality?: number;
  /**
   * Skip the per-slide screenshots entirely — `shots` comes back empty. An
   * audit-only pass (pre-flight) measures the DOM on the same load without
   * paying for the JPEG array, which dominates a render's memory.
   */
  skipShots?: boolean;
  /**
   * Called with the fresh page BEFORE setContent, so callers can attach
   * listeners (pageerror / console / requestfailed) that must observe the
   * load itself. Keep it synchronous-fast; the render waits on it.
   */
  onPageCreated?: (page: Page) => void | Promise<void>;
  /**
   * Called after the native-stage viewport + style injection settle — the
   * exact frame the screenshots are taken in. Pre-flight runs its audit
   * evaluate here so measurements share the capture's layout.
   */
  onPageReady?: (page: Page) => void | Promise<void>;
  /** Extra CSS appended to the standard injected style tag. */
  extraStyle?: string;
};

export type RasterShotMeta = {
  /** The captured slide's own box in CSS px — NOT necessarily `size` (a deck
   *  can mix slide sizes; assembling every shot into the first slide's box is
   *  how off-size slides came out stretched). */
  w: number;
  h: number;
  /** The slide's `data-canvas-position` value (the DB position assemble stamps),
   *  so callers can join shots back to slide rows by position instead of by
   *  array index — index joins silently shift when a section is skipped. */
  position: number | null;
};

export type RasterizeResult = {
  /** The deck's native stage size, read off the first slide. */
  size: RasterStageSize;
  /** One JPEG (as raw bytes) per captured slide, in document order. */
  shots: Uint8Array[];
  /** Per-shot geometry + position, index-aligned with `shots`. */
  shotMeta: RasterShotMeta[];
};

export async function launchBrowser(): Promise<Browser> {
  // EC2 host: a box-installed Chromium whose path the bootstrap exports. Gated on
  // the absence of the serverless markers so a stray CHROMIUM_PATH on Vercel/Lambda
  // can't shadow the bundled binary there. --no-sandbox is required running headless
  // as a non-login systemd user; --disable-dev-shm-usage avoids crashes from EC2's
  // small /dev/shm during multi-slide capture; --disable-gpu since the box is headless.
  if (
    process.env.CHROMIUM_PATH &&
    !process.env.VERCEL &&
    !process.env.AWS_LAMBDA_FUNCTION_VERSION
  ) {
    // Fail fast with a self-identifying error if the box Chromium is missing or
    // not executable (e.g. a dangling symlink from a failed bootstrap install),
    // so a CONFIG problem doesn't masquerade as a generic render failure in
    // telemetry. accessSync follows the symlink, so a broken link throws here.
    try {
      accessSync(process.env.CHROMIUM_PATH, constants.X_OK);
    } catch {
      throw new Error(`CHROMIUM_PATH not executable: ${process.env.CHROMIUM_PATH}`);
    }
    return puppeteer.launch({
      executablePath: process.env.CHROMIUM_PATH,
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
    });
  }
  if (process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_VERSION) {
    // Dynamic import keeps the ~60MB lambda-only package out of every other
    // route's module graph and out of local dev entirely.
    const chromium = (await import("@sparticuz/chromium")).default;
    return puppeteer.launch({
      args: chromium.args,
      executablePath: await chromium.executablePath(),
      headless: true,
    });
  }
  return puppeteer.launch({ channel: "chrome", headless: true });
}

// close() can hang on a wedged Chromium. Race it against a short timeout so
// freeing the browser (to reclaim memory before assembly, and in cleanup) can
// never block the response. Never throws.
export async function closeBrowser(browser: Browser): Promise<void> {
  try {
    await Promise.race([
      browser.close(),
      new Promise((resolve) => setTimeout(resolve, 5_000)),
    ]);
  } catch (err) {
    console.warn("[slide-raster] close", err);
  }
}

// ---------------------------------------------------------------------------
// Warm-browser pool
// ---------------------------------------------------------------------------
// One shared Chromium reused across renders instead of a cold launch per render.
// The render gate (render-gate.ts) already bounds how many renders run at once,
// so at most RENDER_MAX_CONCURRENCY pages are open on this browser at a time —
// pages are cheap, a process launch is not. Lifecycle: lazily launched on first
// use; kept warm while renders are in flight; closed after RENDER_BROWSER_IDLE_MS
// of inactivity (reclaim memory) or recycled after RENDER_BROWSER_MAX_RENDERS
// (bound leaks); relaunched automatically if Chromium dies.
let sharedBrowser: Browser | null = null;
let launchInFlight: Promise<Browser> | null = null;
let activeRenders = 0;
let rendersOnBrowser = 0;
let idleTimer: ReturnType<typeof setTimeout> | null = null;

function isAlive(b: Browser | null): b is Browser {
  return b !== null && b.connected;
}

// Reserve a render against the pool and get a live browser. Cancels any pending
// idle-close, launches (or awaits an in-flight launch) if none is alive, and
// dedupes concurrent launches so a burst shares one process.
async function acquireBrowser(): Promise<Browser> {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  activeRenders += 1;
  if (isAlive(sharedBrowser)) return sharedBrowser;
  if (!launchInFlight) {
    launchInFlight = launchBrowser()
      .then((b) => {
        sharedBrowser = b;
        rendersOnBrowser = 0;
        // If Chromium dies (crash, OOM-kill), drop the ref so the next acquire
        // relaunches instead of handing out a dead browser.
        b.once("disconnected", () => {
          if (sharedBrowser === b) sharedBrowser = null;
        });
        return b;
      })
      .finally(() => {
        launchInFlight = null;
      });
  }
  return launchInFlight;
}

// Release a render. When the last in-flight render finishes, either recycle the
// browser now (hit the per-browser render cap) or arm the idle-close timer.
function releaseBrowser(): void {
  activeRenders = Math.max(0, activeRenders - 1);
  rendersOnBrowser += 1;
  if (activeRenders > 0) return;
  if (rendersOnBrowser >= RENDER_BROWSER_MAX_RENDERS || RENDER_BROWSER_IDLE_MS <= 0) {
    void closeSharedBrowser();
    return;
  }
  idleTimer = setTimeout(() => {
    idleTimer = null;
    if (activeRenders === 0) void closeSharedBrowser();
  }, RENDER_BROWSER_IDLE_MS);
  // Don't let the idle timer keep the Node process alive on its own.
  idleTimer.unref?.();
}

// Tear down the shared browser and reset pool state. Safe to call anytime —
// exported so a graceful shutdown or a test can force a clean slate.
export async function closeSharedBrowser(): Promise<void> {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  rendersOnBrowser = 0;
  const b = sharedBrowser;
  sharedBrowser = null;
  if (b) await closeBrowser(b);
}

// Render a fully self-contained deck HTML string and screenshot every slide at
// its native stage size. This is the exact capture the PDF route did inline:
// setContent + fonts.ready + native-size detection + the per-slide
// [data-canvas-position] screenshot loop. The caller owns assembly (PDF, PPTX,
// or a single MCP image); the browser comes from the warm pool and only this
// render's page is closed in cleanup, so no caller can leak a page or a Chromium.
//
// `html` MUST be self-contained (assets inlined as data: URLs) — the same HTML
// buildDeckExportHtml produces — so the render touches no authenticated routes.
export async function rasterizeDeckHtml(
  html: string,
  options: RasterizeOptions = {},
): Promise<RasterizeResult> {
  const scale = options.scale ?? DEFAULT_SCALE;
  const jpegQuality = options.jpegQuality ?? DEFAULT_JPEG_QUALITY;

  // Reuse the warm shared browser; open a fresh page for this render and close
  // ONLY the page in cleanup (the pool owns the browser's lifecycle).
  const browser = await acquireBrowser();
  let page: Page | null = null;
  try {
    page = await browser.newPage();
    if (options.onPageCreated) await options.onPageCreated(page);
    await page.setViewport({ width: FALLBACK.w, height: FALLBACK.h, deviceScaleFactor: scale });
    await page.setContent(html, {
      waitUntil: "load",
      timeout: 30_000,
    });
    // `load` doesn't cover web fonts a theme_css @imports (they resolve after
    // the load event); capturing before they apply gives fallback-font slides.
    // fonts.ready settles once every requested face is active — but bound the
    // wait: the HTML inlines fonts as data: URLs, so this is normally instant,
    // and when inlining missed a font (best-effort) an unbounded await would
    // hang the render on that CDN. Past the timeout we capture with whatever
    // loaded rather than block.
    const fontsSettled = await page.evaluate(async (timeoutMs) => {
      if (timeoutMs <= 0) return false;
      let timedOut = false;
      await Promise.race([
        document.fonts.ready,
        new Promise<void>((resolve) => {
          setTimeout(() => {
            timedOut = true;
            resolve();
          }, timeoutMs);
        }),
      ]);
      return !timedOut;
    }, FONT_READY_TIMEOUT_MS);
    if (!fontsSettled) {
      console.warn(
        `[slide-raster] fonts.ready not settled in ${FONT_READY_TIMEOUT_MS}ms — ` +
          "a web font is being fetched at render time (inlining missed it); capturing anyway",
      );
    }

    // Strip the screen-only viewing aids BEFORE measuring. assemble stamps them
    // so they're removable here: the viewport shim (style[data-canvas=
    // "viewport-shim"]) rebinds `.slide` to 100vw×100vh so a fixed-px deck fits
    // whatever screen it's on — at the capture's fallback viewport that squeezes
    // the measured "native" size down to 1280×720 and (with the deck's own zoom
    // pinned to 1 below) clips design-px content at the squeezed box. The
    // EXPORT_FIT letterbox sizes .deck to one fitted slide with overflow:hidden
    // — the clip that painted the white bands on dark slides. Both are screen
    // aids; at capture the viewport IS the stage, so remove them and let the
    // deck's own authored geometry lay out. (Their companion scripts stay but
    // write only --slide-zoom/--cv-fit-* custom properties, which are inert once
    // the consuming CSS is gone and `zoom` is pinned.)
    await page.evaluate(() => {
      document
        .querySelectorAll('style[data-canvas="viewport-shim"], style[data-canvas="export-fit"]')
        .forEach((el) => el.remove());
    });

    // Pin the frame the shots are taken in: `zoom: 1` (any screen-fit zoom
    // resolves to native), no transforms or transitions on the structural
    // containers (the deck's nav / CANVAS_CONTROLLER writes the carousel
    // translate as an inline style, and a transition mid-flight tears the
    // capture — a strip drifting during the shot loop screenshots blank
    // background), no inter-slide margins, and no floating chrome (per-slide
    // topstrip/footer are part of the slide and stay). Stylesheet !important
    // outranks the inline style writes those scripts keep making. Screen
    // layout — NOT print — because print reflow is the bug.
    await page.addStyleTag({
      content:
        ".slide,[data-canvas-position]{zoom:1 !important}" +
        ".deck{position:static !important;width:auto !important;height:auto !important;overflow:visible !important}" +
        ".deck,.slides,#slides{transform:none !important;transition:none !important}" +
        // flex-shrink 0: a deck whose own strip is display:flex relied on the
        // (now removed) viewport shim's `flex: 0 0 <basis>` to keep fixed-width
        // slides from being squeezed into the viewport by default flex-shrink.
        "[data-canvas-position]{margin:0 !important;transform:none !important;flex-shrink:0 !important}" +
        '.cv-chrome,.hint,#hint,.edit-hint,.deck-nav,.dots,[data-canvas="deck-chrome"]{display:none !important}' +
        (options.extraStyle ?? ""),
    });

    // Top-level slide boxes (absolute page coords). Only TOP-LEVEL sections
    // count: a stale `data-canvas-position` nested inside a slide's body (an
    // exported deck pasted into a slide) must not become an extra page — a
    // hidden one used to crash the whole export ("Node is either not visible").
    const measureSections = () =>
      page!.evaluate(() => {
        return Array.from(document.querySelectorAll("[data-canvas-position]"))
          .filter(
            (el) => !(el.parentElement && el.parentElement.closest("[data-canvas-position]")),
          )
          .map((el) => {
            const r = el.getBoundingClientRect();
            const raw = el.getAttribute("data-canvas-position");
            const n = raw === null || raw === "" ? NaN : Number(raw);
            return {
              x: r.x + window.scrollX,
              y: r.y + window.scrollY,
              w: r.width,
              h: r.height,
              position: Number.isFinite(n) ? n : null,
            };
          });
      });

    // The deck's native stage size = the first visible slide's own box, now
    // that every screen scaler is gone. Rects (not computed style) so the
    // number is the box that actually paints.
    const preSections = await measureSections();
    const firstVisible = preSections.find((s) => s.w > 0.5 && s.h > 0.5);
    const size = firstVisible
      ? { w: Math.round(firstVisible.w), h: Math.round(firstVisible.h) }
      : FALLBACK;

    await page.setViewport({ width: size.w, height: size.h, deviceScaleFactor: scale });

    // Let the resized frame settle before measuring the capture boxes: a
    // viewport-relative layout reflows, and a font first demanded by the new
    // layout (e.g. behind a min-width media query) starts loading only now —
    // re-await fonts.ready (same bound as above; instant when nothing new
    // loads), then two rAFs so layout and paint have run. The rAF wait is
    // raced against a short timer because headless Chromium can throttle rAF
    // on a non-foreground page (several render pages can be open at once
    // under the gate) — a frame that never comes must not hang the render.
    await page.evaluate(async (timeoutMs) => {
      if (timeoutMs > 0) {
        await Promise.race([
          document.fonts.ready,
          new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
        ]);
      }
      // No named locals in this closure: bundlers that keep function names
      // (tsx/esbuild running scripts against src) wrap them in a __name helper
      // that doesn't exist in the page context. resolve() is idempotent, so
      // whichever of the two paths fires first wins and the other no-ops.
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        setTimeout(resolve, 250);
      });
    }, FONT_READY_TIMEOUT_MS);

    if (options.onPageReady) await options.onPageReady(page);

    // Final-frame measurement (the resize above can reflow), then screenshot
    // each slide by EXPLICIT clip rather than ElementHandle.screenshot: the
    // element path re-derives visibility and scroll state per shot (and hard-
    // fails on a hidden node), while a clip of the composited page captures
    // exactly the box we measured — beyond the viewport too (the carousel lays
    // slides out in a strip wider than the stage).
    const sections = await measureSections();
    if (sections.length === 0) throw new Error("no slides to render");
    const shots: Uint8Array[] = [];
    const shotMeta: RasterShotMeta[] = [];
    if (!options.skipShots) {
      for (const s of sections) {
        if (!(s.w > 0.5 && s.h > 0.5)) {
          console.warn(
            `[slide-raster] skipping zero-area slide at position ${s.position ?? "?"} — hidden at capture`,
          );
          continue;
        }
        shots.push(
          await page.screenshot({
            type: "jpeg",
            quality: jpegQuality,
            clip: { x: s.x, y: s.y, width: s.w, height: s.h },
            captureBeyondViewport: true,
          }),
        );
        shotMeta.push({ w: s.w, h: s.h, position: s.position });
      }
    }

    return { size, shots, shotMeta };
  } finally {
    // Free the PAGE (its DOM + the decoded screenshots are the per-render memory
    // the caller's pure-JS assembly no longer needs) but keep the browser warm
    // for the next render. releaseBrowser() arms the idle-close / recycle so an
    // idle box still reclaims Chromium. Closing the page can reject on a browser
    // that just died — swallow it; the disconnect handler already dropped the ref.
    if (page) {
      try {
        await page.close();
      } catch {
        /* browser gone — page is already dead */
      }
    }
    releaseBrowser();
  }
}

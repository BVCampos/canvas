"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type TouchEvent as ReactTouchEvent,
} from "react";
import {
  ChevronLeft,
  ChevronRight,
  Maximize2,
  Minimize2,
  NotebookText,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { MenuSurface } from "@/components/ui/menu-surface";

// Full-bleed, read-only deck viewer. The single source of truth for the
// large-format slide experience, shared by:
//   * Present mode (/canvases/{id}/present) — passes the private preview src and
//     an `onExit` that returns to the editor.
//   * The public share viewer (/p/{token}) — passes the cookieless public render
//     src, no `onExit` (there's no editor to return to), and `brand` on.
//
// Rendering: we DON'T build a second render path. The caller hands us a
// `previewSrc` (an /api/.../preview route that returns sandboxed deck HTML); we
// load it in an opaque-origin iframe. Slides are authored in viewport units and
// the deck's CANVAS_CONTROLLER translates the strip by N*100vw, so the iframe's
// own viewport IS the scaling stage — no transform math.
//
// Aspect handling: on a landscape/desktop viewport the iframe is full-bleed, so
// its viewport ≈ the slide's native 16:9 and slides fill the screen. On a
// PORTRAIT phone a full-bleed iframe is ~9:19 tall, which crushes 16:9-authored
// slides — classic decks shrink to a tiny self-letterboxed band with big empty
// margins, doc-style decks overflow and overlap. So in portrait we constrain the
// iframe to a width-filling 16:9 box and centre it, letting the dark backdrop
// paint the letterbox bars above/below. The deck inside then sees a 16:9 viewport
// and renders at its intended proportions, just scaled to the phone's width. This
// mirrors the editor preview, which already switches to a centred `aspect-video`
// box below `xl` (deck-workspace.tsx).
//
// Navigation reuses the exact postMessage protocol the editor exercises in
// production (assemble.ts):
//   host → iframe: { type: "canvas:navigate", position }
//   iframe → host: { type: "canvas:state", position }  (authoritative echo)
//                  { type: "canvas:key", key }          (forwarded when the
//                    iframe has focus, since EMBEDDED_GUARD silences the deck's
//                    own keydown handler)
// so arrow / space / Home / End work whether focus is on the host or inside the
// iframe.
//
// Chrome auto-hides after a few seconds idle (cursor too) and reveals on any
// pointer/keyboard activity — standard presenter behaviour.

export type DeckViewerSlide = { id: string; position: number; title: string };

// Fullscreen API with a webkit (older Safari) fallback, typed without `any`.
type FullscreenDoc = Document & {
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => void;
};
type FullscreenEl = HTMLElement & {
  webkitRequestFullscreen?: () => void;
};

function fullscreenElement(): Element | null {
  if (typeof document === "undefined") return null;
  const d = document as FullscreenDoc;
  return document.fullscreenElement ?? d.webkitFullscreenElement ?? null;
}

function requestFullscreen() {
  const el = document.documentElement as FullscreenEl;
  try {
    if (typeof el.requestFullscreen === "function") {
      const p = el.requestFullscreen();
      if (p && typeof p.catch === "function") p.catch(() => {});
    } else if (typeof el.webkitRequestFullscreen === "function") {
      el.webkitRequestFullscreen();
    }
  } catch {
    /* user gesture / permission issue — non-fatal, stay in the route */
  }
}

function exitFullscreen() {
  const d = document as FullscreenDoc;
  try {
    if (typeof document.exitFullscreen === "function") {
      const p = document.exitFullscreen();
      if (p && typeof p.catch === "function") p.catch(() => {});
    } else if (typeof d.webkitExitFullscreen === "function") {
      d.webkitExitFullscreen();
    }
  } catch {
    /* non-fatal */
  }
}

const HIDE_DELAY_MS = 2800;

export function DeckViewer({
  previewSrc,
  title,
  slides,
  onExit,
  exitTitle = "Exit (Esc)",
  brand = false,
  showTitle = true,
  onPositionChange,
  extraControls,
  speakerNotesByPosition,
}: {
  previewSrc: string;
  title: string;
  slides: DeckViewerSlide[];
  // When provided, an exit (X) button is shown and Esc (after fullscreen/menu)
  // calls it. Omitted for the public viewer, which has nowhere to exit to.
  onExit?: () => void;
  exitTitle?: string;
  // Show a subtle "Canvas" wordmark (public share viewer).
  brand?: boolean;
  // Top-left deck-title pill. The public share viewer keeps it (the recipient
  // needs to know what they're looking at); present mode hides it — the
  // presenter knows, and the pill reads as clutter on a projected slide.
  showTitle?: boolean;
  // Observer for the authoritative slide position (fires on every change,
  // including navigation that originated inside the deck iframe). The public
  // viewer uses it for anonymous dwell telemetry; present mode leaves it
  // unset.
  onPositionChange?: (position: number) => void;
  // Extra buttons for the bottom control pill, rendered between the divider
  // and the fullscreen control. The public viewer slots its comments toggle
  // here; keep additions pill-button-shaped (h-10 w-10 sm:h-8 sm:w-8).
  extraControls?: ReactNode;
  // Speaker notes per slide position (0067). PRESENTER-ONLY: present mode
  // passes it; the public share viewer must never. The Notes toggle ("N") joins
  // the pill only when the map is non-empty; the notes card renders only while
  // toggled and floats bottom-left — it does NOT fade with the auto-hiding
  // chrome, since the presenter reads it continuously.
  speakerNotesByPosition?: Map<number, string>;
}) {
  const total = slides.length;

  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const hideTimer = useRef<number | null>(null);
  const menuOpenRef = useRef(false);
  // Touch-swipe tracking for mobile slide navigation (see the swipe-capture
  // layer in the JSX). Holds the start point + a flag so touchend can decide
  // whether the gesture was a horizontal swipe or just a tap / vertical scroll.
  const swipeRef = useRef<{ x: number; y: number; active: boolean }>({
    x: 0,
    y: 0,
    active: false,
  });

  const [position, setPosition] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [chromeVisible, setChromeVisible] = useState(true);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [notesOpen, setNotesOpen] = useState(false);
  const notesAvailable = (speakerNotesByPosition?.size ?? 0) > 0;

  const atStart = position <= 0;
  const atEnd = position >= total - 1;
  const showNav = total > 1;
  const showDots = showNav && total <= 12;

  // --- chrome auto-hide ---------------------------------------------------
  useEffect(() => {
    menuOpenRef.current = menuOpen;
  }, [menuOpen]);

  // Arm (or re-arm) the idle-hide timer. setChromeVisible(false) fires from
  // inside the timeout — async, so it's not a synchronous setState-in-effect.
  const scheduleHide = useCallback(() => {
    if (hideTimer.current != null) window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => {
      // Never hide while the slide-jump menu is open — the user is mid-pick.
      if (menuOpenRef.current) return;
      setChromeVisible(false);
    }, HIDE_DELAY_MS);
  }, []);

  const reveal = useCallback(() => {
    setChromeVisible(true);
    scheduleHide();
  }, [scheduleHide]);

  // Chrome starts visible (initial state) so the controls are discoverable; on
  // mount we just arm the idle-hide timer. We deliberately DON'T call reveal()
  // here — a synchronous setState in an effect body is disallowed, and it's
  // redundant since chromeVisible already starts true.
  useEffect(() => {
    scheduleHide();
    return () => {
      if (hideTimer.current != null) window.clearTimeout(hideTimer.current);
    };
  }, [scheduleHide]);

  // Reveal chrome on any pointer / touch activity.
  useEffect(() => {
    const onMove = () => reveal();
    window.addEventListener("mousemove", onMove);
    window.addEventListener("touchstart", onMove, { passive: true });
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("touchstart", onMove);
    };
  }, [reveal]);

  // --- lock background scroll while viewing -------------------------------
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  // Safety net for the cold-start cover: if the deck never signals readiness
  // (e.g. a transient error response that emits no canvas:state), clear the
  // cover after a few seconds so the viewer is never trapped behind the spinner.
  // A healthy deck clears it far sooner via canvas:state.
  useEffect(() => {
    const id = window.setTimeout(() => setLoaded(true), 6000);
    return () => window.clearTimeout(id);
  }, []);

  // --- exit + fullscreen --------------------------------------------------
  const exit = useCallback(() => {
    // Don't strand the page in fullscreen on the way out.
    if (fullscreenElement()) exitFullscreen();
    onExit?.();
  }, [onExit]);

  const toggleFullscreen = useCallback(() => {
    if (fullscreenElement()) exitFullscreen();
    else requestFullscreen();
  }, []);

  useEffect(() => {
    const onChange = () => setIsFullscreen(Boolean(fullscreenElement()));
    document.addEventListener("fullscreenchange", onChange);
    document.addEventListener("webkitfullscreenchange", onChange);
    return () => {
      document.removeEventListener("fullscreenchange", onChange);
      document.removeEventListener("webkitfullscreenchange", onChange);
    };
  }, []);

  // --- navigation ---------------------------------------------------------
  // Post the current position to the iframe whenever it changes. The onLoad
  // handler re-fires this too, since the first paint can land before this
  // effect's listener is wired (mirrors deck-workspace.tsx).
  //
  // `position` doubles as the 0-based list index AND the deck's
  // `data-canvas-position` value the controller navigates by. They're equal
  // because slide positions are 0-based and contiguous.
  useEffect(() => {
    iframeRef.current?.contentWindow?.postMessage(
      { type: "canvas:navigate", position },
      "*",
    );
  }, [position]);

  // Surface the authoritative position to the caller. Runs on the same state
  // the navigate effect reads, so callers see every change exactly once —
  // whether it came from host keys, the control pill, a swipe, or the deck's
  // own navigation echoed back via canvas:state.
  useEffect(() => {
    onPositionChange?.(position);
  }, [position, onPositionChange]);

  // Host-focused keyboard. Functional setState keeps these stable without
  // re-binding on every position change.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement | null;
      if (
        t &&
        (t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA" ||
          t.tagName === "SELECT" ||
          // A focused control button must keep native Space/Enter activation
          // — don't let Space steal it to advance the slide.
          t.tagName === "BUTTON" ||
          t.isContentEditable)
      ) {
        return;
      }
      switch (e.key) {
        case "ArrowRight":
        case "PageDown":
        case " ":
          e.preventDefault();
          setPosition((p) => Math.max(0, Math.min(total - 1, p + 1)));
          reveal();
          break;
        case "ArrowLeft":
        case "PageUp":
          e.preventDefault();
          setPosition((p) => Math.max(0, p - 1));
          reveal();
          break;
        case "Home":
          e.preventDefault();
          setPosition(0);
          reveal();
          break;
        case "End":
          e.preventDefault();
          setPosition(Math.max(0, total - 1));
          reveal();
          break;
        case "f":
        case "F":
          e.preventDefault();
          toggleFullscreen();
          reveal();
          break;
        case "n":
        case "N":
          // Speaker notes toggle — presenter surfaces only (the public viewer
          // never passes the prop, so this is a no-op there).
          if (notesAvailable) {
            e.preventDefault();
            setNotesOpen((v) => !v);
            reveal();
          }
          break;
        case "Escape":
          // Peel one layer at a time: jump menu → fullscreen (browser owns it)
          // → exit (if the caller gave us somewhere to go).
          if (menuOpenRef.current) {
            setMenuOpen(false);
            return;
          }
          if (fullscreenElement()) return; // browser exits fullscreen on Esc
          // Only exit if the caller gave us somewhere to go (present mode → the
          // editor). The public viewer has no exit target, so Esc here is a
          // deliberate no-op rather than routing through a do-nothing exit().
          if (onExit) exit();
          break;
        default:
          return;
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [total, reveal, toggleFullscreen, exit, onExit, notesAvailable]);

  // iframe → host messages: reconcile position (deck navigated itself) and
  // honour keys forwarded from inside the iframe.
  useEffect(() => {
    function onMessage(event: MessageEvent) {
      const frame = iframeRef.current;
      if (!frame || event.source !== frame.contentWindow) return;
      const data = event.data;
      if (!data) return;
      if (data.type === "canvas:activity") {
        // Pointer/touch movement inside the (cross-origin) iframe — the host
        // window can't see it directly, so the controller forwards it. Wake the
        // chrome + cursor.
        reveal();
        return;
      }
      if (data.type === "canvas:state") {
        // The deck is alive and rendering — clear the cold-start cover. Gating
        // on this (not the raw iframe onLoad) avoids revealing an error body.
        setLoaded(true);
        if (typeof data.position !== "number") return;
        const next = Math.max(0, Math.min(total - 1, data.position));
        // Only setState on a real change — avoids the iframe→host→iframe loop
        // the navigate effect would otherwise spin.
        setPosition((prev) => (prev === next ? prev : next));
        return;
      }
      if (data.type === "canvas:key") {
        switch (data.key) {
          case "ArrowRight":
          case "PageDown":
          case " ":
            setPosition((p) => Math.max(0, Math.min(total - 1, p + 1)));
            break;
          case "ArrowLeft":
          case "PageUp":
            setPosition((p) => Math.max(0, p - 1));
            break;
          case "Home":
            setPosition(0);
            break;
          case "End":
            setPosition(Math.max(0, total - 1));
            break;
          default:
            return;
        }
        reveal();
      }
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [total, reveal]);

  const goTo = (index: number) => {
    setPosition(Math.max(0, Math.min(total - 1, index)));
    reveal();
  };

  // --- touch swipe navigation (mobile) ------------------------------------
  // The slide is a cross-origin sandboxed iframe (allow-scripts WITHOUT
  // allow-same-origin), so touch events over it DON'T bubble to the host
  // window — a window-level listener can't see swipes that happen over the
  // slide. We therefore capture them on a transparent layer that sits ABOVE
  // the iframe but BELOW the chrome (see the JSX). Present-mode slides are
  // non-interactive, so hijacking horizontal drags there is the standard
  // presenter affordance; vertical pan/pinch is left to the browser via
  // touch-action: pan-y on that layer.
  const SWIPE_THRESHOLD_PX = 45;

  const onSwipeStart = (e: ReactTouchEvent) => {
    // The iframe normally swallows the touchstart the window listener relied
    // on, so reveal the chrome from here to keep the tap-to-wake behaviour.
    reveal();
    if (menuOpenRef.current) {
      swipeRef.current.active = false;
      return;
    }
    const t = e.touches[0];
    if (!t) return;
    swipeRef.current = { x: t.clientX, y: t.clientY, active: true };
  };

  const onSwipeEnd = (e: ReactTouchEvent) => {
    const s = swipeRef.current;
    if (!s.active) return;
    swipeRef.current.active = false;
    if (menuOpenRef.current) return; // let the jump menu own the gesture
    const t = e.changedTouches[0];
    if (!t) return;
    const dx = t.clientX - s.x;
    const dy = t.clientY - s.y;
    // Only a predominantly-horizontal drag past the threshold counts as a
    // swipe — vertical gestures and taps fall through untouched.
    if (Math.abs(dx) <= Math.abs(dy) || Math.abs(dx) < SWIPE_THRESHOLD_PX) {
      return;
    }
    // Swipe left → next, swipe right → previous (natural drag direction).
    goTo(dx < 0 ? position + 1 : position - 1);
  };

  const current = slides[position] ?? null;

  return (
    <div
      className={cn(
        // Always-dark backdrop (navy-glow is deep in both themes). It shows
        // behind the loading cover and, in portrait, paints the letterbox bars
        // around the centred 16:9 iframe (see the iframe's portrait classes).
        // flex centring only affects the in-flow iframe; the swipe layer, cover,
        // and chrome are all absolutely positioned and still cover the viewport.
        "fixed inset-0 z-50 flex items-center justify-center overflow-hidden bg-[color:var(--navy-glow)]",
        !chromeVisible && "cursor-none",
      )}
    >
      <iframe
        ref={iframeRef}
        src={previewSrc}
        // SECURITY: untrusted deck HTML. allow-scripts WITHOUT allow-same-origin
        // keeps deck nav working while denying access to the app's cookies /
        // origin. The postMessage protocol validates by event.source, not
        // origin. Mirrors deck-workspace.tsx — do NOT add allow-same-origin.
        sandbox="allow-scripts"
        title={`${title} — slides`}
        // Landscape/desktop: full-bleed (h-full w-full) — the iframe viewport is
        // ~16:9 so slides fill the screen, unchanged. Portrait: a width-filling
        // 16:9 box (aspect-video w-full) centred by the parent flex, so the deck
        // renders at its intended proportions and the dark backdrop letterboxes
        // above/below instead of the slide squishing. max-h-full guards the rare
        // portrait viewport tall enough that 16:9-by-width would still overflow.
        className="h-full w-full border-0 bg-white portrait:h-auto portrait:max-h-full portrait:w-full portrait:aspect-video"
        onLoad={() => {
          // Don't clear the cover here — onLoad fires for error bodies (e.g. a
          // cold 503) too, which would flash the error page. We clear it on the
          // deck's first canvas:state instead. Just (re)assert the position.
          iframeRef.current?.contentWindow?.postMessage(
            { type: "canvas:navigate", position },
            "*",
          );
        }}
      />

      {/* Transparent swipe-capture layer (mobile). Sits ABOVE the iframe but
       * BELOW the chrome overlay (z-[4]) and cold-start cover (z-[3]) so taps
       * still wake the chrome and the jump menu / controls stay interactive.
       * Needed because the slide iframe is cross-origin sandboxed — touch
       * events over it never reach the host window — so we read swipes here.
       * touch-pan-y lets the browser keep vertical scroll / pinch-zoom while we
       * claim the horizontal gesture. Only mounted when there's somewhere to
       * navigate. Scoped to pointer-coarse (touch): on a fine pointer (mouse)
       * it's pointer-events-none, so the public share viewer's desktop
       * click-through to any in-slide links is unchanged. */}
      {showNav ? (
        <div
          className="pointer-events-none absolute inset-0 z-[2] touch-pan-y pointer-coarse:pointer-events-auto"
          aria-hidden
          onTouchStart={onSwipeStart}
          onTouchEnd={onSwipeEnd}
        />
      ) : null}

      {/* Cold-start cover. The preview function 503s for 2-5s on a cold Vercel
       * instance; without this a viewer flashes white between launch and first
       * paint. */}
      {!loaded ? (
        <div className="absolute inset-0 z-[3] flex flex-col items-center justify-center gap-4 bg-[color:var(--navy-glow)]">
          <div
            aria-hidden
            className="h-7 w-7 animate-spin rounded-full border-2 border-white/25 border-t-white/80"
          />
          <p className="font-machine text-xs text-white/60">Loading {title}…</p>
        </div>
      ) : null}

      {/* Chrome overlay — pointer-events only on the controls so the slide stays
       * click-through. Fades with chromeVisible. */}
      <div
        className={cn(
          "pointer-events-none absolute inset-0 z-[4] transition-opacity duration-300 motion-reduce:transition-none",
          chromeVisible ? "opacity-100" : "opacity-0",
        )}
        aria-hidden={!chromeVisible}
      >
        {/* Top-left: deck context. On the fixed dark scrim, foreground tokens
         * (dark in light theme) would be invisible, so this single label rides a
         * card-surface pill that flips with the theme like the bottom bar. */}
        {/* top offset clears the notch/status bar on a notched phone; falls
         * back to 1rem on devices without a safe-area inset. */}
        {showTitle ? (
          <div className="absolute left-4 top-[max(1rem,env(safe-area-inset-top))] flex items-center gap-2">
            <span className="max-w-[60vw] truncate rounded-full border border-border/70 bg-card/85 px-3 py-1 text-xs font-medium text-foreground shadow-sm backdrop-blur">
              {title}
            </span>
          </div>
        ) : null}

        {/* Bottom-left: optional "Canvas" wordmark for the public share viewer,
         * so a recipient knows what made the deck. Editor/present omit it. */}
        {brand ? (
          <div className="absolute bottom-[max(1.25rem,env(safe-area-inset-bottom))] left-4">
            <span className="font-machine rounded-full border border-border/70 bg-card/85 px-3 py-1 text-[11px] font-semibold tracking-tight text-muted-foreground shadow-sm backdrop-blur">
              Canvas
            </span>
          </div>
        ) : null}

        {/* Bottom-center control pill — same visual language as DeckChrome.
         * bottom offset clears the iPhone home indicator on a notched phone;
         * falls back to 1.25rem (the old bottom-5) elsewhere. */}
        <div className="absolute inset-x-0 bottom-[max(1.25rem,env(safe-area-inset-bottom))] flex justify-center px-4">
          <div className="pointer-events-auto relative flex items-center gap-2 rounded-full border border-border/80 bg-card/90 px-2.5 py-1.5 shadow-lg backdrop-blur">
            {/* Slide-jump menu, anchored above the counter. */}
            {menuOpen ? (
              <MenuSurface
                onClose={() => setMenuOpen(false)}
                aria-label="Jump to slide"
                className="absolute bottom-full left-1/2 mb-2 max-h-[50dvh] w-[min(80vw,320px)] -translate-x-1/2 overflow-y-auto rounded-[12px] border border-border bg-card p-1 shadow-2xl"
              >
                {slides.map((s) => {
                  const isCurrent = s.position === position;
                  return (
                    <button
                      key={s.id}
                      role="menuitem"
                      type="button"
                      onClick={() => {
                        goTo(s.position);
                        setMenuOpen(false);
                      }}
                      className={cn(
                        "flex w-full items-center gap-3 rounded-[8px] px-2.5 py-1.5 text-left text-xs transition-colors",
                        isCurrent
                          ? "bg-[color:var(--accent-wash)] text-foreground"
                          : "text-muted-foreground hover:bg-muted hover:text-foreground",
                      )}
                    >
                      <span className="font-machine w-6 shrink-0 text-right text-[11px] tabular-nums">
                        {s.position + 1}
                      </span>
                      <span className="min-w-0 flex-1 truncate">
                        {s.title || "Untitled slide"}
                      </span>
                    </button>
                  );
                })}
              </MenuSurface>
            ) : null}

            {showNav ? (
              <button
                type="button"
                onClick={() => goTo(position - 1)}
                disabled={atStart}
                aria-label="Previous slide"
                title="Previous slide (←)"
                // 40px tap target on mobile (touch); back to the desktop 32px
                // at sm+ so the control row is visually unchanged on pointer.
                className="flex h-10 w-10 items-center justify-center rounded-full text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-30 disabled:hover:bg-transparent sm:h-8 sm:w-8"
              >
                <ChevronLeft aria-hidden className="h-4 w-4" />
              </button>
            ) : null}

            {/* Counter — also the slide-jump trigger. font-machine + tabular
             * digits so the width is stable as it ticks. */}
            <button
              type="button"
              onClick={() => {
                if (total <= 1) return;
                setMenuOpen((v) => !v);
                reveal();
              }}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              disabled={total <= 1}
              title={total > 1 ? "Jump to slide" : undefined}
              className="font-machine flex items-center rounded-[6px] px-2 py-1 text-[11px] tabular-nums text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:hover:bg-transparent disabled:hover:text-muted-foreground"
            >
              <strong className="font-semibold text-foreground">
                {total === 0 ? 0 : position + 1}
              </strong>
              <span className="mx-1 opacity-60">/</span>
              {total}
            </button>

            {showDots ? (
              <div className="flex items-center gap-1.5 px-1">
                {slides.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => goTo(s.position)}
                    aria-label={`Slide ${s.position + 1}: ${s.title || "untitled"}`}
                    aria-current={s.position === position ? "true" : undefined}
                    className={cn(
                      // The painted dot stays tiny, but a transparent ::before
                      // overlay expands the tappable zone to ~28px so it's
                      // reachable on touch without enlarging the visible dot or
                      // the control row. Inset is negative top/bottom (the dot
                      // is only 6px tall) and a smaller horizontal pad so
                      // adjacent dots' hit zones don't overlap into each other.
                      "relative h-1.5 rounded-full transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring before:absolute before:-inset-x-1 before:-inset-y-[11px] before:content-['']",
                      s.position === position
                        ? "w-4 bg-foreground"
                        : "w-1.5 bg-muted-foreground/40 hover:bg-muted-foreground/70",
                    )}
                  />
                ))}
              </div>
            ) : null}

            {showNav ? (
              <button
                type="button"
                onClick={() => goTo(position + 1)}
                disabled={atEnd}
                aria-label="Next slide"
                title="Next slide (→)"
                className="flex h-10 w-10 items-center justify-center rounded-full text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-30 disabled:hover:bg-transparent sm:h-8 sm:w-8"
              >
                <ChevronRight aria-hidden className="h-4 w-4" />
              </button>
            ) : null}

            <span aria-hidden className="mx-0.5 h-5 w-px bg-border" />

            {notesAvailable ? (
              <button
                type="button"
                onClick={() => {
                  setNotesOpen((v) => !v);
                  reveal();
                }}
                aria-label={notesOpen ? "Hide speaker notes" : "Show speaker notes"}
                aria-pressed={notesOpen}
                title={notesOpen ? "Hide notes (N)" : "Notes (N)"}
                className={cn(
                  "flex h-10 w-10 items-center justify-center rounded-full text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:h-8 sm:w-8",
                  notesOpen && "bg-muted",
                )}
              >
                <NotebookText aria-hidden className="h-4 w-4" />
              </button>
            ) : null}

            {extraControls}

            <button
              type="button"
              onClick={() => {
                toggleFullscreen();
                reveal();
              }}
              aria-label={isFullscreen ? "Exit fullscreen" : "Enter fullscreen"}
              title={isFullscreen ? "Exit fullscreen (F)" : "Fullscreen (F)"}
              className="flex h-10 w-10 items-center justify-center rounded-full text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:h-8 sm:w-8"
            >
              {isFullscreen ? (
                <Minimize2 aria-hidden className="h-4 w-4" />
              ) : (
                <Maximize2 aria-hidden className="h-4 w-4" />
              )}
            </button>

            {onExit ? (
              <button
                type="button"
                onClick={exit}
                aria-label="Exit"
                title={exitTitle}
                className="flex h-10 w-10 items-center justify-center rounded-full text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:h-8 sm:w-8"
              >
                <X aria-hidden className="h-4 w-4" />
              </button>
            ) : null}
          </div>
        </div>
      </div>

      {/* Speaker notes card (presenter-only, 0067). Deliberately OUTSIDE the
        * auto-hiding chrome: the presenter reads it continuously, so it stays
        * put while the controls fade. Bottom-left, clear of the control pill. */}
      {notesAvailable && notesOpen ? (
        <aside
          aria-label="Speaker notes"
          className="absolute bottom-[max(5rem,calc(env(safe-area-inset-bottom)+4.5rem))] left-4 z-[5] w-[min(26rem,calc(100vw-2rem))] rounded-[12px] border border-border/80 bg-card/95 p-4 shadow-lg backdrop-blur"
        >
          <div className="font-machine mb-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">
            Notes · Slide {position + 1}
          </div>
          <div className="max-h-[30dvh] overflow-y-auto whitespace-pre-wrap text-sm leading-relaxed text-foreground">
            {speakerNotesByPosition?.get(position) ?? (
              <span className="text-muted-foreground">
                No notes for this slide.
              </span>
            )}
          </div>
        </aside>
      ) : null}

      {/* Screen-reader live region for slide changes. */}
      <div className="sr-only" role="status" aria-live="polite">
        {current
          ? `Slide ${position + 1} of ${total}: ${current.title || "Untitled slide"}`
          : ""}
      </div>
    </div>
  );
}

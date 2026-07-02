"use client";

import { useCallback, useEffect, useMemo, useRef } from "react";
import type { DeckViewerSlide } from "@/components/deck-viewer";
import type { TrackEvent } from "@/lib/canvas/engagement";
import { mintOpaqueSession } from "@/lib/canvas/opaque-session";

// Anonymous view telemetry for the PUBLIC share viewer only. Wired from
// PublicDeckViewer — never from present mode, which shares DeckViewer but
// must not count as recipient engagement (the owner rehearsing is not a
// client reading).
//
// What it measures (and the ceiling): the sandboxed deck iframe is an opaque
// origin, so the host only ever sees slide *transitions* via DeckViewer's
// position state. Per-slide dwell is the grain; there is no in-slide
// scroll/click tracking, deliberately.
//
// Mechanics:
//   * a persistent opaque session id in localStorage (no cookie, no PII);
//   * dwell timing pauses while the tab is hidden (Page Visibility API) so a
//     background tab doesn't inflate time-on-slide;
//   * events queue locally and flush in batches — periodic fetch(keepalive)
//     plus a final sendBeacon on pagehide, so the last slide's dwell isn't
//     lost with the tab (best-effort; beacon loss is acceptable for
//     directional data).

const SESSION_KEY = "canvas:view-session";
const FLUSH_INTERVAL_MS = 15_000;

// Persistent opaque view-session id: no cookie, no PII, with a per-load
// fallback when storage is denied (private mode) — uniques over-count
// slightly, opens stay correct. Its own storage key and 's' fallback prefix
// keep it a DISTINCT identity from the guest-comment session.
function mintSession(): string {
  return mintOpaqueSession(SESSION_KEY, "s");
}

export function useViewTracking(token: string, slides: DeckViewerSlide[]) {
  const total = slides.length;
  const slideIdByPosition = useMemo(() => {
    const map = new Map<number, string>();
    for (const s of slides) map.set(s.position, s.id);
    return map;
  }, [slides]);

  const sessionRef = useRef<string | null>(null);
  const queueRef = useRef<TrackEvent[]>([]);
  // Dwell accounting for the slide currently on screen.
  const currentRef = useRef<{ position: number; enteredAt: number; accumulatedMs: number }>({
    position: 0,
    enteredAt: 0,
    accumulatedMs: 0,
  });
  const trackedRef = useRef(false);

  const flush = useCallback(
    (useBeacon: boolean) => {
      const events = queueRef.current;
      const session = sessionRef.current;
      if (!session || events.length === 0) return;
      queueRef.current = [];
      const payload = JSON.stringify({ session, events });
      const url = `/api/public/deck/${token}/track`;
      try {
        if (useBeacon && typeof navigator.sendBeacon === "function") {
          navigator.sendBeacon(url, new Blob([payload], { type: "application/json" }));
          return;
        }
        void fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: payload,
          keepalive: true,
        }).catch(() => {});
      } catch {
        // Telemetry must never break the viewer.
      }
    },
    [token],
  );

  // Close out the dwell clock for the slide being left and queue its event.
  const settleDwell = useCallback(() => {
    const cur = currentRef.current;
    const now = Date.now();
    const ms = cur.accumulatedMs + (cur.enteredAt > 0 ? now - cur.enteredAt : 0);
    cur.accumulatedMs = 0;
    cur.enteredAt = now;
    if (ms < 250) return; // a pass-through flicker isn't a view
    const slideId = slideIdByPosition.get(cur.position);
    if (!slideId) return;
    queueRef.current.push({
      type: "slide",
      slide_id: slideId,
      position: cur.position,
      ms,
      reached_end: cur.position >= total - 1 || undefined,
    });
  }, [slideIdByPosition, total]);

  const onPositionChange = useCallback(
    (position: number) => {
      if (!trackedRef.current) return;
      const cur = currentRef.current;
      if (position === cur.position) return;
      settleDwell();
      currentRef.current = { position, enteredAt: Date.now(), accumulatedMs: 0 };
    },
    [settleDwell],
  );

  useEffect(() => {
    // Effects run twice under Strict Mode dev; the ref guard keeps a single
    // open per mount and the cleanup re-arms it for a real remount.
    if (trackedRef.current) return;
    trackedRef.current = true;

    sessionRef.current = mintSession();
    currentRef.current = { position: 0, enteredAt: Date.now(), accumulatedMs: 0 };

    let referrerHost: string | null = null;
    try {
      referrerHost = document.referrer ? new URL(document.referrer).host : null;
    } catch {
      referrerHost = null;
    }
    queueRef.current.push({
      type: "open",
      slide_count: total,
      referrer_host: referrerHost,
    });
    flush(false);

    const interval = window.setInterval(() => flush(false), FLUSH_INTERVAL_MS);

    // Pause the dwell clock while hidden; bank the elapsed time on hide and
    // restart the clock on show.
    const onVisibility = () => {
      const cur = currentRef.current;
      if (document.visibilityState === "hidden") {
        if (cur.enteredAt > 0) {
          cur.accumulatedMs += Date.now() - cur.enteredAt;
          cur.enteredAt = 0;
        }
        settleDwell();
        // settleDwell resets the clock to "running"; hold it paused while
        // hidden so background time never counts.
        currentRef.current.enteredAt = 0;
        currentRef.current.accumulatedMs = 0;
        flush(true);
      } else if (cur.enteredAt === 0) {
        cur.enteredAt = Date.now();
      }
    };
    const onPageHide = () => {
      settleDwell();
      flush(true);
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", onPageHide);

    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", onPageHide);
      trackedRef.current = false;
    };
  }, [flush, settleDwell, total]);

  return { onPositionChange };
}

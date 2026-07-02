"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";

// Shared retry wrapper for the on-demand thumbnail renders
// (GET /api/decks/{id}/slides/{slideId}/thumbnail → headless Chromium → JPEG),
// used by the deck index, the inbox proposal list, and the per-slide proposal
// chip — all three mount and fire every thumbnail at once, so all three hit the
// same failure mode. The route's bounded gate queues most of that burst, but a
// request that overflows the wait queue (or times out) is shed with a 429; a bare
// <img> shows those as a broken icon until the next navigation. This re-requests
// on a load error with a jittered backoff so a thumbnail that lost the first race
// fills in on its own within a few seconds, and settles to a calm placeholder
// after MAX_RETRIES (a genuine 404 — e.g. a deleted slide — shouldn't retry
// forever).
//
// Visibility is NOT gated on an onLoad "ready" state: a cached thumbnail (a
// revisit within the route's 60s cache) can finish loading before React attaches
// onLoad, so that event never fires — an opacity/hidden gate keyed on it would
// leave the loaded image invisible forever. Instead the <img> is always laid out
// over the muted box: before it loads the box shows, once it paints the opaque
// JPEG covers it. Only onError drives state, and onError fires reliably on a
// genuine failure.

const MAX_RETRIES = 5;
const BASE_DELAY_MS = 600;
const MAX_DELAY_MS = 8000;

// First attempt uses the bare URL so a cached success (the route caches
// current-state thumbnails for 60s) is reused across loads; retries add a
// throwaway cache-buster so each re-request actually reaches the route rather
// than replaying the failed response from cache. The route ignores unknown
// params, but pick the separator correctly so this stays reusable.
function attemptUrl(url: string, attempt: number): string {
  if (attempt === 0) return url;
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}_retry=${attempt}`;
}

// "live" → the img is mounted and loading/loaded; "backoff" → a load failed and
// we're waiting to retry (img unmounted so no broken icon shows); "dead" →
// retries exhausted, the caller's placeholder.
type Phase = "live" | "backoff" | "dead";

// The retrying <img>, laid out to fill `containerClassName` (which carries the
// surface's own box: size, rounding, border, muted background, responsive
// visibility). `placeholder` renders once retries are exhausted — pass the
// surface's "No preview" node, or omit for a bare muted box.
export function RetryingThumbnail({
  src,
  containerClassName,
  placeholder = null,
}: {
  src: string;
  containerClassName: string;
  placeholder?: ReactNode;
}) {
  const [attempt, setAttempt] = useState(0);
  const [phase, setPhase] = useState<Phase>("live");

  // Reset to a fresh first attempt when the underlying slide changes (e.g. a
  // client-side filter swaps which rows are listed and a row is reused).
  const [lastSrc, setLastSrc] = useState(src);
  if (lastSrc !== src) {
    setLastSrc(src);
    setAttempt(0);
    setPhase("live");
  }

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  function handleError() {
    if (attempt >= MAX_RETRIES) {
      setPhase("dead");
      return;
    }
    // Exponential backoff with full jitter (0.5×–1.5×) so a wall of rows that all
    // 429'd together don't re-stampede the gate in lockstep. Unmount the img while
    // we wait so the failed frame doesn't flash a broken icon.
    const backoff = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** attempt);
    const wait = backoff * (0.5 + Math.random());
    if (timer.current) clearTimeout(timer.current);
    setPhase("backoff");
    timer.current = setTimeout(() => {
      setAttempt((n) => n + 1);
      setPhase("live");
    }, wait);
  }

  return (
    <div className={cn("relative overflow-hidden", containerClassName)}>
      {phase === "live" ? (
        // Authenticated, on-demand screenshot route; next/image would add an
        // optimizer hop with no benefit for a small preview and can't carry the
        // per-attempt retry param.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          // Remount per attempt so a retry re-requests even when the prior URL is
          // identical.
          key={attempt}
          src={attemptUrl(src, attempt)}
          alt=""
          loading="lazy"
          decoding="async"
          onError={handleError}
          className="h-full w-full object-cover"
        />
      ) : phase === "backoff" ? (
        // Waiting to retry: a quiet skeleton over the muted box.
        <div aria-hidden className="absolute inset-0 animate-pulse bg-muted" />
      ) : (
        // Retries exhausted — the caller's calm placeholder (or a bare muted box).
        placeholder
      )}
    </div>
  );
}

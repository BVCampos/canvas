"use client";

import { useCallback, useMemo, useState } from "react";
import { DeckViewer, type DeckViewerSlide } from "@/components/deck-viewer";
import { useViewTracking } from "./use-view-tracking";
import {
  PublicCommentsButton,
  PublicCommentsSheet,
  usePublicComments,
} from "./public-comments";

// Public share viewer. A thin adapter over the shared DeckViewer: load the deck
// from the cookieless public render route, brand it as Canvas, and offer no
// editor exit (an anonymous visitor has nowhere to return to). Fullscreen and
// keyboard/slide nav come for free from DeckViewer.
//
// This adapter is also the ONLY place recipient-facing features are wired —
// view telemetry and the guest comment layer. Present mode shares DeckViewer
// and must never grow either.

export function PublicDeckViewer({
  token,
  title,
  slides,
  commentsEnabled = false,
}: {
  token: string;
  title: string;
  slides: DeckViewerSlide[];
  commentsEnabled?: boolean;
}) {
  const { onPositionChange: onTrackPosition } = useViewTracking(token, slides);
  const [position, setPosition] = useState(0);
  const [commentsOpen, setCommentsOpen] = useState(false);
  const { threads, refresh, loadError } = usePublicComments(
    token,
    commentsEnabled,
  );

  const onPositionChange = useCallback(
    (next: number) => {
      onTrackPosition(next);
      setPosition(next);
    },
    [onTrackPosition],
  );

  const currentSlide = useMemo(
    () => slides.find((s) => s.position === position) ?? null,
    [slides, position],
  );
  const currentSlideThreadCount = useMemo(
    () =>
      currentSlide
        ? threads.filter((t) => t.slide_id === currentSlide.id).length
        : 0,
    [threads, currentSlide],
  );

  return (
    <>
      <DeckViewer
        previewSrc={`/api/public/deck/${token}/preview`}
        title={title}
        slides={slides}
        brand
        onPositionChange={onPositionChange}
        extraControls={
          commentsEnabled ? (
            <PublicCommentsButton
              count={currentSlideThreadCount}
              open={commentsOpen}
              onToggle={() => setCommentsOpen((v) => !v)}
            />
          ) : null
        }
      />
      {commentsEnabled && commentsOpen ? (
        <PublicCommentsSheet
          token={token}
          deckTitle={title}
          slideTitle={currentSlide?.title ?? ""}
          slideId={currentSlide?.id ?? null}
          slidePosition={position}
          threads={threads}
          loadError={loadError}
          onPosted={() => void refresh()}
          onRetry={() => void refresh()}
          onClose={() => setCommentsOpen(false)}
        />
      ) : null}
    </>
  );
}

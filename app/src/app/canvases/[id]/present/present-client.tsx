"use client";

import { useMemo } from "react";
import { useRouter } from "next/navigation";
import { DeckViewer, type DeckViewerSlide } from "@/components/deck-viewer";

// Full-screen presentation. A thin adapter over the shared DeckViewer: present
// mode is "the read-only viewer, loaded from the private preview route, with an
// exit that returns to the editor". All the iframe/postMessage/chrome behaviour
// lives in DeckViewer so present and the public share viewer can't drift apart.
//
// Speaker notes (0067) are presenter-only: threaded into DeckViewer's notes
// panel here and ONLY here — the public share viewer must never receive them.

type PresentSlide = DeckViewerSlide & { speaker_notes: string | null };

export function PresentClient({
  deckId,
  title,
  slides,
}: {
  deckId: string;
  title: string;
  slides: PresentSlide[];
}) {
  const router = useRouter();

  const notesByPosition = useMemo(() => {
    const map = new Map<number, string>();
    for (const s of slides) {
      if (s.speaker_notes) map.set(s.position, s.speaker_notes);
    }
    return map;
  }, [slides]);

  return (
    <DeckViewer
      // ?present=1 suppresses the deck's editor-only "click to edit" hint. The
      // preview route signs its own asset URLs and is sandboxed to an opaque
      // origin, so this iframe carries no cookies and can't reach the app origin.
      previewSrc={`/api/decks/${deckId}/preview?present=1`}
      title={title}
      slides={slides}
      onExit={() => router.push(`/canvases/${deckId}`)}
      exitTitle="Exit presentation (Esc)"
      // No title pill while presenting — the presenter knows the deck, and the
      // pill is noise on a projected slide. The public share viewer keeps it.
      showTitle={false}
      speakerNotesByPosition={notesByPosition}
    />
  );
}

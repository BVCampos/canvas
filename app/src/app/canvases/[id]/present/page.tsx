import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { logUsage } from "@/lib/usage/log";
import { PresentClient } from "./present-client";

// /canvases/{id}/present — full-screen presentation.
//
// A thin server loader (mirrors the editor's page.tsx auth/data pattern, but
// only needs the deck title + ordered slide list — no locks, comments,
// proposals, or version metadata). RLS gates access: a deck the caller can't
// see comes back null → notFound(). The actual slide HTML is rendered by the
// same sandboxed /api/decks/{id}/preview route the editor uses, so there is no
// second rendering path to keep in sync.
//
// `force-dynamic` mirrors the preview route's `no-store` freshness — present
// mode should always show the deck's current state, never a cached cut.
export const dynamic = "force-dynamic";

type PresentSlide = {
  id: string;
  position: number;
  title: string;
  speaker_notes: string | null;
};

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const supabase = await createClient();
  const { data: deck } = await supabase
    .from("canvas_deck")
    .select("title")
    .eq("id", id)
    .maybeSingle();
  return { title: deck?.title ? `${deck.title} — Present` : "Present" };
}

export default async function PresentPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();

  const { data: deck, error: deckErr } = await supabase
    .from("canvas_deck")
    .select("id, title, workspace_id")
    .eq("id", id)
    .maybeSingle();

  if (deckErr) {
    console.error("[present]", deckErr);
  }
  if (!deck) notFound();

  const { data: slidesRaw } = await supabase
    .from("canvas_deck_slide")
    .select("id, position, title, speaker_notes")
    .eq("deck_id", id)
    .order("position", { ascending: true });

  const slides: PresentSlide[] = (slidesRaw ?? []).map((s) => ({
    id: s.id as string,
    position: s.position as number,
    title: (s.title as string) ?? "",
    speaker_notes: (s.speaker_notes as string | null) ?? null,
  }));

  // The present-mode demand signal the discovery doc says to collect before
  // investing in presenter view / follow-along: one event per present open.
  const {
    data: { user },
  } = await supabase.auth.getUser();
  logUsage({
    event: "deck.present",
    surface: "action",
    user_id: user?.id ?? null,
    workspace_id: (deck.workspace_id as string | null) ?? null,
    deck_id: deck.id,
    props: {
      slide_count: slides.length,
      slides_with_notes: slides.filter((s) => s.speaker_notes).length,
    },
  });

  return <PresentClient deckId={deck.id} title={deck.title} slides={slides} />;
}

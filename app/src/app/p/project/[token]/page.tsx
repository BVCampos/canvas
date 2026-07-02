import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import type { DeckViewerSlide } from "@/components/deck-viewer";
import { PublicProjectViewer, type PublicProjectDeck } from "./public-project-viewer";

// /p/project/{token} — public, unauthenticated, read-only viewer for a whole
// project ("anyone with the link can view"). Lives at the app root, OUTSIDE the
// (auth)/canvases/settings layouts, so it inherits no workspace gate. Mirrors
// /p/{token} (the single-deck viewer), but the token is the capability for
// EVERY deck in the project.
//
// Authorization is the token itself: we resolve the project via the service-role
// client gated solely by an exact public_share_token match (migration 0046). A
// disabled or rotated link yields no row -> notFound(). We read the project
// title + each deck's title + ordered slide list here (for the rails); the slide
// HTML is rendered by the cookieless project-scoped preview route the viewer
// iframes.

export const dynamic = "force-dynamic";

const TOKEN_RE = /^[A-Za-z0-9_-]{16,64}$/;

async function loadProject(token: string) {
  if (!TOKEN_RE.test(token)) return null;
  const admin = createAdminClient();
  const { data: project, error } = await admin
    .from("canvas_project")
    .select("id, name")
    .eq("public_share_token", token)
    .maybeSingle();
  if (error) {
    console.error("[public-project]", error);
    return null;
  }
  return project;
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ token: string }>;
}): Promise<Metadata> {
  const { token } = await params;
  const project = await loadProject(token);
  return {
    title: project?.name ? `${project.name}` : "Shared project",
    // A capability link is not meant to be crawled.
    robots: { index: false, follow: false },
  };
}

export default async function PublicProjectPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const project = await loadProject(token);
  if (!project) notFound();

  const admin = createAdminClient();
  // Stable order: oldest deck first (created_at), independent of edit activity.
  // Private decks are excluded from the public surface (the membership cascade
  // still shows them to invited members; the world-readable link does not).
  const { data: decksRaw, error: decksErr } = await admin
    .from("canvas_deck")
    .select("id, title")
    .eq("project_id", project.id)
    .neq("visibility", "private")
    .order("created_at", { ascending: true });
  if (decksErr) {
    console.error("[public-project:decks]", decksErr);
  }

  // One batched slide read for every (non-private) deck, then grouped in JS —
  // avoids the N+1 of a query per deck. Deck order is preserved from decksRaw;
  // slide order from `position` (the query orders by it).
  const deckIds = (decksRaw ?? []).map((d) => d.id as string);
  const slidesByDeck = new Map<string, DeckViewerSlide[]>();
  if (deckIds.length > 0) {
    const { data: slidesRaw, error: slidesErr } = await admin
      .from("canvas_deck_slide")
      .select("id, position, title, deck_id")
      .in("deck_id", deckIds)
      .order("position", { ascending: true });
    if (slidesErr) {
      console.error("[public-project:slides]", slidesErr);
    }
    for (const s of slidesRaw ?? []) {
      const deckId = s.deck_id as string;
      const list = slidesByDeck.get(deckId) ?? [];
      list.push({
        id: s.id as string,
        position: s.position as number,
        title: (s.title as string) ?? "",
      });
      slidesByDeck.set(deckId, list);
    }
  }

  const decks: PublicProjectDeck[] = (decksRaw ?? []).map((d) => ({
    id: d.id as string,
    title: (d.title as string) ?? "",
    slides: slidesByDeck.get(d.id as string) ?? [],
  }));

  return (
    <PublicProjectViewer
      token={token}
      projectName={project.name}
      decks={decks}
    />
  );
}

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { PublicDeckViewer } from "./public-deck-viewer";

// /p/{token} — public, unauthenticated, read-only deck viewer ("anyone with the
// link can view"). Lives at the app root, OUTSIDE the (auth)/canvases/settings
// layouts, so it inherits no workspace gate — exactly what an anonymous visitor
// needs. The proxy middleware only refreshes the session cookie (it never
// redirects), so an anon request flows straight through.
//
// Authorization is the token itself: we resolve the deck via the service-role
// client gated solely by an exact public_share_token match (see migration 0027
// and /api/public/deck/{token}/preview). A disabled or rotated link yields no
// row -> notFound(). We read ONLY the deck title + ordered slide list here (for
// the nav rail); the slide HTML is rendered by the cookieless public preview
// route the viewer iframes.

export const dynamic = "force-dynamic";

const TOKEN_RE = /^[A-Za-z0-9_-]{16,64}$/;

type PublicSlide = { id: string; position: number; title: string };

async function loadDeck(token: string) {
  if (!TOKEN_RE.test(token)) return null;
  const admin = createAdminClient();
  const { data: deck, error } = await admin
    .from("canvas_deck")
    .select("id, title, public_comments_enabled")
    .eq("public_share_token", token)
    .maybeSingle();
  if (error) {
    console.error("[public-deck]", error);
    return null;
  }
  return deck;
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ token: string }>;
}): Promise<Metadata> {
  const { token } = await params;
  const deck = await loadDeck(token);
  return {
    title: deck?.title ? `${deck.title}` : "Shared deck",
    // A capability link is not meant to be crawled — keep shared decks out of
    // search indexes even if the URL leaks into a referrer or sitemap.
    robots: { index: false, follow: false },
  };
}

export default async function PublicDeckPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const deck = await loadDeck(token);
  if (!deck) notFound();

  const admin = createAdminClient();
  const { data: slidesRaw } = await admin
    .from("canvas_deck_slide")
    .select("id, position, title")
    .eq("deck_id", deck.id)
    .order("position", { ascending: true });

  const slides: PublicSlide[] = (slidesRaw ?? []).map((s) => ({
    id: s.id as string,
    position: s.position as number,
    title: (s.title as string) ?? "",
  }));

  return (
    <PublicDeckViewer
      token={token}
      title={deck.title}
      slides={slides}
      commentsEnabled={deck.public_comments_enabled === true}
    />
  );
}

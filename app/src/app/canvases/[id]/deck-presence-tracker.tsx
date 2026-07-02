"use client";

import { useEffect } from "react";
import { displayName } from "@/lib/utils";
import { usePresenceControls } from "@/app/canvases/presence-provider";

// Declares the active deck + current user to the PresenceProvider (mounted in
// the /canvases layout). Mounting this inside the deck route is what makes the
// provider join the deck's Realtime Presence channel and track the user; the
// topbar's PresenceStack then shows everyone here. Unmounting (navigating away)
// clears it, so presence is scoped to having a deck open.
//
// Renders nothing — it's a pure side-effect bridge. Lives in the deck route so
// it's only active when a deck is open; it reads the same currentUser* values
// page.tsx already resolves for the editor.
export function DeckPresenceTracker({
  deckId,
  userId,
  userName,
  userEmail,
}: {
  deckId: string;
  userId: string | null;
  userName: string | null;
  userEmail: string | null;
}) {
  const setActiveDeck = usePresenceControls();

  useEffect(() => {
    // Without an authenticated user we can't identify a presence — leave the
    // roster untouched (an anonymous viewer shouldn't appear as a collaborator).
    if (!userId) {
      setActiveDeck(null, null);
      return;
    }
    const name = displayName({ email: userEmail ?? "", name: userName });
    setActiveDeck(deckId, {
      id: userId,
      name,
      email: userEmail ?? "",
    });
    return () => setActiveDeck(null, null);
  }, [deckId, userId, userName, userEmail, setActiveDeck]);

  return null;
}

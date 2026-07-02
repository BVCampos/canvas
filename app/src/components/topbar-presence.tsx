"use client";

import { PresenceStack } from "@/components/presence-stack";
import { usePresences } from "@/app/canvases/presence-provider";

// Client bridge between the (Server Component) topbar and the presence context.
// The topbar can't call the usePresences hook directly, so it renders this thin
// wrapper, which reads the live roster from PresenceProvider and feeds the
// already-built PresenceStack. Outside a deck (or outside the provider) the
// roster is empty and the stack renders its positioned-but-empty slot.
export function TopbarPresence() {
  const presences = usePresences();
  return <PresenceStack presences={presences} />;
}

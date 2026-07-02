"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { createClient } from "@/lib/supabase/client";
import type { Presence } from "@/components/presence-stack";

// Live presence for the active deck, exposed via React context.
//
// Why a context that lives in the /canvases LAYOUT, above both the topbar and
// the deck route: the topbar (where the PresenceStack renders) is workspace-
// scoped and sits ABOVE the per-deck route, but presence is per-deck. React
// context only flows down, so the holder of the roster has to wrap both. The
// deck route (which knows the deck id + the current user) calls
// `setActiveDeck` from inside the tree; the provider then joins a single
// Supabase Realtime Presence channel keyed on that deck and tracks the user.
// The topbar reads the resulting roster. Outside a deck there is no active
// deck, so the roster is empty and the topbar's stack renders nothing.
//
// Transient only: presence is Realtime channel state (channel.track), never a
// DB write — no migration, nothing to clean up. Leaving the deck (unmount or a
// new deck) untracks and removes the channel.

// The identity the deck route hands us for the current user. We track this on
// the channel so other clients see who's here.
export type PresenceSelf = {
  id: string;
  name: string;
  email: string;
};

type PresenceContextValue = {
  // The live roster for the active deck (everyone tracked on the channel,
  // including the current user). Empty outside a deck.
  presences: Presence[];
  // Called by the deck route to declare which deck is active and who I am.
  // Passing null clears presence (e.g. on unmount / leaving the deck).
  setActiveDeck: (deckId: string | null, self: PresenceSelf | null) => void;
};

const PresenceContext = createContext<PresenceContextValue | null>(null);

// The shape Supabase Presence stores per tracked client. We track one of these
// per join; presenceState() returns them grouped by presence key.
type TrackedMeta = {
  id: string;
  name: string;
  email: string;
  // MCP-agent presence would set this; human web clients leave it false.
  isAgent?: boolean;
};

export function PresenceProvider({ children }: { children: React.ReactNode }) {
  const [presences, setPresences] = useState<Presence[]>([]);
  // The active deck + self identity, updated by the deck route. Held in state
  // so a change re-runs the subscription effect.
  const [active, setActive] = useState<{
    deckId: string;
    self: PresenceSelf;
  } | null>(null);

  // Stable setter for consumers — identity changes shouldn't re-render the
  // whole tree, so memoize it and compare in the updater before updating.
  const setActiveDeck = useCallback(
    (deckId: string | null, self: PresenceSelf | null) => {
      setActive((prev) => {
        if (!deckId || !self) {
          return prev === null ? prev : null;
        }
        if (
          prev &&
          prev.deckId === deckId &&
          prev.self.id === self.id &&
          prev.self.name === self.name &&
          prev.self.email === self.email
        ) {
          return prev; // no-op — don't thrash the subscription
        }
        return { deckId, self };
      });
    },
    [],
  );

  useEffect(() => {
    // No active deck: nothing to subscribe to. The roster is already empty —
    // it was either never set, or the previous effect's cleanup cleared it on
    // the transition to null — so there's no state write to make here.
    if (!active) return;
    const supabase = createClient();
    const { deckId, self } = active;

    // Presence key = the user id, so multiple tabs from one user collapse to a
    // single avatar (Supabase groups state by key). One channel per deck.
    const channel = supabase.channel(`deck-presence:${deckId}`, {
      config: { presence: { key: self.id } },
    });

    const syncRoster = () => {
      const state = channel.presenceState<TrackedMeta>();
      // Flatten the grouped state to one entry per presence key (first meta
      // wins — all a user's tabs carry the same identity).
      const roster: Presence[] = [];
      const seen = new Set<string>();
      for (const metas of Object.values(state)) {
        const meta = metas[0];
        if (!meta || seen.has(meta.id)) continue;
        seen.add(meta.id);
        roster.push({
          id: meta.id,
          name: meta.name,
          email: meta.email,
          isAgent: meta.isAgent,
        });
      }
      // Stable order so the avatar stack doesn't reshuffle on every sync:
      // current user first, then the rest alphabetically.
      roster.sort((a, b) => {
        if (a.id === self.id) return -1;
        if (b.id === self.id) return 1;
        return (a.name || a.email).localeCompare(b.name || b.email);
      });
      setPresences(roster);
    };

    channel
      .on("presence", { event: "sync" }, syncRoster)
      .on("presence", { event: "join" }, syncRoster)
      .on("presence", { event: "leave" }, syncRoster)
      .subscribe((status) => {
        if (status === "SUBSCRIBED") {
          void channel.track({
            id: self.id,
            name: self.name,
            email: self.email,
          } satisfies TrackedMeta);
        }
      });

    return () => {
      // untrack is implicit on removeChannel, which also fires leave for peers.
      setPresences([]);
      supabase.removeChannel(channel);
    };
  }, [active]);

  const value = useMemo<PresenceContextValue>(
    () => ({ presences, setActiveDeck }),
    [presences, setActiveDeck],
  );

  return (
    <PresenceContext.Provider value={value}>
      {children}
    </PresenceContext.Provider>
  );
}

// Read the live roster (topbar). Returns an empty array when no provider is
// mounted, so the global topbar keeps working on non-/canvases pages.
export function usePresences(): Presence[] {
  return useContext(PresenceContext)?.presences ?? [];
}

// Imperative handle for the deck route to declare the active deck + self.
// Returns a stable no-op outside the provider.
export function usePresenceControls(): PresenceContextValue["setActiveDeck"] {
  const ctx = useContext(PresenceContext);
  return ctx?.setActiveDeck ?? noop;
}

function noop() {}

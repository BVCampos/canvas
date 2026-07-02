"use client";

import { avatarGradient, AVATAR_INNER_RING } from "@/lib/avatar";
import { initials } from "@/lib/utils";
import { cn } from "@/lib/utils";

export type Presence = {
  id: string;
  name: string;
  email: string;
  // An MCP agent may participate in deck editing as a first-class actor.
  // Tagged separately so we can color the ring copper (AI presence) rather
  // than blue (human collaboration).
  isAgent?: boolean;
};

// Max avatars shown stacked before collapsing into a "+N" chip. Four keeps
// the topbar compact while still implying multiplayer at a glance.
const MAX_VISIBLE = 4;

export function PresenceStack({ presences }: { presences: Presence[] }) {
  // Render an empty-but-positioned slot so the topbar layout doesn't reflow
  // when presence comes and goes. The slot's min-width matches roughly one
  // avatar so collaborators appearing first don't shift other elements.
  if (presences.length === 0) {
    return <div className="min-w-6" aria-hidden />;
  }

  const visible = presences.slice(0, MAX_VISIBLE);
  const overflow = presences.length - visible.length;

  return (
    <div
      className="flex items-center"
      role="group"
      aria-label={`${presences.length} active`}
    >
      {visible.map((presence, index) => (
        <PresenceAvatar
          key={presence.id}
          presence={presence}
          // Leftmost on top: stack reads left-to-right with the most recent
          // / current actor in front.
          zIndex={visible.length - index}
          // First avatar has no negative margin; subsequent ones overlap by
          // ~8px to produce the classic stacked look.
          offset={index === 0 ? 0 : -8}
        />
      ))}
      {overflow > 0 && (
        <div
          className="ml-1 flex h-6 items-center justify-center rounded-full border border-border bg-paper px-1.5 text-[10px] font-semibold text-steel"
          title={`${overflow} more`}
          aria-label={`${overflow} more`}
        >
          +{overflow}
        </div>
      )}
    </div>
  );
}

function PresenceAvatar({
  presence,
  zIndex,
  offset,
}: {
  presence: Presence;
  zIndex: number;
  offset: number;
}) {
  const title = presence.isAgent ? "Agent (MCP session)" : presence.name;
  const ringColor = presence.isAgent
    ? "var(--accent-warm)"
    : "var(--accent)";
  // An agent is a different kind of entity, not a person — keep it visually
  // distinct with a solid copper fill rather than a per-identity gradient.
  const background = presence.isAgent
    ? "var(--accent-warm)"
    : avatarGradient(presence.email);

  return (
    <div
      className={cn(
        "relative flex h-6 w-6 items-center justify-center rounded-full text-[9px] font-semibold text-white",
      )}
      style={{
        marginLeft: offset,
        zIndex,
        background,
        boxShadow: `0 0 0 1.5px ${ringColor}, ${AVATAR_INNER_RING}`,
      }}
      title={title}
      aria-label={title}
    >
      {initials(presence.name || presence.email)}
    </div>
  );
}

import Link from "next/link";
import type { User } from "@supabase/supabase-js";
import { Logo } from "@/components/logo";
import { WorkspaceSwitcher } from "@/components/workspace-switcher";
import { UserMenu } from "@/components/user-menu";
import { TopbarPresence } from "@/components/topbar-presence";
import { NotificationBell } from "@/components/notification-bell";
import { createClient } from "@/lib/supabase/server";
import type { WorkspaceMembership, WorkspaceRole } from "@/lib/auth/workspace";
import { displayName, initials } from "@/lib/utils";
import { isMcpTokenExpired } from "@/lib/canvas/mcp-token";

export async function Topbar({
  user,
  workspace,
  workspaces,
  role,
}: {
  user: User;
  workspace: { id: string; name: string };
  workspaces: WorkspaceMembership[];
  // Active-workspace role. Guests (deck-scoped outside reviewers) get a pared-
  // down topbar — they can't mint MCP tokens, so we don't dangle the link.
  role: WorkspaceRole;
}) {
  const isGuest = role === "guest";
  const name = displayName({
    email: user.email ?? "",
    name:
      (user.user_metadata?.name as string | null | undefined) ??
      (user.user_metadata?.full_name as string | null | undefined) ??
      null,
  });

  // One server client for the two reads below — the MCP token check and the
  // unread-notification count.
  const supabase = await createClient();

  // Guests can't mint MCP tokens (RLS gates on is_workspace_member_full), and
  // the link is hidden for them below — so skip that lookup entirely.
  let agentConnected = false;
  let connectedClient: string | null = null;
  if (!isGuest) {
    const { data: activeTokens } = await supabase
      .from("canvas_mcp_token")
      .select("last_used_at, last_client_name, expires_at")
      .eq("user_id", user.id)
      .eq("workspace_id", workspace.id)
      .is("revoked_at", null)
      .order("last_used_at", { ascending: false, nullsFirst: false });
    const activeToken = activeTokens?.find(
      (token) => token.last_used_at && !isMcpTokenExpired(token.expires_at),
    );
    agentConnected = Boolean(activeToken?.last_used_at);
    connectedClient = activeToken?.last_client_name ?? null;
  }

  // Initial unread-notification count for the topbar bell. RLS scopes
  // canvas_notification to this user's own rows, so the head count is already
  // personal (no user_id filter needed, but the partial unread index keys on
  // user_id + read_at is null). The NotificationBell keeps it live thereafter.
  // Guests are full workspace members for mention purposes, so they get the
  // bell too.
  const { count: unreadCount } = await supabase
    .from("canvas_notification")
    .select("id", { count: "exact", head: true })
    .is("read_at", null);

  return (
    <header className="sticky top-0 z-10 flex h-14 items-center justify-between border-b border-border bg-background/75 px-3 backdrop-blur-md sm:px-6">
      {/*
       * Wrap the primary workspace navigation in a <nav aria-label> landmark
       * so screen-reader users get a discrete region rather than the items
       * landing inside the banner alone. The <header> itself already counts
       * as the banner landmark.
       */}
      <nav
        aria-label="Workspace"
        className="flex min-w-0 items-center gap-2 sm:gap-4"
      >
        <Link
          href="/canvases"
          className="flex items-center rounded-md outline-none transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        >
          <Logo />
        </Link>
        <WorkspaceSwitcher workspaces={workspaces} activeId={workspace.id} />
      </nav>

      {/*
       * Right-cluster landmark. The MCP setup link is real navigation, and
       * wrapping the surrounding presence stack + user-menu trigger in the
       * same <nav> keeps the right side of the topbar inside an addressable
       * region (parallel to the left "Workspace" landmark). The UserMenu's
       * internal role="menu" tree is a separate semantic that lives happily
       * inside a nav landmark.
       */}
      <nav aria-label="Account" className="flex items-center gap-3 text-sm sm:gap-5">
        {/*
          Notification bell — unread @mentions + replies (migration 0048).
          Server-rendered count, then kept live by the client subscription.
        */}
        <NotificationBell userId={user.id} initialUnread={unreadCount ?? 0} />
        {/*
          Presence stack — collaborators currently active on the open deck.
          Wired via PresenceProvider (mounted in `canvases/layout.tsx`, above
          both this topbar and the deck route): the deck route tracks the user
          on a per-deck Supabase Realtime Presence channel, and TopbarPresence
          reads the live roster from that context. Empty outside a deck, so the
          slot stays positioned-but-blank on the list / settings pages.
        */}
        <TopbarPresence />
        {!isGuest &&
          // The emphasis inverts on connection state: until an agent has
          // connected, this is the single most important action for a new
          // user, so it reads as an accent pill; once connected it relaxes
          // to a quiet link with a green dot. Hidden below sm either way —
          // the same destination lives in the UserMenu dropdown.
          (agentConnected ? (
            <Link
              href="/settings/mcp"
              className="hidden items-center gap-1.5 text-muted-foreground transition-colors hover:text-foreground sm:flex"
              title={`${connectedClient || "Agent"} connected`}
            >
              <span
                className="h-1.5 w-1.5 rounded-full bg-success"
                aria-hidden
              />
              Connections
            </Link>
          ) : (
            <Link
              href="/settings/mcp"
              className="hidden items-center gap-1.5 rounded-full bg-[color:var(--accent)] px-3 py-1.5 text-xs font-medium text-white transition-opacity hover:opacity-90 sm:inline-flex"
              title="No agent has connected yet — set one up"
            >
              Connect your agent
            </Link>
          ))}
        <UserMenu
          name={name}
          email={user.email ?? ""}
          initials={initials(name)}
        />
      </nav>
    </header>
  );
}

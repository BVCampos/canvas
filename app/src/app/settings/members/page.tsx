import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { getActiveWorkspace } from "@/lib/auth/workspace";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { InviteForm } from "./invite-form";
import { InvitesList } from "./invites-list";
import { MembersList } from "./members-list";

// /settings/members — owner/admin only.
// Members + invites are scoped to the active workspace via RLS on
// workspace_memberships / workspace_invites. The panel's shape was originally
// mirrored from 21x-workforce-management (where the workspace concept came
// from); after the standalone split (ADR-0004) Canvas owns its own copies of
// those tables. Canvas v0 has no /w/{slug}/ prefix; we resolve the active
// workspace from the user's first membership (see getActiveWorkspace).

export default async function MembersSettingsPage() {
  const { user, workspace, role } = await getActiveWorkspace("/settings/members");
  if (role !== "owner" && role !== "admin") {
    // Bouncing to notFound rather than redirecting keeps the URL stable for
    // the back button if they re-acquire admin later.
    notFound();
  }

  const supabase = await createClient();
  const admin = createAdminClient();

  // Workspace-level invites only (deck_id is null). Deck-scoped guest invites
  // are managed from each deck's Share dialog — surfacing them here would
  // clutter the roster with bare "guest" rows an admin has no deck context for
  // and let them revoke a deck editor's reviewer from the wrong place.
  const invitesPromise = supabase
    .from("workspace_invites")
    .select("id, email, role, token, expires_at, accepted_at")
    .is("accepted_at", null)
    .is("deck_id", null)
    .eq("workspace_id", workspace.id)
    .order("created_at", { ascending: false });

  // Member list goes through the admin client to get the joined user data —
  // RLS on public.users would otherwise hide rows that aren't yet visible
  // to the actor.
  const membersPromise = admin
    .from("workspace_memberships")
    .select(
      "id, role, joined_at, user_id, user:users!user_id(id, name, email, avatar_url)",
    )
    .eq("workspace_id", workspace.id)
    .order("joined_at", { ascending: true });

  const [invitesRes, membersRes] = await Promise.all([
    invitesPromise,
    membersPromise,
  ]);

  const invites = invitesRes.data ?? [];
  type RawMember = {
    id: string;
    role: string;
    joined_at: string;
    user_id: string;
    user: { id: string; name: string | null; email: string; avatar_url: string | null } | null;
  };
  const memberRows = (membersRes.data ?? []) as unknown as RawMember[];
  const members = memberRows.flatMap((m) =>
    m.user
      ? [
          {
            membership_id: m.id,
            user_id: m.user.id,
            email: m.user.email,
            name: m.user.name,
            avatar_url: m.user.avatar_url,
            role: m.role,
            joined_at: m.joined_at,
            is_self: m.user.id === user.id,
          },
        ]
      : [],
  );

  // For each guest, list the deck(s) they can actually reach (their explicit
  // canvas_deck_member grants) so an admin can audit per-deck access from the
  // roster instead of opening every deck's Share dialog one by one.
  const guestUserIds = members
    .filter((m) => m.role === "guest")
    .map((m) => m.user_id);
  const guestDecks: Record<string, { title: string; role: string }[]> = {};
  if (guestUserIds.length > 0) {
    const { data: deckRows } = await admin
      .from("canvas_deck_member")
      .select("user_id, role, deck:canvas_deck(title)")
      .eq("workspace_id", workspace.id)
      .in("user_id", guestUserIds);
    for (const row of deckRows ?? []) {
      const uid = row.user_id as string;
      const deckRel = row.deck as
        | { title: string }
        | { title: string }[]
        | null;
      const title = Array.isArray(deckRel) ? deckRel[0]?.title : deckRel?.title;
      if (!title) continue;
      (guestDecks[uid] ??= []).push({ title, role: row.role as string });
    }
  }

  // Used by InvitesList to render copy-link buttons that point at this app's
  // own /invite/{token} route. Computed server-side so it works in dev,
  // preview, and prod without hardcoding.
  const reqHeaders = await headers();
  const host = reqHeaders.get("host") ?? "canvas.21xventures.com";
  const proto =
    reqHeaders.get("x-forwarded-proto") ??
    (host.startsWith("localhost") ? "http" : "https");
  const appBaseUrl = `${proto}://${host}`;

  return (
    <>
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Members</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Who can sign in to{" "}
          <strong className="font-medium text-foreground">{workspace.name}</strong>{" "}
          on Canvas. Members can view and edit every workspace-visible deck;
          Admins also manage members and private decks. Invites go out by email —
          the invitee signs in with that address (Google or a one-time email
          link), then clicks Join Workspace. To give someone access to just one
          deck, use <strong className="font-medium text-foreground">Share</strong>{" "}
          on that deck instead.
        </p>
      </div>

      <section className="rounded-[12px] border border-border bg-card p-6 space-y-4">
        <div className="eyebrow">Invite someone</div>
        <InviteForm canInviteOwner={role === "owner"} />
      </section>

      <section className="rounded-[12px] border border-border bg-card p-6 space-y-4">
        <div className="eyebrow">Pending invites</div>
        <InvitesList invites={invites} appBaseUrl={appBaseUrl} />
      </section>

      <section className="rounded-[12px] border border-border bg-card p-6 space-y-4">
        <div className="eyebrow">Workspace members</div>
        <MembersList members={members} actorRole={role} guestDecks={guestDecks} />
      </section>
    </>
  );
}

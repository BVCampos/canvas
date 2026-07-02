"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

// The result of attempting to accept an invite. The `kind: "error"` branch
// is rendered inline on the invite page; `kind: "ok"` triggers a redirect
// to the workspace's first deck list.
export type AcceptResult =
  | { kind: "ok"; redirectTo: string }
  | { kind: "error"; message: string };

// Capability ordering used to reconcile roles on accept: a re-invite may only
// RAISE someone's access, never lower it. Higher number = more access.
const ROLE_RANK: Record<string, number> = {
  guest: 0,
  member: 1,
  admin: 2,
  owner: 3,
};
const DECK_ROLE_RANK: Record<string, number> = { viewer: 0, editor: 1 };

export async function acceptInvite(token: string): Promise<AcceptResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user || !user.email) {
    return {
      kind: "error",
      message: "You must be signed in to accept an invite.",
    };
  }

  // Admin client because the visitor isn't yet a member of the workspace —
  // RLS would otherwise hide the invite row from them.
  const admin = createAdminClient();
  const { data: invite, error: inviteErr } = await admin
    .from("workspace_invites")
    .select(
      "id, workspace_id, email, role, expires_at, accepted_at, deck_id, deck_role, project_id, project_role, invited_by",
    )
    .eq("token", token)
    .maybeSingle();

  if (inviteErr || !invite) {
    return { kind: "error", message: "This invite does not exist or has been revoked." };
  }
  if (invite.accepted_at) {
    return { kind: "error", message: "This invite has already been used." };
  }
  if (new Date(invite.expires_at) < new Date()) {
    return { kind: "error", message: "This invite has expired. Ask for a new one." };
  }
  if (invite.email.trim().toLowerCase() !== user.email.trim().toLowerCase()) {
    return {
      kind: "error",
      message: `This invite is for ${invite.email}. Sign in with that email to accept.`,
    };
  }

  // Reconcile the workspace role ESCALATE-ONLY. A re-invite may RAISE access
  // (a deck-scoped guest later invited as a full member) but must never
  // silently DOWNGRADE it — an existing member/admin who accepts a guest or
  // member invite keeps their higher role, and the domain-auto-join trigger's
  // 'member' row is preserved. We first ensure a row exists (ignoreDuplicates,
  // so a concurrent auto-join row wins), then read the effective role and only
  // UPDATE upward. The old code used a blanket ignoreDuplicates upsert, which
  // made a guest→member re-invite a silent no-op (invite burned, role
  // unchanged) — the classic "I accepted but still can't see anything" loop.
  const { error: memErr } = await admin.from("workspace_memberships").upsert(
    {
      workspace_id: invite.workspace_id,
      user_id: user.id,
      role: invite.role,
    },
    { onConflict: "workspace_id,user_id", ignoreDuplicates: true },
  );
  if (memErr) {
    console.error("[acceptInvite] membership upsert", memErr);
    return {
      kind: "error",
      message: "Could not add you to the workspace. Ask for a fresh invite.",
    };
  }

  const { data: membershipRow } = await admin
    .from("workspace_memberships")
    .select("role")
    .eq("workspace_id", invite.workspace_id)
    .eq("user_id", user.id)
    .maybeSingle();
  const currentRole = (membershipRow?.role as string) ?? invite.role;
  if ((ROLE_RANK[invite.role] ?? 0) > (ROLE_RANK[currentRole] ?? 0)) {
    const { error: roleErr } = await admin
      .from("workspace_memberships")
      .update({ role: invite.role })
      .eq("workspace_id", invite.workspace_id)
      .eq("user_id", user.id);
    if (roleErr) {
      console.error("[acceptInvite] role escalate", roleErr);
      return {
        kind: "error",
        message: "Could not finish setting up your workspace access. Try again.",
      };
    }
  }

  // Deck-scoped invite (an outside reviewer): also grant the explicit
  // canvas_deck_member row, which is the ONLY thing that gives a guest access
  // to anything. Same escalate-only merge so re-inviting a viewer as an editor
  // actually bumps them to editor (a blanket ignoreDuplicates kept them a
  // viewer).
  if (invite.deck_id && invite.deck_role) {
    const { error: dmErr } = await admin.from("canvas_deck_member").upsert(
      {
        deck_id: invite.deck_id,
        user_id: user.id,
        workspace_id: invite.workspace_id,
        role: invite.deck_role,
        invited_by: invite.invited_by,
      },
      { onConflict: "deck_id,user_id", ignoreDuplicates: true },
    );
    if (dmErr) {
      console.error("[acceptInvite] deck member upsert", dmErr);
      return {
        kind: "error",
        message: "This deck is no longer available. Ask for a new link.",
      };
    }

    const { data: deckMemberRow } = await admin
      .from("canvas_deck_member")
      .select("role")
      .eq("deck_id", invite.deck_id)
      .eq("user_id", user.id)
      .maybeSingle();
    const currentDeckRole =
      (deckMemberRow?.role as string) ?? invite.deck_role;
    if ((DECK_ROLE_RANK[invite.deck_role] ?? 0) > (DECK_ROLE_RANK[currentDeckRole] ?? 0)) {
      const { error: deckRoleErr } = await admin
        .from("canvas_deck_member")
        .update({ role: invite.deck_role })
        .eq("deck_id", invite.deck_id)
        .eq("user_id", user.id);
      if (deckRoleErr) {
        console.error("[acceptInvite] deck role escalate", deckRoleErr);
        return {
          kind: "error",
          message: "Could not finish setting up your deck access. Try again.",
        };
      }
    }
  }

  // Project-scoped invite (an outside reviewer invited to a whole project):
  // grant the explicit canvas_project_member row — the ONLY thing that gives a
  // guest access — which (per migration 0046) cascades to every deck in the
  // project. Same escalate-only merge as the deck branch; viewer/editor share
  // the DECK_ROLE_RANK ordering.
  if (invite.project_id && invite.project_role) {
    const { error: pmErr } = await admin.from("canvas_project_member").upsert(
      {
        project_id: invite.project_id,
        user_id: user.id,
        workspace_id: invite.workspace_id,
        role: invite.project_role,
        invited_by: invite.invited_by,
      },
      { onConflict: "project_id,user_id", ignoreDuplicates: true },
    );
    if (pmErr) {
      console.error("[acceptInvite] project member upsert", pmErr);
      return {
        kind: "error",
        message: "This project is no longer available. Ask for a new link.",
      };
    }

    const { data: projectMemberRow } = await admin
      .from("canvas_project_member")
      .select("role")
      .eq("project_id", invite.project_id)
      .eq("user_id", user.id)
      .maybeSingle();
    const currentProjectRole =
      (projectMemberRow?.role as string) ?? invite.project_role;
    if ((DECK_ROLE_RANK[invite.project_role] ?? 0) > (DECK_ROLE_RANK[currentProjectRole] ?? 0)) {
      const { error: projectRoleErr } = await admin
        .from("canvas_project_member")
        .update({ role: invite.project_role })
        .eq("project_id", invite.project_id)
        .eq("user_id", user.id);
      if (projectRoleErr) {
        console.error("[acceptInvite] project role escalate", projectRoleErr);
        return {
          kind: "error",
          message: "Could not finish setting up your project access. Try again.",
        };
      }
    }
  }

  const { error: updErr } = await admin
    .from("workspace_invites")
    .update({ accepted_at: new Date().toISOString() })
    .eq("id", invite.id);
  if (updErr) {
    // Membership is in place — log and keep moving. Worst case: the invite
    // stays visible in the pending list until manually revoked.
    console.error("invite.accepted_at update failed", updErr);
  }

  // Deck-scoped guests land directly on the deck they were invited to (it's the
  // only thing they can see). Project-scoped guests and full members go to the
  // deck list — the project group (and its decks) renders there. /canvases
  // resolves the active workspace from membership order (Canvas v0 has no
  // /w/{slug}/).
  return {
    kind: "ok",
    redirectTo: invite.deck_id ? `/canvases/${invite.deck_id}` : "/canvases",
  };
}

export async function acceptInviteAndRedirect(token: string) {
  const result = await acceptInvite(token);
  if (result.kind === "ok") {
    redirect(result.redirectTo);
  }
  redirect(`/invite/${token}?error=${encodeURIComponent(result.message)}`);
}

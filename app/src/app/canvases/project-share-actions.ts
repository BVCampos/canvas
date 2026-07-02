"use server";

import { revalidatePath } from "next/cache";
import { randomBytes } from "crypto";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendInviteLink, resolveAppBaseUrl } from "@/lib/auth/invite-email";
import { logUsage } from "@/lib/usage/log";
import type { ActionResult } from "./[id]/actions";

// Server actions for PROJECT-level sharing — the mirror of the deck Share
// dialog actions in [id]/actions.ts, retargeted at canvas_project*. Sharing a
// project reaches every deck in it (the cascade lives in canvas_can_read_deck /
// canvas_can_edit_deck, migration 0046); these actions only manage the project's
// own visibility, members, guest invites, and public link. Every mutation runs
// through the caller's RLS-aware client (the 0046 policies are the real gate),
// then revalidates /canvases so the grouped list re-renders.

export type ProjectVisibility = "workspace" | "private";
export type ProjectMemberRole = "viewer" | "editor";

export type ProjectShareCandidate = {
  user_id: string;
  email: string | null;
  name: string | null;
  workspace_role: "owner" | "admin" | "member" | string;
  // Present when the user is already on the project; null when they're just a
  // workspace member available to add.
  project_role: ProjectMemberRole | null;
};

// A pending invite for an outside reviewer (workspace_role 'guest') scoped to
// this project. Surfaced under "People with access" as not-yet-accepted.
export type ProjectGuestInvite = {
  id: string;
  email: string;
  project_role: ProjectMemberRole;
};

export type ProjectShareState =
  | {
      ok: true;
      visibility: ProjectVisibility;
      candidates: ProjectShareCandidate[];
      guestInvites: ProjectGuestInvite[];
      // True when the viewer can edit the project — gates the manage-only
      // affordances (inviting/revoking outside reviewers). RLS still enforces.
      canManage: boolean;
      // Public "anyone with the link can view" state for the whole project.
      publicShareEnabled: boolean;
      publicShareUrl: string | null;
      // Stricter than canManage: only full workspace members with edit access
      // (never a guest) can manage the public link.
      canManagePublicShare: boolean;
    }
  | { ok: false; error: string };

export type ProjectPublicShareResult =
  | { ok: true; enabled: boolean; url: string | null }
  | { ok: false; error: string };

export type ProjectGuestInviteResult =
  | { ok: true; warning?: string }
  | { ok: false; error: string };

const GUEST_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Server-minted, unguessable view-only capability — same shape as the deck
// token (24 random bytes -> 32 url-safe chars, 192 bits; migration 0046).
function newPublicShareToken(): string {
  return randomBytes(24).toString("base64url");
}

function publicShareUrlFor(baseUrl: string, token: string): string {
  return `${baseUrl}/p/project/${token}`;
}

// Who may turn a project's public link on/off/rotate. A guest can hold an
// editor seat (which passes canvas_can_edit_project), but making the project
// world-readable is a broader act — require BOTH project-edit rights AND a FULL
// workspace membership, which excludes guests. Mirrors callerCanManagePublicShare.
async function callerCanManageProjectPublicShare(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
  projectId: string,
  workspaceId: string,
): Promise<boolean> {
  const { data: canEdit } = await supabase.rpc("canvas_can_edit_project", {
    _project_id: projectId,
  });
  if (canEdit !== true) return false;
  const { data: membership } = await supabase
    .from("workspace_memberships")
    .select("role")
    .eq("user_id", userId)
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  const role = membership?.role;
  return role === "owner" || role === "admin" || role === "member";
}

export async function getProjectShareState(
  projectId: string,
): Promise<ProjectShareState> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "not_authenticated" };

  const { data: project, error: projErr } = await supabase
    .from("canvas_project")
    .select("id, workspace_id, visibility, public_share_token")
    .eq("id", projectId)
    .maybeSingle();
  if (projErr) {
    console.error("[getProjectShareState] project", projErr);
    return { ok: false, error: projErr.message };
  }
  if (!project) return { ok: false, error: "project_not_found" };

  const { data: memberships, error: memErr } = await supabase
    .from("workspace_memberships")
    .select("user_id, role")
    .eq("workspace_id", project.workspace_id);
  if (memErr) {
    console.error("[getProjectShareState] memberships", memErr);
    return { ok: false, error: memErr.message };
  }

  const userIds = (memberships ?? []).map((m) => m.user_id);
  const profiles =
    userIds.length > 0
      ? (await supabase.from("users").select("id, email, name").in("id", userIds)).data ?? []
      : [];
  const profileById = new Map(
    profiles.map((p) => [
      p.id,
      { email: p.email as string | null, name: (p.name as string | null) ?? null },
    ]),
  );

  const { data: projectMembers, error: pmErr } = await supabase
    .from("canvas_project_member")
    .select("user_id, role")
    .eq("project_id", projectId);
  if (pmErr) {
    console.error("[getProjectShareState] project members", pmErr);
    return { ok: false, error: pmErr.message };
  }
  const projectRoleById = new Map<string, ProjectMemberRole>(
    (projectMembers ?? []).map((m) => [m.user_id as string, m.role as ProjectMemberRole]),
  );

  const candidates: ProjectShareCandidate[] = (memberships ?? [])
    .map((m) => {
      const profile = profileById.get(m.user_id);
      return {
        user_id: m.user_id as string,
        email: profile?.email ?? null,
        name: profile?.name ?? null,
        workspace_role: m.role as string,
        project_role: projectRoleById.get(m.user_id as string) ?? null,
      };
    })
    // Outside reviewers (workspace_role 'guest') are scoped — only keep one if
    // they're already on THIS project (so they show under "People with access").
    .filter((c) => c.workspace_role !== "guest" || c.project_role != null);

  const roleWeight: Record<string, number> = { editor: 0, viewer: 1 };
  candidates.sort((a, b) => {
    const ar = a.project_role ? roleWeight[a.project_role] : 2;
    const br = b.project_role ? roleWeight[b.project_role] : 2;
    if (ar !== br) return ar - br;
    const an = (a.name || a.email || "").toLowerCase();
    const bn = (b.name || b.email || "").toLowerCase();
    return an.localeCompare(bn);
  });

  // Pending guest invites for this project — only meaningful to someone who can
  // edit it. Read via the admin client (workspace_invites SELECT is admin-only),
  // but a project editor who isn't a workspace admin still manages their own.
  let guestInvites: ProjectGuestInvite[] = [];
  const { data: canEdit } = await supabase.rpc("canvas_can_edit_project", {
    _project_id: projectId,
  });
  if (canEdit === true) {
    const admin = createAdminClient();
    const { data: invites, error: invErr } = await admin
      .from("workspace_invites")
      .select("id, email, project_role")
      .eq("project_id", projectId)
      .is("accepted_at", null);
    if (invErr) {
      console.error("[getProjectShareState] guest invites", invErr);
    }
    guestInvites = (invites ?? []).map((i) => ({
      id: i.id as string,
      email: i.email as string,
      project_role: (i.project_role as ProjectMemberRole) ?? "viewer",
    }));
  }

  const publicToken = (project.public_share_token as string | null) ?? null;
  const canManagePublicShare = await callerCanManageProjectPublicShare(
    supabase,
    user.id,
    projectId,
    project.workspace_id as string,
  );
  let publicShareUrl: string | null = null;
  if (publicToken && canManagePublicShare) {
    publicShareUrl = publicShareUrlFor(await resolveAppBaseUrl(), publicToken);
  }

  return {
    ok: true,
    visibility: (project.visibility as ProjectVisibility) ?? "workspace",
    candidates,
    guestInvites,
    canManage: canEdit === true,
    publicShareEnabled: publicToken != null,
    publicShareUrl,
    canManagePublicShare,
  };
}

export async function setProjectVisibility(
  projectId: string,
  visibility: ProjectVisibility,
): Promise<ActionResult> {
  if (visibility !== "workspace" && visibility !== "private") {
    return { ok: false, error: "invalid_visibility" };
  }
  const started = Date.now();
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "not_authenticated" };

  const { data: project } = await supabase
    .from("canvas_project")
    .select("workspace_id")
    .eq("id", projectId)
    .maybeSingle();
  const workspace_id = project?.workspace_id ?? null;

  const { data: updated, error } = await supabase
    .from("canvas_project")
    .update({ visibility })
    .eq("id", projectId)
    .select("id");

  if (error) {
    console.error("[setProjectVisibility]", error);
    return { ok: false, error: error.message };
  }
  if (!updated || updated.length === 0) {
    logUsage({
      event: "project.set_visibility",
      surface: "action",
      user_id: user.id,
      workspace_id,
      status: "denied",
      duration_ms: Date.now() - started,
      error_code: "not_authorized",
      props: { project_id: projectId, visibility },
    });
    return { ok: false, error: "not_authorized" };
  }

  logUsage({
    event: "project.set_visibility",
    surface: "action",
    user_id: user.id,
    workspace_id,
    status: "ok",
    duration_ms: Date.now() - started,
    props: { project_id: projectId, visibility },
  });

  revalidatePath("/canvases");
  return { ok: true };
}

// Enable/disable the project's public "anyone with the link can view" share.
// Enabling reuses an existing token (stable link) or mints one; disabling nulls
// it (every shared URL 404s next request). Mirrors setDeckPublicShare.
export async function setProjectPublicShare(
  projectId: string,
  enabled: boolean,
): Promise<ProjectPublicShareResult> {
  const started = Date.now();
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "not_authenticated" };

  const { data: project } = await supabase
    .from("canvas_project")
    .select("workspace_id, public_share_token")
    .eq("id", projectId)
    .maybeSingle();
  if (!project?.workspace_id) return { ok: false, error: "project_not_found" };
  const workspace_id = project.workspace_id as string;

  const canManage = await callerCanManageProjectPublicShare(
    supabase,
    user.id,
    projectId,
    workspace_id,
  );
  if (!canManage) {
    logUsage({
      event: "project.public_share",
      surface: "action",
      user_id: user.id,
      workspace_id,
      status: "denied",
      duration_ms: Date.now() - started,
      error_code: "not_authorized",
      props: { project_id: projectId, enabled },
    });
    return {
      ok: false,
      error: "Only workspace members with edit access can change the public link.",
    };
  }

  if (!enabled) {
    const { data: updated, error } = await supabase
      .from("canvas_project")
      .update({ public_share_token: null })
      .eq("id", projectId)
      .select("id");
    if (error) {
      console.error("[setProjectPublicShare] disable", error);
      return { ok: false, error: error.message };
    }
    if (!updated || updated.length === 0) {
      return { ok: false, error: "not_authorized" };
    }
    logUsage({
      event: "project.public_share",
      surface: "action",
      user_id: user.id,
      workspace_id,
      status: "ok",
      duration_ms: Date.now() - started,
      props: { project_id: projectId, enabled: false },
    });
    revalidatePath("/canvases");
    return { ok: true, enabled: false, url: null };
  }

  const existing = (project.public_share_token as string | null) ?? null;
  const token = existing ?? newPublicShareToken();
  if (!existing) {
    const { data: updated, error } = await supabase
      .from("canvas_project")
      .update({ public_share_token: token })
      .eq("id", projectId)
      .select("id");
    if (error) {
      console.error("[setProjectPublicShare] enable", error);
      return { ok: false, error: error.message };
    }
    if (!updated || updated.length === 0) {
      return { ok: false, error: "not_authorized" };
    }
  }

  logUsage({
    event: "project.public_share",
    surface: "action",
    user_id: user.id,
    workspace_id,
    status: "ok",
    duration_ms: Date.now() - started,
    props: { project_id: projectId, enabled: true, reused: Boolean(existing) },
  });
  revalidatePath("/canvases");
  return {
    ok: true,
    enabled: true,
    url: publicShareUrlFor(await resolveAppBaseUrl(), token),
  };
}

// Rotate the public link: mint a fresh token, revoking the old URL. Mirrors
// rotateDeckPublicShareLink.
export async function rotateProjectPublicShareLink(
  projectId: string,
): Promise<ProjectPublicShareResult> {
  const started = Date.now();
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "not_authenticated" };

  const { data: project } = await supabase
    .from("canvas_project")
    .select("workspace_id")
    .eq("id", projectId)
    .maybeSingle();
  if (!project?.workspace_id) return { ok: false, error: "project_not_found" };
  const workspace_id = project.workspace_id as string;

  const canManage = await callerCanManageProjectPublicShare(
    supabase,
    user.id,
    projectId,
    workspace_id,
  );
  if (!canManage) {
    return {
      ok: false,
      error: "Only workspace members with edit access can reset the public link.",
    };
  }

  const token = newPublicShareToken();
  const { data: updated, error } = await supabase
    .from("canvas_project")
    .update({ public_share_token: token })
    .eq("id", projectId)
    .select("id");
  if (error) {
    console.error("[rotateProjectPublicShareLink]", error);
    return { ok: false, error: error.message };
  }
  if (!updated || updated.length === 0) {
    return { ok: false, error: "not_authorized" };
  }

  logUsage({
    event: "project.public_share_rotate",
    surface: "action",
    user_id: user.id,
    workspace_id,
    status: "ok",
    duration_ms: Date.now() - started,
    props: { project_id: projectId },
  });
  revalidatePath("/canvases");
  return {
    ok: true,
    enabled: true,
    url: publicShareUrlFor(await resolveAppBaseUrl(), token),
  };
}

export async function addProjectMember(
  projectId: string,
  userId: string,
  role: ProjectMemberRole,
): Promise<ActionResult> {
  if (role !== "viewer" && role !== "editor") {
    return { ok: false, error: "invalid_role" };
  }
  const started = Date.now();
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "not_authenticated" };

  const { data: project } = await supabase
    .from("canvas_project")
    .select("workspace_id")
    .eq("id", projectId)
    .maybeSingle();
  if (!project?.workspace_id) return { ok: false, error: "project_not_found" };

  const { data, error } = await supabase
    .from("canvas_project_member")
    .upsert(
      {
        project_id: projectId,
        user_id: userId,
        workspace_id: project.workspace_id,
        role,
        invited_by: user.id,
      },
      { onConflict: "project_id,user_id" },
    )
    .select("user_id");

  if (error) {
    console.error("[addProjectMember]", error);
    logUsage({
      event: "project.member.add",
      surface: "action",
      user_id: user.id,
      workspace_id: project.workspace_id,
      status: "error",
      duration_ms: Date.now() - started,
      error_code: error.code ?? "insert_error",
      props: { project_id: projectId, invited_user_id: userId, role },
    });
    return { ok: false, error: error.message };
  }
  if (!data || data.length === 0) {
    return { ok: false, error: "not_authorized" };
  }

  logUsage({
    event: "project.member.add",
    surface: "action",
    user_id: user.id,
    workspace_id: project.workspace_id,
    status: "ok",
    duration_ms: Date.now() - started,
    props: { project_id: projectId, invited_user_id: userId, role },
  });

  revalidatePath("/canvases");
  return { ok: true };
}

export async function updateProjectMemberRole(
  projectId: string,
  userId: string,
  role: ProjectMemberRole,
): Promise<ActionResult> {
  if (role !== "viewer" && role !== "editor") {
    return { ok: false, error: "invalid_role" };
  }
  const started = Date.now();
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "not_authenticated" };

  const { data: project } = await supabase
    .from("canvas_project")
    .select("workspace_id, created_by")
    .eq("id", projectId)
    .maybeSingle();
  const workspace_id = project?.workspace_id ?? null;

  // The creator's auto-added editor row keeps a private project reachable by
  // its author; block demoting them (and direct self-demotion).
  if (project?.created_by === userId && role !== "editor") {
    return { ok: false, error: "cannot_demote_creator" };
  }
  if (userId === user.id && role !== "editor") {
    return { ok: false, error: "cannot_demote_self" };
  }

  const { data: updated, error } = await supabase
    .from("canvas_project_member")
    .update({ role })
    .eq("project_id", projectId)
    .eq("user_id", userId)
    .select("user_id");

  if (error) {
    console.error("[updateProjectMemberRole]", error);
    logUsage({
      event: "project.member.update",
      surface: "action",
      user_id: user.id,
      workspace_id,
      status: "error",
      duration_ms: Date.now() - started,
      error_code: error.code ?? "update_error",
      props: { project_id: projectId, member_user_id: userId, role },
    });
    return { ok: false, error: error.message };
  }
  if (!updated || updated.length === 0) {
    return { ok: false, error: "not_authorized_or_not_found" };
  }

  logUsage({
    event: "project.member.update",
    surface: "action",
    user_id: user.id,
    workspace_id,
    status: "ok",
    duration_ms: Date.now() - started,
    props: { project_id: projectId, member_user_id: userId, role },
  });

  revalidatePath("/canvases");
  return { ok: true };
}

export async function removeProjectMember(
  projectId: string,
  userId: string,
): Promise<ActionResult> {
  const started = Date.now();
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "not_authenticated" };

  const { data: project } = await supabase
    .from("canvas_project")
    .select("workspace_id, created_by")
    .eq("id", projectId)
    .maybeSingle();
  const workspace_id = project?.workspace_id ?? null;

  // Guard against removing the creator — the load-bearing editor seat the
  // trigger auto-installs on a private project.
  if (project?.created_by === userId) {
    return { ok: false, error: "cannot_remove_creator" };
  }

  const { data: deleted, error } = await supabase
    .from("canvas_project_member")
    .delete()
    .eq("project_id", projectId)
    .eq("user_id", userId)
    .select("user_id");

  if (error) {
    console.error("[removeProjectMember]", error);
    logUsage({
      event: "project.member.remove",
      surface: "action",
      user_id: user.id,
      workspace_id,
      status: "error",
      duration_ms: Date.now() - started,
      error_code: error.code ?? "delete_error",
      props: { project_id: projectId, member_user_id: userId },
    });
    return { ok: false, error: error.message };
  }
  if (!deleted || deleted.length === 0) {
    return { ok: false, error: "not_authorized_or_not_found" };
  }

  logUsage({
    event: "project.member.remove",
    surface: "action",
    user_id: user.id,
    workspace_id,
    status: "ok",
    duration_ms: Date.now() - started,
    props: { project_id: projectId, member_user_id: userId },
  });

  revalidatePath("/canvases");
  return { ok: true };
}

// Invite an outside reviewer (no workspace account needed) to a whole project.
// They accept the emailed link, sign in, and land with a 'guest' workspace
// membership + a canvas_project_member row — which is the ONLY thing that grants
// a guest access. They reach every deck in the project, and nothing else.
export async function inviteGuestToProject(
  projectId: string,
  email: string,
  role: ProjectMemberRole,
): Promise<ProjectGuestInviteResult> {
  const started = Date.now();
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "not_authenticated" };

  const normEmail = email.trim().toLowerCase();
  if (!GUEST_EMAIL_RE.test(normEmail)) {
    return { ok: false, error: "Enter a valid email address." };
  }
  if (role !== "viewer" && role !== "editor") {
    return { ok: false, error: "Invalid role." };
  }

  const { data: project } = await supabase
    .from("canvas_project")
    .select("workspace_id")
    .eq("id", projectId)
    .maybeSingle();
  if (!project?.workspace_id) return { ok: false, error: "project_not_found" };

  const { data: canEdit } = await supabase.rpc("canvas_can_edit_project", {
    _project_id: projectId,
  });
  if (canEdit !== true) {
    logUsage({
      event: "project.guest_invite",
      surface: "action",
      user_id: user.id,
      workspace_id: project.workspace_id,
      status: "denied",
      duration_ms: Date.now() - started,
      error_code: "not_authorized",
      props: { project_id: projectId, role },
    });
    return {
      ok: false,
      error: "You need edit access to invite a reviewer to this project.",
    };
  }

  const admin = createAdminClient();

  // Guard: never let a project "guest" invite target an email on the
  // workspace's auto-join domain — the auth.users INSERT trigger would make
  // them a FULL workspace member on first sign-in, silently widening "this
  // project" into "every workspace deck". Internal teammates belong in
  // Settings → Members.
  const emailDomain = normEmail.split("@")[1] ?? "";
  if (emailDomain) {
    const { data: allowlisted } = await admin
      .from("workspace_email_domain")
      .select("domain")
      .eq("workspace_id", project.workspace_id)
      .eq("domain", emailDomain)
      .maybeSingle();
    if (allowlisted) {
      logUsage({
        event: "project.guest_invite",
        surface: "action",
        user_id: user.id,
        workspace_id: project.workspace_id,
        status: "denied",
        duration_ms: Date.now() - started,
        error_code: "internal_domain",
        props: { project_id: projectId, role },
      });
      return {
        ok: false,
        error: `${normEmail} is on your team's domain — add them from Settings → Members instead. A guest invite would give them the whole workspace, not just this project.`,
      };
    }
  }

  const { data: invite, error: insertErr } = await admin
    .from("workspace_invites")
    .insert({
      workspace_id: project.workspace_id,
      email: normEmail,
      role: "guest",
      project_id: projectId,
      project_role: role,
      invited_by: user.id,
    })
    .select("token")
    .single();

  if (insertErr) {
    logUsage({
      event: "project.guest_invite",
      surface: "action",
      user_id: user.id,
      workspace_id: project.workspace_id,
      status: "error",
      duration_ms: Date.now() - started,
      error_code: insertErr.code ?? "insert_error",
      props: { project_id: projectId, role, duplicate: insertErr.code === "23505" },
    });
    if (insertErr.code === "23505") {
      return {
        ok: false,
        error:
          "There's already a pending invite for that email on this project — they need to accept it first.",
      };
    }
    return { ok: false, error: insertErr.message };
  }

  const send = await sendInviteLink(normEmail, invite.token, {
    workspace_id: project.workspace_id,
    project_id: projectId,
    project_role: role,
    invited_role: "guest",
  });

  logUsage({
    event: "project.guest_invite",
    surface: "action",
    user_id: user.id,
    workspace_id: project.workspace_id,
    status: "ok",
    duration_ms: Date.now() - started,
    props: { project_id: projectId, role, email_sent: send.emailed },
  });

  revalidatePath("/canvases");
  return send.emailed ? { ok: true } : { ok: true, warning: send.warning };
}

// Cancel a pending (not-yet-accepted) guest invite on this project.
export async function revokeProjectGuestInvite(
  projectId: string,
  inviteId: string,
): Promise<ActionResult> {
  const started = Date.now();
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "not_authenticated" };

  const { data: project } = await supabase
    .from("canvas_project")
    .select("workspace_id")
    .eq("id", projectId)
    .maybeSingle();
  if (!project?.workspace_id) return { ok: false, error: "project_not_found" };

  const { data: canEdit } = await supabase.rpc("canvas_can_edit_project", {
    _project_id: projectId,
  });
  if (canEdit !== true) return { ok: false, error: "not_authorized" };

  const admin = createAdminClient();
  const { data: deleted, error } = await admin
    .from("workspace_invites")
    .delete()
    .eq("id", inviteId)
    .eq("project_id", projectId)
    .is("accepted_at", null)
    .select("id");

  if (error) {
    console.error("[revokeProjectGuestInvite]", error);
    logUsage({
      event: "project.guest_invite_revoke",
      surface: "action",
      user_id: user.id,
      workspace_id: project.workspace_id,
      status: "error",
      duration_ms: Date.now() - started,
      error_code: error.code ?? "delete_error",
      props: { project_id: projectId, invite_id: inviteId },
    });
    return { ok: false, error: error.message };
  }
  if (!deleted || deleted.length === 0) {
    return { ok: false, error: "Invite already accepted or already revoked." };
  }

  logUsage({
    event: "project.guest_invite_revoke",
    surface: "action",
    user_id: user.id,
    workspace_id: project.workspace_id,
    status: "ok",
    duration_ms: Date.now() - started,
    props: { project_id: projectId, invite_id: inviteId },
  });

  revalidatePath("/canvases");
  return { ok: true };
}

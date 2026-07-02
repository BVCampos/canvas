"use server";

import { revalidatePath } from "next/cache";
import { randomBytes } from "node:crypto";
import { createClient } from "@/lib/supabase/server";
import { getActiveWorkspace } from "@/lib/auth/workspace";
import { logUsage } from "@/lib/usage/log";
import { mcpTokenExpiresAt } from "@/lib/canvas/mcp-token";
import { credentialEncryptionAvailable } from "@/lib/security/credential-crypto";
import {
  getOpenRouterConfigSummary,
  getOpenRouterCredential,
  getWorkspaceOpenRouterConfigSummary,
  getWorkspaceOpenRouterCredential,
  removeOpenRouterCredential,
  removeWorkspaceOpenRouterCredential,
  saveOpenRouterCredential,
  saveWorkspaceOpenRouterCredential,
  type AssistantRuntime,
  type OpenRouterConfigSummary,
  type WorkspaceOpenRouterConfigSummary,
} from "@/lib/canvas/assistant/openrouter-config";
import {
  isValidOpenRouterModelSpec,
  parseOpenRouterModels,
  validateOpenRouterAccess,
} from "@/lib/canvas/assistant/openrouter-client";

export type CreateTokenResult =
  | { ok: true; token: string; label: string | null }
  | { ok: false; error: string };

export type OpenRouterSettingsResult =
  | { ok: true; config: OpenRouterConfigSummary }
  | {
      ok: false;
      error:
        | "encryption_unavailable"
        | "key_required"
        | "invalid_key"
        | "invalid_model"
        | "model_not_capable"
        | "openrouter_unavailable"
        | "save_failed";
    };

export async function saveOpenRouterSettings(input: {
  apiKey: string;
  modelId: string;
  defaultRuntime: AssistantRuntime;
}): Promise<OpenRouterSettingsResult> {
  const started = Date.now();
  const { user, workspace } = await getActiveWorkspace("/settings/mcp");
  if (!credentialEncryptionAvailable()) {
    return { ok: false, error: "encryption_unavailable" };
  }

  // Accept a comma-separated model list (primary + fallbacks). Validate the
  // PRIMARY against OpenRouter, but persist the whole normalized list so the
  // runner's fallback array survives.
  const modelSpec = parseOpenRouterModels(input.modelId).normalized.slice(0, 200);
  if (!isValidOpenRouterModelSpec(modelSpec)) {
    return { ok: false, error: "invalid_model" };
  }
  const primaryModel = parseOpenRouterModels(modelSpec).primary;
  const defaultRuntime: AssistantRuntime =
    input.defaultRuntime === "openrouter" ? "openrouter" : "bridge";

  let apiKey = input.apiKey.trim();
  if (apiKey.length > 512) return { ok: false, error: "invalid_key" };
  try {
    if (!apiKey) {
      const existing = await getOpenRouterCredential(user.id);
      if (!existing) return { ok: false, error: "key_required" };
      apiKey = existing.apiKey;
    }

    const validation = await validateOpenRouterAccess(apiKey, primaryModel);
    if (!validation.ok) return validation;

    // Store the full list when the user supplied fallbacks; a single model
    // stays exactly as validated.
    const storedModel =
      parseOpenRouterModels(modelSpec).models.length > 1 ? modelSpec : validation.modelId;
    await saveOpenRouterCredential({
      userId: user.id,
      apiKey,
      keyHint: validation.keyHint,
      modelId: storedModel,
      defaultRuntime,
    });
    const config = await getOpenRouterConfigSummary(user.id);

    logUsage({
      event: "assistant.openrouter.configure",
      surface: "action",
      user_id: user.id,
      workspace_id: workspace.id,
      status: "ok",
      duration_ms: Date.now() - started,
      props: {
        model_id: validation.modelId,
        default_runtime: defaultRuntime,
        replaced_key: Boolean(input.apiKey.trim()),
      },
    });
    revalidatePath("/settings/mcp");
    return { ok: true, config };
  } catch (error) {
    console.error("[saveOpenRouterSettings]", error);
    return { ok: false, error: "save_failed" };
  }
}

export async function deleteOpenRouterSettings(): Promise<{
  ok: boolean;
  error?: "delete_failed";
}> {
  const { user, workspace } = await getActiveWorkspace("/settings/mcp");
  try {
    await removeOpenRouterCredential(user.id);
    logUsage({
      event: "assistant.openrouter.remove",
      surface: "action",
      user_id: user.id,
      workspace_id: workspace.id,
      status: "ok",
    });
    revalidatePath("/settings/mcp");
    return { ok: true };
  } catch (error) {
    console.error("[deleteOpenRouterSettings]", error);
    return { ok: false, error: "delete_failed" };
  }
}

// ── Workspace-shared OpenRouter key (ADR-0011). Owner/admin only. Resolved as a
// fallback for members without a personal key. ─────────────────────────────────

export type WorkspaceOpenRouterSettingsResult =
  | { ok: true; config: WorkspaceOpenRouterConfigSummary }
  | {
      ok: false;
      error:
        | "forbidden"
        | "encryption_unavailable"
        | "key_required"
        | "invalid_key"
        | "invalid_model"
        | "model_not_capable"
        | "openrouter_unavailable"
        | "save_failed";
    };

export async function saveWorkspaceOpenRouterSettings(input: {
  apiKey: string;
  modelId: string;
}): Promise<WorkspaceOpenRouterSettingsResult> {
  const started = Date.now();
  const { user, workspace, role } = await getActiveWorkspace("/settings/mcp");
  if (role !== "owner" && role !== "admin") {
    return { ok: false, error: "forbidden" };
  }
  if (!credentialEncryptionAvailable()) {
    return { ok: false, error: "encryption_unavailable" };
  }

  const modelSpec = parseOpenRouterModels(input.modelId).normalized.slice(0, 200);
  if (!isValidOpenRouterModelSpec(modelSpec)) {
    return { ok: false, error: "invalid_model" };
  }
  const primaryModel = parseOpenRouterModels(modelSpec).primary;

  let apiKey = input.apiKey.trim();
  if (apiKey.length > 512) return { ok: false, error: "invalid_key" };
  try {
    if (!apiKey) {
      const existing = await getWorkspaceOpenRouterCredential(workspace.id);
      if (!existing) return { ok: false, error: "key_required" };
      apiKey = existing.apiKey;
    }

    const validation = await validateOpenRouterAccess(apiKey, primaryModel);
    if (!validation.ok) return validation;

    const storedModel =
      parseOpenRouterModels(modelSpec).models.length > 1 ? modelSpec : validation.modelId;
    await saveWorkspaceOpenRouterCredential({
      workspaceId: workspace.id,
      setBy: user.id,
      apiKey,
      keyHint: validation.keyHint,
      modelId: storedModel,
    });
    const config = await getWorkspaceOpenRouterConfigSummary(workspace.id);

    logUsage({
      event: "assistant.openrouter.workspace.configure",
      surface: "action",
      user_id: user.id,
      workspace_id: workspace.id,
      status: "ok",
      duration_ms: Date.now() - started,
      props: {
        model_id: validation.modelId,
        replaced_key: Boolean(input.apiKey.trim()),
      },
    });
    revalidatePath("/settings/mcp");
    return { ok: true, config };
  } catch (error) {
    console.error("[saveWorkspaceOpenRouterSettings]", error);
    return { ok: false, error: "save_failed" };
  }
}

export async function deleteWorkspaceOpenRouterSettings(): Promise<{
  ok: boolean;
  error?: "forbidden" | "delete_failed";
}> {
  const { user, workspace, role } = await getActiveWorkspace("/settings/mcp");
  if (role !== "owner" && role !== "admin") {
    return { ok: false, error: "forbidden" };
  }
  try {
    await removeWorkspaceOpenRouterCredential(workspace.id);
    logUsage({
      event: "assistant.openrouter.workspace.remove",
      surface: "action",
      user_id: user.id,
      workspace_id: workspace.id,
      status: "ok",
    });
    revalidatePath("/settings/mcp");
    return { ok: true };
  } catch (error) {
    console.error("[deleteWorkspaceOpenRouterSettings]", error);
    return { ok: false, error: "delete_failed" };
  }
}

/**
 * Mints a new per-user MCP token scoped to the user's active workspace.
 *
 * New tokens get a default expiry (see mcpTokenExpiresAt); legacy tokens keep a
 * null expires_at and never expire (migration 0049). The token is still stored
 * raw as the primary key — hashing-at-rest needs a destructive PK migration and
 * is deferred (see the execution ledger).
 */
export async function createMcpToken(label: string): Promise<CreateTokenResult> {
  const started = Date.now();
  const { user, workspace } = await getActiveWorkspace("/settings/mcp");
  const supabase = await createClient();

  const token = `mcp_${randomBytes(24).toString("base64url")}`;
  const trimmedLabel = label.trim() || null;

  const { error } = await supabase.from("canvas_mcp_token").insert({
    token,
    workspace_id: workspace.id,
    user_id: user.id,
    label: trimmedLabel,
    expires_at: mcpTokenExpiresAt(),
  });

  if (error) {
    console.error("[createMcpToken]", error);
    logUsage({
      event: "mcp_token.create",
      surface: "action",
      user_id: user.id,
      workspace_id: workspace.id,
      status: "error",
      duration_ms: Date.now() - started,
      error_code: error.code ?? "insert_error",
      props: { has_label: Boolean(trimmedLabel) },
    });
    return { ok: false, error: error.message };
  }

  // Note: token value is intentionally not logged. has_label is the only
  // signal we keep — useful for "are people naming their tokens" without
  // ever capturing the label string itself.
  logUsage({
    event: "mcp_token.create",
    surface: "action",
    user_id: user.id,
    workspace_id: workspace.id,
    status: "ok",
    duration_ms: Date.now() - started,
    props: { has_label: Boolean(trimmedLabel) },
  });

  revalidatePath("/settings/mcp");
  return { ok: true, token, label: trimmedLabel };
}

export async function revokeMcpToken(token: string): Promise<{ ok: boolean; error?: string }> {
  const started = Date.now();
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Capture workspace_id from the token row before the update — RLS gates
  // the read to the token's owner. Best-effort: if we can't see it, log
  // with null workspace_id (admins won't see the event then, but
  // service-role queries still will).
  const { data: tokenRow } = await supabase
    .from("canvas_mcp_token")
    .select("workspace_id")
    .eq("token", token)
    .maybeSingle();

  const { error } = await supabase
    .from("canvas_mcp_token")
    .update({ revoked_at: new Date().toISOString() })
    .eq("token", token);

  if (error) {
    console.error("[revokeMcpToken]", error);
    logUsage({
      event: "mcp_token.revoke",
      surface: "action",
      user_id: user?.id ?? null,
      workspace_id: tokenRow?.workspace_id ?? null,
      status: "error",
      duration_ms: Date.now() - started,
      error_code: error.code ?? "update_error",
    });
    return { ok: false, error: error.message };
  }

  logUsage({
    event: "mcp_token.revoke",
    surface: "action",
    user_id: user?.id ?? null,
    workspace_id: tokenRow?.workspace_id ?? null,
    status: "ok",
    duration_ms: Date.now() - started,
  });

  revalidatePath("/settings/mcp");
  return { ok: true };
}

/**
 * Rotates a token: mints a replacement (inheriting the label + a fresh expiry)
 * and revokes the old one. Returns the new token so the UI can reveal it once.
 * Mint-then-revoke order: if the revoke fails the old token stays live (the user
 * can revoke it by hand) but they already hold the replacement, so a revoke
 * hiccup never strands the rotation.
 */
export async function rotateMcpToken(oldToken: string): Promise<CreateTokenResult> {
  const started = Date.now();
  const { user, workspace } = await getActiveWorkspace("/settings/mcp");
  const supabase = await createClient();

  // The old token must be the caller's — RLS scopes this read to the owner.
  const { data: oldRow } = await supabase
    .from("canvas_mcp_token")
    .select("label")
    .eq("token", oldToken)
    .maybeSingle();
  if (!oldRow) {
    return { ok: false, error: "Token not found." };
  }
  const label = (oldRow.label as string | null) ?? null;

  const token = `mcp_${randomBytes(24).toString("base64url")}`;
  const { error: insertErr } = await supabase.from("canvas_mcp_token").insert({
    token,
    workspace_id: workspace.id,
    user_id: user.id,
    label,
    expires_at: mcpTokenExpiresAt(),
  });
  if (insertErr) {
    console.error("[rotateMcpToken:insert]", insertErr);
    return { ok: false, error: insertErr.message };
  }

  const { error: revokeErr } = await supabase
    .from("canvas_mcp_token")
    .update({ revoked_at: new Date().toISOString() })
    .eq("token", oldToken);
  if (revokeErr) {
    console.error("[rotateMcpToken:revoke-old]", revokeErr);
  }

  logUsage({
    event: "mcp_token.rotate",
    surface: "action",
    user_id: user.id,
    workspace_id: workspace.id,
    status: "ok",
    duration_ms: Date.now() - started,
    props: { has_label: Boolean(label), old_revoked: !revokeErr },
  });

  revalidatePath("/settings/mcp");
  return { ok: true, token, label };
}

import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  credentialEncryptionAvailable,
  decryptCredential,
  encryptCredential,
} from "@/lib/security/credential-crypto";
import {
  isHostedProvider,
  type HostedProvider,
} from "@/lib/canvas/assistant/hosted-providers";

// Naming debt (ADR-0014): the stored runtime id 'openrouter' means "hosted API
// runtime" generically — the credential's `provider` column says which vendor.
// The OpenRouter* names in this module predate BYOK and are kept to avoid an
// app-wide rename.
export type AssistantRuntime = "bridge" | "openrouter";

type ConfigRow = {
  user_id: string;
  provider: string | null;
  encrypted_api_key: string;
  key_hint: string;
  model_id: string;
  default_runtime: AssistantRuntime;
  validated_at: string;
};

function normalizeProvider(value: unknown): HostedProvider {
  return isHostedProvider(value) ? value : "openrouter";
}

export type OpenRouterConfigSummary = {
  configured: boolean;
  // Which config satisfied the lookup: the user's own key, the workspace-shared
  // fallback, or none. `null` when not configured.
  source: "user" | "workspace" | null;
  provider: HostedProvider;
  encryptionReady: boolean;
  keyHint: string | null;
  modelId: string;
  defaultRuntime: AssistantRuntime;
  validatedAt: string | null;
};

export type WorkspaceOpenRouterConfigSummary = {
  configured: boolean;
  provider: HostedProvider;
  encryptionReady: boolean;
  keyHint: string | null;
  modelId: string;
  validatedAt: string | null;
};

const DEFAULT_MODEL = "openrouter/auto";

function admin(client?: SupabaseClient): SupabaseClient {
  return client ?? createAdminClient();
}

export async function getOpenRouterConfigSummary(
  userId: string,
  workspaceId?: string | null,
  client?: SupabaseClient,
): Promise<OpenRouterConfigSummary> {
  const db = admin(client);
  const encryptionReady = credentialEncryptionAvailable();

  const { data, error } = await db
    .from("canvas_user_ai_provider_config")
    .select("provider, key_hint, model_id, default_runtime, validated_at")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new Error(`OpenRouter config lookup failed: ${error.message}`);

  if (data) {
    return {
      configured: true,
      source: "user",
      provider: normalizeProvider(data.provider),
      encryptionReady,
      keyHint: (data.key_hint as string | undefined) ?? null,
      modelId: (data.model_id as string | undefined) ?? DEFAULT_MODEL,
      defaultRuntime:
        data.default_runtime === "openrouter" ? "openrouter" : "bridge",
      validatedAt: (data.validated_at as string | undefined) ?? null,
    };
  }

  // No personal key: a workspace-shared key (if any) still makes OpenRouter
  // available to this member. They opt in per turn, so the default stays bridge.
  if (workspaceId) {
    const ws = await getWorkspaceOpenRouterConfigSummary(workspaceId, db);
    if (ws.configured) {
      return {
        configured: true,
        source: "workspace",
        provider: ws.provider,
        encryptionReady,
        keyHint: ws.keyHint,
        modelId: ws.modelId,
        defaultRuntime: "bridge",
        validatedAt: ws.validatedAt,
      };
    }
  }

  return {
    configured: false,
    source: null,
    provider: "openrouter",
    encryptionReady,
    keyHint: null,
    modelId: DEFAULT_MODEL,
    defaultRuntime: "bridge",
    validatedAt: null,
  };
}

export async function getOpenRouterCredential(
  userId: string,
  workspaceId?: string | null,
  client?: SupabaseClient,
): Promise<{
  apiKey: string;
  modelId: string;
  provider: HostedProvider;
  source: "user" | "workspace";
} | null> {
  const db = admin(client);
  const { data, error } = await db
    .from("canvas_user_ai_provider_config")
    .select(
      "user_id, provider, encrypted_api_key, key_hint, model_id, default_runtime, validated_at",
    )
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new Error(`OpenRouter credential lookup failed: ${error.message}`);
  if (data) {
    const row = data as ConfigRow;
    return {
      apiKey: decryptCredential(row.encrypted_api_key),
      modelId: row.model_id,
      provider: normalizeProvider(row.provider),
      source: "user",
    };
  }

  // Personal key wins; otherwise fall back to the workspace-shared key.
  if (workspaceId) {
    const ws = await getWorkspaceOpenRouterCredential(workspaceId, db);
    if (ws) return { ...ws, source: "workspace" };
  }
  return null;
}

export async function saveOpenRouterCredential(
  input: {
    userId: string;
    provider: HostedProvider;
    apiKey: string;
    keyHint: string;
    modelId: string;
    defaultRuntime: AssistantRuntime;
  },
  client?: SupabaseClient,
): Promise<void> {
  const now = new Date().toISOString();
  const { error } = await admin(client)
    .from("canvas_user_ai_provider_config")
    .upsert(
      {
        user_id: input.userId,
        provider: input.provider,
        encrypted_api_key: encryptCredential(input.apiKey),
        key_hint: input.keyHint,
        model_id: input.modelId,
        default_runtime: input.defaultRuntime,
        validated_at: now,
      },
      { onConflict: "user_id" },
    );
  if (error) throw new Error(`OpenRouter config save failed: ${error.message}`);
}

export async function removeOpenRouterCredential(
  userId: string,
  client?: SupabaseClient,
): Promise<void> {
  const { error } = await admin(client)
    .from("canvas_user_ai_provider_config")
    .delete()
    .eq("user_id", userId);
  if (error) throw new Error(`OpenRouter config delete failed: ${error.message}`);
}

// ── Workspace-shared OpenRouter config (fallback for members without a personal
// key). Same encryption + service-role-only posture as the per-user table;
// writes are gated to owner/admin by the calling Server Action. ──────────────

export async function getWorkspaceOpenRouterConfigSummary(
  workspaceId: string,
  client?: SupabaseClient,
): Promise<WorkspaceOpenRouterConfigSummary> {
  const { data, error } = await admin(client)
    .from("canvas_workspace_ai_provider_config")
    .select("provider, key_hint, model_id, validated_at")
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  if (error)
    throw new Error(`Workspace OpenRouter config lookup failed: ${error.message}`);

  return {
    configured: Boolean(data),
    provider: normalizeProvider(data?.provider),
    encryptionReady: credentialEncryptionAvailable(),
    keyHint: (data?.key_hint as string | undefined) ?? null,
    modelId: (data?.model_id as string | undefined) ?? DEFAULT_MODEL,
    validatedAt: (data?.validated_at as string | undefined) ?? null,
  };
}

export async function getWorkspaceOpenRouterCredential(
  workspaceId: string,
  client?: SupabaseClient,
): Promise<{ apiKey: string; modelId: string; provider: HostedProvider } | null> {
  const { data, error } = await admin(client)
    .from("canvas_workspace_ai_provider_config")
    .select("provider, encrypted_api_key, model_id")
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  if (error)
    throw new Error(`Workspace OpenRouter credential lookup failed: ${error.message}`);
  if (!data) return null;
  return {
    apiKey: decryptCredential(data.encrypted_api_key as string),
    modelId: (data.model_id as string | undefined) ?? DEFAULT_MODEL,
    provider: normalizeProvider(data.provider),
  };
}

export async function saveWorkspaceOpenRouterCredential(
  input: {
    workspaceId: string;
    setBy: string;
    provider: HostedProvider;
    apiKey: string;
    keyHint: string;
    modelId: string;
  },
  client?: SupabaseClient,
): Promise<void> {
  const { error } = await admin(client)
    .from("canvas_workspace_ai_provider_config")
    .upsert(
      {
        workspace_id: input.workspaceId,
        provider: input.provider,
        encrypted_api_key: encryptCredential(input.apiKey),
        key_hint: input.keyHint,
        model_id: input.modelId,
        set_by: input.setBy,
        validated_at: new Date().toISOString(),
      },
      { onConflict: "workspace_id" },
    );
  if (error)
    throw new Error(`Workspace OpenRouter config save failed: ${error.message}`);
}

export async function removeWorkspaceOpenRouterCredential(
  workspaceId: string,
  client?: SupabaseClient,
): Promise<void> {
  const { error } = await admin(client)
    .from("canvas_workspace_ai_provider_config")
    .delete()
    .eq("workspace_id", workspaceId);
  if (error)
    throw new Error(`Workspace OpenRouter config delete failed: ${error.message}`);
}


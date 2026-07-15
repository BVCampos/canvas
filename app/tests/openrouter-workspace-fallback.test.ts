import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

// Exercise the personal-first / workspace-fallback resolution (ADR-0011) without
// real crypto or a database: a fake client routes by table name.
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => {
    throw new Error("tests must pass an explicit client");
  },
}));
vi.mock("@/lib/security/credential-crypto", () => ({
  credentialEncryptionAvailable: () => true,
  encryptCredential: (plain: string) => `enc(${plain})`,
  decryptCredential: (envelope: string) => envelope.slice(4, -1),
}));

import {
  getOpenRouterConfigSummary,
  getOpenRouterCredential,
} from "@/lib/canvas/assistant/openrouter-config";

const USER_ROW = {
  user_id: "u1",
  encrypted_api_key: "enc(USER_KEY)",
  key_hint: "••••user",
  model_id: "user/model",
  default_runtime: "openrouter",
  validated_at: "2026-01-01T00:00:00Z",
};
const WS_ROW = {
  workspace_id: "w1",
  encrypted_api_key: "enc(WORKSPACE_KEY)",
  key_hint: "••••wksp",
  model_id: "ws/model",
  validated_at: "2026-01-02T00:00:00Z",
};

function fakeClient(rows: {
  user?: Record<string, unknown>;
  workspace?: Record<string, unknown>;
}): SupabaseClient {
  return {
    from(table: string) {
      const row =
        table === "canvas_user_ai_provider_config"
          ? (rows.user ?? null)
          : table === "canvas_workspace_ai_provider_config"
            ? (rows.workspace ?? null)
            : null;
      const builder = {
        select: () => builder,
        eq: () => builder,
        maybeSingle: async () => ({ data: row, error: null }),
      };
      return builder;
    },
  } as unknown as SupabaseClient;
}

describe("getOpenRouterCredential — personal-first, workspace-fallback", () => {
  it("returns the personal key when the user has one", async () => {
    const c = await getOpenRouterCredential("u1", "w1", fakeClient({ user: USER_ROW, workspace: WS_ROW }));
    expect(c).toEqual({
      apiKey: "USER_KEY",
      modelId: "user/model",
      provider: "openrouter",
      source: "user",
    });
  });

  it("falls back to the workspace key when the user has none", async () => {
    const c = await getOpenRouterCredential("u1", "w1", fakeClient({ workspace: WS_ROW }));
    expect(c).toEqual({
      apiKey: "WORKSPACE_KEY",
      modelId: "ws/model",
      provider: "openrouter",
      source: "workspace",
    });
  });

  it("does not use the workspace key without a workspace id", async () => {
    const c = await getOpenRouterCredential("u1", null, fakeClient({ workspace: WS_ROW }));
    expect(c).toBeNull();
  });

  it("returns null when neither is configured", async () => {
    const c = await getOpenRouterCredential("u1", "w1", fakeClient({}));
    expect(c).toBeNull();
  });
});

describe("getOpenRouterConfigSummary — workspace fallback availability", () => {
  it("reports workspace-sourced availability with a bridge default", async () => {
    const s = await getOpenRouterConfigSummary("u1", "w1", fakeClient({ workspace: WS_ROW }));
    expect(s).toMatchObject({
      configured: true,
      source: "workspace",
      modelId: "ws/model",
      defaultRuntime: "bridge",
    });
  });

  it("prefers the user's own config and default runtime", async () => {
    const s = await getOpenRouterConfigSummary("u1", "w1", fakeClient({ user: USER_ROW, workspace: WS_ROW }));
    expect(s).toMatchObject({
      configured: true,
      source: "user",
      modelId: "user/model",
      defaultRuntime: "openrouter",
    });
  });

  it("is not configured when neither exists", async () => {
    const s = await getOpenRouterConfigSummary("u1", "w1", fakeClient({}));
    expect(s).toMatchObject({ configured: false, source: null });
  });
});

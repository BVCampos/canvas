"use server";

import { revalidatePath } from "next/cache";
import { getActiveWorkspace } from "@/lib/auth/workspace";
import { createClient } from "@/lib/supabase/server";
import { logUsage } from "@/lib/usage/log";
import {
  normalizeBrandName,
  normalizeBrandTokens,
  normalizeBrandVoice,
  type BrandTokens,
} from "@/lib/canvas/brand";

// Save the workspace's brand kit (migration 0065). Direct admin write, NOT a
// proposal — brand is workspace configuration. The UPSERT runs through the
// caller's RLS client, so "admins insert/update brand" is the authoritative
// check; a non-admin's write lands zero rows and reports denial (never a
// silent success).

export type SaveBrandResult = { ok: true } | { ok: false; error: string };

export async function saveBrand(input: {
  name: string;
  tokens: BrandTokens;
  voice: string;
}): Promise<SaveBrandResult> {
  const started = Date.now();
  const { workspace } = await getActiveWorkspace("/settings/brand");
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "not_authenticated" };

  const row = {
    workspace_id: workspace.id,
    name: normalizeBrandName(input.name),
    tokens: normalizeBrandTokens(input.tokens),
    voice: normalizeBrandVoice(input.voice),
    updated_by: user.id,
  };

  const { data: updated, error } = await supabase
    .from("canvas_brand")
    .upsert(row, { onConflict: "workspace_id" })
    .select("id");

  if (error) {
    console.error("[saveBrand]", error);
    logUsage({
      event: "brand.save",
      surface: "action",
      user_id: user.id,
      workspace_id: workspace.id,
      status: "error",
      duration_ms: Date.now() - started,
      error_code: error.code ?? "upsert_error",
    });
    return { ok: false, error: error.message };
  }
  if (!updated || updated.length === 0) {
    return { ok: false, error: "Only admins and owners can edit the brand kit." };
  }

  logUsage({
    event: "brand.save",
    surface: "action",
    user_id: user.id,
    workspace_id: workspace.id,
    status: "ok",
    duration_ms: Date.now() - started,
    props: {
      colors: Object.keys(row.tokens.colors ?? {}).length,
      fonts: Object.keys(row.tokens.fonts ?? {}).length,
      has_voice: row.voice !== null,
    },
  });

  revalidatePath("/settings/brand");
  return { ok: true };
}

"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import type { ActionResult } from "./[id]/actions";

// Server actions for Canvas Projects — the named deck groups on /canvases.
// Every call runs on the RLS client, so the 0038 policies are the real gate:
// full members create, creator-or-admin renames/deletes, and moving a deck is
// governed by the existing canvas_deck UPDATE policy. Each action revalidates
// /canvases so the grouped list re-renders with fresh data.

const NAME_MAX = 120;

// Postgres unique_violation — the (workspace_id, lower(name)) index in 0038.
const UNIQUE_VIOLATION = "23505";

export async function createProject(
  workspaceId: string,
  name: string,
): Promise<ActionResult> {
  const trimmed = name.trim().slice(0, NAME_MAX);
  if (!trimmed) return { ok: false, error: "Give the project a name." };

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not signed in." };

  const { error } = await supabase.from("canvas_project").insert({
    workspace_id: workspaceId,
    name: trimmed,
    created_by: user.id,
  });
  if (error) {
    if (error.code === UNIQUE_VIOLATION) {
      return { ok: false, error: `A project named "${trimmed}" already exists.` };
    }
    console.error("[createProject]", error);
    return { ok: false, error: error.message };
  }

  revalidatePath("/canvases");
  return { ok: true };
}

export async function renameProject(
  projectId: string,
  name: string,
): Promise<ActionResult> {
  const trimmed = name.trim().slice(0, NAME_MAX);
  if (!trimmed) return { ok: false, error: "Give the project a name." };

  const supabase = await createClient();
  // `.select()` so we can tell "no row updated" (RLS denied / project gone)
  // apart from success — a bare UPDATE succeeds silently on zero rows.
  const { data, error } = await supabase
    .from("canvas_project")
    .update({ name: trimmed })
    .eq("id", projectId)
    .select("id");
  if (error) {
    if (error.code === UNIQUE_VIOLATION) {
      return { ok: false, error: `A project named "${trimmed}" already exists.` };
    }
    console.error("[renameProject]", error);
    return { ok: false, error: error.message };
  }
  if (!data || data.length === 0) {
    return { ok: false, error: "Project not found, or you can't rename it." };
  }

  revalidatePath("/canvases");
  return { ok: true };
}

export async function deleteProject(projectId: string): Promise<ActionResult> {
  const supabase = await createClient();
  // The FK on canvas_deck.project_id is ON DELETE SET NULL — decks survive
  // and fall back to the ungrouped section.
  const { data, error } = await supabase
    .from("canvas_project")
    .delete()
    .eq("id", projectId)
    .select("id");
  if (error) {
    console.error("[deleteProject]", error);
    return { ok: false, error: error.message };
  }
  if (!data || data.length === 0) {
    return { ok: false, error: "Project not found, or you can't delete it." };
  }

  revalidatePath("/canvases");
  return { ok: true };
}

export async function setDeckProject(
  deckId: string,
  projectId: string | null,
): Promise<ActionResult> {
  const supabase = await createClient();

  // Cross-workspace guard: the deck UPDATE policy doesn't know about
  // projects, so without this a deck could point at a project in another
  // workspace the user belongs to. Both reads are RLS-gated.
  if (projectId !== null) {
    const [deckResp, projectResp] = await Promise.all([
      supabase.from("canvas_deck").select("workspace_id").eq("id", deckId).maybeSingle(),
      supabase.from("canvas_project").select("workspace_id").eq("id", projectId).maybeSingle(),
    ]);
    if (!deckResp.data || !projectResp.data) {
      return { ok: false, error: "Deck or project not found." };
    }
    if (deckResp.data.workspace_id !== projectResp.data.workspace_id) {
      return { ok: false, error: "Project belongs to a different workspace." };
    }
  }

  const { data, error } = await supabase
    .from("canvas_deck")
    .update({ project_id: projectId })
    .eq("id", deckId)
    .select("id");
  if (error) {
    console.error("[setDeckProject]", error);
    return { ok: false, error: error.message };
  }
  if (!data || data.length === 0) {
    return { ok: false, error: "You can't move this deck — only its creator or an admin can." };
  }

  revalidatePath("/canvases");
  return { ok: true };
}

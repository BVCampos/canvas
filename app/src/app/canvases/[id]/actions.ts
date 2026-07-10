"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { randomBytes } from "crypto";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendInviteLink, resolveAppBaseUrl } from "@/lib/auth/invite-email";
import { logUsage } from "@/lib/usage/log";
import { logNotifications } from "@/lib/notifications/log";
import { notificationsForComment } from "@/lib/canvas/notifications";
import { resolveMentions } from "@/lib/canvas/mention";

// Server actions for the deck editor. Each one resolves the active user via
// the SSR Supabase client (RLS applies on every call) and bumps the deck
// route's cache so the page re-renders with fresh data.

export type ActionResult = { ok: true } | { ok: false; error: string };

// lockSlide surfaces a richer payload when the lock is already taken, so the
// UI can name the holder + show their expiry instead of dumping the raw error
// code in the right rail. The `kind` discriminator lets callers switch on the
// failure category without sniffing fields on the result.
export type LockSlideResult =
  | { ok: true }
  | {
      ok: false;
      kind: "already_locked";
      holder_email: string | null;
      holder_name: string | null;
      expires_at: string;
    }
  | { ok: false; kind: "other"; error: string };

const LOCK_DURATION_MINUTES = 15;

export async function lockSlide(slideId: string, deckId: string): Promise<LockSlideResult> {
  const started = Date.now();
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, kind: "other", error: "not_authenticated" };

  // Resolve workspace_id from the slide row — RLS gates this read by
  // membership. Split error from absence so a real DB failure surfaces a
  // different code than "this slide doesn't exist or you can't see it".
  const { data: slide, error: slideErr } = await supabase
    .from("canvas_deck_slide")
    .select("workspace_id")
    .eq("id", slideId)
    .maybeSingle();
  if (slideErr) {
    console.error("[lockSlide] slide lookup", slideErr);
    return { ok: false, kind: "other", error: "slide_lookup_failed" };
  }
  if (!slide?.workspace_id) {
    return { ok: false, kind: "other", error: "slide_not_found" };
  }

  // Drop any stale (expired) lock first. We don't fight other holders here —
  // if they're still inside their 15min window, the upsert will fail and we
  // surface that to the UI.
  await supabase
    .from("canvas_deck_slide_lock")
    .delete()
    .eq("slide_id", slideId)
    .lt("expires_at", new Date().toISOString());

  const expires_at = new Date(Date.now() + LOCK_DURATION_MINUTES * 60_000).toISOString();
  const { error } = await supabase
    .from("canvas_deck_slide_lock")
    .insert({
      slide_id: slideId,
      workspace_id: slide.workspace_id,
      locked_by: user.id,
      locked_by_kind: "user",
      expires_at,
    });

  if (error) {
    // Unique-violation on the PK (slide_id) means someone else is holding it.
    // Resolve the holder (email + display name) so the UI can render
    // "Already being edited by …". We also revalidate so the page rehydrates
    // with the up-to-date lock badge (the optimistic "Claim slide" button
    // disappears on refresh).
    if (error.code === "23505") {
      const { data: holder, error: holderErr } = await supabase
        .from("canvas_deck_slide_lock")
        .select("locked_by, expires_at")
        .eq("slide_id", slideId)
        .maybeSingle();
      if (holderErr) {
        console.error("[lockSlide] holder lookup", holderErr);
      }

      let holderEmail: string | null = null;
      let holderName: string | null = null;
      let holderExpiry = expires_at;
      if (holder) {
        holderExpiry = holder.expires_at;
        const { data: userRow, error: userErr } = await supabase
          .from("users")
          .select("email, name")
          .eq("id", holder.locked_by)
          .maybeSingle();
        if (userErr) {
          console.error("[lockSlide] holder user lookup", userErr);
        } else if (userRow) {
          holderEmail = (userRow.email as string | null) ?? null;
          holderName = (userRow.name as string | null) ?? null;
        }
      }

      logUsage({
        event: "slide.lock",
        surface: "action",
        user_id: user.id,
        workspace_id: slide.workspace_id,
        deck_id: deckId,
        slide_id: slideId,
        status: "denied",
        duration_ms: Date.now() - started,
        error_code: "already_locked",
        props: { result_kind: "already_locked" },
      });

      revalidatePath(`/canvases/${deckId}`);
      return {
        ok: false,
        kind: "already_locked",
        holder_email: holderEmail,
        holder_name: holderName,
        expires_at: holderExpiry,
      };
    }
    console.error("[lockSlide]", error);
    logUsage({
      event: "slide.lock",
      surface: "action",
      user_id: user.id,
      workspace_id: slide.workspace_id,
      deck_id: deckId,
      slide_id: slideId,
      status: "error",
      duration_ms: Date.now() - started,
      error,
      error_code: error.code ?? "insert_error",
    });
    return { ok: false, kind: "other", error: error.message };
  }

  logUsage({
    event: "slide.lock",
    surface: "action",
    user_id: user.id,
    workspace_id: slide.workspace_id,
    deck_id: deckId,
    slide_id: slideId,
    status: "ok",
    duration_ms: Date.now() - started,
  });

  revalidatePath(`/canvases/${deckId}`);
  return { ok: true };
}

export async function releaseSlide(slideId: string, deckId: string): Promise<ActionResult> {
  const started = Date.now();
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "not_authenticated" };

  // Capture workspace_id for the usage event — best-effort, RLS-gated.
  const { data: slide } = await supabase
    .from("canvas_deck_slide")
    .select("workspace_id")
    .eq("id", slideId)
    .maybeSingle();
  const workspace_id = slide?.workspace_id ?? null;

  const { error } = await supabase
    .from("canvas_deck_slide_lock")
    .delete()
    .eq("slide_id", slideId);

  if (error) {
    console.error("[releaseSlide]", error);
    logUsage({
      event: "slide.release",
      surface: "action",
      user_id: user.id,
      workspace_id,
      deck_id: deckId,
      slide_id: slideId,
      status: "error",
      duration_ms: Date.now() - started,
      error,
      error_code: error.code ?? "delete_error",
    });
    return { ok: false, error: error.message };
  }

  logUsage({
    event: "slide.release",
    surface: "action",
    user_id: user.id,
    workspace_id,
    deck_id: deckId,
    slide_id: slideId,
    status: "ok",
    duration_ms: Date.now() - started,
  });

  revalidatePath(`/canvases/${deckId}`);
  return { ok: true };
}

// Heartbeat for a lock we already hold. The soft lock is a flat 15-min TTL
// (migration 0001) with no renewal, so an edit that runs past 15 minutes used
// to have its lock lapse silently mid-edit — another user (or Claude) could
// then claim the slide underneath the active editor. `renewSlideLock` pushes
// `expires_at` forward by another full lease so a focused editor keeps the
// hold for as long as they're working.
//
// Holder-scoped on purpose: the UPDATE is constrained by BOTH `slide_id` AND
// `locked_by = auth.uid()`, so it can only ever extend a lock the caller
// already owns — it can never steal or resurrect someone else's hold, and a
// lock that expired and was re-taken by another user won't match. `.select()`
// on the UPDATE lets us report whether a row was actually touched: zero rows
// means "you no longer hold this" (lapsed, force-released, or stolen), which
// the client uses to stop the heartbeat instead of renewing a ghost. Unlike
// lock/release this does NOT revalidate the route — renewal is a silent
// keep-alive, and realtime already watches canvas_deck_slide_lock for the
// expiry bump; a revalidate here would churn the page every five minutes.
export type RenewSlideLockResult =
  | { ok: true; renewed: boolean; expires_at: string | null }
  | { ok: false; error: string };

export async function renewSlideLock(
  slideId: string,
  deckId: string,
): Promise<RenewSlideLockResult> {
  const started = Date.now();
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "not_authenticated" };

  const expires_at = new Date(Date.now() + LOCK_DURATION_MINUTES * 60_000).toISOString();
  const { data, error } = await supabase
    .from("canvas_deck_slide_lock")
    .update({ expires_at })
    .eq("slide_id", slideId)
    .eq("locked_by", user.id)
    .select("slide_id");

  if (error) {
    console.error("[renewSlideLock]", error);
    logUsage({
      event: "slide.lock_renew",
      surface: "action",
      user_id: user.id,
      deck_id: deckId,
      slide_id: slideId,
      status: "error",
      duration_ms: Date.now() - started,
      error,
      error_code: error.code ?? "update_error",
    });
    return { ok: false, error: error.message };
  }

  const renewed = Boolean(data && data.length > 0);
  logUsage({
    event: "slide.lock_renew",
    surface: "action",
    user_id: user.id,
    deck_id: deckId,
    slide_id: slideId,
    // A no-row outcome isn't an error — it's "you don't hold this lock
    // anymore"; tag it `denied` so it's distinguishable from a real failure.
    status: renewed ? "ok" : "denied",
    duration_ms: Date.now() - started,
    props: { renewed },
  });

  return { ok: true, renewed, expires_at: renewed ? expires_at : null };
}

// Admin/owner-only escape hatch. Members release their own slides via
// releaseSlide; this one breaks somebody else's hold. RLS on
// canvas_deck_slide_lock already gates the DELETE on
// `is_workspace_admin_or_owner OR locked_by = auth.uid()`, but we still
// pre-check via the RPC so we can return a precise "not_authorized" error
// rather than a silent zero-rows-affected.
//
// The discriminated result lets the caller distinguish:
//   - `lock_not_found`   — the lock was released between render and click
//   - `not_authorized`   — caller isn't admin/owner on the deck's workspace
//   - `slide_not_found`  — slide doesn't exist or RLS hides it
//   - `slide_lookup_failed` / `rpc_error` / `delete_failed` — real DB errors
export type ForceReleaseSlideResult =
  | { ok: true }
  | {
      ok: false;
      kind:
        | "not_authenticated"
        | "slide_not_found"
        | "slide_lookup_failed"
        | "rpc_error"
        | "not_authorized"
        | "lock_not_found"
        | "delete_failed";
      error?: string;
    };

export async function forceReleaseSlide(
  slideId: string,
  deckId: string,
): Promise<ForceReleaseSlideResult> {
  const started = Date.now();
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, kind: "not_authenticated" };

  const { data: slide, error: slideErr } = await supabase
    .from("canvas_deck_slide")
    .select("workspace_id")
    .eq("id", slideId)
    .maybeSingle();
  if (slideErr) {
    console.error("[forceReleaseSlide] slide lookup", slideErr);
    logUsage({
      event: "slide.force_release",
      surface: "action",
      user_id: user.id,
      deck_id: deckId,
      slide_id: slideId,
      status: "error",
      duration_ms: Date.now() - started,
      error: slideErr,
      error_code: slideErr.code ?? "slide_lookup_failed",
      props: { result_kind: "slide_lookup_failed" },
    });
    return { ok: false, kind: "slide_lookup_failed", error: slideErr.message };
  }
  if (!slide?.workspace_id) {
    logUsage({
      event: "slide.force_release",
      surface: "action",
      user_id: user.id,
      deck_id: deckId,
      slide_id: slideId,
      status: "denied",
      duration_ms: Date.now() - started,
      props: { result_kind: "slide_not_found" },
    });
    return { ok: false, kind: "slide_not_found" };
  }

  const { data: isAdmin, error: rpcErr } = await supabase.rpc(
    "is_workspace_admin_or_owner",
    { _workspace_id: slide.workspace_id },
  );
  if (rpcErr) {
    console.error("[forceReleaseSlide] rpc", rpcErr);
    logUsage({
      event: "slide.force_release",
      surface: "action",
      user_id: user.id,
      workspace_id: slide.workspace_id,
      deck_id: deckId,
      slide_id: slideId,
      status: "error",
      duration_ms: Date.now() - started,
      error: rpcErr,
      error_code: rpcErr.code ?? "rpc_error",
      props: { result_kind: "rpc_error" },
    });
    return { ok: false, kind: "rpc_error", error: rpcErr.message };
  }
  if (!isAdmin) {
    logUsage({
      event: "slide.force_release",
      surface: "action",
      user_id: user.id,
      workspace_id: slide.workspace_id,
      deck_id: deckId,
      slide_id: slideId,
      status: "denied",
      duration_ms: Date.now() - started,
      props: { result_kind: "not_authorized" },
    });
    return { ok: false, kind: "not_authorized" };
  }

  // `.select("slide_id")` on the DELETE lets us distinguish "RLS / no row"
  // (zero rows) from a real driver error. The pre-check above means a
  // zero-row outcome here is almost always "the lock expired or someone else
  // released it between render and click", not an auth issue.
  const { data: deleted, error } = await supabase
    .from("canvas_deck_slide_lock")
    .delete()
    .eq("slide_id", slideId)
    .select("slide_id");

  if (error) {
    console.error("[forceReleaseSlide]", error);
    logUsage({
      event: "slide.force_release",
      surface: "action",
      user_id: user.id,
      workspace_id: slide.workspace_id,
      deck_id: deckId,
      slide_id: slideId,
      status: "error",
      duration_ms: Date.now() - started,
      error,
      error_code: error.code ?? "delete_failed",
      props: { result_kind: "delete_failed" },
    });
    return { ok: false, kind: "delete_failed", error: error.message };
  }
  if (!deleted || deleted.length === 0) {
    logUsage({
      event: "slide.force_release",
      surface: "action",
      user_id: user.id,
      workspace_id: slide.workspace_id,
      deck_id: deckId,
      slide_id: slideId,
      status: "denied",
      duration_ms: Date.now() - started,
      props: { result_kind: "lock_not_found" },
    });
    return { ok: false, kind: "lock_not_found" };
  }

  logUsage({
    event: "slide.force_release",
    surface: "action",
    user_id: user.id,
    workspace_id: slide.workspace_id,
    deck_id: deckId,
    slide_id: slideId,
    status: "ok",
    duration_ms: Date.now() - started,
  });

  revalidatePath(`/canvases/${deckId}`);
  return { ok: true };
}

export async function createSnapshot(
  deckId: string,
  label: string,
  description?: string,
): Promise<ActionResult> {
  const started = Date.now();
  const supabase = await createClient();
  const trimmed = label.trim();
  if (!trimmed) return { ok: false, error: "label_required" };

  // Look up workspace + user for the usage event. RLS gates the deck read.
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const { data: deck } = await supabase
    .from("canvas_deck")
    .select("workspace_id")
    .eq("id", deckId)
    .maybeSingle();
  const workspace_id = deck?.workspace_id ?? null;

  const { error } = await supabase.rpc("canvas_create_snapshot", {
    _deck_id: deckId,
    _label: trimmed,
    _description: description?.trim() || null,
    _kind: "manual",
  });

  if (error) {
    console.error("[createSnapshot]", error);
    logUsage({
      event: "snapshot.create",
      surface: "action",
      user_id: user?.id ?? null,
      workspace_id,
      deck_id: deckId,
      status: "error",
      duration_ms: Date.now() - started,
      error,
      error_code: error.code ?? "rpc_error",
      props: { kind: "manual", has_description: Boolean(description?.trim()) },
    });
    return { ok: false, error: error.message };
  }

  logUsage({
    event: "snapshot.create",
    surface: "action",
    user_id: user?.id ?? null,
    workspace_id,
    deck_id: deckId,
    status: "ok",
    duration_ms: Date.now() - started,
    props: { kind: "manual", has_description: Boolean(description?.trim()) },
  });

  revalidatePath(`/canvases/${deckId}`);
  revalidatePath(`/canvases/${deckId}/history`);
  return { ok: true };
}

export async function restoreSlideVersion(
  slideId: string,
  versionId: string,
  deckId: string,
): Promise<ActionResult> {
  const started = Date.now();
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const { data: slide } = await supabase
    .from("canvas_deck_slide")
    .select("workspace_id")
    .eq("id", slideId)
    .maybeSingle();
  const workspace_id = slide?.workspace_id ?? null;

  const { error } = await supabase.rpc("canvas_restore_slide_version", {
    _slide_id: slideId,
    _to_version_id: versionId,
  });

  if (error) {
    console.error("[restoreSlideVersion]", error);
    logUsage({
      event: "slide_version.restore",
      surface: "action",
      user_id: user?.id ?? null,
      workspace_id,
      deck_id: deckId,
      slide_id: slideId,
      status: "error",
      duration_ms: Date.now() - started,
      error,
      error_code: error.code ?? "rpc_error",
      props: { version_id: versionId },
    });
    return { ok: false, error: error.message };
  }

  logUsage({
    event: "slide_version.restore",
    surface: "action",
    user_id: user?.id ?? null,
    workspace_id,
    deck_id: deckId,
    slide_id: slideId,
    status: "ok",
    duration_ms: Date.now() - started,
    props: { version_id: versionId },
  });

  // Revalidate the history page too — the user is almost certainly viewing it
  // when they click Restore, and without this the new v(N+1) row doesn't show
  // up until they manually refresh. restoreSnapshot below already does both.
  revalidatePath(`/canvases/${deckId}`);
  revalidatePath(`/canvases/${deckId}/history`);
  return { ok: true };
}

// Fetch raw version content for the History version-to-version diff, on demand
// when a row's "View diff" is expanded. This lets the History page ship version
// METADATA only (not every version's full html_body), so the payload doesn't
// grow unbounded with a deck's edit count. RLS gates by workspace membership;
// we also scope to deck_id so a version id from another deck can't be read here.
export async function getSlideVersionContents(
  deckId: string,
  versionIds: string[],
): Promise<
  | {
      ok: true;
      versions: Record<
        string,
        { title: string; html_body: string; slide_styles: string | null }
      >;
    }
  | { ok: false; error: string }
> {
  if (versionIds.length === 0) return { ok: true, versions: {} };
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("canvas_slide_version")
    .select("id, title, html_body, slide_styles")
    .eq("deck_id", deckId)
    .in("id", versionIds);
  if (error) {
    console.error("[getSlideVersionContents]", error);
    return { ok: false, error: error.message };
  }
  const versions: Record<
    string,
    { title: string; html_body: string; slide_styles: string | null }
  > = {};
  for (const v of data ?? []) {
    versions[v.id as string] = {
      title: (v.title as string) ?? "",
      html_body: (v.html_body as string) ?? "",
      slide_styles: (v.slide_styles as string | null) ?? null,
    };
  }
  return { ok: true, versions };
}

// Direct (non-proposal) slide-HTML edit — backs the inline "Edit text" surface
// and the raw-HTML code view. Unlike the propose -> approve loop this commits
// immediately, but still versions the slide via canvas_save_slide_direct, so
// History and restore keep working. RLS on canvas_deck_slide is the real gate
// on who may save (slide owner / creator / workspace admin); a non-editor's
// write is blocked by the RPC's row-count guard. `baseVersionId` is the version
// the editor opened against — the RPC aborts (kind: "stale") if the slide moved
// on since, so a save can't silently clobber newer content.
export type SaveSlideResult =
  // versionId is the just-produced version's id — the workspace uses it to
  // recognize its OWN edit's revalidate echo and skip the preview remount (the
  // iframe already shows the edited content in place). Keyed on the id, not the
  // number, so it matches the current_version_id the remount signature uses.
  | { ok: true; versionId: string | null }
  | { ok: false; kind: "stale" | "other"; error: string };

export async function saveSlideHtmlDirect(
  slideId: string,
  deckId: string,
  newHtml: string,
  baseVersionId: string | null,
  summary?: string,
  // Release the caller's own soft lock in the SAME transaction as the save
  // (migration 0072) — one action instead of save + a separate releaseSlide
  // round-trip (each with its own revalidate loader run).
  releaseLock = false,
): Promise<SaveSlideResult> {
  const started = Date.now();
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, kind: "other", error: "not_authenticated" };

  const trimmed = newHtml.trim();
  if (!trimmed) return { ok: false, kind: "other", error: "empty_html" };

  const { data: slide } = await supabase
    .from("canvas_deck_slide")
    .select("workspace_id")
    .eq("id", slideId)
    .maybeSingle();
  const workspace_id = slide?.workspace_id ?? null;

  const { data: versionRow, error } = await supabase.rpc(
    "canvas_save_slide_direct",
    {
      _slide_id: slideId,
      _new_html: trimmed,
      _base_version_id: baseVersionId,
      _summary: summary?.trim() || null,
      _release_lock: releaseLock,
    },
  );

  if (error) {
    // The RPC tags the optimistic-concurrency failure with a stable token so
    // we can show a "refresh and re-apply" hint rather than a raw SQL error.
    const stale = (error.message ?? "").includes("stale_base_version");
    console.error("[saveSlideHtmlDirect]", error);
    logUsage({
      event: "slide.direct_edit",
      surface: "action",
      user_id: user.id,
      workspace_id,
      deck_id: deckId,
      slide_id: slideId,
      status: stale ? "denied" : "error",
      duration_ms: Date.now() - started,
      error_code: stale ? "stale_base_version" : error.code ?? "rpc_error",
      props: { html_len: trimmed.length },
    });
    return {
      ok: false,
      kind: stale ? "stale" : "other",
      error: stale
        ? "This slide changed since you started editing — refresh to see the latest, then re-apply your change."
        : error.message,
    };
  }

  logUsage({
    event: "slide.direct_edit",
    surface: "action",
    user_id: user.id,
    workspace_id,
    deck_id: deckId,
    slide_id: slideId,
    status: "ok",
    duration_ms: Date.now() - started,
    props: { html_len: trimmed.length },
  });

  revalidatePath(`/canvases/${deckId}`);
  revalidatePath(`/canvases/${deckId}/history`);
  // .rpc on a function returning a composite row hands back that row (or an
  // array of one, depending on the client) — read the new version id defensively.
  const row = Array.isArray(versionRow) ? versionRow[0] : versionRow;
  const versionId =
    row && typeof row === "object" && typeof (row as { id?: unknown }).id === "string"
      ? (row as { id: string }).id
      : null;
  return { ok: true, versionId };
}

// Fetch a slide's current raw html_body for the code-view editor. RLS gates the
// read by workspace membership; scoped to deck_id so a slide id from another
// deck can't be read through this deck's editor. Returns current_version_id so
// the caller can pass it back as the optimistic-concurrency base on save.
export async function getSlideHtml(
  deckId: string,
  slideId: string,
): Promise<
  | { ok: true; html: string; versionId: string | null }
  | { ok: false; error: string }
> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("canvas_deck_slide")
    .select("html_body, current_version_id")
    .eq("id", slideId)
    .eq("deck_id", deckId)
    .maybeSingle();
  if (error) {
    console.error("[getSlideHtml]", error);
    return { ok: false, error: error.message };
  }
  if (!data) return { ok: false, error: "slide_not_found" };
  return {
    ok: true,
    html: (data.html_body as string) ?? "",
    versionId: (data.current_version_id as string | null) ?? null,
  };
}

export async function restoreSnapshot(
  snapshotId: string,
  deckId: string,
): Promise<ActionResult> {
  const started = Date.now();
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const { data: deck } = await supabase
    .from("canvas_deck")
    .select("workspace_id")
    .eq("id", deckId)
    .maybeSingle();
  const workspace_id = deck?.workspace_id ?? null;

  const { data: slidesRestored, error } = await supabase.rpc("canvas_restore_snapshot", {
    _snapshot_id: snapshotId,
  });

  if (error) {
    console.error("[restoreSnapshot]", error);
    logUsage({
      event: "snapshot.restore",
      surface: "action",
      user_id: user?.id ?? null,
      workspace_id,
      deck_id: deckId,
      status: "error",
      duration_ms: Date.now() - started,
      error,
      error_code: error.code ?? "rpc_error",
      props: { snapshot_id: snapshotId },
    });
    return { ok: false, error: error.message };
  }

  logUsage({
    event: "snapshot.restore",
    surface: "action",
    user_id: user?.id ?? null,
    workspace_id,
    deck_id: deckId,
    status: "ok",
    duration_ms: Date.now() - started,
    props: {
      snapshot_id: snapshotId,
      slides_restored: typeof slidesRestored === "number" ? slidesRestored : null,
    },
  });

  revalidatePath(`/canvases/${deckId}`);
  revalidatePath(`/canvases/${deckId}/history`);
  return { ok: true };
}

// ============================================================
// Comments — pinned threads on a slide
// ============================================================
// Comments anchor to a slide via (anchor_x, anchor_y) in [0,1] coordinates
// against the slide's rendered rect (the host page converts pixels →
// fractions before calling here; see slide-comments-overlay.tsx). Null
// anchors are accepted for slide-scoped-but-unpinned threads (Claude/MCP
// originated, or deck-level) — the UI floats them in the right rail.
//
// RLS gates everything: only workspace members can read/write; only the
// author or a workspace admin can update or delete. The policy on insert
// pins `author_id = auth.uid()` and `author_kind = 'user'`, which is why
// these actions don't accept an authorKind parameter — MCP posts go through
// a different code path that uses the service-role client.

export type CreateCommentInput = {
  deckId: string;
  // null for a deck-level thread (not tied to a slide) — e.g. a reply to a
  // deck-scoped note Claude opened via MCP add_comment without a slide_id.
  slideId: string | null;
  body: string;
  anchorX: number | null;
  anchorY: number | null;
  parentId?: string | null;
};

export async function createComment(input: CreateCommentInput): Promise<
  ActionResult & { id?: string }
> {
  const started = Date.now();
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "not_authenticated" };

  const body = input.body.trim();
  if (!body) return { ok: false, error: "body_required" };

  // Replies inherit their anchor from the thread root — the table allows
  // both null and a pinned position on a reply, but the UI treats the root
  // as the source of truth, so we drop reply anchors to keep one writer per
  // value.
  const isReply = Boolean(input.parentId);
  const anchorX = isReply ? null : input.anchorX;
  const anchorY = isReply ? null : input.anchorY;
  const bothNull = anchorX == null && anchorY == null;
  const bothSet =
    typeof anchorX === "number" &&
    typeof anchorY === "number" &&
    anchorX >= 0 &&
    anchorX <= 1 &&
    anchorY >= 0 &&
    anchorY <= 1;
  if (!bothNull && !bothSet) {
    return { ok: false, error: "invalid_anchor" };
  }

  // Resolve workspace_id from the slide (slide-scoped) or the deck (deck-level
  // thread, slide_id null). RLS gates both reads by membership, so a non-member
  // sees nothing.
  let workspaceId: string | null = null;
  if (input.slideId) {
    const { data: slide } = await supabase
      .from("canvas_deck_slide")
      .select("workspace_id, deck_id")
      .eq("id", input.slideId)
      .maybeSingle();
    if (!slide?.workspace_id) return { ok: false, error: "slide_not_found" };
    if (slide.deck_id !== input.deckId)
      return { ok: false, error: "slide_deck_mismatch" };
    workspaceId = slide.workspace_id;
  } else {
    const { data: deck } = await supabase
      .from("canvas_deck")
      .select("workspace_id")
      .eq("id", input.deckId)
      .maybeSingle();
    if (!deck?.workspace_id) return { ok: false, error: "deck_not_found" };
    workspaceId = deck.workspace_id;
  }

  // For a reply, resolve the parent comment's author so we can notify them
  // (kind 'comment_reply'). Best-effort + RLS-gated: a parent we can't read
  // (or a 'claude'-authored parent, which has author_id but isn't a human to
  // ping) just yields no reply notification. We capture author_kind so an MCP/
  // Claude-authored thread doesn't generate a reply notification to a bot.
  let parentAuthorId: string | null = null;
  if (isReply && input.parentId) {
    const { data: parent } = await supabase
      .from("canvas_comment")
      .select("author_id, author_kind")
      .eq("id", input.parentId)
      .maybeSingle();
    if (parent?.author_kind === "user") {
      parentAuthorId = (parent.author_id as string | null) ?? null;
    }
  }

  // Resolve @mentions from the body against workspace members and persist the
  // matched user_ids (canvas_comment.mentions, previously never written by the
  // web path) — this lights up the handle and drives the notification feed.
  // The parse/match rules live in the pure `resolveMentions` helper (shared,
  // unit-tested), which honors two handle shapes: the unique email handle the
  // composer's autocomplete inserts (`@joao@acme.com`, resolves to exactly one
  // member) and the legacy short handle (`@joao`, first-name / local-part,
  // possibly ambiguous). Only runs when the body actually contains an "@".
  let mentions: string[] = [];
  if (body.includes("@")) {
    const { data: memberRows } = await supabase
      .from("workspace_memberships")
      .select("user_id")
      .eq("workspace_id", workspaceId);
    const memberIds = (memberRows ?? []).map((r) => r.user_id as string);
    const { data: memberUsers } = memberIds.length
      ? await supabase.from("users").select("id, name, email").in("id", memberIds)
      : {
          data: [] as { id: string; name: string | null; email: string | null }[],
        };
    mentions = resolveMentions(body, memberUsers ?? []);
  }

  const { data, error } = await supabase
    .from("canvas_comment")
    .insert({
      workspace_id: workspaceId,
      deck_id: input.deckId,
      slide_id: input.slideId,
      parent_id: input.parentId ?? null,
      author_kind: "user",
      author_id: user.id,
      body,
      anchor_x: anchorX,
      anchor_y: anchorY,
      mentions,
    })
    .select("id")
    .single();

  if (error) {
    console.error("[createComment]", error);
    logUsage({
      event: "comment.create",
      surface: "action",
      user_id: user.id,
      workspace_id: workspaceId,
      deck_id: input.deckId,
      slide_id: input.slideId,
      status: "error",
      duration_ms: Date.now() - started,
      error,
      error_code: error.code ?? "insert_error",
      props: { is_reply: isReply, has_anchor: bothSet, body_len: body.length },
    });
    return { ok: false, error: error.message };
  }

  // Deliver in-app notifications for this comment: one per resolved mention
  // (excluding the author) and a reply ping to the thread's author. Written via
  // the service-role logger because canvas_notification has no client INSERT
  // path (migration 0048). Best-effort / fire-and-forget — like logUsage, a
  // notification failure must never break the comment that just succeeded.
  logNotifications(
    notificationsForComment({
      workspaceId: workspaceId!,
      deckId: input.deckId,
      slideId: input.slideId,
      commentId: data.id,
      actorId: user.id,
      body,
      mentionedUserIds: mentions,
      parentAuthorId,
    }),
  );

  logUsage({
    event: "comment.create",
    surface: "action",
    user_id: user.id,
    workspace_id: workspaceId,
    deck_id: input.deckId,
    slide_id: input.slideId,
    status: "ok",
    duration_ms: Date.now() - started,
    props: { is_reply: isReply, has_anchor: bothSet, body_len: body.length },
  });

  revalidatePath(`/canvases/${input.deckId}`);
  return { ok: true, id: data.id };
}

export async function resolveComment(
  commentId: string,
  deckId: string,
): Promise<ActionResult> {
  const started = Date.now();
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "not_authenticated" };

  const { data: updated, error } = await supabase
    .from("canvas_comment")
    .update({
      resolved: true,
      resolved_by: user.id,
      resolved_at: new Date().toISOString(),
    })
    .eq("id", commentId)
    .select("workspace_id, slide_id")
    .maybeSingle();

  if (error) {
    console.error("[resolveComment]", error);
    logUsage({
      event: "comment.resolve",
      surface: "action",
      user_id: user.id,
      deck_id: deckId,
      status: "error",
      duration_ms: Date.now() - started,
      error,
      error_code: error.code ?? "update_error",
      props: { comment_id: commentId },
    });
    return { ok: false, error: error.message };
  }

  // RLS filters disallowed updates to 0 rows with NO error — `updated` null
  // means nothing was resolved. Reporting ok here is exactly the silent
  // failure that had a user clicking Resolve 3 times to no effect (2026-06-11)
  // while the logs said success.
  if (!updated) {
    logUsage({
      event: "comment.resolve",
      surface: "action",
      user_id: user.id,
      deck_id: deckId,
      status: "denied",
      duration_ms: Date.now() - started,
      error_code: "no_rows",
      props: { comment_id: commentId },
    });
    // "not_authorized" is the stable code the comment surfaces map to a
    // human message (same convention as deleteComment's 0-row case).
    return { ok: false, error: "not_authorized" };
  }

  logUsage({
    event: "comment.resolve",
    surface: "action",
    user_id: user.id,
    workspace_id: updated.workspace_id ?? null,
    deck_id: deckId,
    slide_id: updated.slide_id ?? null,
    status: "ok",
    duration_ms: Date.now() - started,
    props: { comment_id: commentId },
  });

  revalidatePath(`/canvases/${deckId}`);
  return { ok: true };
}

export async function unresolveComment(
  commentId: string,
  deckId: string,
): Promise<ActionResult> {
  const started = Date.now();
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const { data: updated, error } = await supabase
    .from("canvas_comment")
    .update({
      resolved: false,
      resolved_by: null,
      resolved_at: null,
    })
    .eq("id", commentId)
    .select("workspace_id, slide_id")
    .maybeSingle();

  if (error) {
    console.error("[unresolveComment]", error);
    logUsage({
      event: "comment.unresolve",
      surface: "action",
      user_id: user?.id ?? null,
      deck_id: deckId,
      status: "error",
      duration_ms: Date.now() - started,
      error,
      error_code: error.code ?? "update_error",
      props: { comment_id: commentId },
    });
    return { ok: false, error: error.message };
  }

  // Same 0-row RLS silence as resolveComment above: null `updated` = nothing
  // changed, so say so instead of reporting ok.
  if (!updated) {
    logUsage({
      event: "comment.unresolve",
      surface: "action",
      user_id: user?.id ?? null,
      deck_id: deckId,
      status: "denied",
      duration_ms: Date.now() - started,
      error_code: "no_rows",
      props: { comment_id: commentId },
    });
    return { ok: false, error: "not_authorized" };
  }

  logUsage({
    event: "comment.unresolve",
    surface: "action",
    user_id: user?.id ?? null,
    workspace_id: updated.workspace_id ?? null,
    deck_id: deckId,
    slide_id: updated.slide_id ?? null,
    status: "ok",
    duration_ms: Date.now() - started,
    props: { comment_id: commentId },
  });

  revalidatePath(`/canvases/${deckId}`);
  return { ok: true };
}

export async function deleteComment(
  commentId: string,
  deckId: string,
): Promise<ActionResult> {
  const started = Date.now();
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  // RLS (0036) allows any full workspace member, or the author for guests;
  // relying on the policy means we don't duplicate the rule here. A caller
  // outside it gets 0 rows affected, which we surface as not_authorized.
  const { data: deleted, error } = await supabase
    .from("canvas_comment")
    .delete()
    .eq("id", commentId)
    .select("id, workspace_id, slide_id");

  if (error) {
    console.error("[deleteComment]", error);
    logUsage({
      event: "comment.delete",
      surface: "action",
      user_id: user?.id ?? null,
      deck_id: deckId,
      status: "error",
      duration_ms: Date.now() - started,
      error,
      error_code: error.code ?? "delete_error",
      props: { comment_id: commentId },
    });
    return { ok: false, error: error.message };
  }
  if (!deleted || deleted.length === 0) {
    logUsage({
      event: "comment.delete",
      surface: "action",
      user_id: user?.id ?? null,
      deck_id: deckId,
      status: "denied",
      duration_ms: Date.now() - started,
      error_code: "not_authorized",
      props: { comment_id: commentId },
    });
    return { ok: false, error: "not_authorized" };
  }

  logUsage({
    event: "comment.delete",
    surface: "action",
    user_id: user?.id ?? null,
    workspace_id: deleted[0]?.workspace_id ?? null,
    deck_id: deckId,
    slide_id: deleted[0]?.slide_id ?? null,
    status: "ok",
    duration_ms: Date.now() - started,
    props: { comment_id: commentId },
  });

  revalidatePath(`/canvases/${deckId}`);
  return { ok: true };
}

export async function renameDeck(
  deckId: string,
  newTitle: string,
): Promise<ActionResult> {
  // Mirrors deleteDeck's auth model: the user's RLS-aware client runs the
  // UPDATE; the policy "creators and admins update canvas decks" decides
  // whether the row is reachable. A non-creator non-admin will get zero rows
  // affected, which we surface as `not_authorized` rather than reporting a
  // phantom success.
  const started = Date.now();
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "not_authenticated" };

  const trimmed = newTitle.trim();
  if (!trimmed) return { ok: false, error: "title_required" };
  if (trimmed.length > 200) return { ok: false, error: "title_too_long" };

  const { data: deck } = await supabase
    .from("canvas_deck")
    .select("workspace_id")
    .eq("id", deckId)
    .maybeSingle();
  const workspace_id = deck?.workspace_id ?? null;

  const { data: updated, error } = await supabase
    .from("canvas_deck")
    .update({ title: trimmed })
    .eq("id", deckId)
    .select("id");

  if (error) {
    console.error("[renameDeck]", error);
    logUsage({
      event: "deck.rename",
      surface: "action",
      user_id: user.id,
      workspace_id,
      deck_id: deckId,
      status: "error",
      duration_ms: Date.now() - started,
      error,
      error_code: error.code ?? "update_error",
    });
    return { ok: false, error: error.message };
  }
  if (!updated || updated.length === 0) {
    logUsage({
      event: "deck.rename",
      surface: "action",
      user_id: user.id,
      workspace_id,
      deck_id: deckId,
      status: "denied",
      duration_ms: Date.now() - started,
      error_code: "not_authorized",
    });
    return { ok: false, error: "not_authorized" };
  }

  logUsage({
    event: "deck.rename",
    surface: "action",
    user_id: user.id,
    workspace_id,
    deck_id: deckId,
    status: "ok",
    duration_ms: Date.now() - started,
    props: { title_len: trimmed.length },
  });

  revalidatePath(`/canvases/${deckId}`);
  revalidatePath("/canvases");
  return { ok: true };
}

export async function duplicateDeck(
  deckId: string,
): Promise<ActionResult & { newDeckId?: string }> {
  // Clones the deck shell — theme_css, nav_js, meta, title — plus every slide
  // (position, title, html_body, slide_styles) into a brand-new
  // canvas_deck row. Snapshots, version history, comments, locks, and
  // proposals do NOT copy: the duplicate is a fresh deck that starts its
  // own version chain.
  //
  // Auth: reads use the user's RLS-aware client (workspace membership
  // gates visibility). Writes use the same client too, so the same RLS
  // policies that block "members create canvas decks" / "members create
  // slides" apply.
  //
  // Assets: slide HTML may reference /api/canvas/asset/{id} URLs whose
  // backing rows live under the original deck. Those URLs continue to
  // resolve for any workspace member, so the duplicate renders correctly
  // without re-uploading bytes. If the original deck is later deleted the
  // duplicate's images would go away too — an acceptable tradeoff for
  // now, documented in the report.
  const started = Date.now();
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "not_authenticated" };

  const { data: deck, error: deckErr } = await supabase
    .from("canvas_deck")
    .select(
      "id, workspace_id, title, theme_css, nav_js, meta, client_id, proposal_id, project_id",
    )
    .eq("id", deckId)
    .maybeSingle();
  if (deckErr) {
    console.error("[duplicateDeck] deck lookup", deckErr);
    return { ok: false, error: deckErr.message };
  }
  if (!deck) return { ok: false, error: "deck_not_found" };

  const { data: slides, error: slidesErr } = await supabase
    .from("canvas_deck_slide")
    .select("position, title, html_body, slide_styles")
    .eq("deck_id", deckId)
    .order("position", { ascending: true });
  if (slidesErr) {
    console.error("[duplicateDeck] slide lookup", slidesErr);
    return { ok: false, error: slidesErr.message };
  }

  const newTitle = `${deck.title} (copy)`;
  const { data: newDeck, error: insertErr } = await supabase
    .from("canvas_deck")
    .insert({
      workspace_id: deck.workspace_id,
      client_id: deck.client_id,
      proposal_id: deck.proposal_id,
      project_id: deck.project_id,
      title: newTitle,
      theme_css: deck.theme_css,
      nav_js: deck.nav_js,
      meta: deck.meta,
      created_by: user.id,
    })
    .select("id")
    .single();

  if (insertErr || !newDeck) {
    console.error("[duplicateDeck] insert", insertErr);
    logUsage({
      event: "deck.duplicate",
      surface: "action",
      user_id: user.id,
      workspace_id: deck.workspace_id,
      deck_id: deckId,
      status: "error",
      duration_ms: Date.now() - started,
      error_code: insertErr?.code ?? "insert_error",
    });
    return { ok: false, error: insertErr?.message ?? "insert_failed" };
  }

  const newDeckId = newDeck.id as string;

  if (slides && slides.length > 0) {
    const slideRows = slides.map((s) => ({
      workspace_id: deck.workspace_id,
      deck_id: newDeckId,
      position: s.position,
      title: s.title,
      html_body: s.html_body,
      slide_styles: s.slide_styles,
      created_by: user.id,
    }));
    const { error: slideInsertErr } = await supabase
      .from("canvas_deck_slide")
      .insert(slideRows);
    if (slideInsertErr) {
      // Best-effort cleanup — drop the half-created deck so we don't leak.
      await supabase.from("canvas_deck").delete().eq("id", newDeckId);
      console.error("[duplicateDeck] slide insert", slideInsertErr);
      logUsage({
        event: "deck.duplicate",
        surface: "action",
        user_id: user.id,
        workspace_id: deck.workspace_id,
        deck_id: deckId,
        status: "error",
        duration_ms: Date.now() - started,
        error: slideInsertErr,
        error_code: slideInsertErr.code ?? "slide_insert_error",
      });
      return { ok: false, error: slideInsertErr.message };
    }
  }

  logUsage({
    event: "deck.duplicate",
    surface: "action",
    user_id: user.id,
    workspace_id: deck.workspace_id,
    deck_id: deckId,
    status: "ok",
    duration_ms: Date.now() - started,
    props: {
      new_deck_id: newDeckId,
      slides_copied: slides?.length ?? 0,
    },
  });

  revalidatePath("/canvases");
  return { ok: true, newDeckId };
}

// ============================================================
// Sharing — per-deck visibility + member ACL
// ============================================================
// Backs the "Share" dialog on the deck editor. Visibility flips the deck
// between 'workspace' (everyone in the workspace) and 'private' (only the
// explicit canvas_deck_member entries plus workspace admins). Adding /
// removing / changing roles writes through the user's RLS-aware client so
// the policies on canvas_deck_member ("editors and admins …") are the
// authoritative check.

export type DeckVisibility = "workspace" | "private";
// Editorial state of a deck, set from the editor's deck overflow menu.
// Mirrors the canvas_deck.status CHECK.
export type DeckStatus = "draft" | "in_review" | "final";
export type DeckMemberRole = "viewer" | "editor";

export type DeckShareCandidate = {
  user_id: string;
  email: string | null;
  name: string | null;
  workspace_role: "owner" | "admin" | "member" | string;
  // Present when the user is already on the deck; null when they're just a
  // workspace member available to invite.
  deck_role: DeckMemberRole | null;
};

// A pending invite for an outside reviewer (workspace_role 'guest') scoped to
// this deck. Surfaced under "People with access" as not-yet-accepted so the
// inviter can see it's in flight and revoke it.
export type DeckGuestInvite = {
  id: string;
  email: string;
  deck_role: DeckMemberRole;
};

export type DeckShareState = {
  ok: true;
  visibility: DeckVisibility;
  candidates: DeckShareCandidate[];
  guestInvites: DeckGuestInvite[];
  // True when the viewer can edit the deck — gates the manage-only affordances
  // (inviting/revoking outside reviewers). Mutations are still RLS-enforced.
  canManage: boolean;
  // Public "anyone with the link can view" state. enabled mirrors a non-null
  // canvas_deck.public_share_token; url is the absolute /p/{token} link (null
  // when disabled). Anyone who can open the dialog sees the state; only
  // managers can toggle it.
  publicShareEnabled: boolean;
  publicShareUrl: string | null;
  // Stricter than canManage: public links can be managed only by full workspace
  // members with edit access, not deck-scoped guests.
  canManagePublicShare: boolean;
  // Engagement rollup for the public link (migration 0063): total opens and
  // the most recent one. Null last-open when the link was never opened.
  // Directional, self-reported numbers — see /canvases/{id}/engagement.
  publicOpens: number;
  publicLastOpenedAt: string | null;
  // Guest commenting on the public link (migration 0064). Off by default;
  // only meaningful while the link itself is on.
  publicCommentsEnabled: boolean;
} | { ok: false; error: string };

// Server-minted, unguessable view-only capability. 24 random bytes -> 32
// url-safe chars (192 bits); see migration 0027 + the /p/{token} viewer.
function newPublicShareToken(): string {
  return randomBytes(24).toString("base64url");
}

function publicShareUrlFor(baseUrl: string, token: string): string {
  return `${baseUrl}/p/${token}`;
}

// Who may turn a deck's public link on/off/rotate. A deck-scoped guest (an
// outside reviewer, migration 0025) can hold an editor seat on ONE deck, which
// passes canvas_can_edit_deck — but making that deck world-readable is a much
// broader act than editing it. So we require BOTH deck-edit rights AND a FULL
// workspace membership (owner/admin/member), which excludes guests. For an
// internal editor this is identical to the plain edit check.
async function callerCanManagePublicShare(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
  deckId: string,
  workspaceId: string,
): Promise<boolean> {
  const { data: canEdit } = await supabase.rpc("canvas_can_edit_deck", {
    _deck_id: deckId,
  });
  if (canEdit !== true) return false;
  // A guest can read its own membership row (migration 0025), so this resolves
  // for every caller that got this far.
  const { data: membership } = await supabase
    .from("workspace_memberships")
    .select("role")
    .eq("user_id", userId)
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  const role = membership?.role;
  return role === "owner" || role === "admin" || role === "member";
}

export async function getDeckShareState(deckId: string): Promise<DeckShareState> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "not_authenticated" };

  const { data: deck, error: deckErr } = await supabase
    .from("canvas_deck")
    .select("id, workspace_id, visibility, public_share_token, public_comments_enabled")
    .eq("id", deckId)
    .maybeSingle();
  if (deckErr) {
    console.error("[getDeckShareState] deck", deckErr);
    return { ok: false, error: deckErr.message };
  }
  if (!deck) return { ok: false, error: "deck_not_found" };

  const { data: memberships, error: memErr } = await supabase
    .from("workspace_memberships")
    .select("user_id, role")
    .eq("workspace_id", deck.workspace_id);
  if (memErr) {
    console.error("[getDeckShareState] memberships", memErr);
    return { ok: false, error: memErr.message };
  }

  const userIds = (memberships ?? []).map((m) => m.user_id);
  const profiles = userIds.length > 0
    ? (await supabase.from("users").select("id, email, name").in("id", userIds)).data ?? []
    : [];
  const profileById = new Map(
    profiles.map((p) => [p.id, { email: p.email as string | null, name: (p.name as string | null) ?? null }]),
  );

  const { data: deckMembers, error: dmErr } = await supabase
    .from("canvas_deck_member")
    .select("user_id, role")
    .eq("deck_id", deckId);
  if (dmErr) {
    console.error("[getDeckShareState] deck members", dmErr);
    return { ok: false, error: dmErr.message };
  }
  const deckRoleById = new Map<string, DeckMemberRole>(
    (deckMembers ?? []).map((m) => [m.user_id as string, m.role as DeckMemberRole]),
  );

  const candidates: DeckShareCandidate[] = (memberships ?? [])
    .map((m) => {
      const profile = profileById.get(m.user_id);
      return {
        user_id: m.user_id as string,
        email: profile?.email ?? null,
        name: profile?.name ?? null,
        workspace_role: m.role as string,
        deck_role: deckRoleById.get(m.user_id as string) ?? null,
      };
    })
    // Outside reviewers (workspace_role 'guest') are scoped to a single deck —
    // never offer them in the general "Add from this workspace" picker. Only
    // keep a guest if they're already on THIS deck (so they still show under
    // "People with access").
    .filter((c) => c.workspace_role !== "guest" || c.deck_role != null);

  // Stable order: invited people first (editor, then viewer), then the rest
  // alphabetically by name/email. Makes the dialog scan-friendly for the
  // common "who already has access" question.
  const roleWeight: Record<string, number> = { editor: 0, viewer: 1 };
  candidates.sort((a, b) => {
    const ar = a.deck_role ? roleWeight[a.deck_role] : 2;
    const br = b.deck_role ? roleWeight[b.deck_role] : 2;
    if (ar !== br) return ar - br;
    const an = (a.name || a.email || "").toLowerCase();
    const bn = (b.name || b.email || "").toLowerCase();
    return an.localeCompare(bn);
  });

  // Pending guest invites for this deck — only meaningful to (and only shown
  // to) someone who can edit the deck. Read via the admin client because the
  // workspace_invites SELECT policy is admin-only, but a deck editor who isn't
  // a workspace admin still manages their own deck's invites.
  let guestInvites: DeckGuestInvite[] = [];
  const { data: canEdit } = await supabase.rpc("canvas_can_edit_deck", {
    _deck_id: deckId,
  });
  if (canEdit === true) {
    const admin = createAdminClient();
    const { data: invites } = await admin
      .from("workspace_invites")
      .select("id, email, deck_role")
      .eq("deck_id", deckId)
      .is("accepted_at", null);
    guestInvites = (invites ?? []).map((i) => ({
      id: i.id as string,
      email: i.email as string,
      deck_role: (i.deck_role as DeckMemberRole) ?? "viewer",
    }));
  }

  // Resolve the absolute public link only when sharing is on AND the caller can
  // manage the deck. The token IS the capability — a view-only collaborator
  // shouldn't be handed it to re-propagate public access, so non-managers see
  // only the on/off state, never the URL itself.
  const publicToken = (deck.public_share_token as string | null) ?? null;
  const canManagePublicShare = await callerCanManagePublicShare(
    supabase,
    user.id,
    deckId,
    deck.workspace_id as string,
  );
  let publicShareUrl: string | null = null;
  if (publicToken && canManagePublicShare) {
    publicShareUrl = publicShareUrlFor(await resolveAppBaseUrl(), publicToken);
  }

  // Opens rollup for the "12 opens · last opened 2h ago" line. Read through
  // the admin client (usage events have admin-only SELECT); the deck read
  // above already proved the caller can see this deck. Failures degrade to
  // zero — the dialog must never break on telemetry.
  let publicOpens = 0;
  let publicLastOpenedAt: string | null = null;
  if (publicToken != null) {
    const admin = createAdminClient();
    const { data: lastOpen, count } = await admin
      .from("canvas_usage_event")
      .select("created_at", { count: "exact" })
      .eq("deck_id", deckId)
      .eq("surface", "public")
      .eq("event", "public_view.open")
      .order("created_at", { ascending: false })
      .limit(1);
    publicOpens = count ?? 0;
    publicLastOpenedAt = (lastOpen?.[0]?.created_at as string | undefined) ?? null;
  }

  return {
    ok: true,
    visibility: (deck.visibility as DeckVisibility) ?? "workspace",
    candidates,
    guestInvites,
    canManage: canEdit === true,
    publicShareEnabled: publicToken != null,
    publicShareUrl,
    canManagePublicShare,
    publicOpens,
    publicLastOpenedAt,
    publicCommentsEnabled: deck.public_comments_enabled === true,
  };
}

// Turn guest commenting on the public link on/off. Same authorization rule
// as the link itself (callerCanManagePublicShare): making a deck accept
// anonymous writes is a broader act than editing it. The UPDATE runs through
// the caller's RLS client and the zero-row result is treated as denial —
// never a silent success (the resolveComment lesson).
export async function setDeckPublicComments(
  deckId: string,
  enabled: boolean,
): Promise<ActionResult> {
  const started = Date.now();
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "not_authenticated" };

  const { data: deck } = await supabase
    .from("canvas_deck")
    .select("workspace_id, public_share_token")
    .eq("id", deckId)
    .maybeSingle();
  if (!deck?.workspace_id) return { ok: false, error: "deck_not_found" };
  const workspace_id = deck.workspace_id as string;

  const canManage = await callerCanManagePublicShare(
    supabase,
    user.id,
    deckId,
    workspace_id,
  );
  if (!canManage) {
    logUsage({
      event: "deck.public_comments",
      surface: "action",
      user_id: user.id,
      workspace_id,
      deck_id: deckId,
      status: "denied",
      duration_ms: Date.now() - started,
      error_code: "not_authorized",
      props: { enabled },
    });
    return {
      ok: false,
      error: "Only workspace members with edit access can change guest comments.",
    };
  }
  // Commenting requires a live link to hang off — refuse to arm the write
  // path on a deck that isn't publicly shared at all.
  if (enabled && !deck.public_share_token) {
    return { ok: false, error: "Turn on the public link first." };
  }

  const { data: updated, error } = await supabase
    .from("canvas_deck")
    .update({ public_comments_enabled: enabled })
    .eq("id", deckId)
    .select("id");
  if (error) {
    console.error("[setDeckPublicComments]", error);
    logUsage({
      event: "deck.public_comments",
      surface: "action",
      user_id: user.id,
      workspace_id,
      deck_id: deckId,
      status: "error",
      duration_ms: Date.now() - started,
      error,
      error_code: error.code ?? "update_error",
      props: { enabled },
    });
    return { ok: false, error: error.message };
  }
  if (!updated || updated.length === 0) {
    return { ok: false, error: "not_authorized" };
  }

  logUsage({
    event: "deck.public_comments",
    surface: "action",
    user_id: user.id,
    workspace_id,
    deck_id: deckId,
    status: "ok",
    duration_ms: Date.now() - started,
    props: { enabled },
  });
  revalidatePath(`/canvases/${deckId}`);
  return { ok: true };
}

// --- Cross-deck slide copy (slide library v0) -------------------------------
//
// "Insert the team slide from the intro deck." The UI picker lists the decks
// the caller can already read (plain RLS — no new permission surface), and
// the copy itself is a DIRECT additive insert via canvas_create_slide_direct
// (the ADR-0012 precedent: additive, non-clobbering ops skip the proposal).
// Asset URLs ship verbatim: the preview/export routes HMAC-sign each
// /api/canvas/asset/{id} URL after passing RLS on the containing deck, so the
// copied slide's images render there. Asset SELECT is per-deck
// (canvas_can_read_deck since 0015), so an image from a PRIVATE source deck
// only inlines for viewers who can read that source.

export type CopySourceDeck = {
  id: string;
  title: string;
  slides: { id: string; position: number; title: string }[];
};

export type CopySourcesResult =
  | { ok: true; decks: CopySourceDeck[] }
  | { ok: false; error: string };

export async function listCopySources(
  currentDeckId: string,
): Promise<CopySourcesResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "not_authenticated" };

  // Everything the caller can read except the deck being edited; RLS is the
  // filter. Recency-ordered and capped — this is a picker, not a browser.
  // Archived decks are excluded (0074): they're shelved out of the browse/pick
  // surfaces, and since archiving bumps updated_at they'd otherwise jump to the
  // top of this recency-ordered list — the opposite of decluttering. Copy from
  // an archived deck by unarchiving it first.
  const { data: decks, error: decksErr } = await supabase
    .from("canvas_deck")
    .select("id, title")
    .neq("id", currentDeckId)
    .is("archived_at", null)
    .order("updated_at", { ascending: false })
    .limit(30);
  if (decksErr) {
    console.error("[listCopySources]", decksErr);
    return { ok: false, error: decksErr.message };
  }
  const deckRows = decks ?? [];
  if (deckRows.length === 0) return { ok: true, decks: [] };

  const { data: slides, error: slidesErr } = await supabase
    .from("canvas_deck_slide")
    .select("id, deck_id, position, title")
    .in("deck_id", deckRows.map((d) => d.id))
    .order("position", { ascending: true });
  if (slidesErr) {
    console.error("[listCopySources:slides]", slidesErr);
    return { ok: false, error: slidesErr.message };
  }

  const byDeck = new Map<string, CopySourceDeck["slides"]>();
  for (const s of slides ?? []) {
    const bucket = byDeck.get(s.deck_id as string) ?? [];
    bucket.push({
      id: s.id as string,
      position: s.position as number,
      title: (s.title as string) ?? "",
    });
    byDeck.set(s.deck_id as string, bucket);
  }

  return {
    ok: true,
    decks: deckRows
      .map((d) => ({
        id: d.id as string,
        title: d.title as string,
        slides: byDeck.get(d.id as string) ?? [],
      }))
      .filter((d) => d.slides.length > 0),
  };
}

export type CopySlideResult =
  | { ok: true; slideId: string }
  | { ok: false; error: string };

export async function copySlideFromDeck(
  sourceSlideId: string,
  destDeckId: string,
): Promise<CopySlideResult> {
  const started = Date.now();
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "not_authenticated" };

  // Read gate = RLS: a slide the caller can't read simply comes back null.
  const { data: source, error: sourceErr } = await supabase
    .from("canvas_deck_slide")
    .select("id, deck_id, workspace_id, title, html_body, slide_styles, current_version_id")
    .eq("id", sourceSlideId)
    .maybeSingle();
  if (sourceErr) {
    console.error("[copySlideFromDeck]", sourceErr);
    return { ok: false, error: sourceErr.message };
  }
  if (!source) return { ok: false, error: "Source slide not found." };

  // Same-workspace only: cross-workspace copies would strand asset URLs —
  // asset SELECT is gated per source deck (canvas_can_read_deck), and a deck in
  // another workspace is never readable, so its images could never inline.
  const { data: dest } = await supabase
    .from("canvas_deck")
    .select("id, workspace_id")
    .eq("id", destDeckId)
    .maybeSingle();
  if (!dest) return { ok: false, error: "Destination deck not found." };
  if (dest.workspace_id !== source.workspace_id) {
    return { ok: false, error: "Slides can only be copied within a workspace." };
  }

  // Direct additive insert at the end of the deck; the RPC owns the edit gate
  // (canvas_can_edit_deck) and the position shuffle. Speaker notes do NOT
  // travel with a copy — canvas_create_slide_direct has no notes param.
  const { data: created, error } = await supabase.rpc("canvas_create_slide_direct", {
    _deck_id: destDeckId,
    _position: null,
    _title: (source.title as string) ?? "",
    _html_body: source.html_body as string,
    _slide_styles: (source.slide_styles as string | null) ?? "",
  });
  if (error) {
    console.error("[copySlideFromDeck:rpc]", error);
    logUsage({
      event: "slide.copy_from_deck",
      surface: "action",
      user_id: user.id,
      workspace_id: source.workspace_id as string,
      deck_id: destDeckId,
      status: "error",
      duration_ms: Date.now() - started,
      error,
      error_code: error.code ?? "rpc_error",
    });
    return {
      ok: false,
      error: error.message.includes("not_authorized")
        ? "You don't have edit access to this deck."
        : "Copy failed — try again.",
    };
  }

  // A function returning a single composite comes back as the row object (not a
  // one-element array); normalize either shape defensively (mirrors
  // createSlideDirect). Reading `.id` off the raw array would strand a real
  // insert as a false failure.
  const row = (Array.isArray(created) ? created[0] : created) as
    | { id: string; position: number }
    | null;
  const newSlideId = row?.id ?? null;

  const provenance = {
    source_deck_id: source.deck_id,
    source_slide_id: source.id,
    source_version_id: source.current_version_id,
  };

  if (!newSlideId) {
    // The RPC didn't error but resolved no slide id — a real failure, so it
    // must be logged as one (not the success path) and reported to the caller.
    console.error("[copySlideFromDeck] RPC returned no slide id", created);
    logUsage({
      event: "slide.copy_from_deck",
      surface: "action",
      user_id: user.id,
      workspace_id: source.workspace_id as string,
      deck_id: destDeckId,
      status: "error",
      duration_ms: Date.now() - started,
      error_code: "no_slide_id",
      props: provenance,
    });
    return { ok: false, error: "Copy failed — try again." };
  }

  // Provenance trail: the copy is a fork; the exact source version is pinned
  // in telemetry (queryable), since the direct RPC has no provenance columns.
  logUsage({
    event: "slide.copy_from_deck",
    surface: "action",
    user_id: user.id,
    workspace_id: source.workspace_id as string,
    deck_id: destDeckId,
    slide_id: newSlideId,
    status: "ok",
    duration_ms: Date.now() - started,
    props: provenance,
  });

  revalidatePath(`/canvases/${destDeckId}`);
  return { ok: true, slideId: newSlideId };
}

export type PublicShareResult =
  | { ok: true; enabled: boolean; url: string | null }
  | { ok: false; error: string };

// Enable or disable the deck's public "anyone with the link can view" share.
// Enabling reuses the existing token if there is one (idempotent — the link is
// stable across repeated enables) and mints a fresh one otherwise. Disabling
// nulls the token, which makes every previously-shared URL 404 immediately.
//
// Authorization: gated by canvas_can_edit_deck (the same rule that governs
// visibility + guest invites), and the UPDATE itself runs through the caller's
// RLS-aware client so the "editors and admins update decks" policy is the
// authoritative check — a non-editor's UPDATE matches zero rows.
export async function setDeckPublicShare(
  deckId: string,
  enabled: boolean,
): Promise<PublicShareResult> {
  const started = Date.now();
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "not_authenticated" };

  const { data: deck } = await supabase
    .from("canvas_deck")
    .select("workspace_id, public_share_token")
    .eq("id", deckId)
    .maybeSingle();
  if (!deck?.workspace_id) return { ok: false, error: "deck_not_found" };
  const workspace_id = deck.workspace_id as string;

  const canManage = await callerCanManagePublicShare(
    supabase,
    user.id,
    deckId,
    workspace_id,
  );
  if (!canManage) {
    logUsage({
      event: "deck.public_share",
      surface: "action",
      user_id: user.id,
      workspace_id,
      deck_id: deckId,
      status: "denied",
      duration_ms: Date.now() - started,
      error_code: "not_authorized",
      props: { enabled },
    });
    return {
      ok: false,
      error:
        "Only workspace members with edit access can change the public link.",
    };
  }

  if (!enabled) {
    const { data: updated, error } = await supabase
      .from("canvas_deck")
      .update({ public_share_token: null })
      .eq("id", deckId)
      .select("id");
    if (error) {
      console.error("[setDeckPublicShare] disable", error);
      logUsage({
        event: "deck.public_share",
        surface: "action",
        user_id: user.id,
        workspace_id,
        deck_id: deckId,
        status: "error",
        duration_ms: Date.now() - started,
        error,
        error_code: error.code ?? "update_error",
        props: { enabled },
      });
      return { ok: false, error: error.message };
    }
    if (!updated || updated.length === 0) {
      return { ok: false, error: "not_authorized" };
    }
    logUsage({
      event: "deck.public_share",
      surface: "action",
      user_id: user.id,
      workspace_id,
      deck_id: deckId,
      status: "ok",
      duration_ms: Date.now() - started,
      props: { enabled: false },
    });
    revalidatePath(`/canvases/${deckId}`);
    revalidatePath("/canvases");
    return { ok: true, enabled: false, url: null };
  }

  // Enable: reuse an existing token so the link stays stable; mint one if not.
  const existing = (deck.public_share_token as string | null) ?? null;
  const token = existing ?? newPublicShareToken();
  if (!existing) {
    const { data: updated, error } = await supabase
      .from("canvas_deck")
      .update({ public_share_token: token })
      .eq("id", deckId)
      .select("id");
    if (error) {
      console.error("[setDeckPublicShare] enable", error);
      logUsage({
        event: "deck.public_share",
        surface: "action",
        user_id: user.id,
        workspace_id,
        deck_id: deckId,
        status: "error",
        duration_ms: Date.now() - started,
        // 23505 = the (astronomically unlikely) token collision on the unique
        // index. Surface it plainly; the caller can simply retry.
        error,
        error_code: error.code ?? "update_error",
        props: { enabled, duplicate: error.code === "23505" },
      });
      return { ok: false, error: error.message };
    }
    if (!updated || updated.length === 0) {
      return { ok: false, error: "not_authorized" };
    }
  }

  logUsage({
    event: "deck.public_share",
    surface: "action",
    user_id: user.id,
    workspace_id,
    deck_id: deckId,
    status: "ok",
    duration_ms: Date.now() - started,
    props: { enabled: true, reused: Boolean(existing) },
  });
  revalidatePath(`/canvases/${deckId}`);
  revalidatePath("/canvases");
  return {
    ok: true,
    enabled: true,
    url: publicShareUrlFor(await resolveAppBaseUrl(), token),
  };
}

// Rotate the public link: mint a fresh token, which revokes the old URL (it
// will 404) and returns the new one. The Google-Slides "reset link" affordance,
// for when an old link has spread too far. Only meaningful while sharing is on.
export async function rotateDeckPublicShareLink(
  deckId: string,
): Promise<PublicShareResult> {
  const started = Date.now();
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "not_authenticated" };

  const { data: deck } = await supabase
    .from("canvas_deck")
    .select("workspace_id")
    .eq("id", deckId)
    .maybeSingle();
  if (!deck?.workspace_id) return { ok: false, error: "deck_not_found" };
  const workspace_id = deck.workspace_id as string;

  const canManage = await callerCanManagePublicShare(
    supabase,
    user.id,
    deckId,
    workspace_id,
  );
  if (!canManage) {
    return {
      ok: false,
      error:
        "Only workspace members with edit access can reset the public link.",
    };
  }

  const token = newPublicShareToken();
  const { data: updated, error } = await supabase
    .from("canvas_deck")
    .update({ public_share_token: token })
    .eq("id", deckId)
    .select("id");
  if (error) {
    console.error("[rotateDeckPublicShareLink]", error);
    logUsage({
      event: "deck.public_share_rotate",
      surface: "action",
      user_id: user.id,
      workspace_id,
      deck_id: deckId,
      status: "error",
      duration_ms: Date.now() - started,
      error,
      error_code: error.code ?? "update_error",
    });
    return { ok: false, error: error.message };
  }
  if (!updated || updated.length === 0) {
    return { ok: false, error: "not_authorized" };
  }

  logUsage({
    event: "deck.public_share_rotate",
    surface: "action",
    user_id: user.id,
    workspace_id,
    deck_id: deckId,
    status: "ok",
    duration_ms: Date.now() - started,
  });
  revalidatePath(`/canvases/${deckId}`);
  revalidatePath("/canvases");
  return {
    ok: true,
    enabled: true,
    url: publicShareUrlFor(await resolveAppBaseUrl(), token),
  };
}

export async function setDeckVisibility(
  deckId: string,
  visibility: DeckVisibility,
): Promise<ActionResult> {
  const started = Date.now();
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "not_authenticated" };

  const { data: deck } = await supabase
    .from("canvas_deck")
    .select("workspace_id")
    .eq("id", deckId)
    .maybeSingle();
  const workspace_id = deck?.workspace_id ?? null;

  const { data: updated, error } = await supabase
    .from("canvas_deck")
    .update({ visibility })
    .eq("id", deckId)
    .select("id");

  if (error) {
    console.error("[setDeckVisibility]", error);
    logUsage({
      event: "deck.set_visibility",
      surface: "action",
      user_id: user.id,
      workspace_id,
      deck_id: deckId,
      status: "error",
      duration_ms: Date.now() - started,
      error,
      error_code: error.code ?? "update_error",
      props: { visibility },
    });
    return { ok: false, error: error.message };
  }
  if (!updated || updated.length === 0) {
    logUsage({
      event: "deck.set_visibility",
      surface: "action",
      user_id: user.id,
      workspace_id,
      deck_id: deckId,
      status: "denied",
      duration_ms: Date.now() - started,
      error_code: "not_authorized",
      props: { visibility },
    });
    return { ok: false, error: "not_authorized" };
  }

  logUsage({
    event: "deck.set_visibility",
    surface: "action",
    user_id: user.id,
    workspace_id,
    deck_id: deckId,
    status: "ok",
    duration_ms: Date.now() - started,
    props: { visibility },
  });

  revalidatePath(`/canvases/${deckId}`);
  revalidatePath("/canvases");
  return { ok: true };
}

// Set a deck's editorial status (draft → in review → final). Near-exact copy of
// setDeckVisibility: it writes through the user's RLS-aware client so the
// canvas_deck UPDATE policy is the authoritative check — a zero-rows result
// means RLS hid/blocked the row, which we surface as "not_authorized".
export async function setDeckStatus(
  deckId: string,
  status: DeckStatus,
): Promise<ActionResult> {
  // Validate up front so a bad client can't reach the DB CHECK with garbage.
  if (status !== "draft" && status !== "in_review" && status !== "final") {
    return { ok: false, error: "invalid_status" };
  }

  const started = Date.now();
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "not_authenticated" };

  const { data: deck } = await supabase
    .from("canvas_deck")
    .select("workspace_id")
    .eq("id", deckId)
    .maybeSingle();
  const workspace_id = deck?.workspace_id ?? null;

  const { data: updated, error } = await supabase
    .from("canvas_deck")
    .update({ status })
    .eq("id", deckId)
    .select("id");

  if (error) {
    console.error("[setDeckStatus]", error);
    logUsage({
      event: "deck.set_status",
      surface: "action",
      user_id: user.id,
      workspace_id,
      deck_id: deckId,
      status: "error",
      duration_ms: Date.now() - started,
      error,
      error_code: error.code ?? "update_error",
      props: { status },
    });
    return { ok: false, error: error.message };
  }
  if (!updated || updated.length === 0) {
    logUsage({
      event: "deck.set_status",
      surface: "action",
      user_id: user.id,
      workspace_id,
      deck_id: deckId,
      status: "denied",
      duration_ms: Date.now() - started,
      error_code: "not_authorized",
      props: { status },
    });
    return { ok: false, error: "not_authorized" };
  }

  logUsage({
    event: "deck.set_status",
    surface: "action",
    user_id: user.id,
    workspace_id,
    deck_id: deckId,
    status: "ok",
    duration_ms: Date.now() - started,
    props: { status },
  });

  revalidatePath(`/canvases/${deckId}`);
  revalidatePath("/canvases");
  return { ok: true };
}

// Archive / unarchive a deck (migration 0074). Another near-exact copy of
// setDeckStatus: a single nullable-timestamp column write through the user's
// RLS-aware client, so the canvas_deck UPDATE policy is the authoritative gate
// (a zero-rows result means RLS blocked the row → "not_authorized"). Archiving
// is reversible and access-preserving — it only hides the deck from the default
// /canvases list and MCP list_decks; it never changes visibility or revokes a
// public link. `archived_at` records WHEN so the archived view can order by it
// and show "Archived {relativeDate}".
export async function setDeckArchived(
  deckId: string,
  archived: boolean,
): Promise<ActionResult> {
  const started = Date.now();
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "not_authenticated" };

  // Authorize creator-or-admin IN CODE — not via RLS alone. Archiving removes
  // the deck from EVERYONE's active list (delete-like blast radius, minus the
  // destruction), so it's creator/admin-only, matching the Delete gate and the
  // UI's `canManageDeck`. The shared canvas_deck UPDATE policy also admits
  // deck-editor members and Postgres RLS isn't column-scoped, so — exactly like
  // setDeckAgentFastLane — without this check a non-creator editor could
  // archive. (setDeckStatus / setDeckVisibility stay editor-level by design;
  // archive is deliberately tighter.)
  const { data: deck } = await supabase
    .from("canvas_deck")
    .select("workspace_id, created_by")
    .eq("id", deckId)
    .maybeSingle();
  const workspace_id = deck?.workspace_id ?? null;
  if (!deck?.workspace_id) {
    // Deck missing or RLS-hidden from the caller — indistinguishable, and both
    // mean "you can't act on this".
    return { ok: false, error: "not_authorized" };
  }
  let authorized = deck.created_by === user.id;
  if (!authorized) {
    const { data: isAdmin, error: rpcErr } = await supabase.rpc(
      "is_workspace_admin_or_owner",
      { _workspace_id: deck.workspace_id },
    );
    if (rpcErr) {
      console.error("[setDeckArchived] rpc", rpcErr);
      return { ok: false, error: rpcErr.message };
    }
    authorized = Boolean(isAdmin);
  }
  if (!authorized) {
    logUsage({
      event: "deck.set_archived",
      surface: "action",
      user_id: user.id,
      workspace_id,
      deck_id: deckId,
      status: "denied",
      duration_ms: Date.now() - started,
      error_code: "not_authorized",
      props: { archived },
    });
    return { ok: false, error: "not_authorized" };
  }

  const { data: updated, error } = await supabase
    .from("canvas_deck")
    .update({ archived_at: archived ? new Date().toISOString() : null })
    .eq("id", deckId)
    .select("id");

  if (error) {
    console.error("[setDeckArchived]", error);
    logUsage({
      event: "deck.set_archived",
      surface: "action",
      user_id: user.id,
      workspace_id,
      deck_id: deckId,
      status: "error",
      duration_ms: Date.now() - started,
      error,
      error_code: error.code ?? "update_error",
      props: { archived },
    });
    return { ok: false, error: error.message };
  }
  if (!updated || updated.length === 0) {
    logUsage({
      event: "deck.set_archived",
      surface: "action",
      user_id: user.id,
      workspace_id,
      deck_id: deckId,
      status: "denied",
      duration_ms: Date.now() - started,
      error_code: "not_authorized",
      props: { archived },
    });
    return { ok: false, error: "not_authorized" };
  }

  logUsage({
    event: "deck.set_archived",
    surface: "action",
    user_id: user.id,
    workspace_id,
    deck_id: deckId,
    status: "ok",
    duration_ms: Date.now() - started,
    props: { archived },
  });

  revalidatePath(`/canvases/${deckId}`);
  revalidatePath("/canvases");
  return { ok: true };
}

// Deck-scoped opt-in for the trusted agent patch fast lane. The user's normal
// canvas_deck UPDATE policy remains the authority: deck creators and workspace
// admins/owners may change it. The SQL apply helper separately requires the
// workspace-level self-approval opt-in before it can commit anything.
export async function setDeckAgentFastLane(
  deckId: string,
  enabled: boolean,
): Promise<ActionResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "not_authenticated" };

  // Authorize the caller the same way the UI's `canManageFastLane` gate does
  // (deck-workspace.tsx): workspace owner/admin OR the deck creator. The
  // canvas_deck UPDATE RLS policy also permits role-'editor' deck members and
  // Postgres RLS is not column-scoped, so without this check a non-creator
  // editor could flip this security-relevant flag via a direct call.
  const { data: deck } = await supabase
    .from("canvas_deck")
    .select("workspace_id, created_by")
    .eq("id", deckId)
    .maybeSingle();
  if (!deck?.workspace_id) {
    return { ok: false, error: "not_authorized" };
  }
  let authorized = deck.created_by === user.id;
  if (!authorized) {
    const { data: isAdmin, error: rpcErr } = await supabase.rpc(
      "is_workspace_admin_or_owner",
      { _workspace_id: deck.workspace_id },
    );
    if (rpcErr) {
      console.error("[setDeckAgentFastLane] rpc", rpcErr);
      return { ok: false, error: rpcErr.message };
    }
    authorized = Boolean(isAdmin);
  }
  if (!authorized) {
    return { ok: false, error: "not_authorized" };
  }

  const { data, error } = await supabase
    .from("canvas_deck")
    .update({ agent_fast_lane_enabled: enabled })
    .eq("id", deckId)
    .select("id");
  if (error) {
    console.error("[setDeckAgentFastLane]", error);
    return { ok: false, error: error.message };
  }
  if (!data || data.length === 0) {
    return { ok: false, error: "not_authorized" };
  }

  // Record the choice as this user's standing default: decks they create from
  // now on inherit it via the canvas_deck insert trigger (0075). Best-effort —
  // the deck flag above is the authority, so a pref write failure only costs
  // the inheritance, never the toggle.
  const { error: prefErr } = await supabase
    .from("canvas_user_fast_lane_default")
    .upsert({ user_id: user.id, enabled, updated_at: new Date().toISOString() });
  if (prefErr) {
    console.error("[setDeckAgentFastLane] default", prefErr);
  }

  revalidatePath(`/canvases/${deckId}`);
  return { ok: true };
}

// Duplicate a slide. DIRECT for anyone who can edit the deck (migration 0071,
// ADR-0012 finished: a copy is purely additive — it clobbers nobody's work, so
// routing it propose→self-approve cost a solo editor two full review cycles
// for one copy). The SECURITY DEFINER RPC's explicit canvas_can_edit_deck
// check is the authority; a caller it refuses falls back to the original
// propose-first path (a member without direct rights still gets their copy —
// as a pending proposal a reviewer approves). The result says which path ran
// so the UI can phrase the feedback honestly.
export type DuplicateSlideResult =
  | { ok: true; mode: "direct"; slideId: string; position: number }
  | { ok: true; mode: "proposed" }
  | { ok: false; error: string };

export async function duplicateSlide(
  deckId: string,
  slideId: string,
): Promise<DuplicateSlideResult> {
  const started = Date.now();
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "not_authenticated" };

  // Load the source slide (RLS-gated). A viewer who can't see it gets a
  // not-found here rather than a confusing downstream insert error.
  const { data: slide, error: slideErr } = await supabase
    .from("canvas_deck_slide")
    .select("id, workspace_id, deck_id, position, title, html_body, slide_styles")
    .eq("id", slideId)
    .maybeSingle();
  if (slideErr) {
    console.error("[duplicateSlide] slide lookup", slideErr);
    return { ok: false, error: slideErr.message };
  }
  if (!slide?.workspace_id) {
    return { ok: false, error: "slide_not_found" };
  }

  // Direct path first. Only a not_authorized refusal falls through to the
  // propose path — any other failure is a real error the user should see.
  const { data: direct, error: directErr } = await supabase.rpc(
    "canvas_duplicate_slide_direct",
    { _slide_id: slideId },
  );
  if (!directErr) {
    const row = Array.isArray(direct) ? direct[0] : direct;
    logUsage({
      event: "slide.duplicate",
      surface: "action",
      user_id: user.id,
      workspace_id: slide.workspace_id,
      deck_id: deckId,
      slide_id: slideId,
      status: "ok",
      duration_ms: Date.now() - started,
      props: { mode: "direct" },
    });
    revalidatePath(`/canvases/${deckId}`);
    revalidatePath(`/canvases/${deckId}/history`);
    return {
      ok: true,
      mode: "direct",
      slideId: (row?.id as string) ?? "",
      position: (row?.position as number) ?? (slide.position as number) + 1,
    };
  }
  if (!/not_authorized/.test(directErr.message ?? "")) {
    console.error("[duplicateSlide] direct rpc", directErr);
    logUsage({
      event: "slide.duplicate",
      surface: "action",
      user_id: user.id,
      workspace_id: slide.workspace_id,
      deck_id: deckId,
      slide_id: slideId,
      status: "error",
      duration_ms: Date.now() - started,
      error: directErr,
      error_code: directErr.code ?? "rpc_error",
    });
    return { ok: false, error: directErr.message };
  }

  const { error: insertErr } = await supabase.from("canvas_deck_edit").insert({
    workspace_id: slide.workspace_id,
    deck_id: slide.deck_id,
    slide_id: null,
    kind: "slide_create",
    proposed_by: user.id,
    proposed_by_kind: "user",
    new_content: null,
    new_slide_payload: {
      position: (slide.position as number) + 1,
      title: (slide.title as string | null) ?? "",
      html_body: slide.html_body as string,
      slide_styles: (slide.slide_styles as string | null) ?? "",
    },
    rationale: null,
    status: "pending",
  });

  if (insertErr) {
    console.error("[duplicateSlide] insert", insertErr);
    logUsage({
      event: "slide.duplicate",
      surface: "action",
      user_id: user.id,
      workspace_id: slide.workspace_id,
      deck_id: deckId,
      slide_id: slideId,
      status: "error",
      duration_ms: Date.now() - started,
      error: insertErr,
      error_code: insertErr.code ?? "insert_error",
    });
    return { ok: false, error: insertErr.message };
  }

  logUsage({
    event: "slide.duplicate",
    surface: "action",
    user_id: user.id,
    workspace_id: slide.workspace_id,
    deck_id: deckId,
    slide_id: slideId,
    status: "ok",
    duration_ms: Date.now() - started,
    props: { mode: "proposed" },
  });

  revalidatePath(`/canvases/${deckId}`);
  return { ok: true, mode: "proposed" };
}

// Delete a slide. DIRECT for anyone who can edit the deck (migration 0071,
// ADR-0012 finished): the delete is recoverable via snapshot restore, audited
// by the 0037 activity trigger, and guarded by the same only-slide rule the
// apply path enforces — so a solo editor no longer pays propose+self-approve
// to remove their own slide. The SECURITY DEFINER RPC's canvas_can_edit_deck
// check is the authority; a caller it refuses falls back to the propose-first
// pending slide_delete a reviewer approves. The result says which path ran.
export type DeleteSlideResult =
  | { ok: true; mode: "direct" }
  | { ok: true; mode: "proposed" }
  | { ok: false; error: string };

export async function proposeDeleteSlide(
  deckId: string,
  slideId: string,
): Promise<DeleteSlideResult> {
  const started = Date.now();
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "not_authenticated" };

  // Load the slide (RLS-gated) — a viewer who can't see it gets a not-found
  // here rather than a confusing downstream insert error.
  const { data: slide, error: slideErr } = await supabase
    .from("canvas_deck_slide")
    .select("id, workspace_id, deck_id")
    .eq("id", slideId)
    .maybeSingle();
  if (slideErr) {
    console.error("[proposeDeleteSlide] slide lookup", slideErr);
    return { ok: false, error: slideErr.message };
  }
  if (!slide?.workspace_id) {
    return { ok: false, error: "slide_not_found" };
  }

  // A deck can't lose its only slide (same rule as the RPC + MCP tool). Fail
  // fast here so the click gets a friendly error instead of a raw SQL message
  // or a pending proposal that can never be approved.
  const { count, error: countErr } = await supabase
    .from("canvas_deck_slide")
    .select("id", { count: "exact", head: true })
    .eq("deck_id", slide.deck_id);
  if (countErr) {
    console.error("[proposeDeleteSlide] slide count", countErr);
    return { ok: false, error: countErr.message };
  }
  if ((count ?? 0) <= 1) {
    return { ok: false, error: "cannot_delete_only_slide" };
  }

  // Direct path first; only a not_authorized refusal falls through to propose.
  const { error: directErr } = await supabase.rpc("canvas_delete_slide_direct", {
    _slide_id: slideId,
  });
  if (!directErr) {
    logUsage({
      event: "slide.delete_direct",
      surface: "action",
      user_id: user.id,
      workspace_id: slide.workspace_id,
      deck_id: deckId,
      slide_id: slideId,
      status: "ok",
      duration_ms: Date.now() - started,
    });
    revalidatePath(`/canvases/${deckId}`);
    revalidatePath(`/canvases/${deckId}/history`);
    return { ok: true, mode: "direct" };
  }
  if (!/not_authorized/.test(directErr.message ?? "")) {
    console.error("[proposeDeleteSlide] direct rpc", directErr);
    logUsage({
      event: "slide.delete_direct",
      surface: "action",
      user_id: user.id,
      workspace_id: slide.workspace_id,
      deck_id: deckId,
      slide_id: slideId,
      status: "error",
      duration_ms: Date.now() - started,
      error: directErr,
      error_code: directErr.code ?? "rpc_error",
    });
    return { ok: false, error: directErr.message };
  }

  const { error: insertErr } = await supabase.from("canvas_deck_edit").insert({
    workspace_id: slide.workspace_id,
    deck_id: slide.deck_id,
    slide_id: slideId,
    kind: "slide_delete",
    proposed_by: user.id,
    proposed_by_kind: "user",
    new_content: null,
    new_slide_payload: null,
    rationale: null,
    status: "pending",
  });

  if (insertErr) {
    console.error("[proposeDeleteSlide] insert", insertErr);
    logUsage({
      event: "slide.delete_propose",
      surface: "action",
      user_id: user.id,
      workspace_id: slide.workspace_id,
      deck_id: deckId,
      slide_id: slideId,
      status: "error",
      duration_ms: Date.now() - started,
      error: insertErr,
      error_code: insertErr.code ?? "insert_error",
    });
    return { ok: false, error: insertErr.message };
  }

  logUsage({
    event: "slide.delete_propose",
    surface: "action",
    user_id: user.id,
    workspace_id: slide.workspace_id,
    deck_id: deckId,
    slide_id: slideId,
    status: "ok",
    duration_ms: Date.now() - started,
  });

  revalidatePath(`/canvases/${deckId}`);
  return { ok: true, mode: "proposed" };
}

// ============================================================
// Direct (non-proposal) structural slide ops — create + reorder
// ============================================================
// The propose-first loop is right for CONTENT edits (they clobber, a reviewer
// needs to see what changed). Reordering and adding a freshly drawn slide are
// structural and non-destructive — a reorder is trivially reversible and a new
// slide is additive — so these go direct for anyone who can edit the deck,
// mirroring saveSlideHtmlDirect. Authority is enforced by the SECURITY DEFINER
// RPCs' explicit canvas_can_edit_deck check (migration 0061); a caller who
// can't edit gets a `not_authorized` error, never a phantom success. Agents
// still use the propose_* MCP tools — only the in-app human editor goes direct.
// See ADR-0012.

export type CreateSlideDirectResult =
  | { ok: true; slideId: string; position: number }
  | { ok: false; error: string };

// Insert a slide (typically a drawing) at `position` and return its id for the
// caller to select. Used by the draw surface's "Add to deck". html_body is the
// caller's <section class="slide">-wrapped output (see lib/canvas/draw/scene.ts);
// the action trims it before storing. The `error` field carries a user-ready
// message (the caller shows it directly).
export async function createSlideDirect(
  deckId: string,
  input: {
    position?: number | null;
    title?: string;
    html_body: string;
    slide_styles?: string;
  },
): Promise<CreateSlideDirectResult> {
  const started = Date.now();
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Your session expired — sign in again." };

  const html = input.html_body.trim();
  if (!html) return { ok: false, error: "Nothing to save — draw something first." };

  const { data: deck } = await supabase
    .from("canvas_deck")
    .select("workspace_id")
    .eq("id", deckId)
    .maybeSingle();
  const workspace_id = deck?.workspace_id ?? null;

  const { data, error } = await supabase.rpc("canvas_create_slide_direct", {
    _deck_id: deckId,
    _position: input.position ?? null,
    _title: input.title?.trim() || "",
    _html_body: html,
    _slide_styles: input.slide_styles ?? "",
  });

  // A function returning a single composite comes back as the row object (not a
  // one-element array); normalize either shape defensively.
  const row = (Array.isArray(data) ? data[0] : data) as
    | { id: string; position: number }
    | null;

  if (error || !row) {
    const denied = (error?.message ?? "").includes("not_authorized");
    console.error("[createSlideDirect]", error);
    logUsage({
      event: "slide.create_direct",
      surface: "action",
      user_id: user.id,
      workspace_id,
      deck_id: deckId,
      status: denied ? "denied" : "error",
      duration_ms: Date.now() - started,
      error_code: denied ? "not_authorized" : error?.code ?? "rpc_error",
      props: { html_len: html.length },
    });
    return {
      ok: false,
      error: denied
        ? "You don't have permission to add slides to this deck."
        : "Couldn't add the slide — please try again.",
    };
  }

  logUsage({
    event: "slide.create_direct",
    surface: "action",
    user_id: user.id,
    workspace_id,
    deck_id: deckId,
    slide_id: row.id,
    status: "ok",
    duration_ms: Date.now() - started,
    props: { html_len: html.length, position: row.position },
  });

  revalidatePath(`/canvases/${deckId}`);
  revalidatePath(`/canvases/${deckId}/history`);
  return { ok: true, slideId: row.id, position: row.position };
}

// Rewrite slide order from an exact permutation of the deck's slide ids. Backs
// the left-rail drag-to-reorder. The RPC re-validates the permutation + the
// caller's edit rights server-side, so a stale order (a slide added/removed
// since the page loaded) fails loudly rather than corrupting positions.
export async function reorderSlidesDirect(
  deckId: string,
  orderedSlideIds: string[],
): Promise<ActionResult> {
  const started = Date.now();
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "not_authenticated" };

  if (!Array.isArray(orderedSlideIds) || orderedSlideIds.length === 0) {
    return { ok: false, error: "empty_order" };
  }

  const { data: deck } = await supabase
    .from("canvas_deck")
    .select("workspace_id")
    .eq("id", deckId)
    .maybeSingle();
  const workspace_id = deck?.workspace_id ?? null;

  const { error } = await supabase.rpc("canvas_reorder_slides_direct", {
    _deck_id: deckId,
    _order: orderedSlideIds,
  });

  if (error) {
    const msg = error.message ?? "";
    const denied = msg.includes("not_authorized");
    // The RPC raises the permutation-mismatch failures (a slide added/removed
    // since the page loaded) with these tokens. Everything else is a transport
    // or internal error the user can't interpret — so only the stale case gets
    // the "deck changed, refresh" hint; the rest get a neutral retry message
    // rather than misattributing the failure to staleness.
    const stale = msg.includes("exactly once") || msg.includes("not in deck");
    console.error("[reorderSlidesDirect]", error);
    logUsage({
      event: "slide.reorder_direct",
      surface: "action",
      user_id: user.id,
      workspace_id,
      deck_id: deckId,
      status: denied ? "denied" : "error",
      duration_ms: Date.now() - started,
      error_code: denied
        ? "not_authorized"
        : stale
          ? "stale_order"
          : error.code ?? "rpc_error",
      props: { slide_count: orderedSlideIds.length },
    });
    return {
      ok: false,
      error: denied
        ? "You don't have permission to reorder this deck."
        : stale
          ? "The deck changed since you started — refresh and try again."
          : "Couldn't save the new order — please try again.",
    };
  }

  logUsage({
    event: "slide.reorder_direct",
    surface: "action",
    user_id: user.id,
    workspace_id,
    deck_id: deckId,
    status: "ok",
    duration_ms: Date.now() - started,
    props: { slide_count: orderedSlideIds.length },
  });

  revalidatePath(`/canvases/${deckId}`);
  return { ok: true };
}

export async function addDeckMember(
  deckId: string,
  userId: string,
  role: DeckMemberRole,
): Promise<ActionResult> {
  const started = Date.now();
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "not_authenticated" };

  const { data: deck } = await supabase
    .from("canvas_deck")
    .select("workspace_id")
    .eq("id", deckId)
    .maybeSingle();
  if (!deck?.workspace_id) return { ok: false, error: "deck_not_found" };

  const { error } = await supabase
    .from("canvas_deck_member")
    .upsert(
      {
        deck_id: deckId,
        user_id: userId,
        workspace_id: deck.workspace_id,
        role,
        invited_by: user.id,
      },
      { onConflict: "deck_id,user_id" },
    );

  if (error) {
    console.error("[addDeckMember]", error);
    logUsage({
      event: "deck.member.add",
      surface: "action",
      user_id: user.id,
      workspace_id: deck.workspace_id,
      deck_id: deckId,
      status: "error",
      duration_ms: Date.now() - started,
      error,
      error_code: error.code ?? "insert_error",
      props: { invited_user_id: userId, role },
    });
    return { ok: false, error: error.message };
  }

  logUsage({
    event: "deck.member.add",
    surface: "action",
    user_id: user.id,
    workspace_id: deck.workspace_id,
    deck_id: deckId,
    status: "ok",
    duration_ms: Date.now() - started,
    props: { invited_user_id: userId, role },
  });

  revalidatePath(`/canvases/${deckId}`);
  return { ok: true };
}

export async function updateDeckMemberRole(
  deckId: string,
  userId: string,
  role: DeckMemberRole,
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

  const { data: deck } = await supabase
    .from("canvas_deck")
    .select("workspace_id, created_by")
    .eq("id", deckId)
    .maybeSingle();
  const workspace_id = deck?.workspace_id ?? null;

  // The creator's auto-added editor row is load-bearing for private decks: it is
  // what keeps the deck reachable/editable by its author. Also block a direct
  // self-demotion; the UI hides it, but server actions are callable directly.
  if (deck?.created_by === userId && role !== "editor") {
    return { ok: false, error: "cannot_demote_creator" };
  }
  if (userId === user.id && role !== "editor") {
    return { ok: false, error: "cannot_demote_self" };
  }

  const { data: updated, error } = await supabase
    .from("canvas_deck_member")
    .update({ role })
    .eq("deck_id", deckId)
    .eq("user_id", userId)
    .select("user_id");

  if (error) {
    console.error("[updateDeckMemberRole]", error);
    logUsage({
      event: "deck.member.update",
      surface: "action",
      user_id: user.id,
      workspace_id,
      deck_id: deckId,
      status: "error",
      duration_ms: Date.now() - started,
      error,
      error_code: error.code ?? "update_error",
      props: { member_user_id: userId, role },
    });
    return { ok: false, error: error.message };
  }
  if (!updated || updated.length === 0) {
    return { ok: false, error: "not_authorized_or_not_found" };
  }

  logUsage({
    event: "deck.member.update",
    surface: "action",
    user_id: user.id,
    workspace_id,
    deck_id: deckId,
    status: "ok",
    duration_ms: Date.now() - started,
    props: { member_user_id: userId, role },
  });

  revalidatePath(`/canvases/${deckId}`);
  return { ok: true };
}

export async function removeDeckMember(
  deckId: string,
  userId: string,
): Promise<ActionResult> {
  const started = Date.now();
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "not_authenticated" };

  const { data: deck } = await supabase
    .from("canvas_deck")
    .select("workspace_id, created_by")
    .eq("id", deckId)
    .maybeSingle();
  const workspace_id = deck?.workspace_id ?? null;

  // Guard against removing the deck creator from a private deck — they're
  // the load-bearing editor seat the trigger auto-installed, and removing
  // them would orphan the deck. The UI hides this case but a direct caller
  // would otherwise be able to invoke it.
  if (deck?.created_by === userId) {
    return { ok: false, error: "cannot_remove_creator" };
  }

  const { data: deleted, error } = await supabase
    .from("canvas_deck_member")
    .delete()
    .eq("deck_id", deckId)
    .eq("user_id", userId)
    .select("user_id");

  if (error) {
    console.error("[removeDeckMember]", error);
    logUsage({
      event: "deck.member.remove",
      surface: "action",
      user_id: user.id,
      workspace_id,
      deck_id: deckId,
      status: "error",
      duration_ms: Date.now() - started,
      error,
      error_code: error.code ?? "delete_error",
      props: { member_user_id: userId },
    });
    return { ok: false, error: error.message };
  }
  if (!deleted || deleted.length === 0) {
    return { ok: false, error: "not_authorized_or_not_found" };
  }

  logUsage({
    event: "deck.member.remove",
    surface: "action",
    user_id: user.id,
    workspace_id,
    deck_id: deckId,
    status: "ok",
    duration_ms: Date.now() - started,
    props: { member_user_id: userId },
  });

  revalidatePath(`/canvases/${deckId}`);
  return { ok: true };
}

export type GuestInviteResult =
  | { ok: true; warning?: string }
  | { ok: false; error: string };

const GUEST_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Invite an outside reviewer (no workspace account needed) to a single deck.
// They accept the emailed link, sign in with that email, and land on the deck
// with a 'guest' workspace membership + an explicit canvas_deck_member row —
// which (per migration 0025) is the ONLY thing that grants a guest any access.
// They never see other workspace decks.
export async function inviteGuestToDeck(
  deckId: string,
  email: string,
  role: DeckMemberRole,
): Promise<GuestInviteResult> {
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

  const { data: deck } = await supabase
    .from("canvas_deck")
    .select("workspace_id")
    .eq("id", deckId)
    .maybeSingle();
  if (!deck?.workspace_id) return { ok: false, error: "deck_not_found" };

  // Authorize against the same rule the DB uses: you can invite a reviewer to a
  // deck you can edit (admin/owner, creator, or an editor deck-member).
  const { data: canEdit } = await supabase.rpc("canvas_can_edit_deck", {
    _deck_id: deckId,
  });
  if (canEdit !== true) {
    logUsage({
      event: "deck.guest_invite",
      surface: "action",
      user_id: user.id,
      workspace_id: deck.workspace_id,
      deck_id: deckId,
      status: "denied",
      duration_ms: Date.now() - started,
      error_code: "not_authorized",
      props: { role },
    });
    return {
      ok: false,
      error: "You need edit access to invite a reviewer to this deck.",
    };
  }

  const admin = createAdminClient();

  // Guard: never let a deck-scoped "guest" invite target an email on the
  // workspace's auto-join domain. The auth.users INSERT trigger would make
  // that person a FULL workspace 'member' on first sign-in (it wins the
  // membership conflict before the guest grant is applied), silently turning
  // "view this one deck" into "view + edit every workspace deck". Internal
  // teammates belong in Settings → Members, not in a per-deck guest invite.
  const emailDomain = normEmail.split("@")[1] ?? "";
  if (emailDomain) {
    const { data: allowlisted } = await admin
      .from("workspace_email_domain")
      .select("domain")
      .eq("workspace_id", deck.workspace_id)
      .eq("domain", emailDomain)
      .maybeSingle();
    if (allowlisted) {
      logUsage({
        event: "deck.guest_invite",
        surface: "action",
        user_id: user.id,
        workspace_id: deck.workspace_id,
        deck_id: deckId,
        status: "denied",
        duration_ms: Date.now() - started,
        error_code: "internal_domain",
        props: { role },
      });
      return {
        ok: false,
        error: `${normEmail} is on your team's domain — add them from Settings → Members instead. A guest invite would give them the whole workspace, not just this deck.`,
      };
    }
  }

  // Create the deck-scoped guest invite via the admin client: the
  // workspace_invites INSERT policy is admin-only, but we've just verified the
  // caller can edit the deck, which is the authorization we want here.
  const { data: invite, error: insertErr } = await admin
    .from("workspace_invites")
    .insert({
      workspace_id: deck.workspace_id,
      email: normEmail,
      role: "guest",
      deck_id: deckId,
      deck_role: role,
      invited_by: user.id,
    })
    .select("token")
    .single();

  if (insertErr) {
    logUsage({
      event: "deck.guest_invite",
      surface: "action",
      user_id: user.id,
      workspace_id: deck.workspace_id,
      deck_id: deckId,
      status: "error",
      duration_ms: Date.now() - started,
      error: insertErr,
      error_code: insertErr.code ?? "insert_error",
      props: { role, duplicate: insertErr.code === "23505" },
    });
    if (insertErr.code === "23505") {
      return {
        ok: false,
        error:
          "There's already a pending invite for that email on this deck — they need to accept it first.",
      };
    }
    return { ok: false, error: insertErr.message };
  }

  const send = await sendInviteLink(normEmail, invite.token, {
    workspace_id: deck.workspace_id,
    deck_id: deckId,
    deck_role: role,
    invited_role: "guest",
  });

  logUsage({
    event: "deck.guest_invite",
    surface: "action",
    user_id: user.id,
    workspace_id: deck.workspace_id,
    deck_id: deckId,
    status: "ok",
    duration_ms: Date.now() - started,
    props: { role, email_sent: send.emailed },
  });

  revalidatePath(`/canvases/${deckId}`);
  return send.emailed ? { ok: true } : { ok: true, warning: send.warning };
}

// Cancel a pending (not-yet-accepted) guest invite on this deck.
export async function revokeGuestInvite(
  deckId: string,
  inviteId: string,
): Promise<ActionResult> {
  const started = Date.now();
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "not_authenticated" };

  const { data: deck } = await supabase
    .from("canvas_deck")
    .select("workspace_id")
    .eq("id", deckId)
    .maybeSingle();
  if (!deck?.workspace_id) return { ok: false, error: "deck_not_found" };

  const { data: canEdit } = await supabase.rpc("canvas_can_edit_deck", {
    _deck_id: deckId,
  });
  if (canEdit !== true) return { ok: false, error: "not_authorized" };

  // Scoped to this deck + not-yet-accepted so this can never delete a member
  // invite or undo an already-granted seat.
  const admin = createAdminClient();
  const { data: deleted, error } = await admin
    .from("workspace_invites")
    .delete()
    .eq("id", inviteId)
    .eq("deck_id", deckId)
    .is("accepted_at", null)
    .select("id");

  if (error) {
    logUsage({
      event: "deck.guest_invite_revoke",
      surface: "action",
      user_id: user.id,
      workspace_id: deck.workspace_id,
      deck_id: deckId,
      status: "error",
      duration_ms: Date.now() - started,
      error,
      error_code: error.code ?? "delete_error",
      props: { invite_id: inviteId },
    });
    return { ok: false, error: error.message };
  }
  if (!deleted || deleted.length === 0) {
    return { ok: false, error: "Invite already accepted or already revoked." };
  }

  logUsage({
    event: "deck.guest_invite_revoke",
    surface: "action",
    user_id: user.id,
    workspace_id: deck.workspace_id,
    deck_id: deckId,
    status: "ok",
    duration_ms: Date.now() - started,
    props: { invite_id: inviteId },
  });

  revalidatePath(`/canvases/${deckId}`);
  return { ok: true };
}

export async function deleteDeck(deckId: string): Promise<ActionResult> {
  // IMPORTANT: this path must go through the user's RLS-aware Supabase client
  // for the DELETE itself, not the admin client. The DELETE policy on
  // `canvas_deck` ("creators and admins delete canvas decks") is the
  // authorisation rule we rely on — using admin here would let any workspace
  // member delete any deck, even ones they didn't create.
  const started = Date.now();
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "not_authenticated" };

  // Pre-resolve workspace_id (RLS-gated) so the usage event lands on the
  // right workspace even though the row will be gone by the time we log.
  const { data: deck } = await supabase
    .from("canvas_deck")
    .select("workspace_id")
    .eq("id", deckId)
    .maybeSingle();
  const workspace_id = deck?.workspace_id ?? null;

  // 1. Capture the asset paths *before* the DB cascade removes their rows. We
  //    use the same RLS-gated read; a non-member sees no rows.
  const { data: assetsRaw } = await supabase
    .from("canvas_deck_asset")
    .select("storage_path")
    .eq("deck_id", deckId);
  const storagePaths = (assetsRaw ?? [])
    .map((a) => a.storage_path as string | null)
    .filter((p): p is string => Boolean(p));

  // 2. RLS-gated DELETE. Returns the deleted rows so we can detect "policy
  //    silently filtered me" (zero rows affected) and surface 'not_authorized'
  //    rather than reporting a phantom success.
  const { data: deleted, error: delErr } = await supabase
    .from("canvas_deck")
    .delete()
    .eq("id", deckId)
    .select("id");
  if (delErr) {
    console.error("[deleteDeck]", delErr);
    logUsage({
      event: "deck.delete",
      surface: "action",
      user_id: user.id,
      workspace_id,
      deck_id: deckId,
      status: "error",
      duration_ms: Date.now() - started,
      error: delErr,
      error_code: delErr.code ?? "delete_error",
    });
    return { ok: false, error: delErr.message };
  }
  if (!deleted || deleted.length === 0) {
    logUsage({
      event: "deck.delete",
      surface: "action",
      user_id: user.id,
      workspace_id,
      deck_id: deckId,
      status: "denied",
      duration_ms: Date.now() - started,
      error_code: "not_authorized",
    });
    return { ok: false, error: "not_authorized" };
  }

  // 3. Storage cleanup via the admin client — the DB rows are already gone
  //    (cascade removed the asset table entries), so RLS on storage.objects no
  //    longer has anything to anchor against. Best-effort; orphans get
  //    swept by `scripts/sweep-orphans.mts`.
  let storage_cleanup_ok = true;
  if (storagePaths.length > 0) {
    const admin = createAdminClient();
    const { error: rmErr } = await admin.storage.from("decks").remove(storagePaths);
    if (rmErr) {
      storage_cleanup_ok = false;
      console.warn(`[deleteDeck] storage cleanup partial — ${rmErr.message}`);
    }
  }

  logUsage({
    event: "deck.delete",
    surface: "action",
    user_id: user.id,
    workspace_id,
    deck_id: deckId,
    status: "ok",
    duration_ms: Date.now() - started,
    props: {
      asset_paths: storagePaths.length,
      storage_cleanup_ok,
    },
  });

  revalidatePath("/canvases");
  redirect("/canvases");
}

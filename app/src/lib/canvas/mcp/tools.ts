// MCP tools — phase 3.
//
// Each function maps to one Canvas operation. Called from the JSON-RPC
// dispatcher in `server.ts` with a resolved auth context (workspace + user
// from the token). We use the service-role admin client and explicitly filter
// every query by workspace_id to enforce isolation — the token has already
// proven the user is in this workspace, and using admin avoids the
// `auth.uid()`-null pitfalls of running RPC functions outside an HTTP session.
//
// Returns are plain objects; the dispatcher JSON-stringifies them into MCP
// `content[0].text`. Throw to signal a tool error — the dispatcher catches
// and wraps as `isError: true`.

import { createHash, randomUUID } from "node:crypto";
import { createPatch } from "diff";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";
import { importDeckFromHtml } from "@/lib/canvas/importer";
import { blankDeckHtml } from "@/lib/canvas/blank-deck";
import { assembleDeckHtml } from "@/lib/canvas/assemble";
import { assembleSelfContainedDeck } from "@/lib/canvas/export-deck";
import { normalizeBrandTokens } from "@/lib/canvas/brand";
import { rasterizeDeckHtml } from "@/lib/canvas/slide-raster";
import { previewProposalOnSlide } from "@/lib/canvas/proposal-preview";
import { supersedeOlderPendingProposals } from "@/lib/canvas/proposal-hygiene";
import { renderGate } from "@/lib/canvas/render-gate";
import {
  applySlidePatch,
  MAX_PATCH_EDITS,
  type SlidePatchEdit,
} from "@/lib/canvas/slide-patch";
import { computeSlidePatch } from "@/lib/canvas/slide-patch-suggest";
import { logUsage, type UsageStatus } from "@/lib/usage/log";

export type AuthContext = {
  user_id: string;
  workspace_id: string;
  // Server-side assistant runtimes can pin proposals to the exact reply row.
  // External MCP clients omit this and use the legacy streaming-row lookup.
  assistant_message_id?: string;
};

export type ToolFn = (args: unknown, ctx: AuthContext) => Promise<unknown>;

const LOCK_DURATION_MINUTES = 15;

// MCP renders (render_slide / render_deck / render_proposal) acquire the one
// box-wide render gate (renderGate) shared with the thumbnail, PDF, and PPTX
// paths — the single ceiling that bounds how many Chromium renders run at once
// across the whole process, instead of four private caps that could stack. An
// agent-triggered render takes the non-blocking policy (run): if no slot is
// free, surface a clear retryable error rather than pile up.

// A tool that returns rendered image(s) hands back this tagged shape instead of
// a plain object. server.ts detects it and emits the MCP content blocks
// verbatim (an `image` part per the MCP spec) rather than JSON-stringifying the
// result into a single text block. Every other tool is unaffected.
export type McpContentResult = {
  __mcpContent: Array<
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: string }
  >;
};

export function isMcpContentResult(value: unknown): value is McpContentResult {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as McpContentResult).__mcpContent)
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Errors a tool raises on purpose: validation failures, authorization denials,
// not-found, size caps, etc. Their messages are human-readable and safe to
// return to the MCP client. Everything else (e.g. a raw Postgres error wrapped
// in `new Error(error.message)`) is treated as "unexpected" by the dispatcher
// and replaced with a generic message so DB table/column/constraint names never
// reach the client. See server.ts's tools/call catch path.
export class ExpectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExpectedError";
  }
}

function admin(): SupabaseClient {
  return createAdminClient();
}

// The in-app chatbox opens a streaming assistant reply row for the turn before
// Claude runs (the bridge's `start` event — ADR-0006). When a propose_* call
// arrives mid-turn, we stamp the new canvas_deck_edit with that reply's id so
// the web chatbox can surface the proposal inline and review it without leaving
// the panel. Resolves to null for every non-chatbox path (terminal Claude, or
// no live turn on this deck) — those proposals stay unlinked, exactly as
// before. The bridge runs one turn at a time per deck, so at most one row
// matches; the immutability trigger (0043) freezes the link after insert.
async function activeAssistantMessageId(
  deckId: string,
  ctx: AuthContext,
): Promise<string | null> {
  if (ctx.assistant_message_id) return ctx.assistant_message_id;
  const { data } = await admin()
    .from("canvas_assistant_message")
    .select("id")
    .eq("user_id", ctx.user_id)
    .eq("deck_id", deckId)
    .eq("role", "assistant")
    .eq("status", "streaming")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data?.id as string | undefined) ?? null;
}

function requireString(args: unknown, key: string): string {
  if (!args || typeof args !== "object") {
    throw new ExpectedError(`Missing arguments object`);
  }
  const v = (args as Record<string, unknown>)[key];
  if (typeof v !== "string" || !v.trim()) {
    throw new ExpectedError(`Argument "${key}" is required`);
  }
  return v;
}

function optionalString(args: unknown, key: string): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  const v = (args as Record<string, unknown>)[key];
  if (typeof v !== "string") return undefined;
  return v;
}

function optionalNumber(args: unknown, key: string, fallback: number): number {
  if (!args || typeof args !== "object") return fallback;
  const v = (args as Record<string, unknown>)[key];
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return v;
  return fallback;
}

// Required non-negative integer (position 0 is valid — it puts the new slide
// at the start of the deck). Throws on missing, NaN, float, or negative.
function requireNonNegativeInteger(args: unknown, key: string): number {
  if (!args || typeof args !== "object") {
    throw new ExpectedError(`Missing arguments object`);
  }
  const v = (args as Record<string, unknown>)[key];
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0) {
    throw new ExpectedError(`Argument "${key}" must be a non-negative integer`);
  }
  return v;
}

// Required version echo for propose_slide_edit. A full-content replacement is
// only safe if it was composed from the slide's CURRENT content, and only the
// caller knows which version it actually read — base_version_id can't catch a
// stale rewrite because it's stamped server-side at INSERT time, so it always
// looks current. The tailored message matters: it's what teaches a client that
// cached the slide earlier in a long session to re-read instead of guessing.
function requireBaseVersionNo(args: unknown): number {
  if (!args || typeof args !== "object") {
    throw new ExpectedError(`Missing arguments object`);
  }
  const v = (args as Record<string, unknown>).base_version_no;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1) {
    throw new ExpectedError(
      'Argument "base_version_no" is required — echo the current_version_no from your most recent read_slide / get_deck of this slide. It proves the replacement was built from the slide\'s current content; call read_slide first if you don\'t have it.',
    );
  }
  return v;
}

// Parse and validate the `edits` array for propose_slide_patch. Shape errors
// throw ExpectedError with the offending index so the caller can fix the one
// bad entry; content-level failures (no match, ambiguous match) are reported
// by applySlidePatch instead.
function requirePatchEdits(args: unknown): SlidePatchEdit[] {
  if (!args || typeof args !== "object") {
    throw new ExpectedError("Missing arguments object");
  }
  const raw = (args as Record<string, unknown>).edits;
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new ExpectedError(
      'Argument "edits" must be a non-empty array of {find, replace} objects',
    );
  }
  if (raw.length > MAX_PATCH_EDITS) {
    throw new ExpectedError(
      `Argument "edits" has too many entries (${raw.length}; max ${MAX_PATCH_EDITS})`,
    );
  }
  return raw.map((entry, i) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new ExpectedError(`edits[${i}] must be an object with find and replace`);
    }
    const e = entry as Record<string, unknown>;
    if (typeof e.find !== "string" || e.find.length === 0) {
      throw new ExpectedError(`edits[${i}].find must be a non-empty string`);
    }
    if (typeof e.replace !== "string") {
      throw new ExpectedError(`edits[${i}].replace must be a string (may be empty)`);
    }
    if (e.in !== undefined && e.in !== "html_body" && e.in !== "slide_styles") {
      throw new ExpectedError(`edits[${i}].in must be "html_body" or "slide_styles"`);
    }
    if (e.replace_all !== undefined && typeof e.replace_all !== "boolean") {
      throw new ExpectedError(`edits[${i}].replace_all must be a boolean`);
    }
    return {
      find: e.find,
      replace: e.replace,
      in: e.in as SlidePatchEdit["in"],
      replace_all: e.replace_all === true,
    };
  });
}

// One slide's worth of patch edits, grouped out of propose_deck_patch's flat
// `edits` array. Order within a group is preserved (each edit sees the prior
// edits' output, same as propose_slide_patch).
type DeckPatchGroup = { slide_id: string; edits: SlidePatchEdit[] };

// Parse and group the `edits` array for propose_deck_patch. Each entry is the
// same {find, replace, in?, replace_all?} as propose_slide_patch PLUS a
// slide_id. Multiple entries for the same slide are grouped into one patch (one
// proposal per slide), which also sidesteps the batch-approve "exactly one
// pending proposal per slide" rule — two separate proposals on one slide would
// make BOTH batch-ineligible. The total edit count is capped the same way a
// single slide's patch is (MAX_PATCH_EDITS) since each group is applied as one
// patch and per-group size is re-checked by applySlidePatch.
function requireDeckPatchEdits(args: unknown): DeckPatchGroup[] {
  if (!args || typeof args !== "object") {
    throw new ExpectedError("Missing arguments object");
  }
  const raw = (args as Record<string, unknown>).edits;
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new ExpectedError(
      'Argument "edits" must be a non-empty array of {slide_id, find, replace} objects',
    );
  }
  if (raw.length > MAX_PATCH_EDITS) {
    throw new ExpectedError(
      `Argument "edits" has too many entries (${raw.length}; max ${MAX_PATCH_EDITS})`,
    );
  }
  // Group by slide_id, preserving first-seen order so the returned groups (and
  // thus the per-slide proposals) come back in a stable, predictable order.
  const order: string[] = [];
  const bySlide = new Map<string, SlidePatchEdit[]>();
  raw.forEach((entry, i) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new ExpectedError(`edits[${i}] must be an object with slide_id, find and replace`);
    }
    const e = entry as Record<string, unknown>;
    if (typeof e.slide_id !== "string" || !e.slide_id.trim()) {
      throw new ExpectedError(`edits[${i}].slide_id must be a non-empty string`);
    }
    if (typeof e.find !== "string" || e.find.length === 0) {
      throw new ExpectedError(`edits[${i}].find must be a non-empty string`);
    }
    if (typeof e.replace !== "string") {
      throw new ExpectedError(`edits[${i}].replace must be a string (may be empty)`);
    }
    if (e.in !== undefined && e.in !== "html_body" && e.in !== "slide_styles") {
      throw new ExpectedError(`edits[${i}].in must be "html_body" or "slide_styles"`);
    }
    if (e.replace_all !== undefined && typeof e.replace_all !== "boolean") {
      throw new ExpectedError(`edits[${i}].replace_all must be a boolean`);
    }
    const slide_id = e.slide_id;
    if (!bySlide.has(slide_id)) {
      bySlide.set(slide_id, []);
      order.push(slide_id);
    }
    bySlide.get(slide_id)!.push({
      find: e.find,
      replace: e.replace,
      in: e.in as SlidePatchEdit["in"],
      replace_all: e.replace_all === true,
    });
  });
  return order.map((slide_id) => ({ slide_id, edits: bySlide.get(slide_id)! }));
}

// Shape the new_slide_payload from a resolved applySlidePatch result, applying
// the same wrapper guard and payload-size checks propose_slide_patch uses.
// Shared so the single-slide and deck-wide patch tools cannot drift apart on
// these invariants. `labelPrefix` lets the deck-patch tool name the failing
// slide in its error. Returns the touched-fields-only payload; throws
// ExpectedError on a wrapper-eating patch or an oversized result.
function buildPatchedSlidePayload(
  originalHtmlBody: string,
  result: Extract<ReturnType<typeof applySlidePatch>, { ok: true }>,
  labelPrefix = "",
): { html_body?: string; slide_styles?: string } {
  const payload: { html_body?: string; slide_styles?: string } = {};
  if (result.touched.html_body) {
    // A patch whose `find` consumes the opening <section> tag would leave a
    // dangling trailing </section>; re-wrapping that (ensureSlideSectionWrap
    // only checks the leading tag) persists malformed nested markup. Reject
    // instead — the wrapper is the slide's contract.
    const hadWrap = /^\s*<section\b/i.test(originalHtmlBody);
    const hasWrap = /^\s*<section\b/i.test(result.html_body);
    if (hadWrap && !hasWrap) {
      throw new ExpectedError(
        `${labelPrefix}patch removed the slide's opening <section> wrapper — keep the slide wrapped in a single <section class="slide">…</section>, or use propose_slide_edit to replace the whole body`,
      );
    }
    assertPayloadSize(`${labelPrefix}html_body (after patch)`, result.html_body);
    payload.html_body = ensureSlideSectionWrap(result.html_body);
  }
  if (result.touched.slide_styles) {
    assertPayloadSize(`${labelPrefix}slide_styles (after patch)`, result.slide_styles);
    payload.slide_styles = result.slide_styles;
  }
  return payload;
}

function optionalBoolean(args: unknown, key: string): boolean {
  if (!args || typeof args !== "object") return false;
  const v = (args as Record<string, unknown>)[key];
  return v === true;
}

function contentHashMd5(content: string): string {
  return createHash("md5").update(content).digest("hex");
}

// First N characters of an inline-text source's body for list_sources, so the
// list stays cheap while still letting Claude tell sources apart at a glance.
// The full text comes back from read_source. Whitespace is collapsed so a
// multi-line preview reads as one line; truncation is marked with an ellipsis.
const SOURCE_BODY_PREVIEW_CHARS = 240;

function sourceBodyPreview(body: string | null | undefined): string | null {
  if (typeof body !== "string" || body.length === 0) return null;
  const oneLine = body.replace(/\s+/g, " ").trim();
  if (oneLine.length <= SOURCE_BODY_PREVIEW_CHARS) return oneLine;
  return `${oneLine.slice(0, SOURCE_BODY_PREVIEW_CHARS)}…`;
}

// Upper bound on a single proposed-content string (html_body, theme_css,
// nav_js, slide_styles). Guards against a single tool call writing a multi-MB
// row; the route enforces a separate, larger cap on the whole request body.
const MAX_PROPOSAL_CONTENT_CHARS = 1_000_000;

function assertPayloadSize(key: string, value: string): void {
  if (value.length > MAX_PROPOSAL_CONTENT_CHARS) {
    throw new ExpectedError(
      `Argument "${key}" is too large (${value.length} chars; max ${MAX_PROPOSAL_CONTENT_CHARS})`,
    );
  }
}

// Line-based change ratio between the stored slide body and a proposed full
// replacement: 0 = identical, 1 = nothing shared. Multiset line intersection
// (order-insensitive), O(n) — cheap enough to run on every propose_slide_edit.
// Drives the patch nudge below: prod data showed sessions issuing full
// rewrites for one-line tweaks and ZERO propose_slide_patch calls, so the
// steer has to ride the tool RESULT, not just the session instructions.
export function lineChangeRatio(before: string, after: string): number {
  const a = before.split("\n");
  const b = after.split("\n");
  if (a.length === 0 && b.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const line of a) counts.set(line, (counts.get(line) ?? 0) + 1);
  let common = 0;
  for (const line of b) {
    const c = counts.get(line) ?? 0;
    if (c > 0) {
      common += 1;
      counts.set(line, c - 1);
    }
  }
  return 1 - (2 * common) / (a.length + b.length);
}

// Below this change ratio a full slide replacement is "an adjustment" — the
// caller should have used propose_slide_patch. The threshold is deliberately
// generous (a real redesign rewrites most lines).
const PATCH_NUDGE_MAX_RATIO = 0.15;

// Slides must start with a `<section class="slide ...">` wrapper so they
// inherit the deck theme's `.slide` rule (full-viewport sizing, padding,
// centering). Callers occasionally pass bare body markup (e.g. just `<h1>…`),
// which renders as a stray heading glued to the previous slide and breaks
// in-deck navigation since the assembler's `scrollIntoView` has nowhere to
// scroll to. When the body already starts with a `<section>`, trust the
// caller — they may be using intentional class modifiers like `slide cover`
// or a custom theme-specific class.
export function ensureSlideSectionWrap(html_body: string): string {
  if (/^\s*<section\b/i.test(html_body)) return html_body;
  return `<section class="slide">${html_body}</section>`;
}

// Per-deck access check. Mirrors the canvas_can_read_deck SQL helper but runs
// against the admin client (the MCP route bypasses RLS by design — see the
// header comment). Workspace admins/owners always pass; private decks require
// an explicit canvas_deck_member row.
async function assertDeckAccessibleToUser(
  deck_id: string,
  ctx: AuthContext,
): Promise<{ id: string; workspace_id: string; visibility: "workspace" | "private"; created_by: string | null }> {
  const { data: deck, error } = await admin()
    .from("canvas_deck")
    .select("id, workspace_id, visibility, created_by")
    .eq("id", deck_id)
    .eq("workspace_id", ctx.workspace_id)
    .maybeSingle();
  if (error) throw new Error(`deck lookup failed: ${error.message}`);
  if (!deck) throw new ExpectedError(`deck ${deck_id} not found in this workspace`);

  // Workspace admins/owners always pass — same as the DB helpers do.
  const { data: membership } = await admin()
    .from("workspace_memberships")
    .select("role")
    .eq("workspace_id", ctx.workspace_id)
    .eq("user_id", ctx.user_id)
    .maybeSingle();
  const isAdmin =
    membership?.role === "owner" || membership?.role === "admin";

  if (!isAdmin && deck.visibility === "private") {
    const { data: deckMember } = await admin()
      .from("canvas_deck_member")
      .select("role")
      .eq("deck_id", deck_id)
      .eq("user_id", ctx.user_id)
      .maybeSingle();
    if (!deckMember) {
      throw new ExpectedError(`deck ${deck_id} not accessible — you're not invited`);
    }
  }

  return {
    id: deck.id as string,
    workspace_id: deck.workspace_id as string,
    visibility: (deck.visibility === "private" ? "private" : "workspace") as
      | "workspace"
      | "private",
    created_by: (deck.created_by as string | null) ?? null,
  };
}

// Per-deck EDIT check. Mirrors the canvas_can_edit_deck SQL helper (RLS is
// bypassed on the admin client by design — see the header comment). Workspace
// admins/owners always pass; workspace-visibility decks → any member;
// private decks → require an explicit canvas_deck_member row with role
// 'editor'. Use this (not the read-only assert) on every write/lock tool.
async function assertDeckEditableByUser(
  deck_id: string,
  ctx: AuthContext,
): Promise<{ id: string; workspace_id: string; visibility: "workspace" | "private"; created_by: string | null }> {
  const deck = await assertDeckAccessibleToUser(deck_id, ctx); // existence + workspace + read
  const { data: membership } = await admin()
    .from("workspace_memberships")
    .select("role")
    .eq("workspace_id", ctx.workspace_id)
    .eq("user_id", ctx.user_id)
    .maybeSingle();
  if (membership?.role === "owner" || membership?.role === "admin") return deck;
  if (deck.visibility === "workspace") return deck;
  const { data: deckMember } = await admin()
    .from("canvas_deck_member")
    .select("role")
    .eq("deck_id", deck_id)
    .eq("user_id", ctx.user_id)
    .maybeSingle();
  if (deckMember?.role !== "editor") {
    throw new ExpectedError(`deck ${deck_id} is read-only for you`);
  }
  return deck;
}

async function loadSlideAndAssertWorkspace(
  slide_id: string,
  ctxOrWorkspaceId: AuthContext | string,
) {
  const { data, error } = await admin()
    .from("canvas_deck_slide")
    .select(
      "id, workspace_id, deck_id, position, title, html_body, slide_styles, speaker_notes, owner_id, created_by, current_version_id",
    )
    .eq("id", slide_id)
    .maybeSingle();
  if (error) throw new Error(`slide lookup failed: ${error.message}`);
  const workspace_id =
    typeof ctxOrWorkspaceId === "string"
      ? ctxOrWorkspaceId
      : ctxOrWorkspaceId.workspace_id;
  if (!data || data.workspace_id !== workspace_id) {
    throw new ExpectedError(`slide ${slide_id} not found in this workspace`);
  }
  // When the caller passes a full AuthContext, also enforce per-deck
  // visibility. Passing just a workspace_id is the legacy path used by sites
  // that haven't been updated yet — they should be migrated to the ctx form.
  if (typeof ctxOrWorkspaceId !== "string") {
    await assertDeckAccessibleToUser(data.deck_id as string, ctxOrWorkspaceId);
  }
  return data;
}

// ---- Render helpers (render_slide / render_deck) --------------------------

// Buffer / Uint8Array → base64 string for an MCP image content block. The
// rasterizer returns Uint8Array; Buffer.from accepts it without a copy of the
// underlying bytes' meaning (it views the same data) and encodes base64.
function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

// Optional deviceScaleFactor for a render, clamped to a sane range. Defaults to
// 1: these renders are for an AGENT to inspect its own work, where retina crispness
// buys nothing but ~4x the pixels (CPU + memory + encode time) of scale 1. A
// caller that wants a sharper image can still pass scale up to 3; the PDF/PPTX
// exports raster at 2 independently (they call rasterizeDeckHtml with no scale,
// so DEFAULT_SCALE applies there, not this). Floored at 1, capped at 3.
function clampRenderScale(args: unknown): number {
  if (!args || typeof args !== "object") return 1;
  const v = (args as Record<string, unknown>).scale;
  if (typeof v !== "number" || !Number.isFinite(v)) return 1;
  return Math.min(3, Math.max(1, Math.round(v)));
}

// Load a deck's ordered slides (admin client, workspace-scoped — the caller has
// already passed the per-deck access gate) and assemble the SAME self-contained
// export-mode HTML the PDF/PPTX exports render: every asset inlined as a base64
// data: URL, web fonts resolved, so the headless render touches no
// authenticated route. Returns the HTML plus the ordered slide rows so the
// caller can map a screenshot index back to a slide_id/position/title.
async function loadDeckForRender(
  deck_id: string,
  ctx: AuthContext,
): Promise<{
  html: string;
  slides: Array<{ id: string; position: number; title: string }>;
}> {
  const { data: deck, error: deckErr } = await admin()
    .from("canvas_deck")
    .select("title, theme_css, nav_js, meta")
    .eq("id", deck_id)
    .eq("workspace_id", ctx.workspace_id)
    .maybeSingle();
  if (deckErr) throw new Error(`deck lookup failed: ${deckErr.message}`);
  if (!deck) throw new ExpectedError("deck not found");

  const { data: slideRows, error: slideErr } = await admin()
    .from("canvas_deck_slide")
    .select("id, position, title, html_body, slide_styles")
    .eq("deck_id", deck_id)
    .order("position", { ascending: true });
  if (slideErr) throw new Error(`slide lookup failed: ${slideErr.message}`);
  const ordered = slideRows ?? [];
  if (ordered.length === 0) throw new ExpectedError("deck has no slides to render");

  // Asset lookups use the admin client already scoped to this workspace's deck
  // (the caller proved deck access above), mirroring how the export route scopes
  // them under the user's RLS.
  const { html } = await assembleSelfContainedDeck(
    {
      title: deck.title as string,
      theme_css: (deck.theme_css as string | null) ?? "",
      nav_js: (deck.nav_js as string | null) ?? "",
      meta: (deck.meta as Record<string, unknown> | null) ?? {},
    },
    ordered.map((s) => ({
      position: s.position as number,
      title: (s.title as string | null) ?? "",
      html_body: s.html_body as string,
      slide_styles: (s.slide_styles as string | null) ?? null,
    })),
    admin(),
  );

  return {
    html,
    slides: ordered.map((s) => ({
      id: s.id as string,
      position: s.position as number,
      title: (s.title as string | null) ?? "",
    })),
  };
}

// Rasterize the assembled HTML behind the render ConcurrencyGate. On saturation
// we surface a clear, retryable ExpectedError (safe to show the client) rather
// than letting a burst of renders OOM the box.
async function renderDeckShots(html: string, scale: number): Promise<Uint8Array[]> {
  const outcome = await renderGate.run(async () => {
    const { shots } = await rasterizeDeckHtml(html, { scale });
    return shots;
  });
  if (!outcome.ok) {
    throw new ExpectedError(
      "Render is busy — another deck is already rendering on this server. Retry in a moment.",
    );
  }
  return outcome.value;
}

// Deck chrome (title/theme/nav/meta + any extra columns) for a render. Kept as
// a tiny helper so the single-slide render paths can ask for exactly the
// columns they need in one select.
async function loadDeckChromeRow(
  deck_id: string,
  ctx: AuthContext,
  extraColumns = "",
): Promise<Record<string, unknown>> {
  const columns = `title, theme_css, nav_js, meta${extraColumns ? `, ${extraColumns}` : ""}`;
  const { data: deckRow, error: deckErr } = await admin()
    .from("canvas_deck")
    .select(columns)
    .eq("id", deck_id)
    .eq("workspace_id", ctx.workspace_id)
    .maybeSingle();
  if (deckErr) throw new Error(`deck lookup failed: ${deckErr.message}`);
  if (!deckRow) throw new ExpectedError("deck not found");
  return deckRow as unknown as Record<string, unknown>;
}

// Render ONE slide as a self-contained single-slide deck (deck chrome + theme
// + that slide, assets inlined) — the fast render path shared by render_slide
// and render_proposal. Cost scales with the slide, not the deck: rasterizing
// the whole deck to return one image made render_slide cost 17–22s on real
// decks (speed discovery 2026-07); this shape is ~3s. Returns null when the
// body produced no rasterizable <section class="slide"> shot.
async function renderSingleSlideShot(
  deck: Record<string, unknown>,
  slide: { title: string; html_body: string; slide_styles: string | null },
  scale: number,
): Promise<Uint8Array | null> {
  const { html } = await assembleSelfContainedDeck(
    {
      title: deck.title as string,
      theme_css: (deck.theme_css as string | null) ?? "",
      nav_js: (deck.nav_js as string | null) ?? "",
      meta: (deck.meta as Record<string, unknown> | null) ?? {},
    },
    [
      {
        position: 0,
        title: slide.title,
        html_body: slide.html_body,
        slide_styles: slide.slide_styles,
      },
    ],
    admin(),
  );
  const shots = await renderDeckShots(html, scale);
  return shots.length > 0 ? shots[0] : null;
}

// Supersede-on-propose (speed discovery 2026-07 #7): a proposer's older
// pending content proposals on the SAME slide are dead weight once a newer one
// lands (each is a full payload resolved at propose time; approving an old
// sibling after the new one would clobber it). Advisory like the patch nudge:
// the new proposal is ALREADY committed when this runs, so a sweep failure is
// logged and swallowed — it must never report a persisted proposal as failed.
async function supersedeOwnStalePendings(
  slideId: string,
  proposedBy: string,
  newEditId: string,
): Promise<string[]> {
  try {
    return await supersedeOlderPendingProposals(admin(), {
      slideId,
      proposedBy,
      newEditId,
    });
  } catch (e) {
    console.error(`[mcp:tool] supersede sweep failed (edit ${newEditId}):`, e);
    return [];
  }
}

// Read-only mirror of canvas_apply_trusted_agent_edit's gates (migration 0057)
// minus the per-proposal fields the caller already holds: reports whether
// apply_trusted_proposal WOULD succeed right now for this caller on this
// deck/slide. render_proposal uses it to offer the fast lane only when the
// call is real — the old unconditional invitation burned an agent turn on
// every deck that never opted in (speed discovery 2026-07 #1).
async function trustedFastLaneAvailable(
  ctx: AuthContext,
  deck: { agent_fast_lane_enabled?: unknown; created_by?: unknown },
  slide: { owner_id?: unknown; created_by?: unknown },
): Promise<boolean> {
  if (!deck.agent_fast_lane_enabled) return false;
  const [{ data: workspace }, { data: membership }] = await Promise.all([
    admin()
      .from("workspaces")
      .select("canvas_allow_self_approval")
      .eq("id", ctx.workspace_id)
      .maybeSingle(),
    admin()
      .from("workspace_memberships")
      .select("role")
      .eq("workspace_id", ctx.workspace_id)
      .eq("user_id", ctx.user_id)
      .maybeSingle(),
  ]);
  if (!workspace?.canvas_allow_self_approval) return false;
  const role = membership?.role as string | undefined;
  if (!role || role === "guest") return false;
  if (role === "owner" || role === "admin") return true;
  if (deck.created_by !== ctx.user_id) return false;
  return (
    slide.owner_id == null ||
    slide.owner_id === ctx.user_id ||
    slide.created_by === ctx.user_id
  );
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

// Resolve a project inside the caller's workspace, or throw. Mirrors the 0038
// FK + the import route's RLS lookup — the MCP route runs on the admin client,
// so this manual check is the only thing stopping a cross-workspace pointer.
async function assertProjectInWorkspace(
  project_id: string,
  ctx: AuthContext,
): Promise<{ id: string; name: string }> {
  const { data: project, error } = await admin()
    .from("canvas_project")
    .select("id, name")
    .eq("id", project_id)
    .eq("workspace_id", ctx.workspace_id)
    .maybeSingle();
  if (error) throw new Error(`project lookup failed: ${error.message}`);
  if (!project) {
    throw new ExpectedError(
      `project ${project_id} not found in this workspace — call list_projects first`,
    );
  }
  return { id: project.id as string, name: project.name as string };
}

// Full-member gate (owner/admin/member — excludes guests), shared by the
// project tools and create_deck. Mirrors the is_workspace_member_full RLS
// helper: guests are deck-scoped outside reviewers, so they can't create
// decks (0025 web policy) or see the project taxonomy (0038) — and the MCP
// route bypasses RLS, so this manual check is the enforcement. Returns the
// role so callers can branch on admin/owner without a second lookup.
async function assertFullMember(
  ctx: AuthContext,
  capability: string,
): Promise<"owner" | "admin" | "member"> {
  const { data: membership } = await admin()
    .from("workspace_memberships")
    .select("role")
    .eq("workspace_id", ctx.workspace_id)
    .eq("user_id", ctx.user_id)
    .maybeSingle();
  if (!membership) {
    throw new ExpectedError("You are not a member of this workspace");
  }
  if (membership.role === "guest") {
    throw new ExpectedError(`Guest accounts can't ${capability}`);
  }
  return membership.role as "owner" | "admin" | "member";
}

// Visibility filter shared by list_decks and list_projects' deck counts:
// workspace admins/owners see every deck; everyone else sees workspace-
// visibility decks plus private decks they hold an explicit
// canvas_deck_member grant on — the same rule as the canvas_can_read_deck
// SQL helper. Without this, a count or list would leak the existence of
// private decks the caller can't open.
async function dropInaccessiblePrivateDecks<
  T extends { id: string; visibility: string | null },
>(rows: T[], ctx: AuthContext, isAdmin: boolean): Promise<T[]> {
  if (isAdmin) return rows;
  const privateIds = rows
    .filter((r) => r.visibility === "private")
    .map((r) => r.id);
  if (privateIds.length === 0) return rows;
  const { data: members } = await admin()
    .from("canvas_deck_member")
    .select("deck_id")
    .eq("user_id", ctx.user_id)
    .in("deck_id", privateIds);
  const accessible = new Set((members ?? []).map((m) => m.deck_id as string));
  return rows.filter(
    (r) => r.visibility !== "private" || accessible.has(r.id),
  );
}

// withdraw_proposal's result contract in one place. withdraw is idempotent
// across terminal states, so the return is a union keyed on `withdrawn` (the
// per-call signal); the extra fields route the no-op cases. `satisfies` at each
// return site catches a mistyped field name that ToolFn's `unknown` would
// otherwise erase. See the withdraw_proposal handler.
type WithdrawProposalResult =
  | { edit_id: string; status: "rejected"; withdrawn: true }
  | {
      edit_id: string;
      status: "applied";
      withdrawn: false;
      action_required: "revert_proposal";
      note: string;
    }
  | {
      edit_id: string;
      status: string;
      withdrawn: false;
      already_resolved: true;
      note: string;
    };

export const tools: Record<string, ToolFn> = {
  // Greenfield deck creation. There's no existing deck to gate on (the edit
  // tools use assertDeckEditableByUser, which presupposes one), so we gate on
  // FULL workspace membership — guests can't create decks on the web (the
  // 0025 INSERT policy uses is_workspace_member_full) and the MCP route
  // bypasses RLS, so assertFullMember is what enforces parity here.
  // Writes directly via the importer (no proposal): there is no deck/reviewer
  // to attach a pending edit to until the deck exists. Starts as a blank deck
  // (one cover slide); populate it with propose_new_slide / propose_slide_edit.
  create_deck: async (args, ctx) => {
    const title = requireString(args, "title").trim().slice(0, 200);
    const visibilityArg = optionalString(args, "visibility");
    const visibility = visibilityArg === "private" ? "private" : "workspace";
    const projectArg = optionalString(args, "project_id")?.trim();

    await assertFullMember(ctx, "create decks");

    const project = projectArg
      ? await assertProjectInWorkspace(projectArg, ctx)
      : null;

    const result = await importDeckFromHtml(blankDeckHtml(title), {
      workspace_id: ctx.workspace_id,
      user_id: ctx.user_id,
      title,
      visibility,
      project_id: project?.id ?? null,
    });
    return {
      deck_id: result.deck_id,
      slide_count: result.slide_count,
      title,
      visibility,
      project_id: project?.id ?? null,
    };
  },

  // -- Projects -------------------------------------------------------------
  // A Project is a named deck group inside the workspace (e.g. one client
  // proposal holding its decks) — pure organization, not a permission
  // boundary. See migration 0038.

  list_projects: async (_args, ctx) => {
    const role = await assertFullMember(ctx, "list projects");
    const isAdmin = role === "owner" || role === "admin";
    const [projectsResp, decksResp] = await Promise.all([
      admin()
        .from("canvas_project")
        .select("id, name, description, created_at, updated_at")
        .eq("workspace_id", ctx.workspace_id)
        .order("name", { ascending: true }),
      admin()
        .from("canvas_deck")
        .select("id, project_id, visibility")
        .eq("workspace_id", ctx.workspace_id)
        .not("project_id", "is", null),
    ]);
    if (projectsResp.error) throw new Error(projectsResp.error.message);
    if (decksResp.error) throw new Error(decksResp.error.message);
    // Count only decks the caller could actually see via list_decks —
    // otherwise deck_count leaks the existence of private decks.
    const visibleDecks = await dropInaccessiblePrivateDecks(
      (decksResp.data ?? []) as {
        id: string;
        project_id: string;
        visibility: string | null;
      }[],
      ctx,
      isAdmin,
    );
    const countByProject = new Map<string, number>();
    for (const row of visibleDecks) {
      const pid = row.project_id;
      countByProject.set(pid, (countByProject.get(pid) ?? 0) + 1);
    }
    return {
      projects: (projectsResp.data ?? []).map((p) => ({
        ...p,
        deck_count: countByProject.get(p.id as string) ?? 0,
      })),
    };
  },

  create_project: async (args, ctx) => {
    const name = requireString(args, "name").trim().slice(0, 120);
    if (!name) throw new ExpectedError("name must not be empty");
    const description = optionalString(args, "description")?.trim() || null;
    await assertFullMember(ctx, "create projects");

    const { data, error } = await admin()
      .from("canvas_project")
      .insert({
        workspace_id: ctx.workspace_id,
        name,
        description,
        created_by: ctx.user_id,
      })
      .select("id, name")
      .single();
    if (error) {
      // Unique (workspace_id, lower(name)) violation → return the existing
      // project instead of erroring, so "create project X" is idempotent.
      // The winner is necessarily committed by the time 23505 surfaces
      // (unique checks block on the in-flight row), so a targeted lookup
      // finds it. Escape LIKE wildcards so ilike is an exact
      // case-insensitive match, not a pattern.
      if (error.code === "23505") {
        const pattern = name.replace(/[\\%_]/g, (c) => `\\${c}`);
        const { data: existing } = await admin()
          .from("canvas_project")
          .select("id, name")
          .eq("workspace_id", ctx.workspace_id)
          .ilike("name", pattern)
          .maybeSingle();
        if (existing) {
          return { project_id: existing.id, name: existing.name, already_existed: true };
        }
      }
      throw new Error(`project insert failed: ${error.message}`);
    }
    return { project_id: data.id, name: data.name, already_existed: false };
  },
  // -- Discovery ----------------------------------------------------------

  list_decks: async (args, ctx) => {
    // Optional project filter — validate first so a bad id errors loudly
    // instead of returning a confusing empty list.
    const projectArg = optionalString(args, "project_id")?.trim();
    if (projectArg) await assertProjectInWorkspace(projectArg, ctx);

    let query = admin()
      .from("canvas_deck")
      .select("id, title, status, updated_at, created_at, visibility, project_id")
      .eq("workspace_id", ctx.workspace_id)
      .order("updated_at", { ascending: false });
    if (projectArg) query = query.eq("project_id", projectArg);
    const { data, error } = await query;
    if (error) throw new Error(error.message);
    const rows = data ?? [];

    // Workspace admins/owners see every deck — same rule as the DB helpers.
    const { data: membership } = await admin()
      .from("workspace_memberships")
      .select("role")
      .eq("workspace_id", ctx.workspace_id)
      .eq("user_id", ctx.user_id)
      .maybeSingle();
    const isAdmin =
      membership?.role === "owner" || membership?.role === "admin";
    const filtered = await dropInaccessiblePrivateDecks(
      rows as { id: string; visibility: string | null }[],
      ctx,
      isAdmin,
    );
    return { decks: filtered };
  },

  get_deck: async (args, ctx) => {
    const deck_id = requireString(args, "deck_id");
    await assertDeckAccessibleToUser(deck_id, ctx);

    const { data: deck, error: deckErr } = await admin()
      .from("canvas_deck")
      .select(
        "id, title, status, meta, created_at, updated_at, visibility, project_id, agent_fast_lane_enabled",
      )
      .eq("id", deck_id)
      .eq("workspace_id", ctx.workspace_id)
      .maybeSingle();
    if (deckErr) throw new Error(deckErr.message);
    if (!deck) throw new ExpectedError(`deck not found`);

    const { data: slides } = await admin()
      .from("canvas_deck_slide")
      .select("id, position, title, owner_id, current_version_id")
      .eq("deck_id", deck_id)
      .order("position", { ascending: true });

    const slideIds = (slides ?? []).map((s) => s.id);
    const versions = slideIds.length
      ? (await admin()
          .from("canvas_slide_version")
          .select("id, slide_id, version_no")
          .in("id", (slides ?? [])
            .map((s) => s.current_version_id)
            .filter((v): v is string => Boolean(v)))).data ?? []
      : [];
    const versionByCurrentId = new Map(versions.map((v) => [v.id, v.version_no]));

    const locks = slideIds.length
      ? (await admin()
          .from("canvas_deck_slide_lock")
          .select("slide_id, locked_by, locked_by_kind, expires_at")
          .in("slide_id", slideIds)).data ?? []
      : [];
    const lockBySlide = new Map(
      locks
        .filter((l) => new Date(l.expires_at).getTime() > Date.now())
        .map((l) => [l.slide_id, l]),
    );

    return {
      deck,
      slides: (slides ?? []).map((s) => ({
        id: s.id,
        position: s.position,
        title: s.title,
        owner_id: s.owner_id,
        current_version_no: s.current_version_id
          ? versionByCurrentId.get(s.current_version_id) ?? null
          : null,
        locked: lockBySlide.has(s.id),
        lock: lockBySlide.get(s.id) ?? null,
      })),
    };
  },

  read_slide: async (args, ctx) => {
    const slide_id = requireString(args, "slide_id");
    const slide = await loadSlideAndAssertWorkspace(slide_id, ctx);
    const { data: version } = slide.current_version_id
      ? await admin()
          .from("canvas_slide_version")
          .select("version_no")
          .eq("id", slide.current_version_id)
          .maybeSingle()
      : { data: null };
    return {
      id: slide.id,
      deck_id: slide.deck_id,
      position: slide.position,
      title: slide.title,
      html_body: slide.html_body,
      slide_styles: slide.slide_styles,
      speaker_notes: slide.speaker_notes ?? null,
      current_version_no: version?.version_no ?? null,
    };
  },

  // DIRECT write — the second deliberate exception to propose-first after
  // create_deck (ADR-0012 litmus: notes are presenter working text, not the
  // visual deliverable; a review gate on a talk track is pure friction).
  // Last-write-wins, not versioned, deck-shared.
  write_slide_notes: async (args, ctx) => {
    const slide_id = requireString(args, "slide_id");
    const notesRaw = (args as Record<string, unknown>).notes;
    if (typeof notesRaw !== "string") {
      throw new ExpectedError('Argument "notes" (string) is required — pass "" to clear.');
    }
    const notes = notesRaw.trim().slice(0, 20_000);

    const slide = await loadSlideAndAssertWorkspace(slide_id, ctx);
    await assertDeckEditableByUser(slide.deck_id as string, ctx);

    const { data: updated, error } = await admin()
      .from("canvas_deck_slide")
      .update({ speaker_notes: notes === "" ? null : notes })
      .eq("id", slide_id)
      .eq("workspace_id", ctx.workspace_id)
      .select("id");
    if (error) throw new Error(`notes update failed: ${error.message}`);
    if (!updated || updated.length === 0) {
      throw new ExpectedError("notes update landed no row — reload and retry");
    }
    return { slide_id, saved: true, cleared: notes === "" };
  },

  read_theme: async (args, ctx) => {
    const deck_id = requireString(args, "deck_id");
    await assertDeckAccessibleToUser(deck_id, ctx);
    const { data, error } = await admin()
      .from("canvas_deck")
      .select("theme_css, nav_js")
      .eq("id", deck_id)
      .eq("workspace_id", ctx.workspace_id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new ExpectedError("deck not found");
    return { theme_css: data.theme_css, nav_js: data.nav_js };
  },

  read_brand: async (_args, ctx) => {
    // Workspace-scoped (no deck_id): the token's workspace IS the scope, and
    // membership was already asserted when the token resolved. Returns the
    // full token bag — the assistant's per-turn injection carries only a
    // compact blurb; this is where an agent gets the complete set.
    const { data, error } = await admin()
      .from("canvas_brand")
      .select("name, tokens, voice, updated_at")
      .eq("workspace_id", ctx.workspace_id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) {
      return {
        configured: false,
        hint: "No brand kit set for this workspace yet — an admin can add one under Settings → Brand.",
      };
    }
    return {
      configured: true,
      name: data.name,
      tokens: normalizeBrandTokens(data.tokens),
      voice: data.voice,
      updated_at: data.updated_at,
    };
  },

  read_full_deck: async (args, ctx) => {
    const deck_id = requireString(args, "deck_id");
    await assertDeckAccessibleToUser(deck_id, ctx);
    const { data: deck } = await admin()
      .from("canvas_deck")
      .select("title, theme_css, nav_js, meta")
      .eq("id", deck_id)
      .eq("workspace_id", ctx.workspace_id)
      .maybeSingle();
    if (!deck) throw new ExpectedError("deck not found");
    const { data: slides } = await admin()
      .from("canvas_deck_slide")
      .select("id, position, title, html_body, slide_styles, current_version_id")
      .eq("deck_id", deck_id)
      .order("position", { ascending: true });
    // Slide metadata rides along with the assembled HTML so a caller that only
    // did a deck-wide read still has the slide_ids and current_version_no it
    // needs to propose edits (propose_slide_edit requires base_version_no)
    // without a per-slide read round-trip.
    const versionIds = (slides ?? [])
      .map((s) => s.current_version_id as string | null)
      .filter((id): id is string => id !== null);
    const { data: versions } = versionIds.length
      ? await admin()
          .from("canvas_slide_version")
          .select("id, version_no")
          .in("id", versionIds)
      : { data: [] as { id: string; version_no: number }[] };
    const versionNoById = new Map(
      (versions ?? []).map((v) => [v.id as string, v.version_no as number]),
    );
    return {
      html: assembleDeckHtml({
        title: deck.title,
        theme_css: deck.theme_css ?? "",
        nav_js: deck.nav_js ?? "",
        meta: (deck.meta ?? {}) as Record<string, unknown>,
        slides: slides ?? [],
      }),
      slides: (slides ?? []).map((s) => ({
        slide_id: s.id,
        position: s.position,
        title: s.title,
        current_version_no: s.current_version_id
          ? versionNoById.get(s.current_version_id as string) ?? null
          : null,
      })),
    };
  },

  // -- Sources (pinned reference material) --------------------------------
  // canvas_deck_source rows are the PDFs / URLs / pasted text a human pinned to
  // a deck (global context) or a single slide (slide-specific context) as "what
  // Claude reads when drafting". These two tools are the READ path: list what's
  // pinned, then read one source's full content. They're read-only and gated
  // exactly like read_slide / read_full_deck — workspace-scoped on the admin
  // client (the MCP route bypasses RLS by design) with the per-deck access check
  // — so an uninvited member can't enumerate a private deck's sources. A pinned
  // PDF/file's binary content is NOT fetched here (out of scope this round); the
  // row carries storage_path so Claude knows the asset exists and can name it.

  list_sources: async (args, ctx) => {
    const deck_id = requireString(args, "deck_id");
    const slide_id = optionalString(args, "slide_id")?.trim();
    await assertDeckAccessibleToUser(deck_id, ctx);

    // Deck-pinned sources (slide_id IS NULL) are global context for the whole
    // deck; slide-pinned sources hang off one slide. We always return the
    // deck-global ones, and ALSO the given slide's when slide_id is passed —
    // that's the full set of reference material in scope for drafting that
    // slide. Without a slide_id we return every source on the deck (global +
    // all slides) so a caller can see the deck's whole pinned corpus.
    const { data, error } = await admin()
      .from("canvas_deck_source")
      .select("id, deck_id, slide_id, kind, label, url, storage_path, body, created_at")
      .eq("workspace_id", ctx.workspace_id)
      .eq("deck_id", deck_id)
      .order("created_at", { ascending: true });
    if (error) throw new Error(error.message);
    let rows = data ?? [];
    if (slide_id) {
      // Narrow to this slide's context: deck-global sources plus the ones
      // pinned to exactly this slide. Filtering in memory (the deck's source
      // set is small) keeps it to one query and avoids an `.or()` the mock
      // harness doesn't model.
      rows = rows.filter(
        (r) => r.slide_id === null || r.slide_id === slide_id,
      );
    }

    // A short body preview only — the full body can be large (pasted text), and
    // the point of the list is to let Claude pick which source to read_source.
    return {
      sources: rows.map((r) => ({
        id: r.id,
        deck_id: r.deck_id,
        slide_id: r.slide_id,
        kind: r.kind,
        label: r.label,
        url: r.url,
        has_body: typeof r.body === "string" && r.body.length > 0,
        body_preview: sourceBodyPreview(r.body as string | null),
        is_binary: r.storage_path !== null && r.storage_path !== undefined,
      })),
    };
  },

  read_source: async (args, ctx) => {
    const source_id = requireString(args, "source_id");

    const { data: source, error } = await admin()
      .from("canvas_deck_source")
      .select("id, deck_id, slide_id, kind, label, url, storage_path, body, created_at")
      .eq("id", source_id)
      .eq("workspace_id", ctx.workspace_id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!source) throw new ExpectedError(`source ${source_id} not found in this workspace`);
    // Per-deck gate: a workspace member who isn't invited to a private deck must
    // not be able to read that deck's pinned sources.
    await assertDeckAccessibleToUser(source.deck_id as string, ctx);

    // Binary sources (pdf/file pinned via storage_path) aren't fetched this
    // round — return enough that Claude knows the asset exists, its label/url,
    // and where it lives, with an explicit note rather than a silent empty body.
    const isBinary =
      source.storage_path !== null && source.storage_path !== undefined;
    return {
      id: source.id,
      deck_id: source.deck_id,
      slide_id: source.slide_id,
      kind: source.kind,
      label: source.label,
      url: source.url,
      body: (source.body as string | null) ?? null,
      storage_path: (source.storage_path as string | null) ?? null,
      created_at: source.created_at,
      ...(isBinary
        ? {
            note: "This source is a stored binary (PDF/file); its content isn't fetched here. Use its label and url to reason about what it is, and ask the human if you need its contents.",
          }
        : {}),
    };
  },

  // -- Render (give the agent eyes) --------------------------------------
  // render_slide / render_deck rasterize the deck in headless Chromium and hand
  // back a JPEG image (MCP `image` content block) of the laid-out result. The
  // editing-10x discovery showed the root cause of the slow edit loop was a
  // BLIND editor: Claude proposes HTML/CSS, can't see how it actually renders,
  // and iterates by guesswork. These tools close that loop — propose, then
  // render to verify before telling the human it's done.
  //
  // They load + assemble the deck the same way the read tools do (admin client
  // scoped by workspace, per-deck access gate), produce the SAME self-contained
  // export-mode HTML the PDF/PPTX exports render (assets inlined as base64), and
  // screenshot each slide at native size via the shared rasterizer. Gated behind
  // the render ConcurrencyGate so a burst can't OOM the box.

  render_slide: async (args, ctx) => {
    const slide_id = requireString(args, "slide_id");
    const scale = clampRenderScale(args);

    // Resolve the slide → deck and enforce per-deck read access the same way
    // read_slide does, BEFORE doing any expensive render work.
    const slide = await loadSlideAndAssertWorkspace(slide_id, ctx);
    const deck_id = slide.deck_id as string;

    // Assemble ONLY this slide (deck chrome + theme + the one slide) instead
    // of rasterizing the whole deck for one image — the same single-slide
    // shape render_proposal has always rendered, so the capture matches what
    // a reviewer sees for a proposal on this slide.
    const deckRow = await loadDeckChromeRow(deck_id, ctx);
    const shot = await renderSingleSlideShot(
      deckRow,
      {
        title: (slide.title as string | null) ?? "",
        html_body: slide.html_body as string,
        slide_styles: (slide.slide_styles as string | null) ?? null,
      },
      scale,
    );
    if (!shot) {
      throw new ExpectedError(
        `slide ${slide_id} produced no rendered image — its html_body may be missing its <section class="slide"> wrapper`,
      );
    }

    return {
      __mcpContent: [
        {
          type: "text",
          text: `Rendered slide at position ${slide.position} (slide_id ${slide_id}) of deck ${deck_id} — rendered in isolation with the deck theme applied.`,
        },
        { type: "image", data: toBase64(shot), mimeType: "image/jpeg" },
      ],
    } satisfies McpContentResult;
  },

  render_deck: async (args, ctx) => {
    const deck_id = requireString(args, "deck_id");
    const scale = clampRenderScale(args);
    await assertDeckAccessibleToUser(deck_id, ctx);

    const { html, slides } = await loadDeckForRender(deck_id, ctx);
    const shots = await renderDeckShots(html, scale);

    // One text label + one image per slide, in order. A render that produced
    // fewer images than slides (malformed bodies) still returns what it has —
    // the labels make the alignment explicit so Claude isn't misled.
    const content: McpContentResult["__mcpContent"] = [
      {
        type: "text",
        text: `Rendered ${shots.length} slide(s) of deck ${deck_id}, in order.`,
      },
    ];
    for (let i = 0; i < shots.length; i++) {
      const label = slides[i]
        ? `Slide ${slides[i].position} — ${slides[i].title || "(untitled)"}`
        : `Slide image ${i + 1}`;
      content.push({ type: "text", text: label });
      content.push({ type: "image", data: toBase64(shots[i]), mimeType: "image/jpeg" });
    }
    return { __mcpContent: content } satisfies McpContentResult;
  },

  render_proposal: async (args, ctx) => {
    // Closes the loop render_slide can't: render the slide AS a PENDING proposal
    // would leave it, so Claude can SEE its own just-proposed change before the
    // human reviews it (render_slide only shows current, applied content). Pass
    // the edit_id returned by propose_slide_patch / propose_slide_edit.
    const proposal_id = requireString(args, "proposal_id");
    const scale = clampRenderScale(args);

    // Load the proposal (admin; the per-deck access gate is re-enforced below).
    const { data: edit, error: editErr } = await admin()
      .from("canvas_deck_edit")
      .select(
        "deck_id, slide_id, kind, status, new_content, new_slide_payload, auto_apply_eligible, proposed_by",
      )
      .eq("id", proposal_id)
      .maybeSingle();
    if (editErr) throw new Error(`proposal lookup failed: ${editErr.message}`);
    if (!edit) throw new ExpectedError(`proposal ${proposal_id} not found`);

    const deck_id = edit.deck_id as string;
    // Workspace + per-deck visibility gate BEFORE any render work — same gate
    // render_slide uses. A cross-workspace or no-access proposal throws here.
    await assertDeckAccessibleToUser(deck_id, ctx);

    if (edit.status !== "pending") {
      throw new ExpectedError(
        `proposal ${proposal_id} is ${edit.status}, not pending — render_proposal previews a PENDING proposal's would-be result. An applied proposal IS the live slide, so use render_slide for that.`,
      );
    }

    const slide_id = edit.slide_id as string | null;

    // slide_create proposals (propose_new_slide / propose_duplicate_slide /
    // copy_slide) have no existing slide to merge over — the payload IS the
    // slide, so render it directly. Before this branch, adds were the one
    // proposal kind that couldn't be render-verified at all (blind adds).
    if (!slide_id && edit.kind === "slide_create") {
      const payload =
        (edit.new_slide_payload as {
          html_body?: string;
          slide_styles?: string;
          title?: string;
          position?: number;
        } | null) ?? null;
      if (!payload?.html_body) {
        throw new ExpectedError(
          `proposal ${proposal_id} carries no html_body payload — there's nothing to render`,
        );
      }
      const deckRow = await loadDeckChromeRow(deck_id, ctx);
      const shot = await renderSingleSlideShot(
        deckRow,
        {
          title: payload.title ?? "",
          html_body: payload.html_body,
          slide_styles: payload.slide_styles ?? null,
        },
        scale,
      );
      if (!shot) {
        throw new ExpectedError(
          `the proposed slide produced no rendered image — its html_body may be missing its <section class="slide"> wrapper`,
        );
      }
      return {
        __mcpContent: [
          {
            type: "text",
            text: `Rendered PENDING slide_create proposal ${proposal_id} — this is how the NEW slide would look once approved${typeof payload.position === "number" ? ` (inserting at position ${payload.position})` : ""}, NOT a live slide. It stays pending human review in the Canvas Review rail.`,
          },
          { type: "image", data: toBase64(shot), mimeType: "image/jpeg" },
        ],
      } satisfies McpContentResult;
    }

    if (!slide_id) {
      throw new ExpectedError(
        `proposal ${proposal_id} (kind ${edit.kind}) doesn't target a single slide, so there's nothing to preview as one image. Review the deck after approval with render_deck.`,
      );
    }

    // Current slide content under the workspace/visibility gate (re-checks access).
    const slide = await loadSlideAndAssertWorkspace(slide_id, ctx);
    const patched = previewProposalOnSlide(
      {
        title: (slide.title as string | null) ?? "",
        html_body: slide.html_body as string,
        slide_styles: (slide.slide_styles as string | null) ?? null,
      },
      {
        kind: edit.kind as string,
        new_content: (edit.new_content as string | null) ?? null,
        new_slide_payload:
          (edit.new_slide_payload as {
            html_body?: string;
            slide_styles?: string;
            title?: string;
          } | null) ?? null,
      },
    );
    if (!patched) {
      throw new ExpectedError(
        `proposal ${proposal_id} (kind ${edit.kind}) doesn't change slide ${slide_id}'s rendered body — there's nothing visual to preview as one slide. Theme/structural changes show across the deck; use render_deck after approval.`,
      );
    }

    // Load the deck chrome (theme/nav/meta) and render JUST the proposed slide as
    // a self-contained single-slide deck — the same capture the reviewer
    // thumbnail and the exports use, so the preview matches the eventual version.
    // The extra columns feed the fast-lane availability check below.
    const deckRow = await loadDeckChromeRow(
      deck_id,
      ctx,
      "agent_fast_lane_enabled, created_by",
    );
    const shot = await renderSingleSlideShot(
      deckRow,
      {
        title: patched.title,
        html_body: patched.html_body,
        slide_styles: patched.slide_styles,
      },
      scale,
    );
    if (!shot) {
      throw new ExpectedError(
        `the proposed slide produced no rendered image — its html_body may be missing its <section class="slide"> wrapper`,
      );
    }

    // A successful raster is the proof required by the trusted fast lane.
    // Only the service can stamp this field; the apply tool still performs all
    // deck/workspace/ownership checks before committing the proposal. The mark
    // RPC only accepts the proposer's own render (anyone else's is a no-op),
    // so don't spend the call for other callers.
    const isOwnProposal = edit.proposed_by === ctx.user_id;
    if (edit.auto_apply_eligible && isOwnProposal) {
      const { error: markError } = await admin().rpc(
        "canvas_mark_agent_proposal_rendered",
        { _edit_id: proposal_id, _actor_id: ctx.user_id },
      );
      if (markError) {
        throw new Error(`proposal render mark failed: ${markError.message}`);
      }
    }

    // Offer apply_trusted_proposal ONLY when it would actually succeed — an
    // invitation on a deck that never opted in burns an agent turn on a
    // guaranteed refusal and teaches it the lane is dead. The lane applies
    // only the proposer's OWN patch (canvas_apply_trusted_agent_edit checks
    // proposed_by = actor), so a reviewer rendering someone else's proposal
    // must not be invited to apply it.
    const fastLaneOpen =
      Boolean(edit.auto_apply_eligible) &&
      isOwnProposal &&
      (await trustedFastLaneAvailable(ctx, deckRow, slide));

    return {
      __mcpContent: [
        {
          type: "text",
          text: `Rendered PENDING proposal ${proposal_id} (kind ${edit.kind}) on slide ${slide_id} of deck ${deck_id} — this is how the slide WOULD look once approved, NOT the live slide.${fastLaneOpen ? " This deck has the trusted fast lane enabled for your verified patches: if the image is visually correct, call apply_trusted_proposal to land it now." : " It is not applied yet; it stays pending human review in the Canvas Review rail."}`,
        },
        { type: "image", data: toBase64(shot), mimeType: "image/jpeg" },
      ],
    } satisfies McpContentResult;
  },

  apply_trusted_proposal: async (args, ctx) => {
    const proposal_id = requireString(args, "proposal_id");
    const { data: edit, error: lookupError } = await admin()
      .from("canvas_deck_edit")
      .select("id, workspace_id, deck_id, slide_id, proposed_by, status, auto_apply_eligible, agent_rendered_at")
      .eq("id", proposal_id)
      .eq("workspace_id", ctx.workspace_id)
      .eq("proposed_by", ctx.user_id)
      .maybeSingle();
    if (lookupError) throw new Error(`proposal lookup failed: ${lookupError.message}`);
    if (!edit) throw new ExpectedError("proposal not found or it belongs to another user");
    if (edit.status !== "pending") {
      throw new ExpectedError(`proposal ${proposal_id} is already ${edit.status}`);
    }
    if (!edit.auto_apply_eligible) {
      throw new ExpectedError(
        "Only deterministic propose_slide_patch / propose_deck_patch changes can use the trusted fast lane.",
      );
    }
    if (!edit.agent_rendered_at) {
      throw new ExpectedError(
        "Render this proposal with render_proposal and visually inspect it before applying it.",
      );
    }

    const { error } = await admin().rpc("canvas_apply_trusted_agent_edit", {
      _edit_id: proposal_id,
      _actor_id: ctx.user_id,
    });
    if (error) {
      if (/workspace self-approval is disabled|deck is not opted in/.test(error.message)) {
        throw new ExpectedError(
          "Trusted fast lane is not enabled for this deck and workspace. Leave the proposal in Review for a human.",
        );
      }
      if (/does not own|not a full workspace member/.test(error.message)) {
        throw new ExpectedError(
          "This proposal needs a human reviewer because you do not own its deck or slide.",
        );
      }
      throw new Error(`trusted proposal apply failed: ${error.message}`);
    }
    return {
      proposal_id,
      deck_id: edit.deck_id,
      slide_id: edit.slide_id,
      status: "applied",
      applied_by: ctx.user_id,
      note: "Applied through the deck's trusted fast lane after render verification.",
    };
  },

  // -- Proposals (write) --------------------------------------------------
  // Every change to a slide or theme/nav goes through canvas_deck_edit as a
  // pending proposal. Owner (or workspace admin) reviews + approves through
  // the UI; the apply step inserts the new canvas_slide_version row. The MCP
  // surface intentionally has no direct-write tool — by design.

  propose_slide_edit: async (args, ctx) => {
    const slide_id = requireString(args, "slide_id");
    const base_version_no = requireBaseVersionNo(args);
    const new_html_body = optionalString(args, "new_html_body");
    const new_slide_styles = optionalString(args, "new_slide_styles");
    const new_title = optionalString(args, "new_title");
    const rationale = optionalString(args, "rationale");

    // A slide edit bundles whatever fields the caller provides — html body,
    // scoped styles, and/or the slide's title (the label shown in the editor's
    // slide list) — into ONE proposal that's reviewed and applied atomically as
    // a single new version. At least one field is required.
    const provided = [
      new_html_body !== undefined ? "html_body" : null,
      new_slide_styles !== undefined ? "slide_styles" : null,
      new_title !== undefined ? "title" : null,
    ].filter((k): k is string => k !== null);
    if (provided.length === 0) {
      throw new ExpectedError(
        "propose_slide_edit requires at least one of: new_html_body, new_slide_styles, new_title",
      );
    }
    if (new_html_body !== undefined) assertPayloadSize("new_html_body", new_html_body);
    if (new_slide_styles !== undefined) assertPayloadSize("new_slide_styles", new_slide_styles);
    if (new_title !== undefined) assertPayloadSize("new_title", new_title);

    const slide = await loadSlideAndAssertWorkspace(slide_id, ctx);
    // Write path: viewers can read this slide's deck but must not author edits.
    await assertDeckEditableByUser(slide.deck_id as string, ctx);

    // Anti-clobber gate: reject the proposal when the slide has moved on since
    // the caller read it. Approving a full replacement built from a stale copy
    // silently reverts every newer version — humans editing text in the Canvas
    // UI mid-session were the repeat victim. A slide with no version row yet
    // (or a dangling pointer) has no history to revert, so the check is
    // skipped rather than locking the slide out of edits.
    if (slide.current_version_id) {
      const { data: cur, error: curErr } = await admin()
        .from("canvas_slide_version")
        .select("version_no")
        .eq("id", slide.current_version_id)
        .maybeSingle();
      if (curErr) throw new Error(`version lookup failed: ${curErr.message}`);
      if (cur && cur.version_no !== base_version_no) {
        throw new ExpectedError(
          `slide ${slide_id} is at version ${cur.version_no}, but this edit was built from version ${base_version_no} — the slide changed since you read it (often a human editing it in the Canvas UI). Call read_slide again and rebuild your replacement from the CURRENT content, or use propose_slide_patch for targeted changes. Do NOT re-send the same content with the new version number: approving it would silently revert the newer edits.`,
        );
      }
    }

    // Carry only the touched fields. html_body is <section class="slide">-
    // wrapped (bare markup is auto-wrapped); title is stored trimmed (a
    // whitespace-only value clears the label — slide titles default to '' and
    // the slide list keys on position, not the title). A field left out of the
    // payload keeps the slide's current value on apply; an explicit "" clears
    // it. The whole bundle becomes one kind='slide_edit' canvas_deck_edit row.
    const new_slide_payload: {
      html_body?: string;
      slide_styles?: string;
      title?: string;
    } = {};
    if (new_html_body !== undefined) {
      new_slide_payload.html_body = ensureSlideSectionWrap(new_html_body);
    }
    if (new_slide_styles !== undefined) {
      new_slide_payload.slide_styles = new_slide_styles;
    }
    if (new_title !== undefined) {
      new_slide_payload.title = new_title.trim();
    }

    const { data: edit, error } = await admin()
      .from("canvas_deck_edit")
      .insert({
        workspace_id: ctx.workspace_id,
        deck_id: slide.deck_id,
        slide_id: slide.id,
        kind: "slide_edit",
        proposed_by: ctx.user_id,
        proposed_by_kind: "claude",
        new_content: null,
        new_slide_payload,
        rationale: rationale ?? null,
        status: "pending",
        base_version_id: slide.current_version_id,
        assistant_message_id: await activeAssistantMessageId(slide.deck_id as string, ctx),
      })
      .select("id, kind, status, base_version_id, created_at")
      .single();
    if (error || !edit) throw new Error(`proposal insert failed: ${error?.message}`);

    // Patch nudge: a full replacement that barely changes the slide is an
    // adjustment that should have been a patch. The proposal is ALREADY
    // committed above; the nudge only teaches the NEXT call, so it must never
    // fail this one — a thrown nudge would report a persisted proposal as
    // isError, and Claude re-proposes on failure (a duplicate). Hence the guard.
    // Prose alone didn't move behavior in prod (full edits ran ~5x patches), so
    // when we can, we hand back the EXACT propose_slide_patch edits that
    // reproduce this change — a concrete, copy-runnable example, not advice.
    let hint: string | undefined;
    let suggested_patch: SlidePatchEdit[] | undefined;
    try {
      if (new_html_body !== undefined && typeof slide.html_body === "string") {
        const before = slide.html_body;
        const after = new_slide_payload.html_body ?? "";
        const ratio = lineChangeRatio(before, after);
        if (ratio <= PATCH_NUDGE_MAX_RATIO) {
          const changePct = Math.max(1, Math.round(ratio * 100));
          const patch = computeSlidePatch(before, after, "html_body");
          if (patch) {
            suggested_patch = patch;
            hint = `This rewrite changed only ~${changePct}% of the slide's lines. For an adjustment this small, prefer propose_slide_patch: it's faster, gives a cleaner diff, and can't clobber concurrent edits to the rest of the slide. suggested_patch below is the exact propose_slide_patch(slide_id, edits) call that reproduces THIS change — use that shape next time.`;
          } else {
            hint = `This rewrite changed only ~${changePct}% of the slide's lines. For adjustments this small, use propose_slide_patch with find/replace snippets instead of a full rewrite — it's faster, produces a reviewable diff, and can't clobber concurrent edits to the rest of the slide.`;
          }
        }
      }
    } catch (e) {
      // Advisory only — never let nudge computation fail a committed proposal.
      console.error(`[mcp:tool] propose_slide_edit nudge failed (edit ${edit.id}):`, e);
    }

    const superseded = await supersedeOwnStalePendings(
      slide.id as string,
      ctx.user_id,
      edit.id as string,
    );

    return {
      edit_id: edit.id,
      slide_id,
      kind: edit.kind,
      fields: provided,
      status: edit.status,
      base_version_id: edit.base_version_id,
      created_at: edit.created_at,
      ...(superseded.length > 0 ? { superseded_edit_ids: superseded } : {}),
      ...(hint ? { hint } : {}),
      ...(suggested_patch ? { suggested_patch } : {}),
    };
  },

  // N alternative designs for ONE slide, as sibling proposals sharing a
  // variant_group_id (migration 0066). The human picks one — the pick
  // supersedes the rest transactionally via canvas_apply_variant, and the
  // generic apply path fail-closes on a grouped row with pending siblings.
  // Full-replacement payloads are the LEGITIMATE shape here (each variant is
  // a distinct design), so no patch nudge. Insert is all-or-nothing like
  // propose_deck_patch: the agent can never half-build a group.
  propose_slide_variants: async (args, ctx) => {
    const slide_id = requireString(args, "slide_id");
    const base_version_no = requireBaseVersionNo(args);
    const rationale = optionalString(args, "rationale");
    const variantsRaw = (args as Record<string, unknown>).variants;
    if (!Array.isArray(variantsRaw) || variantsRaw.length < 2 || variantsRaw.length > 4) {
      throw new ExpectedError(
        'Argument "variants" must be an array of 2–4 alternatives, each with at least one of: new_html_body, new_slide_styles, new_title (plus an optional short "label").',
      );
    }

    type VariantInput = {
      payload: { html_body?: string; slide_styles?: string; title?: string };
      label: string | null;
    };
    const variants: VariantInput[] = variantsRaw.map((raw, i) => {
      if (typeof raw !== "object" || raw === null) {
        throw new ExpectedError(`variants[${i}] must be an object`);
      }
      const v = raw as Record<string, unknown>;
      const payload: VariantInput["payload"] = {};
      if (typeof v.new_html_body === "string") {
        assertPayloadSize(`variants[${i}].new_html_body`, v.new_html_body);
        payload.html_body = ensureSlideSectionWrap(v.new_html_body);
      }
      if (typeof v.new_slide_styles === "string") {
        assertPayloadSize(`variants[${i}].new_slide_styles`, v.new_slide_styles);
        payload.slide_styles = v.new_slide_styles;
      }
      if (typeof v.new_title === "string") {
        payload.title = v.new_title.trim();
      }
      if (Object.keys(payload).length === 0) {
        throw new ExpectedError(
          `variants[${i}] needs at least one of: new_html_body, new_slide_styles, new_title`,
        );
      }
      return {
        payload,
        label: typeof v.label === "string" ? v.label.trim().slice(0, 60) || null : null,
      };
    });

    const slide = await loadSlideAndAssertWorkspace(slide_id, ctx);
    await assertDeckEditableByUser(slide.deck_id as string, ctx);

    // One anti-clobber gate for the whole set (same rule as propose_slide_edit).
    if (slide.current_version_id) {
      const { data: cur, error: curErr } = await admin()
        .from("canvas_slide_version")
        .select("version_no")
        .eq("id", slide.current_version_id)
        .maybeSingle();
      if (curErr) throw new Error(`version lookup failed: ${curErr.message}`);
      if (cur && cur.version_no !== base_version_no) {
        throw new ExpectedError(
          `slide ${slide_id} is at version ${cur.version_no}, but these variants were built from version ${base_version_no} — call read_slide again and rebuild from the CURRENT content.`,
        );
      }
    }

    const variant_group_id = randomUUID();
    const assistant_message_id = await activeAssistantMessageId(
      slide.deck_id as string,
      ctx,
    );
    const rows = variants.map((v) => ({
      workspace_id: ctx.workspace_id,
      deck_id: slide.deck_id,
      slide_id: slide.id,
      kind: "slide_edit",
      proposed_by: ctx.user_id,
      proposed_by_kind: "claude",
      new_content: null,
      new_slide_payload: v.payload,
      rationale: v.label
        ? `${v.label}${rationale ? ` — ${rationale}` : ""}`
        : rationale ?? null,
      status: "pending",
      base_version_id: slide.current_version_id,
      variant_group_id,
      assistant_message_id,
    }));

    const { data: edits, error } = await admin()
      .from("canvas_deck_edit")
      .insert(rows)
      .select("id, status, created_at");
    if (error || !edits || edits.length !== rows.length) {
      throw new Error(`variant insert failed: ${error?.message ?? "row count mismatch"}`);
    }

    return {
      variant_group_id,
      slide_id,
      variants: edits.map((edit, i) => ({
        edit_id: edit.id,
        label: variants[i].label,
        thumbnail_url: `/api/decks/${slide.deck_id}/slides/${slide.id}/thumbnail?proposalId=${edit.id}`,
      })),
      status: "pending",
      note:
        "These are ALTERNATIVES. In the in-app Ask-agent chatbox the human gets one side-by-side pick-one card; from a terminal MCP client they show up as individual pending proposals in Review, where approving one is refused until the others are withdrawn or rejected. Either way exactly one lands and the rest are set aside. Optionally render_proposal each to describe them; do not approve any yourself.",
    };
  },

  // Targeted adjustments without resending the whole slide: the caller passes
  // find/replace snippets, we resolve them against the slide's CURRENT stored
  // content and insert the same kind='slide_edit' proposal propose_slide_edit
  // would — reviewers and the apply path see a normal whole-content proposal.
  propose_slide_patch: async (args, ctx) => {
    const slide_id = requireString(args, "slide_id");
    const rationale = optionalString(args, "rationale");
    const edits = requirePatchEdits(args);

    const slide = await loadSlideAndAssertWorkspace(slide_id, ctx);
    await assertDeckEditableByUser(slide.deck_id as string, ctx);

    const result = applySlidePatch(
      {
        html_body: (slide.html_body as string) ?? "",
        slide_styles: (slide.slide_styles as string | null) ?? "",
      },
      edits,
    );
    if (!result.ok) throw new ExpectedError(result.error);

    // Carry only the fields the patch actually changed, mirroring
    // propose_slide_edit's omitted-field-keeps-current semantics. The wrapper
    // guard + size checks are shared with propose_deck_patch.
    const new_slide_payload = buildPatchedSlidePayload(
      (slide.html_body as string) ?? "",
      result,
    );

    const { data: edit, error } = await admin()
      .from("canvas_deck_edit")
      .insert({
        workspace_id: ctx.workspace_id,
        deck_id: slide.deck_id,
        slide_id: slide.id,
        kind: "slide_edit",
        proposed_by: ctx.user_id,
        proposed_by_kind: "claude",
        new_content: null,
        new_slide_payload,
        rationale: rationale ?? null,
        status: "pending",
        auto_apply_eligible: true,
        base_version_id: slide.current_version_id,
        assistant_message_id: await activeAssistantMessageId(slide.deck_id as string, ctx),
      })
      .select("id, kind, status, base_version_id, created_at")
      .single();
    if (error || !edit) throw new Error(`proposal insert failed: ${error?.message}`);

    const superseded = await supersedeOwnStalePendings(
      slide.id as string,
      ctx.user_id,
      edit.id as string,
    );

    return {
      edit_id: edit.id,
      slide_id,
      kind: edit.kind,
      fields: Object.keys(new_slide_payload),
      edits_applied: edits.length,
      status: edit.status,
      base_version_id: edit.base_version_id,
      created_at: edit.created_at,
      ...(superseded.length > 0 ? { superseded_edit_ids: superseded } : {}),
    };
  },

  // Multi-slide find/replace in ONE reviewable batch. Each edit carries its own
  // slide_id; edits on the same slide are grouped and applied together (one
  // proposal per slide). We emit one INDEPENDENT pending slide_edit row per
  // affected slide — exactly what propose_slide_patch produces — so the
  // existing inbox batch-approve ("Approve N from Claude") treats the set as a
  // unit, with no schema change. One slide gets at most one proposal here, so
  // the batch-approve "exactly one pending per slide" rule is satisfied by
  // construction.
  //
  // FAILURE SEMANTICS — ATOMIC across the whole batch (mirrors
  // propose_slide_patch's "no row written on failure" for one slide, extended
  // to the set): we resolve EVERY slide's patch against its current stored
  // content FIRST, and only if all resolve do we insert. If any slide's snippet
  // doesn't match (or matches ambiguously, or eats the wrapper), the call
  // throws naming that slide and NO rows are written — you fix the one bad
  // snippet and resend, never landing a half-applied batch where some slides
  // got proposals and others silently didn't.
  propose_deck_patch: async (args, ctx) => {
    const deck_id = requireString(args, "deck_id");
    const rationale = optionalString(args, "rationale");
    const groups = requireDeckPatchEdits(args);

    // One edit gate for the whole deck — every targeted slide rides this deck,
    // and the per-slide loads below re-confirm each slide belongs to it.
    await assertDeckEditableByUser(deck_id, ctx);

    // PASS 1 — resolve every slide's patch against current content. Build the
    // full set of rows to insert, but write nothing until all succeed.
    type PreparedRow = {
      slide_id: string;
      base_version_id: string | null;
      new_slide_payload: { html_body?: string; slide_styles?: string };
      fields: string[];
      edits_applied: number;
    };
    const prepared: PreparedRow[] = [];
    for (const group of groups) {
      const slide = await loadSlideAndAssertWorkspace(group.slide_id, ctx);
      if (slide.deck_id !== deck_id) {
        throw new ExpectedError(
          `slide ${group.slide_id} does not belong to deck ${deck_id}`,
        );
      }
      const result = applySlidePatch(
        {
          html_body: (slide.html_body as string) ?? "",
          slide_styles: (slide.slide_styles as string | null) ?? "",
        },
        group.edits,
      );
      if (!result.ok) {
        // Name the offending slide so the caller fixes the one bad snippet
        // rather than re-sending the whole batch blind.
        throw new ExpectedError(`slide ${group.slide_id}: ${result.error}`);
      }
      const new_slide_payload = buildPatchedSlidePayload(
        (slide.html_body as string) ?? "",
        result,
        `slide ${group.slide_id}: `,
      );
      prepared.push({
        slide_id: slide.id as string,
        base_version_id: (slide.current_version_id as string | null) ?? null,
        new_slide_payload,
        fields: Object.keys(new_slide_payload),
        edits_applied: group.edits.length,
      });
    }

    // PASS 2 — insert one slide_edit row per slide. assistant_message_id is the
    // same for the whole batch (one live turn per deck), so resolve it once.
    const assistantMessageId = await activeAssistantMessageId(deck_id, ctx);
    const rows = prepared.map((p) => ({
      workspace_id: ctx.workspace_id,
      deck_id,
      slide_id: p.slide_id,
      kind: "slide_edit",
      proposed_by: ctx.user_id,
      proposed_by_kind: "claude",
      new_content: null,
      new_slide_payload: p.new_slide_payload,
      rationale: rationale ?? null,
      status: "pending",
      auto_apply_eligible: true,
      base_version_id: p.base_version_id,
      assistant_message_id: assistantMessageId,
    }));

    const { data: inserted, error } = await admin()
      .from("canvas_deck_edit")
      .insert(rows)
      .select("id, slide_id, status, base_version_id, created_at");
    if (error || !inserted) {
      throw new Error(`proposal insert failed: ${error?.message}`);
    }

    // Map the returned rows back to their slide for the per-slide echo. (Insert
    // preserves input order, but match on slide_id to be robust.)
    const insertedBySlide = new Map(
      (inserted as Array<Record<string, unknown>>).map((r) => [r.slide_id as string, r]),
    );

    // Same supersede sweep as propose_slide_patch, per affected slide.
    for (const row of inserted as Array<Record<string, unknown>>) {
      await supersedeOwnStalePendings(
        row.slide_id as string,
        ctx.user_id,
        row.id as string,
      );
    }
    return {
      deck_id,
      kind: "slide_edit",
      slides_affected: prepared.length,
      edits: prepared.map((p) => {
        const row = insertedBySlide.get(p.slide_id);
        return {
          edit_id: (row?.id as string) ?? null,
          slide_id: p.slide_id,
          fields: p.fields,
          edits_applied: p.edits_applied,
          base_version_id: (row?.base_version_id as string | null) ?? p.base_version_id,
          status: (row?.status as string) ?? "pending",
        };
      }),
      note: "One pending proposal per slide — approve them together via the inbox's batch-approve.",
    };
  },

  propose_new_slide: async (args, ctx) => {
    const deck_id = requireString(args, "deck_id");
    const position = requireNonNegativeInteger(args, "position");
    const rawHtmlBody = requireString(args, "html_body");
    assertPayloadSize("html_body", rawHtmlBody);
    const html_body = ensureSlideSectionWrap(rawHtmlBody);
    const title = optionalString(args, "title") ?? "";
    const slide_styles = optionalString(args, "slide_styles") ?? "";
    assertPayloadSize("slide_styles", slide_styles);
    const rationale = optionalString(args, "rationale");

    await assertDeckEditableByUser(deck_id, ctx);

    // Payload shape matches the CHECK constraint on canvas_deck_edit: position
    // and html_body are required; title and slide_styles fall back to '' when
    // omitted (matches canvas_deck_slide column defaults).
    const new_slide_payload = { position, title, html_body, slide_styles };

    const { data: edit, error } = await admin()
      .from("canvas_deck_edit")
      .insert({
        workspace_id: ctx.workspace_id,
        deck_id,
        slide_id: null,
        kind: "slide_create",
        proposed_by: ctx.user_id,
        proposed_by_kind: "claude",
        new_content: null,
        new_slide_payload,
        rationale: rationale ?? null,
        status: "pending",
        assistant_message_id: await activeAssistantMessageId(deck_id, ctx),
      })
      .select("id, kind, status, created_at")
      .single();
    if (error || !edit) throw new Error(`proposal insert failed: ${error?.message}`);

    return {
      edit_id: edit.id,
      deck_id,
      kind: edit.kind,
      status: edit.status,
      position,
      created_at: edit.created_at,
    };
  },

  // Duplicate an existing slide. Cheaper and safer than re-sending the full
  // HTML through propose_new_slide when you want a near-copy to tweak: we read
  // the source's stored content and emit a slide_create proposal that inserts
  // the copy at source.position + 1. The slide_create apply path shifts later
  // slides right by one, so the duplicate lands immediately after its source.
  // html_body is already <section class="slide">-wrapped in storage, so we copy
  // it verbatim (do NOT re-wrap). Still propose-first — a human approves it.
  //
  // Optional `edits` (the propose_slide_patch find/replace shape) are applied
  // to the COPY server-side at propose time, so "add a slide like slide 4 but
  // for Q3" is ONE deterministic proposal and one review instead of a 4–13 KB
  // regeneration — or worse, duplicate-approve-then-patch-approve (two review
  // round-trips with the copy's slide_id unknown until the first approval).
  propose_duplicate_slide: async (args, ctx) => {
    const slide_id = requireString(args, "slide_id");
    const rationale = optionalString(args, "rationale");
    const new_title = optionalString(args, "new_title");
    const hasEdits = (args as Record<string, unknown>).edits !== undefined;
    const edits = hasEdits ? requirePatchEdits(args) : null;

    const slide = await loadSlideAndAssertWorkspace(slide_id, ctx);
    const deck_id = slide.deck_id as string;
    await assertDeckEditableByUser(deck_id, ctx);

    const position = (slide.position as number) + 1;
    const title = new_title ?? ((slide.title as string | null) ?? "");
    let html_body = slide.html_body as string;
    let slide_styles = (slide.slide_styles as string | null) ?? "";

    let edits_applied = 0;
    if (edits) {
      const result = applySlidePatch({ html_body, slide_styles }, edits);
      if (!result.ok) throw new ExpectedError(result.error);
      // Reuse the patch guards (wrapper preservation + size) — the payload
      // builder returns only touched fields; untouched ones keep the copy.
      const patched = buildPatchedSlidePayload(html_body, result);
      if (patched.html_body !== undefined) html_body = patched.html_body;
      if (patched.slide_styles !== undefined) slide_styles = patched.slide_styles;
      edits_applied = edits.length;
    }

    const { data: edit, error } = await admin()
      .from("canvas_deck_edit")
      .insert({
        workspace_id: ctx.workspace_id,
        deck_id,
        slide_id: null,
        kind: "slide_create",
        proposed_by: ctx.user_id,
        proposed_by_kind: "claude",
        new_content: null,
        new_slide_payload: { position, title, html_body, slide_styles },
        rationale: rationale ?? null,
        status: "pending",
        assistant_message_id: await activeAssistantMessageId(deck_id, ctx),
      })
      .select("id, kind, status, created_at")
      .single();
    if (error || !edit)
      throw new Error(`proposal insert failed: ${error?.message}`);
    return {
      edit_id: edit.id,
      deck_id,
      source_slide_id: slide_id,
      kind: edit.kind,
      status: edit.status,
      position,
      edits_applied,
      created_at: edit.created_at,
      note: "Preview the copy with render_proposal before the human reviews it.",
    };
  },

  // Cross-deck slide reuse: copy a finished slide from one deck into another
  // as a slide_create proposal on the DESTINATION deck. The HTML ships verbatim
  // — no blob copy, no URL rewrite — and its /api/canvas/asset/{id} URLs still
  // resolve because the preview/export routes HMAC-sign every asset URL in the
  // assembled HTML AFTER passing RLS on the containing deck. Caveat: asset
  // SELECT is per-deck (canvas_can_read_deck since 0015), so an image owned by a
  // PRIVATE source deck only inlines for viewers who can read that source; an
  // export by someone who can't may drop it (the URL stays un-inlined).
  // slide_styles travel; theme_css does NOT (deck-wide), so a copy across
  // unrelated themes may need a restyle — render_proposal shows the reviewer
  // before they approve. Provenance (where this came from) rides
  // new_slide_payload.source, which the apply path ignores and the applied edit
  // row preserves immutably.
  copy_slide: async (args, ctx) => {
    const source_slide_id = requireString(args, "source_slide_id");
    const dest_deck_id = requireString(args, "dest_deck_id");
    const rationale = optionalString(args, "rationale");
    const positionRaw = (args as Record<string, unknown>).position;
    const position =
      typeof positionRaw === "number" && Number.isInteger(positionRaw) && positionRaw >= 0
        ? positionRaw
        : null;

    // Read gate on the source, write gate on the destination — both
    // workspace-bounded by the helpers, so cross-workspace copy is
    // impossible by construction.
    const slide = await loadSlideAndAssertWorkspace(source_slide_id, ctx);
    await assertDeckAccessibleToUser(slide.deck_id as string, ctx);
    await assertDeckEditableByUser(dest_deck_id, ctx);

    const { data: destDeck } = await admin()
      .from("canvas_deck")
      .select("id, title")
      .eq("id", dest_deck_id)
      .eq("workspace_id", ctx.workspace_id)
      .maybeSingle();
    if (!destDeck) throw new ExpectedError("destination deck not found");

    const { data: sourceDeck } = await admin()
      .from("canvas_deck")
      .select("title")
      .eq("id", slide.deck_id as string)
      .maybeSingle();

    // Default insert position: end of the destination deck. Throw on a count
    // error rather than swallow it — a null count would mis-position the copy
    // at 0 (the front of the deck) instead of appending.
    const { count, error: countErr } = await admin()
      .from("canvas_deck_slide")
      .select("id", { count: "exact", head: true })
      .eq("deck_id", dest_deck_id);
    if (countErr) throw new Error(`destination slide count failed: ${countErr.message}`);
    const destCount = count ?? 0;
    const insertAt = position === null ? destCount : Math.min(position, destCount);

    const { data: edit, error } = await admin()
      .from("canvas_deck_edit")
      .insert({
        workspace_id: ctx.workspace_id,
        deck_id: dest_deck_id,
        slide_id: null,
        kind: "slide_create",
        proposed_by: ctx.user_id,
        proposed_by_kind: "claude",
        new_content: null,
        new_slide_payload: {
          position: insertAt,
          title: (slide.title as string | null) ?? "",
          html_body: slide.html_body as string,
          slide_styles: (slide.slide_styles as string | null) ?? "",
          // Provenance stamp — a copy is a FORK, not a live link. The exact
          // version copied is pinned so "where did this come from" survives
          // later edits on either side. Soft pointers, no FKs: deleting the
          // source deck leaves these dangling by design.
          source: {
            deck_id: slide.deck_id,
            deck_title: sourceDeck?.title ?? null,
            slide_id: source_slide_id,
            version_id: slide.current_version_id,
          },
        },
        rationale:
          rationale ??
          `Copy of "${(slide.title as string | null) || "untitled slide"}" from ${sourceDeck?.title ?? "another deck"}`,
        status: "pending",
        assistant_message_id: await activeAssistantMessageId(dest_deck_id, ctx),
      })
      .select("id, kind, status, created_at")
      .single();
    if (error || !edit) throw new Error(`proposal insert failed: ${error?.message}`);

    return {
      edit_id: edit.id,
      dest_deck_id,
      source_slide_id,
      source_deck_id: slide.deck_id,
      position: insertAt,
      status: edit.status,
      created_at: edit.created_at,
      note:
        "The copy keeps the source's slide_styles but NOT its deck theme_css — across different themes it may need a restyle. render_proposal to check before the human approves. Speaker notes do not travel with a copy, and images from a PRIVATE source deck only inline for viewers who can read that source.",
    };
  },

  propose_reorder_slides: async (args, ctx) => {
    const deck_id = requireString(args, "deck_id");
    const rationale = optionalString(args, "rationale");
    const orderRaw =
      args && typeof args === "object"
        ? (args as Record<string, unknown>).order
        : undefined;
    if (
      !Array.isArray(orderRaw) ||
      orderRaw.length === 0 ||
      !orderRaw.every((v) => typeof v === "string")
    ) {
      throw new ExpectedError(
        'Argument "order" must be a non-empty array of slide ids in the desired order',
      );
    }
    const order = orderRaw as string[];

    await assertDeckEditableByUser(deck_id, ctx);

    // Validate an exact permutation of the deck's current slides up front for
    // fast feedback. The apply RPC re-validates at approve time too (the slide
    // set can change between propose and approve).
    const { data: slideRows, error: slideErr } = await admin()
      .from("canvas_deck_slide")
      .select("id")
      .eq("deck_id", deck_id);
    if (slideErr) throw new Error(slideErr.message);
    const currentIds = new Set((slideRows ?? []).map((s) => s.id as string));
    if (order.length !== currentIds.size) {
      throw new ExpectedError(
        `order must list all ${currentIds.size} slide(s) exactly once (got ${order.length})`,
      );
    }
    if (new Set(order).size !== order.length) {
      throw new ExpectedError("order contains duplicate slide ids");
    }
    for (const id of order) {
      if (!currentIds.has(id)) {
        throw new ExpectedError(
          `order references slide ${id} not in deck ${deck_id}`,
        );
      }
    }

    const { data: edit, error } = await admin()
      .from("canvas_deck_edit")
      .insert({
        workspace_id: ctx.workspace_id,
        deck_id,
        slide_id: null,
        kind: "slide_reorder",
        proposed_by: ctx.user_id,
        proposed_by_kind: "claude",
        new_content: null,
        new_slide_payload: { order },
        rationale: rationale ?? null,
        status: "pending",
        assistant_message_id: await activeAssistantMessageId(deck_id, ctx),
      })
      .select("id, kind, status, created_at")
      .single();
    if (error || !edit) throw new Error(`proposal insert failed: ${error?.message}`);
    return {
      edit_id: edit.id,
      deck_id,
      kind: edit.kind,
      status: edit.status,
      slide_count: order.length,
      created_at: edit.created_at,
    };
  },

  propose_delete_slide: async (args, ctx) => {
    const slide_id = requireString(args, "slide_id");
    const rationale = optionalString(args, "rationale");
    // Resolve deck + workspace from the slide, then require edit permission.
    const slide = await loadSlideAndAssertWorkspace(slide_id, ctx);
    const deck_id = slide.deck_id as string;
    await assertDeckEditableByUser(deck_id, ctx);

    const { data: edit, error } = await admin()
      .from("canvas_deck_edit")
      .insert({
        workspace_id: ctx.workspace_id,
        deck_id,
        slide_id,
        kind: "slide_delete",
        proposed_by: ctx.user_id,
        proposed_by_kind: "claude",
        new_content: null,
        new_slide_payload: null,
        rationale: rationale ?? null,
        status: "pending",
        assistant_message_id: await activeAssistantMessageId(deck_id, ctx),
      })
      .select("id, kind, slide_id, status, created_at")
      .single();
    if (error || !edit) throw new Error(`proposal insert failed: ${error?.message}`);
    return {
      edit_id: edit.id,
      deck_id,
      slide_id,
      kind: edit.kind,
      status: edit.status,
      created_at: edit.created_at,
    };
  },

  propose_theme_edit: async (args, ctx) => {
    const deck_id = requireString(args, "deck_id");
    await assertDeckEditableByUser(deck_id, ctx);
    const new_theme_css = optionalString(args, "new_theme_css");
    const new_nav_js = optionalString(args, "new_nav_js");
    const rationale = optionalString(args, "rationale");

    if (new_theme_css === undefined && new_nav_js === undefined) {
      throw new ExpectedError(
        "propose_theme_edit requires one of: new_theme_css, new_nav_js",
      );
    }
    if (new_theme_css !== undefined && new_nav_js !== undefined) {
      throw new ExpectedError(
        "propose_theme_edit accepts only one of new_theme_css or new_nav_js per call",
      );
    }
    if (new_theme_css !== undefined) assertPayloadSize("new_theme_css", new_theme_css);
    if (new_nav_js !== undefined) assertPayloadSize("new_nav_js", new_nav_js);

    const { data: deck, error: deckErr } = await admin()
      .from("canvas_deck")
      .select("theme_css, nav_js")
      .eq("id", deck_id)
      .eq("workspace_id", ctx.workspace_id)
      .maybeSingle();
    if (deckErr) throw new Error(deckErr.message);
    if (!deck) throw new ExpectedError("deck not found");

    const kind = new_theme_css !== undefined ? "theme_css" : "nav_js";
    const new_content =
      new_theme_css !== undefined ? new_theme_css : (new_nav_js as string);

    const insertRow: Record<string, unknown> = {
      workspace_id: ctx.workspace_id,
      deck_id,
      slide_id: null,
      kind,
      proposed_by: ctx.user_id,
      proposed_by_kind: "claude",
      new_content,
      rationale: rationale ?? null,
      status: "pending",
    };
    if (kind === "theme_css") {
      insertRow.base_theme_css_hash = contentHashMd5(deck.theme_css ?? "");
    } else {
      insertRow.base_nav_js_hash = contentHashMd5(deck.nav_js ?? "");
    }
    insertRow.assistant_message_id = await activeAssistantMessageId(deck_id, ctx);

    const { data: edit, error } = await admin()
      .from("canvas_deck_edit")
      .insert(insertRow)
      .select("id, kind, status, created_at")
      .single();
    if (error || !edit) throw new Error(`proposal insert failed: ${error?.message}`);

    return {
      edit_id: edit.id,
      deck_id,
      kind: edit.kind,
      status: edit.status,
      created_at: edit.created_at,
    };
  },

  propose_deck_edit: async (args, ctx) => {
    const deck_id = requireString(args, "deck_id");
    await assertDeckEditableByUser(deck_id, ctx);
    const new_title = optionalString(args, "new_title");
    const rationale = optionalString(args, "rationale");

    // Today only one field is supported, but the check is structured as a
    // sequence of `undefined` guards so adding new deck-level fields later
    // (status, meta, etc.) is mechanical — drop in a new optionalString and
    // append a `|| new_x === undefined` branch.
    if (new_title === undefined) {
      throw new ExpectedError("propose_deck_edit requires one of: new_title");
    }

    // Fail fast at propose-time: the DB CHECK on apply also rejects an empty
    // title, but surfacing the error here gives a clearer message to the
    // caller before a row is even written.
    const trimmedTitle = new_title.trim();
    if (trimmedTitle.length === 0) {
      throw new ExpectedError("propose_deck_edit: new_title cannot be empty");
    }

    const { data: deck, error: deckErr } = await admin()
      .from("canvas_deck")
      .select("id, title")
      .eq("id", deck_id)
      .eq("workspace_id", ctx.workspace_id)
      .maybeSingle();
    if (deckErr) throw new Error(deckErr.message);
    if (!deck) throw new ExpectedError("deck not found");

    const { data: edit, error } = await admin()
      .from("canvas_deck_edit")
      .insert({
        workspace_id: ctx.workspace_id,
        deck_id,
        slide_id: null,
        kind: "deck_title",
        proposed_by: ctx.user_id,
        proposed_by_kind: "claude",
        new_content: trimmedTitle,
        base_deck_title: deck.title,
        rationale: rationale ?? null,
        status: "pending",
        assistant_message_id: await activeAssistantMessageId(deck_id, ctx),
      })
      .select("id, kind, status, created_at")
      .single();
    if (error || !edit) throw new Error(`proposal insert failed: ${error?.message}`);

    return {
      edit_id: edit.id,
      deck_id,
      kind: edit.kind,
      status: edit.status,
      created_at: edit.created_at,
    };
  },

  // -- Proposals (read + mutate own) --------------------------------------

  list_proposals: async (args, ctx) => {
    const deck_id = optionalString(args, "deck_id");
    const slide_id = optionalString(args, "slide_id");
    const status = optionalString(args, "status");
    const mine = optionalBoolean(args, "mine");
    const limit = Math.min(optionalNumber(args, "limit", 50), 200);

    let query = admin()
      .from("canvas_deck_edit")
      .select(
        "id, deck_id, slide_id, kind, proposed_by, proposed_by_kind, rationale, status, base_version_id, variant_group_id, created_at, resolved_at, resolved_by",
      )
      .eq("workspace_id", ctx.workspace_id)
      .order("created_at", { ascending: false })
      .limit(limit);
    if (deck_id) query = query.eq("deck_id", deck_id);
    if (slide_id) query = query.eq("slide_id", slide_id);
    if (status) query = query.eq("status", status);
    if (mine) query = query.eq("proposed_by", ctx.user_id);

    const { data, error } = await query;
    if (error) throw new Error(error.message);
    const rows = data ?? [];

    // Per-deck gate: this query is workspace-scoped, so it would otherwise
    // surface proposals on private decks the caller isn't invited to. Resolve
    // each distinct deck once and drop rows on inaccessible decks.
    const accessibleByDeck = new Map<string, boolean>();
    const filtered: typeof rows = [];
    for (const row of rows) {
      const deckId = row.deck_id as string;
      let accessible = accessibleByDeck.get(deckId);
      if (accessible === undefined) {
        try {
          await assertDeckAccessibleToUser(deckId, ctx);
          accessible = true;
        } catch {
          accessible = false;
        }
        accessibleByDeck.set(deckId, accessible);
      }
      if (accessible) filtered.push(row);
    }
    return { proposals: filtered };
  },

  get_proposal: async (args, ctx) => {
    const edit_id = requireString(args, "edit_id");

    // Explicit column list (was select("*")) — these are exactly the proposal
    // fields the tool returns to the client; keeping it explicit avoids leaking
    // any future internal columns added to canvas_deck_edit.
    const { data: edit, error } = await admin()
      .from("canvas_deck_edit")
      .select(
        "id, deck_id, slide_id, kind, proposed_by, proposed_by_kind, new_content, new_slide_payload, rationale, status, base_version_id, variant_group_id, base_theme_css_hash, base_nav_js_hash, base_deck_title, created_at, resolved_at, resolved_by",
      )
      .eq("id", edit_id)
      .eq("workspace_id", ctx.workspace_id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!edit) throw new ExpectedError("proposal not found");
    // Per-deck gate: a workspace member who isn't invited to a private deck
    // must not be able to read that deck's proposals.
    await assertDeckAccessibleToUser(edit.deck_id as string, ctx);

    const { data: comments } = await admin()
      .from("canvas_edit_comment")
      .select("id, author_kind, author_id, body, created_at")
      .eq("edit_id", edit_id)
      .order("created_at", { ascending: true });

    return { edit, comments: comments ?? [] };
  },

  comment_on_proposal: async (args, ctx) => {
    const edit_id = requireString(args, "edit_id");
    const body = requireString(args, "body");

    const { data: edit, error: eErr } = await admin()
      .from("canvas_deck_edit")
      .select("id, workspace_id, deck_id")
      .eq("id", edit_id)
      .maybeSingle();
    if (eErr) throw new Error(eErr.message);
    if (!edit || edit.workspace_id !== ctx.workspace_id) {
      throw new ExpectedError("proposal not found in this workspace");
    }
    // Per-deck gate: don't let an uninvited member comment on a private deck's
    // proposal thread.
    await assertDeckAccessibleToUser(edit.deck_id as string, ctx);

    const { data: comment, error } = await admin()
      .from("canvas_edit_comment")
      .insert({
        workspace_id: ctx.workspace_id,
        edit_id,
        author_kind: "claude",
        author_id: ctx.user_id,
        body: body.trim(),
      })
      .select("id, created_at")
      .single();
    if (error || !comment) throw new Error(`comment insert failed: ${error?.message}`);

    return { comment_id: comment.id, edit_id, created_at: comment.created_at };
  },

  withdraw_proposal: async (args, ctx) => {
    const edit_id = requireString(args, "edit_id");

    const { data: edit, error: eErr } = await admin()
      .from("canvas_deck_edit")
      .select("id, workspace_id, deck_id, proposed_by, status")
      .eq("id", edit_id)
      .maybeSingle();
    if (eErr) throw new Error(eErr.message);
    if (!edit || edit.workspace_id !== ctx.workspace_id) {
      throw new ExpectedError("proposal not found in this workspace");
    }
    // Per-deck gate: an uninvited member must not be able to enumerate/touch a
    // private deck's proposals (even to learn the proposal exists).
    await assertDeckAccessibleToUser(edit.deck_id as string, ctx);
    if (edit.proposed_by !== ctx.user_id) {
      throw new ExpectedError("only the proposer can withdraw a proposal");
    }
    // Idempotent by design. withdraw's goal state is "this proposal is no longer
    // pending", so reaching for it once that already holds is not an error — it's
    // a state Claude couldn't see. This was the single most common MCP failure in
    // prod (2026-06: 22 of 25 withdraw errors targeted an ALREADY-APPLIED
    // proposal — the reviewer self-approved within minutes, then Claude tried to
    // retract). We surface the current status instead of throwing, and route the
    // applied case to the tool that CAN undo it.
    //
    // In the return, `status` is the PROPOSAL's lifecycle state, not this call's
    // outcome; `withdrawn` is the per-call signal ("did THIS call withdraw it"),
    // so an already-rejected proposal correctly returns withdrawn:false.
    //
    // We also record the outcome as a `proposal.withdraw` usage event. The old
    // code threw here, which logged as status:'error' — that's how the "22 of 25"
    // stat above was measurable. The structured return logs as a plain 'ok' via
    // the dispatcher, erasing that signal, so we emit the discriminant explicitly
    // (status 'denied' for the no-op branches) to keep it queryable.
    const recordWithdraw = (status: UsageStatus, outcome: string) =>
      logUsage({
        event: "proposal.withdraw",
        surface: "mcp",
        status,
        user_id: ctx.user_id,
        workspace_id: ctx.workspace_id,
        deck_id: edit.deck_id as string,
        props: { outcome, edit_id },
      });

    if (edit.status === "applied") {
      recordWithdraw("denied", "applied_needs_revert");
      return {
        edit_id,
        status: "applied",
        withdrawn: false,
        action_required: "revert_proposal",
        note: `This proposal was already applied (a reviewer approved it), so there is nothing pending to withdraw. To undo it, call revert_proposal with this edit_id — it proposes restoring the slide's pre-change content for human review.`,
      } satisfies WithdrawProposalResult;
    }
    if (edit.status !== "pending") {
      // Only 'rejected' (a prior reject or withdraw — withdraw maps to 'rejected')
      // reaches here today. The goal state already holds → an idempotent no-op.
      recordWithdraw("denied", "already_resolved");
      return {
        edit_id,
        status: edit.status,
        withdrawn: false,
        already_resolved: true,
        note: `This proposal is already ${edit.status} — nothing to withdraw.`,
      } satisfies WithdrawProposalResult;
    }

    const { error } = await admin()
      .from("canvas_deck_edit")
      .update({
        status: "rejected",
        resolved_at: new Date().toISOString(),
        resolved_by: ctx.user_id,
      })
      .eq("id", edit_id);
    if (error) throw new Error(error.message);

    recordWithdraw("ok", "withdrawn");
    return { edit_id, status: "rejected", withdrawn: true } satisfies WithdrawProposalResult;
  },

  // Undo for an APPLIED slide proposal: proposes restoring the slide to the
  // content it had immediately before that proposal landed. It's a normal
  // pending slide_edit proposal (full review flow) — nothing is reverted until
  // a human approves. Only slide-content proposals are revertable this way:
  // they create a version row whose parent is the pre-change state.
  revert_proposal: async (args, ctx) => {
    const edit_id = requireString(args, "edit_id");
    const rationale = optionalString(args, "rationale");

    const { data: edit, error: eErr } = await admin()
      .from("canvas_deck_edit")
      .select("id, workspace_id, deck_id, slide_id, kind, status, rationale")
      .eq("id", edit_id)
      .maybeSingle();
    if (eErr) throw new Error(eErr.message);
    if (!edit || edit.workspace_id !== ctx.workspace_id) {
      throw new ExpectedError("proposal not found in this workspace");
    }
    // Editable implies accessible (it checks both).
    await assertDeckEditableByUser(edit.deck_id as string, ctx);

    if (edit.status !== "applied") {
      throw new ExpectedError(
        edit.status === "pending"
          ? `proposal ${edit_id} is still pending — use withdraw_proposal to cancel it, or comment_on_proposal to flag it for the reviewer.`
          : `proposal ${edit_id} was never applied (status=${edit.status}) — there is nothing to revert.`,
      );
    }

    // The version this proposal created carries source_edit_id; its parent is
    // the slide state immediately before the change.
    const { data: created, error: vErr } = await admin()
      .from("canvas_slide_version")
      .select("id, slide_id, version_no, parent_version_id")
      .eq("source_edit_id", edit_id)
      .order("version_no", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (vErr) throw new Error(vErr.message);
    if (!created) {
      throw new ExpectedError(
        `proposal ${edit_id} (kind=${edit.kind}) did not produce a slide version, so it can't be reverted automatically — structural changes (delete/reorder/create) need a new explicit proposal instead.`,
      );
    }
    if (!created.parent_version_id) {
      throw new ExpectedError(
        `proposal ${edit_id} created the slide's FIRST version — there is no earlier content to restore.`,
      );
    }

    const { data: parent, error: pErr } = await admin()
      .from("canvas_slide_version")
      .select("id, version_no, title, html_body, slide_styles")
      .eq("id", created.parent_version_id)
      .maybeSingle();
    if (pErr) throw new Error(pErr.message);
    if (!parent) {
      throw new ExpectedError(
        "the pre-change version is no longer in the history — revert manually via read_slide_version + propose_slide_edit.",
      );
    }

    const slide = await loadSlideAndAssertWorkspace(created.slide_id as string, ctx);

    // Anti-clobber: if the slide moved on AFTER the proposal being reverted,
    // restoring that proposal's parent would also wipe the newer edits. Same
    // failure class as a stale full rewrite — refuse and route to history.
    if (slide.current_version_id !== created.id) {
      throw new ExpectedError(
        `the slide has changed since proposal ${edit_id} was applied (it created version ${created.version_no}, but the slide is past it now). Reverting would also erase the newer edits. Inspect list_slide_versions and propose_slide_edit the exact state you want, or ask a human to restore a version from the History page.`,
      );
    }

    const originalWhy = (edit.rationale as string | null)?.slice(0, 140);
    const { data: revert, error: rErr } = await admin()
      .from("canvas_deck_edit")
      .insert({
        workspace_id: ctx.workspace_id,
        deck_id: edit.deck_id,
        slide_id: slide.id,
        kind: "slide_edit",
        proposed_by: ctx.user_id,
        proposed_by_kind: "claude",
        new_content: null,
        new_slide_payload: {
          title: parent.title ?? "",
          html_body: parent.html_body,
          slide_styles: parent.slide_styles ?? "",
        },
        rationale:
          rationale ??
          `Revert of applied proposal ${edit_id}: restores the slide to version ${parent.version_no}` +
            (originalWhy ? ` (before: "${originalWhy}")` : ""),
        status: "pending",
        base_version_id: slide.current_version_id,
        // Explicit link to the applied edit being undone (0040) — lets the
        // apply RPC's self-approval guard pass for the resolver's own undo,
        // and keeps the rationale string as human context only.
        reverts_edit_id: edit_id,
      })
      .select("id, status, created_at")
      .single();
    if (rErr || !revert) throw new Error(`revert proposal insert failed: ${rErr?.message}`);

    return {
      edit_id: revert.id,
      reverts_edit_id: edit_id,
      slide_id: slide.id,
      restores_version_no: parent.version_no,
      status: revert.status,
      created_at: revert.created_at,
      note: "Pending review like any proposal — the slide is unchanged until a human approves the revert.",
    };
  },

  // -- Locks --------------------------------------------------------------

  lock_slide: async (args, ctx) => {
    const slide_id = requireString(args, "slide_id");
    const slide = await loadSlideAndAssertWorkspace(slide_id, ctx);
    // Claiming a slide for editing is a write-intent action — viewers of the
    // deck must not be able to take an editing lock.
    await assertDeckEditableByUser(slide.deck_id as string, ctx);
    await admin()
      .from("canvas_deck_slide_lock")
      .delete()
      .eq("slide_id", slide_id)
      .lt("expires_at", new Date().toISOString());

    const expires_at = new Date(Date.now() + LOCK_DURATION_MINUTES * 60_000).toISOString();
    const { error } = await admin().from("canvas_deck_slide_lock").insert({
      slide_id,
      workspace_id: slide.workspace_id,
      locked_by: ctx.user_id,
      locked_by_kind: "agent",
      expires_at,
    });
    if (error) {
      if (error.code === "23505") {
        // Someone else holds the lock.
        const { data: existing } = await admin()
          .from("canvas_deck_slide_lock")
          .select("locked_by, expires_at")
          .eq("slide_id", slide_id)
          .maybeSingle();
        throw new ExpectedError(
          `slide is already locked by ${existing?.locked_by ?? "another user"} until ${existing?.expires_at ?? "?"}`,
        );
      }
      throw new Error(error.message);
    }
    return { slide_id, locked_by: ctx.user_id, expires_at };
  },

  release_slide: async (args, ctx) => {
    const slide_id = requireString(args, "slide_id");
    await loadSlideAndAssertWorkspace(slide_id, ctx);
    const { error } = await admin()
      .from("canvas_deck_slide_lock")
      .delete()
      .eq("slide_id", slide_id)
      .eq("locked_by", ctx.user_id);
    if (error) throw new Error(error.message);
    return { slide_id, released: true };
  },

  // -- Comments (canvas_comment) -----------------------------------------
  // Threaded comments pinned to a slide or posted at the deck level. Each
  // thread has a root (parent_id = null) and zero-or-more replies. The UI
  // supports a single nesting level; we enforce that here so a reply's
  // parent must itself be a root. Comments authored via MCP carry
  // author_kind = 'claude' but keep the human's user_id as author_id for
  // audit. Anchors (anchor_x, anchor_y) only make sense on slide-level
  // roots — both coordinates must be set together and within [0, 1].

  list_comments: async (args, ctx) => {
    const deck_id = requireString(args, "deck_id");
    const slide_id = optionalString(args, "slide_id");
    const include_resolved = optionalBoolean(args, "include_resolved");
    const limit = Math.min(optionalNumber(args, "limit", 100), 500);

    await assertDeckAccessibleToUser(deck_id, ctx);
    if (slide_id) {
      const slide = await loadSlideAndAssertWorkspace(slide_id, ctx);
      if (slide.deck_id !== deck_id) {
        throw new ExpectedError(`slide ${slide_id} does not belong to deck ${deck_id}`);
      }
    }

    // author_name = the stored guest attribution on author_kind='client' rows
    // (0064) — how the agent sees WHO on the client's side asked for a change.
    // Null for user/claude rows (their identity is author_id).
    const commentColumns =
      "id, deck_id, slide_id, parent_id, author_kind, author_id, author_name, body, mentions, resolved, resolved_by, resolved_at, anchor_x, anchor_y, created_at, updated_at";

    let rootsQuery = admin()
      .from("canvas_comment")
      .select(commentColumns)
      .eq("workspace_id", ctx.workspace_id)
      .eq("deck_id", deck_id)
      .is("parent_id", null)
      .order("created_at", { ascending: true })
      .limit(limit);
    if (slide_id) {
      rootsQuery = rootsQuery.eq("slide_id", slide_id);
    }
    if (!include_resolved) {
      rootsQuery = rootsQuery.eq("resolved", false);
    }

    const { data: roots, error: rootsErr } = await rootsQuery;
    if (rootsErr) throw new Error(`comment lookup failed: ${rootsErr.message}`);

    const rootIds = (roots ?? []).map((r) => r.id);
    let replies: Array<Record<string, unknown>> = [];
    if (rootIds.length > 0) {
      const { data: replyRows, error: repliesErr } = await admin()
        .from("canvas_comment")
        .select(commentColumns)
        .eq("workspace_id", ctx.workspace_id)
        .in("parent_id", rootIds)
        .order("created_at", { ascending: true });
      if (repliesErr) throw new Error(`reply lookup failed: ${repliesErr.message}`);
      replies = replyRows ?? [];
    }

    const repliesByRoot = new Map<string, Array<Record<string, unknown>>>();
    for (const reply of replies) {
      const parentId = reply.parent_id as string;
      const bucket = repliesByRoot.get(parentId) ?? [];
      bucket.push(reply);
      repliesByRoot.set(parentId, bucket);
    }

    return {
      comments: (roots ?? []).map((root) => ({
        ...root,
        replies: repliesByRoot.get(root.id) ?? [],
      })),
    };
  },

  add_comment: async (args, ctx) => {
    const deck_id = requireString(args, "deck_id");
    const slide_id = optionalString(args, "slide_id");
    const rawBody = requireString(args, "body");
    const body = rawBody.trim();
    if (!body) throw new ExpectedError('Argument "body" must be non-empty after trim');

    const hasAnchorX =
      args && typeof args === "object" && "anchor_x" in (args as Record<string, unknown>);
    const hasAnchorY =
      args && typeof args === "object" && "anchor_y" in (args as Record<string, unknown>);
    const anchorXRaw = hasAnchorX ? (args as Record<string, unknown>).anchor_x : undefined;
    const anchorYRaw = hasAnchorY ? (args as Record<string, unknown>).anchor_y : undefined;
    const anchorXSet = anchorXRaw !== undefined && anchorXRaw !== null;
    const anchorYSet = anchorYRaw !== undefined && anchorYRaw !== null;
    if (anchorXSet !== anchorYSet) {
      throw new ExpectedError("anchor_x and anchor_y must be provided together");
    }
    let anchor_x: number | null = null;
    let anchor_y: number | null = null;
    if (anchorXSet && anchorYSet) {
      if (
        typeof anchorXRaw !== "number" ||
        typeof anchorYRaw !== "number" ||
        !Number.isFinite(anchorXRaw) ||
        !Number.isFinite(anchorYRaw)
      ) {
        throw new ExpectedError("anchor_x and anchor_y must be finite numbers");
      }
      if (anchorXRaw < 0 || anchorXRaw > 1 || anchorYRaw < 0 || anchorYRaw > 1) {
        throw new ExpectedError("anchor_x and anchor_y must be in [0, 1]");
      }
      if (!slide_id) {
        throw new ExpectedError("anchors require slide_id (deck-level threads cannot be pinned)");
      }
      anchor_x = anchorXRaw;
      anchor_y = anchorYRaw;
    }

    await assertDeckAccessibleToUser(deck_id, ctx);
    if (slide_id) {
      const slide = await loadSlideAndAssertWorkspace(slide_id, ctx);
      if (slide.deck_id !== deck_id) {
        throw new ExpectedError(`slide ${slide_id} does not belong to deck ${deck_id}`);
      }
    }

    const { data: comment, error } = await admin()
      .from("canvas_comment")
      .insert({
        workspace_id: ctx.workspace_id,
        deck_id,
        slide_id: slide_id ?? null,
        parent_id: null,
        author_kind: "claude",
        author_id: ctx.user_id,
        body,
        mentions: [],
        anchor_x,
        anchor_y,
      })
      .select("id, deck_id, slide_id, created_at")
      .single();
    if (error || !comment) throw new Error(`comment insert failed: ${error?.message}`);

    return {
      comment_id: comment.id,
      deck_id: comment.deck_id,
      slide_id: comment.slide_id,
      created_at: comment.created_at,
    };
  },

  reply_to_comment: async (args, ctx) => {
    const parent_id = requireString(args, "parent_id");
    const body = requireString(args, "body").trim();
    if (!body) throw new ExpectedError('Argument "body" must be non-empty after trim');

    const { data: parent, error: parentErr } = await admin()
      .from("canvas_comment")
      .select("id, workspace_id, deck_id, slide_id, parent_id")
      .eq("id", parent_id)
      .maybeSingle();
    if (parentErr) throw new Error(`parent comment lookup failed: ${parentErr.message}`);
    if (!parent || parent.workspace_id !== ctx.workspace_id) {
      throw new ExpectedError("parent comment not found in this workspace");
    }
    if (parent.parent_id !== null) {
      throw new ExpectedError(
        "replies are one level deep — reply to the thread root instead of a reply",
      );
    }
    await assertDeckAccessibleToUser(parent.deck_id as string, ctx);

    const { data: reply, error } = await admin()
      .from("canvas_comment")
      .insert({
        workspace_id: ctx.workspace_id,
        deck_id: parent.deck_id,
        slide_id: parent.slide_id,
        parent_id: parent.id,
        author_kind: "claude",
        author_id: ctx.user_id,
        body,
        mentions: [],
        anchor_x: null,
        anchor_y: null,
      })
      .select("id, created_at")
      .single();
    if (error || !reply) throw new Error(`reply insert failed: ${error?.message}`);

    return { comment_id: reply.id, parent_id, created_at: reply.created_at };
  },

  resolve_comment: async (args, ctx) => {
    const comment_id = requireString(args, "comment_id");
    const resolved =
      args && typeof args === "object" && "resolved" in (args as Record<string, unknown>)
        ? (args as Record<string, unknown>).resolved !== false
        : true;

    const { data: target, error: lookupErr } = await admin()
      .from("canvas_comment")
      .select("id, workspace_id, deck_id, parent_id")
      .eq("id", comment_id)
      .maybeSingle();
    if (lookupErr) throw new Error(`comment lookup failed: ${lookupErr.message}`);
    if (!target || target.workspace_id !== ctx.workspace_id) {
      throw new ExpectedError("comment not found in this workspace");
    }
    if (target.parent_id !== null) {
      throw new ExpectedError("only thread roots can be resolved — pass the root comment id");
    }
    await assertDeckAccessibleToUser(target.deck_id as string, ctx);

    const now = new Date().toISOString();
    const { data: updated, error } = await admin()
      .from("canvas_comment")
      .update({
        resolved,
        resolved_by: resolved ? ctx.user_id : null,
        resolved_at: resolved ? now : null,
      })
      .eq("id", comment_id)
      .select("id, resolved, resolved_at")
      .single();
    if (error || !updated) throw new Error(`comment update failed: ${error?.message}`);

    return {
      comment_id: updated.id,
      resolved: updated.resolved,
      resolved_at: updated.resolved_at,
    };
  },

  // -- History ------------------------------------------------------------

  list_slide_versions: async (args, ctx) => {
    const slide_id = requireString(args, "slide_id");
    const limit = Math.min(optionalNumber(args, "limit", 25), 200);
    await loadSlideAndAssertWorkspace(slide_id, ctx);
    const { data, error } = await admin()
      .from("canvas_slide_version")
      .select("id, version_no, author_kind, created_by, source_prompt, created_at, parent_version_id")
      .eq("slide_id", slide_id)
      .order("version_no", { ascending: false })
      .limit(limit);
    if (error) throw new Error(error.message);
    return { versions: data ?? [] };
  },

  read_slide_version: async (args, ctx) => {
    const version_id = requireString(args, "version_id");
    // Explicit column list (was select("*")) — content, attribution, and the
    // identity/deck pointer the response and the access gate below use.
    const { data, error } = await admin()
      .from("canvas_slide_version")
      .select(
        "id, deck_id, slide_id, version_no, parent_version_id, title, html_body, slide_styles, author_kind, created_by, source_prompt, source_edit_id, created_at",
      )
      .eq("id", version_id)
      .eq("workspace_id", ctx.workspace_id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new ExpectedError("version not found");
    // Per-deck gate: even though the version is workspace-scoped, the slide it
    // belongs to may live on a private deck the caller isn't invited to.
    await assertDeckAccessibleToUser(data.deck_id as string, ctx);
    return { version: data };
  },

  list_snapshots: async (args, ctx) => {
    const deck_id = requireString(args, "deck_id");
    const limit = Math.min(optionalNumber(args, "limit", 25), 200);
    await assertDeckAccessibleToUser(deck_id, ctx);
    const { data, error } = await admin()
      .from("canvas_deck_snapshot")
      .select("id, label, description, kind, created_by, created_at")
      .eq("deck_id", deck_id)
      .order("created_at", { ascending: false })
      .limit(limit);
    if (error) throw new Error(error.message);
    return { snapshots: data ?? [] };
  },

  create_snapshot: async (args, ctx) => {
    const deck_id = requireString(args, "deck_id");
    const label = requireString(args, "label");
    const description = optionalString(args, "description");
    await assertDeckEditableByUser(deck_id, ctx);

    // Inline implementation (we can't use the RPC because it relies on auth.uid()
    // for created_by; from MCP we know the user id from the token).
    const { data: deck, error: deckErr } = await admin()
      .from("canvas_deck")
      .select("theme_css, nav_js, meta")
      .eq("id", deck_id)
      .maybeSingle();
    if (deckErr || !deck) throw new ExpectedError("deck not found");

    const { data: snap, error: snapErr } = await admin()
      .from("canvas_deck_snapshot")
      .insert({
        workspace_id: ctx.workspace_id,
        deck_id,
        label,
        description: description ?? null,
        theme_css: deck.theme_css,
        nav_js: deck.nav_js,
        meta: deck.meta ?? {},
        kind: "manual",
        created_by: ctx.user_id,
      })
      .select("id, created_at")
      .single();
    if (snapErr || !snap) throw new Error(`snapshot insert failed: ${snapErr?.message}`);

    const { data: slides } = await admin()
      .from("canvas_deck_slide")
      .select("id, position, current_version_id, title, html_body, slide_styles")
      .eq("deck_id", deck_id)
      .not("current_version_id", "is", null)
      .order("position", { ascending: true });

    if (slides && slides.length > 0) {
      // Self-contained capture: pointer + a denormalized copy of the content and
      // slide id, so a later hard-delete of the slide can't hollow the snapshot
      // out (mirrors the canvas_create_snapshot RPC; see migration 0061).
      const rows = slides
        .filter((s) => s.current_version_id)
        .map((s) => ({
          snapshot_id: snap.id,
          slide_version_id: s.current_version_id!,
          slide_id: s.id,
          position: s.position,
          title: s.title ?? "",
          html_body: s.html_body ?? "",
          slide_styles: s.slide_styles ?? "",
        }));
      const { error: ssErr } = await admin()
        .from("canvas_deck_snapshot_slide")
        .insert(rows);
      if (ssErr) throw new Error(`snapshot slides insert failed: ${ssErr.message}`);
    }

    return { snapshot_id: snap.id, label, created_at: snap.created_at };
  },

  // History tools promised in CONTEXT.md (phase-3 history surface) but never
  // built until now. Read-only; admin client + workspace filter + per-deck gate
  // like the other read tools.

  read_snapshot: async (args, ctx) => {
    const snapshot_id = requireString(args, "snapshot_id");
    const { data: snap, error } = await admin()
      .from("canvas_deck_snapshot")
      .select("id, deck_id, label, description, kind, theme_css, nav_js, created_by, created_at")
      .eq("id", snapshot_id)
      .eq("workspace_id", ctx.workspace_id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!snap) throw new ExpectedError("snapshot not found");
    await assertDeckAccessibleToUser(snap.deck_id as string, ctx);

    // The frozen per-position slide content. Two queries + a JS join rather than
    // a PostgREST embed so the access gate stays explicit and it's easy to test.
    const { data: pins, error: pErr } = await admin()
      .from("canvas_deck_snapshot_slide")
      .select("position, slide_version_id, slide_id, title, html_body, slide_styles")
      .eq("snapshot_id", snapshot_id)
      .order("position", { ascending: true });
    if (pErr) throw new Error(pErr.message);

    const versionIds = (pins ?? [])
      .map((p) => p.slide_version_id as string | null)
      .filter((id): id is string => id != null);
    const versionById = new Map<string, Record<string, unknown>>();
    if (versionIds.length > 0) {
      const { data: versions, error: vErr } = await admin()
        .from("canvas_slide_version")
        .select("id, title, html_body, slide_styles, version_no")
        .in("id", versionIds);
      if (vErr) throw new Error(vErr.message);
      for (const v of versions ?? []) versionById.set(v.id as string, v);
    }

    const slides = (pins ?? []).map((p) => {
      // Prefer the immutable version row while it survives (covers legacy rows
      // whose denormalized columns are still ''); fall back to the snapshot's
      // own denormalized copy, which persists even after the slide is deleted
      // (migration 0061).
      const v = p.slide_version_id
        ? versionById.get(p.slide_version_id as string)
        : undefined;
      return {
        position: p.position,
        slide_version_id: p.slide_version_id ?? null,
        slide_id: p.slide_id ?? null,
        version_no: v?.version_no ?? null,
        title: (v?.title as string | undefined) ?? p.title ?? null,
        html_body: (v?.html_body as string | undefined) ?? p.html_body ?? null,
        slide_styles: (v?.slide_styles as string | undefined) ?? p.slide_styles ?? null,
      };
    });

    return {
      snapshot: {
        id: snap.id,
        label: snap.label,
        description: snap.description,
        kind: snap.kind,
        theme_css: snap.theme_css,
        nav_js: snap.nav_js,
        created_at: snap.created_at,
      },
      slides,
    };
  },

  diff_slide_versions: async (args, ctx) => {
    const a_id = requireString(args, "a_id");
    const b_id = requireString(args, "b_id");
    const [a, b] = await Promise.all([
      loadSlideVersionForDiff(a_id, ctx),
      loadSlideVersionForDiff(b_id, ctx),
    ]);
    const labelA = `v${a.version_no}`;
    const labelB = `v${b.version_no}`;
    const htmlChanged = a.html_body !== b.html_body;
    const stylesChanged = (a.slide_styles ?? "") !== (b.slide_styles ?? "");
    return {
      a: { version_id: a_id, version_no: a.version_no, title: a.title },
      b: { version_id: b_id, version_no: b.version_no, title: b.title },
      line_change_ratio: lineChangeRatio(a.html_body ?? "", b.html_body ?? ""),
      title_changed: a.title !== b.title,
      html_diff: htmlChanged
        ? createPatch("html_body", a.html_body ?? "", b.html_body ?? "", labelA, labelB)
        : null,
      styles_diff: stylesChanged
        ? createPatch("slide_styles", a.slide_styles ?? "", b.slide_styles ?? "", labelA, labelB)
        : null,
    };
  },

  diff_snapshots: async (args, ctx) => {
    const a_id = requireString(args, "a_id");
    const b_id = requireString(args, "b_id");
    const [a, b] = await Promise.all([
      loadSnapshotForDiff(a_id, ctx),
      loadSnapshotForDiff(b_id, ctx),
    ]);
    const { changed, added, removed } = compareSnapshotPositions(a.byPosition, b.byPosition);
    return {
      a: { snapshot_id: a_id, label: a.label, created_at: a.created_at },
      b: { snapshot_id: b_id, label: b.label, created_at: b.created_at },
      theme_changed: a.theme_css !== b.theme_css,
      nav_changed: a.nav_js !== b.nav_js,
      slides_changed_at_positions: changed,
      slides_added_at_positions: added,
      slides_removed_at_positions: removed,
    };
  },
};

// Compare two snapshots' (position -> slide_version_id) maps. A position present
// in both with a different version id is "changed"; only in `a` is "removed";
// only in `b` is "added". Pure + exported so it's unit-testable.
export function compareSnapshotPositions(
  a: Map<number, string>,
  b: Map<number, string>,
): { changed: number[]; added: number[]; removed: number[] } {
  const positions = Array.from(new Set([...a.keys(), ...b.keys()])).sort((x, y) => x - y);
  const changed: number[] = [];
  const added: number[] = [];
  const removed: number[] = [];
  for (const pos of positions) {
    const av = a.get(pos);
    const bv = b.get(pos);
    if (av && !bv) removed.push(pos);
    else if (!av && bv) added.push(pos);
    else if (av !== bv) changed.push(pos);
  }
  return { changed, added, removed };
}

// Load one slide version's content for a diff, gated by its deck's access.
async function loadSlideVersionForDiff(versionId: string, ctx: AuthContext) {
  const { data, error } = await admin()
    .from("canvas_slide_version")
    .select("id, deck_id, version_no, title, html_body, slide_styles")
    .eq("id", versionId)
    .eq("workspace_id", ctx.workspace_id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new ExpectedError(`version not found: ${versionId}`);
  await assertDeckAccessibleToUser(data.deck_id as string, ctx);
  return {
    version_no: data.version_no as number,
    title: (data.title as string | null) ?? null,
    html_body: (data.html_body as string | null) ?? "",
    slide_styles: (data.slide_styles as string | null) ?? "",
  };
}

// Load a snapshot's (position -> slide_version_id) map + theme/nav for a diff,
// gated by the snapshot's deck.
async function loadSnapshotForDiff(snapshotId: string, ctx: AuthContext) {
  const { data: snap, error } = await admin()
    .from("canvas_deck_snapshot")
    .select("id, deck_id, label, theme_css, nav_js, created_at")
    .eq("id", snapshotId)
    .eq("workspace_id", ctx.workspace_id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!snap) throw new ExpectedError(`snapshot not found: ${snapshotId}`);
  await assertDeckAccessibleToUser(snap.deck_id as string, ctx);
  const { data: pins, error: pErr } = await admin()
    .from("canvas_deck_snapshot_slide")
    .select("position, slide_version_id")
    .eq("snapshot_id", snapshotId);
  if (pErr) throw new Error(pErr.message);
  const byPosition = new Map<number, string>();
  for (const p of pins ?? []) byPosition.set(p.position as number, p.slide_version_id as string);
  return {
    label: (snap.label as string | null) ?? null,
    theme_css: (snap.theme_css as string | null) ?? "",
    nav_js: (snap.nav_js as string | null) ?? "",
    created_at: snap.created_at as string,
    byPosition,
  };
}

// ---------------------------------------------------------------------------
// Tool schemas (for tools/list)
// ---------------------------------------------------------------------------

export const toolDescriptors = [
  {
    name: "create_deck",
    description:
      "Create a new blank deck in the active workspace and return its deck_id. It starts with a single cover slide titled with `title`; add content with propose_new_slide / propose_slide_edit (a human approves your proposals). This is the only way to start a deck from scratch here.",
    inputSchema: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "Deck title (also the cover slide heading).",
        },
        visibility: {
          type: "string",
          enum: ["workspace", "private"],
          description:
            "workspace (default): all workspace members can view and edit. private: only invited members + workspace admins.",
        },
        project_id: {
          type: "string",
          description:
            "Optional Project to file the deck under (a named deck group, e.g. one client proposal). Get ids from list_projects, or create one with create_project.",
        },
      },
      required: ["title"],
      additionalProperties: false,
    },
  },
  {
    name: "list_decks",
    description:
      "List every deck in the active workspace, newest update first. Each row carries its project_id (null = ungrouped); pass project_id to list only one project's decks.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: {
          type: "string",
          description: "Only return decks in this project. Get ids from list_projects.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "list_projects",
    description:
      "List the workspace's Projects — named deck groups (e.g. one client proposal holding its decks) — with deck counts. Projects organize decks; they don't change who can see them.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "create_project",
    description:
      "Create a Project (a named deck group) in the active workspace and return its project_id. Names are unique per workspace (case-insensitive); creating an existing name returns that project with already_existed=true. File decks into it via create_deck's project_id.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Project name, e.g. \"Acme proposal\"." },
        description: { type: "string", description: "Optional one-line description." },
      },
      required: ["name"],
      additionalProperties: false,
    },
  },
  {
    name: "get_deck",
    description:
      "Get deck metadata plus its ordered slide list with current version numbers and lock state. The deck payload includes agent_fast_lane_enabled — when true, your render-verified patch proposals on this deck may self-apply via apply_trusted_proposal; when false, every proposal waits for human review.",
    inputSchema: {
      type: "object",
      properties: { deck_id: { type: "string" } },
      required: ["deck_id"],
      additionalProperties: false,
    },
  },
  {
    name: "read_slide",
    description: "Read a single slide's title, html_body, slide_styles, and current version number.",
    inputSchema: {
      type: "object",
      properties: { slide_id: { type: "string" } },
      required: ["slide_id"],
      additionalProperties: false,
    },
  },
  {
    name: "read_theme",
    description: "Read a deck's shared theme_css and nav_js (read-only context).",
    inputSchema: {
      type: "object",
      properties: { deck_id: { type: "string" } },
      required: ["deck_id"],
      additionalProperties: false,
    },
  },
  {
    name: "write_slide_notes",
    description:
      "Write a slide's speaker notes (the presenter's talk track, shown in present mode and carried into PowerPoint export). DIRECT write, no proposal — notes are presenter working text, not the visual deliverable, so \"write my talk track\" applies immediately. Last-write-wins and NOT versioned; deck-shared (one talk track per slide, not per presenter). Pass an empty string to clear. read_slide returns the current speaker_notes.",
    inputSchema: {
      type: "object",
      properties: {
        slide_id: { type: "string" },
        notes: {
          type: "string",
          description: "The talk track for this slide. Empty string clears it.",
        },
      },
      required: ["slide_id", "notes"],
      additionalProperties: false,
    },
  },
  {
    name: "read_brand",
    description:
      "Read the workspace's brand kit: named colors (hex), font stacks, and writing-voice rules. Use these tokens when generating or restyling slides so the result is on-brand without the user restating the palette. Returns configured=false when no brand kit is set.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "read_full_deck",
    description:
      "Assemble the deck back into a single HTML string (for cross-slide context). Also returns a `slides` array with each slide's slide_id, position, title, and current_version_no — use those when proposing edits afterwards (propose_slide_edit requires base_version_no).",
    inputSchema: {
      type: "object",
      properties: { deck_id: { type: "string" } },
      required: ["deck_id"],
      additionalProperties: false,
    },
  },
  {
    name: "list_sources",
    description:
      "List the reference material a human PINNED to this deck — PDFs, URLs, and pasted text that are 'what to read before drafting'. Call this FIRST when you start work on a deck (or a specific slide): the pins are the human's brief, and drafting without them means guessing at content they already gave you. Returns each source's id, kind (pdf/url/text/file), label, url, and a short body_preview; pass slide_id to scope to one slide's context (you'll get the deck-wide pins PLUS that slide's). Read the full text of any that look relevant with read_source. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        deck_id: { type: "string" },
        slide_id: {
          type: "string",
          description:
            "Optional. Narrow to one slide's context: returns the deck-wide pinned sources plus the ones pinned to this slide. Omit to list every source on the deck.",
        },
      },
      required: ["deck_id"],
      additionalProperties: false,
    },
  },
  {
    name: "read_source",
    description:
      "Read one pinned source's FULL content by its id (from list_sources) — the body text of a pasted-text source, plus its kind, label, and url. This is reference material the human attached for you to read BEFORE drafting; consult it rather than inventing facts it already contains. For URL sources, the url is returned (fetch it yourself if you need the page contents); for a pinned PDF/file, only its label, url, and storage_path come back this round — the binary content isn't fetched, so use the label to reason about it and ask the human if you need what's inside. Read-only.",
    inputSchema: {
      type: "object",
      properties: { source_id: { type: "string" } },
      required: ["source_id"],
      additionalProperties: false,
    },
  },
  {
    name: "render_slide",
    description:
      "Render a slide to an IMAGE so you can SEE how it actually looks laid out — Canvas decks use a fixed pixel stage with CSS that reads HTML/CSS you can't evaluate from the markup alone. Returns a JPEG of the slide as it renders (assets and fonts inlined). Renders ONLY this slide with the deck theme applied (fast — cost scales with the slide, not the deck; the same single-slide capture render_proposal uses). Note: render_slide shows the slide's CURRENT stored content — a just-proposed change is pending review and is NOT yet reflected. To CLOSE THE LOOP on an edit you just proposed (confirm the patch renders right BEFORE telling the human it's done), use render_proposal with the edit_id instead — render_slide is for the live/applied state. Read-access only; does not modify anything.",
    inputSchema: {
      type: "object",
      properties: {
        slide_id: { type: "string" },
        scale: {
          type: "integer",
          minimum: 1,
          maximum: 3,
          description:
            "deviceScaleFactor for the render. Defaults to 1 (plenty to inspect your work). Pass 2-3 for a sharper, larger image; capped at 3.",
        },
      },
      required: ["slide_id"],
      additionalProperties: false,
    },
  },
  {
    name: "render_deck",
    description:
      "Render EVERY slide of a deck to images, in order — one labelled JPEG per slide — so you can review the whole deck visually (consistency pass, spotting layout breaks across slides). Same capture as render_slide; prefer render_slide when you only need to check one slide (a full-deck render is slower and heavier). Shows current stored content, not pending proposals — use render_proposal to preview a single unapproved proposal. Read-access only.",
    inputSchema: {
      type: "object",
      properties: {
        deck_id: { type: "string" },
        scale: {
          type: "integer",
          minimum: 1,
          maximum: 3,
          description:
            "deviceScaleFactor for the render. Defaults to 1 (plenty to inspect your work). Pass 2-3 for a sharper, larger image; capped at 3.",
        },
      },
      required: ["deck_id"],
      additionalProperties: false,
    },
  },
  {
    name: "render_proposal",
    description:
      "Render a PENDING proposal to an IMAGE so you can SEE how your just-proposed change WILL look — BEFORE the human reviews it. This closes the loop render_slide can't: a proposal isn't applied until a human approves it, so render_slide (which shows the slide's CURRENT content) can't preview your unapproved change; render_proposal can. Pass the edit_id returned by propose_slide_patch / propose_slide_edit / propose_new_slide / propose_duplicate_slide. Returns a JPEG of the slide as the proposal WOULD leave it (for edits: the proposed html_body/slide_styles/title merged over the current slide exactly as canvas_apply_edit will merge it on approval; for slide_create: the new slide's payload rendered with the deck theme; assets inlined). Use it to confirm a proposal renders right, then tell the human it's ready. Previews proposals that change or create one slide (slide_edit / slide_html / slide_styles / slide_title / slide_create); theme or reorder/delete proposals have nothing to show as a single slide. Read-access only — does NOT apply or approve the proposal.",
    inputSchema: {
      type: "object",
      properties: {
        proposal_id: {
          type: "string",
          description:
            "The edit_id returned by propose_slide_patch / propose_slide_edit — the pending proposal to preview.",
        },
        scale: {
          type: "integer",
          minimum: 1,
          maximum: 3,
          description:
            "deviceScaleFactor for the render. Defaults to 1 (plenty to inspect your work). Pass 2-3 for a sharper, larger image; capped at 3.",
        },
      },
      required: ["proposal_id"],
      additionalProperties: false,
    },
  },
  {
    name: "apply_trusted_proposal",
    description:
      "Apply your own deterministic patch proposal after you have called render_proposal and visually verified the returned image. This is a narrow opt-in fast lane: it works only for proposals created by propose_slide_patch or propose_deck_patch, only when both the workspace and this deck explicitly allow it, and only when you own the deck/slide (workspace owners/admins qualify). If it is not enabled, leave the proposal pending for human Review. Never call this before inspecting render_proposal's image.",
    inputSchema: {
      type: "object",
      properties: {
        proposal_id: {
          type: "string",
          description:
            "The pending edit_id returned by propose_slide_patch / propose_deck_patch and successfully rendered with render_proposal.",
        },
      },
      required: ["proposal_id"],
      additionalProperties: false,
    },
  },
  {
    name: "propose_slide_edit",
    description:
      "Propose a FULL-CONTENT change to a slide's html_body, slide_styles, and/or title. For targeted adjustments (copy tweaks, number changes, small styling fixes) prefer propose_slide_patch — it takes find/replace snippets instead of the whole slide and is much faster; use this tool when redesigning or replacing most of the slide. IMPORTANT: build the replacement from the slide's CURRENT content — call read_slide immediately before composing it (the copy you read earlier in the session may be outdated; humans edit slides directly in the Canvas UI), and echo that read's current_version_no as base_version_no. A version mismatch rejects the proposal, because approving a replacement built from a stale copy silently reverts every newer edit. Pass any combination of new_html_body, new_slide_styles, and new_title (at least one) — they're BUNDLED into a single proposal that the reviewer approves or rejects as one atomic change, applied as one new slide version. So a redesign that touches both markup and CSS is one proposal, not two. Creates a pending canvas_deck_edit row; the slide owner reviews and approves through the Canvas UI. The slide is NOT modified until approval. `new_title` changes the slide's internal label shown in the editor's slide list; it does NOT render on the slide itself. Omitted fields keep their current value on approval. Always include a clear rationale so the reviewer knows what you changed and why.",
    inputSchema: {
      type: "object",
      properties: {
        slide_id: { type: "string" },
        base_version_no: {
          type: "integer",
          minimum: 1,
          description:
            "The slide's current_version_no from your MOST RECENT read_slide / get_deck / read_full_deck. Proves the replacement was built from the slide's current content; if the slide has changed since (someone edited it in the Canvas UI, or another proposal was approved), the call is rejected and you must re-read the slide and rebuild the edit from the current content.",
        },
        new_html_body: {
          type: "string",
          description: "Full replacement HTML for the slide. Must be wrapped in `<section class=\"slide\">…</section>` so it inherits the deck theme's slide rule; bare body markup is auto-wrapped in a default `<section class=\"slide\">`. Combine with new_slide_styles and/or new_title to bundle them into one proposal.",
        },
        new_slide_styles: {
          type: "string",
          description: "The full replacement slide-scoped CSS. Combine with new_html_body and/or new_title to bundle them into one proposal.",
        },
        new_title: {
          type: "string",
          description: "New internal label for the slide (what shows in the editor's slide list — it does NOT render on the slide). Stored trimmed; a whitespace-only value clears the label. Combine with new_html_body and/or new_slide_styles to bundle them into one proposal.",
        },
        rationale: {
          type: "string",
          description: "A short explanation of the change — appears in the reviewer's diff view. Strongly recommended.",
        },
      },
      required: ["slide_id", "base_version_no"],
      additionalProperties: false,
    },
  },
  {
    name: "propose_slide_variants",
    description:
      "Propose 2–4 ALTERNATIVE designs for ONE slide as a variant set the human picks from — use this when the user asks for options (\"give me 3 versions\") or after two or more full rewrites of the same slide haven't converged. Each variant is a full replacement (same field semantics as propose_slide_edit: new_html_body / new_slide_styles / new_title, at least one each) plus an optional short label (e.g. \"bolder\", \"data-forward\"). All variants insert atomically as sibling pending proposals sharing a variant_group_id. In the in-app Ask-agent chatbox they render as ONE side-by-side pick-one card; from a terminal MCP client they appear as individual pending proposals in Review, where approving one is refused until the others are withdrawn or rejected. Either way exactly one can land and the rest are set aside automatically. Do not approve any yourself; picking is deliberately human. Echo base_version_no from your most recent read_slide. Include a rationale describing what varies across the set.",
    inputSchema: {
      type: "object",
      properties: {
        slide_id: { type: "string" },
        base_version_no: {
          type: "integer",
          minimum: 1,
          description:
            "The slide's current_version_no from your MOST RECENT read_slide / get_deck. One staleness gate covers the whole set.",
        },
        variants: {
          type: "array",
          minItems: 2,
          maxItems: 4,
          description: "The alternative designs. Each needs at least one content field.",
          items: {
            type: "object",
            properties: {
              new_html_body: { type: "string" },
              new_slide_styles: { type: "string" },
              new_title: { type: "string" },
              label: {
                type: "string",
                description: "Short human label for this direction (max 60 chars).",
              },
            },
            additionalProperties: false,
          },
        },
        rationale: {
          type: "string",
          description: "What varies across the set — appears in the reviewer's cards.",
        },
      },
      required: ["slide_id", "base_version_no", "variants"],
      additionalProperties: false,
    },
  },
  {
    name: "propose_slide_patch",
    description:
      "Propose a TARGETED change to a slide via find/replace — the fast path for adjustments. Pass one or more {find, replace} edits; the server applies them to the slide's current stored content and creates the same pending slide_edit proposal as propose_slide_edit (the reviewer sees the full before/after diff and approves in the Canvas UI; the slide is NOT modified until approval). Strongly preferred over propose_slide_edit for copy tweaks, number updates, or styling fixes: you send only the changed snippets instead of regenerating the whole slide. Each `find` must match the slide's CURRENT content exactly (whitespace-sensitive — call read_slide first and copy text verbatim) and must be unique within its field unless replace_all=true; extend the snippet with surrounding context to disambiguate. Edits apply in order, each seeing the previous edits' output. Set in:'slide_styles' on an edit to patch the slide-scoped CSS instead of the HTML. Always include a rationale.",
    inputSchema: {
      type: "object",
      properties: {
        slide_id: { type: "string" },
        edits: {
          type: "array",
          minItems: 1,
          maxItems: 50,
          items: {
            type: "object",
            properties: {
              find: {
                type: "string",
                description:
                  "Exact text to locate in the slide's current content (whitespace-sensitive). Must be unique within the target field unless replace_all=true.",
              },
              replace: {
                type: "string",
                description: "Replacement text. Empty string deletes the found text.",
              },
              in: {
                type: "string",
                enum: ["html_body", "slide_styles"],
                description: "Field to patch. Defaults to html_body.",
              },
              replace_all: {
                type: "boolean",
                description: "Replace every occurrence instead of requiring a unique match.",
              },
            },
            required: ["find", "replace"],
            additionalProperties: false,
          },
          description: "Find/replace edits applied in order against the slide's current content.",
        },
        rationale: {
          type: "string",
          description: "A short explanation of the change — appears in the reviewer's diff view. Strongly recommended.",
        },
      },
      required: ["slide_id", "edits"],
      additionalProperties: false,
    },
  },
  {
    name: "propose_deck_patch",
    description:
      "Propose TARGETED find/replace edits across MULTIPLE slides in ONE reviewable batch — for a change that spans the deck (rename a product everywhere, restyle a recurring element, fix a repeated typo). Each edit carries its own slide_id; edits on the same slide are grouped and applied together (one proposal per slide). Emits one pending slide_edit proposal per affected slide, the same shape propose_slide_patch produces, so the reviewer can approve them together via the inbox's batch-approve. ATOMIC: every slide's snippet is resolved against that slide's CURRENT stored content first, and only if ALL resolve are any proposals written — if one `find` doesn't match (whitespace-sensitive), matches ambiguously, or removes a slide's <section> wrapper, the whole call fails naming the offending slide and NO rows are created, so you never land a half-applied batch. Each `find` must match exactly (call read_slide / read_full_deck first and copy text verbatim) and be unique within its slide+field unless replace_all=true. Prefer per-slide propose_slide_patch when the change touches only one slide; use this when the SAME or related change repeats across several. Always include a rationale.",
    inputSchema: {
      type: "object",
      properties: {
        deck_id: { type: "string" },
        edits: {
          type: "array",
          minItems: 1,
          maxItems: 50,
          items: {
            type: "object",
            properties: {
              slide_id: {
                type: "string",
                description:
                  "The slide this edit targets. Multiple edits with the same slide_id are applied together in order against that slide.",
              },
              find: {
                type: "string",
                description:
                  "Exact text to locate in the slide's current content (whitespace-sensitive). Must be unique within the target field of its slide unless replace_all=true.",
              },
              replace: {
                type: "string",
                description: "Replacement text. Empty string deletes the found text.",
              },
              in: {
                type: "string",
                enum: ["html_body", "slide_styles"],
                description: "Field to patch on this slide. Defaults to html_body.",
              },
              replace_all: {
                type: "boolean",
                description:
                  "Replace every occurrence in this slide's field instead of requiring a unique match.",
              },
            },
            required: ["slide_id", "find", "replace"],
            additionalProperties: false,
          },
          description:
            "Find/replace edits, each tagged with a slide_id. Edits on the same slide apply in order; one proposal is created per slide.",
        },
        rationale: {
          type: "string",
          description:
            "A short explanation of the change — appears on every slide's proposal in the reviewer's diff view. Strongly recommended.",
        },
      },
      required: ["deck_id", "edits"],
      additionalProperties: false,
    },
  },
  {
    name: "propose_new_slide",
    description:
      "Propose creating a new slide on a deck at a specific 0-indexed position. Existing slides at or after that position shift right by one on approval. The slide starts unowned (any workspace member can subsequently edit it). Creates a pending canvas_deck_edit row with kind='slide_create'; a workspace admin or the deck creator reviews and approves through the Canvas UI. Always include a rationale so the reviewer understands what you're adding and why.",
    inputSchema: {
      type: "object",
      properties: {
        deck_id: { type: "string" },
        position: {
          type: "integer",
          minimum: 0,
          description:
            "0-indexed slot for the new slide. 0 inserts at the start; pass the current slide count to append at the end. Existing slides at or after this position shift right by one.",
        },
        html_body: {
          type: "string",
          description: "Full HTML for the new slide. Must be wrapped in `<section class=\"slide\">…</section>` so it inherits the deck theme's slide rule (full-viewport sizing, padding, centering). Bare body markup (e.g. just `<h1>…`) is auto-wrapped in a default `<section class=\"slide\">` — pass the wrapper yourself if you need class modifiers like `slide cover` or `slide split`. Required.",
        },
        title: {
          type: "string",
          description: "Slide title. Optional, defaults to empty.",
        },
        slide_styles: {
          type: "string",
          description: "Slide-scoped CSS that doesn't belong in the deck theme. Optional.",
        },
        rationale: {
          type: "string",
          description: "Short explanation of why you're adding this slide. Strongly recommended — appears in the reviewer's diff view.",
        },
      },
      required: ["deck_id", "position", "html_body"],
      additionalProperties: false,
    },
  },
  {
    name: "propose_duplicate_slide",
    description:
      "Propose duplicating an existing slide, optionally with find/replace edits applied to the COPY at propose time. This is the FAST PATH for adding a slide that resembles an existing one (\"add a slide like slide 4 but for Q3\"): pass edits (the same {find, replace, in?, replace_all?} shape as propose_slide_patch, resolved against the source's content server-side) and the whole thing is ONE deterministic proposal and one review — no regenerating 4-13KB of HTML, no duplicate-approve-then-patch second round-trip. Without edits it copies html_body, slide_styles, and title verbatim. The copy is inserted right AFTER the source slide (later slides shift right on approval); kind='slide_create', pending until a reviewer approves. Call render_proposal on the returned edit_id to verify the copy visually. Always include a rationale.",
    inputSchema: {
      type: "object",
      properties: {
        slide_id: {
          type: "string",
          description: "The slide to duplicate. The copy is inserted right after it.",
        },
        edits: {
          type: "array",
          minItems: 1,
          maxItems: 50,
          items: {
            type: "object",
            properties: {
              find: {
                type: "string",
                description:
                  "Exact text to locate in the SOURCE slide's current content (whitespace-sensitive). Must be unique within the target field unless replace_all=true.",
              },
              replace: {
                type: "string",
                description: "Replacement text for the copy. Empty string deletes the found text.",
              },
              in: {
                type: "string",
                enum: ["html_body", "slide_styles"],
                description: "Field to patch. Defaults to html_body.",
              },
              replace_all: {
                type: "boolean",
                description: "Replace every occurrence instead of requiring a unique match.",
              },
            },
            required: ["find", "replace"],
            additionalProperties: false,
          },
          description:
            "Optional find/replace edits applied to the copy at propose time, in order, against the source slide's current content. Omit for a verbatim duplicate.",
        },
        new_title: {
          type: "string",
          description: "Optional title for the copy. Defaults to the source slide's title.",
        },
        rationale: {
          type: "string",
          description: "Short explanation of why you're duplicating this slide. Appears in the reviewer's view.",
        },
      },
      required: ["slide_id"],
      additionalProperties: false,
    },
  },
  {
    name: "copy_slide",
    description:
      "Copy a slide from one deck into ANOTHER deck in the same workspace (\"insert the team slide from the intro deck\"). Reads the source slide (you need read access to its deck) and proposes a slide_create on the destination deck (you need edit access there); a reviewer approves it in the Canvas UI. The copy carries the source's html_body, slide_styles, and title verbatim plus a provenance stamp of exactly which version was copied. It does NOT carry the source deck's theme_css — across two decks with different themes the copy may need a restyle; call render_proposal on the returned edit_id to check how it lands before telling the human it's ready. Speaker notes do NOT travel with a copy. Images from a PRIVATE source deck render in previews and exports only for viewers who can also read that source deck; an export by someone without source access may drop them (they stay as un-inlined URLs). Defaults to the end of the destination deck; pass position to insert elsewhere. A copy is a fork: later changes to the source do not propagate.",
    inputSchema: {
      type: "object",
      properties: {
        source_slide_id: { type: "string", description: "The slide to copy." },
        dest_deck_id: { type: "string", description: "The deck to copy it into." },
        position: {
          type: "integer",
          minimum: 0,
          description: "0-based insert position in the destination deck. Omit to append at the end.",
        },
        rationale: {
          type: "string",
          description: "Why this slide is being reused here. Appears in the reviewer's view.",
        },
      },
      required: ["source_slide_id", "dest_deck_id"],
      additionalProperties: false,
    },
  },
  {
    name: "propose_reorder_slides",
    description:
      "Propose reordering a deck's slides. `order` is the COMPLETE list of the deck's slide ids in the desired order (every current slide exactly once — get_deck gives you the ids). On approval, positions are rewritten to match. Creates a pending canvas_deck_edit row with kind='slide_reorder' that a workspace admin or the deck creator approves in the Canvas UI. Always include a rationale.",
    inputSchema: {
      type: "object",
      properties: {
        deck_id: { type: "string" },
        order: {
          type: "array",
          items: { type: "string" },
          description:
            "All of the deck's slide ids, in the desired final order. Must be an exact permutation of the current slides (same set, no duplicates, none missing).",
        },
        rationale: {
          type: "string",
          description: "Short explanation of the reordering. Appears in the reviewer's view.",
        },
      },
      required: ["deck_id", "order"],
      additionalProperties: false,
    },
  },
  {
    name: "propose_delete_slide",
    description:
      "Propose deleting a slide. Creates a pending canvas_deck_edit row with kind='slide_delete' that a workspace admin or the deck creator approves in the Canvas UI. WARNING: approving permanently removes the slide AND its entire version history (and any comments/locks on it) — it is not recoverable via restore. Cannot delete a deck's only slide. Always include a rationale explaining why the slide should go.",
    inputSchema: {
      type: "object",
      properties: {
        slide_id: { type: "string" },
        rationale: {
          type: "string",
          description: "Short explanation of why this slide should be removed. Strongly recommended.",
        },
      },
      required: ["slide_id"],
      additionalProperties: false,
    },
  },
  {
    name: "propose_theme_edit",
    description:
      "Propose a change to a deck's theme_css OR nav_js. Creates a pending canvas_deck_edit row; the deck owner reviews and approves through the Canvas UI. Submit one kind of change per call.",
    inputSchema: {
      type: "object",
      properties: {
        deck_id: { type: "string" },
        new_theme_css: {
          type: "string",
          description: "The full replacement theme CSS. Submit this OR new_nav_js, not both.",
        },
        new_nav_js: {
          type: "string",
          description: "The full replacement navigation JS. Submit this OR new_theme_css, not both.",
        },
        rationale: { type: "string" },
      },
      required: ["deck_id"],
      additionalProperties: false,
    },
  },
  {
    name: "propose_deck_edit",
    description:
      "Propose a change to deck-level metadata. Currently the only supported field is the deck title; future fields (status, meta, etc.) will plug into the same tool. Creates a pending canvas_deck_edit row with kind='deck_title'; the deck owner or a workspace admin reviews and approves through the Canvas UI. Exactly one field must be set per call. Include a rationale so the reviewer knows what you changed and why.",
    inputSchema: {
      type: "object",
      properties: {
        deck_id: { type: "string" },
        new_title: {
          type: "string",
          description:
            "The full replacement deck title. Must be non-empty after trimming whitespace.",
        },
        rationale: {
          type: "string",
          description:
            "Short explanation of the change — appears in the reviewer's diff view. Strongly recommended.",
        },
      },
      required: ["deck_id"],
      additionalProperties: false,
    },
  },
  {
    name: "list_proposals",
    description:
      "List proposals (canvas_deck_edit rows) in the workspace, newest first. Filter by deck, slide, status (pending/applied/rejected/superseded), or limit to your own proposals.",
    inputSchema: {
      type: "object",
      properties: {
        deck_id: { type: "string" },
        slide_id: { type: "string" },
        status: {
          type: "string",
          enum: ["pending", "applied", "rejected", "superseded"],
        },
        mine: {
          type: "boolean",
          description: "When true, only return proposals you authored.",
        },
        limit: { type: "number", minimum: 1, maximum: 200 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "get_proposal",
    description:
      "Read a single proposal: full proposed content, rationale, status, base version pointer, plus every comment on the thread.",
    inputSchema: {
      type: "object",
      properties: { edit_id: { type: "string" } },
      required: ["edit_id"],
      additionalProperties: false,
    },
  },
  {
    name: "comment_on_proposal",
    description:
      "Leave a comment on a proposal thread. Visible to the proposer and the reviewer. Useful for clarifying intent or responding to reviewer feedback.",
    inputSchema: {
      type: "object",
      properties: {
        edit_id: { type: "string" },
        body: { type: "string" },
      },
      required: ["edit_id", "body"],
      additionalProperties: false,
    },
  },
  {
    name: "withdraw_proposal",
    description:
      "Cancel a PENDING proposal you authored: marks it rejected so the reviewer no longer sees it. Safe to call on a non-pending proposal — it's an idempotent no-op that reports the current status and never errors on state. A reviewer may approve before you withdraw, so if the proposal is already APPLIED this returns action_required: \"revert_proposal\" (call revert_proposal with the same edit_id to undo it); an already-rejected/withdrawn proposal returns already_resolved. The result's `withdrawn` boolean tells you whether THIS call cancelled it. A withdrawn proposal can't be un-withdrawn — submit a fresh propose_* call to retry.",
    inputSchema: {
      type: "object",
      properties: { edit_id: { type: "string" } },
      required: ["edit_id"],
      additionalProperties: false,
    },
  },
  {
    name: "revert_proposal",
    description:
      "Undo an APPLIED slide proposal: proposes restoring the slide to the content it had immediately before that proposal landed. Creates a normal pending slide_edit proposal — the slide is unchanged until a human approves the revert. Works for slide-content proposals (slide_edit / patches); structural changes (delete, reorder, create) can't be auto-reverted. Optional rationale overrides the generated one.",
    inputSchema: {
      type: "object",
      properties: {
        edit_id: { type: "string" },
        rationale: { type: "string" },
      },
      required: ["edit_id"],
      additionalProperties: false,
    },
  },
  {
    name: "lock_slide",
    description:
      "Claim a slide for editing — 15-minute soft lock. Advisory: signals to other editors that you're working on this slide. Does not block propose_slide_edit from other proposers.",
    inputSchema: {
      type: "object",
      properties: { slide_id: { type: "string" } },
      required: ["slide_id"],
      additionalProperties: false,
    },
  },
  {
    name: "release_slide",
    description: "Release a slide you currently hold. Has no effect on locks held by other users.",
    inputSchema: {
      type: "object",
      properties: { slide_id: { type: "string" } },
      required: ["slide_id"],
      additionalProperties: false,
    },
  },
  {
    name: "list_comments",
    description:
      "List threaded comments on a deck, grouped by thread. Each thread root carries its replies inline. Defaults to unresolved threads only — pass include_resolved=true to fetch the full history. Scope to a single slide by passing slide_id; omit it to include both deck-level and slide-level threads on the deck. Returns up to `limit` thread roots (default 100, max 500) ordered by creation time ascending; replies under a returned root are always included regardless of the limit. Use this before reply_to_comment or resolve_comment so you know the thread root id.",
    inputSchema: {
      type: "object",
      properties: {
        deck_id: { type: "string" },
        slide_id: {
          type: "string",
          description:
            "Scope to a specific slide. Omit to include both deck-level threads and every slide's comments on the deck.",
        },
        include_resolved: {
          type: "boolean",
          description:
            "When true, include thread roots whose resolved flag is set. Defaults to false.",
        },
        limit: {
          type: "number",
          minimum: 1,
          maximum: 500,
          description: "Cap on returned thread roots. Default 100, max 500.",
        },
      },
      required: ["deck_id"],
      additionalProperties: false,
    },
  },
  {
    name: "add_comment",
    description:
      "Post a new top-level comment (a thread root) on a deck or slide. Pass slide_id to anchor the thread to a specific slide; omit it for a deck-level thread. Optionally pin the comment to a specific point on the slide canvas by passing both anchor_x and anchor_y as normalized fractions in [0, 1]; anchors are only valid when slide_id is set. Comments authored via MCP carry author_kind='claude' but keep the human's user_id for audit. Returns the new comment id; use reply_to_comment to add replies under it.",
    inputSchema: {
      type: "object",
      properties: {
        deck_id: { type: "string" },
        slide_id: {
          type: "string",
          description:
            "Slide to anchor the comment to. Omit for a deck-level thread.",
        },
        body: {
          type: "string",
          description: "Comment text. Trimmed; must be non-empty after trim.",
        },
        anchor_x: {
          type: "number",
          minimum: 0,
          maximum: 1,
          description:
            "Horizontal pin position as a fraction of the slide's rendered rect (0 = left edge, 1 = right edge). Requires anchor_y and slide_id.",
        },
        anchor_y: {
          type: "number",
          minimum: 0,
          maximum: 1,
          description:
            "Vertical pin position as a fraction of the slide's rendered rect (0 = top edge, 1 = bottom edge). Requires anchor_x and slide_id.",
        },
      },
      required: ["deck_id", "body"],
      additionalProperties: false,
    },
  },
  {
    name: "reply_to_comment",
    description:
      "Reply to an existing comment thread. parent_id must be a thread root (a comment whose own parent_id is null); replies are one level deep, matching the UI. The reply inherits the root's deck/slide scope. Use list_comments first to find the right root id.",
    inputSchema: {
      type: "object",
      properties: {
        parent_id: {
          type: "string",
          description:
            "ID of the thread root to reply under. Must be a root (parent_id null), not another reply.",
        },
        body: {
          type: "string",
          description: "Reply text. Trimmed; must be non-empty after trim.",
        },
      },
      required: ["parent_id", "body"],
      additionalProperties: false,
    },
  },
  {
    name: "resolve_comment",
    description:
      "Mark a comment thread root resolved (or un-resolve it). Only thread roots can be resolved — pass the root id, not a reply id. Pass resolved=false to un-resolve a previously resolved thread; resolved_by and resolved_at are cleared in that case.",
    inputSchema: {
      type: "object",
      properties: {
        comment_id: {
          type: "string",
          description: "ID of the thread root to resolve. Must be a root (parent_id null).",
        },
        resolved: {
          type: "boolean",
          description: "Defaults to true. Pass false to un-resolve.",
        },
      },
      required: ["comment_id"],
      additionalProperties: false,
    },
  },
  {
    name: "list_slide_versions",
    description: "List historical versions of a slide, newest first.",
    inputSchema: {
      type: "object",
      properties: {
        slide_id: { type: "string" },
        limit: { type: "number", minimum: 1, maximum: 200 },
      },
      required: ["slide_id"],
      additionalProperties: false,
    },
  },
  {
    name: "read_slide_version",
    description: "Read a specific historical version of a slide (title, html_body, slide_styles, attribution).",
    inputSchema: {
      type: "object",
      properties: { version_id: { type: "string" } },
      required: ["version_id"],
      additionalProperties: false,
    },
  },
  {
    name: "list_snapshots",
    description: "List named deck snapshots, newest first.",
    inputSchema: {
      type: "object",
      properties: {
        deck_id: { type: "string" },
        limit: { type: "number", minimum: 1, maximum: 200 },
      },
      required: ["deck_id"],
      additionalProperties: false,
    },
  },
  {
    name: "create_snapshot",
    description: "Capture a named cut of the deck (theme + nav + current version of every slide).",
    inputSchema: {
      type: "object",
      properties: {
        deck_id: { type: "string" },
        label: { type: "string" },
        description: { type: "string" },
      },
      required: ["deck_id", "label"],
      additionalProperties: false,
    },
  },
  {
    name: "read_snapshot",
    description:
      "Read a snapshot's frozen content: its theme/nav plus every slide's title and html_body as captured at snapshot time. Use this to see what a deck looked like at a named cut (e.g. the version you sent a client) without restoring it.",
    inputSchema: {
      type: "object",
      properties: {
        snapshot_id: { type: "string", description: "From list_snapshots." },
      },
      required: ["snapshot_id"],
      additionalProperties: false,
    },
  },
  {
    name: "diff_slide_versions",
    description:
      "Compare two slide versions and return a unified diff of their html_body (and slide_styles), plus the line-change ratio. Use it to answer 'what changed between v4 and v7 of this slide' without pulling both full versions and diffing them yourself. Get version ids from list_slide_versions.",
    inputSchema: {
      type: "object",
      properties: {
        a_id: { type: "string", description: "The earlier (base) slide_version id." },
        b_id: { type: "string", description: "The later (compare) slide_version id." },
      },
      required: ["a_id", "b_id"],
      additionalProperties: false,
    },
  },
  {
    name: "diff_snapshots",
    description:
      "Compare two deck snapshots: which slide positions changed/were added/removed between them, and whether the theme or nav changed. Use it for 'what's different since the snapshot I took before the client meeting'. Get snapshot ids from list_snapshots.",
    inputSchema: {
      type: "object",
      properties: {
        a_id: { type: "string", description: "The earlier (base) snapshot id." },
        b_id: { type: "string", description: "The later (compare) snapshot id." },
      },
      required: ["a_id", "b_id"],
      additionalProperties: false,
    },
  },
];

// MCP JSON-RPC dispatcher — phase 3.
//
// Implements the request/response MCP surface used by compatible agent clients:
//   - initialize          → returns server name + protocol version + capabilities
//   - notifications/*     → notifications: no response (HTTP 202)
//   - ping                → empty result (health check)
//   - tools/list          → returns toolDescriptors
//   - tools/call          → executes the named tool with `arguments`
//
// All other methods reply with code -32601 (Method not found). We intentionally
// don't support SSE in v1 — the tool flow is request/response only.

import {
  tools,
  toolDescriptors,
  ExpectedError,
  isMcpContentResult,
  type AuthContext,
} from "./tools";
import { logUsage } from "@/lib/usage/log";
import { createAdminClient } from "@/lib/supabase/admin";
import { rateLimitOk } from "@/lib/canvas/rate-limit";

// Write fan-out cap. Write tools mint a row a human must triage (or mutate deck
// state directly); the per-request limit in api/mcp/[token] bounds HTTP volume
// but not the cumulative WRITE effect, so a buggy or abusive session could
// flood the review rail (a denial-of-attention attack). Cap write actions per
// user on a tighter window. Reads are unaffected. (propose_deck_patch can emit
// several proposals per call; this coarse per-call cap still bounds the worst
// case because that tool is itself capped at MAX_PATCH_EDITS slides.)
const WRITE_LIMIT_PER_HOUR = 80;

// Classification is fail-closed: the read-only tools are enumerated, and
// ANYTHING else counts as a write. The old propose_/create_ prefix check let
// non-prefixed writers (copy_slide, which mints a proposal; write_slide_notes,
// a direct write) slip the cap; keying on the reads instead means a future
// write tool is capped by default until it is deliberately listed as a read.
// mcp-write-cap.test.ts pins the full classification so adding a tool forces
// the decision rather than silently defaulting.
const READ_ONLY_TOOLS = new Set<string>([
  "diff_slide_versions",
  "diff_snapshots",
  "get_deck",
  "get_proposal",
  "list_comments",
  "list_decks",
  "list_projects",
  "list_proposals",
  "list_slide_versions",
  "list_snapshots",
  "list_sources",
  "read_brand",
  "read_full_deck",
  "read_slide",
  "read_slide_version",
  "read_snapshot",
  "read_source",
  "read_theme",
  "render_deck",
  "render_proposal",
  "render_slide",
]);
export function isWriteTool(name: string): boolean {
  return !READ_ONLY_TOOLS.has(name);
}

const PROTOCOL_VERSION = "2024-11-05";
const SERVER_NAME = "canvas";
const SERVER_VERSION = "0.2.0";

// Session-level guidance surfaced by MCP clients in the initialize result.
// Keep the first paragraph self-contained because clients vary in how much of
// the optional instructions field they preserve.
const INSTRUCTIONS = `Canvas is a propose-first multiplayer deck editor. You never edit decks directly — you PROPOSE changes that a human approves in the Canvas web UI. (One exception: create_deck makes a new blank deck directly — use it to start from scratch, then propose slides into it.)

Workflow:
1. Read only what you need: get_deck lists the slides (ids, positions, titles) — that's how "slide 5" becomes a slide_id; read_slide returns one slide's content. Use read_full_deck ONLY for genuinely cross-slide work (full redesign, theme audit) — it returns the entire deck and is slow to read.
2. ADJUSTMENTS (copy tweaks, numbers, small styling fixes) — the common case: read_slide, then propose_slide_patch with exact find/replace snippets. Do NOT regenerate the whole slide for a small change; that's what makes edits slow. Reserve propose_slide_edit (full replacement) for redesigns or when most of the slide changes. If you do send a full propose_slide_edit that only touches a little, the result will usually include suggested_patch — the exact propose_slide_patch call you should have used; when it does, switch to that shape next time.
3. Propose: propose_slide_patch / propose_slide_edit / propose_new_slide / propose_theme_edit / propose_deck_edit insert a PENDING proposal. The slide/theme is NOT changed until a human approves it — so a just-proposed change won't show up in a later read_slide. Don't re-propose because it "didn't take"; it's waiting for review.
4. After every visual proposal, call render_proposal and inspect the returned image before reporting the work ready. If the render is wrong, withdraw or revise the pending proposal. Never claim a proposal was visually verified unless you actually rendered it. An eligible patch render may tell you apply_trusted_proposal is available; call it only after the image looks correct. If the deck is not opted in, leave the proposal pending for human Review.
5. Always pass a rationale — it's what the reviewer reads in the diff, and unexplained proposals get extra scrutiny.

Rules:
- propose_slide_patch finds/replaces against the slide's CURRENT stored content — "find" is whitespace-sensitive and must be unique (or pass replace_all). On a "not found" error, re-run read_slide and copy the text verbatim; don't fall back to a full propose_slide_edit just because one snippet missed.
- propose_slide_edit BUNDLES a slide's html_body, slide_styles, and/or title (pass any combination, at least one) into a single proposal the reviewer approves or rejects atomically — a redesign touching both markup and CSS is ONE proposal. (propose_theme_edit still takes new_theme_css OR new_nav_js, one per call.)
- propose_slide_edit requires base_version_no — the current_version_no from your LATEST read of that slide. Slides change under you mid-session (humans edit text directly in the Canvas UI), so read_slide right before composing a full replacement and build it from that content. On a version-mismatch error, re-read and rebuild from the current content — never re-send the same payload with the new number, and never "restore" text the human changed unless they ask.
- Slide html_body must be a single <section class="slide">…</section>.
- lock_slide is an advisory 15-minute soft lock (a visual signal to humans); it does NOT reserve the slide or block others' proposals, so you generally don't need to lock before proposing.
- Undo: withdraw_proposal cancels a proposal that is still PENDING. A reviewer may approve at any time, so by the time you withdraw it may already be APPLIED — withdraw won't error in that case, it returns the edit_id with action_required: "revert_proposal". revert_proposal proposes restoring the slide's pre-change content (again pending human review). Don't hand-rebuild old content from memory to undo something; the version history has the exact bytes.
- Comments (add_comment / reply) and history (list_slide_versions, list_snapshots, create_snapshot) are available for collaboration and safe checkpoints.`;

type JsonRpcId = string | number | null;

type JsonRpcRequest = {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: unknown;
};

type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

export type DispatchOutcome =
  | { kind: "response"; body: JsonRpcResponse }
  | { kind: "notification" };

export async function dispatchMcp(
  raw: unknown,
  ctx: AuthContext,
): Promise<DispatchOutcome> {
  if (!raw || typeof raw !== "object" || (raw as JsonRpcRequest).jsonrpc !== "2.0") {
    return errorResponse(null, -32600, "Invalid Request");
  }
  const req = raw as JsonRpcRequest;
  const id = req.id ?? null;
  const isNotification = req.id === undefined || req.id === null;

  try {
    if (req.method === "initialize") {
      return ok(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {
          tools: { listChanged: false },
        },
        serverInfo: {
          name: SERVER_NAME,
          version: SERVER_VERSION,
        },
        instructions: INSTRUCTIONS,
      });
    }

    if (req.method === "ping") {
      return ok(id, {});
    }

    if (req.method.startsWith("notifications/")) {
      // Notifications never get a response.
      return { kind: "notification" };
    }

    if (req.method === "tools/list") {
      return ok(id, { tools: toolDescriptors });
    }

    if (req.method === "tools/call") {
      const params = (req.params ?? {}) as { name?: unknown; arguments?: unknown };
      const name = typeof params.name === "string" ? params.name : "";
      if (!name) return errorResponse(id, -32602, "Missing tool name");
      const fn = tools[name];
      if (!fn) return errorResponse(id, -32602, `Unknown tool: ${name}`);

      const started = Date.now();
      const args = params.arguments ?? {};
      try {
        if (isWriteTool(name)) {
          const allowed = await rateLimitOk(
            createAdminClient(),
            `mcp-write:${ctx.user_id}`,
            WRITE_LIMIT_PER_HOUR,
            3600,
          );
          if (!allowed) {
            throw new ExpectedError(
              "Too many changes proposed in the last hour. Get some approved or rejected first, then continue.",
            );
          }
        }
        const value = await fn(args, ctx);
        logUsage({
          event: "mcp.tool_call",
          surface: "mcp",
          user_id: ctx.user_id,
          workspace_id: ctx.workspace_id,
          deck_id: pickId(args, "deck_id"),
          slide_id: pickId(args, "slide_id"),
          duration_ms: Date.now() - started,
          status: "ok",
          props: { tool_name: name, ...mcpArgShape(name, args) },
        });
        // Most tools return a plain object we JSON-stringify into one text
        // block. A render tool instead returns the tagged __mcpContent shape so
        // it can emit MCP `image` content blocks (a base64 JPEG of the slide)
        // alongside text — pass those through verbatim per the MCP spec.
        const content = isMcpContentResult(value)
          ? value.__mcpContent
          : [{ type: "text", text: JSON.stringify(value, null, 2) }];
        return ok(id, { content, isError: false });
      } catch (err) {
        // Tool errors come back as a normal MCP response with isError: true so
        // Agent clients can show them. Reserve JSON-RPC error envelopes for
        // protocol-level failures (bad method, malformed request).
        //
        // Only ExpectedError messages (validation, authorization, not-found,
        // size caps — thrown on purpose by the tools) are safe to return to the
        // client. Everything else may be a raw Postgres error whose text leaks
        // table/column/constraint names, so we log it server-side and return a
        // generic message instead.
        const clientMessage =
          err instanceof ExpectedError
            ? err.message
            : "tool failed";
        if (!(err instanceof ExpectedError)) {
          console.error(`[mcp:tool] ${name} failed:`, err);
        }
        logUsage({
          event: "mcp.tool_call",
          surface: "mcp",
          user_id: ctx.user_id,
          workspace_id: ctx.workspace_id,
          deck_id: pickId(args, "deck_id"),
          slide_id: pickId(args, "slide_id"),
          duration_ms: Date.now() - started,
          status: "error",
          error: err,
          props: { tool_name: name, ...mcpArgShape(name, args) },
        });
        return ok(id, {
          content: [{ type: "text", text: clientMessage }],
          isError: true,
        });
      }
    }

    if (isNotification) return { kind: "notification" };
    return errorResponse(id, -32601, `Method not found: ${req.method}`);
  } catch (err) {
    if (isNotification) return { kind: "notification" };
    const message = err instanceof Error ? err.message : String(err);
    return errorResponse(id, -32603, `Internal error: ${message}`);
  }
}

function ok(id: JsonRpcId, result: unknown): DispatchOutcome {
  return { kind: "response", body: { jsonrpc: "2.0", id, result } };
}

function errorResponse(id: JsonRpcId, code: number, message: string): DispatchOutcome {
  return {
    kind: "response",
    body: { jsonrpc: "2.0", id, error: { code, message } },
  };
}

// Pull an id field out of the tool arguments for the usage event's
// deck_id / slide_id columns. Returns null if the argument is missing
// or not a uuid-shaped string.
function pickId(args: unknown, key: string): string | null {
  if (!args || typeof args !== "object") return null;
  const v = (args as Record<string, unknown>)[key];
  return typeof v === "string" && v.length > 0 ? v : null;
}

// Per-tool prop shape — IDs and sizes only, never content. Anything not
// listed here is dropped. The logger's `sanitizeProps` blocks the
// obvious content keys as a backstop; this allowlist keeps the table
// small and meaningfully queryable.
function mcpArgShape(toolName: string, args: unknown): Record<string, unknown> {
  if (!args || typeof args !== "object") return {};
  const a = args as Record<string, unknown>;
  const shape: Record<string, unknown> = {};

  // Size signals: how big was the proposed change?
  if (typeof a.html_body === "string") shape.html_body_len = a.html_body.length;
  if (typeof a.slide_styles === "string") shape.slide_styles_len = a.slide_styles.length;
  if (typeof a.theme_css === "string") shape.theme_css_len = a.theme_css.length;
  if (typeof a.nav_js === "string") shape.nav_js_len = a.nav_js.length;
  if (typeof a.body === "string") shape.body_len = a.body.length;

  // Patch signals: how many edits, and how small was the payload relative to
  // a whole-content proposal? (find/replace text itself is content — only
  // lengths are logged.)
  if (Array.isArray(a.edits)) {
    shape.edits_count = a.edits.length;
    shape.edits_chars = a.edits.reduce((sum: number, e: unknown) => {
      if (!e || typeof e !== "object") return sum;
      const { find, replace } = e as Record<string, unknown>;
      return (
        sum +
        (typeof find === "string" ? find.length : 0) +
        (typeof replace === "string" ? replace.length : 0)
      );
    }, 0);
  }

  // Positional / structural signals.
  if (typeof a.position === "number") shape.position = a.position;
  if (typeof a.base_version_no === "number") shape.base_version_no = a.base_version_no;
  if (typeof a.limit === "number") shape.limit = a.limit;
  if (typeof a.parent_id === "string") shape.has_parent = true;
  if (a.mentions && Array.isArray(a.mentions)) shape.mentions_count = a.mentions.length;

  // Optional auxiliary IDs that aren't deck_id/slide_id.
  for (const key of ["edit_id", "version_id", "snapshot_id", "comment_id"]) {
    if (typeof a[key] === "string") shape[key] = a[key];
  }

  // Cheap tool-specific extras.
  if (toolName === "propose_new_slide" || toolName === "propose_slide_edit") {
    if (typeof a.position === "number") shape.position = a.position;
  }

  return shape;
}

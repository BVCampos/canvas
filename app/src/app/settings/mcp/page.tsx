import Link from "next/link";
import { headers } from "next/headers";
import { getActiveWorkspace } from "@/lib/auth/workspace";
import { createClient } from "@/lib/supabase/server";
import {
  getOpenRouterConfigSummary,
  getWorkspaceOpenRouterConfigSummary,
} from "@/lib/canvas/assistant/openrouter-config";
import { McpTokenManager } from "./token-manager";
import { OpenRouterManager } from "./openrouter-manager";
import { WorkspaceOpenRouterManager } from "./workspace-openrouter-manager";

// /settings/mcp — provider-neutral agent connections. The URL stays stable for
// existing bookmarks while the setup flow works for any MCP-compatible agent
// plus the optional local Canvas chat bridge.

export default async function McpSettingsPage() {
  // user/workspaces are already rendered by the parent layout's Topbar; we
  // only need `user.id` and `workspace.id` here to scope the token queries.
  const { user, workspace, role } = await getActiveWorkspace("/settings/mcp");
  const supabase = await createClient();
  const canManageWorkspaceKey = role === "owner" || role === "admin";

  const [tokensResult, bridgeResult, openRouterConfig, workspaceOpenRouter] =
    await Promise.all([
    supabase
      .from("canvas_mcp_token")
      .select(
        "token, label, last_used_at, last_client_name, last_client_version, revoked_at, created_at, expires_at",
      )
      .eq("user_id", user.id)
      .eq("workspace_id", workspace.id)
      .order("created_at", { ascending: false }),
    supabase
      .from("canvas_assistant_bridge_presence")
      .select("last_seen_at, bridge_version, agent_provider")
      .eq("user_id", user.id)
      .maybeSingle(),
    getOpenRouterConfigSummary(user.id),
    canManageWorkspaceKey
      ? getWorkspaceOpenRouterConfigSummary(workspace.id)
      : Promise.resolve(null),
  ]);
  const tokensRaw = tokensResult.data;

  const tokens = (tokensRaw ?? []).map((t) => ({
    token: t.token as string,
    label: (t.label as string | null) ?? null,
    last_used_at: (t.last_used_at as string | null) ?? null,
    revoked_at: (t.revoked_at as string | null) ?? null,
    created_at: t.created_at as string,
    expires_at: (t.expires_at as string | null) ?? null,
    last_client_name: (t.last_client_name as string | null) ?? null,
    last_client_version: (t.last_client_version as string | null) ?? null,
  }));

  // Compute the absolute base URL from the incoming request so the copy-paste
  // snippet works on localhost (port 3001) and prod (canvas.21xventures.com)
  // alike.
  const reqHeaders = await headers();
  const host = reqHeaders.get("host") ?? "canvas.21xventures.com";
  const proto = reqHeaders.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  const baseUrl = `${proto}://${host}`;

  return (
    <>
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Connections</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Canvas has no built-in AI — it connects to an agent you run. Create
          an access token, add Canvas to Claude Code or Codex, and its edits
          arrive here as proposals you review. Tokens are scoped to{" "}
          <strong className="font-medium text-foreground">{workspace.name}</strong>
          .
        </p>
      </div>

      <McpTokenManager
        tokens={tokens}
        baseUrl={baseUrl}
        currentUserId={user.id}
        initialBridgePresence={
          bridgeResult.data
            ? {
                last_seen_at: bridgeResult.data.last_seen_at as string,
                bridge_version:
                  (bridgeResult.data.bridge_version as string | null) ?? null,
                agent_provider:
                  (bridgeResult.data.agent_provider as string | null) ?? null,
              }
            : null
        }
      />

      <div className="rounded-[12px] border border-border bg-card p-6 space-y-3">
        <div className="eyebrow">What connected agents can do</div>
        <ul className="space-y-1 text-sm text-muted-foreground">
          <li>• List decks and read their slides + shared theme.</li>
          <li>• Claim a slide so parallel agents and teammates do not collide.</li>
          <li>
            • Propose targeted patches, redesigns, new slides, and theme changes —
            creates a pending proposal; the slide owner reviews and approves
            before it ships.
          </li>
          <li>• Save named snapshots before risky edits.</li>
          <li>• Browse version history and read prior versions.</li>
        </ul>
      </div>

      {/* The hosted API key is the alternative path (hosted model instead of
          a local agent), so it lives collapsed below the core token flow —
          new users land on the token, not on an API-key form. */}
      <details className="group">
        <summary className="cursor-pointer list-none rounded-[12px] border border-border bg-card px-6 py-4 transition-colors hover:border-[color:var(--accent)]/40 [&::-webkit-details-marker]:hidden">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="eyebrow">Advanced · Hosted API runtime</div>
              <p className="mt-1 text-sm text-muted-foreground">
                Prefer not to run a local agent? Add an OpenRouter, Anthropic,
                or OpenAI API key and the in-deck Canvas chat runs on a hosted
                model instead. Keys are encrypted before storage and never
                returned to the browser.
              </p>
            </div>
            <span
              className="shrink-0 text-xs text-muted-foreground transition-transform group-open:rotate-180"
              aria-hidden
            >
              ▾
            </span>
          </div>
        </summary>
        <div className="mt-4 space-y-6">
          <OpenRouterManager initial={openRouterConfig} />

          {canManageWorkspaceKey && workspaceOpenRouter ? (
            <WorkspaceOpenRouterManager
              workspaceName={workspace.name}
              initial={workspaceOpenRouter}
            />
          ) : null}
        </div>
      </details>

      <div className="flex flex-wrap items-center justify-between gap-3 rounded-[12px] border border-border bg-card p-6">
        <p className="text-sm text-muted-foreground">
          <span className="font-medium text-foreground">Next:</span> open a deck
          and use{" "}
          <span className="font-medium text-foreground">
            Copy prompt for agent
          </span>{" "}
          (in the deck toolbar&apos;s More menu) to point an external agent at it,
          or use the Canvas chat directly.
        </p>
        <Link
          href="/canvases"
          className="shrink-0 text-sm font-medium text-[color:var(--accent)] hover:underline"
        >
          ← Back to decks
        </Link>
      </div>
    </>
  );
}

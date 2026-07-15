"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";

// Shared connect-an-agent UI, used by BOTH the Connections reveal panel
// (settings/mcp/token-manager.tsx) and the first-run connect module on the
// empty deck list (canvases/first-run-connect.tsx). One source of truth for
// the per-agent setup command and the live check line — the two surfaces must
// never drift on what command a given agent needs.

export type ExternalAgent = "codex" | "claude" | "other";

export function externalAgentDisplayName(agent: ExternalAgent): string {
  return agent === "codex"
    ? "Codex"
    : agent === "claude"
      ? "Claude Code"
      : "your MCP client";
}

export function buildExternalCommand(
  agent: ExternalAgent,
  baseUrl: string,
  token: string,
): string {
  const bearerUrl = `${baseUrl}/api/mcp`;
  return agent === "codex"
    ? `export CANVAS_MCP_TOKEN=${token}\ncodex mcp add canvas --url ${bearerUrl} --bearer-token-env-var CANVAS_MCP_TOKEN`
    : agent === "claude"
      ? `claude mcp add --scope user --transport http canvas ${baseUrl}/api/mcp/${token}`
      : `${bearerUrl}\nAuthorization: Bearer ${token}`;
}

// "Claude Code laptop" → claude tabs; "codex desktop" → codex tabs. Cheap
// personalization: the label the user just typed usually names the tool.
export function inferProviderFromLabel(
  label: string | null,
): "codex" | "claude" | null {
  if (!label) return null;
  if (/claude/i.test(label)) return "claude";
  if (/codex/i.test(label)) return "codex";
  return null;
}

/**
 * The terminal-setup block: agent tabs → install precondition → copyable
 * setup command → what-happens-next note → live connection check. The caller
 * owns the token (and the poll that discovers the first connection); this
 * component owns the presentation. Tab state is internal and seeds from
 * `defaultAgent`, so remount (key by token) re-applies label inference.
 */
export function ExternalAgentSetup({
  baseUrl,
  token,
  defaultAgent = "codex",
  connected,
  waitingCopy,
  connectedCopy,
}: {
  baseUrl: string;
  token: string;
  defaultAgent?: "codex" | "claude";
  connected: boolean;
  waitingCopy: string;
  connectedCopy: string;
}) {
  const [agent, setAgent] = useState<ExternalAgent>(defaultAgent);
  const [copied, setCopied] = useState(false);
  const command = buildExternalCommand(agent, baseUrl, token);
  const agentName = externalAgentDisplayName(agent);
  const copy = () => {
    void navigator.clipboard.writeText(command);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-1" aria-label="Choose MCP client">
        {(["codex", "claude", "other"] as const).map((a) => (
          <button
            key={a}
            type="button"
            aria-pressed={agent === a}
            onClick={() => setAgent(a)}
            className={`rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${
              agent === a
                ? "bg-foreground text-background"
                : "bg-muted text-muted-foreground hover:text-foreground"
            }`}
          >
            {a === "codex"
              ? "Codex"
              : a === "claude"
                ? "Claude Code"
                : "Other MCP client"}
          </button>
        ))}
      </div>
      {agent !== "other" ? (
        <p className="text-xs text-muted-foreground">
          Make sure {agentName} is installed and signed in, then run this once
          in your terminal:
        </p>
      ) : null}
      <CommandRow
        command={command}
        copied={copied}
        onCopy={copy}
        copyLabel={agent === "other" ? "Copy details" : "Copy command"}
      />
      {agent === "other" ? (
        <p className="text-[11px] text-muted-foreground">
          Use Streamable HTTP. Clients that support bearer authentication can
          call <code className="font-mono">{baseUrl}/api/mcp</code> with this
          token in the Authorization header.
        </p>
      ) : (
        <p className="text-[11px] text-muted-foreground">
          {/* One string, not interleaved JSX text runs — keeps the spaces
              around the agent name from ever collapsing. */}
          {`This adds Canvas to ${agentName}. Then open a new ${agentName} session and try “list my Canvas decks”.`}
        </p>
      )}
      <ConnectionCheck
        connected={connected}
        waitingCopy={waitingCopy}
        connectedCopy={connectedCopy}
      />
    </div>
  );
}

export function ConnectionCheck({
  connected,
  waitingCopy,
  connectedCopy,
}: {
  connected: boolean;
  waitingCopy: string;
  connectedCopy: string;
}) {
  return (
    <p
      role="status"
      className={`flex items-center gap-1.5 text-xs ${
        connected ? "font-medium text-success-fg" : "text-muted-foreground"
      }`}
    >
      <span
        aria-hidden
        className={`size-1.5 shrink-0 rounded-full ${
          connected ? "bg-success" : "animate-pulse bg-[color:var(--warning)]"
        }`}
      />
      {connected ? connectedCopy : waitingCopy}
    </p>
  );
}

export function CommandRow({
  command,
  copied,
  onCopy,
  copyLabel,
}: {
  command: string;
  copied: boolean;
  onCopy: () => void;
  copyLabel: string;
}) {
  return (
    <div className="flex flex-col gap-2 sm:flex-row">
      <code className="min-w-0 flex-1 overflow-x-auto rounded-[8px] border border-border bg-paper px-3 py-2 font-mono text-xs whitespace-nowrap">
        {command}
      </code>
      <Button type="button" variant="outline" onClick={onCopy}>
        {copied ? "Copied" : copyLabel}
      </Button>
    </div>
  );
}

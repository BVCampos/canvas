"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatDate, relativeDate } from "@/lib/utils";
import { isMcpTokenExpired } from "@/lib/canvas/mcp-token";
import { createClient } from "@/lib/supabase/client";
import { createMcpToken, revokeMcpToken, rotateMcpToken } from "./actions";

type TokenRow = {
  token: string;
  label: string | null;
  last_used_at: string | null;
  revoked_at: string | null;
  created_at: string;
  expires_at: string | null;
  last_client_name: string | null;
  last_client_version: string | null;
};

type BridgePresence = {
  last_seen_at: string;
  bridge_version: string | null;
  agent_provider: string | null;
};

export function McpTokenManager({
  tokens,
  baseUrl,
  currentUserId,
  initialBridgePresence,
}: {
  tokens: TokenRow[];
  baseUrl: string;
  currentUserId: string;
  initialBridgePresence: BridgePresence | null;
}) {
  const [label, setLabel] = useState("");
  const [justCreated, setJustCreated] = useState<{ token: string; label: string | null } | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [bridgePresence, setBridgePresence] = useState(initialBridgePresence);
  const [now, setNow] = useState(() => Date.now());
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    const tick = window.setInterval(() => setNow(Date.now()), 4000);
    const supabase = createClient();
    const channel = supabase
      .channel(`connections-bridge:${currentUserId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "canvas_assistant_bridge_presence",
          filter: `user_id=eq.${currentUserId}`,
        },
        (payload) => {
          if (payload.eventType === "DELETE") {
            setBridgePresence(null);
            return;
          }
          const row = payload.new as BridgePresence;
          setBridgePresence({
            last_seen_at: row.last_seen_at,
            bridge_version: row.bridge_version ?? null,
            agent_provider: row.agent_provider ?? null,
          });
        },
      )
      .subscribe();
    return () => {
      window.clearInterval(tick);
      supabase.removeChannel(channel);
    };
  }, [currentUserId]);

  const handleCreate = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      const result = await createMcpToken(label);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setJustCreated({ token: result.token, label: result.label });
      setLabel("");
    });
  };

  const handleRevoke = (token: string) => {
    startTransition(async () => {
      const result = await revokeMcpToken(token);
      if (!result.ok) setError(result.error ?? "revoke_failed");
    });
  };

  const handleRotate = (token: string) => {
    setError(null);
    startTransition(async () => {
      const result = await rotateMcpToken(token);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      // Reveal the replacement once, exactly like a fresh create.
      setJustCreated({ token: result.token, label: result.label });
    });
  };

  const liveTokens = tokens.filter((t) => !t.revoked_at);
  const usableTokens = liveTokens.filter((t) => !isMcpTokenExpired(t.expires_at));
  const revokedTokens = tokens.filter((t) => t.revoked_at);
  const latestConnectedToken = usableTokens.find((t) => t.last_used_at) ?? null;
  const bridgeOnline = Boolean(
    bridgePresence &&
      now - new Date(bridgePresence.last_seen_at).getTime() < 10_000,
  );

  return (
    <div className="space-y-6">
      <ConnectionOverview
        token={latestConnectedToken}
        hasToken={usableTokens.length > 0}
        bridgePresence={bridgePresence}
        bridgeOnline={bridgeOnline}
      />

      <form
        onSubmit={handleCreate}
        className="rounded-[12px] border border-border bg-card p-6 space-y-4"
      >
        <div className="eyebrow">Create an access token</div>
        {/* Stack the label input above the Create button on mobile so neither
            gets squeezed; inline row from sm+ as before. */}
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            placeholder="Where you will use it (e.g. 'Codex laptop')"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />
          <Button type="submit" disabled={isPending} className="w-full sm:w-auto">
            Create token
          </Button>
        </div>
        {error ? (
          <p className="text-xs text-[color:var(--danger)]">{error}</p>
        ) : null}
      </form>

      {justCreated ? (
        <RevealPanel
          token={justCreated.token}
          label={justCreated.label}
          baseUrl={baseUrl}
          onDismiss={() => setJustCreated(null)}
        />
      ) : null}

      <div className="rounded-[12px] border border-border bg-card">
        <div className="border-b border-border px-5 py-3">
          <div className="eyebrow">Access tokens</div>
        </div>
        {liveTokens.length === 0 ? (
          <div className="px-5 py-6 text-sm text-muted-foreground">
            No active tokens yet.
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {liveTokens.map((t) => (
              // Let the revoke control wrap under the token meta on mobile so
              // the armed "Revoke? / Confirm / Cancel" cluster never collides
              // with the label; inline row from sm+.
              <li
                key={t.token}
                className="flex flex-col items-start gap-2 px-5 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4"
              >
                <div className="min-w-0 self-stretch">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium text-foreground">
                      {t.label ?? "Unlabeled token"}
                    </span>
                    {/* Connection state at a glance — the install moment is the
                        riskiest onboarding step. last_used_at being set means
                        An agent has successfully called Canvas with this token. */}
                    <span
                      className="inline-flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground"
                      title={
                        t.last_used_at
                          ? `${t.last_client_name || "An MCP agent"} connected with this token`
                          : "No connection seen yet — add Canvas to an MCP-compatible agent or start the local bridge"
                      }
                    >
                      <span
                        aria-hidden
                        className={`size-1.5 rounded-full ${
                          t.last_used_at ? "bg-success" : "bg-muted-foreground/40"
                        }`}
                      />
                      {t.last_used_at
                        ? `${t.last_client_name || "Agent"} connected`
                        : "Not connected yet"}
                    </span>
                  </div>
                  <div className="mt-0.5 font-mono text-[11px] text-muted-foreground">
                    {maskToken(t.token)}
                  </div>
                  {/* suppressHydrationWarning: formatDate/relativeDate are
                      timezone- and now-relative, so the server (UTC) and the
                      client (local TZ) can render different text — that's
                      expected here, not a real mismatch. Without this, React
                      logs hydration error #418. */}
                  <div
                    className="mt-0.5 text-[11px] text-muted-foreground"
                    suppressHydrationWarning
                  >
                    Created {formatDate(t.created_at)} ·{" "}
                    {t.last_used_at ? `Last used ${relativeDate(t.last_used_at)}` : "Never used"}
                  </div>
                  {t.expires_at ? (
                    <div
                      className={`mt-0.5 text-[11px] ${
                        isMcpTokenExpired(t.expires_at)
                          ? "text-[color:var(--danger)]"
                          : "text-muted-foreground"
                      }`}
                      suppressHydrationWarning
                    >
                      {isMcpTokenExpired(t.expires_at)
                        ? "Expired — rotate or revoke"
                        : `Expires ${formatDate(t.expires_at)}`}
                    </div>
                  ) : null}
                </div>
                {/* self-end right-aligns the revoke control on its own line on
                    mobile; shrink-0 keeps it intact inline at sm+. */}
                <div className="flex shrink-0 items-center gap-1 self-end sm:self-auto">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={isPending}
                    onClick={() => handleRotate(t.token)}
                    title="Mint a replacement and revoke this one"
                  >
                    Rotate
                  </Button>
                  <RevokeControl
                    disabled={isPending}
                    onConfirm={() => handleRevoke(t.token)}
                  />
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {revokedTokens.length > 0 ? (
        <details className="rounded-[12px] border border-border bg-card">
          <summary className="cursor-pointer px-5 py-3 text-xs uppercase tracking-[0.08em] text-muted-foreground">
            Revoked ({revokedTokens.length})
          </summary>
          <ul className="divide-y divide-border">
            {revokedTokens.map((t) => (
              <li key={t.token} className="px-5 py-3 text-xs text-muted-foreground">
                <div className="font-mono">{maskToken(t.token)}</div>
                <div suppressHydrationWarning>
                  {t.label ?? "—"} · revoked {relativeDate(t.revoked_at!)}
                </div>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

function ConnectionOverview({
  token,
  hasToken,
  bridgePresence,
  bridgeOnline,
}: {
  token: TokenRow | null;
  hasToken: boolean;
  bridgePresence: BridgePresence | null;
  bridgeOnline: boolean;
}) {
  const provider = bridgePresence?.agent_provider
    ? providerLabel(bridgePresence.agent_provider)
    : "Local agent";
  return (
    <section className="grid gap-3 sm:grid-cols-2" aria-label="Connection status">
      <div className="rounded-[12px] border border-border bg-card p-5">
        <div className="flex items-center justify-between gap-3">
          <div className="eyebrow">External agent</div>
          <StatusPill
            active={Boolean(token)}
            activeLabel="Seen"
            inactiveLabel="Not seen"
          />
        </div>
        <p className="mt-2 text-sm font-medium text-foreground">
          {token
            ? `${token.last_client_name || "MCP client"} connected`
            : hasToken
              ? "Waiting for first connection"
              : "Not configured"}
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          {token?.last_used_at
            ? `Last used ${relativeDate(token.last_used_at)}${
                token.last_client_version ? ` · v${token.last_client_version}` : ""
              }`
            : "Works with Codex, Claude Code, and any streamable-HTTP MCP client."}
        </p>
      </div>

      <div className="rounded-[12px] border border-border bg-card p-5">
        <div className="flex items-center justify-between gap-3">
          <div className="eyebrow">Local chat bridge</div>
          <StatusPill
            active={bridgeOnline}
            activeLabel="Online"
            inactiveLabel="Offline"
          />
        </div>
        <p className="mt-2 text-sm font-medium text-foreground">
          {bridgeOnline ? `${provider} online` : "Local agent offline"}
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          {bridgePresence
            ? `Last seen ${relativeDate(bridgePresence.last_seen_at)}${
                bridgePresence.bridge_version
                  ? ` · bridge v${bridgePresence.bridge_version}`
                  : ""
              }`
            : "Run canvas-agent with your preferred provider to use the in-deck chat."}
        </p>
      </div>
    </section>
  );
}

function StatusPill({
  active,
  activeLabel,
  inactiveLabel,
}: {
  active: boolean;
  activeLabel: string;
  inactiveLabel: string;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2 py-1 text-[10px] font-semibold uppercase tracking-wide ${
        active
          ? "bg-success/15 text-success-fg"
          : "bg-muted text-muted-foreground"
      }`}
    >
      <span
        aria-hidden
        className={`h-1.5 w-1.5 rounded-full ${active ? "bg-success" : "bg-muted-foreground/40"}`}
      />
      {active ? activeLabel : inactiveLabel}
    </span>
  );
}

function providerLabel(provider: string): string {
  switch (provider.toLowerCase()) {
    case "codex":
      return "Codex";
    case "claude":
      return "Claude Code";
    default:
      return provider;
  }
}

function RevealPanel({
  token,
  label,
  baseUrl,
  onDismiss,
}: {
  token: string;
  label: string | null;
  baseUrl: string;
  onDismiss: () => void;
}) {
  const fullUrl = `${baseUrl}/api/mcp/${token}`;
  const bearerUrl = `${baseUrl}/api/mcp`;
  const [externalAgent, setExternalAgent] = useState<
    "codex" | "claude" | "other"
  >("codex");
  const [bridgeProvider, setBridgeProvider] = useState<"codex" | "claude">(
    "codex",
  );
  const externalCommand =
    externalAgent === "codex"
      ? `export CANVAS_MCP_TOKEN=${token}\ncodex mcp add canvas --url ${bearerUrl} --bearer-token-env-var CANVAS_MCP_TOKEN`
      : externalAgent === "claude"
        ? `claude mcp add --scope user --transport http canvas ${fullUrl}`
        : `${bearerUrl}\nAuthorization: Bearer ${token}`;
  const bridgeCommand = `CANVAS_AGENT_PROVIDER=${bridgeProvider} CANVAS_MCP_TOKEN=${token} CANVAS_URL=${baseUrl} npx @21xventures/canvas-agent`;

  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const copy = (key: string, text: string) => {
    void navigator.clipboard.writeText(text);
    setCopiedKey(key);
    window.setTimeout(() => {
      setCopiedKey((current) => (current === key ? null : current));
    }, 1800);
  };

  return (
    <div className="rounded-[12px] border border-[color:var(--accent)]/40 bg-[color:var(--accent-wash)] p-6 space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="eyebrow text-[color:var(--accent-dim)]">
            Token created{label ? ` · ${label}` : ""}
          </div>
          <p className="mt-1 text-sm text-foreground">
            Choose how you want to work. This is the only time Canvas shows the
            full token; after you close this panel, only its masked prefix remains.
          </p>
        </div>
        <button
          type="button"
          onClick={onDismiss}
          className="text-xs text-muted-foreground hover:text-foreground"
          aria-label="Close"
        >
          ✕
        </button>
      </div>

      <div className="space-y-3 rounded-[10px] border border-border bg-card/70 p-4">
        <div>
          <div className="eyebrow">Use an external agent</div>
          <p className="mt-1 text-xs text-muted-foreground">
            Add Canvas as an MCP server in the agent you already use.
          </p>
        </div>
        <div className="flex flex-wrap gap-1" aria-label="Choose MCP client">
          {(["codex", "claude", "other"] as const).map((agent) => (
            <button
              key={agent}
              type="button"
              aria-pressed={externalAgent === agent}
              onClick={() => setExternalAgent(agent)}
              className={`rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${
                externalAgent === agent
                  ? "bg-foreground text-background"
                  : "bg-muted text-muted-foreground hover:text-foreground"
              }`}
            >
              {agent === "codex"
                ? "Codex"
                : agent === "claude"
                  ? "Claude Code"
                  : "Other MCP client"}
            </button>
          ))}
        </div>
        <CommandRow
          command={externalCommand}
          copied={copiedKey === "external"}
          onCopy={() => copy("external", externalCommand)}
          copyLabel={externalAgent === "other" ? "Copy details" : "Copy command"}
        />
        {externalAgent === "other" ? (
          <p className="text-[11px] text-muted-foreground">
            Use Streamable HTTP. Clients that support bearer authentication can
            call <code className="font-mono">{baseUrl}/api/mcp</code> with this
            token in the Authorization header.
          </p>
        ) : null}
      </div>

      <div className="space-y-3 rounded-[10px] border border-border bg-card/70 p-4">
        <div>
          <div className="eyebrow">Use the Canvas chat</div>
          <p className="mt-1 text-xs text-muted-foreground">
            Run the local bridge with Codex or Claude Code. It can use Canvas
            tools only and never sends your provider credential to Canvas.
          </p>
        </div>
        <div className="flex gap-1" aria-label="Choose local agent provider">
          {(["codex", "claude"] as const).map((provider) => (
            <button
              key={provider}
              type="button"
              aria-pressed={bridgeProvider === provider}
              onClick={() => setBridgeProvider(provider)}
              className={`rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${
                bridgeProvider === provider
                  ? "bg-foreground text-background"
                  : "bg-muted text-muted-foreground hover:text-foreground"
              }`}
            >
              {provider === "codex" ? "Codex" : "Claude Code"}
            </button>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">
          Make sure <code className="font-mono">{bridgeProvider}</code> is
          installed and signed in locally, then leave this command running.
        </p>
        <CommandRow
          command={bridgeCommand}
          copied={copiedKey === "bridge"}
          onCopy={() => copy("bridge", bridgeCommand)}
          copyLabel="Copy command"
        />
      </div>
    </div>
  );
}

function CommandRow({
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

function RevokeControl({
  disabled,
  onConfirm,
}: {
  disabled: boolean;
  onConfirm: () => void;
}) {
  const [armed, setArmed] = useState(false);
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!armed) return;
    confirmRef.current?.focus();
    const timer = window.setTimeout(() => setArmed(false), 4000);
    return () => window.clearTimeout(timer);
  }, [armed]);

  if (!armed) {
    return (
      <Button
        type="button"
        variant="ghost"
        className="text-[color:var(--danger)] hover:bg-[color:var(--danger)]/10"
        disabled={disabled}
        onClick={() => setArmed(true)}
      >
        Revoke
      </Button>
    );
  }

  return (
    <div className="flex items-center gap-1.5">
      <span className="text-xs text-muted-foreground">Revoke?</span>
      <Button
        ref={confirmRef}
        type="button"
        size="sm"
        variant="ghost"
        className="bg-[color:var(--danger)]/10 text-[color:var(--danger)] hover:bg-[color:var(--danger)]/20"
        disabled={disabled}
        onClick={() => {
          setArmed(false);
          onConfirm();
        }}
      >
        Confirm
      </Button>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        disabled={disabled}
        onClick={() => setArmed(false)}
      >
        Cancel
      </Button>
    </div>
  );
}

function maskToken(token: string): string {
  // mcp_ABC...XYZ — keep the prefix and the last 4 chars; mask the middle.
  if (token.length < 12) return token;
  return `${token.slice(0, 8)}…${token.slice(-4)}`;
}

"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatDate, relativeDate } from "@/lib/utils";
import { isMcpTokenExpired } from "@/lib/canvas/mcp-token";
import { createClient } from "@/lib/supabase/client";
import {
  CommandRow,
  ConnectionCheck,
  ExternalAgentSetup,
  inferProviderFromLabel,
} from "@/components/mcp-connect";
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
  // First successful call made with the just-created token — polled below so
  // the reveal panel can flip from "waiting" to "connected" while the user
  // still has the setup command on screen.
  const [firstConnection, setFirstConnection] = useState<{
    token: string;
    at: string;
    client: string | null;
  } | null>(null);
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

  // While the reveal panel is open and the token hasn't been used yet, poll
  // its row (RLS scopes reads to the owner) so the "waiting for the first
  // connection" line turns green on its own — the confirmation moment the
  // install step otherwise lacks. Stops as soon as a connection is seen.
  useEffect(() => {
    if (!justCreated) return;
    const supabase = createClient();
    let cancelled = false;
    const check = async () => {
      const { data } = await supabase
        .from("canvas_mcp_token")
        .select("last_used_at, last_client_name")
        .eq("token", justCreated.token)
        .maybeSingle();
      if (cancelled || !data?.last_used_at) return;
      setFirstConnection({
        token: justCreated.token,
        at: data.last_used_at as string,
        client: (data.last_client_name as string | null) ?? null,
      });
      window.clearInterval(interval);
    };
    const interval = window.setInterval(() => void check(), 4000);
    void check();
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [justCreated]);

  const handleCreate = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      const result = await createMcpToken(label);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setFirstConnection(null);
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
      setFirstConnection(null);
      setJustCreated({ token: result.token, label: result.label });
    });
  };

  // The reveal-panel poll flips `firstConnection` the moment the just-created
  // token is first used, but the server-rendered `tokens` prop still says
  // "Not connected yet". Fold that first connection into the token it belongs
  // to so the token rows AND the ConnectionOverview below reflect it too — a
  // pure render-time derivation, no reload and no extra state. Keyed on the
  // token stamped INTO firstConnection (not justCreated) so the flipped state
  // survives the reveal panel being dismissed.
  const displayTokens = tokens.map((t) =>
    firstConnection && t.token === firstConnection.token
      ? {
          ...t,
          last_used_at: firstConnection.at,
          last_client_name: firstConnection.client,
        }
      : t,
  );
  const liveTokens = displayTokens.filter((t) => !t.revoked_at);
  const usableTokens = liveTokens.filter((t) => !isMcpTokenExpired(t.expires_at));
  const revokedTokens = displayTokens.filter((t) => t.revoked_at);
  const latestConnectedToken = usableTokens.find((t) => t.last_used_at) ?? null;
  const bridgeOnline = Boolean(
    bridgePresence &&
      now - new Date(bridgePresence.last_seen_at).getTime() < 10_000,
  );

  return (
    <div className="space-y-6">
      {/* The create form leads: minting a token is the first thing a new user
          must do, so it sits above the status cards (which read "not
          configured" until the setup below has happened). */}
      <form
        onSubmit={handleCreate}
        className="rounded-[12px] border border-border bg-card p-6 space-y-4"
      >
        <div>
          <div className="eyebrow">Create an access token</div>
          <p className="mt-1 text-sm text-muted-foreground">
            Your agent signs in to Canvas with a personal token. Create one,
            then copy the setup command it unlocks.
          </p>
        </div>
        {/* Stack the label input above the Create button on mobile so neither
            gets squeezed; inline row from sm+ as before. */}
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            placeholder="Where you will use it (e.g. 'Claude Code laptop')"
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
          key={justCreated.token}
          token={justCreated.token}
          label={justCreated.label}
          baseUrl={baseUrl}
          firstConnection={firstConnection}
          bridgeOnline={bridgeOnline}
          onDismiss={() => setJustCreated(null)}
        />
      ) : null}

      <ConnectionOverview
        token={latestConnectedToken}
        hasToken={usableTokens.length > 0}
        bridgePresence={bridgePresence}
        bridgeOnline={bridgeOnline}
      />

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
                  {/* Closing the reveal panel before copying the command is a
                      dead end otherwise — the full token is already client-side
                      (masking is display-only), so re-opening the panel exposes
                      nothing new. Only offered while the token has never
                      connected and is still usable; once used, the setup step
                      is done and the row falls back to Rotate/Revoke. */}
                  {!t.last_used_at &&
                  !isMcpTokenExpired(t.expires_at) &&
                  justCreated?.token !== t.token ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={isPending}
                      onClick={() => {
                        setError(null);
                        setFirstConnection(null);
                        setJustCreated({ token: t.token, label: t.label });
                      }}
                      title="Show the setup command for this token again"
                    >
                      Show setup command
                    </Button>
                  ) : null}
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
          <div className="eyebrow">Terminal agent</div>
          <StatusPill
            active={Boolean(token)}
            activeLabel="Connected"
            inactiveLabel="Not connected"
          />
        </div>
        <p className="mt-2 text-sm font-medium text-foreground">
          {token
            ? `${token.last_client_name || "MCP client"} connected`
            : hasToken
              ? "Waiting for first connection"
              : "No token yet — create one above"}
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          {token?.last_used_at
            ? `Last used ${relativeDate(token.last_used_at)}${
                token.last_client_version ? ` · v${token.last_client_version}` : ""
              }`
            : "Works with Claude Code, Codex, and any compatible AI agent."}
        </p>
      </div>

      <div className="rounded-[12px] border border-border bg-card p-5">
        <div className="flex items-center justify-between gap-3">
          <div className="eyebrow">Canvas chat</div>
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
            : "Powers the in-deck Ask-agent panel — start it from a token above."}
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
  firstConnection,
  bridgeOnline,
  onDismiss,
}: {
  token: string;
  label: string | null;
  baseUrl: string;
  firstConnection: { at: string; client: string | null } | null;
  bridgeOnline: boolean;
  onDismiss: () => void;
}) {
  const inferred = inferProviderFromLabel(label);
  const [bridgeProvider, setBridgeProvider] = useState<"codex" | "claude">(
    inferred ?? "codex",
  );
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
            One setup step left. Keep it secret — anyone with it can act as you.
            You can reopen this setup panel from the token list until the token
            first connects.
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

      <div className="space-y-3 rounded-[10px] border border-[color:var(--accent)]/30 bg-card/70 p-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <div className="eyebrow">Work from your terminal</div>
            <p className="mt-1 text-xs text-muted-foreground">
              Drive Canvas from the coding agent you already use — ask for
              edits in your terminal, review and approve them here.
            </p>
          </div>
          <span className="shrink-0 rounded-full bg-[color:var(--accent)]/10 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide text-[color:var(--accent-dim)]">
            Most people start here
          </span>
        </div>
        <ExternalAgentSetup
          baseUrl={baseUrl}
          token={token}
          defaultAgent={inferred ?? "codex"}
          connected={Boolean(firstConnection)}
          waitingCopy="Waiting for the first connection — this flips green on its own once your agent calls Canvas."
          connectedCopy={`${firstConnection?.client || "Your agent"} connected — you're set. Open a deck and ask it for an edit.`}
        />
      </div>

      {/* The bridge is the secondary path (it powers the in-deck chat panel),
          so it starts collapsed — two open blocks that both name Codex and
          Claude Code read as an unanswerable either/or. */}
      <details className="group rounded-[10px] border border-border bg-card/70">
        <summary className="cursor-pointer list-none space-y-1 p-4 [&::-webkit-details-marker]:hidden">
          <div className="flex items-center justify-between gap-3">
            <div className="eyebrow">Chat inside Canvas instead</div>
            <span
              className="shrink-0 text-xs text-muted-foreground transition-transform group-open:rotate-180"
              aria-hidden
            >
              ▾
            </span>
          </div>
          <p className="text-xs text-muted-foreground">
            Prefer not to switch to a terminal? Run a small helper on your
            machine and the Ask-agent panel inside each deck can draft edits.
            It uses Canvas tools only and never sends your provider credential
            to Canvas.
          </p>
        </summary>
        <div className="space-y-3 px-4 pb-4">
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
            Make sure{" "}
            {bridgeProvider === "codex" ? "Codex" : "Claude Code"} is installed
            and signed in locally, then leave this command running:
          </p>
          <CommandRow
            command={bridgeCommand}
            copied={copiedKey === "bridge"}
            onCopy={() => copy("bridge", bridgeCommand)}
            copyLabel="Copy command"
          />
          <ConnectionCheck
            connected={bridgeOnline}
            waitingCopy="Waiting for the bridge — leave the command running; this flips green when it comes online."
            connectedCopy="Bridge online — open a deck and use the Ask-agent panel."
          />
        </div>
      </details>
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

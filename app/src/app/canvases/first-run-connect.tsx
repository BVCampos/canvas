"use client";

import { useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { createClient } from "@/lib/supabase/client";
import { ExternalAgentSetup } from "@/components/mcp-connect";
import { createMcpToken } from "@/app/settings/mcp/actions";

// Inline connect module for the first-run screen: the empty deck list is
// where a new user actually stands, so the connect step happens HERE — mint
// the token, show the setup command, watch the live check flip — with no
// detour through Settings. Shares ExternalAgentSetup with the Connections
// reveal panel so the two surfaces can't drift on the setup command.
export function FirstRunConnect({ baseUrl }: { baseUrl: string }) {
  const router = useRouter();
  const [created, setCreated] = useState<{ token: string } | null>(null);
  const [connected, setConnected] = useState<{ client: string | null } | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const handleCreate = () => {
    setError(null);
    startTransition(async () => {
      // The label surfaces later on the Connections token list — name the
      // moment, not the tool (the user picks their agent on the next step).
      const result = await createMcpToken("First agent");
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setCreated({ token: result.token });
    });
  };

  // Same poll as the Connections reveal panel: the token row is owner-scoped
  // under RLS, so watch last_used_at until the agent's first call lands.
  useEffect(() => {
    if (!created || connected) return;
    const supabase = createClient();
    let cancelled = false;
    const check = async () => {
      const { data } = await supabase
        .from("canvas_mcp_token")
        .select("last_used_at, last_client_name")
        .eq("token", created.token)
        .maybeSingle();
      if (cancelled || !data?.last_used_at) return;
      setConnected({
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
  }, [created, connected]);

  // Once connected, let the green line land, then refresh the server render:
  // the step-1 card flips to ✓ Connected, the topbar pill relaxes, and this
  // module unmounts (the page stops rendering it once agentConnected).
  useEffect(() => {
    if (!connected) return;
    const timer = window.setTimeout(() => router.refresh(), 2500);
    return () => window.clearTimeout(timer);
  }, [connected, router]);

  return (
    <div className="mx-auto mt-8 max-w-3xl space-y-3 rounded-[12px] border border-[color:var(--accent)]/40 bg-[color:var(--accent-wash)] p-5 text-left">
      {!created ? (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="eyebrow text-[color:var(--accent-dim)]">
                Start here · about a minute
              </div>
              <p className="mt-1 text-sm text-foreground">
                Connect the coding agent you already use — Canvas gives you one
                command to paste into your terminal.
              </p>
            </div>
            <Button type="button" onClick={handleCreate} disabled={isPending}>
              {isPending ? "Creating…" : "Get my setup command"}
            </Button>
          </div>
          {error ? <p className="text-xs text-destructive">{error}</p> : null}
          <p className="text-[11px] text-muted-foreground">
            This creates a personal access token — your agent signs in to
            Canvas with it. Prefer chatting inside Canvas, or other options?{" "}
            <Link
              href="/settings/mcp"
              className="font-medium text-[color:var(--accent)] hover:underline"
            >
              Open Connections
            </Link>
            .
          </p>
        </>
      ) : (
        <>
          <div className="eyebrow text-[color:var(--accent-dim)]">
            One step left
          </div>
          <ExternalAgentSetup
            baseUrl={baseUrl}
            token={created.token}
            connected={Boolean(connected)}
            waitingCopy="Waiting for the first connection — run the command, then this flips green on its own."
            connectedCopy={`${connected?.client || "Your agent"} connected — you're set. Next: create a deck and ask it for edits.`}
          />
          <p className="text-[11px] text-muted-foreground">
            Manage tokens, Canvas chat, and other options in{" "}
            <Link
              href="/settings/mcp"
              className="font-medium text-[color:var(--accent)] hover:underline"
            >
              Connections
            </Link>
            .
          </p>
        </>
      )}
    </div>
  );
}

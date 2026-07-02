"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { Eye, EyeOff, Users, ShieldCheck, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { relativeDate } from "@/lib/utils";
import {
  deleteWorkspaceOpenRouterSettings,
  saveWorkspaceOpenRouterSettings,
} from "./actions";

export type WorkspaceOpenRouterView = {
  configured: boolean;
  encryptionReady: boolean;
  keyHint: string | null;
  modelId: string;
  validatedAt: string | null;
};

function friendlyError(code: string): string {
  switch (code) {
    case "forbidden":
      return "Only a workspace owner or admin can set the shared key.";
    case "encryption_unavailable":
      return "The server encryption key is not configured yet.";
    case "key_required":
      return "Add an OpenRouter API key first.";
    case "invalid_key":
      return "OpenRouter rejected that API key.";
    case "invalid_model":
      return "Use an OpenRouter model slug such as openrouter/auto.";
    case "model_not_capable":
      return "That model must support tool calling for Canvas. Text-only models are fine: renders are inspected via the vision relay.";
    case "openrouter_unavailable":
      return "OpenRouter could not be reached. Try again in a moment.";
    default:
      return "The workspace OpenRouter key could not be saved.";
  }
}

export function WorkspaceOpenRouterManager({
  workspaceName,
  initial,
}: {
  workspaceName: string;
  initial: WorkspaceOpenRouterView;
}) {
  const [config, setConfig] = useState(initial);
  const [apiKey, setApiKey] = useState("");
  const [modelId, setModelId] = useState(initial.modelId);
  const [showKey, setShowKey] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [isPending, startTransition] = useTransition();

  const save = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    setSaved(false);
    startTransition(async () => {
      const result = await saveWorkspaceOpenRouterSettings({ apiKey, modelId });
      if (!result.ok) {
        setError(friendlyError(result.error));
        return;
      }
      setConfig(result.config);
      setModelId(result.config.modelId);
      setApiKey("");
      setSaved(true);
    });
  };

  const remove = () => {
    setError(null);
    setSaved(false);
    startTransition(async () => {
      const result = await deleteWorkspaceOpenRouterSettings();
      if (!result.ok) {
        setError("The workspace OpenRouter key could not be removed.");
        return;
      }
      setConfig({
        configured: false,
        encryptionReady: config.encryptionReady,
        keyHint: null,
        modelId: "openrouter/auto",
        validatedAt: null,
      });
      setModelId("openrouter/auto");
      setApiKey("");
    });
  };

  return (
    <section
      className="rounded-[12px] border border-border bg-card"
      aria-labelledby="workspace-openrouter-heading"
    >
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-5 py-4">
        <div className="flex min-w-0 items-start gap-3">
          <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-[9px] bg-[color:var(--accent-wash)] text-[color:var(--accent)]">
            <Users aria-hidden className="size-4" />
          </span>
          <div>
            <h2
              id="workspace-openrouter-heading"
              className="text-sm font-semibold text-foreground"
            >
              Workspace OpenRouter key
            </h2>
            <p className="mt-0.5 max-w-2xl text-xs leading-relaxed text-muted-foreground">
              A shared key every member of{" "}
              <strong className="font-medium text-foreground">{workspaceName}</strong>{" "}
              can use for Canvas chat. A member&apos;s own key always takes
              precedence; this is the fallback. All shared usage bills this key.
            </p>
          </div>
        </div>
        <span className="inline-flex items-center gap-1.5 rounded-full border border-border px-2.5 py-1 text-[11px] font-medium text-muted-foreground">
          <span
            aria-hidden
            className={`size-1.5 rounded-full ${
              config.configured && config.encryptionReady
                ? "bg-success"
                : "bg-muted-foreground/40"
            }`}
          />
          {config.configured && config.encryptionReady ? "Shared key set" : "Not set"}
        </span>
      </div>

      <form onSubmit={save} className="space-y-5 p-5">
        {!config.encryptionReady ? (
          <div className="rounded-[9px] border border-[color:var(--danger)]/35 bg-[color:var(--danger)]/10 px-3 py-2 text-xs leading-relaxed text-foreground">
            Add <code className="font-mono">CANVAS_CREDENTIAL_ENCRYPTION_KEY</code>{" "}
            to the server environment before saving a workspace key.
          </div>
        ) : null}

        <div className="grid gap-4 lg:grid-cols-2">
          <label className="space-y-1.5">
            <span className="text-xs font-medium text-foreground">API key</span>
            <span className="relative block">
              <Input
                type={showKey ? "text" : "password"}
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
                autoComplete="off"
                spellCheck={false}
                placeholder={
                  config.configured
                    ? `Shared key ${config.keyHint ?? "saved"} — leave blank to keep it`
                    : "sk-or-v1-…"
                }
                disabled={!config.encryptionReady || isPending}
                className="pr-10 font-mono"
              />
              <button
                type="button"
                onClick={() => setShowKey((value) => !value)}
                disabled={!apiKey}
                className="absolute inset-y-0 right-0 flex w-10 items-center justify-center text-muted-foreground hover:text-foreground disabled:opacity-35"
                aria-label={showKey ? "Hide API key" : "Show API key"}
              >
                {showKey ? (
                  <EyeOff aria-hidden className="size-4" />
                ) : (
                  <Eye aria-hidden className="size-4" />
                )}
              </button>
            </span>
            <span className="block text-[11px] text-muted-foreground">
              Create or revoke keys in{" "}
              <Link
                href="https://openrouter.ai/settings/keys"
                target="_blank"
                rel="noreferrer"
                className="text-[color:var(--accent)] hover:underline"
              >
                OpenRouter
              </Link>
              . The full key is never shown again after save.
            </span>
          </label>

          <label className="space-y-1.5">
            <span className="text-xs font-medium text-foreground">Model</span>
            <Input
              value={modelId}
              onChange={(event) => setModelId(event.target.value)}
              placeholder="openrouter/auto"
              disabled={!config.encryptionReady || isPending}
              spellCheck={false}
              className="font-mono"
            />
            <span className="block text-[11px] text-muted-foreground">
              <code className="font-mono">openrouter/auto</code> is recommended.
              Custom models must support tools and image input.
            </span>
          </label>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
          <div className="min-h-5 text-xs">
            {error ? (
              <span className="text-[color:var(--danger)]">{error}</span>
            ) : saved ? (
              <span className="inline-flex items-center gap-1.5 text-success">
                <ShieldCheck aria-hidden className="size-3.5" />
                Workspace key validated, encrypted, and saved.
              </span>
            ) : config.validatedAt ? (
              <span className="text-muted-foreground" suppressHydrationWarning>
                {config.keyHint} · validated {relativeDate(config.validatedAt)}
              </span>
            ) : null}
          </div>
          <div className="flex items-center gap-2">
            {config.configured ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={remove}
                disabled={isPending}
                className="gap-1.5 text-[color:var(--danger)] hover:text-[color:var(--danger)]"
              >
                <Trash2 aria-hidden className="size-3.5" />
                Remove
              </Button>
            ) : null}
            <Button
              type="submit"
              size="sm"
              disabled={
                !config.encryptionReady || isPending || (!apiKey && !config.configured)
              }
            >
              {isPending
                ? "Validating…"
                : config.configured
                  ? "Save changes"
                  : "Validate & save"}
            </Button>
          </div>
        </div>
      </form>
    </section>
  );
}

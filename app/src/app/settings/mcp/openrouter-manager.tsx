"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { Eye, EyeOff, KeyRound, ShieldCheck, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { relativeDate } from "@/lib/utils";
import {
  deleteOpenRouterSettings,
  saveOpenRouterSettings,
} from "./actions";

type Runtime = "bridge" | "openrouter";

export type OpenRouterSettingsView = {
  configured: boolean;
  encryptionReady: boolean;
  keyHint: string | null;
  modelId: string;
  defaultRuntime: Runtime;
  validatedAt: string | null;
};

// Quick-pick model presets (speed discovery — assistant #6). The floor on a
// reasoning model's turn is its thinking latency (~10s even for "hi"), so a
// non-reasoning preset changes the felt speed class for small copy tweaks; the
// heavier reasoning preset stays for redesigns. The "deep work" value is a
// comma list — the runner sends the first id as primary and the rest as
// OpenRouter's `models` fallback array, so a routing flap on the pinned dated
// id fails over to the alias instead of killing the turn (assistant #2). The
// field stays free-text; a preset just fills it.
type ModelPreset = { label: string; model: string; hint: string };
const MODEL_PRESETS: ModelPreset[] = [
  {
    label: "Balanced",
    model: "openrouter/auto",
    hint: "OpenRouter picks a capable model per request.",
  },
  {
    label: "Quick edits",
    model: "anthropic/claude-haiku-4.5",
    hint: "Fast, non-reasoning — best for small copy tweaks.",
  },
  {
    label: "Deep work",
    model: "z-ai/glm-5.2-20260616, z-ai/glm-5.2",
    hint: "Reasoning model for redesigns (pinned id, alias fallback).",
  },
];

function friendlyError(code: string): string {
  switch (code) {
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
      return "The OpenRouter connection could not be saved.";
  }
}

export function OpenRouterManager({
  initial,
}: {
  initial: OpenRouterSettingsView;
}) {
  const [config, setConfig] = useState(initial);
  const [apiKey, setApiKey] = useState("");
  const [modelId, setModelId] = useState(initial.modelId);
  const [defaultRuntime, setDefaultRuntime] = useState<Runtime>(
    initial.defaultRuntime,
  );
  const [showKey, setShowKey] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [isPending, startTransition] = useTransition();

  const save = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    setSaved(false);
    startTransition(async () => {
      const result = await saveOpenRouterSettings({
        apiKey,
        modelId,
        defaultRuntime,
      });
      if (!result.ok) {
        setError(friendlyError(result.error));
        return;
      }
      setConfig(result.config);
      setModelId(result.config.modelId);
      setDefaultRuntime(result.config.defaultRuntime);
      setApiKey("");
      setSaved(true);
    });
  };

  const remove = () => {
    setError(null);
    setSaved(false);
    startTransition(async () => {
      const result = await deleteOpenRouterSettings();
      if (!result.ok) {
        setError("The OpenRouter connection could not be removed.");
        return;
      }
      setConfig({
        configured: false,
        encryptionReady: config.encryptionReady,
        keyHint: null,
        modelId: "openrouter/auto",
        defaultRuntime: "bridge",
        validatedAt: null,
      });
      setModelId("openrouter/auto");
      setDefaultRuntime("bridge");
      setApiKey("");
    });
  };

  return (
    <section className="rounded-[12px] border border-border bg-card" aria-labelledby="openrouter-heading">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-5 py-4">
        <div className="flex min-w-0 items-start gap-3">
          <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-[9px] bg-[color:var(--accent-wash)] text-[color:var(--accent)]">
            <KeyRound aria-hidden className="size-4" />
          </span>
          <div>
            <h2 id="openrouter-heading" className="text-sm font-semibold text-foreground">
              OpenRouter API
            </h2>
            <p className="mt-0.5 max-w-2xl text-xs leading-relaxed text-muted-foreground">
              Use your own API key to run Canvas chat in the cloud when the
              local bridge is not running. Canvas tools stay propose-first.
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
          {config.configured && config.encryptionReady
            ? "Connected"
            : "Not configured"}
        </span>
      </div>

      <form onSubmit={save} className="space-y-5 p-5">
        {!config.encryptionReady ? (
          <div className="rounded-[9px] border border-[color:var(--danger)]/35 bg-[color:var(--danger)]/10 px-3 py-2 text-xs leading-relaxed text-foreground">
            Add <code className="font-mono">CANVAS_CREDENTIAL_ENCRYPTION_KEY</code>{" "}
            to the server environment before saving personal API keys. Generate
            it once with <code className="font-mono">openssl rand -base64 32</code>.
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
                    ? `Connected as ${config.keyHint ?? "saved key"} — leave blank to keep it`
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
                {showKey ? <EyeOff aria-hidden className="size-4" /> : <Eye aria-hidden className="size-4" />}
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
            <span className="flex flex-wrap gap-1.5 pt-0.5">
              {MODEL_PRESETS.map((preset) => {
                const active = modelId.trim() === preset.model;
                return (
                  <button
                    key={preset.label}
                    type="button"
                    onClick={() => setModelId(preset.model)}
                    disabled={!config.encryptionReady || isPending}
                    title={preset.hint}
                    className={`rounded-full border px-2.5 py-0.5 text-[11px] font-medium transition-colors disabled:opacity-55 ${
                      active
                        ? "border-[color:var(--accent)]/55 bg-[color:var(--accent-wash)] text-[color:var(--accent)]"
                        : "border-border text-muted-foreground hover:bg-muted/40"
                    }`}
                  >
                    {preset.label}
                  </button>
                );
              })}
            </span>
            <span className="block text-[11px] text-muted-foreground">
              Pick a preset or type any OpenRouter model. Custom models must
              support tools and image input. Use a comma-separated list to add
              fallbacks (the first is primary).
            </span>
          </label>
        </div>

        <fieldset className="space-y-2">
          <legend className="text-xs font-medium text-foreground">
            Default Canvas chat runtime
          </legend>
          <div className="grid gap-2 sm:grid-cols-2">
            <RuntimeChoice
              checked={defaultRuntime === "bridge"}
              onChange={() => setDefaultRuntime("bridge")}
              title="Local bridge"
              description="Uses Codex or Claude Code on your machine."
              disabled={isPending}
            />
            <RuntimeChoice
              checked={defaultRuntime === "openrouter"}
              onChange={() => setDefaultRuntime("openrouter")}
              title="OpenRouter"
              description="Uses this personal API key from the Canvas server."
              disabled={!config.encryptionReady || isPending}
            />
          </div>
        </fieldset>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
          <div className="min-h-5 text-xs">
            {error ? (
              <span className="text-[color:var(--danger)]">{error}</span>
            ) : saved ? (
              <span className="inline-flex items-center gap-1.5 text-success">
                <ShieldCheck aria-hidden className="size-3.5" />
                Key validated, encrypted, and saved.
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
              disabled={!config.encryptionReady || isPending || (!apiKey && !config.configured)}
            >
              {isPending ? "Validating…" : config.configured ? "Save changes" : "Validate & save"}
            </Button>
          </div>
        </div>
      </form>
    </section>
  );
}

function RuntimeChoice({
  checked,
  onChange,
  title,
  description,
  disabled,
}: {
  checked: boolean;
  onChange: () => void;
  title: string;
  description: string;
  disabled: boolean;
}) {
  return (
    <label
      className={`flex cursor-pointer items-start gap-2.5 rounded-[9px] border px-3 py-2.5 transition-colors ${
        checked
          ? "border-[color:var(--accent)]/55 bg-[color:var(--accent-wash)]"
          : "border-border hover:bg-muted/40"
      } ${disabled ? "cursor-not-allowed opacity-55" : ""}`}
    >
      <input
        type="radio"
        name="assistant-runtime"
        checked={checked}
        onChange={onChange}
        disabled={disabled}
        className="mt-0.5 accent-[color:var(--accent)]"
      />
      <span>
        <span className="block text-xs font-medium text-foreground">{title}</span>
        <span className="mt-0.5 block text-[11px] leading-relaxed text-muted-foreground">
          {description}
        </span>
      </span>
    </label>
  );
}


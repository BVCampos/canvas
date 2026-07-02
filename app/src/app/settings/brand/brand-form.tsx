"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { isHexColor, type BrandTokens } from "@/lib/canvas/brand";
import { saveBrand } from "./actions";

// Brand kit editor (v0): a raw-but-pleasant token form. Four conventional
// color slots seeded when present, plus add-your-own rows; two font stacks;
// a voice textarea. Deliberately no theming engine — flat tokens only.

const SUGGESTED_COLORS = ["accent", "ink", "surface", "muted"] as const;

type ColorRow = { key: string; value: string };

function tokensToColorRows(tokens: BrandTokens): ColorRow[] {
  const entries = Object.entries(tokens.colors ?? {});
  if (entries.length > 0) return entries.map(([key, value]) => ({ key, value }));
  // Fresh brand: seed the conventional slots empty so the form teaches the
  // vocabulary without forcing it.
  return SUGGESTED_COLORS.map((key) => ({ key, value: "" }));
}

export function BrandForm({
  initialName,
  initialTokens,
  initialVoice,
}: {
  initialName: string;
  initialTokens: BrandTokens;
  initialVoice: string;
}) {
  const [name, setName] = useState(initialName);
  const [colors, setColors] = useState<ColorRow[]>(() => tokensToColorRows(initialTokens));
  const [fontSans, setFontSans] = useState(initialTokens.fonts?.sans ?? "");
  const [fontDisplay, setFontDisplay] = useState(initialTokens.fonts?.display ?? "");
  const [voice, setVoice] = useState(initialVoice);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const setColor = (index: number, patch: Partial<ColorRow>) => {
    setColors((prev) => prev.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  };

  const handleSave = () => {
    setError(null);
    setFeedback(null);
    const colorMap: Record<string, string> = {};
    for (const row of colors) {
      const key = row.key.trim();
      const value = row.value.trim();
      if (key === "" && value === "") continue;
      if (key === "" || !isHexColor(value)) {
        setError(
          `Check the color "${key || value}" — names need a value like #2563eb.`,
        );
        return;
      }
      colorMap[key] = value;
    }
    const fonts: Record<string, string> = {};
    if (fontSans.trim() !== "") fonts.sans = fontSans.trim();
    if (fontDisplay.trim() !== "") fonts.display = fontDisplay.trim();

    startTransition(async () => {
      const res = await saveBrand({
        name,
        tokens: { colors: colorMap, fonts },
        voice,
      });
      if (res.ok) {
        setFeedback("Brand saved. Agents pick it up on their next turn.");
      } else {
        setError(res.error);
      }
    });
  };

  return (
    <div className="space-y-5">
      <section className="space-y-4 rounded-[12px] border border-border bg-card p-6">
        <div className="eyebrow">Identity</div>
        <div className="max-w-sm space-y-1.5">
          <label htmlFor="brand-name" className="text-xs font-medium text-foreground">
            Brand name
          </label>
          <Input
            id="brand-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. 21x"
            maxLength={60}
          />
        </div>
      </section>

      <section className="space-y-4 rounded-[12px] border border-border bg-card p-6">
        <div className="flex items-baseline justify-between">
          <div className="eyebrow">Colors</div>
          <span className="text-xs text-muted-foreground">
            named hex tokens — agents reference them by name
          </span>
        </div>
        <div className="space-y-2">
          {colors.map((row, i) => (
            <div key={i} className="flex items-center gap-2">
              {/* Live swatch: shows the parsed color, or a checker for empty/bad. */}
              <span
                aria-hidden
                className="h-8 w-8 shrink-0 rounded-[8px] border border-border"
                style={{
                  backgroundColor: isHexColor(row.value) ? row.value : "transparent",
                }}
              />
              <Input
                value={row.key}
                onChange={(e) => setColor(i, { key: e.target.value })}
                placeholder="name (e.g. accent)"
                className="w-40"
                maxLength={40}
                aria-label={`Color ${i + 1} name`}
              />
              <Input
                value={row.value}
                onChange={(e) => setColor(i, { value: e.target.value })}
                placeholder="#2563eb"
                className="w-32 font-machine text-xs"
                maxLength={7}
                aria-label={`Color ${i + 1} value`}
              />
              <button
                type="button"
                onClick={() => setColors((prev) => prev.filter((_, j) => j !== i))}
                className="text-xs text-muted-foreground transition-colors hover:text-[color:var(--danger)]"
                aria-label={`Remove color ${row.key || i + 1}`}
              >
                Remove
              </button>
            </div>
          ))}
        </div>
        <button
          type="button"
          onClick={() => setColors((prev) => [...prev, { key: "", value: "" }])}
          className="text-xs font-medium text-[color:var(--accent)] transition-colors hover:underline"
        >
          + Add color
        </button>
      </section>

      <section className="space-y-4 rounded-[12px] border border-border bg-card p-6">
        <div className="eyebrow">Type</div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <label htmlFor="brand-font-sans" className="text-xs font-medium text-foreground">
              Body font stack
            </label>
            <Input
              id="brand-font-sans"
              value={fontSans}
              onChange={(e) => setFontSans(e.target.value)}
              placeholder='e.g. Geist, "Helvetica Neue", sans-serif'
              maxLength={200}
            />
          </div>
          <div className="space-y-1.5">
            <label htmlFor="brand-font-display" className="text-xs font-medium text-foreground">
              Display font stack{" "}
              <span className="font-normal text-muted-foreground">(optional)</span>
            </label>
            <Input
              id="brand-font-display"
              value={fontDisplay}
              onChange={(e) => setFontDisplay(e.target.value)}
              placeholder="e.g. Geist, sans-serif"
              maxLength={200}
            />
          </div>
        </div>
      </section>

      <section className="space-y-4 rounded-[12px] border border-border bg-card p-6">
        <div className="flex items-baseline justify-between">
          <div className="eyebrow">Voice</div>
          <span className="text-xs text-muted-foreground">
            how copy should read — injected into every assistant turn, keep it tight
          </span>
        </div>
        <textarea
          value={voice}
          onChange={(e) => setVoice(e.target.value)}
          rows={5}
          maxLength={4000}
          placeholder={
            "e.g. First person, direct, specific numbers. No em dashes, no rule-of-three, no marketing superlatives."
          }
          className="w-full resize-y rounded-[8px] border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
      </section>

      <div className="flex items-center gap-3">
        <Button type="button" onClick={handleSave} disabled={isPending}>
          {isPending ? "Saving…" : "Save brand"}
        </Button>
        {feedback ? <span className="text-xs text-muted-foreground">{feedback}</span> : null}
        {error ? (
          <span className="text-xs text-[color:var(--danger)]">{error}</span>
        ) : null}
      </div>
    </div>
  );
}

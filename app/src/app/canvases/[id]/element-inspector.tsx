"use client";

import { useEffect, useState } from "react";
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  Bold,
  ChevronUp,
  Minus,
  Plus,
  Type,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Computed-style snapshot the iframe posts on every (re)selection
 * (canvas:element-selected in assemble.ts). Numbers are layout px; colors are
 * hex ('' = transparent / no fill); padding is the uniform value or null when
 * the four sides differ ("mixed").
 */
export type InspectSnapshot = {
  fontSize: number | null;
  fontWeight: number | null;
  color: string;
  background: string;
  textAlign: string;
  padding: number | null;
  width: number | null;
  height: number | null;
  positionMode: "absolute" | "flow";
};

type Props = {
  descriptor: string;
  snapshot: InspectSnapshot;
  /** Write inline styles onto the selected element (kebab-case CSS props; null removes). */
  onStyle: (styles: Record<string, string | null>) => void;
  onNudge: (dx: number, dy: number) => void;
  /** Begin editing the selected element's text in place (mirrors a double-click). */
  onEditText: () => void;
  onSelectParent: () => void;
  onDeselect: () => void;
  /** True while the element's text is being typed in the iframe — the in-place
   * edit owns the keyboard, so the panel disables its own arrow-nudge and marks
   * the Text button pressed. */
  textEditing: boolean;
};

/**
 * The floating control panel for the direct-manipulation inspector ("Adjust"
 * mode). Pure view: every change posts straight through to the iframe via
 * onStyle/onNudge, so the slide IS the live preview — nothing is persisted
 * until the toolbar Save serializes the slide (canvas:inspect-save).
 *
 * The host remounts this component (key bump) on each new selection, so local
 * input state can initialize from the snapshot without sync effects.
 */
export function ElementInspector({
  descriptor,
  snapshot,
  onStyle,
  onNudge,
  onEditText,
  onSelectParent,
  onDeselect,
  textEditing,
}: Props) {
  const [fontSize, setFontSize] = useState(
    snapshot.fontSize != null ? String(snapshot.fontSize) : "",
  );
  const [bold, setBold] = useState((snapshot.fontWeight ?? 400) >= 600);
  const [color, setColor] = useState(snapshot.color || "#000000");
  const [background, setBackground] = useState(snapshot.background);
  const [align, setAlign] = useState(snapshot.textAlign);
  const [padding, setPadding] = useState(
    snapshot.padding != null ? String(snapshot.padding) : "",
  );
  const [width, setWidth] = useState(
    snapshot.width != null ? String(snapshot.width) : "",
  );
  const [height, setHeight] = useState(
    snapshot.height != null ? String(snapshot.height) : "",
  );

  // Arrow-key nudge while the HOST has focus (the iframe handles its own
  // arrows). Skips editable targets so typing in the px inputs still works;
  // the workspace's slide-nav arrow handler is suppressed during edit modes,
  // so there is no competition for the gesture. Also skipped entirely while the
  // element's text is being typed in the iframe — there the arrows move the
  // caret, and a host nudge would fight it.
  useEffect(() => {
    if (textEditing) return;
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      if (target) {
        const tag = target.tagName;
        if (
          tag === "INPUT" ||
          tag === "TEXTAREA" ||
          tag === "SELECT" ||
          target.isContentEditable
        ) {
          return;
        }
      }
      if (e.key === "Escape") {
        e.preventDefault();
        onDeselect();
        return;
      }
      const map: Record<string, [number, number]> = {
        ArrowLeft: [-1, 0],
        ArrowRight: [1, 0],
        ArrowUp: [0, -1],
        ArrowDown: [0, 1],
      };
      const d = map[e.key];
      if (!d) return;
      e.preventDefault();
      const f = e.shiftKey ? 10 : 1;
      onNudge(d[0] * f, d[1] * f);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onNudge, onDeselect, textEditing]);

  const commitPx = (
    prop: string,
    raw: string,
    set: (v: string) => void,
  ) => {
    set(raw);
    const n = parseFloat(raw);
    if (Number.isFinite(n) && n >= 0) onStyle({ [prop]: `${Math.round(n)}px` });
  };

  const stepPx = (
    prop: string,
    current: string,
    delta: number,
    set: (v: string) => void,
    fallback: number,
  ) => {
    const base = parseFloat(current);
    const next = Math.max(0, Math.round((Number.isFinite(base) ? base : fallback) + delta));
    set(String(next));
    onStyle({ [prop]: `${next}px` });
  };

  const numField = (
    label: string,
    prop: string,
    value: string,
    set: (v: string) => void,
    placeholder: string,
    fallback: number,
  ) => (
    <div className="flex items-center gap-1">
      <span className="w-12 shrink-0 text-[10px] text-muted-foreground">{label}</span>
      <button
        type="button"
        onClick={() => stepPx(prop, value, -1, set, fallback)}
        className="flex h-6 w-6 shrink-0 items-center justify-center rounded border border-border text-muted-foreground hover:bg-muted"
        aria-label={`Decrease ${label.toLowerCase()}`}
      >
        <Minus aria-hidden className="h-3 w-3" />
      </button>
      <input
        type="number"
        min={0}
        value={value}
        placeholder={placeholder}
        onChange={(e) => commitPx(prop, e.target.value, set)}
        className="font-machine h-6 w-full min-w-0 rounded border border-border bg-background px-1.5 text-center text-[11px] tabular-nums focus:outline-none focus:ring-1 focus:ring-ring [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
        aria-label={`${label} (px)`}
      />
      <button
        type="button"
        onClick={() => stepPx(prop, value, 1, set, fallback)}
        className="flex h-6 w-6 shrink-0 items-center justify-center rounded border border-border text-muted-foreground hover:bg-muted"
        aria-label={`Increase ${label.toLowerCase()}`}
      >
        <Plus aria-hidden className="h-3 w-3" />
      </button>
    </div>
  );

  const alignBtn = (value: string, Icon: typeof AlignLeft, label: string) => (
    <button
      type="button"
      onClick={() => {
        setAlign(value);
        onStyle({ "text-align": value });
      }}
      className={cn(
        "flex h-6 flex-1 items-center justify-center rounded border text-muted-foreground hover:bg-muted",
        align === value
          ? "border-[color:var(--accent-warm)] bg-muted text-foreground"
          : "border-border",
      )}
      aria-label={label}
      aria-pressed={align === value}
    >
      <Icon aria-hidden className="h-3 w-3" />
    </button>
  );

  return (
    <div className="pointer-events-auto absolute right-2 top-8 z-[5] w-60 rounded-lg border border-border bg-card/95 shadow-lg backdrop-blur-sm">
      <div className="flex items-center gap-1 border-b border-border px-2.5 py-1.5">
        <span
          className="font-machine min-w-0 truncate text-[10px] text-machine-copper"
          title={descriptor}
        >
          {descriptor}
        </span>
        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          <button
            type="button"
            onClick={onEditText}
            className={cn(
              "flex h-5 w-5 items-center justify-center rounded hover:bg-muted hover:text-foreground",
              textEditing
                ? "bg-muted text-machine-copper"
                : "text-muted-foreground",
            )}
            title="Edit text (or double-click the element)"
            aria-label="Edit element text"
            aria-pressed={textEditing}
          >
            <Type aria-hidden className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={onSelectParent}
            className="flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
            title="Select the parent element"
            aria-label="Select parent element"
          >
            <ChevronUp aria-hidden className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={onDeselect}
            className="flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
            title="Deselect (Esc)"
            aria-label="Deselect element"
          >
            <X aria-hidden className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      <div className="space-y-1.5 px-2.5 py-2">
        {numField("Text", "font-size", fontSize, setFontSize, "–", 16)}

        <div className="flex items-center gap-1">
          <span className="w-12 shrink-0 text-[10px] text-muted-foreground">Style</span>
          <button
            type="button"
            onClick={() => {
              const next = !bold;
              setBold(next);
              onStyle({ "font-weight": next ? "700" : "400" });
            }}
            className={cn(
              "flex h-6 w-6 shrink-0 items-center justify-center rounded border text-muted-foreground hover:bg-muted",
              bold ? "border-[color:var(--accent-warm)] bg-muted text-foreground" : "border-border",
            )}
            title="Bold"
            aria-label="Toggle bold"
            aria-pressed={bold}
          >
            <Bold aria-hidden className="h-3 w-3" />
          </button>
          <input
            type="color"
            value={color}
            onChange={(e) => {
              setColor(e.target.value);
              onStyle({ color: e.target.value });
            }}
            className="h-6 w-8 shrink-0 cursor-pointer rounded border border-border bg-background p-0.5"
            title="Text color"
            aria-label="Text color"
          />
          <div className="ml-auto flex flex-1 items-center gap-0.5">
            {alignBtn("left", AlignLeft, "Align left")}
            {alignBtn("center", AlignCenter, "Align center")}
            {alignBtn("right", AlignRight, "Align right")}
          </div>
        </div>

        <div className="flex items-center gap-1">
          <span className="w-12 shrink-0 text-[10px] text-muted-foreground">Fill</span>
          <input
            type="color"
            value={background || "#ffffff"}
            onChange={(e) => {
              setBackground(e.target.value);
              onStyle({ "background-color": e.target.value });
            }}
            className="h-6 w-8 shrink-0 cursor-pointer rounded border border-border bg-background p-0.5"
            title="Background color"
            aria-label="Background color"
          />
          {!background ? (
            <span className="text-[10px] text-muted-foreground/70">none</span>
          ) : (
            <button
              type="button"
              onClick={() => {
                setBackground("");
                onStyle({ "background-color": null });
              }}
              className="rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-muted"
            >
              Clear
            </button>
          )}
        </div>

        {numField(
          "Padding",
          "padding",
          padding,
          setPadding,
          snapshot.padding == null ? "mixed" : "–",
          0,
        )}
        {numField("Width", "width", width, setWidth, "auto", snapshot.width ?? 0)}
        {numField("Height", "height", height, setHeight, "auto", snapshot.height ?? 0)}
      </div>

      <div className="border-t border-border px-2.5 py-1.5 text-[10px] leading-snug text-muted-foreground">
        {textEditing
          ? "Editing text — Enter or Esc to finish"
          : "Drag to move · corners resize (Shift keeps ratio) · double-click edits text · arrows nudge (Shift ×10)"}
      </div>
    </div>
  );
}

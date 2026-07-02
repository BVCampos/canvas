"use client";

// ============================================================
// DrawCanvas — an Excalidraw-style freehand drawing surface for a slide.
// ============================================================
// A full-screen modal that edits a DrawScene (see lib/canvas/draw/scene.ts) and
// hands it back via onSave. It is deliberately HOST-side (not inside the preview
// iframe): the headline use is creating a NEW slide, where there is no slide to
// edit-in-place yet, and a self-contained surface keeps the giant CANVAS_EDITOR
// island untouched. The saved scene becomes plain SVG in the slide's html_body,
// so it renders everywhere (preview / export / thumbnails) with no pipeline work.
//
// Rendering model (zero WYSIWYG drift): the COMMITTED scene is painted by the
// same serializer the saved slide uses (sceneToSvg, via dangerouslySetInnerHTML
// on a non-interactive layer). A transparent interaction <svg> sits on top and
// owns pointer events, the in-progress draft shape, and the selection UI.
// Elements being moved / erased / text-edited are hidden from the committed
// layer; moved and text-edited ones are re-previewed on the overlay (erased
// ones simply vanish), so the committed `scene` never mutates mid-gesture —
// which makes undo/redo exactly one step per gesture.
// ============================================================

import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import {
  ArrowUpRight,
  Circle,
  Eraser,
  Minus,
  MousePointer2,
  Pencil,
  Redo2,
  Square,
  Trash2,
  Type,
  Undo2,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  DRAW_W,
  DRAW_H,
  elementBounds,
  elementToSvg,
  emptyScene,
  hitTest,
  sceneToSvg,
  translateElement,
  type DrawElement,
  type DrawScene,
  type ElementType,
} from "@/lib/canvas/draw/scene";

type Tool =
  | "select"
  | "pen"
  | "rect"
  | "ellipse"
  | "line"
  | "arrow"
  | "text"
  | "eraser";

const STROKE_SWATCHES = [
  "#1e1e1e",
  "#e03131",
  "#1971c2",
  "#2f9e44",
  "#f08c00",
  "#9c36b5",
  "#ffffff",
];
const BG_SWATCHES = ["#ffffff", "#fff9db", "#1e1e1e", "#0b1021", "transparent"];
const STROKE_WIDTHS = [
  { label: "S", value: 2 },
  { label: "M", value: 4 },
  { label: "L", value: 8 },
];
const FONT_SIZES = [
  { label: "S", value: 28 },
  { label: "M", value: 44 },
  { label: "L", value: 72 },
];

const TOOLS: Array<{ tool: Tool; icon: typeof Pencil; label: string; key: string }> = [
  { tool: "select", icon: MousePointer2, label: "Select / move", key: "V" },
  { tool: "pen", icon: Pencil, label: "Pen", key: "P" },
  { tool: "rect", icon: Square, label: "Rectangle", key: "R" },
  { tool: "ellipse", icon: Circle, label: "Ellipse", key: "O" },
  { tool: "line", icon: Minus, label: "Line", key: "L" },
  { tool: "arrow", icon: ArrowUpRight, label: "Arrow", key: "A" },
  { tool: "text", icon: Type, label: "Text", key: "T" },
  { tool: "eraser", icon: Eraser, label: "Eraser", key: "E" },
];

const KEY_TO_TOOL: Record<string, Tool> = {
  v: "select",
  p: "pen",
  r: "rect",
  o: "ellipse",
  l: "line",
  a: "arrow",
  t: "text",
  e: "eraser",
};

const genId = (): string =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `e${Math.random().toString(36).slice(2)}`;

function isBoxType(t: ElementType): boolean {
  return t === "rect" || t === "ellipse";
}

export function DrawCanvas({
  initialScene,
  title: initialTitle = "",
  saving = false,
  onSave,
  onCancel,
  overlay = false,
  backdropSrc = null,
  saveLabel = "Add to deck",
}: {
  initialScene?: DrawScene | null;
  title?: string;
  saving?: boolean;
  onSave: (scene: DrawScene, title: string) => void;
  onCancel: () => void;
  // Overlay mode: draw ON TOP of an existing slide rather than authoring a whole
  // slide. Hides the background + title controls (the slide owns both) and shows
  // the slide render behind the canvas via `backdropSrc`.
  overlay?: boolean;
  backdropSrc?: string | null;
  saveLabel?: string;
}) {
  // Scene + undo/redo stacks live in one reducer so each commit/undo/redo is a
  // single PURE transition. (They used to be three useStates with setState
  // called inside another setState's updater — React invokes updaters more than
  // once under StrictMode/concurrent rendering, which double-pushed history
  // entries and desynced the undo step count from the user's gestures.)
  const [{ scene, past, future }, dispatch] = useReducer(
    historyReducer,
    undefined,
    () => ({ scene: initialScene ?? emptyScene(), past: [], future: [] }),
  );
  const [title, setTitle] = useState(initialTitle);

  const [tool, setTool] = useState<Tool>("pen");
  const [stroke, setStroke] = useState(STROKE_SWATCHES[0]);
  const [strokeWidth, setStrokeWidth] = useState(4);
  const [fontSize, setFontSize] = useState(44);
  const [fillEnabled, setFillEnabled] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Transient gesture state (cleared on pointerup) — previewed on the overlay so
  // the committed `scene` stays frozen for the whole gesture (= 1 undo step).
  const [draft, setDraft] = useState<DrawElement | null>(null);
  const [moving, setMoving] = useState<{ id: string; dx: number; dy: number } | null>(null);
  const [erasing, setErasing] = useState<Set<string>>(() => new Set());
  const [editingTextId, setEditingTextId] = useState<string | null>(null);
  const [textValue, setTextValue] = useState("");

  const svgRef = useRef<SVGSVGElement | null>(null);
  const gesture = useRef<
    | { mode: "draw-pen" | "draw-shape" | "move" | "erase"; startX: number; startY: number }
    | null
  >(null);
  // Live width of the canvas in CSS px, for sizing the text-edit overlay.
  const [canvasW, setCanvasW] = useState(0);
  const canvasWrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = canvasWrapRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      setCanvasW(entries[0].contentRect.width);
    });
    ro.observe(el);
    setCanvasW(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  // Body scroll lock while the modal is open.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  // Callback ref that focuses the text box the moment it mounts. We focus twice:
  // synchronously (covers most cases) and again on the next frame, because a
  // focus race during the placement click can blur the freshly-focused box —
  // that blur would prune the empty element before a keystroke lands. The
  // double-focus makes it stick without an autoFocus race.
  const focusText = useCallback((node: HTMLTextAreaElement | null) => {
    if (!node) return;
    const place = () => {
      node.focus();
      const len = node.value.length;
      node.setSelectionRange(len, len);
    };
    place();
    requestAnimationFrame(place);
  }, []);

  const selectedEl = useMemo(
    () => (selectedId ? scene.elements.find((e) => e.id === selectedId) ?? null : null),
    [scene, selectedId],
  );

  // ---- history --------------------------------------------------------------
  // `commit(producer)` derives the next scene and pushes one history step; undo
  // / redo are single reducer dispatches. All the (im)mutation logic lives in
  // the pure `historyReducer` below.
  const commit = useCallback(
    (producer: (s: DrawScene) => DrawScene) =>
      dispatch({ type: "commit", producer }),
    [],
  );
  const undo = useCallback(() => dispatch({ type: "undo" }), []);
  const redo = useCallback(() => dispatch({ type: "redo" }), []);

  // ---- coordinate mapping ---------------------------------------------------
  // The canvas wrapper is forced to 16:9 and the svg fills it, so screen↔scene
  // is a plain linear scale (no preserveAspectRatio letterboxing to undo).
  const toScene = useCallback((clientX: number, clientY: number) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return { x: 0, y: 0 };
    return {
      x: ((clientX - rect.left) / rect.width) * DRAW_W,
      y: ((clientY - rect.top) / rect.height) * DRAW_H,
    };
  }, []);

  const eraseTol = 10;

  // ---- apply property changes (to the selection and/or the live defaults) ---
  const applyStroke = (color: string) => {
    setStroke(color);
    if (selectedEl) {
      commit((s) => ({
        ...s,
        elements: s.elements.map((e) =>
          e.id === selectedEl.id
            ? e.type === "text"
              ? { ...e, color }
              : { ...e, stroke: color }
            : e,
        ),
      }));
    }
  };
  const applyWidth = (w: number) => {
    setStrokeWidth(w);
    if (selectedEl && selectedEl.type !== "text") {
      commit((s) => ({
        ...s,
        elements: s.elements.map((e) =>
          e.id === selectedEl.id && e.type !== "text" ? { ...e, strokeWidth: w } : e,
        ),
      }));
    }
  };
  const applyFontSize = (fs: number) => {
    setFontSize(fs);
    if (selectedEl?.type === "text") {
      commit((s) => ({
        ...s,
        elements: s.elements.map((e) =>
          e.id === selectedEl.id && e.type === "text" ? { ...e, fontSize: fs } : e,
        ),
      }));
    }
  };
  const applyFill = (enabled: boolean) => {
    setFillEnabled(enabled);
    if (selectedEl && isBoxType(selectedEl.type)) {
      const fill = enabled ? `${stroke}33` : "none";
      commit((s) => ({
        ...s,
        elements: s.elements.map((e) =>
          e.id === selectedEl.id && isBoxType(e.type)
            ? ({ ...e, fill } as DrawElement)
            : e,
        ),
      }));
    }
  };

  const deleteSelected = useCallback(() => {
    if (!selectedId) return;
    commit((s) => ({ ...s, elements: s.elements.filter((e) => e.id !== selectedId) }));
    setSelectedId(null);
  }, [selectedId, commit]);

  // ---- text editing ---------------------------------------------------------
  const startTextEdit = (el: DrawElement) => {
    if (el.type !== "text") return;
    setSelectedId(el.id);
    setEditingTextId(el.id);
    setTextValue(el.text);
  };
  const finishTextEdit = useCallback(() => {
    const id = editingTextId;
    if (!id) return;
    const value = textValue;
    setEditingTextId(null);
    setTextValue("");
    commit((s) => {
      const exists = s.elements.some((e) => e.id === id);
      const trimmed = value.replace(/\s+$/g, "");
      if (trimmed === "") {
        // Empty text element is dropped (creating one then clicking away).
        return { ...s, elements: s.elements.filter((e) => e.id !== id) };
      }
      if (!exists) return s;
      return {
        ...s,
        elements: s.elements.map((e) =>
          e.id === id && e.type === "text" ? { ...e, text: value } : e,
        ),
      };
    });
  }, [editingTextId, textValue, commit]);

  // ---- pointer gestures -----------------------------------------------------
  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    if (e.button !== 0) return;
    if (editingTextId) {
      // A click outside the textarea commits the in-progress text first.
      finishTextEdit();
    }
    const p = toScene(e.clientX, e.clientY);
    (e.target as Element).setPointerCapture?.(e.pointerId);

    if (tool === "select") {
      const hit = hitTest(scene, p.x, p.y, 8);
      setSelectedId(hit);
      if (hit) {
        gesture.current = { mode: "move", startX: p.x, startY: p.y };
        setMoving({ id: hit, dx: 0, dy: 0 });
      } else {
        gesture.current = null;
      }
      return;
    }

    if (tool === "eraser") {
      gesture.current = { mode: "erase", startX: p.x, startY: p.y };
      const hit = hitTest(scene, p.x, p.y, eraseTol);
      setErasing(hit ? new Set([hit]) : new Set());
      return;
    }

    if (tool === "text") {
      const el: DrawElement = {
        id: genId(),
        type: "text",
        x: p.x,
        y: p.y,
        text: "",
        fontSize,
        color: stroke,
      };
      // Add immediately so the overlay textarea anchors to it; empty text is
      // pruned on finish.
      commit((s) => ({ ...s, elements: [...s.elements, el] }));
      startTextEdit(el);
      setTool("select");
      return;
    }

    if (tool === "pen") {
      gesture.current = { mode: "draw-pen", startX: p.x, startY: p.y };
      setDraft({
        id: genId(),
        type: "freehand",
        points: [round(p.x), round(p.y)],
        stroke,
        strokeWidth,
      });
      return;
    }

    // rect / ellipse / line / arrow — a 2-point drag. The branches above
    // already returned for select/pen/text/eraser, so `tool` is a ShapeTool here.
    gesture.current = { mode: "draw-shape", startX: p.x, startY: p.y };
    setDraft(
      makeShape(tool as ShapeTool, p.x, p.y, p.x, p.y, stroke, strokeWidth, fillEnabled),
    );
  };

  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const g = gesture.current;
    if (!g) return;
    const p = toScene(e.clientX, e.clientY);

    if (g.mode === "move") {
      setMoving((m) => (m ? { ...m, dx: p.x - g.startX, dy: p.y - g.startY } : m));
      return;
    }
    if (g.mode === "erase") {
      const hit = hitTest(scene, p.x, p.y, eraseTol);
      if (hit) setErasing((cur) => (cur.has(hit) ? cur : new Set(cur).add(hit)));
      return;
    }
    if (g.mode === "draw-pen") {
      setDraft((d) => {
        if (!d || d.type !== "freehand") return d;
        const pts = d.points;
        const lx = pts[pts.length - 2];
        const ly = pts[pts.length - 1];
        if (Math.hypot(p.x - lx, p.y - ly) < 2.5) return d;
        return { ...d, points: [...pts, round(p.x), round(p.y)] };
      });
      return;
    }
    if (g.mode === "draw-shape") {
      setDraft((d) => (d ? updateShape(d, g.startX, g.startY, p.x, p.y) : d));
    }
  };

  const onPointerUp = () => {
    const g = gesture.current;
    gesture.current = null;
    if (!g) return;

    if (g.mode === "move") {
      const m = moving;
      setMoving(null);
      if (m && (m.dx !== 0 || m.dy !== 0)) {
        commit((s) => ({
          ...s,
          elements: s.elements.map((el) =>
            el.id === m.id ? translateElement(el, m.dx, m.dy) : el,
          ),
        }));
      }
      return;
    }
    if (g.mode === "erase") {
      const ids = erasing;
      setErasing(new Set());
      if (ids.size > 0) {
        commit((s) => ({ ...s, elements: s.elements.filter((el) => !ids.has(el.id)) }));
      }
      return;
    }
    // draw-pen / draw-shape
    const d = draft;
    setDraft(null);
    if (!d) return;
    if (!isWorthKeeping(d)) return;
    commit((s) => ({ ...s, elements: [...s.elements, d] }));
    setSelectedId(d.id);
  };

  // ---- keyboard -------------------------------------------------------------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing =
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable);

      // Focus in the title input or the text box → let native editing
      // shortcuts (incl. Cmd/Ctrl+Z) work; the canvas shortcuts below must not
      // hijack them. The text box runs its own Escape / Cmd+Enter handler.
      if (typing) return;

      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "y") {
        e.preventDefault();
        redo();
        return;
      }

      if (e.key === "Escape") {
        if (editingTextId) finishTextEdit();
        else if (selectedId) setSelectedId(null);
        else setTool("select");
        return;
      }
      if ((e.key === "Delete" || e.key === "Backspace") && selectedId) {
        e.preventDefault();
        deleteSelected();
        return;
      }
      const t = KEY_TO_TOOL[e.key.toLowerCase()];
      if (t) {
        setTool(t);
        setSelectedId(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo, redo, deleteSelected, finishTextEdit, editingTextId, selectedId]);

  // ---- render ---------------------------------------------------------------
  // Committed layer = scene minus anything being moved / erased / text-edited
  // (those preview on the overlay), serialized with the SAME function the saved
  // slide uses.
  const hiddenIds = useMemo(() => {
    const set = new Set<string>();
    if (moving) set.add(moving.id);
    erasing.forEach((id) => set.add(id));
    if (editingTextId) set.add(editingTextId);
    return set;
  }, [moving, erasing, editingTextId]);

  const committedSvg = useMemo(
    () =>
      sceneToSvg({
        ...scene,
        elements: scene.elements.filter((e) => !hiddenIds.has(e.id)),
      }),
    [scene, hiddenIds],
  );

  // The moved element previewed at its dragged position.
  const movedEl = useMemo(() => {
    if (!moving) return null;
    const el = scene.elements.find((e) => e.id === moving.id);
    return el ? translateElement(el, moving.dx, moving.dy) : null;
  }, [moving, scene]);

  const selBounds = useMemo(() => {
    const el = movedEl ?? selectedEl;
    if (!el || editingTextId) return null;
    const b = elementBounds(el);
    const pad = 6;
    return { x: b.x - pad, y: b.y - pad, w: b.w + pad * 2, h: b.h + pad * 2 };
  }, [movedEl, selectedEl, editingTextId]);

  const editingEl =
    editingTextId != null
      ? (scene.elements.find((e) => e.id === editingTextId) as
          | (DrawElement & { type: "text" })
          | undefined)
      : undefined;
  const scale = canvasW > 0 ? canvasW / DRAW_W : 0;

  const showFill = tool === "rect" || tool === "ellipse" || (selectedEl != null && isBoxType(selectedEl.type));
  const showFont = tool === "text" || selectedEl?.type === "text";
  const cursor = tool === "select" ? "default" : tool === "text" ? "text" : "crosshair";

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={overlay ? "Draw over slide" : "Draw a slide"}
      className="fixed inset-0 z-[60] flex flex-col bg-foreground/50 backdrop-blur-sm"
    >
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2 border-b border-border bg-card px-3 py-2 shadow-sm">
        {/* Tools */}
        <div className="flex items-center gap-0.5 rounded-[8px] border border-border p-0.5">
          {TOOLS.map(({ tool: t, icon: Icon, label, key }) => (
            <button
              key={t}
              type="button"
              aria-label={`${label} (${key})`}
              aria-pressed={tool === t}
              title={`${label} — ${key}`}
              onClick={() => {
                setTool(t);
                if (t !== "select") setSelectedId(null);
              }}
              className={cn(
                "flex h-8 w-8 items-center justify-center rounded-[6px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
                tool === t && "bg-[color:var(--accent-wash)] text-foreground ring-1 ring-[color:var(--accent)]/40",
              )}
            >
              <Icon aria-hidden className="h-4 w-4" />
            </button>
          ))}
        </div>

        {/* Stroke colour */}
        <div className="flex items-center gap-1" role="group" aria-label="Stroke colour">
          {STROKE_SWATCHES.map((c) => (
            <button
              key={c}
              type="button"
              aria-label={`Colour ${c}`}
              aria-pressed={stroke === c}
              onClick={() => applyStroke(c)}
              className={cn(
                "h-6 w-6 rounded-full border border-border transition-transform hover:scale-110",
                stroke === c && "ring-2 ring-[color:var(--accent)] ring-offset-1 ring-offset-card",
              )}
              style={{ background: c }}
            />
          ))}
          <label
            className="relative h-6 w-6 cursor-pointer overflow-hidden rounded-full border border-dashed border-border"
            title="Custom colour"
            style={{
              background:
                "conic-gradient(red, orange, yellow, lime, cyan, blue, magenta, red)",
            }}
          >
            <input
              type="color"
              value={STROKE_SWATCHES.includes(stroke) ? "#000000" : stroke}
              onChange={(e) => applyStroke(e.target.value)}
              className="absolute inset-0 cursor-pointer opacity-0"
            />
          </label>
        </div>

        {/* Stroke width */}
        <div className="flex items-center gap-0.5 rounded-[8px] border border-border p-0.5" role="group" aria-label="Stroke width">
          {STROKE_WIDTHS.map((w) => (
            <button
              key={w.value}
              type="button"
              aria-label={`Stroke ${w.label}`}
              aria-pressed={strokeWidth === w.value}
              onClick={() => applyWidth(w.value)}
              className={cn(
                "flex h-8 w-8 items-center justify-center rounded-[6px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
                strokeWidth === w.value && "bg-[color:var(--accent-wash)] text-foreground",
              )}
            >
              <span
                className="rounded-full bg-current"
                style={{ width: Math.max(3, w.value), height: Math.max(3, w.value) }}
              />
            </button>
          ))}
        </div>

        {showFont ? (
          <div className="flex items-center gap-0.5 rounded-[8px] border border-border p-0.5" role="group" aria-label="Font size">
            {FONT_SIZES.map((f) => (
              <button
                key={f.value}
                type="button"
                aria-label={`Text size ${f.label}`}
                aria-pressed={fontSize === f.value}
                onClick={() => applyFontSize(f.value)}
                className={cn(
                  "flex h-8 min-w-8 items-center justify-center rounded-[6px] px-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
                  fontSize === f.value && "bg-[color:var(--accent-wash)] text-foreground",
                )}
              >
                {f.label}
              </button>
            ))}
          </div>
        ) : null}

        {showFill ? (
          <button
            type="button"
            aria-pressed={fillEnabled}
            onClick={() => applyFill(!fillEnabled)}
            className={cn(
              "flex h-8 items-center gap-1.5 rounded-[8px] border border-border px-2 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
              fillEnabled && "bg-[color:var(--accent-wash)] text-foreground",
            )}
            title="Toggle a light fill for shapes"
          >
            <span
              className="h-3.5 w-3.5 rounded-[3px] border border-current"
              style={{ background: fillEnabled ? `${stroke}33` : "transparent" }}
            />
            Fill
          </button>
        ) : null}

        <div className="mx-0.5 h-6 w-px bg-border" />

        {/* History + element actions */}
        <button
          type="button"
          aria-label="Undo"
          title="Undo (⌘Z)"
          disabled={past.length === 0}
          onClick={undo}
          className="flex h-8 w-8 items-center justify-center rounded-[6px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
        >
          <Undo2 aria-hidden className="h-4 w-4" />
        </button>
        <button
          type="button"
          aria-label="Redo"
          title="Redo (⇧⌘Z)"
          disabled={future.length === 0}
          onClick={redo}
          className="flex h-8 w-8 items-center justify-center rounded-[6px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
        >
          <Redo2 aria-hidden className="h-4 w-4" />
        </button>
        <button
          type="button"
          aria-label="Delete selected"
          title="Delete selected (Del)"
          disabled={!selectedId}
          onClick={deleteSelected}
          className="flex h-8 w-8 items-center justify-center rounded-[6px] text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive disabled:cursor-not-allowed disabled:opacity-40"
        >
          <Trash2 aria-hidden className="h-4 w-4" />
        </button>

        <div className="ml-auto flex items-center gap-2">
          {/* Background colour — hidden when drawing over a slide (the slide is
              the background). */}
          <div
            className={cn(
              "hidden items-center gap-1 sm:flex",
              overlay && "sm:hidden",
            )}
            role="group"
            aria-label="Background colour"
          >
            <span className="text-[11px] text-muted-foreground">Bg</span>
            {BG_SWATCHES.map((c) => (
              <button
                key={c}
                type="button"
                aria-label={`Background ${c}`}
                aria-pressed={scene.background === c}
                onClick={() => commit((s) => ({ ...s, background: c }))}
                className={cn(
                  "h-5 w-5 rounded-[4px] border border-border transition-transform hover:scale-110",
                  c === "transparent" &&
                    "bg-[repeating-conic-gradient(#ccc_0_25%,#fff_0_50%)] bg-[length:8px_8px]",
                  scene.background === c && "ring-2 ring-[color:var(--accent)]",
                )}
                style={c === "transparent" ? undefined : { background: c }}
              />
            ))}
          </div>
          {overlay ? null : (
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Slide title (optional)"
              aria-label="Slide title"
              className="h-8 w-36 rounded-[6px] border border-border bg-background px-2 text-xs text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:w-44"
            />
          )}
          <Button type="button" variant="outline" size="sm" onClick={onCancel} disabled={saving}>
            <X aria-hidden className="h-3.5 w-3.5" />
            Cancel
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={saving}
            onClick={() => {
              // Flush an in-progress text edit into the scene first.
              if (editingTextId) finishTextEdit();
              onSave(
                editingTextId
                  ? {
                      ...scene,
                      elements: scene.elements
                        .map((el) =>
                          el.id === editingTextId && el.type === "text"
                            ? { ...el, text: textValue }
                            : el,
                        )
                        .filter((el) => !(el.type === "text" && el.text.trim() === "")),
                    }
                  : scene,
                title,
              );
            }}
          >
            {saving ? "Saving…" : saveLabel}
          </Button>
        </div>
      </div>

      {/* Canvas area */}
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden p-3 sm:p-6">
        <div
          ref={canvasWrapRef}
          className="relative aspect-[16/9] w-full overflow-hidden rounded-[10px] shadow-2xl ring-1 ring-black/10"
          style={{
            width: "min(100%, calc((100vh - 9rem) * 16 / 9))",
            // In overlay mode the backdrop iframe paints the slide; keep the box
            // an opaque white (a blank-slide stand-in) so the dialog's dark
            // scrim behind doesn't peek through before the frame loads.
            background:
              backdropSrc || scene.background === "transparent"
                ? "#ffffff"
                : scene.background,
          }}
        >
          {/* Backdrop: the real slide render, drawn behind the canvas so an
              overlay is placed over live content. Non-interactive; the route's
              CSP sandboxes it. */}
          {backdropSrc ? (
            <iframe
              src={backdropSrc}
              aria-hidden
              tabIndex={-1}
              title="Slide backdrop"
              className="pointer-events-none absolute inset-0 h-full w-full border-0"
            />
          ) : null}

          {/* Committed scene (non-interactive, exact saved serialization). */}
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0"
            dangerouslySetInnerHTML={{ __html: committedSvg }}
          />

          {/* Interaction overlay */}
          <svg
            ref={svgRef}
            viewBox={`0 0 ${DRAW_W} ${DRAW_H}`}
            preserveAspectRatio="xMidYMid meet"
            className="absolute inset-0 h-full w-full touch-none select-none"
            style={{ cursor }}
            // Stop the canvas click's default focus handling: when placing text
            // it would yank focus off the just-mounted text box (firing a blur
            // that prunes the empty element before a keystroke). Drawing uses
            // pointer events, which this doesn't affect; finishing a text edit
            // is handled by the next pointerdown / a toolbar blur instead.
            onMouseDown={(e) => e.preventDefault()}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onDoubleClick={(e) => {
              // Double-click a text element to re-edit it (any tool).
              const p = toScene(e.clientX, e.clientY);
              const hit = hitTest(scene, p.x, p.y, 8);
              const el = hit ? scene.elements.find((x) => x.id === hit) : null;
              if (el?.type === "text") startTextEdit(el);
            }}
          >
            {/* draft / moved-element preview, same serializer as committed */}
            {draft ? (
              <g dangerouslySetInnerHTML={{ __html: elementToSvg(draft) }} />
            ) : null}
            {movedEl ? (
              <g dangerouslySetInnerHTML={{ __html: elementToSvg(movedEl) }} />
            ) : null}
            {selBounds ? (
              <rect
                x={selBounds.x}
                y={selBounds.y}
                width={selBounds.w}
                height={selBounds.h}
                fill="none"
                stroke="var(--accent, #c8702a)"
                strokeWidth={2}
                strokeDasharray="6 4"
                vectorEffect="non-scaling-stroke"
                pointerEvents="none"
              />
            ) : null}
          </svg>

          {/* Text-edit overlay — an HTML textarea positioned over the element. */}
          {editingEl && scale > 0 ? (
            <textarea
              ref={focusText}
              value={textValue}
              onChange={(e) => setTextValue(e.target.value)}
              onBlur={finishTextEdit}
              onKeyDown={(e) => {
                if (e.key === "Escape" || (e.key === "Enter" && (e.metaKey || e.ctrlKey))) {
                  e.preventDefault();
                  finishTextEdit();
                }
              }}
              className="absolute z-10 resize-none overflow-hidden border-none bg-transparent p-0 leading-tight outline-none"
              style={{
                left: editingEl.x * scale,
                top: editingEl.y * scale,
                width: Math.max(120, (DRAW_W - editingEl.x) * scale),
                fontSize: editingEl.fontSize * scale,
                fontFamily:
                  "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
                color: editingEl.color,
                lineHeight: 1.25,
              }}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}

// ---- pure shape helpers (kept local; the scene module stays tool/gesture-
// agnostic — no React, no pointer logic) ------------------------------------

function round(n: number): number {
  return Math.round(n * 10) / 10;
}

// The four tools that drag out a 2-point shape. Excludes select/pen/text/eraser
// — onPointerDown handles those and returns before reaching makeShape, so the
// helper's domain is exactly these four (no silent rect fabrication for others).
type ShapeTool = "rect" | "ellipse" | "line" | "arrow";

function makeShape(
  tool: ShapeTool,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  stroke: string,
  strokeWidth: number,
  fillEnabled: boolean,
): DrawElement {
  const id = genId();
  if (tool === "line" || tool === "arrow") {
    return { id, type: tool, x1, y1, x2, y2, stroke, strokeWidth };
  }
  // rect / ellipse
  return {
    id,
    type: tool === "ellipse" ? "ellipse" : "rect",
    x: x1,
    y: y1,
    w: x2 - x1,
    h: y2 - y1,
    stroke,
    strokeWidth,
    fill: fillEnabled ? `${stroke}33` : "none",
  };
}

function updateShape(
  d: DrawElement,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): DrawElement {
  if (d.type === "line" || d.type === "arrow") {
    return { ...d, x1, y1, x2, y2 };
  }
  if (d.type === "rect" || d.type === "ellipse") {
    return { ...d, x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
  }
  return d;
}

// Keep-or-discard a just-finished draft on pointer-up: drop a click-without-drag
// for shapes/lines (avoids zero-size ghosts), keep a freehand with ≥2 points (a
// single-tap dot still carries 2 coords). Text never reaches here — the text
// tool commits in onPointerDown without setting a gesture — so its case is
// defensive, kept only so the switch stays exhaustive over DrawElement.
function isWorthKeeping(d: DrawElement): boolean {
  switch (d.type) {
    case "freehand":
      return d.points.length >= 2;
    case "line":
    case "arrow":
      return Math.hypot(d.x2 - d.x1, d.y2 - d.y1) >= 4;
    case "rect":
    case "ellipse":
      return Math.abs(d.w) >= 4 && Math.abs(d.h) >= 4;
    case "text":
      return d.text.trim().length > 0;
  }
}

// ---- history reducer (pure) -----------------------------------------------
// One pure transition per commit/undo/redo so React may re-invoke it (under
// StrictMode / concurrent rendering) without double-pushing history entries.
type HistoryState = { scene: DrawScene; past: DrawScene[]; future: DrawScene[] };
type HistoryAction =
  | { type: "commit"; producer: (s: DrawScene) => DrawScene }
  | { type: "undo" }
  | { type: "redo" };

const HISTORY_LIMIT = 120;

function historyReducer(state: HistoryState, action: HistoryAction): HistoryState {
  switch (action.type) {
    case "commit": {
      const next = action.producer(state.scene);
      if (next === state.scene) return state; // no-op edit → no history step
      return {
        scene: next,
        past: [...state.past, state.scene].slice(-HISTORY_LIMIT),
        future: [],
      };
    }
    case "undo": {
      if (state.past.length === 0) return state;
      return {
        scene: state.past[state.past.length - 1],
        past: state.past.slice(0, -1),
        future: [state.scene, ...state.future],
      };
    }
    case "redo": {
      if (state.future.length === 0) return state;
      return {
        scene: state.future[0],
        past: [...state.past, state.scene],
        future: state.future.slice(1),
      };
    }
  }
}

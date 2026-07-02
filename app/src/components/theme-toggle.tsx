"use client";

import { useEffect, useSyncExternalStore } from "react";
import { cn } from "@/lib/utils";

export type ThemeChoice = "system" | "light" | "dark";

const STORAGE_KEY = "canvas-theme";

/** Read the persisted choice; falls back to "system" when storage is empty
 * or unavailable (SSR, private browsing). Kept outside the component so the
 * boot script in `layout.tsx` and this hook stay in lockstep on the key. */
function readStoredTheme(): ThemeChoice {
  if (typeof window === "undefined") return "system";
  try {
    const v = window.localStorage.getItem(STORAGE_KEY);
    if (v === "light" || v === "dark" || v === "system") return v;
  } catch {
    /* ignore */
  }
  return "system";
}

/** Apply a theme choice to <html> by toggling the `dark` class. "system"
 * resolves against `prefers-color-scheme` at call time. The boot script
 * in `app/layout.tsx` runs the same logic before hydration to avoid FOUC. */
function applyTheme(theme: ThemeChoice) {
  if (typeof window === "undefined") return;
  const root = document.documentElement;
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const dark = theme === "dark" || (theme === "system" && prefersDark);
  root.classList.toggle("dark", dark);
}

// useSyncExternalStore plumbing — localStorage is an external store, so we
// read it via the official primitive rather than mirroring it into useState
// (which would trip the react-hooks/set-state-in-effect lint). The
// `subscribe` arg is required by the API even though localStorage doesn't
// fire change events for our same-tab writes — we trigger re-renders by
// calling `notify()` ourselves after writing.
const listeners = new Set<() => void>();
function subscribeTheme(cb: () => void) {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}
function notifyThemeChange() {
  for (const cb of listeners) cb();
}

function SunIcon({ className }: { className?: string }) {
  return (
    <svg width="13" height="13" viewBox="0 0 13 13" fill="none" aria-hidden className={className}>
      <circle cx="6.5" cy="6.5" r="2.25" stroke="currentColor" strokeWidth="1.2" />
      <path
        d="M6.5 1.5V2.5M6.5 10.5V11.5M11.5 6.5H10.5M2.5 6.5H1.5M10.04 2.96L9.33 3.67M3.67 9.33L2.96 10.04M10.04 10.04L9.33 9.33M3.67 3.67L2.96 2.96"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
    </svg>
  );
}

function MoonIcon({ className }: { className?: string }) {
  return (
    <svg width="13" height="13" viewBox="0 0 13 13" fill="none" aria-hidden className={className}>
      <path
        d="M10.5 7.5C10.05 8.45 9.05 9.1 7.9 9.1C6.3 9.1 5 7.8 5 6.2C5 5.05 5.65 4.05 6.6 3.6C6.5 3.6 6.4 3.59 6.3 3.59C4.36 3.59 2.8 5.15 2.8 7.09C2.8 9.03 4.36 10.59 6.3 10.59C8.05 10.59 9.5 9.31 9.78 7.64C10.04 7.59 10.28 7.55 10.5 7.5Z"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function MonitorIcon({ className }: { className?: string }) {
  return (
    <svg width="13" height="13" viewBox="0 0 13 13" fill="none" aria-hidden className={className}>
      <rect
        x="2"
        y="3"
        width="9"
        height="6"
        rx="1"
        stroke="currentColor"
        strokeWidth="1.2"
      />
      <path d="M5 11H8M6.5 9V11" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}

/** Tri-state theme segmented control. Renders inside the user menu so it
 * sits next to "MCP setup" / "Sign out". Persists to localStorage under
 * `canvas-theme` and reapplies immediately on selection. */
export function ThemeToggle() {
  // useSyncExternalStore returns "system" on the server (the third arg) and
  // the real persisted value on the client. The boot script in layout.tsx
  // has already applied the correct `dark` class to <html>, so even though
  // this component renders "system" on the server pass, the visible UI is
  // already correct by the time hydration runs.
  const theme = useSyncExternalStore<ThemeChoice>(
    subscribeTheme,
    readStoredTheme,
    () => "system",
  );

  // Keep `dark` class in sync with the OS preference when the user picks
  // "system". No-ops in light/dark modes.
  useEffect(() => {
    if (theme !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => applyTheme("system");
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [theme]);

  function choose(next: ThemeChoice) {
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* ignore */
    }
    applyTheme(next);
    notifyThemeChange();
  }

  const options: { value: ThemeChoice; label: string; Icon: typeof SunIcon }[] = [
    { value: "system", label: "System", Icon: MonitorIcon },
    { value: "light", label: "Light", Icon: SunIcon },
    { value: "dark", label: "Dark", Icon: MoonIcon },
  ];

  return (
    <div className="px-2 py-1.5">
      <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        Theme
      </div>
      <div
        role="group"
        aria-label="Theme"
        onKeyDown={(event) => {
          if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
            return;
          }
          event.preventDefault();
          const current = options.findIndex((option) => option.value === theme);
          const next =
            event.key === "Home"
              ? 0
              : event.key === "End"
                ? options.length - 1
                : (current + (event.key === "ArrowRight" ? 1 : -1) + options.length) %
                  options.length;
          const value = options[next].value;
          choose(value);
          requestAnimationFrame(() =>
            document.querySelector<HTMLElement>(`[data-theme-choice="${value}"]`)?.focus(),
          );
        }}
        className="flex items-center gap-0.5 rounded-md border border-border bg-fog p-0.5"
      >
        {options.map((opt) => {
          const selected = theme === opt.value;
          return (
            <button
              key={opt.value}
              type="button"
              role="menuitemradio"
              aria-checked={selected}
              tabIndex={selected ? 0 : -1}
              data-theme-choice={opt.value}
              onClick={() => choose(opt.value)}
              className={cn(
                "flex flex-1 items-center justify-center gap-1.5 rounded-[5px] px-1.5 py-1 text-[11px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                selected
                  ? "bg-paper text-foreground shadow-[0_1px_2px_rgba(14,26,43,0.06)]"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <opt.Icon className="shrink-0" />
              <span>{opt.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// Workspace-layout preferences: whether the deck editor's two permanent rails
// (slide list on the left, Activity + Ask agent on the right) are shown at
// lg+. Per browser, not per deck — hiding a rail is a "how I like my editor"
// choice (à la Cursor / VS Code panel toggles), not deck state.
//
// Components read these via useSyncExternalStore — the theme-toggle pattern;
// mirroring localStorage into useState would trip
// react-hooks/set-state-in-effect. localStorage fires no events for same-tab
// writes, so the writer notifies subscribers itself.

export type RailSide = "slides" | "activity";

const KEYS: Record<RailSide, string> = {
  slides: "canvas:deck:slide-rail",
  activity: "canvas:deck:activity-rail",
};

const listeners = new Set<() => void>();

export function subscribeRailPrefs(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

// Open on the server pass and when storage is blocked (private mode) —
// visible rails are the safe default, and a toolbar toggle is always there
// to close them again.
export function readRailOpen(side: RailSide): boolean {
  try {
    return window.localStorage.getItem(KEYS[side]) !== "closed";
  } catch {
    return true;
  }
}

export function setRailOpen(side: RailSide, open: boolean): void {
  try {
    window.localStorage.setItem(KEYS[side], open ? "open" : "closed");
  } catch {
    /* ignore — worst case the preference doesn't survive a reload */
  }
  reconcileRailPrefs();
}

// Re-notify every subscriber so useSyncExternalStore re-reads the client
// snapshot. Needed once after mount: React keeps the getServerSnapshot value
// ("open") through hydration and only re-reads when the store notifies —
// verified on Next 16.2 / React 19.2, where a persisted "closed" otherwise
// doesn't apply until the first manual toggle.
export function reconcileRailPrefs(): void {
  for (const cb of listeners) cb();
}

export function toggleRail(side: RailSide): void {
  setRailOpen(side, !readRailOpen(side));
}

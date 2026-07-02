import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// The bridge reports its version (bridge/package.json) to Canvas on every poll;
// the chatbox compares it against a pinned LATEST_BRIDGE_VERSION in assistant-panel
// to decide whether a running bridge is outdated (migration 0051). The two MUST
// agree — scripts/release-bridge.mjs bumps both, and this guard fails CI if a hand
// edit moves only one.

const here = dirname(fileURLToPath(import.meta.url));

describe("bridge version pin", () => {
  it("LATEST_BRIDGE_VERSION matches bridge/package.json", () => {
    const pkg = JSON.parse(
      readFileSync(join(here, "../../bridge/package.json"), "utf8"),
    ) as { version: string };

    const panel = readFileSync(
      join(here, "../src/app/canvases/[id]/assistant-panel.tsx"),
      "utf8",
    );
    const m = panel.match(/const LATEST_BRIDGE_VERSION = "([^"]*)";/);
    expect(m, "LATEST_BRIDGE_VERSION pin not found in assistant-panel.tsx").not.toBeNull();
    expect(m![1]).toBe(pkg.version);
  });
});

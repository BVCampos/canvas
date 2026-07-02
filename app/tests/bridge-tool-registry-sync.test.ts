import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { toolDescriptors } from "../src/lib/canvas/mcp/tools";

const here = dirname(fileURLToPath(import.meta.url));

describe("local bridge MCP allowlist", () => {
  it("contains every advertised Canvas tool and no stale names", () => {
    const source = readFileSync(join(here, "../../bridge/canvas-agent.mjs"), "utf8");
    const block = source.match(/const CANVAS_TOOLS = \[([\s\S]*?)\n\];/);
    expect(block, "CANVAS_TOOLS array not found in bridge").not.toBeNull();
    const bridgeNames = Array.from(
      block![1].matchAll(/"([a-z0-9_]+)"/g),
      (match) => match[1],
    ).sort();
    const serverNames = toolDescriptors.map((tool) => tool.name).sort();
    expect(bridgeNames).toEqual(serverNames);
  });
});


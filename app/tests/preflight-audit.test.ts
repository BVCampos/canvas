import { describe, expect, it } from "vitest";
import { classifyFindings } from "@/lib/canvas/preflight-audit";

describe("classifyFindings", () => {
  it("maps DOM findings to blockers and runtime signals to warnings", () => {
    const out = classifyFindings({
      dom: [
        {
          kind: "overflow",
          position: 3,
          descriptor: "p.body “Long paragraph”",
          message: "Text is clipped by its box (40px cut off)",
        },
        {
          kind: "broken_image",
          position: 1,
          descriptor: "https://cdn.example.com/dead.png",
          message: "Image failed to load",
        },
      ],
      pageErrors: ["ReferenceError: initCharts is not defined"],
      consoleErrors: [],
      failedRequests: ["https://cdn.example.com/dead.png"],
    });

    expect(out.map((f) => f.check)).toEqual([
      "broken_image", // blockers first, slide order within
      "overflow",
      "page_error",
      "request_failed",
    ]);
    expect(out[0].severity).toBe("blocker");
    expect(out[2].severity).toBe("warning");
    expect(out[2].position).toBeNull(); // runtime signals are deck-level
  });

  it("dedupes repeated runtime messages", () => {
    const out = classifyFindings({
      dom: [],
      pageErrors: [],
      consoleErrors: ["boom", "boom", "boom"],
      failedRequests: [],
    });
    expect(out).toHaveLength(1);
  });

  it("returns an empty list for a clean deck", () => {
    expect(
      classifyFindings({ dom: [], pageErrors: [], consoleErrors: [], failedRequests: [] }),
    ).toEqual([]);
  });

  it("truncates unbounded detail strings", () => {
    const out = classifyFindings({
      dom: [],
      pageErrors: ["x".repeat(2000)],
      consoleErrors: [],
      failedRequests: [],
    });
    expect(out[0].detail!.length).toBeLessThanOrEqual(300);
  });
});

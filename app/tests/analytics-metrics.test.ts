// Unit tests for the analytics aggregation core
// (src/app/settings/analytics/metrics.ts).
//
// No Supabase, no Next, no database — synthetic rows in, metrics object out.
// This is the part of the dashboard that's worth pinning down: percentile
// math, the activation funnel distinct-user counts, proposal outcome rates,
// and the patch-vs-rewrite mix.

import { describe, expect, it } from "vitest";
import {
  computeAnalytics,
  percentile,
  formatRate,
  formatMs,
  formatRatio,
  isoDaysAgo,
  type UsageRow,
} from "../src/app/settings/analytics/metrics";

// Fixed clock so the 7d/30d windows are deterministic.
const NOW = Date.parse("2026-06-21T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

function daysAgo(n: number): string {
  return new Date(NOW - n * DAY).toISOString();
}

// Row builder with sane defaults; override per test.
function row(partial: Partial<UsageRow>): UsageRow {
  return {
    event: "mcp.tool_call",
    surface: "mcp",
    status: "ok",
    user_id: "u1",
    duration_ms: null,
    created_at: daysAgo(1),
    props: {},
    ...partial,
  };
}

describe("percentile (nearest-rank)", () => {
  it("returns null for an empty sample", () => {
    expect(percentile([], 0.5)).toBeNull();
  });

  it("p50 of a 3-element sample is the middle", () => {
    expect(percentile([10, 20, 30], 0.5)).toBe(20);
  });

  it("p95 of 1..100 is 95", () => {
    const s = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(s, 0.95)).toBe(95);
  });

  it("p0 and p1 clamp to min and max", () => {
    expect(percentile([5, 1, 9, 3], 0)).toBe(1);
    expect(percentile([5, 1, 9, 3], 1)).toBe(9);
  });

  it("is order-independent (sorts internally)", () => {
    expect(percentile([30, 10, 20], 0.5)).toBe(20);
  });

  it("ignores non-finite values", () => {
    expect(percentile([10, NaN, 20, Infinity, 30], 0.5)).toBe(20);
  });
});

describe("activation funnel", () => {
  it("counts distinct users per stage and computes conversion rates", () => {
    const rows: UsageRow[] = [
      // 4 users mint a token; u1 mints twice (de-duped to one).
      row({ event: "mcp_token.create", user_id: "u1" }),
      row({ event: "mcp_token.create", user_id: "u1" }),
      row({ event: "mcp_token.create", user_id: "u2" }),
      row({ event: "mcp_token.create", user_id: "u3" }),
      row({ event: "mcp_token.create", user_id: "u4" }),
      // 2 of them connect.
      row({ event: "activation.first_token_use", user_id: "u1" }),
      row({ event: "activation.first_token_use", user_id: "u2" }),
      // 1 reaches a first approved edit.
      row({ event: "activation.first_approved_edit", user_id: "u1" }),
    ];
    const { funnel } = computeAnalytics(rows, NOW);
    expect(funnel.tokensMinted).toBe(4);
    expect(funnel.firstConnect).toBe(2);
    expect(funnel.firstApprovedEdit).toBe(1);
    expect(funnel.mintToConnectRate).toBeCloseTo(2 / 4);
    expect(funnel.connectToEditRate).toBeCloseTo(1 / 2);
    expect(funnel.overallRate).toBeCloseTo(1 / 4);
  });

  it("returns null rates when a denominator is zero", () => {
    const { funnel } = computeAnalytics([], NOW);
    expect(funnel.tokensMinted).toBe(0);
    expect(funnel.mintToConnectRate).toBeNull();
    expect(funnel.connectToEditRate).toBeNull();
    expect(funnel.overallRate).toBeNull();
  });

  it("is lifetime, not windowed — counts activations older than 30 days", () => {
    const rows: UsageRow[] = [
      row({ event: "mcp_token.create", user_id: "u1", created_at: daysAgo(90) }),
      row({ event: "activation.first_token_use", user_id: "u1", created_at: daysAgo(89) }),
    ];
    const { funnel } = computeAnalytics(rows, NOW);
    expect(funnel.tokensMinted).toBe(1);
    expect(funnel.firstConnect).toBe(1);
  });

  it("ignores rows with no user_id", () => {
    const rows: UsageRow[] = [
      row({ event: "mcp_token.create", user_id: null }),
    ];
    expect(computeAnalytics(rows, NOW).funnel.tokensMinted).toBe(0);
  });
});

describe("proposal outcomes", () => {
  it("counts approve/reject/withdraw and computes rates over their sum", () => {
    const rows: UsageRow[] = [
      row({ event: "proposal.approve", props: { edit_id: "e1" } }),
      row({ event: "proposal.approve", props: { edit_id: "e2" } }),
      row({ event: "proposal.approve", props: { edit_id: "e3" } }),
      row({ event: "proposal.reject", props: { edit_id: "e4" } }),
      row({ event: "proposal.withdraw", props: { edit_id: "e5" } }),
    ];
    const { last30d } = computeAnalytics(rows, NOW);
    expect(last30d.proposals.approve).toBe(3);
    expect(last30d.proposals.reject).toBe(1);
    expect(last30d.proposals.withdraw).toBe(1);
    expect(last30d.proposals.total).toBe(5);
    expect(last30d.proposals.approveRate).toBeCloseTo(3 / 5);
    expect(last30d.proposals.rejectRate).toBeCloseTo(1 / 5);
    expect(last30d.proposals.withdrawRate).toBeCloseTo(1 / 5);
  });

  it("de-dupes the same edit_id logged twice on the single-approve path", () => {
    const rows: UsageRow[] = [
      row({ event: "proposal.approve", props: { edit_id: "e1" } }),
      row({ event: "proposal.approve", props: { edit_id: "e1" } }), // duplicate log
    ];
    expect(computeAnalytics(rows, NOW).last30d.proposals.approve).toBe(1);
  });

  it("ignores non-ok proposal events", () => {
    const rows: UsageRow[] = [
      row({ event: "proposal.approve", status: "error", props: { edit_id: "e1" } }),
    ];
    expect(computeAnalytics(rows, NOW).last30d.proposals.approve).toBe(0);
  });

  it("returns null rates when there are no decisions", () => {
    const { last30d } = computeAnalytics([], NOW);
    expect(last30d.proposals.approveRate).toBeNull();
  });
});

describe("editing efficiency (patch vs full mix, proposals per landed edit)", () => {
  it("computes patchShare from propose_slide_patch vs propose_slide_edit", () => {
    const rows: UsageRow[] = [
      row({ props: { tool_name: "propose_slide_patch" } }),
      row({ props: { tool_name: "propose_slide_patch" } }),
      row({ props: { tool_name: "propose_slide_patch" } }),
      row({ props: { tool_name: "propose_slide_edit" } }),
    ];
    const { last30d } = computeAnalytics(rows, NOW);
    expect(last30d.efficiency.patchCount).toBe(3);
    expect(last30d.efficiency.fullEditCount).toBe(1);
    expect(last30d.efficiency.patchShare).toBeCloseTo(3 / 4);
  });

  it("computes proposals-per-landed-edit from propose_* calls over approvals + direct edits", () => {
    const rows: UsageRow[] = [
      // 6 authoring proposals proposed via MCP
      row({ props: { tool_name: "propose_slide_patch" } }),
      row({ props: { tool_name: "propose_slide_patch" } }),
      row({ props: { tool_name: "propose_slide_edit" } }),
      row({ props: { tool_name: "propose_new_slide" } }),
      row({ props: { tool_name: "propose_theme_edit" } }),
      row({ props: { tool_name: "propose_reorder_slides" } }),
      // 2 landed: 1 approval + 1 direct edit
      row({ event: "proposal.approve", props: { edit_id: "e1" } }),
      row({ event: "slide.direct_edit", surface: "action", props: { html_len: 100 } }),
    ];
    const { last30d } = computeAnalytics(rows, NOW);
    expect(last30d.efficiency.proposalsCreated).toBe(6);
    expect(last30d.efficiency.landedEdits).toBe(2);
    expect(last30d.efficiency.proposalsPerLandedEdit).toBeCloseTo(3.0);
  });

  it("does not count read-only tools as proposals", () => {
    const rows: UsageRow[] = [
      row({ props: { tool_name: "read_slide" } }),
      row({ props: { tool_name: "list_decks" } }),
      row({ props: { tool_name: "get_deck" } }),
    ];
    const { last30d } = computeAnalytics(rows, NOW);
    expect(last30d.efficiency.proposalsCreated).toBe(0);
  });

  it("patchShare is null when neither edit tool was used", () => {
    const rows: UsageRow[] = [row({ props: { tool_name: "propose_new_slide" } })];
    expect(computeAnalytics(rows, NOW).last30d.efficiency.patchShare).toBeNull();
  });
});

describe("weekly active editors (distinct users)", () => {
  it("counts distinct users who proposed, approved, or directly edited in the window", () => {
    const rows: UsageRow[] = [
      row({ user_id: "u1", props: { tool_name: "propose_slide_patch" } }),
      row({ user_id: "u1", props: { tool_name: "propose_slide_edit" } }), // same user
      row({ user_id: "u2", event: "proposal.approve", props: { edit_id: "e1" } }),
      row({ user_id: "u3", event: "slide.direct_edit", surface: "action", props: {} }),
      // read-only + auth users don't count
      row({ user_id: "u4", props: { tool_name: "read_slide" } }),
      row({ user_id: "u5", event: "auth.login", surface: "auth", props: {} }),
    ];
    const { last7d, last30d } = computeAnalytics(rows, NOW);
    expect(last7d.active.activeEditors).toBe(3);
    expect(last30d.active.activeEditors).toBe(3);
  });

  it("respects the 7-day window: an 8-day-old editor is out of 7d but in 30d", () => {
    const rows: UsageRow[] = [
      row({ user_id: "u1", props: { tool_name: "propose_slide_patch" }, created_at: daysAgo(8) }),
      row({ user_id: "u2", props: { tool_name: "propose_slide_patch" }, created_at: daysAgo(2) }),
    ];
    const { last7d, last30d } = computeAnalytics(rows, NOW);
    expect(last7d.active.activeEditors).toBe(1);
    expect(last30d.active.activeEditors).toBe(2);
  });
});

describe("latency buckets (p50/p95 of duration_ms)", () => {
  it("computes percentiles per heavy operation", () => {
    const patch = Array.from({ length: 10 }, (_, i) =>
      row({ props: { tool_name: "propose_slide_patch" }, duration_ms: (i + 1) * 100 }),
    );
    const exportRows = [
      row({ event: "deck.export", surface: "api", duration_ms: 5000 }),
      row({ event: "deck.export", surface: "api", duration_ms: 9000 }),
    ];
    const { last30d } = computeAnalytics([...patch, ...exportRows], NOW);
    const patchStat = last30d.latency.find((l) => l.label === "Slide patch")!;
    expect(patchStat.count).toBe(10);
    expect(patchStat.p50).toBe(500); // nearest-rank: ceil(0.5*10)=5 -> 5th = 500
    expect(patchStat.p95).toBe(1000); // ceil(0.95*10)=10 -> 10th = 1000

    const exportStat = last30d.latency.find((l) => l.label === "Deck export")!;
    expect(exportStat.count).toBe(2);
    expect(exportStat.p95).toBe(9000);
  });

  it("reports null percentiles and zero count for an empty bucket", () => {
    const { last30d } = computeAnalytics([], NOW);
    const stat = last30d.latency.find((l) => l.label === "Slide edit (full)")!;
    expect(stat.count).toBe(0);
    expect(stat.p50).toBeNull();
    expect(stat.p95).toBeNull();
  });

  it("excludes errored rows and negative durations", () => {
    const rows: UsageRow[] = [
      row({ props: { tool_name: "propose_slide_patch" }, duration_ms: 200, status: "error" }),
      row({ props: { tool_name: "propose_slide_patch" }, duration_ms: -5 }),
      row({ props: { tool_name: "propose_slide_patch" }, duration_ms: 300 }),
    ];
    const { last30d } = computeAnalytics(rows, NOW);
    const stat = last30d.latency.find((l) => l.label === "Slide patch")!;
    expect(stat.count).toBe(1);
    expect(stat.p50).toBe(300);
  });
});

describe("totalEvents and empty state", () => {
  it("reports the raw row count", () => {
    expect(computeAnalytics([row({}), row({})], NOW).totalEvents).toBe(2);
  });

  it("an empty dataset produces a fully-zeroed metrics object", () => {
    const m = computeAnalytics([], NOW);
    expect(m.totalEvents).toBe(0);
    expect(m.last7d.active.activeEditors).toBe(0);
    expect(m.last30d.proposals.total).toBe(0);
    expect(m.last30d.efficiency.landedEdits).toBe(0);
  });
});

describe("formatters", () => {
  it("formatRate renders percent or an em-free dash", () => {
    expect(formatRate(0.5)).toBe("50%");
    expect(formatRate(1)).toBe("100%");
    expect(formatRate(null)).toBe("—");
  });

  it("formatMs renders ms under 1s and seconds above", () => {
    expect(formatMs(250)).toBe("250 ms");
    expect(formatMs(1500)).toBe("1.5 s");
    expect(formatMs(12000)).toBe("12 s");
    expect(formatMs(null)).toBe("—");
  });

  it("formatRatio renders one decimal or a dash", () => {
    expect(formatRatio(2.41)).toBe("2.4");
    expect(formatRatio(null)).toBe("—");
  });
});

describe("isoDaysAgo (query lower bound)", () => {
  it("returns an ISO timestamp exactly N days before the given now", () => {
    expect(isoDaysAgo(30, NOW)).toBe(new Date(NOW - 30 * DAY).toISOString());
    expect(isoDaysAgo(7, NOW)).toBe(new Date(NOW - 7 * DAY).toISOString());
  });
});

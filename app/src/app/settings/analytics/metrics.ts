// Pure aggregation over canvas_usage_event rows.
//
// This module has NO Supabase / Next imports on purpose: it's the
// verifiable core of the analytics dashboard. The page fetches rows via
// the admin client (after gating on role) and hands them straight here;
// every metric below is a deterministic function of (rows, now) so the
// percentile math, funnel counts, and rate arithmetic can be unit-tested
// with synthetic rows and no database (see app/tests/analytics-metrics.test.ts).
//
// Event names are keyed off what's actually emitted by the logger call
// sites (grep `event:` in app/src). The ones we read:
//   - mcp.tool_call            props.tool_name distinguishes propose_slide_patch
//                              vs propose_slide_edit vs propose_new_slide, plus
//                              size signals (edits_count, html_body_len). MCP surface.
//   - slide.direct_edit        a human typing in the editor (non-proposal landed edit).
//   - proposal.approve         a proposal landed (props.edit_kind, props.bulk).
//   - proposal.reject / .withdraw / .revert  the other proposal outcomes.
//   - mcp_token.create         a personal MCP token minted (funnel step 1).
//   - activation.first_token_use     first time a user's token actually connected (step 2).
//   - activation.first_approved_edit first approved edit by that user (step 3).
//   - deck.export              a deck exported (latency-heavy operation).

export type UsageRow = {
  event: string;
  surface: string;
  status: string;
  user_id: string | null;
  duration_ms: number | null;
  created_at: string; // ISO timestamp
  props: Record<string, unknown> | null;
};

// The proposal authoring tools we treat as "an edit was proposed". Anything
// that mutates slide/theme/deck content. Read-only tools (read_slide,
// list_*, get_*) and lock/release are excluded — they aren't authoring.
const PROPOSE_TOOL_NAMES = new Set([
  "propose_slide_patch",
  "propose_slide_edit",
  "propose_new_slide",
  "propose_delete_slide",
  "propose_duplicate_slide",
  "propose_reorder_slides",
  "propose_theme_edit",
  "propose_deck_edit",
]);

// The two patch-vs-rewrite tools we want the mix for. A patch is a small
// find/replace; a full edit replaces the whole slide body. The ratio is the
// "is Claude editing surgically or rewriting" signal from the editing-10x work.
const PATCH_TOOL = "propose_slide_patch";
const FULL_EDIT_TOOL = "propose_slide_edit";

export type StatCounts = {
  /** distinct user_ids that did something in the window */
  activeEditors: number;
};

export type ActivationFunnel = {
  tokensMinted: number; // distinct users who minted at least one MCP token
  firstConnect: number; // distinct users who reached activation.first_token_use
  firstApprovedEdit: number; // distinct users who reached activation.first_approved_edit
  // Conversion rates as 0..1 fractions. mintToConnect is connect/minted;
  // connectToEdit is edit/connect; overall is edit/minted. Null when the
  // denominator is 0 (avoid a misleading 0% or NaN).
  mintToConnectRate: number | null;
  connectToEditRate: number | null;
  overallRate: number | null;
};

export type ProposalOutcomes = {
  approve: number;
  reject: number;
  withdraw: number;
  revert: number;
  total: number; // approve + reject + withdraw (the three terminal decisions; revert is post-approval)
  approveRate: number | null; // approve / total
  rejectRate: number | null; // reject / total
  withdrawRate: number | null; // withdraw / total
};

export type EditingEfficiency = {
  proposalsCreated: number; // mcp.tool_call ok with a PROPOSE_TOOL_NAMES tool_name
  landedEdits: number; // proposal.approve (non-bulk-double-count) + slide.direct_edit
  proposalsPerLandedEdit: number | null; // proposalsCreated / landedEdits
  patchCount: number; // propose_slide_patch calls
  fullEditCount: number; // propose_slide_edit calls
  // patch / (patch + full). 1.0 = all surgical patches, 0 = all rewrites.
  // Null when neither tool was used in the window.
  patchShare: number | null;
};

export type LatencyStat = {
  label: string;
  count: number;
  p50: number | null;
  p95: number | null;
};

export type WindowMetrics = {
  windowDays: number;
  active: StatCounts;
  proposals: ProposalOutcomes;
  efficiency: EditingEfficiency;
  latency: LatencyStat[];
};

export type AnalyticsMetrics = {
  // Computed once over the full row set; the funnel is lifetime-to-date
  // (activation is a one-time-per-user event, so a rolling window would
  // under-count users who activated before the window opened).
  funnel: ActivationFunnel;
  last30d: WindowMetrics;
  last7d: WindowMetrics;
  totalEvents: number;
};

// --- helpers -------------------------------------------------------------

function withinDays(row: UsageRow, now: number, days: number): boolean {
  const t = Date.parse(row.created_at);
  if (Number.isNaN(t)) return false;
  const cutoff = now - days * 24 * 60 * 60 * 1000;
  return t >= cutoff && t <= now;
}

function toolName(row: UsageRow): string | null {
  const n = row.props?.tool_name;
  return typeof n === "string" ? n : null;
}

function distinctUsers(rows: UsageRow[]): number {
  const set = new Set<string>();
  for (const r of rows) if (r.user_id) set.add(r.user_id);
  return set.size;
}

function rate(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  return numerator / denominator;
}

// Nearest-rank percentile over a numeric sample. p in [0,1]. Returns null
// for an empty sample. Sorted ascending; the rank is ceil(p * n) clamped to
// [1, n], 1-indexed. p50 of [10,20,30] = 20; p95 of a 100-sample = the 95th.
// Nearest-rank (not linear interpolation) keeps it dependency-free and is the
// honest "a real observed request was at least this slow" reading for latency.
export function percentile(samples: number[], p: number): number | null {
  const clean = samples
    .filter((n) => typeof n === "number" && Number.isFinite(n))
    .sort((a, b) => a - b);
  if (clean.length === 0) return null;
  if (p <= 0) return clean[0];
  if (p >= 1) return clean[clean.length - 1];
  const rank = Math.ceil(p * clean.length);
  const idx = Math.min(clean.length, Math.max(1, rank)) - 1;
  return clean[idx];
}

// --- per-window aggregation ---------------------------------------------

function activeEditors(rows: UsageRow[]): StatCounts {
  // "Active editor" = a distinct user who did real authoring work: a propose_*
  // tool call, a landed proposal approval, or a direct in-app slide edit. Read
  // tools and auth events don't count toward activity.
  const active = rows.filter((r) => {
    if (r.event === "proposal.approve" && r.status === "ok") return true;
    if (r.event === "slide.direct_edit" && r.status === "ok") return true;
    if (r.event === "mcp.tool_call" && r.status === "ok") {
      const n = toolName(r);
      return n !== null && PROPOSE_TOOL_NAMES.has(n);
    }
    return false;
  });
  return { activeEditors: distinctUsers(active) };
}

function proposalOutcomes(rows: UsageRow[]): ProposalOutcomes {
  // proposal.approve is logged twice on the single-approve path (a pre-write
  // "ok" guard log and the final log) in some call sites, and once-per-edit on
  // the bulk path. We count each distinct edit_id once per event type to avoid
  // double-counting the same decision. Falling back to the raw row when there's
  // no edit_id keeps synthetic/edge rows countable.
  const seen: Record<string, Set<string>> = {
    approve: new Set(),
    reject: new Set(),
    withdraw: new Set(),
    revert: new Set(),
  };
  let approve = 0;
  let reject = 0;
  let withdraw = 0;
  let revert = 0;

  const bump = (key: keyof typeof seen, row: UsageRow): boolean => {
    const editId = row.props?.edit_id;
    if (typeof editId === "string") {
      if (seen[key].has(editId)) return false;
      seen[key].add(editId);
    }
    return true;
  };

  for (const r of rows) {
    if (r.status !== "ok") continue;
    switch (r.event) {
      case "proposal.approve":
        if (bump("approve", r)) approve++;
        break;
      case "proposal.reject":
        if (bump("reject", r)) reject++;
        break;
      case "proposal.withdraw":
        if (bump("withdraw", r)) withdraw++;
        break;
      case "proposal.revert":
        if (bump("revert", r)) revert++;
        break;
    }
  }

  const total = approve + reject + withdraw;
  return {
    approve,
    reject,
    withdraw,
    revert,
    total,
    approveRate: rate(approve, total),
    rejectRate: rate(reject, total),
    withdrawRate: rate(withdraw, total),
  };
}

function editingEfficiency(
  rows: UsageRow[],
  outcomes: ProposalOutcomes,
): EditingEfficiency {
  let proposalsCreated = 0;
  let patchCount = 0;
  let fullEditCount = 0;
  let directEdits = 0;

  for (const r of rows) {
    if (r.status !== "ok") continue;
    if (r.event === "slide.direct_edit") {
      directEdits++;
      continue;
    }
    if (r.event !== "mcp.tool_call") continue;
    const n = toolName(r);
    if (n === null) continue;
    if (PROPOSE_TOOL_NAMES.has(n)) proposalsCreated++;
    if (n === PATCH_TOOL) patchCount++;
    if (n === FULL_EDIT_TOOL) fullEditCount++;
  }

  // A "landed edit" is something that actually changed the deck: an approved
  // proposal or a direct in-app edit. proposalsPerLandedEdit > 1 means Claude
  // proposed more than once per change that stuck (the editing-10x churn signal).
  const landedEdits = outcomes.approve + directEdits;
  const patchPlusFull = patchCount + fullEditCount;

  return {
    proposalsCreated,
    landedEdits,
    proposalsPerLandedEdit: rate(proposalsCreated, landedEdits),
    patchCount,
    fullEditCount,
    patchShare: rate(patchCount, patchPlusFull),
  };
}

// Latency buckets we care about, keyed by an event-and-tool predicate. We
// report the heaviest operations: surgical patches, full-slide rewrites, and
// deck export (the PDF/HTML render path, historically the slowest route).
const LATENCY_BUCKETS: { label: string; match: (r: UsageRow) => boolean }[] = [
  {
    label: "Slide patch",
    match: (r) => r.event === "mcp.tool_call" && toolName(r) === PATCH_TOOL,
  },
  {
    label: "Slide edit (full)",
    match: (r) => r.event === "mcp.tool_call" && toolName(r) === FULL_EDIT_TOOL,
  },
  {
    label: "Deck export",
    match: (r) => r.event === "deck.export",
  },
];

function latency(rows: UsageRow[]): LatencyStat[] {
  return LATENCY_BUCKETS.map(({ label, match }) => {
    const samples = rows
      .filter((r) => r.status === "ok" && match(r))
      .map((r) => r.duration_ms)
      .filter((d): d is number => typeof d === "number" && d >= 0);
    return {
      label,
      count: samples.length,
      p50: percentile(samples, 0.5),
      p95: percentile(samples, 0.95),
    };
  });
}

function windowMetrics(allRows: UsageRow[], now: number, days: number): WindowMetrics {
  const rows = allRows.filter((r) => withinDays(r, now, days));
  const proposals = proposalOutcomes(rows);
  return {
    windowDays: days,
    active: activeEditors(rows),
    proposals,
    efficiency: editingEfficiency(rows, proposals),
    latency: latency(rows),
  };
}

// --- lifetime activation funnel -----------------------------------------

function activationFunnel(rows: UsageRow[]): ActivationFunnel {
  // Each stage counts DISTINCT users, lifetime-to-date. activation.* events are
  // emitted exactly once per user (the first time they happen), so distinct-user
  // and raw-count agree for those; mcp_token.create can fire many times per user
  // (re-minting), so we de-dupe to "users who ever minted".
  const minted = new Set<string>();
  const connected = new Set<string>();
  const edited = new Set<string>();

  for (const r of rows) {
    if (!r.user_id) continue;
    if (r.event === "mcp_token.create" && r.status === "ok") minted.add(r.user_id);
    else if (r.event === "activation.first_token_use") connected.add(r.user_id);
    else if (r.event === "activation.first_approved_edit") edited.add(r.user_id);
  }

  const tokensMinted = minted.size;
  const firstConnect = connected.size;
  const firstApprovedEdit = edited.size;

  return {
    tokensMinted,
    firstConnect,
    firstApprovedEdit,
    mintToConnectRate: rate(firstConnect, tokensMinted),
    connectToEditRate: rate(firstApprovedEdit, firstConnect),
    overallRate: rate(firstApprovedEdit, tokensMinted),
  };
}

/**
 * The single entry point. Takes every workspace-scoped usage row and the
 * current time, returns the full metrics object the page renders. `now` is
 * injected (not read from Date.now inside) so the windows are testable.
 */
export function computeAnalytics(rows: UsageRow[], now: number = Date.now()): AnalyticsMetrics {
  return {
    funnel: activationFunnel(rows),
    last30d: windowMetrics(rows, now, 30),
    last7d: windowMetrics(rows, now, 7),
    totalEvents: rows.length,
  };
}

// --- presentation helpers (pure, so they're testable too) ----------------

/** Format a 0..1 rate as a percent string, or an em-free dash when null. */
export function formatRate(r: number | null): string {
  if (r === null) return "—";
  return `${Math.round(r * 100)}%`;
}

/** Format a duration in ms as a compact human string. null -> dash. */
export function formatMs(ms: number | null): string {
  if (ms === null) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)} s`;
}

/** Format a ratio like 2.4 with one decimal, or dash when null. */
export function formatRatio(r: number | null): string {
  if (r === null) return "—";
  return r.toFixed(1);
}

/**
 * Wall-clock helpers that live here (not inline in the Server Component) on
 * purpose: React 19's purity lint rule flags a bare `Date.now()` / `new Date()`
 * during render, but a call into a plain module is fine. The page uses these to
 * derive its query cutoff and the aggregation clock from one consistent instant.
 */
export function nowMs(): number {
  return Date.now();
}

/** ISO timestamp for `days` ago relative to `now`. Used as the query lower bound. */
export function isoDaysAgo(days: number, now: number = Date.now()): string {
  return new Date(now - days * 24 * 60 * 60 * 1000).toISOString();
}

import { notFound } from "next/navigation";
import { getActiveWorkspace } from "@/lib/auth/workspace";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  computeAnalytics,
  formatMs,
  formatRate,
  formatRatio,
  isoDaysAgo,
  nowMs,
  type AnalyticsMetrics,
  type UsageRow,
} from "./metrics";

// /settings/analytics — owner/admin only.
//
// Makes the activation/usage funnel visible over canvas_usage_event. The data
// has been written and indexed since migration 0014 but nothing read it; this
// is the first reader. We deliberately compute every aggregate in TypeScript
// (see ./metrics) rather than in SQL so the math is unit-testable without a
// database — the page is a thin shell around computeAnalytics().
//
// Gating mirrors /settings/members exactly: the page's own role check is the
// security boundary, which is what lets us read through the service-role admin
// client. canvas_usage_event's RLS already restricts authenticated reads to
// workspace admins/owners, but we go through the admin client so the read isn't
// silently filtered by the actor's row visibility (the same reason members/
// reads the roster through admin).

// The events table is append-only and unbounded; we only ever chart the last
// 30 days, so cap the read at the 30-day window plus a generous row ceiling.
// Supabase's default select cap is 1000 rows — we page explicitly to gather
// the whole window without surprising truncation, but stop at a hard ceiling
// so a busy workspace can't make this page unbounded.
const WINDOW_DAYS = 30;
const PAGE_SIZE = 1000;
const MAX_ROWS = 50_000;

export default async function AnalyticsSettingsPage() {
  const { workspace, role } = await getActiveWorkspace("/settings/analytics");
  if (role !== "owner" && role !== "admin") {
    // notFound (not redirect) keeps the URL stable for the back button if they
    // re-acquire admin later — same rationale as members/.
    notFound();
  }

  const admin = createAdminClient();

  // One clock instant for the whole render: the query lower bound and the
  // aggregation window both derive from `now`, so they can't drift. The read
  // goes through nowMs() in metrics.ts rather than a bare Date.now() here
  // because React 19's purity rule flags clock reads during a Server
  // Component's render (a plain module call is fine).
  const now = nowMs();
  const since = isoDaysAgo(WINDOW_DAYS, now);

  // Page through the window. The (workspace_id, created_at desc) index
  // (migration 0014) serves this range scan directly. `since` is an absolute
  // ISO timestamp, which PostgREST casts to timestamptz cleanly.
  const rows: UsageRow[] = [];
  for (let offset = 0; offset < MAX_ROWS; offset += PAGE_SIZE) {
    const { data, error } = await admin
      .from("canvas_usage_event")
      .select("event, surface, status, user_id, duration_ms, created_at, props")
      .eq("workspace_id", workspace.id)
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .range(offset, offset + PAGE_SIZE - 1);
    if (error || !data || data.length === 0) break;
    rows.push(...(data as UsageRow[]));
    if (data.length < PAGE_SIZE) break;
  }

  const metrics = computeAnalytics(rows, now);
  const hasData = metrics.totalEvents > 0;

  // Proposal source split: which proposals came from the in-app Ask-Claude
  // assistant vs a terminal Claude Code / MCP session. The discriminator is
  // canvas_deck_edit.assistant_message_id (set by assistant runtimes, migration
  // 0043, immutable). The team is actively trying to measure whether the in-app
  // assistant is being adopted; this is the cheap, exact answer. Two head-count
  // queries over the same window as the rest of the page.
  const [inAppRes, terminalRes] = await Promise.all([
    admin
      .from("canvas_deck_edit")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", workspace.id)
      .gte("created_at", since)
      .not("assistant_message_id", "is", null),
    admin
      .from("canvas_deck_edit")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", workspace.id)
      .gte("created_at", since)
      .is("assistant_message_id", null),
  ]);
  const proposalsBySource = {
    inApp: inAppRes.count ?? 0,
    terminal: terminalRes.count ?? 0,
  };

  return (
    <>
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Analytics</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          How{" "}
          <strong className="font-medium text-foreground">
            {workspace.name}
          </strong>{" "}
          is using Canvas. Activation funnel, proposal outcomes, and editing
          efficiency from the last {WINDOW_DAYS} days of usage telemetry. Visible
          to admins and owners only.
        </p>
      </div>

      {!hasData ? (
        <EmptyState />
      ) : (
        <>
          <ActivationFunnelCard funnel={metrics.funnel} />
          <ProposalSourceCard source={proposalsBySource} windowDays={WINDOW_DAYS} />
          <WindowSection metrics={metrics} window="last7d" label="Last 7 days" />
          <WindowSection
            metrics={metrics}
            window="last30d"
            label="Last 30 days"
          />
        </>
      )}
    </>
  );
}

// ----------------------------------------------------------------------------
// Presentation. Kept inline (server-rendered, no client JS) and small, matching
// the workspace/members pages: section cards with an eyebrow, stat tiles, a
// minimal funnel, and one table. Numbers use tabular-nums so columns line up.
// ----------------------------------------------------------------------------

function EmptyState() {
  return (
    <section className="rounded-[12px] border border-border bg-card p-6">
      <div className="eyebrow">No usage yet</div>
      <p className="mt-2 text-sm text-muted-foreground">
        Once people connect an agent and start proposing edits, their
        activation and editing activity will show up here. Mint an MCP token
        under <strong className="font-medium text-foreground">MCP setup</strong>{" "}
        to get the first connection logged.
      </p>
    </section>
  );
}

function ActivationFunnelCard({
  funnel,
}: {
  funnel: AnalyticsMetrics["funnel"];
}) {
  // Lifetime funnel: token minted -> first connect -> first approved edit.
  // Each step shows its absolute count and the conversion from the prior step.
  const steps = [
    {
      label: "Tokens minted",
      hint: "Users who created an MCP token",
      count: funnel.tokensMinted,
      conv: null as number | null,
    },
    {
      label: "First connect",
      hint: "Token actually used from an MCP agent",
      count: funnel.firstConnect,
      conv: funnel.mintToConnectRate,
    },
    {
      label: "First approved edit",
      hint: "Reached a landed, approved edit",
      count: funnel.firstApprovedEdit,
      conv: funnel.connectToEditRate,
    },
  ];
  const max = Math.max(funnel.tokensMinted, 1);

  return (
    <section className="rounded-[12px] border border-border bg-card p-6 space-y-4">
      <div className="flex items-baseline justify-between">
        <div className="eyebrow">Activation funnel</div>
        <div className="text-xs text-muted-foreground">
          Overall {formatRate(funnel.overallRate)}{" "}mint &rarr; edit &middot;{" "}
          lifetime
        </div>
      </div>
      <div className="space-y-3">
        {steps.map((s) => {
          // Bar width is proportional to the top of the funnel so the drop-off
          // is visible at a glance; floor at a sliver so a 0 still renders.
          const pct = Math.max(2, Math.round((s.count / max) * 100));
          return (
            <div key={s.label} className="space-y-1">
              <div className="flex items-baseline justify-between gap-3 text-sm">
                <span className="font-medium text-foreground">{s.label}</span>
                <span className="tabular-nums text-muted-foreground">
                  {s.count}
                  {s.conv !== null && (
                    <span className="ml-2 text-xs">
                      ({formatRate(s.conv)} from prior)
                    </span>
                  )}
                </span>
              </div>
              <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-foreground/70"
                  style={{ width: `${pct}%` }}
                />
              </div>
              <div className="text-xs text-muted-foreground">{s.hint}</div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function WindowSection({
  metrics,
  window,
  label,
}: {
  metrics: AnalyticsMetrics;
  window: "last7d" | "last30d";
  label: string;
}) {
  const w = metrics[window];
  const { proposals, efficiency, active } = w;

  return (
    <section className="rounded-[12px] border border-border bg-card p-6 space-y-5">
      <div className="eyebrow">{label}</div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat
          label="Active editors"
          value={String(active.activeEditors)}
          hint="Distinct people who proposed or edited"
        />
        <Stat
          label="Approval rate"
          value={formatRate(proposals.approveRate)}
          hint={`${proposals.approve} of ${proposals.total} decisions`}
        />
        <Stat
          label="Proposals / edit"
          value={formatRatio(efficiency.proposalsPerLandedEdit)}
          hint="Proposals per landed change"
        />
        <Stat
          label="Patch share"
          value={formatRate(efficiency.patchShare)}
          hint="Surgical patches vs full rewrites"
        />
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <ProposalOutcomes proposals={proposals} />
        <LatencyTable latency={w.latency} />
      </div>
    </section>
  );
}

function Stat({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="rounded-[10px] border border-border bg-paper p-4">
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums tracking-tight text-foreground">
        {value}
      </div>
      {hint && (
        <div className="mt-1 text-xs text-muted-foreground">{hint}</div>
      )}
    </div>
  );
}

function ProposalSourceCard({
  source,
  windowDays,
}: {
  source: { inApp: number; terminal: number };
  windowDays: number;
}) {
  const total = source.inApp + source.terminal;
  const pct = (n: number) => (total > 0 ? `${Math.round((n / total) * 100)}%` : "—");
  return (
    <section className="rounded-[12px] border border-border bg-card p-6 space-y-4">
      <div>
        <h2 className="text-sm font-semibold text-foreground">Proposals by source</h2>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Where proposals came from in the last {windowDays} days — the in-app
          Canvas chat vs an external MCP agent.
        </p>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Stat
          label="In-app assistant"
          value={String(source.inApp)}
          hint={`${pct(source.inApp)} of proposals`}
        />
        <Stat
          label="External MCP agent"
          value={String(source.terminal)}
          hint={`${pct(source.terminal)} of proposals`}
        />
      </div>
    </section>
  );
}

function ProposalOutcomes({
  proposals,
}: {
  proposals: AnalyticsMetrics["last30d"]["proposals"];
}) {
  const rows = [
    { label: "Approved", count: proposals.approve, rate: proposals.approveRate },
    { label: "Rejected", count: proposals.reject, rate: proposals.rejectRate },
    { label: "Withdrawn", count: proposals.withdraw, rate: proposals.withdrawRate },
  ];
  return (
    <div className="space-y-2">
      <div className="text-xs font-medium text-muted-foreground">
        Proposal outcomes
      </div>
      <table className="w-full text-sm">
        <tbody>
          {rows.map((r) => (
            <tr key={r.label} className="border-b border-border last:border-0">
              <td className="py-2 text-foreground">{r.label}</td>
              <td className="py-2 text-right tabular-nums text-muted-foreground">
                {r.count}
              </td>
              <td className="py-2 text-right tabular-nums text-muted-foreground">
                {formatRate(r.rate)}
              </td>
            </tr>
          ))}
          {/* Reverts are post-approval undos, shown separately since they're not
              one of the three terminal decisions the rates divide over. */}
          <tr className="text-xs">
            <td className="pt-2 text-muted-foreground">Reverted (post-approval)</td>
            <td className="pt-2 text-right tabular-nums text-muted-foreground">
              {proposals.revert}
            </td>
            <td className="pt-2" />
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function LatencyTable({
  latency,
}: {
  latency: AnalyticsMetrics["last30d"]["latency"];
}) {
  return (
    <div className="space-y-2">
      <div className="text-xs font-medium text-muted-foreground">
        Latency (p50 / p95)
      </div>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-xs text-muted-foreground">
            <th className="pb-1 text-left font-medium">Operation</th>
            <th className="pb-1 text-right font-medium">n</th>
            <th className="pb-1 text-right font-medium">p50</th>
            <th className="pb-1 text-right font-medium">p95</th>
          </tr>
        </thead>
        <tbody>
          {latency.map((l) => (
            <tr key={l.label} className="border-b border-border last:border-0">
              <td className="py-2 text-foreground">{l.label}</td>
              <td className="py-2 text-right tabular-nums text-muted-foreground">
                {l.count}
              </td>
              <td className="py-2 text-right tabular-nums text-muted-foreground">
                {formatMs(l.p50)}
              </td>
              <td className="py-2 text-right tabular-nums text-muted-foreground">
                {formatMs(l.p95)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// Usage event logger — writes to public.canvas_usage_event.
//
// Entry points:
//   - logUsage(event)                  fire-and-forget single insert.
//   - logUsageBatch(events)            fire-and-forget one multi-row insert.
//   - withUsage(event, fn)             times fn, logs status + duration,
//                                      re-throws so callers stay normal.
//
// All inserts use the service-role admin client because most call sites
// (MCP route, auth callbacks, server actions) write events on behalf of
// the user but don't run under the user's RLS context. The events table
// has no user-facing INSERT policy — see migration 0014.
//
// Failures are swallowed. Telemetry must never break a request.

import type { PostgrestError } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";

export type UsageSurface = "mcp" | "api" | "action" | "auth" | "public";
export type UsageStatus = "ok" | "error" | "denied";

export type UsageEvent = {
  event: string;
  surface: UsageSurface;
  user_id?: string | null;
  workspace_id?: string | null;
  deck_id?: string | null;
  slide_id?: string | null;
  duration_ms?: number;
  status?: UsageStatus;
  error_code?: string | null;
  props?: Record<string, unknown>;
};

// Fire-and-forget. Inserts asynchronously; logger errors only surface
// as a console warning so a Supabase outage can't take down the app.
export function logUsage(e: UsageEvent): void {
  // Skip the work entirely in the test environment unless the caller
  // has opted in. Vitest unit tests for the logger pass an explicit
  // client (via the seam below) so they don't need the env vars.
  if (process.env.NODE_ENV === "test" && !process.env.USAGE_LOG_ENABLED_IN_TEST) {
    return;
  }
  void insertOne(e).catch((err) => {
    console.error("[usage:logUsage]", e.event, err);
  });
}

// Fire-and-forget batch. Same posture as logUsage but folds N events into a
// single multi-row insert — one round-trip for a surface that emits several
// events at once (e.g. the public viewer's open + slide-dwell beacon).
export function logUsageBatch(events: UsageEvent[]): void {
  if (process.env.NODE_ENV === "test" && !process.env.USAGE_LOG_ENABLED_IN_TEST) {
    return;
  }
  if (events.length === 0) return;
  void insertMany(events).catch((err) => {
    console.error("[usage:logUsageBatch]", events.length, err);
  });
}

// Time a function and emit one event. The event passed in carries
// identity (workspace_id, user_id, deck_id, props) — withUsage adds
// duration_ms and status. Re-throws so the caller sees errors normally.
export async function withUsage<T>(
  e: Omit<UsageEvent, "status" | "duration_ms" | "error_code">,
  fn: () => Promise<T>,
): Promise<T> {
  const started = Date.now();
  try {
    const value = await fn();
    logUsage({
      ...e,
      status: "ok",
      duration_ms: Date.now() - started,
    });
    return value;
  } catch (err) {
    logUsage({
      ...e,
      status: "error",
      duration_ms: Date.now() - started,
      error_code: extractErrorCode(err),
    });
    throw err;
  }
}

// Test seam. Production code goes through createAdminClient(); the
// logger tests swap this so they can assert what was inserted without
// hitting Supabase.
let clientFactory: () => ReturnType<typeof createAdminClient> = createAdminClient;

export function __setUsageClientFactoryForTesting(
  factory: () => ReturnType<typeof createAdminClient>,
): void {
  clientFactory = factory;
}

export function __resetUsageClientFactoryForTesting(): void {
  clientFactory = createAdminClient;
}

// Shape a UsageEvent into a canvas_usage_event row: default the status,
// null-fill the identity columns, clamp duration, and PII-filter props.
// Shared by the single- and batch-insert paths so both write the same shape.
function shapeRow(e: UsageEvent) {
  return {
    event: e.event,
    surface: e.surface,
    status: e.status ?? "ok",
    user_id: e.user_id ?? null,
    workspace_id: e.workspace_id ?? null,
    deck_id: e.deck_id ?? null,
    slide_id: e.slide_id ?? null,
    duration_ms: typeof e.duration_ms === "number" ? Math.max(0, Math.round(e.duration_ms)) : null,
    error_code: e.error_code ?? null,
    props: sanitizeProps(e.props ?? {}),
  };
}

async function insertOne(e: UsageEvent): Promise<void> {
  const { error } = await clientFactory()
    .from("canvas_usage_event")
    .insert(shapeRow(e));
  if (error) {
    throw error;
  }
}

async function insertMany(events: UsageEvent[]): Promise<void> {
  const { error } = await clientFactory()
    .from("canvas_usage_event")
    .insert(events.map(shapeRow));
  if (error) {
    throw error;
  }
}

// Disallow any props key whose name looks PII-shaped. Belt-and-suspenders
// for the manual allowlists at call sites — if someone forgets to filter,
// this still strips the obvious leakage paths.
const FORBIDDEN_PROP_KEYS = new Set([
  "token",
  "secret",
  "password",
  "email",
  "html",
  "html_body",
  "slide_styles",
  "theme_css",
  "nav_js",
  "body",
  "content",
  "comment",
  "comment_body",
  "title",
  "label",
  "description",
  "prompt",
  "source_prompt",
]);

const MAX_STRING_LEN = 200;

function sanitizeProps(props: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(props)) {
    if (FORBIDDEN_PROP_KEYS.has(k.toLowerCase())) continue;
    out[k] = sanitizeValue(v);
  }
  return out;
}

function sanitizeValue(v: unknown): unknown {
  if (v == null) return v;
  if (typeof v === "string") {
    return v.length > MAX_STRING_LEN ? v.slice(0, MAX_STRING_LEN) : v;
  }
  if (typeof v === "number" || typeof v === "boolean") return v;
  if (Array.isArray(v)) return v.slice(0, 50).map(sanitizeValue);
  if (typeof v === "object") return sanitizeProps(v as Record<string, unknown>);
  return String(v);
}

function extractErrorCode(err: unknown): string | null {
  if (!err) return null;
  if (typeof err === "object" && err !== null) {
    const maybe = err as Partial<PostgrestError> & { code?: string };
    if (typeof maybe.code === "string") return maybe.code;
    if (err instanceof Error) return err.name || "Error";
  }
  return String(err).slice(0, 100);
}

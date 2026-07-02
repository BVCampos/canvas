// Share-link engagement — the pure halves of the public-view telemetry
// feature, kept Supabase/Next-free so they unit-test with synthetic rows
// (same discipline as settings/analytics' metrics.ts).
//
// Two responsibilities:
//   * parseTrackBatch — validate the untrusted POST body the public viewer
//     sends to /api/public/deck/{token}/track. Everything is clamped and
//     allowlisted here so the route stays a thin authz/rate-limit shell.
//   * aggregateEngagement — fold the raw public_view.* usage-event rows
//     into the per-deck report (opens, unique sessions, per-slide dwell,
//     drop-off) the engagement page renders.
//
// Honesty note carried from the discovery doc: these are self-reported,
// forgeable numbers from an unauthenticated surface. They are directional
// engagement signals, never billing or gating inputs.

export const VIEW_EVENT_OPEN = "public_view.open";
export const VIEW_EVENT_SLIDE = "public_view.slide";

// Opaque client-minted session id (crypto.randomUUID or similar). The single
// source of the shape; the public comment/track routes and the client session
// minter (lib/canvas/opaque-session) all validate against this same contract.
export const SESSION_RE = /^[A-Za-z0-9_-]{8,64}$/;

// A slide dwell longer than this is a tab left open, not reading time.
export const MAX_DWELL_MS = 30 * 60 * 1000;

// One flush from the viewer: an open and/or a handful of slide dwells.
export const MAX_BATCH_EVENTS = 40;

export type TrackOpenEvent = {
  type: "open";
  slide_count?: number;
  referrer_host?: string | null;
};

export type TrackSlideEvent = {
  type: "slide";
  slide_id: string;
  position: number;
  ms: number;
  reached_end?: boolean;
};

export type TrackEvent = TrackOpenEvent | TrackSlideEvent;

export type TrackBatch = {
  session: string;
  events: TrackEvent[];
};

const UUID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

// Validate + clamp an untrusted request body. Returns null when the shape is
// unusable; silently drops individual malformed events (telemetry should
// degrade, not error a viewer's beacon).
export function parseTrackBatch(body: unknown): TrackBatch | null {
  if (typeof body !== "object" || body === null) return null;
  const b = body as Record<string, unknown>;
  if (typeof b.session !== "string" || !SESSION_RE.test(b.session)) return null;
  if (!Array.isArray(b.events) || b.events.length === 0) return null;

  const events: TrackEvent[] = [];
  for (const raw of b.events.slice(0, MAX_BATCH_EVENTS)) {
    if (typeof raw !== "object" || raw === null) continue;
    const e = raw as Record<string, unknown>;
    if (e.type === "open") {
      events.push({
        type: "open",
        slide_count:
          typeof e.slide_count === "number" && Number.isFinite(e.slide_count)
            ? Math.max(0, Math.min(500, Math.round(e.slide_count)))
            : undefined,
        referrer_host:
          typeof e.referrer_host === "string"
            ? e.referrer_host.slice(0, 100)
            : null,
      });
      continue;
    }
    if (e.type === "slide") {
      if (typeof e.slide_id !== "string" || !UUID_RE.test(e.slide_id)) continue;
      if (typeof e.position !== "number" || !Number.isFinite(e.position)) continue;
      if (typeof e.ms !== "number" || !Number.isFinite(e.ms) || e.ms < 0) continue;
      events.push({
        type: "slide",
        slide_id: e.slide_id,
        position: Math.max(0, Math.min(499, Math.round(e.position))),
        ms: Math.min(MAX_DWELL_MS, Math.round(e.ms)),
        reached_end: e.reached_end === true,
      });
      continue;
    }
  }

  if (events.length === 0) return null;
  return { session: b.session, events };
}

// ---------------------------------------------------------------------------
// Report aggregation
// ---------------------------------------------------------------------------

// The subset of canvas_usage_event columns the report reads.
export type PublicViewRow = {
  event: string;
  created_at: string;
  slide_id: string | null;
  duration_ms: number | null;
  props: Record<string, unknown> | null;
};

export type SlideEngagement = {
  position: number;
  // Sessions that spent any measured time on this slide.
  sessions: number;
  totalDwellMs: number;
  avgDwellMs: number;
};

export type DropOffPoint = {
  position: number;
  // Sessions whose furthest slide reached at least this position.
  sessions: number;
  // sessions / uniqueSessions (0..1); 0 when there are no sessions.
  share: number;
};

export type DeckEngagement = {
  opens: number;
  uniqueSessions: number;
  lastOpenedAt: string | null;
  totalViewMs: number;
  medianViewMs: number;
  perSlide: SlideEngagement[];
  dropOff: DropOffPoint[];
  opensByDay: { day: string; opens: number }[];
};

function sessionOf(row: PublicViewRow): string | null {
  const s = row.props?.session;
  return typeof s === "string" && s.length > 0 ? s : null;
}

function positionOf(row: PublicViewRow): number | null {
  const p = row.props?.position;
  return typeof p === "number" && Number.isFinite(p) ? p : null;
}

export function aggregateEngagement(
  rows: PublicViewRow[],
  slideCount: number,
): DeckEngagement {
  let opens = 0;
  let lastOpenedAt: string | null = null;
  const sessions = new Set<string>();
  const maxPosBySession = new Map<string, number>();
  const viewMsBySession = new Map<string, number>();
  const dwellByPosition = new Map<number, { total: number; sessions: Set<string> }>();
  const opensByDay = new Map<string, number>();

  for (const row of rows) {
    const session = sessionOf(row);
    if (session) sessions.add(session);

    if (row.event === VIEW_EVENT_OPEN) {
      opens += 1;
      if (lastOpenedAt === null || row.created_at > lastOpenedAt) {
        lastOpenedAt = row.created_at;
      }
      const day = row.created_at.slice(0, 10);
      opensByDay.set(day, (opensByDay.get(day) ?? 0) + 1);
      // An open means slide 0 was reached even if the viewer bounced before
      // any dwell flushed.
      if (session) {
        maxPosBySession.set(session, Math.max(maxPosBySession.get(session) ?? 0, 0));
      }
      continue;
    }

    if (row.event === VIEW_EVENT_SLIDE) {
      const position = positionOf(row);
      const ms = Math.min(MAX_DWELL_MS, Math.max(0, row.duration_ms ?? 0));
      if (position === null) continue;
      const bucket = dwellByPosition.get(position) ?? {
        total: 0,
        sessions: new Set<string>(),
      };
      bucket.total += ms;
      if (session) bucket.sessions.add(session);
      dwellByPosition.set(position, bucket);
      if (session) {
        maxPosBySession.set(
          session,
          Math.max(maxPosBySession.get(session) ?? 0, position),
        );
        viewMsBySession.set(session, (viewMsBySession.get(session) ?? 0) + ms);
      }
    }
  }

  const uniqueSessions = sessions.size;

  const perSlide: SlideEngagement[] = [];
  for (let position = 0; position < slideCount; position += 1) {
    const bucket = dwellByPosition.get(position);
    const sessionCount = bucket?.sessions.size ?? 0;
    const total = bucket?.total ?? 0;
    perSlide.push({
      position,
      sessions: sessionCount,
      totalDwellMs: total,
      avgDwellMs: sessionCount > 0 ? Math.round(total / sessionCount) : 0,
    });
  }

  const dropOff: DropOffPoint[] = [];
  for (let position = 0; position < slideCount; position += 1) {
    let reached = 0;
    for (const maxPos of maxPosBySession.values()) {
      if (maxPos >= position) reached += 1;
    }
    dropOff.push({
      position,
      sessions: reached,
      share: uniqueSessions > 0 ? reached / uniqueSessions : 0,
    });
  }

  const viewTimes = [...viewMsBySession.values()].sort((a, b) => a - b);
  const totalViewMs = viewTimes.reduce((sum, v) => sum + v, 0);
  const medianViewMs =
    viewTimes.length === 0
      ? 0
      : viewTimes.length % 2 === 1
        ? viewTimes[(viewTimes.length - 1) / 2]
        : Math.round(
            (viewTimes[viewTimes.length / 2 - 1] + viewTimes[viewTimes.length / 2]) / 2,
          );

  return {
    opens,
    uniqueSessions,
    lastOpenedAt,
    totalViewMs,
    medianViewMs,
    perSlide,
    dropOff,
    opensByDay: [...opensByDay.entries()]
      .map(([day, count]) => ({ day, opens: count }))
      .sort((a, b) => (a.day < b.day ? -1 : 1)),
  };
}

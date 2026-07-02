import { describe, expect, it } from "vitest";
import {
  aggregateEngagement,
  MAX_BATCH_EVENTS,
  MAX_DWELL_MS,
  parseTrackBatch,
  VIEW_EVENT_OPEN,
  VIEW_EVENT_SLIDE,
  type PublicViewRow,
} from "@/lib/canvas/engagement";

const SLIDE_A = "11111111-1111-4111-8111-111111111111";
const SLIDE_B = "22222222-2222-4222-8222-222222222222";

function openRow(session: string, createdAt: string): PublicViewRow {
  return {
    event: VIEW_EVENT_OPEN,
    created_at: createdAt,
    slide_id: null,
    duration_ms: null,
    props: { session, slide_count: 3 },
  };
}

function slideRow(
  session: string,
  position: number,
  ms: number,
  createdAt = "2026-07-01T10:00:00Z",
): PublicViewRow {
  return {
    event: VIEW_EVENT_SLIDE,
    created_at: createdAt,
    slide_id: position === 0 ? SLIDE_A : SLIDE_B,
    duration_ms: ms,
    props: { session, position },
  };
}

describe("parseTrackBatch", () => {
  it("accepts a well-formed open + slide batch", () => {
    const batch = parseTrackBatch({
      session: "abcd1234",
      events: [
        { type: "open", slide_count: 5, referrer_host: "mail.google.com" },
        { type: "slide", slide_id: SLIDE_A, position: 0, ms: 4200 },
      ],
    });
    expect(batch).not.toBeNull();
    expect(batch!.events).toHaveLength(2);
    expect(batch!.events[1]).toMatchObject({ type: "slide", ms: 4200 });
  });

  it("rejects a missing or malformed session", () => {
    expect(parseTrackBatch({ events: [{ type: "open" }] })).toBeNull();
    expect(
      parseTrackBatch({ session: "no spaces!", events: [{ type: "open" }] }),
    ).toBeNull();
  });

  it("drops malformed events but keeps the valid ones", () => {
    const batch = parseTrackBatch({
      session: "abcd1234",
      events: [
        { type: "slide", slide_id: "not-a-uuid", position: 0, ms: 100 },
        { type: "slide", slide_id: SLIDE_A, position: -3, ms: -50 },
        { type: "slide", slide_id: SLIDE_A, position: 1, ms: 900 },
      ],
    });
    expect(batch).not.toBeNull();
    expect(batch!.events).toHaveLength(1);
    expect(batch!.events[0]).toMatchObject({ position: 1, ms: 900 });
  });

  it("returns null when nothing valid survives", () => {
    expect(
      parseTrackBatch({ session: "abcd1234", events: [{ type: "nope" }] }),
    ).toBeNull();
  });

  it("clamps dwell to the ceiling and caps batch size", () => {
    const events = Array.from({ length: MAX_BATCH_EVENTS + 20 }, () => ({
      type: "slide" as const,
      slide_id: SLIDE_A,
      position: 0,
      ms: MAX_DWELL_MS * 10,
    }));
    const batch = parseTrackBatch({ session: "abcd1234", events });
    expect(batch!.events.length).toBe(MAX_BATCH_EVENTS);
    expect((batch!.events[0] as { ms: number }).ms).toBe(MAX_DWELL_MS);
  });
});

describe("aggregateEngagement", () => {
  it("returns an all-zero shape for no rows", () => {
    const agg = aggregateEngagement([], 3);
    expect(agg.opens).toBe(0);
    expect(agg.uniqueSessions).toBe(0);
    expect(agg.lastOpenedAt).toBeNull();
    expect(agg.perSlide).toHaveLength(3);
    expect(agg.dropOff.every((d) => d.share === 0)).toBe(true);
  });

  it("counts opens, sessions, and last-open across sessions", () => {
    const rows = [
      openRow("s1", "2026-07-01T09:00:00Z"),
      openRow("s1", "2026-07-01T12:00:00Z"),
      openRow("s2", "2026-07-01T10:00:00Z"),
    ];
    const agg = aggregateEngagement(rows, 2);
    expect(agg.opens).toBe(3);
    expect(agg.uniqueSessions).toBe(2);
    expect(agg.lastOpenedAt).toBe("2026-07-01T12:00:00Z");
    expect(agg.opensByDay).toEqual([{ day: "2026-07-01", opens: 3 }]);
  });

  it("computes per-slide dwell averages per viewing session", () => {
    const rows = [
      openRow("s1", "2026-07-01T09:00:00Z"),
      slideRow("s1", 0, 10_000),
      slideRow("s1", 0, 2_000), // second visit to the same slide accumulates
      openRow("s2", "2026-07-01T09:05:00Z"),
      slideRow("s2", 0, 4_000),
    ];
    const agg = aggregateEngagement(rows, 2);
    expect(agg.perSlide[0].sessions).toBe(2);
    expect(agg.perSlide[0].totalDwellMs).toBe(16_000);
    expect(agg.perSlide[0].avgDwellMs).toBe(8_000);
    expect(agg.perSlide[1].sessions).toBe(0);
  });

  it("builds the drop-off curve from each session's furthest slide", () => {
    const rows = [
      openRow("s1", "2026-07-01T09:00:00Z"), // bounced on slide 0
      openRow("s2", "2026-07-01T09:01:00Z"),
      slideRow("s2", 1, 3_000), // reached the end
    ];
    const agg = aggregateEngagement(rows, 2);
    expect(agg.dropOff[0]).toMatchObject({ sessions: 2, share: 1 });
    expect(agg.dropOff[1]).toMatchObject({ sessions: 1, share: 0.5 });
  });

  it("computes a per-session median view time", () => {
    const rows = [
      openRow("s1", "2026-07-01T09:00:00Z"),
      slideRow("s1", 0, 10_000),
      openRow("s2", "2026-07-01T09:01:00Z"),
      slideRow("s2", 0, 2_000),
      openRow("s3", "2026-07-01T09:02:00Z"),
      slideRow("s3", 0, 4_000),
    ];
    const agg = aggregateEngagement(rows, 1);
    expect(agg.totalViewMs).toBe(16_000);
    expect(agg.medianViewMs).toBe(4_000);
  });
});

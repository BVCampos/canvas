// Unit tests for the usage event logger.
//
// We swap the admin-client factory via the exported test seam so each
// test sees its own array of inserted rows. The logger is fire-and-forget
// for logUsage(); withUsage() awaits its insert internally before
// returning, but to keep tests deterministic we also await one extra
// microtask tick after logUsage() calls.

import { beforeEach, afterEach, describe, expect, it } from "vitest";
import {
  __resetUsageClientFactoryForTesting,
  __setUsageClientFactoryForTesting,
  logUsage,
  logUsageBatch,
  withUsage,
} from "../src/lib/usage/log";

type InsertedRow = Record<string, unknown>;

let inserted: InsertedRow[] = [];
let insertError: { message: string } | null = null;

function makeFakeClient() {
  // Cast to any so the narrow .from().insert() shape matches what the
  // logger expects from the real SupabaseClient.
  return {
    from: (table: string) => ({
      insert: async (row: InsertedRow) => {
        if (table !== "canvas_usage_event") {
          throw new Error(`unexpected table ${table}`);
        }
        if (insertError) return { error: insertError };
        inserted.push(row);
        return { error: null };
      },
    }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

beforeEach(() => {
  inserted = [];
  insertError = null;
  process.env.USAGE_LOG_ENABLED_IN_TEST = "1";
  __setUsageClientFactoryForTesting(makeFakeClient);
});

afterEach(() => {
  __resetUsageClientFactoryForTesting();
  delete process.env.USAGE_LOG_ENABLED_IN_TEST;
});

// Wait long enough for a fire-and-forget logUsage()'s scheduled promise
// chain to resolve. Two awaited zero-timeouts is enough for a synchronous
// fake insert.
async function flushFireAndForget() {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

describe("withUsage", () => {
  it("logs status=ok with a non-negative duration on success", async () => {
    const result = await withUsage(
      {
        event: "test.success",
        surface: "action",
        user_id: "u1",
        workspace_id: "w1",
        deck_id: "d1",
      },
      async () => 42,
    );
    expect(result).toBe(42);
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({
      event: "test.success",
      surface: "action",
      status: "ok",
      user_id: "u1",
      workspace_id: "w1",
      deck_id: "d1",
    });
    expect(inserted[0].duration_ms).toBeTypeOf("number");
    expect(inserted[0].duration_ms as number).toBeGreaterThanOrEqual(0);
    expect(inserted[0].error_code).toBeNull();
  });

  it("logs status=error with error_code and rethrows on failure", async () => {
    const boom = new Error("kaboom");
    boom.name = "SpecificError";
    await expect(
      withUsage(
        { event: "test.fail", surface: "api", workspace_id: "w1" },
        async () => {
          throw boom;
        },
      ),
    ).rejects.toBe(boom);
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({
      event: "test.fail",
      status: "error",
      error_code: "SpecificError",
    });
  });

  it("prefers a Postgres-style error.code over Error.name", async () => {
    const pgErr = Object.assign(new Error("dup"), {
      name: "Error",
      code: "23505",
    });
    await expect(
      withUsage(
        { event: "test.pgerror", surface: "action", workspace_id: "w1" },
        async () => {
          throw pgErr;
        },
      ),
    ).rejects.toBe(pgErr);
    expect(inserted[0].error_code).toBe("23505");
  });
});

describe("logUsage", () => {
  it("strips forbidden prop keys (PII / content)", async () => {
    logUsage({
      event: "test.redact",
      surface: "mcp",
      workspace_id: "w1",
      props: {
        tool_name: "propose_slide_edit",
        // These must all be dropped.
        html_body: "<section>secret content</section>",
        title: "Confidential plan",
        token: "mcp_xxx",
        email: "user@example.com",
        body: "comment body that should not leak",
        // These pass through.
        html_body_len: 42,
        slide_id: "abc",
      },
    });
    await flushFireAndForget();
    expect(inserted).toHaveLength(1);
    const row = inserted[0];
    const props = row.props as Record<string, unknown>;
    expect(props).toEqual({
      tool_name: "propose_slide_edit",
      html_body_len: 42,
      slide_id: "abc",
    });
  });

  it("truncates long string values in props to 200 chars", async () => {
    const long = "x".repeat(500);
    logUsage({
      event: "test.truncate",
      surface: "action",
      workspace_id: "w1",
      props: { reason: long },
    });
    await flushFireAndForget();
    const props = inserted[0].props as Record<string, unknown>;
    expect((props.reason as string).length).toBe(200);
  });

  it("swallows insert errors without throwing", async () => {
    insertError = { message: "supabase is sad" };
    // No await needed — logUsage is fire-and-forget. The point of this
    // assertion is that the call itself does not throw synchronously and
    // a subsequent microtask flush also doesn't surface an unhandled
    // rejection (caught by the .catch() in logUsage).
    expect(() =>
      logUsage({ event: "test.swallow", surface: "action", workspace_id: "w1" }),
    ).not.toThrow();
    await flushFireAndForget();
    // Nothing was inserted (insert returned an error), but no throw.
    expect(inserted).toHaveLength(0);
  });
});

describe("logUsageBatch", () => {
  it("folds N events into exactly ONE multi-row insert of shaped rows", async () => {
    logUsageBatch([
      {
        event: "public_view.open",
        surface: "public",
        deck_id: "d1",
        props: { session: "s1" },
      },
      {
        event: "public_view.slide",
        surface: "public",
        deck_id: "d1",
        slide_id: "sl1",
        duration_ms: 1200,
        props: { session: "s1", position: 0 },
      },
      {
        event: "public_view.slide",
        surface: "public",
        deck_id: "d1",
        slide_id: "sl2",
        duration_ms: 800,
        props: { session: "s1", position: 1 },
      },
    ]);
    await flushFireAndForget();

    // One round-trip carrying all three rows, not three separate inserts.
    expect(inserted).toHaveLength(1);
    const rows = inserted[0] as unknown as InsertedRow[];
    expect(Array.isArray(rows)).toBe(true);
    expect(rows).toHaveLength(3);
    // Each row went through the SAME shaper as the single-insert path: status
    // defaulted, identity null-filled, props PII-filtered.
    expect(rows[0]).toMatchObject({
      event: "public_view.open",
      surface: "public",
      status: "ok",
      deck_id: "d1",
      slide_id: null,
      duration_ms: null,
    });
    expect(rows[1]).toMatchObject({
      event: "public_view.slide",
      slide_id: "sl1",
      duration_ms: 1200,
    });
    expect(rows[1].props).toEqual({ session: "s1", position: 0 });
  });

  it("short-circuits an empty batch without inserting", async () => {
    logUsageBatch([]);
    await flushFireAndForget();
    expect(inserted).toHaveLength(0);
  });
});

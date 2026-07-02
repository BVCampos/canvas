// /api/ready — the schema-behind-code gate.
//
// The point of this route (vs /api/health liveness) is to catch a deploy where
// the app bundle reads a column a not-yet-applied migration adds: PostgREST 400s
// that read on the hot path while a naive health check stays green. These tests
// pin that a missing probed column flips readiness to 503, and a present schema
// stays 200 — so a deploy gate can act on it.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A swappable admin-client stub. `presentColumns` is the set of "table.column"
// the fake DB knows; a probe for anything else returns the real undefined_column
// error shape (42703) so checkSchema sees "behind". `workspaces.id` (the
// reachability probe) and storage always succeed unless overridden.
let presentColumns = new Set<string>();
let probeError: { code?: string; message?: string } | null = null;

function makeAdmin() {
  return {
    from(table: string) {
      return {
        select(col: string) {
          return {
            limit() {
              if (table === "workspaces") return Promise.resolve({ data: [], error: null });
              if (probeError) return Promise.resolve({ data: null, error: probeError });
              if (presentColumns.has(`${table}.${col}`)) {
                return Promise.resolve({ data: [], error: null });
              }
              // A column absent from a SELECT list surfaces as Postgres
              // undefined_column 42703 (PostgREST passes the SQLSTATE through on
              // error.code) — this is the select-path code the gate keys on.
              // (PGRST204 is the WRITE-payload "column not found" code, not select.)
              return Promise.resolve({
                data: null,
                error: { code: "42703", message: `column ${table}.${col} does not exist` },
              });
            },
          };
        },
      };
    },
    storage: {
      from() {
        return { list: () => Promise.resolve({ data: [], error: null }) };
      },
    },
  };
}

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => makeAdmin(),
}));

// Credential encryption readiness is its own hard gate; default to ready so the
// schema tests below are unaffected, and flip it per-test.
let encryptionReady = true;
vi.mock("@/lib/security/credential-crypto", () => ({
  credentialEncryptionAvailable: () => encryptionReady,
}));

import { GET } from "../src/app/api/ready/route";

const ALL_PRESENT = new Set([
  "canvas_mcp_token.expires_at",
  "canvas_assistant_bridge_presence.bridge_version",
  "canvas_mcp_token.last_client_name",
  "canvas_assistant_bridge_presence.agent_provider",
  "canvas_notification.edit_id",
  "canvas_deck.agent_fast_lane_enabled",
  "canvas_deck_slide_lock.locked_by_kind",
  "canvas_assistant_message.execution_runtime",
  "canvas_user_ai_provider_config.encrypted_api_key",
]);

beforeEach(() => {
  presentColumns = new Set(ALL_PRESENT);
  probeError = null;
  encryptionReady = true;
});
afterEach(() => {
  presentColumns = new Set();
  probeError = null;
  encryptionReady = true;
});

describe("GET /api/ready — schema gate", () => {
  it("is ready (200) when every probed column exists", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ready).toBe(true);
    expect(body.checks.schema.state).toBe("ok");
  });

  it("is NOT ready (503) when a probed column is missing, and names the migration", async () => {
    presentColumns.delete("canvas_assistant_bridge_presence.bridge_version");
    const res = await GET();
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.ready).toBe(false);
    expect(body.checks.schema.state).toBe("behind");
    expect(body.checks.schema.detail).toContain("bridge_version");
    expect(body.checks.schema.detail).toContain("0051");
  });

  it("lists every missing column when more than one migration is unapplied", async () => {
    presentColumns.clear();
    const res = await GET();
    const body = await res.json();
    expect(res.status).toBe(503);
    expect(body.checks.schema.detail).toContain("expires_at");
    expect(body.checks.schema.detail).toContain("bridge_version");
  });

  it("treats a missing TABLE as 'behind' too (new-table+column migration unapplied)", async () => {
    // The common migration shape creates a new table AND its column together, so
    // before it applies the probe hits a missing-RELATION error, not a missing
    // column. That is the same schema-behind-code state and must gate.
    for (const err of [
      { code: "42P01", message: 'relation "public.canvas_assistant_bridge_presence" does not exist' },
      { code: "PGRST205", message: 'Could not find the table "public.canvas_x" in the schema cache' },
    ]) {
      probeError = err;
      const res = await GET();
      const body = await res.json();
      expect(res.status, err.code).toBe(503);
      expect(body.ready, err.code).toBe(false);
      expect(body.checks.schema.state, err.code).toBe("behind");
    }
  });

  it("does NOT gate on a transient probe error (reports 'down' but stays ready)", async () => {
    // A non-undefined-column error is a generic blip checkSupabase already
    // covers — it must not be mislabeled as schema-behind and must not 503.
    probeError = { code: "08006", message: "connection reset" };
    const res = await GET();
    const body = await res.json();
    expect(body.checks.schema.state).toBe("down");
    expect(body.ready).toBe(true);
    expect(res.status).toBe(200);
  });

  it("is NOT ready (503) when the credential encryption key is missing", async () => {
    encryptionReady = false;
    const res = await GET();
    const body = await res.json();
    expect(res.status).toBe(503);
    expect(body.ready).toBe(false);
    expect(body.checks.encryption.state).toBe("down");
    expect(body.checks.encryption.detail).toContain("CANVAS_CREDENTIAL_ENCRYPTION_KEY");
    // schema is fine — this is a distinct gate, not mislabeled as behind.
    expect(body.checks.schema.state).toBe("ok");
  });

  it("reports encryption ok when the key is configured", async () => {
    const res = await GET();
    const body = await res.json();
    expect(body.checks.encryption.state).toBe("ok");
    expect(body.ready).toBe(true);
  });
});

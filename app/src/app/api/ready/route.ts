// GET /api/ready — readiness probe (distinct from /api/health liveness).
//
// Where /api/health proves only that the Node process is up (and deliberately
// never touches Supabase), this probe verifies the box can actually SERVE: the
// database is reachable and the render dependency is in place. It exists because
// a deploy where the new code references a not-yet-applied migration, or a box
// whose Chromium install silently failed, otherwise reports healthy and only
// surfaces when a real user hits a 500.
//
// Criticality:
//   - supabase  → CRITICAL. Unreachable ⇒ 503 (the app cannot function).
//   - schema    → CRITICAL. "behind" ⇒ 503. The app bundle reads columns that a
//                 recent migration added; CI gates tsc/lint/vitest but does NOT
//                 apply migrations (improvement-map-execution.md), so a deploy
//                 can ship code ahead of its schema. A select of a missing
//                 column is a hard PostgREST 400 on the hot path (token auth,
//                 the assistant panel), not a soft failure — and a naive health
//                 check stays green through it. This probe turns that
//                 schema-behind-code state into a red readiness signal a deploy
//                 gate can act on. (Observed once in prod: 0051 unapplied →
//                 bridge_version select 400s every poll.)
//   - storage   → reported. A blip degrades asset loading but the app runs.
//   - chromium  → reported. Missing ⇒ PDF/PPTX/render_slide 500, but the rest
//                 of the app is fine, so it must not deroute the whole box.
//
// Wiring this as the DEPLOY gate (so a 503 here blocks the cutover) lives in the
// EC2 bootstrap and is tracked separately; this route is the verifiable half and
// now actually checks the schema, not just reachability.

import { NextResponse } from "next/server";
import { accessSync, constants } from "node:fs";
import { createAdminClient } from "@/lib/supabase/admin";
import { credentialEncryptionAvailable } from "@/lib/security/credential-crypto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type CheckState = "ok" | "down" | "n/a" | "behind";

// Columns the SHIPPED code reads that a recent migration added. If the app
// bundle deploys before its migration is applied, a select of one of these
// returns a hard PostgREST 400 on a hot path. Add a row whenever a migration
// introduces a column the runtime reads, so this gate keeps pace with the code.
const SCHEMA_PROBES: { table: string; column: string; migration: string }[] = [
  { table: "canvas_mcp_token", column: "expires_at", migration: "0049" },
  {
    table: "canvas_assistant_bridge_presence",
    column: "bridge_version",
    migration: "0051",
  },
  { table: "canvas_mcp_token", column: "last_client_name", migration: "0054" },
  {
    table: "canvas_assistant_bridge_presence",
    column: "agent_provider",
    migration: "0054",
  },
  { table: "canvas_notification", column: "edit_id", migration: "0055" },
  {
    table: "canvas_deck",
    column: "agent_fast_lane_enabled",
    migration: "0057",
  },
  {
    table: "canvas_deck_slide_lock",
    column: "locked_by_kind",
    migration: "0058",
  },
  {
    table: "canvas_assistant_message",
    column: "execution_runtime",
    migration: "0059",
  },
  {
    table: "canvas_user_ai_provider_config",
    column: "encrypted_api_key",
    migration: "0059",
  },
  {
    table: "canvas_user_fast_lane_default",
    column: "enabled",
    migration: "0075",
  },
];

// A PostgREST/Postgres error for a schema object the probe's SELECT needs that
// doesn't exist yet — either a missing COLUMN (undefined_column 42703, or
// PostgREST PGRST204) or a missing TABLE/relation (undefined_table 42P01, or
// PostgREST's PGRST205 "could not find the table in the schema cache"). The
// table case matters because the canonical pattern is a migration that creates a
// NEW table AND the column the code reads in one step, so before it applies the
// whole relation is absent, not just a column. BOTH are the "schema behind code"
// state and must report `behind`. Any OTHER error is a generic fault
// checkSupabase already gates on, so we don't mislabel a transient blip.
function isSchemaBehind(err: { code?: string; message?: string } | null): boolean {
  if (!err) return false;
  if (["42703", "42P01", "PGRST204", "PGRST205"].includes(err.code ?? "")) return true;
  return /(column|relation) .* does not exist|could not find the .* (column|table)/i.test(
    err.message ?? "",
  );
}

async function checkSchema(): Promise<{ state: CheckState; detail?: string }> {
  try {
    const admin = createAdminClient();
    const missing: string[] = [];
    let transient: string | undefined;
    for (const probe of SCHEMA_PROBES) {
      // limit(1) is enough — Postgres rejects the generated SQL at parse time, so
      // a missing column (or table) errors even on an empty table.
      const { error } = await admin.from(probe.table).select(probe.column).limit(1);
      if (!error) continue;
      if (isSchemaBehind(error)) {
        missing.push(`${probe.table}.${probe.column} (needs migration ${probe.migration})`);
      } else {
        transient = error.message;
      }
    }
    if (missing.length > 0) {
      return { state: "behind", detail: `schema behind code — missing ${missing.join("; ")}` };
    }
    if (transient) return { state: "down", detail: transient };
    return { state: "ok" };
  } catch (err) {
    return { state: "down", detail: String(err).slice(0, 120) };
  }
}

async function checkSupabase(): Promise<{ state: CheckState; detail?: string }> {
  try {
    const admin = createAdminClient();
    // A tiny, indexed read against a stable core table proves the DB is
    // reachable and the connection is authorized. limit(1) keeps it cheap.
    const { error } = await admin.from("workspaces").select("id").limit(1);
    if (error) return { state: "down", detail: error.message };
    return { state: "ok" };
  } catch (err) {
    return { state: "down", detail: String(err).slice(0, 120) };
  }
}

async function checkStorage(): Promise<{ state: CheckState; detail?: string }> {
  try {
    const admin = createAdminClient();
    const { error } = await admin.storage.from("decks").list("", { limit: 1 });
    if (error) return { state: "down", detail: error.message };
    return { state: "ok" };
  } catch (err) {
    return { state: "down", detail: String(err).slice(0, 120) };
  }
}

function checkEncryption(): { state: CheckState; detail?: string } {
  // CRITICAL since the OpenRouter runtime shipped: without a valid
  // CANVAS_CREDENTIAL_ENCRYPTION_KEY the server cannot decrypt the personal or
  // workspace OpenRouter keys. This caught a deploy where the key was set on
  // /etc/canvas/app.env directly but absent from the SSM param canvas-pull
  // regenerates the file from — it vanished on the next deploy and nothing was
  // red. The deploy now actually gates on this: canvas-pull curls /api/ready after
  // /api/health and fails the deploy unless `encryption` is ok (see
  // app/infra/user_data.sh.tftpl) — /api/ready is otherwise unconsumed.
  // Limitation: this only proves the key is present and well-formed, not that it
  // matches the key the stored ciphertexts were encrypted with — a silent key swap
  // passes here and surfaces as a CredentialDecryptError at use instead.
  return credentialEncryptionAvailable()
    ? { state: "ok" }
    : {
        state: "down",
        detail:
          "CANVAS_CREDENTIAL_ENCRYPTION_KEY missing or malformed — OpenRouter keys cannot be decrypted",
      };
}

function checkChromium(): { state: CheckState; detail?: string } {
  // Only the EC2 box pins CHROMIUM_PATH; dev (channel: chrome) and lambda
  // (@sparticuz) resolve Chromium differently, so a missing path there is "n/a",
  // not a failure. On the box, a dangling symlink from a failed bootstrap is the
  // real risk this catches (accessSync follows the link).
  const path = process.env.CHROMIUM_PATH;
  if (!path) return { state: "n/a" };
  try {
    accessSync(path, constants.X_OK);
    return { state: "ok" };
  } catch {
    return { state: "down", detail: `not executable: ${path}` };
  }
}

export async function GET() {
  const [supabase, storage, schema] = await Promise.all([
    checkSupabase(),
    checkStorage(),
    checkSchema(),
  ]);
  const chromium = checkChromium();
  const encryption = checkEncryption();

  // Hard gates: the DB must be reachable, the applied schema must not be behind
  // the code that reads it, AND credential encryption must be configured. A
  // "behind" schema 400s real requests; a missing encryption key silently breaks
  // the OpenRouter runtime — both stay green on a naive liveness check. Storage
  // and chromium remain informational (a blip degrades a feature, not the box).
  const ready =
    supabase.state === "ok" &&
    schema.state !== "behind" &&
    encryption.state === "ok";

  return NextResponse.json(
    { ready, checks: { supabase, schema, storage, chromium, encryption } },
    { status: ready ? 200 : 503, headers: { "Cache-Control": "no-store" } },
  );
}

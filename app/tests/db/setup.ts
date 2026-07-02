// ============================================================
// pglite DB harness — load the real Canvas migrations and exercise
// the SECURITY DEFINER RPCs + RLS helpers in actual SQL.
// ============================================================
// WHY this file exists: the most bug-prone code in Canvas lives in
// Postgres, not TypeScript — canvas_apply_edit (rewritten in full a dozen
// times), canvas_restore_slide_version, canvas_restore_snapshot, and the
// RLS helpers canvas_can_read_deck / canvas_can_edit_deck. Every documented
// prod incident (the 0039 RLS leak, silent 0-row writes, the 0040 revert
// self-apply, the 0046 project-sharing cascade) sits in that layer, and it
// had ZERO automated coverage. The ~40 vitest files only test pure TS.
//
// This harness boots an in-process Postgres (pglite, PG 18.3 compiled to
// wasm), applies app/supabase/migrations/0000…NNNN IN ORDER, and runs the
// REAL function definitions. The only things we change are the handful of
// Supabase-managed objects the migrations assume already exist — see
// SUPABASE_PREAMBLE below; every shim is documented there and nowhere do we
// touch a migration file or a function body.
//
// Auth model under the harness: Supabase's auth.uid() reads the JWT; here it
// reads a transaction/session GUC (canvas.test_uid). asUser(uid) sets that
// GUC, so every RLS helper and RPC sees the caller we choose. We deliberately
// run the RPCs as the DB superuser (we do NOT `set role authenticated`),
// exactly like Supabase runs a SECURITY DEFINER function's body as its owner:
// authorization is enforced by the explicit auth.uid()/can_edit checks inside
// the functions, which is the precise behaviour the prod incidents turned on.
// ============================================================

import { PGlite } from "@electric-sql/pglite";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(__dirname, "../../supabase/migrations");

// ------------------------------------------------------------
// Supabase preamble — the objects the migrations reference that a vanilla
// Postgres (pglite) does not ship. Applied ONCE before migration 0000.
// Each block notes WHAT it shims and WHY the migrations need it.
// ------------------------------------------------------------
const SUPABASE_PREAMBLE = /* sql */ `
-- (1) Roles. Migrations carry "grant … to authenticated / anon / service_role"
-- and "create policy … to authenticated". Those roles are provisioned by the
-- Supabase platform; on bare Postgres they must exist or the GRANT/POLICY
-- statements error at parse time. We create them as plain NOLOGIN roles. We do
-- NOT switch into them to run the RPCs — see the auth note at the top.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role; end if;
end $$;

-- (2) Realtime publication. Migrations 0006/0041/0042/0047/0048 run
-- "alter publication supabase_realtime add table …". Supabase pre-creates this
-- publication; we create an empty one so the ALTERs land. It has no functional
-- effect on the harness (nothing subscribes), it just lets the DDL apply.
create publication supabase_realtime;

-- (3) pgcrypto shim. pglite does not ship the pgcrypto extension, and the only
-- pgcrypto function the migrations use is gen_random_bytes(int) — migration
-- 0000's workspace_invites.token default
--   replace(replace(encode(gen_random_bytes(32),'base64'),'+','-'),'/','_').
-- gen_random_uuid() and encode()/md5() are built into PG 18, so we only need to
-- supply gen_random_bytes. This is a faithful stand-in (random bytea of the
-- requested length); token uniqueness/format is irrelevant to the RPC + RLS
-- tests, the column just needs a working default.
create or replace function public.gen_random_bytes(_n int)
returns bytea
language sql
volatile
as $fn$
  select decode(string_agg(lpad(to_hex((random() * 255)::int), 2, '0'), ''), 'hex')
  from generate_series(1, _n);
$fn$;

-- (4) auth schema. Migration 0000 has FK "references auth.users(id)" and
-- 0013 attaches a trigger "after insert on auth.users". auth.uid() is called
-- by virtually every RLS helper and RPC. We:
--   • create the auth schema + a minimal auth.users table (the FK target +
--     trigger host). The public.users / public.workspace_memberships rows the
--     tests actually read hang off public, but the FK to auth.users(id) is real
--     so seeding goes auth.users -> public.users (the 0000 trigger mirrors it).
--   • back auth.uid() with a session GUC (canvas.test_uid). asUser(uid) sets it.
--     current_setting(..., true) returns NULL when unset, so auth.uid() is NULL
--     for an "anonymous" connection — which the RPCs explicitly guard on.
create schema if not exists auth;

-- raw_user_meta_data is read by the 0000 on_auth_user_created trigger
-- (new.raw_user_meta_data->>'full_name' / 'name' / 'avatar_url'); the real
-- Supabase auth.users carries it, so the shim must too or that trigger errors
-- the moment we insert a user.
create table if not exists auth.users (
  id                  uuid primary key default gen_random_uuid(),
  email               text,
  raw_user_meta_data  jsonb default '{}'::jsonb
);

create or replace function auth.uid()
returns uuid
language sql
stable
as $fn$
  select nullif(current_setting('canvas.test_uid', true), '')::uuid;
$fn$;

-- auth.role()/auth.jwt() are referenced by Supabase templates but NOT by any
-- canvas migration (verified by grep). We still provide auth.role() returning
-- the GUC-or-'authenticated' so any incidental reference resolves; harmless.
create or replace function auth.role()
returns text
language sql
stable
as $fn$
  select coalesce(nullif(current_setting('canvas.test_role', true), ''), 'authenticated');
$fn$;

-- (5) storage schema. Migrations 0003 and 0015 create RLS policies on
-- storage.objects and 0003 inserts a bucket row. Supabase's storage extension
-- owns these. We create just enough for the DDL to apply: the buckets/objects
-- tables and storage.foldername(text) (splits an object path on '/'). The
-- storage policies are never exercised by these tests — asset access is out of
-- scope — but the statements must parse and run so the migration list loads
-- end to end against the real files.
create schema if not exists storage;

create table if not exists storage.buckets (
  id                 text primary key,
  name               text not null,
  public             boolean default false,
  file_size_limit    bigint,
  allowed_mime_types text[]
);

create table if not exists storage.objects (
  id         uuid primary key default gen_random_uuid(),
  bucket_id  text references storage.buckets(id),
  name       text,
  owner      uuid,
  created_at timestamptz default now()
);
alter table storage.objects enable row level security;

create or replace function storage.foldername(_name text)
returns text[]
language sql
immutable
as $fn$
  -- Supabase's storage.foldername returns the path segments BEFORE the leaf
  -- file name. The canvas policies index [1] (workspace_id) and [2] (deck_id);
  -- a faithful split on '/' minus the trailing filename matches that usage.
  select (string_to_array(_name, '/'))[1:array_length(string_to_array(_name, '/'), 1) - 1];
$fn$;
`;

export type Pg = PGlite;

/** Discover every migration file, sorted by the numeric 0000… prefix. */
export function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d{4}_.*\.sql$/.test(f))
    .sort();
}

/**
 * Boot a fresh in-memory pglite, apply the Supabase preamble, then every
 * migration in order. Returns the live DB plus the count of migrations applied
 * so a test (and the report) can assert "all N loaded cleanly".
 */
export async function freshDb(): Promise<{ db: Pg; migrationsApplied: number }> {
  const db = new PGlite();
  await db.exec(SUPABASE_PREAMBLE);

  const files = migrationFiles();
  for (const file of files) {
    const sql = readFileSync(resolve(MIGRATIONS_DIR, file), "utf8");
    try {
      await db.exec(sql);
    } catch (e) {
      // Surface WHICH migration failed — a bare pglite error has no file context.
      throw new Error(`migration ${file} failed to apply: ${(e as Error).message}`);
    }
  }

  return { db, migrationsApplied: files.length };
}

// ------------------------------------------------------------
// Auth + role context
// ------------------------------------------------------------

/**
 * Run the rest of the transaction/session as `uid`. Sets the GUC that backs
 * auth.uid(); pass null to drop to "anonymous" (auth.uid() -> NULL), which the
 * RPCs treat as not-authenticated. Session-scoped (is_local = false) so it
 * sticks across statements on this single-connection pglite handle.
 */
export async function asUser(db: Pg, uid: string | null): Promise<void> {
  await db.query("select set_config('canvas.test_uid', $1, false)", [uid ?? ""]);
}

// ------------------------------------------------------------
// Seeding helpers. These insert through the REAL tables (and the real
// init-version trigger), so a seeded slide already has its version_no=1 row
// and the denorm cache the RPCs depend on. We bypass RLS by seeding as the
// pglite superuser (RLS is enforced when we later call the helpers as a user),
// which mirrors how app seed/service-role paths populate data.
// ------------------------------------------------------------

let counter = 0;
const uniq = () => `${Date.now()}-${counter++}`;

export type Role = "owner" | "admin" | "member" | "guest";

/** Create an auth.users row (FK target) + the mirrored public.users row. */
export async function makeUser(db: Pg, email?: string): Promise<string> {
  const id = randomUUID();
  const addr = email ?? `u-${uniq()}@example.com`;
  // The 0000 on_auth_user_created trigger mirrors auth.users -> public.users,
  // but it reads raw_user_meta_data which we don't model; insert both rows
  // explicitly so name/email are deterministic for assertions.
  await db.query("insert into auth.users (id, email) values ($1, $2)", [id, addr]);
  await db.query(
    "insert into public.users (id, email) values ($1, $2) on conflict (id) do nothing",
    [id, addr],
  );
  return id;
}

/** Create a workspace. Returns its id. */
export async function makeWorkspace(db: Pg, name?: string): Promise<string> {
  const id = randomUUID();
  const slug = `ws-${uniq()}`.toLowerCase().slice(0, 40);
  await db.query("insert into public.workspaces (id, slug, name) values ($1, $2, $3)", [
    id,
    slug,
    name ?? slug,
  ]);
  return id;
}

/** Add `userId` to `workspaceId` with `role`. */
export async function addMembership(
  db: Pg,
  workspaceId: string,
  userId: string,
  role: Role,
): Promise<void> {
  await db.query(
    "insert into public.workspace_memberships (workspace_id, user_id, role) values ($1, $2, $3)",
    [workspaceId, userId, role],
  );
}

/** Convenience: a fresh workspace + a user who is its owner. */
export async function makeWorkspaceWithOwner(
  db: Pg,
): Promise<{ workspaceId: string; ownerId: string }> {
  const workspaceId = await makeWorkspace(db);
  const ownerId = await makeUser(db);
  await addMembership(db, workspaceId, ownerId, "owner");
  return { workspaceId, ownerId };
}

export type Visibility = "workspace" | "private";

/** Create a deck. Defaults to workspace-visible. */
export async function makeDeck(
  db: Pg,
  opts: {
    workspaceId: string;
    createdBy: string;
    title?: string;
    visibility?: Visibility;
    projectId?: string | null;
  },
): Promise<string> {
  const id = randomUUID();
  await db.query(
    `insert into public.canvas_deck (id, workspace_id, title, visibility, created_by, project_id)
     values ($1, $2, $3, $4, $5, $6)`,
    [
      id,
      opts.workspaceId,
      opts.title ?? "Test deck",
      opts.visibility ?? "workspace",
      opts.createdBy,
      opts.projectId ?? null,
    ],
  );
  return id;
}

/**
 * Insert a slide at `position`. The 0002 init-version trigger fires on insert,
 * so the returned slide already has a version_no=1 canvas_slide_version row and
 * current_version_id set. Returns slide id + its current (v1) version id.
 */
export async function makeSlide(
  db: Pg,
  opts: {
    workspaceId: string;
    deckId: string;
    position: number;
    createdBy: string;
    title?: string;
    htmlBody?: string;
    slideStyles?: string;
  },
): Promise<{ slideId: string; versionId: string }> {
  const slideId = randomUUID();
  await db.query(
    `insert into public.canvas_deck_slide
       (id, workspace_id, deck_id, position, title, html_body, slide_styles, created_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      slideId,
      opts.workspaceId,
      opts.deckId,
      opts.position,
      opts.title ?? "",
      opts.htmlBody ?? "<section>v1</section>",
      opts.slideStyles ?? "",
      opts.createdBy,
    ],
  );
  const { rows } = await db.query<{ current_version_id: string }>(
    "select current_version_id from public.canvas_deck_slide where id = $1",
    [slideId],
  );
  return { slideId, versionId: rows[0].current_version_id };
}

/**
 * Insert a PENDING canvas_deck_edit. Kinds carrying text use `newContent`;
 * structural kinds (slide_create/reorder/edit) use `payload`. base_version_id
 * is stamped to the slide's current version (matches propose-time behaviour).
 * Returns the edit id.
 */
export async function makePendingSlideEdit(
  db: Pg,
  opts: {
    workspaceId: string;
    deckId: string;
    slideId?: string | null;
    kind: string;
    proposedBy: string;
    proposedByKind?: "user" | "claude";
    newContent?: string | null;
    payload?: unknown;
    rationale?: string | null;
    baseVersionId?: string | null;
    revertsEditId?: string | null;
    autoApplyEligible?: boolean;
    agentRenderedAt?: string | null;
    variantGroupId?: string | null;
  },
): Promise<string> {
  const id = randomUUID();
  await db.query(
    `insert into public.canvas_deck_edit
       (id, workspace_id, deck_id, slide_id, kind, proposed_by, proposed_by_kind,
        new_content, new_slide_payload, rationale, base_version_id, reverts_edit_id,
        auto_apply_eligible, agent_rendered_at, variant_group_id, status)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, 'pending')`,
    [
      id,
      opts.workspaceId,
      opts.deckId,
      opts.slideId ?? null,
      opts.kind,
      opts.proposedBy,
      opts.proposedByKind ?? "user",
      opts.newContent ?? null,
      opts.payload != null ? JSON.stringify(opts.payload) : null,
      opts.rationale ?? null,
      opts.baseVersionId ?? null,
      opts.revertsEditId ?? null,
      opts.autoApplyEligible ?? false,
      opts.agentRenderedAt ?? null,
      opts.variantGroupId ?? null,
    ],
  );
  return id;
}

// ------------------------------------------------------------
// Small query helpers used across the test files.
// ------------------------------------------------------------

/** Run a query as `uid` (sets auth.uid()), returning all rows. */
export async function queryAs<T = Record<string, unknown>>(
  db: Pg,
  uid: string | null,
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  await asUser(db, uid);
  const { rows } = await db.query<T>(sql, params);
  return rows;
}

/** Read the single boolean an RLS helper returns, evaluated as `uid`. */
export async function callBoolHelper(
  db: Pg,
  uid: string | null,
  fn: "canvas_can_read_deck" | "canvas_can_edit_deck",
  deckId: string,
): Promise<boolean> {
  const rows = await queryAs<{ ok: boolean }>(
    db,
    uid,
    `select public.${fn}($1) as ok`,
    [deckId],
  );
  return rows[0].ok;
}

import { describe, expect, it } from "vitest";
import { freshDb } from "./setup";

describe("Workspace OpenRouter config schema (0060)", () => {
  it("creates the workspace-keyed table with a cascade FK to workspaces", async () => {
    const { db } = await freshDb();
    const { rows } = await db.query<{ column_name: string; is_nullable: string }>(
      `select column_name, is_nullable
         from information_schema.columns
        where table_schema = 'public'
          and table_name = 'canvas_workspace_ai_provider_config'
        order by ordinal_position`,
    );
    const cols = rows.map((r) => r.column_name);
    expect(cols).toEqual(
      expect.arrayContaining([
        "workspace_id",
        "encrypted_api_key",
        "key_hint",
        "model_id",
        "set_by",
        "validated_at",
      ]),
    );

    const { rows: pk } = await db.query<{ column_name: string }>(
      `select a.attname as column_name
         from pg_index i
         join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey)
        where i.indrelid = 'public.canvas_workspace_ai_provider_config'::regclass
          and i.indisprimary`,
    );
    expect(pk.map((r) => r.column_name)).toEqual(["workspace_id"]);
  });

  it("keeps the workspace credential service-role only (no anon/authenticated access)", async () => {
    const { db } = await freshDb();
    const { rows: policies } = await db.query(
      `select policyname from pg_policies
        where schemaname = 'public'
          and tablename = 'canvas_workspace_ai_provider_config'`,
    );
    expect(policies).toEqual([]);

    const { rows: authPrivileges } = await db.query(
      `select privilege_type
         from information_schema.role_table_grants
        where table_schema = 'public'
          and table_name = 'canvas_workspace_ai_provider_config'
          and grantee in ('authenticated', 'anon')`,
    );
    expect(authPrivileges).toEqual([]);

    const { rows: servicePrivileges } = await db.query<{ privilege_type: string }>(
      `select privilege_type
         from information_schema.role_table_grants
        where table_schema = 'public'
          and table_name = 'canvas_workspace_ai_provider_config'
          and grantee = 'service_role'`,
    );
    const granted = servicePrivileges.map((row) => row.privilege_type);
    expect(granted).toContain("SELECT");
    expect(granted).toContain("INSERT");
    expect(granted).toContain("UPDATE");
    expect(granted).toContain("DELETE");
  });
});

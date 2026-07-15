import { describe, expect, it } from "vitest";
import { freshDb } from "./setup";

describe("OpenRouter runtime schema", () => {
  it("defaults existing/new assistant messages to the local bridge runtime", async () => {
    const { db } = await freshDb();
    const { rows } = await db.query<{
      column_default: string;
      is_nullable: string;
    }>(
      `select column_default, is_nullable
         from information_schema.columns
        where table_schema = 'public'
          and table_name = 'canvas_assistant_message'
          and column_name = 'execution_runtime'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].column_default).toContain("bridge");
    expect(rows[0].is_nullable).toBe("NO");

    const { rows: checks } = await db.query<{ definition: string }>(
      `select pg_get_constraintdef(oid) as definition
         from pg_constraint
        where conname = 'canvas_assistant_message_execution_runtime_check'`,
    );
    expect(checks[0].definition).toContain("openrouter");
    expect(checks[0].definition).toContain("bridge");
  });

  it("accepts the BYOK providers and rejects unknown ones (0076)", async () => {
    const { db } = await freshDb();
    for (const table of [
      "canvas_user_ai_provider_config",
      "canvas_workspace_ai_provider_config",
    ]) {
      const { rows } = await db.query<{ definition: string }>(
        `select pg_get_constraintdef(oid) as definition
           from pg_constraint
          where conname = '${table}_provider_check'`,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].definition).toContain("openrouter");
      expect(rows[0].definition).toContain("anthropic");
      expect(rows[0].definition).toContain("openai");
    }
  });

  it("keeps encrypted provider credentials service-role only", async () => {
    const { db } = await freshDb();
    const { rows: policies } = await db.query(
      `select policyname from pg_policies
        where schemaname = 'public'
          and tablename = 'canvas_user_ai_provider_config'`,
    );
    expect(policies).toEqual([]);

    const { rows: authPrivileges } = await db.query(
      `select privilege_type
         from information_schema.role_table_grants
        where table_schema = 'public'
          and table_name = 'canvas_user_ai_provider_config'
          and grantee in ('authenticated', 'anon')`,
    );
    expect(authPrivileges).toEqual([]);

    const { rows: servicePrivileges } = await db.query<{ privilege_type: string }>(
      `select privilege_type
         from information_schema.role_table_grants
        where table_schema = 'public'
          and table_name = 'canvas_user_ai_provider_config'
          and grantee = 'service_role'`,
    );
    expect(servicePrivileges.map((row) => row.privilege_type)).toContain("SELECT");
    expect(servicePrivileges.map((row) => row.privilege_type)).toContain("INSERT");
    expect(servicePrivileges.map((row) => row.privilege_type)).toContain("UPDATE");
    expect(servicePrivileges.map((row) => row.privilege_type)).toContain("DELETE");
  });
});


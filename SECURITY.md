# Security policy

## Reporting a vulnerability

Please **do not** open a public issue for security problems. Email
**security@21xventures.com** with a description and, if possible, a reproduction.
We aim to acknowledge within a few business days.

## Notes for self-hosters

Canvas relies on **Supabase Row-Level Security** for all tenant isolation. The
`NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` are, by
design, shipped to the browser — they are not secrets. Your database is only as
safe as your RLS policies, so:

- Review every policy in `app/supabase/migrations/` before exposing a project to
  the internet. The `canvas_*` tables and the tenancy tables (`workspaces`,
  `workspace_memberships`, …) all gate on the `public.is_workspace_member` /
  `is_workspace_admin_or_owner` helpers — confirm they behave as you expect.
- Keep `SUPABASE_SECRET_KEY` server-only. It bypasses RLS (service role) and is
  used by the parser, MCP token revocation, and workspace creation. Never expose
  it to the browser, never commit it.
- Per-user MCP tokens grant deck access; treat them like passwords.

# ADR-0004 — Canvas becomes a standalone product

**Status:** accepted
**Date:** 2026-05
**Supersedes (in part):** [ADR-0001](0001-product-shape.md) — only the "shared Supabase" half. The "sibling product / separate repo / distinct domain" half still stands.

## Context

ADR-0001 framed Canvas as a sibling of an internal workforce-management app: separate repo and distinct domain, but **sharing the same Supabase project** (a shared platform project) so that workspaces, users, memberships, invites, and the Google OAuth session were one set of rows reused by both apps. The original argument was that a deck might link to a workforce-management Client or Proposal, and that sharing the auth session let users move between the two apps without re-logging in.

In practice we hit four problems:

1. **Coupled migrations.** Any schema change Canvas wanted to make in `public.*` had to be coordinated with workforce-management — the two apps shared the same `public` namespace plus the same `workspaces` / `users` / `workspace_memberships` rows. Even purely Canvas-scoped concerns (e.g. a new RLS helper, a new `canvas_*` table) had to be reviewed for impact on the other side.
2. **Cross-product blast radius.** A bad workforce-management migration could brick Canvas, and vice versa. Two products at very different maturity levels (Canvas v0 → v1 vs. workforce-management running real CRM data) had no isolation between them.
3. **Workforce-only artifacts everywhere.** Canvas had to keep importing workforce-management's RLS helpers, dragging in references to `public.clients`, `public.proposals`, `log_*_activity` triggers, and `rls_auto_enable` event triggers — concepts Canvas doesn't model and shouldn't have to know about.
4. **Shared auth surface drag.** Email templates, OAuth client redirect URLs, Site URL, and rate limits were all configured for workforce-management. Tweaking the magic-link email for Canvas would change it for workforce-management too. We never actually shipped the cross-app session because the cookie scope (a shared parent domain) was never wired up in production; the theoretical benefit didn't justify the coupling cost.

The Client/Proposal link from a Deck has had **zero** confirmed uses in Canvas v0 so far — it's a column with no UI today. Keeping a hard foreign key to enforce something we don't use is the worst of both worlds.

## Decision

Canvas becomes a fully standalone product:

- **Own Supabase project.** A dedicated project (`canvas-prod`, region `us-east-1`), separate from the old shared platform project.
- **Own auth.** Separate Google OAuth client, separate magic-link email template, separate Site URL / Redirect URL allowlist. No shared session with the old shared app — users sign into Canvas separately.
- **Own workspaces.** Canvas has its own `public.workspaces` table, seeded with the primary workspace at the same UUID the old app used so cross-app references line up. Membership rows are independent — being a member in the old app does **not** make you a member in Canvas. A domain auto-join trigger (migration 0013) handles the common case of the same person needing access to both.
- **Own envs.** `NEXT_PUBLIC_SUPABASE_URL` and `SUPABASE_SECRET_KEY` point at the Canvas project. The Vercel environment is updated to match. `app/.env.example` reflects the new URL.

## What changed in the schema

The split is implemented in three commits worth of migration changes:

### `0000_workspace_foundation.sql` (new)

Verbatim port of `21x-workforce-management`'s `0001_core_tenancy.sql` + `0002_core_rls.sql`:

- `public.workspaces` (with the `workspaces_slug_format` check `^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$`)
- `public.users` (mirrors `auth.users` 1:1 via the `on_auth_user_created` trigger)
- `public.workspace_role` enum
- `public.workspace_memberships`
- `public.workspace_invites`
- RLS helpers: `is_workspace_member`, `is_workspace_owner`, `is_workspace_admin_or_owner`, `is_co_member` (SECURITY DEFINER, granted to `authenticated`)
- RLS policies on all four tables
- `set_updated_at()` trigger + `handle_new_auth_user()` trigger
- Seed row: a default workspace at a fixed seed UUID

The seed UUID is intentionally the same as the old shared project's so the existing `workspace_domain_auto_join` trigger (migration 0013) routes matching-domain emails to the right place without any change. **No data migration** ran — when the first matching-domain user signs into Canvas, the trigger creates their membership fresh. The first such user gets auto-joined as `member`; promote them to `owner` manually one time to bootstrap.

This migration sits at `0000` (before `0001_canvas_schema.sql`) because every other migration references `public.workspaces` / `public.users` / `is_workspace_member`.

### `0001_canvas_schema.sql` (edited)

`canvas_deck.client_id` and `canvas_deck.proposal_id` used to be foreign keys to `public.clients(id)` and `public.proposals(id)`. Those tables don't exist in the Canvas project, so the FKs were dropped:

```sql
-- before:
client_id uuid references public.clients(id) on delete set null,
proposal_id uuid references public.proposals(id) on delete set null,
-- after:
client_id uuid,
proposal_id uuid,
```

The columns and their `btree` indexes are preserved so any deck row that already records a CRM link keeps it (as a plain UUID — readable from the workforce-management app if it queries by it, but no longer integrity-enforced).

### `0008_canvas_security_followup.sql` (edited)

The original migration revoked `EXECUTE` on five workforce-only functions that don't exist in this project: `log_client_activity`, `log_project_activity`, `log_proposal_activity`, `log_task_activity`, and `rls_auto_enable`. Those REVOKEs are gone. The REVOKEs on the canvas-specific and shared-foundation functions (`canvas_apply_edit`, `handle_new_auth_user`, `set_updated_at`, `is_workspace_*`, …) stay.

## Cutover

Fresh start. **No data migration** between the two projects. The decision log:

- Canvas v0 had a handful of test decks in the shared project; the real client deck is rebuildable from the source HTML we have in `app/tests/fixtures/`. The cost of writing a one-time pg_dump / massaged-insert pipeline did not justify keeping ~5 deck rows.
- Canvas users had memberships in the old shared project; after the cutover they need to sign into the new project and either (a) get auto-joined via the domain trigger or (b) be re-invited from `/settings/members`.
- Active MCP tokens were dropped — users re-issue from `/settings/mcp`. Tokens have always been treated as personal short-lived secrets; revoking-and-reissuing is a one-minute self-service.

The cutover order Bernardo executed:

1. Apply migrations 0000 → 0014 to the fresh `21x-canvas-prod` project.
2. Sign in once with a matching-domain email → auto-joined to the default workspace as `member`.
3. Manually promote `bernardo` to `owner` (one-time bootstrap; future workspaces created from the UI default to owner via `createWorkspaceAction`).
4. Swap `.env.local` and the Vercel project env vars to the new URL + keys.
5. Update the OAuth client + Supabase auth dashboard (Site URL, redirect URLs, magic-link template).
6. Re-issue MCP tokens, re-invite teammates.

Workforce-management is untouched by this change.

## What this unlocks

- **Independent migrations.** Canvas can iterate on `public.*` and its own RLS helpers without coordinating with workforce-management. Migrations apply to one project at a time.
- **Right-sized blast radius.** A bad Canvas migration can only break Canvas. A bad workforce-management migration can only break workforce-management.
- **Workspaces as a first-class concept.** Now that Canvas owns the tenancy tables, users can create their own workspaces from the app (`createWorkspaceAction`, `/no-workspace`, `/settings/workspace`, the topbar switcher's new "+ New workspace" affordance). The previous "ask Bernardo to provision a workspace via the admin client" pattern is gone — users self-serve.
- **Per-product auth UX.** Canvas's magic-link email can say "Canvas"; the OAuth consent screen can say "21x Canvas"; redirect URLs are tight.

## What this gives up

- **No cross-app session.** Signing into Canvas does not sign you into workforce-management. We never actually wired this up so the practical impact is zero, but the door is closed.
- **Client/Proposal soft link is no longer integrity-checked.** A deck can carry a `client_id` UUID that points at a deleted workforce-management client; nobody enforces it. Acceptable because the link has no UI today.
- **Two Supabase bills instead of one.** Marginal at our usage.
- **Schema drift risk.** The workspace-tenancy tables in Canvas and workforce-management are identical today (verbatim port) but will drift as each side adds columns. Either we re-port deliberately, or we accept drift — for now we accept it.

## Related code

- `app/supabase/migrations/0000_workspace_foundation.sql` — the port
- `app/src/lib/auth/actions.ts` — `createWorkspaceAction` / `renameWorkspaceAction` / `deleteWorkspaceAction` (workspaces are user-creatable now)
- `app/src/app/(auth)/no-workspace/` — landing page for signed-in users with zero memberships; offers Create-workspace instead of asking for an invite
- `app/src/app/settings/workspace/` — workspace identity + danger zone
- `app/src/components/workspace-switcher.tsx` — topbar dropdown grew a "+ New workspace" affordance
- `app/supabase/migrations/0013_workspace_domain_auto_join.sql` — still works unchanged; routes the configured domain to the seed workspace

## Open questions

- **Domain link to workforce-management?** If we ever want to surface "this deck was sent for client X (from workforce-management)" in Canvas, we now need an explicit cross-app lookup (HTTP / Supabase Edge Function), not a join. We'll cross that when the use case is real.
- **Workspace deletion cascades.** `public.workspaces ON DELETE CASCADE` rolls down to every Canvas table that has `workspace_id`. The delete action currently uses the user-context client gated by the RLS policy `owners delete workspace`. This works for small workspaces; very large workspaces (thousands of decks, snapshots, versions) will hit Supabase's HTTP-layer timeout. Out of scope for now; revisit if we ever have a workspace big enough to feel it.

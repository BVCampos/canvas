-- ============================================================
-- Canvas storage bucket — migration 0003
-- ============================================================
-- Private bucket for assets extracted from imported HTML decks (typically
-- base64 <img> data URLs hoisted out of the source file). Reads gated by
-- workspace membership; writes are done by the importer via the service-role
-- client and by authenticated members.
--
-- Path convention: {workspace_id}/{deck_id}/{asset_id}.{ext}
-- The first folder segment is the workspace_id; RLS pins membership against
-- it. The second segment is the deck_id (lets us list assets per deck cheaply
-- via storage.list); the leaf is the asset row id from canvas_deck_asset.
-- ============================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'decks',
  'decks',
  false,
  20971520, -- 20 MB per asset; the seed deck's largest image is ~80KB
  array[
    'image/png',
    'image/jpeg',
    'image/gif',
    'image/webp',
    'image/svg+xml',
    'image/avif',
    'font/woff',
    'font/woff2',
    'application/octet-stream'
  ]
)
on conflict (id) do nothing;

create policy "members read deck assets"
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'decks'
    and public.is_workspace_member(((storage.foldername(name))[1])::uuid)
  );

create policy "members upload deck assets"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'decks'
    and public.is_workspace_member(((storage.foldername(name))[1])::uuid)
  );

create policy "admins delete deck assets"
  on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'decks'
    and public.is_workspace_admin_or_owner(((storage.foldername(name))[1])::uuid)
  );

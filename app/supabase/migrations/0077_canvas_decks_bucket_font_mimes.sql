-- ============================================================
-- Decks bucket mime allow-list catches up with the parser — migration 0077
-- ============================================================
-- The importer lifts data-URI assets whose mime passes the parser's
-- ASSET_MIME_ALLOWLIST (src/lib/canvas/parser.ts) and uploads each one to the
-- `decks` bucket. The bucket's allowed_mime_types (0003) was a NARROWER list:
-- a deck embedding a TTF font parsed fine, then the storage upload rejected
-- `font/ttf` and the whole import failed ("mime type font/ttf is not
-- supported" — hit in prod 2026-07-11, three failed uploads).
--
-- This makes the bucket accept every mime the parser can emit (its aliases
-- now normalize onto these canonical spellings at decode time).
-- tests/db/storage-bucket-mimes.test.ts pins the two lists together so they
-- can't drift apart again. image/svg+xml and application/octet-stream stay
-- from 0003: the parser never lifts them, but existing objects/flows may
-- carry them, and the asset route neutralizes non-inert types at serve time.

update storage.buckets
set allowed_mime_types = array[
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/svg+xml',
  'image/avif',
  'image/bmp',
  'image/x-icon',
  'font/woff',
  'font/woff2',
  'font/ttf',
  'font/otf',
  'application/octet-stream'
]
where id = 'decks';

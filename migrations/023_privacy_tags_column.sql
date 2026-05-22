-- 023_privacy_tags_column.sql
-- Mnestra schema PR — adds privacy_tags column for category-tagged content
-- filtering at memory_recall time. Required by Brad's pka (Personal Knowledge
-- Archive) project, kicked off 2026-05-18, which mirrors archive items into
-- memory_items with project='archive' and needs to mark sensitive content
-- (finance / health / legal / family-private) so default recall queries from
-- coding/work sessions exclude it. Explicit opt-in via the new
-- include_privacy[] parameter on memory_recall surfaces the tagged items.
--
-- DESIGN NOTES
--
-- (1) Orthogonal to existing src/privacy.ts <private>...</private> redaction.
--     That existing concept strips secret-block text at WRITE time
--     (memory_remember). privacy_tags works at QUERY time on whole items —
--     they don't overlap. Both can be active on the same row without
--     interaction.
--
-- (2) Filter is implemented at the recall.ts layer, NOT in
--     memory_hybrid_search. Keeping the RPC at the 8-arg canonical signature
--     (post-Sprint-51.9, current as of migration 019) avoids the drift
--     pattern that broke Rumen 0.5.2 (Sprint 54 → Sprint 56 fix; the same
--     class of cross-package signature drift that npm-pack inspection later
--     caught). recall.ts post-fetches results, then filters out items whose
--     privacy_tags overlap the EXCLUDED set (= all known tags minus the
--     caller's include_privacy[] opt-in list).
--
-- (3) Default behavior preserves backward compatibility:
--     - All existing memory_items rows get privacy_tags = ARRAY[]::text[]
--       (nullable column with empty-array default; existing rows untouched).
--     - memory_recall callers that don't pass include_privacy see no
--       behavior change (the post-fetch filter is a no-op when no item has
--       a privacy_tags value AND the caller didn't request a tag scope).
--     - New callers that pass include_privacy=['finance'] see only items
--       tagged 'finance' (plus items with no tag at all if the recall
--       layer is configured to include untagged — TBD, see §F3
--       discussion in /opt/projects/pka/CLAUDE.md).
--
-- (4) GIN index supports fast tag-presence queries when callers want
--     server-side filtering at scale (Phase 2+ if app-layer filter becomes
--     a perf bottleneck). For now the index is built but not exercised by
--     the RPC; it's free insurance.
--
-- (5) Migration is fully reversible — DROP INDEX + ALTER TABLE DROP COLUMN.
--     See reversal block at end of file.

-- ── 1. Add the column ─────────────────────────────────────────────────────
alter table public.memory_items
  add column if not exists privacy_tags text[] not null default array[]::text[];

comment on column public.memory_items.privacy_tags is
  'Optional category tags for memory items containing sensitive content. '
  'Recognized values: finance, health, legal, family, work-confidential. '
  'memory_recall default behavior excludes items with non-empty privacy_tags '
  'from work/coding sessions; explicit include_privacy[] parameter surfaces '
  'them. Orthogonal to src/privacy.ts <private>...</private> write-time '
  'redaction — both concepts coexist without interaction. Added 2026-05-18 '
  'for Brad pka (Personal Knowledge Archive) integration.';

-- ── 2. GIN index for tag-presence queries ─────────────────────────────────
-- Future-proofs server-side filtering if app-layer becomes a bottleneck.
-- Partial index on the active+non-archived subset to match the existing
-- index pattern (idx_memory_items_project, idx_memory_items_source_type).

create index if not exists idx_memory_items_privacy_tags
  on public.memory_items using gin (privacy_tags)
  where is_active = true and archived = false;

comment on index idx_memory_items_privacy_tags is
  'Supports server-side privacy_tags filtering at scale. Not exercised by '
  'memory_hybrid_search today (filter lives in src/recall.ts layer to keep '
  'RPC signature stable). Available for future RPC variant if needed.';

-- ── 3. Verification SQL (run manually after apply) ────────────────────────
--
--   select column_name, data_type, column_default, is_nullable
--   from information_schema.columns
--   where table_schema='public' and table_name='memory_items'
--     and column_name='privacy_tags';
--   -- expect: text array (ARRAY), default array[]::text[], nullable NO
--
--   select indexname from pg_indexes
--   where schemaname='public' and tablename='memory_items'
--     and indexname='idx_memory_items_privacy_tags';
--   -- expect: 1 row returned
--
--   -- Existing-row backward compatibility check:
--   select count(*) filter (where privacy_tags = array[]::text[]) as empty_tags,
--          count(*) filter (where privacy_tags is null) as null_tags,
--          count(*) as total
--   from memory_items;
--   -- expect: empty_tags = total, null_tags = 0

-- ── REVERSAL (do not execute as part of apply; copy when needed) ──────────
--
--   drop index if exists public.idx_memory_items_privacy_tags;
--   alter table public.memory_items drop column if exists privacy_tags;

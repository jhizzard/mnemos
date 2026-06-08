-- Mnestra — privacy_tags column + GIN index + memory_hybrid_search RETURNS TABLE extension
--
-- Source: Brad Heath / Nacho Money LLC 2026-05-18 schema-PR proposal
-- ("privacy_tags column + include_privacy[] recall filter"). Unblocks Brad's
-- pka (Personal Knowledge Archive) — a ~20-year corpus mirrored into
-- memory_items with project='archive', where some items must be excluded from
-- default recall and surfaced only on explicit opt-in.
--
-- WHAT THIS ADDS
--   1. public.memory_items.privacy_tags text[] NOT NULL DEFAULT array[]::text[]
--      — open-ended categorical tags for sensitive content.
--   2. A GIN index on privacy_tags (free insurance for a future server-side
--      filter; the v1 filter is applied JS-side in src/recall.ts).
--   3. privacy_tags added as an OUTPUT column to memory_hybrid_search's
--      RETURNS TABLE, so the recall-layer filter reads the tags straight off
--      each RPC row instead of issuing a follow-up N+1 SELECT. (Orchestrator
--      decision on Brad's open-Q#1: YES, extend RETURNS TABLE.)
--
-- NON-CONFLICT WITH src/privacy.ts (do not conflate the two):
--   src/privacy.ts::stripPrivate strips <private>…</private> text blocks at
--   WRITE time — it edits the stored content. privacy_tags are whole-item
--   categorical labels filtered at QUERY time — they never touch content.
--   The two are ORTHOGONAL: a single row can be stripped AND tagged with no
--   interaction. This migration adds only the query-time mechanism.
--
-- WHY THIS IS A DROP + CREATE, NOT A PLAIN CREATE OR REPLACE (the careful part):
--   Adding a column to a function's RETURNS TABLE changes its return type
--   (RETURNS TABLE columns are OUT parameters). Postgres rejects that via
--   CREATE OR REPLACE — "cannot change return type of existing function" — so
--   the function must be DROPped and recreated. This is already documented
--   in-tree: src/recall.ts:141-143 explains that source_agent was deliberately
--   kept OFF this RPC because adding it "would require a DROP+CREATE on the hot
--   RPC." We now pay that cost for privacy_tags by design.
--
--   We drop ALL public.memory_hybrid_search overloads first (signature-agnostic
--   DO-block, identical to migration 002's preamble). That guarantees a single
--   8-arg function afterward and clears any historical drift overload (the
--   never-shipped 10-arg recency_weight/decay_days variant 002 warns about).
--
-- WHY THE RLS-HYGIENE RE-ISSUE BELOW IS LOAD-BEARING, NOT COSMETIC:
--   A DROP+CREATE produces a BRAND-NEW function. Its privileges and config
--   reset to defaults — which on this database means:
--     * Postgres grants EXECUTE to PUBLIC by default, AND
--     * migration 014 set `alter default privileges in schema public grant
--       execute on functions to service_role, authenticated, anon`.
--   So the new function is callable by public + anon + authenticated unless we
--   explicitly REVOKE — silently re-opening hole class #2 that migration 019
--   closed. Likewise proconfig starts empty, so the body MUST re-pin
--   `set search_path = public, extensions, pg_catalog`. `extensions` is
--   required: pgvector's `<=>` cosine operator lives in the extensions schema
--   on Supabase >= 2024 installs (this is the exact 0.4.4→0.4.6 regression
--   that motivated 019's revision — see migrations/019_security_hardening.sql).
--
-- SECURITY INVOKER (not DEFINER) is preserved deliberately:
--   migrations 002 and 004 declare this function `language sql stable` with NO
--   `security definer`; migration 019 never added it. Per the global hygiene
--   rule ("security definer — only if truly needed; default to invoker"), a
--   recall function read by the service_role MCP server stays INVOKER. Making
--   it DEFINER would be a privilege-escalation regression, not hardening.
--
-- BASIS:
--   SQL body  → migration 004 (last full-body redefinition; carries the
--               match_count cap). privacy_tags is threaded through the
--               candidates → fused → scored CTEs and appended LAST in both the
--               RETURNS TABLE list and the final SELECT, so no existing output
--               column moves (recall.ts maps by-name via PostgREST JSON; any
--               positional reader is also safe because new col is last).
--   Hygiene   → migration 019 (search_path = public, extensions, pg_catalog;
--               REVOKE from public/anon/authenticated; GRANT to service_role).
--
-- IDEMPOTENT / RERUN-SAFE: column + index use IF NOT EXISTS; the drop loop
--   iterates zero times on a fresh schema; the CREATE is CREATE OR REPLACE; the
--   revoke/grant DO-block derives the live signature from pg_proc.
--
-- APPLY-TIME PRECONDITION: run with the pgvector type reachable (same as 002 /
--   004 — the `vector(1536)` parameter must resolve at CREATE time). On Supabase
--   the SQL editor / linked role search_path already includes `extensions`.

-- ====================================================================
-- 1. Column + GIN index
-- ====================================================================

alter table public.memory_items
  add column if not exists privacy_tags text[] not null default array[]::text[];

comment on column public.memory_items.privacy_tags is
  'Open-ended categorical privacy labels (Brad 2026-05-18). Query-time recall '
  'filter (src/recall.ts include_privacy[]); default-excluded from recall. '
  'Orthogonal to src/privacy.ts stripPrivate, which strips <private> blocks at '
  'write time.';

create index if not exists memory_items_privacy_tags_gin
  on public.memory_items using gin (privacy_tags);

-- ====================================================================
-- 2. Extend memory_hybrid_search RETURNS TABLE with privacy_tags.
--
-- 2a. Drop every existing public.memory_hybrid_search overload so the
--     return-type change can land (CREATE OR REPLACE cannot change a
--     function's return type). Signature-agnostic — mirrors migration 002.
--     Scoped to proname = 'memory_hybrid_search' exactly, so the sibling
--     memory_hybrid_search_explain function is untouched.
-- ====================================================================

do $$
declare
  r record;
begin
  for r in
    select p.oid::regprocedure as sig
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where p.proname = 'memory_hybrid_search'
       and n.nspname = 'public'
  loop
    execute 'drop function ' || r.sig::text;
  end loop;
end $$;

-- 2b. Recreate with the canonical 8-arg INPUT signature unchanged and
--     privacy_tags appended LAST to the output. Body = migration 004 verbatim
--     with privacy_tags threaded through; search_path re-pinned (proconfig was
--     cleared by the drop). language/volatility (sql stable) and SECURITY
--     INVOKER preserved.

create or replace function public.memory_hybrid_search (
  query_text          text,
  query_embedding     vector(1536),
  match_count         int default 20,
  full_text_weight    float default 1.0,
  semantic_weight     float default 1.0,
  rrf_k               int default 60,
  filter_project      text default null,
  filter_source_type  text default null
)
returns table (
  id           uuid,
  content      text,
  source_type  text,
  category     text,
  project      text,
  metadata     jsonb,
  score        float,
  created_at   timestamptz,
  privacy_tags text[]
)
language sql stable
set search_path = public, extensions, pg_catalog
as $$
with candidates as (
  select
    m.id,
    m.content,
    m.source_type,
    m.category,
    m.project,
    m.metadata,
    m.privacy_tags,
    m.created_at,
    m.embedding,
    ts_rank_cd(to_tsvector('english', m.content), plainto_tsquery('english', query_text))
      as ft_rank,
    1 - (m.embedding <=> query_embedding) as sem_rank,
    extract(epoch from (now() - m.created_at))::float as age_seconds
  from memory_items m
  where m.is_active = true
    and m.archived = false
    and m.superseded_by is null
    and m.embedding is not null
    and (filter_project is null or m.project = filter_project)
    and (filter_source_type is null or m.source_type = filter_source_type)
),
ft_ranked as (
  select id, row_number() over (order by ft_rank desc nulls last) as rank
  from candidates where ft_rank > 0
),
sem_ranked as (
  select id, row_number() over (order by sem_rank desc nulls last) as rank
  from candidates
),
fused as (
  select
    c.id,
    c.content,
    c.source_type,
    c.category,
    c.project,
    c.metadata,
    c.privacy_tags,
    c.created_at,
    c.age_seconds,
    coalesce(full_text_weight / (rrf_k + ft.rank), 0.0) +
    coalesce(semantic_weight  / (rrf_k + sr.rank), 0.0) as base_score
  from candidates c
  left join ft_ranked  ft on ft.id = c.id
  left join sem_ranked sr on sr.id = c.id
),
scored as (
  select
    f.id,
    f.content,
    f.source_type,
    f.category,
    f.project,
    f.metadata,
    f.privacy_tags,
    f.created_at,
    f.base_score
      * case f.source_type
          when 'decision'        then 1.0 / (1.0 + f.age_seconds / (365.0 * 86400.0))
          when 'architecture'    then 1.0 / (1.0 + f.age_seconds / (365.0 * 86400.0))
          when 'preference'      then 1.0 / (1.0 + f.age_seconds / (365.0 * 86400.0))
          when 'fact'            then 1.0 / (1.0 + f.age_seconds / ( 90.0 * 86400.0))
          when 'convention'      then 1.0 / (1.0 + f.age_seconds / ( 90.0 * 86400.0))
          when 'bug_fix'         then 1.0 / (1.0 + f.age_seconds / ( 30.0 * 86400.0))
          when 'debugging'       then 1.0 / (1.0 + f.age_seconds / ( 30.0 * 86400.0))
          when 'session_summary' then 1.0 / (1.0 + f.age_seconds / ( 14.0 * 86400.0))
          when 'document_chunk'  then 1.0 / (1.0 + f.age_seconds / ( 14.0 * 86400.0))
          when 'code_context'    then 1.0 / (1.0 + f.age_seconds / ( 14.0 * 86400.0))
          else                         1.0 / (1.0 + f.age_seconds / ( 30.0 * 86400.0))
        end
      * case f.source_type
          when 'decision'       then 1.5
          when 'architecture'   then 1.4
          when 'bug_fix'        then 1.3
          when 'preference'     then 1.2
          when 'fact'           then 1.0
          when 'document_chunk' then 0.6
          else                       1.0
        end
      * case
          when filter_project is null then 1.0
          when f.project = filter_project then 1.5
          when f.project = 'global' then 1.0
          else 0.7
        end
      as score
  from fused f
)
select
  s.id,
  s.content,
  s.source_type,
  s.category,
  s.project,
  s.metadata,
  s.score,
  s.created_at,
  s.privacy_tags
from scored s
order by s.score desc
limit least(
  greatest(match_count, 1),
  coalesce(nullif(current_setting('mnestra.max_match_count', true), '')::int, 200)
);
$$;

-- 2c. Re-pin RLS hygiene on the freshly created function (load-bearing — see
--     header). Signature derived from pg_proc so the `vector` type resolves
--     regardless of whether pgvector lives in `extensions` (Supabase >= 2024)
--     or `public` (older installs) — the same robustness migration 019 relies on.
do $$
declare
  sig text;
begin
  select format('public.%I(%s)', p.proname, pg_get_function_identity_arguments(p.oid))
    into sig
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname = 'memory_hybrid_search'
   limit 1;

  if sig is not null then
    execute format('revoke execute on function %s from public, anon, authenticated', sig);
    execute format('grant  execute on function %s to service_role', sig);
  end if;
end $$;

-- ====================================================================
-- 3a. Post-apply verification (run separately in the Studio SQL editor;
--     commented so the migration runner doesn't choke on result sets).
--
--   -- Column: present, text[], NOT NULL, default empty array
--   select data_type, is_nullable, column_default
--     from information_schema.columns
--    where table_schema='public' and table_name='memory_items'
--      and column_name='privacy_tags';
--   -- expect: ARRAY | NO | ARRAY[]::text[]   (udt_name = _text)
--
--   -- GIN index present
--   select indexname from pg_indexes
--    where schemaname='public' and tablename='memory_items'
--      and indexname='memory_items_privacy_tags_gin';
--
--   -- Function returns the new output column (and still resolves the <=> op):
--   select privacy_tags
--     from memory_hybrid_search('smoke', array_fill(0::real, ARRAY[1536])::vector, 1)
--    limit 1;   -- 1 row, privacy_tags present, no operator-resolution error
--
--   -- Hygiene: PUBLIC/anon/authenticated must NOT have EXECUTE; service_role must.
--   select has_function_privilege('public',       'public.memory_hybrid_search(text,vector,int,float,float,int,text,text)', 'EXECUTE') as public_exec,        -- expect f
--          has_function_privilege('anon',          'public.memory_hybrid_search(text,vector,int,float,float,int,text,text)', 'EXECUTE') as anon_exec,          -- expect f
--          has_function_privilege('authenticated', 'public.memory_hybrid_search(text,vector,int,float,float,int,text,text)', 'EXECUTE') as authenticated_exec, -- expect f
--          has_function_privilege('service_role',  'public.memory_hybrid_search(text,vector,int,float,float,int,text,text)', 'EXECUTE') as service_role_exec;  -- expect t
--
--   -- search_path pinned (must include extensions for pgvector):
--   select proconfig from pg_proc p join pg_namespace n on n.oid=p.pronamespace
--    where n.nspname='public' and p.proname='memory_hybrid_search';
--   -- expect: {search_path=public, extensions, pg_catalog}
-- ====================================================================

-- ====================================================================
-- 3b. Reversal (commented — apply by hand to roll back):
--
--   drop index if exists public.memory_items_privacy_tags_gin;
--   alter table public.memory_items drop column if exists privacy_tags;
--
--   -- Reverting the function is one-way through DROP+CREATE: re-apply
--   -- migration 004's body to restore the pre-023 8-output-column shape, then
--   -- re-apply migration 019's hygiene (REVOKE from public/anon/authenticated,
--   -- GRANT to service_role, SET search_path = public, extensions, pg_catalog).
-- ====================================================================

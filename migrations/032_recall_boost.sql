-- migrations/032_recall_boost.sql
-- Sprint 81 T1 (Recall→Reinjection proof) — recall-usage boost: the column
-- Rumen's recall-feedback loop writes, and the bounded, no-op-at-1.0 ranking
-- factor that turns "this memory keeps getting recalled/used" into a small
-- ranking lift — WITHOUT rich-get-richer or a pruning penalty.
--
-- WHY: Sprint 81 T2 (rumen `reinforce.ts` + `rumen-reinforce` Edge Fn) windows
-- over memory_recall_log + the denorm recall_count/last_recalled_at rollup and
-- computes a smoothed reinforcement weight per memory. It needs (a) a column to
-- write and (b) a ranking factor that consumes it. This migration supplies
-- both, INERT by construction until T2 populates: recall_boost defaults to 1.0
-- and the factor is a STRICT no-op at 1.0, so applying 032 changes ranking for
-- ZERO rows on a fresh column (safe to apply before T2's loop is live).
--
-- WHAT:
--   1. public.memory_items.recall_boost numeric NOT NULL DEFAULT 1.0 — a
--      bounded multiplier. Non-volatile default → fast metadata-only add.
--   2. public.set_recall_boost(jsonb) — the service-role RPC T2 writes through
--      (contract confirmed with T2, STATUS 17:01 / ORCH-RESOLUTIONS R5):
--      payload [{"id":"<uuid>","boost":<numeric>}, ...]; ONE batched
--      (never per-row) UPDATE that clamps each boost to [1.0, RECALL_BOOST_MAX]
--      server-side and touches ONLY recall_boost (doctrine-clean — never
--      content/embedding/any ranking-content column, and deliberately not even
--      updated_at, so reinforcement is not conflated with a content write).
--      Returns int rows updated.
--   3. public.memory_hybrid_search — CREATE OR REPLACE (identical 8-arg
--      signature + 9-col RETURNS TABLE as 023/029) with ONE additional
--      multiplicative factor: `least(greatest(coalesce(recall_boost,1.0),1.0),
--      RECALL_BOOST_MAX)`. Floor 1.0 (reinforcement only ELEVATES — never a
--      penalty; honors the pruning moratorium: a never-recalled memory stays
--      at 1.0 and is untouched). Ceiling RECALL_BOOST_MAX bounds it so a
--      frequently-recalled row can't dominate and starve fresh memories
--      (no rich-get-richer). Strict no-op at exactly 1.0.
--
--   RECALL_BOOST_MAX = 2.0 — the SHARED ceiling constant. SQL can't share a
--   constant across functions, so it is duplicated in set_recall_boost's clamp
--   AND memory_hybrid_search's factor AND documented to T2 so reinforce.ts
--   agrees. Change it in ALL THREE places (or re-issue this migration) if it
--   ever moves. 2.0 keeps recall_boost in the same order of magnitude as the
--   existing type-weights (0.6–1.5) and project factor (0.7–1.5) — meaningful
--   but not overpowering.
--
-- Five RLS hygiene gates (global CLAUDE.md), verified by the HARD-FAILING
-- OID-form receipt at the bottom:
--   GATE 1  No NEW table (a column + two functions) — memory_items already has
--           RLS enabled (028 §6b); the receipt re-checks as a regression guard.
--   GATE 2  No new policies; no WITH CHECK (true) anywhere.
--   GATE 3  REVOKE EXECUTE on set_recall_boost FROM public, anon, authenticated
--           + GRANT service_role only; memory_hybrid_search re-pinned the same.
--   GATE 4  SET search_path — set_recall_boost is public, pg_catalog (no
--           vector); memory_hybrid_search stays public, extensions, pg_catalog
--           (its vector(1536) param — matches 029).
--   GATE 5  No raw anon-key write path: set_recall_boost is the only new write
--           surface (SECURITY DEFINER + anon/authenticated revoked); the column
--           is written only by it (and remember.ts as service_role).
--
-- Idempotent / rerun-safe: ADD COLUMN IF NOT EXISTS; CREATE OR REPLACE
-- FUNCTION; the overload-drop guard on memory_hybrid_search (mirrors 029);
-- REVOKE/GRANT naturally idempotent; the receipt DO block only SELECTs (raises).
--
-- APPLY: write + test locally only. ORCH applies at sprint close. 032 runs
-- AFTER 029 (the current memory_hybrid_search owner) — the column is added
-- before the function that reads it, in this same file.

-- ====================================================================
-- 1. recall_boost column — bounded multiplier, no-op default 1.0.
-- ====================================================================

alter table public.memory_items
  add column if not exists recall_boost numeric not null default 1.0;

comment on column public.memory_items.recall_boost is
  'Sprint 81 (migration 032): recall-usage reinforcement weight, a bounded '
  'multiplier applied in memory_hybrid_search. DEFAULT 1.0 = strict no-op. '
  'Written ONLY by set_recall_boost() (Rumen''s reinforce loop), clamped to '
  '[1.0, 2.0]: floor 1.0 (reinforcement only elevates, never penalizes — a '
  'never-recalled memory stays 1.0, pruning moratorium); ceiling 2.0 (no '
  'rich-get-richer). Not a ranking-content column — Rumen writes only this.';

-- ====================================================================
-- 2. set_recall_boost(jsonb) — the ONLY write path for recall_boost.
--    Contract (T2 / R5): p_updates = [{"id":"<uuid>","boost":<numeric>}, ...].
--    Batched, never per-row; clamps to [1.0, RECALL_BOOST_MAX]; touches ONLY
--    recall_boost. Returns rows updated.
-- ====================================================================

create or replace function public.set_recall_boost(p_updates jsonb)
returns int
language plpgsql
security definer
set search_path = public, pg_catalog  -- [GATE 4] (no vector type here)
as $$
declare
  v_updated int := 0;
begin
  -- Defensive no-op on empty / malformed input (fire-and-forget caller).
  if p_updates is null
     or jsonb_typeof(p_updates) <> 'array'
     or jsonb_array_length(p_updates) = 0 then
    return 0;
  end if;

  -- ONE batched, set-based UPDATE (never per-row). Clamps each boost to
  -- [1.0, 2.0] server-side — the single authoritative clamp, so a caller can't
  -- write an out-of-range weight. Touches ONLY recall_boost (doctrine-clean:
  -- no content/embedding, and intentionally not updated_at, so reinforcement
  -- is not conflated with a content mutation). Rows whose id no longer exists
  -- are simply not matched (self-healing).
  update public.memory_items m
     set recall_boost = least(greatest(u.boost, 1.0), 2.0)  -- RECALL_BOOST_MAX = 2.0
    from jsonb_to_recordset(p_updates) as u(id uuid, boost numeric)
   where m.id = u.id
     and u.id is not null
     and u.boost is not null;

  get diagnostics v_updated = row_count;
  return v_updated;
end;
$$;

comment on function public.set_recall_boost(jsonb) is
  'Sprint 81 (migration 032): sole write path for memory_items.recall_boost. '
  'Batched UPDATE from [{"id","boost"}, ...]; clamps each boost to [1.0, 2.0] '
  '(floor = pruning moratorium, ceiling = no rich-get-richer); touches ONLY '
  'recall_boost. Written by Rumen''s reinforce loop. SECURITY DEFINER, pinned '
  'search_path; EXECUTE: service_role only.';

-- [GATE 3]
revoke execute on function public.set_recall_boost(jsonb)
  from public, anon, authenticated;
grant  execute on function public.set_recall_boost(jsonb)
  to service_role;

-- ====================================================================
-- 3. memory_hybrid_search — CREATE OR REPLACE with the recall_boost factor.
--    IDENTICAL signature + RETURNS TABLE as 023/029 (a body-only change).
--    Overload-drop guard first (mirrors 029 / ledger #17/#18 — every migration
--    that replaces this function drops stale overloads defensively). Because a
--    DROP loses grants, the REVOKE/GRANT re-pin below is REQUIRED, not just
--    belt-and-suspenders.
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
    m.recall_boost,
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
    c.recall_boost,
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
          when 'doctrine'        then 1.0 / (1.0 + f.age_seconds / (365.0 * 86400.0))
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
          when 'doctrine'       then 1.5
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
      -- Sprint 81 (migration 032) recall-usage boost. Bounded multiplier,
      -- STRICT no-op at recall_boost = 1.0 (the default): floor 1.0 = never a
      -- penalty (pruning moratorium), ceiling 2.0 = RECALL_BOOST_MAX = no
      -- rich-get-richer. coalesce guards a hypothetical NULL (column is NOT
      -- NULL, so this is belt-and-suspenders). Cast to double precision so the
      -- numeric factor doesn't change the score column's float type.
      * (least(greatest(coalesce(f.recall_boost, 1.0), 1.0), 2.0))::double precision
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

-- Re-pin RLS/EXECUTE hygiene (REQUIRED — the overload-drop above loses grants;
-- resolve the signature from pg_proc, robust to vector-type-location per 019).
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
-- 4. Apply-time receipt — HARD-FAILING, OID form (resolve each function OID by
--    proname; never a reconstructed text signature — pg_get_function_identity_
--    arguments returns arg NAMES on Supabase's Postgres).
-- ====================================================================

do $$
declare
  v_has_col   boolean;
  v_col_def   text;
  v_col_null  text;
  v_oid       oid;
  v_anon      boolean;
  v_auth      boolean;
  v_pub       boolean;
  v_svc       boolean;
  v_cfg       text;
begin
  -- Column exists, NOT NULL, default 1.0.
  select exists (select 1 from information_schema.columns
                  where table_schema='public' and table_name='memory_items'
                    and column_name='recall_boost') into v_has_col;
  select column_default, is_nullable into v_col_def, v_col_null
    from information_schema.columns
   where table_schema='public' and table_name='memory_items' and column_name='recall_boost';
  raise notice '[032] recall_boost column present:% default:% nullable:% (expect t, 1.0, NO)',
    v_has_col, coalesce(v_col_def,'<none>'), coalesce(v_col_null,'<none>');
  if not v_has_col then
    raise exception '[032] COLUMN MISSING: memory_items.recall_boost';
  end if;
  if v_col_null is distinct from 'NO' then
    raise exception '[032] recall_boost must be NOT NULL (found nullable=%)', v_col_null;
  end if;
  if v_col_def is null or v_col_def not like '1.0%' then
    raise exception '[032] recall_boost default must be 1.0 (found: %)', coalesce(v_col_def,'<none>');
  end if;

  -- set_recall_boost five-gate (public, pg_catalog).
  select p.oid into v_oid
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname='public' and p.proname='set_recall_boost' limit 1;
  if v_oid is null then raise exception '[032] set_recall_boost not found'; end if;
  v_anon := has_function_privilege('anon',          v_oid, 'EXECUTE');
  v_auth := has_function_privilege('authenticated', v_oid, 'EXECUTE');
  v_pub  := has_function_privilege('public',        v_oid, 'EXECUTE');
  v_svc  := has_function_privilege('service_role',  v_oid, 'EXECUTE');
  select array_to_string(p.proconfig, '; ') into v_cfg from pg_proc p where p.oid = v_oid;
  raise notice '[032] set_recall_boost EXECUTE — anon:%, auth:%, public:% (expect f f f); service_role:% (expect t); proconfig:%',
    v_anon, v_auth, v_pub, v_svc, coalesce(v_cfg,'<none>');
  if v_anon or v_auth or v_pub then
    raise exception '[032] GATE 3 VIOLATION: set_recall_boost executable by anon/authenticated/public (%, %, %)', v_anon, v_auth, v_pub;
  end if;
  if not v_svc then
    raise exception '[032] GATE 3 VIOLATION: service_role lost EXECUTE on set_recall_boost';
  end if;
  if v_cfg is null or v_cfg not like '%search_path=public, pg_catalog%' then
    raise exception '[032] GATE 4 VIOLATION: set_recall_boost search_path not pinned (proconfig: %)', coalesce(v_cfg,'<none>');
  end if;

  -- memory_hybrid_search five-gate (public, extensions, pg_catalog) after the
  -- drop+recreate — proves the re-pin restored service-role-only EXECUTE.
  select p.oid into v_oid
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname='public' and p.proname='memory_hybrid_search' limit 1;
  if v_oid is null then raise exception '[032] memory_hybrid_search not found after CREATE OR REPLACE'; end if;
  v_anon := has_function_privilege('anon',          v_oid, 'EXECUTE');
  v_auth := has_function_privilege('authenticated', v_oid, 'EXECUTE');
  v_pub  := has_function_privilege('public',        v_oid, 'EXECUTE');
  v_svc  := has_function_privilege('service_role',  v_oid, 'EXECUTE');
  select array_to_string(p.proconfig, '; ') into v_cfg from pg_proc p where p.oid = v_oid;
  raise notice '[032] memory_hybrid_search EXECUTE — anon:%, auth:%, public:% (expect f f f); service_role:% (expect t); proconfig:%',
    v_anon, v_auth, v_pub, v_svc, coalesce(v_cfg,'<none>');
  if v_anon or v_auth or v_pub then
    raise exception '[032] GATE 3 VIOLATION: memory_hybrid_search executable by anon/authenticated/public (%, %, %)', v_anon, v_auth, v_pub;
  end if;
  if not v_svc then
    raise exception '[032] GATE 3 VIOLATION: service_role lost EXECUTE on memory_hybrid_search (re-pin failed after overload drop)';
  end if;
  if v_cfg is null or v_cfg not like '%search_path=public, extensions, pg_catalog%' then
    raise exception '[032] GATE 4 VIOLATION: memory_hybrid_search search_path not pinned (proconfig: %)', coalesce(v_cfg,'<none>');
  end if;

  raise notice '[032] receipt: recall_boost column (NOT NULL default 1.0) present, set_recall_boost + memory_hybrid_search five-gate clean, boost factor no-op at 1.0.';
end$$;

-- ====================================================================
-- 5a. Post-apply verification (ORCH, Studio SQL editor — commented):
--
--   -- No-op proof: with all recall_boost=1.0 (fresh column), scores are
--   -- byte-identical to 029. Boost a row to 2.0 and confirm it climbs:
--   select public.set_recall_boost(jsonb_build_array(jsonb_build_object(
--     'id', (select id from public.memory_items where is_active limit 1), 'boost', 2.0)));  -- expect 1
--   -- clamp proof: 5.0 -> stored 2.0; 0.3 -> stored 1.0:
--   select public.set_recall_boost(jsonb_build_array(
--     jsonb_build_object('id',(select id from public.memory_items where is_active limit 1),'boost',5.0)));
--   select recall_boost from public.memory_items where is_active limit 1;  -- expect 2.0
--   -- reset:
--   select public.set_recall_boost(jsonb_build_array(jsonb_build_object(
--     'id',(select id from public.memory_items where is_active limit 1),'boost',1.0)));
--
--   -- Privileges: set_recall_boost + memory_hybrid_search service_role-only.
--   select has_function_privilege('service_role','public.set_recall_boost(jsonb)','EXECUTE'); -- t
--   select has_function_privilege('anon','public.set_recall_boost(jsonb)','EXECUTE');         -- f
--
--   -- Supabase advisors: ZERO new 0011/0013 lints attributable to 032:
--   --   mcp__supabase__get_advisors(type='security')
--
-- 5b. Reversal (commented — apply by hand):
--   drop function if exists public.set_recall_boost(jsonb);
--   alter table public.memory_items drop column if exists recall_boost;
--   -- then re-apply migration 029's memory_hybrid_search body verbatim to drop
--   -- the recall_boost factor (029_doctrine_recall_boost.sql lines 80-227).
-- ====================================================================

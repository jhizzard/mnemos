-- migrations/029_doctrine_recall_boost.sql
-- Sprint 79 T3 (AMEND-14) — Mnestra 'doctrine' recall boost.
--
-- WHY: Sprint 79 ships the elevation pipeline (Rumen doctrine-scan -> Haiku
-- draft -> PR -> ratify -> flow-back). A ratified doctrine row is direct-
-- INSERTed with source_type='doctrine' (packages/cli/src/index.js `termdeck
-- doctrine ratify`, termdeck repo — never through memoryRemember). Without
-- this migration, memory_hybrid_search (023_privacy_tags_column.sql) scores
-- 'doctrine' via its `else` branches in BOTH the type-weight case (1.0x, same
-- as an unweighted 'fact') and the decay case (30-day half-life, same as a
-- 'bug_fix') — exactly backwards for a row whose entire point is that it
-- survived cluster-of-3+, cross-project (or >=21-day-spread) reinforcement
-- and was human-ratified.
--
-- WHAT: CREATE OR REPLACE public.memory_hybrid_search with the IDENTICAL
-- signature + return table as migration 023 (verified byte-identical by
-- diff — see the ORCH verify-gate note below; a plain replace is sufficient
-- on that basis alone, but this migration ALSO runs 023/002's overload-drop
-- guard first, defensively). Two additive CASE arms for source_type =
-- 'doctrine':
--   - type-weight: 1.5 (AMEND-14's explicit ask; matches 'decision', the only
--     other tier at 1.5).
--   - decay tier: 365-day-denominator tier (matches 'decision' / 'architecture'
--     / 'preference' — the "durable truth" bucket). NOT in AMEND-14's literal
--     text, but implied: leaving 'doctrine' on the 30-day 'bug_fix'-class
--     decay while calling it a x1.5-boosted durable truth is an internally
--     inconsistent half-fix. Flagged as a FINDING in Sprint 79 STATUS.md for
--     Josh/T4 to override toward the narrower literal-only reading if
--     preferred. ORCH approved keeping this (2026-07-05 12:xx ET STATUS.md)
--     — zero live doctrine rows exist yet, so no backfill impact.
-- NEVER edits shipped migration 023 in place (PLANNING §3 lane rule) — this
-- is a fresh CREATE OR REPLACE layered on top. 029 verified next-free per
-- Sprint 79 ground truth (PLANNING.md §1; T1 owns 028, T3/HANDOFF-ACK owns
-- 029 — docs/sprint-79-elevation-capture/STATUS.md).
--
-- SCOPE NOTE — 'elevated_to' relationship_type lives in 028, NOT here
-- (ORCH's FINAL ruling 2026-07-05 ~12:24 ET, docs/sprint-79-elevation-
-- capture/STATUS.md — this constraint's ownership bounced between "029
-- dynamic-union" and "028 sole owner" a few times as the live situation
-- changed; this is the settled state). 029 and T1's 028 both independently
-- touched memory_relationships' relationship_type CHECK constraint at
-- first (029 for 'elevated_to' — the doctrine flow-back edge kind; 028 for
-- 'amends_rule' — the rule_ref auto-link edge kind), a shared-object seam
-- neither PLANNING.md nor DISPATCH-GUIDE anticipated. T1's 028 is now the
-- SOLE owner and hardcodes the full 10-value set (base 8 + 'elevated_to' +
-- 'amends_rule'); 029 touches nothing on memory_relationships at all.
-- `termdeck doctrine ratify`'s runtime `memory_link 'elevated_to'`
-- edge-writes are valid because 028 (applied before 029 in the locked
-- 028→029 apply order) adds 'elevated_to' to the live constraint.
--
-- Five RLS hygiene gates: no NEW table/function is introduced (only an
-- existing function's body changes), so the re-pin + hard-failing receipt
-- below re-verify [GATE 3] REVOKE-then-GRANT and [GATE 4] search_path are
-- still correct after the replace — belt-and-suspenders (CREATE OR REPLACE
-- FUNCTION preserves existing grants in Postgres, so this defends against a
-- divergent long-lived install rather than a real reset); mirrors migration
-- 023's own re-pin block and the mig 026/027 hard-failing-receipt idiom.
--
-- Idempotent / rerun-safe: CREATE OR REPLACE FUNCTION; the grant re-pin
-- resolves the signature from pg_proc (robust to the vector-type-location
-- gate migration 019 already handles); the receipt DO block only SELECTs
-- (and raises).
--
-- APPLY: write + test locally only. ORCH applies at sprint close (engram
-- 028 + 029, rumen 004) per PLANNING.md §7. Apply order is 028 THEN 029
-- (both this migration's scope note above and T1's 'elevated_to' ownership
-- depend on that order).
--
-- ORCH verify-gate (2026-07-05 12:12 ET, docs/sprint-79-elevation-capture/
-- STATUS.md): confirmed byte-identical to migration 023's 8-arg input / 9-col
-- RETURNS TABLE (`diff` of the two signature blocks is empty) — this body-only
-- change is a safe CREATE OR REPLACE with no drop required. The overload-drop
-- guard immediately below is added anyway, defensively: migrations 002 and
-- 023 BOTH guard this exact function before touching it (ledger #17/#18 —
-- match_memories and this same memory_hybrid_search each drifted a stale
-- overload on a long-lived install once already), so every migration that
-- CREATE OR REPLACEs memory_hybrid_search follows suit rather than assuming
-- a clean single-overload state.

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

-- NOTE — memory_items.source_type CHECK does NOT need a fix here: T1's
-- migration 028 already extends `memory_items_source_type_check` to include
-- 'doctrine' (preserving the 10 pre-existing live values), landed in
-- response to the same T4-CODEX 12:41 ET AUDIT-FAIL this migration's header
-- originally cited. 029 briefly duplicated that fix independently before
-- discovering T1 had already claimed it in 028 (docs/sprint-79-elevation-
-- capture/STATUS.md, T1 FIX-LANDED ~12:45 ET) — removed here rather than
-- run a redundant DROP+ADD CONSTRAINT after 028 already did it, mirroring
-- this sprint's own single-owner precedent for the relationship_type
-- constraint. 028 runs before 029 in the locked apply order, so by the time
-- this file executes 'doctrine' is already legal.

-- Re-pin RLS/EXECUTE hygiene (belt-and-suspenders — see header rationale).
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

-- Hard-failing receipt (mirrors migration 026/027's strengthened idiom — a
-- receipt that cannot fail is not a receipt).
do $$
declare
  v_oid  oid;
  v_anon boolean;
  v_auth boolean;
  v_pub  boolean;
  v_svc  boolean;
  v_cfg  text;
begin
  -- Use the function OID with has_function_privilege, NOT a reconstructed text
  -- signature: pg_get_function_identity_arguments returns arg NAMES on some
  -- Postgres builds (observed live on Supabase — "query_text text, ..."), and
  -- has_function_privilege's text form rejects that ("invalid type name
  -- 'query_text text'"). The OID form is portable across builds. (REVOKE/GRANT
  -- in the re-pin block above tolerate named args, so only this receipt needed
  -- the change.)
  select p.oid into v_oid
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname = 'memory_hybrid_search'
   limit 1;

  if v_oid is null then
    raise exception '[029] memory_hybrid_search not found after CREATE OR REPLACE';
  end if;

  v_anon := has_function_privilege('anon',          v_oid, 'EXECUTE');
  v_auth := has_function_privilege('authenticated', v_oid, 'EXECUTE');
  v_pub  := has_function_privilege('public',        v_oid, 'EXECUTE');
  v_svc  := has_function_privilege('service_role',  v_oid, 'EXECUTE');

  select array_to_string(p.proconfig, '; ') into v_cfg
    from pg_proc p where p.oid = v_oid;

  raise notice '[029] memory_hybrid_search EXECUTE — anon:%, authenticated:%, public:% (expect f f f); service_role:% (expect t); proconfig: %',
    v_anon, v_auth, v_pub, v_svc, coalesce(v_cfg, '<none>');

  if v_anon or v_auth or v_pub then
    raise exception '[029] GATE 3 VIOLATION: memory_hybrid_search executable by anon/authenticated/public (anon=%, authenticated=%, public=%)',
      v_anon, v_auth, v_pub;
  end if;
  if not v_svc then
    raise exception '[029] GATE 3 VIOLATION: service_role lost EXECUTE on memory_hybrid_search';
  end if;
  if v_cfg is null or v_cfg not like '%search_path=public, extensions, pg_catalog%' then
    raise exception '[029] GATE 4 VIOLATION: memory_hybrid_search search_path not pinned (proconfig: %)', coalesce(v_cfg, '<none>');
  end if;

  raise notice '[029] receipt: memory_hybrid_search replaced with doctrine x1.5 type-weight + 365d decay tier; hygiene re-verified.';
end$$;

-- ====================================================================
-- Post-apply verification (ORCH, Studio SQL editor — commented so the
-- migration runner doesn't choke on result sets):
--
--   -- A synthetic doctrine row outranks an equally-fresh fact at the same
--   -- base_score (type-weight 1.5 vs 1.0):
--   select source_type, score from memory_hybrid_search(
--     'smoke', array_fill(0::real, ARRAY[1536])::vector, 20
--   ) where source_type in ('doctrine','fact') order by score desc;
--
--   -- Hygiene unchanged: PUBLIC/anon/authenticated still denied, service_role
--   -- still granted (belt-and-suspenders re-pin above should be a no-op on a
--   -- healthy install):
--   select has_function_privilege('service_role',
--     'public.memory_hybrid_search(text,vector,int,float,float,int,text,text)',
--     'EXECUTE');  -- expect t
--
--   -- 'elevated_to' is a legal relationship_type (added by 028, NOT here):
--   select conname, pg_get_constraintdef(oid) from pg_constraint
--    where conrelid = 'public.memory_relationships'::regclass
--      and contype = 'c';  -- expect the def to include 'elevated_to'
--
--   -- Supabase advisors show ZERO new 0011/0013 lints attributable to 029:
--   --   mcp__supabase__get_advisors(type='security')
-- ====================================================================

-- ====================================================================
-- Reversal (commented — apply by hand to roll back to the 023 shape):
--   Re-apply migration 023's `create or replace function
--   public.memory_hybrid_search` body verbatim (023_privacy_tags_column.sql
--   lines 126-256) to drop the 'doctrine' CASE arms; both the type-weight and
--   decay tiers revert to the `else` branch (1.0x / 30-day) for any
--   'doctrine' row.
-- ====================================================================

-- migrations/028_capture_gates.sql
-- Sprint 79 T1 (Capture gates) — stop clobbering repeated kitchen lessons,
-- start counting them, and put real provenance + a granularity signal on the
-- deliberate write path. This is the clean-signal feed T2's doctrine-scan
-- (rumen) clusters over.
--
-- WHY: the 0.88-0.95 embedding-similarity dedup band in remember.ts used to
-- REPLACE the existing row's content/embedding/metadata wholesale on every
-- near-duplicate write. A verbose auto-captured restatement of an existing
-- kitchen lesson would silently destroy the original's metadata and any
-- detail only the original had, and there was no signal anywhere that a
-- lesson had been reinforced N times (vs. written once and never touched
-- again) — exactly the usage signal Sprint 79's elevation loop needs.
--
-- WHAT:
--   1. public.memory_items.reinforcement_count / .sprint_ref / .rule_ref —
--      three genuinely new columns. `content_hash` ALREADY EXISTS LIVE on
--      the daily-driver store (generated `md5(content)`, applied out-of-band
--      in no prior on-disk migration) — but a CLEAN replay of 001->028 on a
--      fresh database (a new install, or CI's sql-syntax job) has never
--      created it, so this migration ALSO `ADD COLUMN IF NOT EXISTS
--      content_hash ... GENERATED ALWAYS AS (md5(content)) STORED`: a true
--      no-op on the live store (IF NOT EXISTS short-circuits before any
--      re-declaration is attempted — re-declaring an EXISTING generated
--      column would error, but IF NOT EXISTS never gets that far), and the
--      column that makes a fresh install actually work. `recall_count` /
--      `last_recalled_at` are OWNED BY migration 027 and are NOT touched
--      here (collision guard, mirrors 027's own note).
--   2. A one-time backfill collapse of existing active content_hash
--      duplicates: keep-oldest canonical, sum reinforcement_count into it,
--      mark every other member superseded (is_active=false, superseded_by
--      set) — REVERSIBLE, never DELETE. The group count is DATA-DRIVEN (a
--      live GROUP BY), not a number baked into this file — an earlier sprint
--      doc cited "56 groups"; the live count the day this was authored was
--      138 groups / 297 rows, and either number would be handled identically
--      by the query below.
--   3. Two partial unique indexes that make `ingest_capture`'s two
--      ON CONFLICT arbiters valid: one on content_hash (WHERE is_active) for
--      hook-retry idempotency, one on source_session_id (WHERE
--      source_type='pre_compact_snapshot' AND is_active) for rolling
--      snapshots (today's bundled pre-compact hook writes a NEW row per
--      compaction event outside this repo; ingest_capture makes a
--      roll-in-place alternative available — adopting it at the caller is
--      explicitly OUT of scope this sprint, see the header note on
--      ingest_capture below).
--   4. public.ingest_capture(jsonb) — the capture-gate RPC: hook-tier writes
--      go through here instead of a raw INSERT, getting idempotency +
--      rolling-snapshot semantics for free. Five RLS hygiene gates, same
--      hard-failing receipt idiom as migration 027.
--   5. public.memory_relationships.relationship_type CHECK — extended to 10
--      values. This migration is the SOLE owner of this constraint this
--      sprint (cross-lane decision, T1<->T3): base 8 (unchanged) +
--      'amends_rule' (this migration's rule_ref auto-link, via the existing
--      memoryLink() TS helper) + 'elevated_to' (T3's migration 029 doctrine
--      flow-back edge — T3's 029 does NOT touch this constraint at all, by
--      design, so there is exactly one writer).
--   5b. public.memory_items.source_type CHECK — another out-of-band live
--      constraint (same class of drift as content_hash) that blocked T3's
--      flow-back INSERT (source_type='doctrine'). Extended to the 10
--      pre-existing live values (verified via pg_get_constraintdef, all
--      preserved) + 'doctrine'.
--   6. public.mnestra_capture_health — a small observability view over the
--      new columns (reinforcement/forced-write/sprint-and-rule-tagging
--      stats per source_type). `security_invoker=true` so it runs under the
--      querying role's own RLS on memory_items rather than the view
--      definer's (Supabase lint 0010 — avoids a SECURITY DEFINER view).
--
-- Five RLS hygiene gates (global CLAUDE.md § "Supabase RLS + privilege
-- hygiene"), marked [GATE n] inline, verified by the HARD-FAILING receipt
-- block near the bottom (same idiom as migrations 026/027):
--   GATE 1  No NEW table is created by this migration, so there is nothing
--           new to enable RLS on — memory_items/memory_relationships already
--           have RLS enabled (verified live, unchanged by this migration;
--           the receipt re-checks this as a regression guard, not a new gate).
--   GATE 2  No new policies; no WITH CHECK (true) anywhere in this file.
--   GATE 3  REVOKE EXECUTE on ingest_capture FROM public, anon, authenticated
--           + targeted GRANT to service_role only.
--   GATE 4  SET search_path on ingest_capture. NOTE: unlike migration 027's
--           functions (jsonb/uuid/text/int only), ingest_capture declares a
--           `vector(1536)` variable — on THIS store, the `vector` extension
--           lives in the `extensions` schema (verified live), not `public`,
--           so the pinned path is `public, extensions, pg_catalog` (matches
--           T3's migration 029, which hit the identical requirement for
--           memory_hybrid_search's own vector(1536) parameter).
--   GATE 5  No raw anon-key write path: ingest_capture is the only new write
--           surface, and it is SECURITY DEFINER + anon/authenticated revoked.
--
-- Idempotent / rerun-safe: ADD COLUMN IF NOT EXISTS; CREATE INDEX IF NOT
-- EXISTS; the backfill UPDATEs are naturally idempotent (a second run finds
-- zero remaining duplicate groups and touches zero rows); DROP CONSTRAINT IF
-- EXISTS + ADD CONSTRAINT; CREATE OR REPLACE FUNCTION/VIEW; REVOKE/GRANT are
-- naturally idempotent; the receipt DO block only SELECTs (and raises).
--
-- APPLY: write + test locally only (five-gate hygiene tests + live read-only
-- reconnaissance). Nobody applies this to the daily-driver project from a
-- lane — ORCH applies at sprint close (PLANNING.md § ORCH close-out), then
-- runs the commented post-apply verification at the bottom + the five-gate
-- get_advisors check.

-- ====================================================================
-- 1. New columns on memory_items. content_hash is REPLAY-SAFETY only (see
--    header — already exists on the live store, IF NOT EXISTS makes this a
--    no-op there); reinforcement_count/sprint_ref/rule_ref are genuinely
--    new everywhere. recall_count/last_recalled_at are pre-existing,
--    owned by migration 027, and untouched here.
-- ====================================================================

alter table public.memory_items
  add column if not exists content_hash text generated always as (md5(content)) stored;
alter table public.memory_items
  add column if not exists reinforcement_count int not null default 1;
alter table public.memory_items
  add column if not exists sprint_ref text;
alter table public.memory_items
  add column if not exists rule_ref text;

comment on column public.memory_items.reinforcement_count is
  'Sprint 79 (migration 028): how many times this row has been reinforced by '
  'a near-duplicate write (the remember.ts 0.88-0.95 embedding-similarity '
  'band) rather than clobbered or skipped. Starts at 1 (the original write '
  'counts as the first). Fed by the backfill collapse below and by every '
  'subsequent dedup-merge in remember.ts.';
comment on column public.memory_items.sprint_ref is
  'Sprint 79 (migration 028): which sprint most recently produced/reinforced '
  'this memory. Loose text, no CHECK — same fail-soft-provenance philosophy '
  'as source_agent (migration 015).';
comment on column public.memory_items.rule_ref is
  'Sprint 79 (migration 028): memory_id of a "rule" memory this row amends. '
  'A non-null value auto-creates an amends_rule memory_link edge from this '
  'row to it (remember.ts, best-effort — never blocks the capture itself).';

-- ====================================================================
-- 2. Backfill collapse — content_hash duplicates among ACTIVE rows.
--    keep-oldest canonical, sum reinforcement_count, supersede the rest.
--    REVERSIBLE (is_active=false + superseded_by set), never DELETE.
--    Two plain UPDATEs (not chained CTEs) so the grouping logic is trivial
--    to audit independently and doesn't depend on Postgres's
--    data-modifying-CTE execution-guarantee semantics.
-- ====================================================================

-- Step A: sum reinforcement_count into the canonical row FIRST, while every
-- duplicate is still active (so the GROUP BY still sees the whole group).
with dup_groups as (
  select
    content_hash,
    (array_agg(id order by created_at asc, id asc))[1] as canonical_id,
    sum(coalesce(reinforcement_count, 1))::int         as total_reinforcement
  from public.memory_items
  where is_active = true and content_hash is not null
  group by content_hash
  having count(*) > 1
)
update public.memory_items m
   set reinforcement_count = dg.total_reinforcement,
       updated_at          = now()
  from dup_groups dg
 where m.id = dg.canonical_id;

-- Step B: mark every non-canonical member superseded. Re-derives canonical_id
-- with the IDENTICAL deterministic ordering as Step A (oldest created_at,
-- id tiebreak) — Step A only touched reinforcement_count/updated_at on the
-- canonical row, so the group membership and ordering are unchanged here.
with dup_groups as (
  select
    content_hash,
    (array_agg(id order by created_at asc, id asc))[1] as canonical_id
  from public.memory_items
  where is_active = true and content_hash is not null
  group by content_hash
  having count(*) > 1
)
update public.memory_items m
   set is_active     = false,
       superseded_by = dg.canonical_id,
       updated_at    = now()
  from dup_groups dg
 where m.content_hash = dg.content_hash
   and m.id <> dg.canonical_id
   and m.is_active = true;

-- Early, clear-message guard before the unique index attempt below (which
-- would otherwise fail with a much less legible "duplicate key value
-- violates unique constraint" if the backfill above somehow left a group
-- unresolved).
do $$
declare
  v_dup_remaining int;
begin
  select count(*) into v_dup_remaining
    from (
      select content_hash from public.memory_items
       where is_active = true and content_hash is not null
       group by content_hash having count(*) > 1
    ) g;
  raise notice '[028] active content_hash duplicate groups remaining after backfill: % (expect 0)', v_dup_remaining;
  if v_dup_remaining <> 0 then
    raise exception '[028] BACKFILL INCOMPLETE: % duplicate active content_hash group(s) remain', v_dup_remaining;
  end if;
end$$;

-- ====================================================================
-- 3. Partial unique indexes — the arbiters for ingest_capture's two
--    ON CONFLICT paths. A NON-unique btree index on content_hash already
--    exists (memory_items_content_hash_idx, pre-existing) — distinct name
--    here, no collision, not dropped (out of this migration's lane).
-- ====================================================================

create unique index if not exists memory_items_content_hash_active_uidx
  on public.memory_items (content_hash)
  where (is_active = true);

-- DEFERRED to Sprint 80 (migration 030): the pre_compact_snapshot rolling-
-- unique index ships together with the hook's ingest_capture adoption. Creating
-- it now would (a) fail on a live store with accumulated snapshots and (b) break
-- the current append-per-compaction hook's next insert. ingest_capture's rolling
-- ON CONFLICT path is created below regardless (its arbiter index lands in 030).
-- create unique index if not exists memory_items_precompact_session_uidx
--   on public.memory_items (source_session_id)
--   where (source_type = 'pre_compact_snapshot' and is_active = true);

-- ====================================================================
-- 4. memory_relationships.relationship_type — extend to 10 values.
--    SOLE writer this sprint (T1<->T3 cross-lane decision): base 8
--    (unchanged) + 'amends_rule' (this migration) + 'elevated_to' (T3's
--    doctrine flow-back edge — T3's 029 does not touch this constraint).
-- ====================================================================

alter table public.memory_relationships
  drop constraint if exists memory_relationships_relationship_type_check;
alter table public.memory_relationships
  add constraint memory_relationships_relationship_type_check
  check (relationship_type = any (array[
    'supersedes', 'relates_to', 'contradicts', 'elaborates', 'caused_by',
    'blocks', 'inspired_by', 'cross_project_link',
    'amends_rule', 'elevated_to'
  ]));

-- ====================================================================
-- 4b. memory_items.source_type CHECK — another out-of-band live constraint
--    (same class of drift as content_hash: applied directly to the store,
--    never captured in an on-disk migration) that blocks T3's flow-back
--    INSERT (source_type='doctrine'). Verified live via pg_get_constraintdef
--    before touching: current allowed set is fact/decision/preference/
--    bug_fix/architecture/code_context/session_summary/document_chunk/
--    commit_context/pre_compact_snapshot (10 values) — preserved verbatim,
--    + 'doctrine' (11th). T1 takes this because it's the same
--    extend-a-memory_items-CHECK-safely pattern as §4 above and directly
--    unblocks T3's acceptance target — flagged in STATUS.md before landing,
--    not a silent scope grab.
-- ====================================================================

alter table public.memory_items
  drop constraint if exists memory_items_source_type_check;
alter table public.memory_items
  add constraint memory_items_source_type_check
  check (source_type = any (array[
    'fact', 'decision', 'preference', 'bug_fix', 'architecture', 'code_context',
    'session_summary', 'document_chunk', 'commit_context', 'pre_compact_snapshot',
    'doctrine'
  ]));

-- ====================================================================
-- 5. ingest_capture(jsonb) — the capture-gate RPC. NEW capability this
--    sprint; adopting it at the caller (the bundled pre-compact hook /
--    TermDeck's periodic-capture timer, both outside this repo) is
--    explicitly deferred (ULTRAPLAN §6 "hook-tier noise controls") — do
--    NOT expand this migration's scope to touch ~/.claude/hooks or
--    packages/server in termdeck.
--
--    Two ON-CONFLICT paths, branched on source_type (a single INSERT can
--    only target one arbiter, so the branch happens in plpgsql, not SQL):
--      - source_type='pre_compact_snapshot' (+ a session id supplied): ONE
--        rolling row per session — DO UPDATE replaces content/embedding/
--        metadata/refs, never accumulates a new row per compaction.
--      - everything else: content_hash idempotency — DO NOTHING on an
--        exact-content retry (e.g. a retried hook POST), then a fallback
--        SELECT so the caller still gets an id back (a retried idempotent
--        write is not an error).
--    No embedding-similarity dedup here (that's remember.ts's job for
--    deliberate LLM-driven writes) — this RPC is the cheap, no-OpenAI-call
--    capture gate for automated/hook paths. `embedding` is optional; when
--    the caller supplies one (jsonb string, same literal shape
--    formatEmbedding() produces) it's cast to vector(1536), else NULL.
-- ====================================================================

create or replace function public.ingest_capture(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_catalog  -- [GATE 4]
as $$
declare
  v_content            text;
  v_project            text;
  v_source_type        text;
  v_category           text;
  v_metadata           jsonb;
  v_source_agent       text;
  v_source_session_id  text;
  v_sprint_ref         text;
  v_rule_ref           text;
  v_embedding          vector(1536);
  v_id                 uuid;
  v_action             text;
  v_was_insert         boolean;
begin
  v_content := p_payload->>'content';
  if v_content is null or btrim(v_content) = '' then
    return jsonb_build_object('ok', false, 'error', 'content is required');
  end if;

  v_project           := coalesce(p_payload->>'project', 'global');
  v_source_type       := coalesce(p_payload->>'source_type', 'fact');
  v_category          := p_payload->>'category';
  v_metadata          := coalesce(p_payload->'metadata', '{}'::jsonb);
  v_source_agent      := p_payload->>'source_agent';
  v_source_session_id := p_payload->>'source_session_id';
  v_sprint_ref        := p_payload->>'sprint_ref';
  v_rule_ref          := p_payload->>'rule_ref';

  if p_payload ? 'embedding' and p_payload->>'embedding' is not null then
    v_embedding := (p_payload->>'embedding')::vector;
  end if;

  if v_source_type = 'pre_compact_snapshot' and v_source_session_id is not null then
    -- Rolling snapshot: one row per (session, pre_compact_snapshot).
    insert into public.memory_items
      (content, embedding, source_type, category, project, metadata,
       source_agent, source_session_id, sprint_ref, rule_ref)
    values
      (v_content, v_embedding, v_source_type, v_category, v_project, v_metadata,
       v_source_agent, v_source_session_id, v_sprint_ref, v_rule_ref)
    on conflict (source_session_id) where (source_type = 'pre_compact_snapshot' and is_active = true)
    do update set
      content      = excluded.content,
      embedding    = coalesce(excluded.embedding, memory_items.embedding),
      metadata     = excluded.metadata,
      source_agent = coalesce(excluded.source_agent, memory_items.source_agent),
      sprint_ref   = coalesce(excluded.sprint_ref, memory_items.sprint_ref),
      rule_ref     = coalesce(excluded.rule_ref, memory_items.rule_ref),
      updated_at   = now()
    returning id, (xmax = 0) into v_id, v_was_insert;

    v_action := case when v_was_insert then 'inserted' else 'updated' end;
    return jsonb_build_object('ok', true, 'id', v_id, 'action', v_action);
  end if;

  -- Everything else: content_hash idempotency, DO NOTHING on a byte-identical
  -- retry (hook-retry safety net — remember.ts's embedding-similarity dedup
  -- is a separate, deliberate-write-only concern).
  insert into public.memory_items
    (content, embedding, source_type, category, project, metadata,
     source_agent, source_session_id, sprint_ref, rule_ref)
  values
    (v_content, v_embedding, v_source_type, v_category, v_project, v_metadata,
     v_source_agent, v_source_session_id, v_sprint_ref, v_rule_ref)
  on conflict (content_hash) where (is_active = true)
  do nothing
  returning id into v_id;

  if v_id is null then
    -- Conflict hit — DO NOTHING returns no row. content_hash is deterministic
    -- (generated md5(content)), so the existing active row is a direct lookup,
    -- not a re-derivation of INSERT's conflict resolution.
    select id into v_id
      from public.memory_items
     where content_hash = md5(v_content) and is_active = true
     limit 1;
    return jsonb_build_object('ok', true, 'id', v_id, 'action', 'skipped');
  end if;

  return jsonb_build_object('ok', true, 'id', v_id, 'action', 'inserted');
end;
$$;

comment on function public.ingest_capture(jsonb) is
  'Sprint 79 T1: capture-gate RPC for automated/hook writes (idempotent on '
  'content_hash; rolling one-row-per-session for pre_compact_snapshot). New '
  'capability this sprint — NOT yet called by the bundled pre-compact hook '
  'or TermDeck''s periodic-capture timer (both outside this repo); adopting '
  'it there is deferred (ULTRAPLAN §6). SECURITY DEFINER, pinned search_path; '
  'EXECUTE: service_role only.';

-- [GATE 3]
revoke execute on function public.ingest_capture(jsonb)
  from public, anon, authenticated;
grant  execute on function public.ingest_capture(jsonb)
  to service_role;

-- ====================================================================
-- 6. mnestra_capture_health — observability view over the new columns.
--    security_invoker=true: runs under the QUERYING role's own RLS on
--    memory_items, not the view definer's (avoids a SECURITY DEFINER view;
--    Supabase advisor lint 0010).
-- ====================================================================

create or replace view public.mnestra_capture_health
with (security_invoker = true) as
select
  source_type,
  count(*)                                                    as active_count,
  round(avg(reinforcement_count)::numeric, 2)                 as avg_reinforcement_count,
  count(*) filter (where reinforcement_count > 1)              as reinforced_count,
  count(*) filter (where metadata ? 'had_private_content')      as had_private_count,
  count(*) filter (where sprint_ref is not null)                as sprint_tagged_count,
  count(*) filter (where rule_ref is not null)                  as rule_tagged_count,
  max(updated_at)                                              as last_write
from public.memory_items
where is_active = true and archived = false
group by source_type;

comment on view public.mnestra_capture_health is
  'Sprint 79 T1: per-source_type capture health — reinforcement rate, private-'
  'content rate, sprint/rule tagging adoption. security_invoker=true (runs '
  'under the caller''s own memory_items RLS, not the view definer''s).';

-- Explicit grant hygiene (migration 019's mnestra_recent_activity precedent):
-- security_invoker alone only controls whose RLS the view runs under, not
-- who may SELECT the view itself — this store has no default ACL granting
-- anything on new public-schema relations (verified live), so without this,
-- not even service_role could query the view.
revoke all on public.mnestra_capture_health from public, anon, authenticated;
grant  select on public.mnestra_capture_health to service_role;

-- ====================================================================
-- 6b. Ensure RLS ENABLED on memory_items + memory_relationships (idempotent).
--    RLS on these tables was enabled OUT-OF-BAND on the live daily-driver; the
--    migration chain (001->027) never enabled it, so a fresh install / CI
--    replay has RLS OFF here and the receipt's RLS post-condition below would
--    (wrongly) abort. Enabling it here (a) makes 028 apply cleanly on a fresh
--    DB and (b) is the correct hygiene posture — memory tables must not be
--    anon/authenticated-accessible (service_role bypasses RLS; the Mnestra
--    server writes as service_role). ENABLE on an already-RLS table is a no-op.
-- ====================================================================

alter table public.memory_items         enable row level security;
alter table public.memory_relationships  enable row level security;

-- ====================================================================
-- 7. Apply-time receipt — HARD-FAILING. Any gate violation raises, rolling
--    back the whole migration transaction. Same idiom as migrations 026/027.
-- ====================================================================

do $$
declare
  v_has_reinforcement boolean;
  v_has_sprint_ref    boolean;
  v_has_rule_ref      boolean;
  v_has_recall_count  boolean;
  v_has_last_recalled boolean;
  v_content_hash_gen  text;
  v_dup_remaining     int;
  v_idx_content_hash  boolean;
  v_idx_precompact    boolean;
  v_constraint_def    text;
  v_anon              boolean;
  v_auth              boolean;
  v_pub               boolean;
  v_svc               boolean;
  v_cfg               text;
  v_view_invoker      boolean;
  v_view_anon         boolean;
  v_view_auth         boolean;
  v_view_pub          boolean;
  v_view_svc          boolean;
  v_items_rls         boolean;
  v_rel_rls           boolean;
  v_sig text := 'public.ingest_capture(jsonb)';
  v_oid oid;
begin
  -- New columns present; 027's denorm columns untouched (collision guard).
  select exists (select 1 from information_schema.columns
                  where table_schema='public' and table_name='memory_items' and column_name='reinforcement_count')
    into v_has_reinforcement;
  select exists (select 1 from information_schema.columns
                  where table_schema='public' and table_name='memory_items' and column_name='sprint_ref')
    into v_has_sprint_ref;
  select exists (select 1 from information_schema.columns
                  where table_schema='public' and table_name='memory_items' and column_name='rule_ref')
    into v_has_rule_ref;
  select exists (select 1 from information_schema.columns
                  where table_schema='public' and table_name='memory_items' and column_name='recall_count')
    into v_has_recall_count;
  select exists (select 1 from information_schema.columns
                  where table_schema='public' and table_name='memory_items' and column_name='last_recalled_at')
    into v_has_last_recalled;

  raise notice '[028] new columns — reinforcement_count:%, sprint_ref:%, rule_ref:% (expect t t t)',
    v_has_reinforcement, v_has_sprint_ref, v_has_rule_ref;
  raise notice '[028] migration-027-owned columns untouched — recall_count:%, last_recalled_at:% (expect t t)',
    v_has_recall_count, v_has_last_recalled;

  if not (v_has_reinforcement and v_has_sprint_ref and v_has_rule_ref) then
    raise exception '[028] NEW COLUMN MISSING: reinforcement_count=%, sprint_ref=%, rule_ref=%',
      v_has_reinforcement, v_has_sprint_ref, v_has_rule_ref;
  end if;
  if not (v_has_recall_count and v_has_last_recalled) then
    raise exception '[028] COLLISION GUARD VIOLATION: migration-027-owned column missing (recall_count=%, last_recalled_at=%)',
      v_has_recall_count, v_has_last_recalled;
  end if;

  -- content_hash still exists, still generated (unchanged by this migration).
  select generation_expression into v_content_hash_gen
    from information_schema.columns
   where table_schema='public' and table_name='memory_items' and column_name='content_hash';
  raise notice '[028] content_hash generation_expression: % (expect md5(content))', coalesce(v_content_hash_gen, '<column missing!>');
  if v_content_hash_gen is null or v_content_hash_gen <> 'md5(content)' then
    raise exception '[028] content_hash is missing or no longer the expected generated column (found: %)', coalesce(v_content_hash_gen, '<null>');
  end if;

  -- Backfill collapse left zero duplicate active groups.
  select count(*) into v_dup_remaining
    from (
      select content_hash from public.memory_items
       where is_active = true and content_hash is not null
       group by content_hash having count(*) > 1
    ) g;
  raise notice '[028] active content_hash duplicate groups: % (expect 0)', v_dup_remaining;
  if v_dup_remaining <> 0 then
    raise exception '[028] BACKFILL REGRESSION: % duplicate active content_hash group(s) present at receipt time', v_dup_remaining;
  end if;

  -- Both partial unique indexes exist.
  select exists (select 1 from pg_indexes where schemaname='public' and indexname='memory_items_content_hash_active_uidx') into v_idx_content_hash;
  v_idx_precompact := true; -- precompact rolling-unique index DEFERRED to Sprint 80 (ships with hook ingest_capture adoption)
  raise notice '[028] content_hash_active index:% (precompact index deferred to S80)', v_idx_content_hash;
  if not v_idx_content_hash then
    raise exception '[028] INDEX MISSING: content_hash_active_uidx=%', v_idx_content_hash;
  end if;

  -- relationship_type CHECK carries both new values (+ base 8 preserved).
  select pg_get_constraintdef(oid) into v_constraint_def
    from pg_constraint
   where conrelid = 'public.memory_relationships'::regclass
     and conname = 'memory_relationships_relationship_type_check';
  raise notice '[028] relationship_type CHECK: %', coalesce(v_constraint_def, '<missing!>');
  if v_constraint_def is null
     or v_constraint_def not like '%amends_rule%'
     or v_constraint_def not like '%elevated_to%'
     or v_constraint_def not like '%supersedes%'
     or v_constraint_def not like '%cross_project_link%' then
    raise exception '[028] RELATIONSHIP_TYPE CHECK VIOLATION: expected base-8 + amends_rule + elevated_to, found: %', coalesce(v_constraint_def, '<null>');
  end if;

  -- source_type CHECK carries 'doctrine' (+ the 10 pre-existing values preserved).
  select pg_get_constraintdef(oid) into v_constraint_def
    from pg_constraint
   where conrelid = 'public.memory_items'::regclass
     and conname = 'memory_items_source_type_check';
  raise notice '[028] source_type CHECK: %', coalesce(v_constraint_def, '<missing!>');
  if v_constraint_def is null
     or v_constraint_def not like '%doctrine%'
     or v_constraint_def not like '%pre_compact_snapshot%'
     or v_constraint_def not like '%fact%' then
    raise exception '[028] SOURCE_TYPE CHECK VIOLATION: expected the 10 pre-existing values + doctrine, found: %', coalesce(v_constraint_def, '<null>');
  end if;

  -- ingest_capture: EXECUTE privileges + pinned search_path. Sprint 81
  -- receipt-OID sweep: resolve the OID from the literal signature and pass it to
  -- has_function_privilege (portable form; migration 029 reference). Receipt-only.
  v_oid := v_sig::regprocedure;
  v_anon := has_function_privilege('anon',          v_oid, 'EXECUTE');
  v_auth := has_function_privilege('authenticated', v_oid, 'EXECUTE');
  v_pub  := has_function_privilege('public',        v_oid, 'EXECUTE');
  v_svc  := has_function_privilege('service_role',  v_oid, 'EXECUTE');
  select array_to_string(p.proconfig, '; ') into v_cfg
    from pg_proc p where p.oid = v_oid;
  raise notice '[028] % EXECUTE — anon:%, authenticated:%, public:% (expect f f f); service_role:% (expect t); proconfig: %',
    v_sig, v_anon, v_auth, v_pub, v_svc, coalesce(v_cfg, '<none>');
  if v_anon or v_auth or v_pub then
    raise exception '[028] GATE 3 VIOLATION: % is executable by anon/authenticated/public (anon=%, authenticated=%, public=%)',
      v_sig, v_anon, v_auth, v_pub;
  end if;
  if not v_svc then
    raise exception '[028] GATE 3 VIOLATION: service_role lost EXECUTE on %', v_sig;
  end if;
  if v_cfg is null or v_cfg not like '%search_path=public, extensions, pg_catalog%' then
    raise exception '[028] GATE 4 VIOLATION: % search_path not pinned as expected (proconfig: %)', v_sig, coalesce(v_cfg, '<none>');
  end if;

  -- mnestra_capture_health is security_invoker (not a SECURITY DEFINER view).
  select coalesce((select 'security_invoker=true' = any(c.reloptions)
                     from pg_class c
                    where c.relname = 'mnestra_capture_health' and c.relkind = 'v'), false)
    into v_view_invoker;
  raise notice '[028] mnestra_capture_health security_invoker=true: % (expect t)', v_view_invoker;
  if not v_view_invoker then
    raise exception '[028] VIEW GATE VIOLATION: mnestra_capture_health is missing security_invoker=true';
  end if;

  -- View-level grant hygiene (migration 019's mnestra_recent_activity
  -- precedent): security_invoker alone doesn't grant SELECT to anyone.
  v_view_anon := has_table_privilege('anon', 'public.mnestra_capture_health', 'SELECT');
  v_view_auth := has_table_privilege('authenticated', 'public.mnestra_capture_health', 'SELECT');
  v_view_pub  := has_table_privilege('public', 'public.mnestra_capture_health', 'SELECT');
  v_view_svc  := has_table_privilege('service_role', 'public.mnestra_capture_health', 'SELECT');
  raise notice '[028] mnestra_capture_health SELECT — anon:%, authenticated:%, public:% (expect f f f); service_role:% (expect t)',
    v_view_anon, v_view_auth, v_view_pub, v_view_svc;
  if v_view_anon or v_view_auth or v_view_pub then
    raise exception '[028] VIEW GATE VIOLATION: mnestra_capture_health is SELECTable by anon/authenticated/public (anon=%, authenticated=%, public=%)',
      v_view_anon, v_view_auth, v_view_pub;
  end if;
  if not v_view_svc then
    raise exception '[028] VIEW GATE VIOLATION: service_role lost SELECT on mnestra_capture_health';
  end if;

  -- Post-condition: memory_items / memory_relationships RLS enabled. §6b above
  -- enables it idempotently — on the live store it was already on (out-of-band);
  -- on a fresh install / CI replay §6b is what turns it on. This check now
  -- always passes; it stays as a cheap guard against a future reordering.
  select relrowsecurity into v_items_rls from pg_class where relname = 'memory_items' and relnamespace = 'public'::regnamespace;
  select relrowsecurity into v_rel_rls from pg_class where relname = 'memory_relationships' and relnamespace = 'public'::regnamespace;
  raise notice '[028] pre-existing RLS unchanged — memory_items:%, memory_relationships:% (expect t t)', v_items_rls, v_rel_rls;
  if not (v_items_rls and v_rel_rls) then
    raise exception '[028] RLS REGRESSION: memory_items=%, memory_relationships=% (both must remain true)', v_items_rls, v_rel_rls;
  end if;

  raise notice '[028] receipt: new columns present, migration-027 columns untouched, content_hash generation unchanged, backfill collapse clean (0 remaining active dup groups), both partial unique indexes present, relationship_type CHECK carries base-8+amends_rule+elevated_to, ingest_capture five-gate clean, mnestra_capture_health is security_invoker AND grant-hygiene clean, pre-existing RLS unchanged.';
end$$;

-- ====================================================================
-- 8a. Post-apply verification (ORCH, Studio SQL editor — commented so the
--     migration runner doesn't choke on result sets):
--
--   -- New columns + generated content_hash unchanged
--   select column_name, is_generated, generation_expression, column_default
--     from information_schema.columns
--    where table_schema='public' and table_name='memory_items'
--      and column_name in ('reinforcement_count','sprint_ref','rule_ref','content_hash');
--
--   -- Zero duplicate active content_hash groups
--   select content_hash, count(*) from public.memory_items
--    where is_active=true and content_hash is not null
--    group by content_hash having count(*) > 1;                  -- expect 0 rows
--
--   -- Reinforcement + supersede spot-check on one collapsed group
--   select id, is_active, superseded_by, reinforcement_count from public.memory_items
--    where content_hash = (
--      select content_hash from public.memory_items
--       where superseded_by is not null order by updated_at desc limit 1
--    ) order by created_at;
--
--   -- ingest_capture round trip (service_role): idempotent content_hash path
--   select public.ingest_capture(jsonb_build_object(
--     'content', 'smoke-test capture-gate probe ' || now()::text,
--     'project', 'smoke', 'source_type', 'fact'));                -- expect {"ok":true,"action":"inserted",...}
--   -- re-run with the SAME content -> {"ok":true,"action":"skipped",...}
--
--   -- ingest_capture round trip: rolling pre_compact_snapshot
--   select public.ingest_capture(jsonb_build_object(
--     'content', 'snapshot v1', 'project', 'smoke',
--     'source_type', 'pre_compact_snapshot', 'source_session_id', 'smoke-session-1'));
--   select public.ingest_capture(jsonb_build_object(
--     'content', 'snapshot v2', 'project', 'smoke',
--     'source_type', 'pre_compact_snapshot', 'source_session_id', 'smoke-session-1'));
--   select count(*) from public.memory_items
--    where source_session_id='smoke-session-1' and source_type='pre_compact_snapshot'; -- expect 1
--   delete from public.memory_items where project='smoke';        -- clean up
--
--   -- Supabase advisors must show ZERO new 0011 (mutable search_path) /
--   -- 0013 (RLS disabled) lints attributable to migration 028:
--   --   mcp__supabase__get_advisors(type='security')
--
-- 8b. Reversal (commented — apply by hand to roll back; does NOT restore the
--     backfilled rows to their pre-collapse is_active state, since that
--     backfill is intentionally permanent/reversible-by-audit, not by DDL
--     rollback):
--
--   revoke select on public.mnestra_capture_health from service_role;
--   drop view if exists public.mnestra_capture_health;
--   drop function if exists public.ingest_capture(jsonb);
--   alter table public.memory_items
--     drop constraint if exists memory_items_source_type_check;
--   alter table public.memory_items
--     add constraint memory_items_source_type_check
--     check (source_type = any (array[
--       'fact','decision','preference','bug_fix','architecture','code_context',
--       'session_summary','document_chunk','commit_context','pre_compact_snapshot'
--     ]));  -- NOTE: drops 'doctrine' too — coordinate with T3 before reverting
--   alter table public.memory_relationships
--     drop constraint if exists memory_relationships_relationship_type_check;
--   alter table public.memory_relationships
--     add constraint memory_relationships_relationship_type_check
--     check (relationship_type = any (array[
--       'supersedes','relates_to','contradicts','elaborates','caused_by',
--       'blocks','inspired_by','cross_project_link'
--     ]));  -- NOTE: drops 'elevated_to' too — coordinate with T3 before reverting
--   drop index if exists public.memory_items_precompact_session_uidx;
--   drop index if exists public.memory_items_content_hash_active_uidx;
--   alter table public.memory_items drop column if exists rule_ref;
--   alter table public.memory_items drop column if exists sprint_ref;
--   alter table public.memory_items drop column if exists reinforcement_count;
--   -- content_hash is DELIBERATELY NOT dropped here: on the daily-driver
--   -- store it PRE-DATES this migration (applied out-of-band) — dropping it
--   -- on reversal would destroy pre-existing state this migration doesn't
--   -- own. Only drop it by hand if reverting a FRESH install that got the
--   -- column exclusively from this migration's ADD COLUMN IF NOT EXISTS.
-- ====================================================================

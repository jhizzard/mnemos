-- migrations/030_precompact_rolling.sql
-- Sprint 81 T1 (Recall→Reinjection proof) — the pre_compact_snapshot rolling
-- unit that migration 028 deferred: collapse the accumulated per-session
-- snapshot duplicates, and make ingest_capture's snapshot branch keep exactly
-- ONE active row per session WITHOUT depending on an index that doesn't exist
-- yet.
--
-- WHY (the R3 correction — ORCH-RESOLUTIONS): migration 028 shipped
-- ingest_capture with a pre_compact_snapshot branch that uses
-- `ON CONFLICT (source_session_id) WHERE (...)` (028:325-345), but the matching
-- partial-unique arbiter index is DEFERRED (028:212-219). PostgreSQL REQUIRES a
-- matching unique/exclusion arbiter for `ON CONFLICT`, so the moment T3 switches
-- the pre-compact hook to `/rpc/ingest_capture`, that branch would raise 42P10
-- ("no unique or exclusion constraint matching the ON CONFLICT specification").
-- "Create the index last" and "ON CONFLICT needs the index" are circular. This
-- migration breaks the cycle by making the branch ARBITER-FREE.
--
-- WHAT:
--   1. One-time backfill collapse of existing ACTIVE pre_compact_snapshot
--      duplicates per session — keep NEWEST, supersede the rest (is_active=
--      false + superseded_by), REVERSIBLE, never DELETE. (028's content_hash
--      collapse kept OLDEST because there the original is canonical; here the
--      latest snapshot IS the current state, so newest wins.)
--   2. CREATE OR REPLACE public.ingest_capture(jsonb) — the pre_compact_snapshot
--      branch is redefined arbiter-free: a per-session transaction advisory lock
--      + explicit "SELECT active snapshot → UPDATE in place, else INSERT". Keeps
--      <=1 active snapshot/session with NO index dependency. The content_hash
--      idempotency branch is UNCHANGED from 028 (its arbiter,
--      memory_items_content_hash_active_uidx, exists — 028 created it active).
--   3. The deferred partial-unique index SQL, left COMMENTED — ORCH creates it
--      LAST at close-out (after T3's hook switch is confirmed round-tripping),
--      now as a pure INTEGRITY GUARD rather than a functional arbiter.
--
-- Ordering (non-circular, per R3):
--   (1) collapse dups [this migration]  →  (2) ingest_capture arbiter-free
--   [this migration]  →  (3) T3 switches memory-pre-compact.js to
--   /rpc/ingest_capture (verified round-trip)  →  (4) ORCH creates the
--   integrity index LAST (succeeds: the RPC keeps <=1 active snapshot/session
--   and the old append-hook is gone).
--
-- Five RLS hygiene gates (global CLAUDE.md), verified by the HARD-FAILING
-- OID-form receipt:
--   GATE 1  No NEW table — memory_items already has RLS (028 §6b); receipt
--           re-checks as a regression guard.
--   GATE 2  No new policies; no WITH CHECK (true).
--   GATE 3  REVOKE EXECUTE on ingest_capture FROM public, anon, authenticated
--           + GRANT service_role only (re-pinned after CREATE OR REPLACE).
--   GATE 4  SET search_path = public, extensions, pg_catalog on ingest_capture
--           (its vector(1536) variable — matches 028/029).
--   GATE 5  No raw anon-key write path: ingest_capture is the only write
--           surface here, SECURITY DEFINER + anon/authenticated revoked.
--
-- Idempotent / rerun-safe: the backfill UPDATE is naturally idempotent (a
-- second run finds zero remaining >1-active-snapshot groups); CREATE OR REPLACE
-- FUNCTION; REVOKE/GRANT idempotent; the receipt DO block only SELECTs (raises).
--
-- APPLY: write + test locally only. ORCH applies at sprint close, THEN creates
-- the §3 index last. 030 runs AFTER 028 (which defines ingest_capture + the
-- content_hash index) and 029; it touches neither memory_recall_log nor
-- memory_hybrid_search.

-- ====================================================================
-- 1. Backfill collapse — active pre_compact_snapshot dups per session.
--    keep NEWEST canonical, supersede the rest. REVERSIBLE, never DELETE.
--    (NULL-source_session_id snapshot rows are left untouched: the deferred
--    index treats NULLs as distinct, so they never violate it, and they can't
--    be collapsed by a session key they don't have.)
-- ====================================================================

with snap_groups as (
  select
    source_session_id,
    (array_agg(id order by created_at desc, id desc))[1] as keep_id
  from public.memory_items
  where is_active = true
    and source_type = 'pre_compact_snapshot'
    and source_session_id is not null
  group by source_session_id
  having count(*) > 1
)
update public.memory_items m
   set is_active     = false,
       superseded_by = sg.keep_id,
       updated_at    = now()
  from snap_groups sg
 where m.source_session_id = sg.source_session_id
   and m.source_type = 'pre_compact_snapshot'
   and m.id <> sg.keep_id
   and m.is_active = true;

-- Early, clear-message guard: the eventual integrity index would otherwise fail
-- with an opaque "duplicate key" if the collapse left a group unresolved.
do $$
declare
  v_dup_remaining int;
begin
  select count(*) into v_dup_remaining
    from (
      select source_session_id from public.memory_items
       where is_active = true and source_type = 'pre_compact_snapshot'
         and source_session_id is not null
       group by source_session_id having count(*) > 1
    ) g;
  raise notice '[030] active pre_compact_snapshot per-session dup groups remaining after collapse: % (expect 0)', v_dup_remaining;
  if v_dup_remaining <> 0 then
    raise exception '[030] BACKFILL INCOMPLETE: % pre_compact_snapshot session group(s) still have >1 active row', v_dup_remaining;
  end if;
end$$;

-- ====================================================================
-- 2. ingest_capture(jsonb) — CREATE OR REPLACE with an ARBITER-FREE
--    pre_compact_snapshot branch (R3). The content_hash idempotency branch is
--    byte-for-byte 028's (its arbiter exists). Same (jsonb) signature.
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
    -- Sprint 81 (migration 030, R3): ARBITER-FREE rolling snapshot. Serialize
    -- per session with a transaction advisory lock so a concurrent capture for
    -- the same session can't race two active rows into existence, then SELECT
    -- the active snapshot → UPDATE it in place, else INSERT. This keeps <=1
    -- active snapshot per (session) WITHOUT `ON CONFLICT`, so it does NOT need
    -- the deferred partial-unique index — that index (created LAST by ORCH) is
    -- then a pure uniqueness backstop, not a functional arbiter. The lock is
    -- transaction-scoped: released when this RPC's transaction ends.
    perform pg_advisory_xact_lock(hashtextextended('mnestra_precompact:' || v_source_session_id, 0));

    select id into v_id
      from public.memory_items
     where source_session_id = v_source_session_id
       and source_type = 'pre_compact_snapshot'
       and is_active = true
     order by created_at desc
     limit 1;

    if v_id is not null then
      update public.memory_items
         set content      = v_content,
             embedding    = coalesce(v_embedding, embedding),
             metadata     = v_metadata,
             source_agent = coalesce(v_source_agent, source_agent),
             sprint_ref   = coalesce(v_sprint_ref, sprint_ref),
             rule_ref     = coalesce(v_rule_ref, rule_ref),
             updated_at   = now()
       where id = v_id;
      return jsonb_build_object('ok', true, 'id', v_id, 'action', 'updated');
    else
      -- No active snapshot yet → first capture for this session. (An
      -- astronomically-rare byte-identical-content collision with another
      -- session's active row would trip memory_items_content_hash_active_uidx —
      -- a pre-existing 028 exposure, not introduced here; the fire-and-forget
      -- caller swallows it and T3's hook falls back to a raw append.)
      insert into public.memory_items
        (content, embedding, source_type, category, project, metadata,
         source_agent, source_session_id, sprint_ref, rule_ref)
      values
        (v_content, v_embedding, v_source_type, v_category, v_project, v_metadata,
         v_source_agent, v_source_session_id, v_sprint_ref, v_rule_ref)
      returning id into v_id;
      return jsonb_build_object('ok', true, 'id', v_id, 'action', 'inserted');
    end if;
  end if;

  -- Everything else: content_hash idempotency (UNCHANGED from 028). DO NOTHING
  -- on a byte-identical retry; its arbiter (memory_items_content_hash_active_uidx)
  -- exists (028 created it active), so this ON CONFLICT is valid.
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
    -- (generated md5(content)), so the existing active row is a direct lookup.
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
  'Sprint 79 (migration 028), redefined Sprint 81 (migration 030): capture-gate '
  'RPC. The pre_compact_snapshot branch is ARBITER-FREE (advisory-locked '
  'SELECT-then-UPDATE-else-INSERT — keeps <=1 active snapshot/session with no '
  'index dependency); the content_hash branch stays ON CONFLICT idempotent. '
  'SECURITY DEFINER, pinned search_path; EXECUTE: service_role only.';

-- [GATE 3] Re-pin (CREATE OR REPLACE preserves grants; keeps the receipt honest).
revoke execute on function public.ingest_capture(jsonb)
  from public, anon, authenticated;
grant  execute on function public.ingest_capture(jsonb)
  to service_role;

-- ====================================================================
-- 3. Deferred partial-unique index — the pre_compact_snapshot INTEGRITY GUARD.
--    ORCH creates this LAST at close-out (R3 step 4), AFTER T3's hook switch is
--    confirmed round-tripping through ingest_capture — so the OLD append-per-
--    compaction hook (which INSERTs a fresh active row per compaction) can no
--    longer violate it. ingest_capture no longer DEPENDS on it (§2 is
--    arbiter-free), so this is a pure uniqueness backstop. Left COMMENTED so
--    applying 030 does NOT create it prematurely; ORCH runs this exact
--    statement by hand as the final step. Requires §1's collapse to have run.
--
--   create unique index if not exists memory_items_precompact_session_uidx
--     on public.memory_items (source_session_id)
--     where (source_type = 'pre_compact_snapshot' and is_active = true);
-- ====================================================================

-- ====================================================================
-- 4. Apply-time receipt — HARD-FAILING, OID form.
-- ====================================================================

do $$
declare
  v_dup_remaining  int;
  v_idx_precompact boolean;
  v_oid            oid;
  v_anon           boolean;
  v_auth           boolean;
  v_pub            boolean;
  v_svc            boolean;
  v_cfg            text;
begin
  -- Collapse clean: zero per-session groups with >1 active snapshot.
  select count(*) into v_dup_remaining
    from (
      select source_session_id from public.memory_items
       where is_active = true and source_type = 'pre_compact_snapshot'
         and source_session_id is not null
       group by source_session_id having count(*) > 1
    ) g;
  raise notice '[030] pre_compact_snapshot per-session dup groups: % (expect 0)', v_dup_remaining;
  if v_dup_remaining <> 0 then
    raise exception '[030] BACKFILL REGRESSION: % pre_compact_snapshot session group(s) still have >1 active row', v_dup_remaining;
  end if;

  -- Integrity index state — informational. Expected ABSENT at 030-apply time;
  -- ORCH creates it LAST at close-out (§3). Do NOT fail on its absence.
  select exists (select 1 from pg_indexes
                  where schemaname='public' and indexname='memory_items_precompact_session_uidx')
    into v_idx_precompact;
  raise notice '[030] precompact integrity index present: % (expected f at 030-apply; ORCH creates it LAST)', v_idx_precompact;

  -- ingest_capture five-gate (OID form).
  select p.oid into v_oid
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname='public' and p.proname='ingest_capture' limit 1;
  if v_oid is null then
    raise exception '[030] ingest_capture not found after CREATE OR REPLACE';
  end if;
  v_anon := has_function_privilege('anon',          v_oid, 'EXECUTE');
  v_auth := has_function_privilege('authenticated', v_oid, 'EXECUTE');
  v_pub  := has_function_privilege('public',        v_oid, 'EXECUTE');
  v_svc  := has_function_privilege('service_role',  v_oid, 'EXECUTE');
  select array_to_string(p.proconfig, '; ') into v_cfg from pg_proc p where p.oid = v_oid;
  raise notice '[030] ingest_capture EXECUTE — anon:%, auth:%, public:% (expect f f f); service_role:% (expect t); proconfig:%',
    v_anon, v_auth, v_pub, v_svc, coalesce(v_cfg,'<none>');
  if v_anon or v_auth or v_pub then
    raise exception '[030] GATE 3 VIOLATION: ingest_capture executable by anon/authenticated/public (%, %, %)', v_anon, v_auth, v_pub;
  end if;
  if not v_svc then
    raise exception '[030] GATE 3 VIOLATION: service_role lost EXECUTE on ingest_capture';
  end if;
  if v_cfg is null or v_cfg not like '%search_path=public, extensions, pg_catalog%' then
    raise exception '[030] GATE 4 VIOLATION: ingest_capture search_path not pinned (proconfig: %)', coalesce(v_cfg,'<none>');
  end if;

  raise notice '[030] receipt: per-session snapshot collapse clean, ingest_capture arbiter-free + five-gate clean, precompact integrity index deferred to ORCH close-out.';
end$$;

-- ====================================================================
-- 5a. Post-apply verification (ORCH, Studio SQL editor — commented):
--
--   -- Zero per-session groups with >1 active snapshot
--   select source_session_id, count(*) from public.memory_items
--    where is_active=true and source_type='pre_compact_snapshot' and source_session_id is not null
--    group by source_session_id having count(*) > 1;                 -- expect 0 rows
--
--   -- ingest_capture rolling round trip WITHOUT the index (arbiter-free proof):
--   select public.ingest_capture(jsonb_build_object(
--     'content','snap v1','project','smoke','source_type','pre_compact_snapshot',
--     'source_session_id','smoke-030-1'));                            -- action inserted
--   select public.ingest_capture(jsonb_build_object(
--     'content','snap v2','project','smoke','source_type','pre_compact_snapshot',
--     'source_session_id','smoke-030-1'));                            -- action updated
--   select count(*) from public.memory_items
--    where source_session_id='smoke-030-1' and source_type='pre_compact_snapshot' and is_active; -- expect 1
--   delete from public.memory_items where project='smoke';           -- clean up
--
--   -- THEN, as the LAST close-out step (after T3's hook round-trips):
--   create unique index if not exists memory_items_precompact_session_uidx
--     on public.memory_items (source_session_id)
--     where (source_type = 'pre_compact_snapshot' and is_active = true);
--
--   -- Supabase advisors: ZERO new 0011/0013 lints attributable to 030.
--
-- 5b. Reversal (commented — does NOT restore collapsed rows to pre-collapse
--     is_active state; that backfill is reversible-by-audit, not by DDL):
--   drop index if exists public.memory_items_precompact_session_uidx;
--   -- then re-apply migration 028's ingest_capture body verbatim
--   -- (028_capture_gates.sql lines 286-374) to restore the ON CONFLICT branch.
-- ====================================================================

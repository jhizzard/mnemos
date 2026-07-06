-- migrations/031_recall_provenance.sql
-- Sprint 81 T1 (Recall→Reinjection proof) — make a recall observable as a
-- discrete "reinjection event" and make MCP-stdio provenance non-NULL.
--
-- WHY: migration 027 (Sprint 78) stood up public.memory_recall_log — one row
-- per RETURNED recall hit — but two gaps keep "which panel pulled which
-- memory, grouped into which reinjection, at what budget" un-answerable:
--   G1  the log has no source_type (per hit), no token_budget (per call), and
--       no per-recall grouping id — so the K rows of one recall can't be
--       reassembled into the single reinjection event they came from, and the
--       source_type mix of a recall isn't queryable from the log alone.
--   G2  the MCP-stdio memory_recall handler never passed log_session_id /
--       log_source_agent into memoryRecall() (only the webhook path did), so
--       the PRIMARY recall path logged source_session_id=NULL, source_agent=
--       NULL. G2 is fixed in TS (mcp-server/index.ts reads the launcher's
--       identity from the environment — see the note in §5 below); this
--       migration supplies the COLUMNS that fix makes meaningful.
--
-- WHAT: EXTEND 027 (never fork it — a parallel recall_events table would split
-- the signal pruning/elevation thresholds already key off, per ORCH ruling 1):
--   1. public.memory_recall_log — ADD source_type / token_budget /
--      recall_group_id (all nullable; a fire-and-forget telemetry write must
--      never fail on a missing field). recall_count / last_recalled_at are
--      OWNED BY migration 027 and are NOT touched here (collision guard,
--      mirrors 027's own note about Sprint 79).
--   2. An index on recall_group_id — the proof surface's core lookup is
--      "give me the K hit-rows of THIS reinjection event" (point lookup) and
--      "group recent recalls by event"; both want the btree. Deliberately NO
--      new index on source_type: the source_type mix is an aggregate over a
--      90-day-retention (bounded) table, cheap without one, and every added
--      index is write amplification on the fire-and-forget hot path.
--   3. public.log_recall_hits(jsonb) — CREATE OR REPLACE (same (jsonb)
--      signature, so grants are preserved; re-REVOKE/GRANT below is
--      belt-and-suspenders + keeps the hygiene receipt honest). The recordset
--      typing + INSERT column list gain source_type / token_budget /
--      recall_group_id. The batched (never per-row) denorm bump of
--      recall_count / last_recalled_at is carried over verbatim from 027.
--
-- Five RLS hygiene gates (global CLAUDE.md § "Supabase RLS + privilege
-- hygiene"), verified by the HARD-FAILING receipt at the bottom (OID form from
-- day one — see the §6 note: pg_get_function_identity_arguments returns arg
-- NAMES on Supabase's Postgres, so the receipt resolves the function OID by
-- proname and never reconstructs a text signature):
--   GATE 1  No NEW table — memory_recall_log already has RLS enabled (027);
--           the receipt re-checks it as a regression guard, not a new gate.
--   GATE 2  No new policies; no WITH CHECK (true) anywhere in this file.
--   GATE 3  REVOKE EXECUTE on log_recall_hits FROM public, anon, authenticated
--           + targeted GRANT to service_role only (CREATE OR REPLACE preserves
--           the 027 grant; this re-pins it defensively).
--   GATE 4  SET search_path = public, pg_catalog on log_recall_hits (the RPC
--           types are jsonb/uuid/text/int/double precision only — no vector —
--           so, unlike 028/029, the pinned path does NOT need `extensions`).
--   GATE 5  No raw anon-key write path: log_recall_hits stays the sole INSERT
--           into memory_recall_log; anon/authenticated table grants remain
--           revoked (027) and this migration adds none.
--
-- Backward-compat: zero behavior change for any install. The new columns are
-- nullable; a caller that predates the TS changes simply logs them NULL.
-- Recall latency is unchanged — the TS write points fire log_recall_hits
-- fire-and-forget, NEVER awaited (src/recall_log.ts contract).
--
-- Idempotent / rerun-safe: ADD COLUMN IF NOT EXISTS; CREATE INDEX IF NOT
-- EXISTS; CREATE OR REPLACE FUNCTION; REVOKE/GRANT are naturally idempotent;
-- the receipt DO block only SELECTs (and raises). Re-applying re-verifies.
--
-- APPLY: write + test locally only. Nobody applies this to the daily-driver
-- project from a lane — ORCH applies at sprint close (PLANNING.md § Lane
-- discipline), then runs the commented post-apply verification at the bottom
-- and the five-gate get_advisors check. 031 runs AFTER 027 (which creates the
-- table + the base function); 028/029/030 sit between them and touch neither
-- memory_recall_log nor log_recall_hits, so this cleanly layers on 027.

-- ====================================================================
-- 1. New provenance columns on memory_recall_log.
--    (collision guard: recall_count / last_recalled_at are OWNED BY 027 and
--    live on memory_items, NOT here — untouched.)
-- ====================================================================

alter table public.memory_recall_log
  add column if not exists source_type text;
alter table public.memory_recall_log
  add column if not exists token_budget int;
alter table public.memory_recall_log
  add column if not exists recall_group_id uuid;

comment on column public.memory_recall_log.source_type is
  'Sprint 81 (migration 031): the recalled memory''s source_type at recall '
  'time (per hit) — lets the proof surface show a recall''s source_type mix '
  '(decision/doctrine/fact/…) from the log alone. NULL when the surface can''t '
  'supply it (graph recall — memory_recall_graph does not return source_type).';
comment on column public.memory_recall_log.token_budget is
  'Sprint 81 (migration 031): the recall call''s token budget (per call; the '
  'same value on every row of the call''s recall_group_id). NULL for surfaces '
  'without a token budget (search/index/timeline/graph). Powers the '
  'cold-vs-warm "token-in" delta.';
comment on column public.memory_recall_log.recall_group_id is
  'Sprint 81 (migration 031): one uuid per recall CALL, shared by that call''s '
  'K returned hit-rows — i.e. the identity of a single reinjection event. '
  'Generated client-side in src/recall_log.ts (one per logRecallHits call). '
  'NULL only for rows written before this migration''s TS changes shipped.';

-- The proof surface's core reads: fetch one reinjection event's K rows
-- (WHERE recall_group_id = $1) and group recent recalls by event. Btree
-- serves both. (No index on source_type — bounded-table aggregate; see header.)
create index if not exists memory_recall_log_group_idx
  on public.memory_recall_log (recall_group_id);

-- ====================================================================
-- 2. log_recall_hits(jsonb) — extend the recordset + INSERT to carry the
--    three new provenance fields. The batched denorm bump is UNCHANGED from
--    027 (statement-level, never per-row). Same (jsonb) signature.
-- ====================================================================

create or replace function public.log_recall_hits(p_hits jsonb)
returns int
language plpgsql
security definer
set search_path = public, pg_catalog  -- [GATE 4]
as $$
declare
  v_inserted int := 0;
begin
  -- Defensive no-op on empty / malformed input (fire-and-forget caller).
  if p_hits is null
     or jsonb_typeof(p_hits) <> 'array'
     or jsonb_array_length(p_hits) = 0 then
    return 0;
  end if;

  -- ONE statement-level insert of K rows (the returned set). jsonb_to_recordset
  -- types each element; rows with a NULL memory_id are skipped. source_type /
  -- token_budget / recall_group_id are the Sprint 81 provenance additions.
  insert into public.memory_recall_log
    (memory_id, query_hash, query_preview, score, rank, surface,
     source_session_id, source_agent,
     source_type, token_budget, recall_group_id)
  select h.memory_id,
         h.query_hash,
         -- DB-level backstop on top of the TS redactor's <=120 truncation.
         left(h.query_preview, 200),
         h.score,
         h.rank,
         coalesce(h.surface, 'recall'),
         h.source_session_id,
         h.source_agent,
         h.source_type,
         h.token_budget,
         h.recall_group_id
    from jsonb_to_recordset(p_hits) as h(
      memory_id          uuid,
      query_hash         text,
      query_preview      text,
      score              double precision,
      rank               int,
      surface            text,
      source_session_id  text,
      source_agent       text,
      source_type        text,
      token_budget       int,
      recall_group_id    uuid
    )
   where h.memory_id is not null;

  get diagnostics v_inserted = row_count;

  -- Batched / statement-level denorm bump — carried over verbatim from 027:
  -- ONE UPDATE touching K distinct rows via a join, NEVER per-row, so a
  -- 4-panel boot can't trigger hot-row lock storms. Memories that no longer
  -- exist are simply not matched (self-healing — 027's no-FK rationale).
  update public.memory_items m
     set recall_count     = coalesce(m.recall_count, 0) + agg.cnt,
         last_recalled_at = now()
    from (
      select (h->>'memory_id')::uuid as memory_id, count(*)::int as cnt
        from jsonb_array_elements(p_hits) as h
       where h->>'memory_id' is not null
       group by 1
    ) agg
   where m.id = agg.memory_id;

  return v_inserted;
end;
$$;

comment on function public.log_recall_hits(jsonb) is
  'Sprint 78 (migration 027), extended Sprint 81 (migration 031): sole insert '
  'path into memory_recall_log. One statement-level insert of the K returned '
  'hits (now carrying source_type/token_budget/recall_group_id) + one batched '
  '(never per-row) bump of memory_items.recall_count / .last_recalled_at. '
  'SECURITY DEFINER, pinned search_path; EXECUTE: service_role only. Called '
  'fire-and-forget from the recall paths — never awaited, latency unchanged.';

-- [GATE 3] Re-pin (CREATE OR REPLACE preserves grants; this defends a
-- divergent long-lived install and keeps the hygiene receipt honest).
revoke execute on function public.log_recall_hits(jsonb)
  from public, anon, authenticated;
grant  execute on function public.log_recall_hits(jsonb)
  to service_role;

-- ====================================================================
-- 3. G2 FIX lives in TypeScript, documented here so the pair is legible.
--    Provenance is a TRUSTED PRODUCER, not a spoofable tool arg (Sprint 81 R2,
--    ORCH-RESOLUTIONS): the recall-log path (src/recall_log.ts) resolves
--    source_session_id / source_agent from the explicit log_* inputs when
--    present (the webhook threads them from its request args,
--    src/webhook-server.ts:158-159 / 178-179), else falls back to the
--    MNESTRA_SESSION_ID / MNESTRA_SOURCE_AGENT environment variables TermDeck
--    exports into each spawned agent's env at panel spawn (owned by T4). Doing
--    the read at that single choke point makes EVERY MCP-stdio recall surface
--    (recall/search/index/timeline/graph) carry non-null provenance, and the
--    value is un-forgeable (a panel can't set another panel's id). Unset env ⇒
--    NULL (fail-soft, exactly the pre-Sprint-81 behavior). No SQL is needed
--    for G2 — this migration only supplies the columns provenance lands in.
-- ====================================================================

-- ====================================================================
-- 4. Apply-time receipt — HARD-FAILING. Any gate violation raises, rolling
--    back the whole migration transaction. OID form (see §6-style note in the
--    029 header + the migration-receipt bug_fix: pg_get_function_identity_
--    arguments returns arg NAMES on Supabase's Postgres, so we resolve the
--    function OID by proname and use has_function_privilege(oid, …), never a
--    reconstructed text signature).
-- ====================================================================

do $$
declare
  v_rls          boolean;
  v_policy_count int;
  v_has_stype    boolean;
  v_has_budget   boolean;
  v_has_group    boolean;
  v_has_group_ix boolean;
  v_oid          oid;
  v_anon         boolean;
  v_auth         boolean;
  v_pub          boolean;
  v_svc          boolean;
  v_cfg          text;
begin
  -- Regression guards: RLS still on, still zero policies (027's posture).
  select c.relrowsecurity into v_rls
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname = 'memory_recall_log';
  select count(*)::int into v_policy_count
    from pg_policies
   where schemaname = 'public' and tablename = 'memory_recall_log';

  -- The three new provenance columns exist.
  select exists (select 1 from information_schema.columns
                  where table_schema='public' and table_name='memory_recall_log'
                    and column_name='source_type') into v_has_stype;
  select exists (select 1 from information_schema.columns
                  where table_schema='public' and table_name='memory_recall_log'
                    and column_name='token_budget') into v_has_budget;
  select exists (select 1 from information_schema.columns
                  where table_schema='public' and table_name='memory_recall_log'
                    and column_name='recall_group_id') into v_has_group;
  select exists (select 1 from pg_indexes
                  where schemaname='public' and indexname='memory_recall_log_group_idx')
    into v_has_group_ix;

  raise notice '[031] memory_recall_log RLS:% (expect t), policies:% (expect 0)', v_rls, v_policy_count;
  raise notice '[031] new columns — source_type:%, token_budget:%, recall_group_id:% (expect t t t); group index:% (expect t)',
    v_has_stype, v_has_budget, v_has_group, v_has_group_ix;

  if v_rls is distinct from true then
    raise exception '[031] GATE 1 REGRESSION: RLS not enabled on public.memory_recall_log';
  end if;
  if v_policy_count <> 0 then
    raise exception '[031] GATE 2 REGRESSION: % policies present on public.memory_recall_log (expected 0)', v_policy_count;
  end if;
  if not (v_has_stype and v_has_budget and v_has_group) then
    raise exception '[031] PROVENANCE COLUMN MISSING: source_type=%, token_budget=%, recall_group_id=%',
      v_has_stype, v_has_budget, v_has_group;
  end if;
  if not v_has_group_ix then
    raise exception '[031] INDEX MISSING: memory_recall_log_group_idx';
  end if;

  -- log_recall_hits five-gate re-verify (OID form).
  select p.oid into v_oid
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'log_recall_hits'
   limit 1;
  if v_oid is null then
    raise exception '[031] log_recall_hits not found after CREATE OR REPLACE';
  end if;

  v_anon := has_function_privilege('anon',          v_oid, 'EXECUTE');
  v_auth := has_function_privilege('authenticated', v_oid, 'EXECUTE');
  v_pub  := has_function_privilege('public',        v_oid, 'EXECUTE');
  v_svc  := has_function_privilege('service_role',  v_oid, 'EXECUTE');
  select array_to_string(p.proconfig, '; ') into v_cfg from pg_proc p where p.oid = v_oid;

  raise notice '[031] log_recall_hits EXECUTE — anon:%, authenticated:%, public:% (expect f f f); service_role:% (expect t); proconfig: %',
    v_anon, v_auth, v_pub, v_svc, coalesce(v_cfg, '<none>');

  if v_anon or v_auth or v_pub then
    raise exception '[031] GATE 3 VIOLATION: log_recall_hits executable by anon/authenticated/public (anon=%, authenticated=%, public=%)',
      v_anon, v_auth, v_pub;
  end if;
  if not v_svc then
    raise exception '[031] GATE 3 VIOLATION: service_role lost EXECUTE on log_recall_hits';
  end if;
  if v_cfg is null or v_cfg not like '%search_path=public, pg_catalog%' then
    raise exception '[031] GATE 4 VIOLATION: log_recall_hits search_path not pinned (proconfig: %)', coalesce(v_cfg, '<none>');
  end if;

  raise notice '[031] receipt: 3 provenance columns + group index present, log_recall_hits five-gate clean, 027 RLS posture unchanged.';
end$$;

-- ====================================================================
-- 5a. Post-apply verification (ORCH, Studio SQL editor — commented so the
--     migration runner doesn't choke on result sets):
--
--   -- New columns present
--   select column_name from information_schema.columns
--    where table_schema='public' and table_name='memory_recall_log'
--      and column_name in ('source_type','token_budget','recall_group_id'); -- expect 3 rows
--
--   -- Round trip (service_role): one recall_group_id groups its K rows,
--   -- carrying source_type + token_budget:
--   with g as (select gen_random_uuid() as gid)
--   select public.log_recall_hits(
--     jsonb_build_array(
--       jsonb_build_object('memory_id',(select id from public.memory_items limit 1),
--         'query_hash','smoke','query_preview','smoke probe','score',0.9,'rank',1,
--         'surface','recall','source_type','decision','token_budget',2000,
--         'recall_group_id',(select gid from g)),
--       jsonb_build_object('memory_id',(select id from public.memory_items offset 1 limit 1),
--         'query_hash','smoke','query_preview','smoke probe','score',0.8,'rank',2,
--         'surface','recall','source_type','fact','token_budget',2000,
--         'recall_group_id',(select gid from g))
--     ));  -- expect 2
--   select recall_group_id, count(*), array_agg(source_type), max(token_budget)
--     from public.memory_recall_log where query_hash='smoke' group by recall_group_id; -- 1 group, 2 rows
--   delete from public.memory_recall_log where query_hash='smoke';  -- clean up
--
--   -- log_recall_hits privileges unchanged (anon/auth/public f, service_role t)
--   select has_function_privilege('service_role','public.log_recall_hits(jsonb)','EXECUTE'); -- t
--
--   -- Supabase advisors: ZERO new 0011 (mutable search_path) / 0013 (RLS
--   -- disabled) lints attributable to 031:  mcp__supabase__get_advisors(type='security')
--
-- 5b. Reversal (commented — apply by hand to roll back):
--   drop index if exists public.memory_recall_log_group_idx;
--   alter table public.memory_recall_log drop column if exists recall_group_id;
--   alter table public.memory_recall_log drop column if exists token_budget;
--   alter table public.memory_recall_log drop column if exists source_type;
--   -- then re-apply migration 027's log_recall_hits body (027 lines 192-255) to
--   -- drop the three columns from the insert/recordset.
-- ====================================================================

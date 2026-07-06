-- migrations/027_recall_telemetry.sql
-- Sprint 78 T3 (Recall telemetry) — make "which memories actually get
-- recalled, and which never do" a measurable quantity.
--
-- WHY: today "never recalled" is uncomputable, so every pruning / elevation
-- threshold is a guess. This migration stands up a recall-hit log so the
-- thresholds become data-driven. Telemetry starts accumulating NOW; nobody
-- acts on recall_count=0 for >= 1 full sprint cycle (the pruning moratorium,
-- PLANNING.md §2 dec. 4).
--
-- WHAT:
--   1. public.memory_recall_log — one row per RETURNED recall hit (not the
--      10-40 over-fetched candidates). Written ONLY by the server-side
--      service-role RPC log_recall_hits(); no recall path reads it.
--   2. public.memory_items.recall_count / .last_recalled_at — denormalized
--      counters bumped statement-level (batched, never per-row) inside
--      log_recall_hits, so the per-memory aggregate survives raw-row purges.
--   3. public.log_recall_hits(jsonb)        — insert K returned hits + bump.
--      public.mark_recall_feedback(jsonb,text) — flip cited/dismissed on the
--                                                 most-recent log row per id
--                                                 (memory_get's "actually used"
--                                                 signal + the webhook
--                                                 op:'feedback' receiver).
--      public.purge_recall_log(int)         — age out raw rows past retention.
--   4. A pg_cron job (guarded; only if pg_cron is installed) that rolls up
--      then purges memory_recall_log rows older than 90 days. "Rollup" = the
--      denorm counters above, maintained at WRITE time, so the purge never
--      loses the aggregate — it only ages out the raw per-hit rows.
--
-- COLLISION GUARD (forward note for Sprint 79 — PLANNING §8.6): the
-- recall_count + last_recalled_at columns on memory_items are owned by THIS
-- migration (027). Sprint 79 T1's memory_items additions
-- (reinforcement_count, sprint_ref, content_hash, ...) are DIFFERENT columns;
-- Sprint 79 staging must NOT re-add recall_count / last_recalled_at.
--
-- Five RLS hygiene gates (global CLAUDE.md § "Supabase RLS + privilege
-- hygiene"), marked [GATE n] inline and verified by the HARD-FAILING receipt
-- block at the bottom (mirrors migration 026's strengthening of 025's
-- notice-only idiom — apply_migration has a known silent-no-op failure mode,
-- so a receipt that cannot fail is not a receipt):
--   GATE 1  RLS enabled on memory_recall_log in this same migration.
--   GATE 2  NO policies at all (no WITH CHECK (true), no PUBLIC, nothing):
--           anon/authenticated are denied everything; service_role bypasses
--           RLS by design. The log is a server-side-write-only path.
--   GATE 3  REVOKE EXECUTE ... FROM public, anon, authenticated (the three
--           default grantees — Postgres' PUBLIC default AND migration 014's
--           ALTER DEFAULT PRIVILEGES anon/authenticated grants) + targeted
--           GRANT to service_role only, on all 3 functions.
--   GATE 4  SET search_path = public, pg_catalog on every function —
--           SECURITY DEFINER makes this load-bearing (search_path shadow
--           attack is a privilege-escalation primitive otherwise).
--   GATE 5  No raw anon-key write path: the only INSERT is log_recall_hits;
--           the only UPDATE is mark_recall_feedback / log_recall_hits; table
--           grants for anon/authenticated are revoked outright.
--
-- Backward-compat: zero behavior change for any install. Recall latency is
-- unchanged — the TS write points (recall.ts/search.ts/layered.ts/
-- recall_graph.ts/webhook-server.ts) fire log_recall_hits fire-and-forget,
-- NEVER awaited.
--
-- Idempotent / rerun-safe: CREATE TABLE/INDEX IF NOT EXISTS; ADD COLUMN IF
-- NOT EXISTS; CREATE OR REPLACE FUNCTION; ENABLE RLS / REVOKE / GRANT are
-- naturally idempotent; the pg_cron block unschedules-before-schedules; the
-- receipt DO block only SELECTs (and raises). Re-applying re-verifies the
-- gates.
--
-- APPLY: write + test locally only. Nobody applies this to the daily-driver
-- project from a lane — ORCH applies at sprint close (PLANNING.md § Hard
-- constraints), then runs the commented post-apply verification at the bottom
-- and the five-gate get_advisors check.

-- ====================================================================
-- 1. Recall-hit log table
-- ====================================================================

create table if not exists public.memory_recall_log (
  id                 uuid primary key default gen_random_uuid(),

  -- The recalled memory. Indexed, but deliberately NOT a FK to memory_items:
  -- a fire-and-forget telemetry write must be maximally robust — a FK could
  -- make the insert fail if a memory was concurrently hard-deleted, and the
  -- denorm UPDATE already self-heals (it only touches ids that still exist).
  memory_id          uuid not null,

  -- Stable hash of the NORMALIZED query (case/whitespace-insensitive); lets
  -- "same query, different sessions" be grouped without storing the text.
  query_hash         text,

  -- A SHORT, gitleaks-SHAPE-redacted preview of the query (<=120 chars).
  -- Recall queries contain pasted secrets more often than memory content;
  -- the TS write site (src/recall_log.ts redactQueryPreview) masks secret
  -- shapes and the Supabase-ref shape before this ever leaves the process,
  -- and fail-soft stores '' on any redaction error. Never the raw query.
  query_preview      text,

  score              double precision,   -- retrieval score of this hit
  rank               int,                -- 1-based position in the returned set

  -- Which retrieval surface produced the row.
  surface            text not null default 'recall',

  source_session_id  text,               -- caller session (NULL for MCP stdio)
  source_agent       text,               -- caller provenance (NULL if unknown)

  cited              boolean not null default false,  -- "actually used" signal
  dismissed          boolean not null default false,  -- negative signal

  created_at         timestamptz not null default now()
);

comment on table public.memory_recall_log is
  'Sprint 78 recall telemetry: one row per RETURNED recall hit (not the '
  'over-fetched candidate pool). Written ONLY by the service-role RPC '
  'log_recall_hits() (fire-and-forget from the recall paths); no recall path '
  'reads it. Powers data-driven pruning/elevation thresholds. 90-day '
  'retention via pg_cron; the per-memory aggregate lives on '
  'memory_items.recall_count / .last_recalled_at and survives the purge.';

comment on column public.memory_recall_log.query_preview is
  'Gitleaks-shape-redacted, <=120-char preview of the recall query. Secret '
  'shapes (JWT/AWS/OpenAI/Stripe/GitHub/Slack/PEM/KEY=VALUE) and the '
  'Supabase project-ref shape are masked at the write site before storage; '
  'redaction errors store an empty string. NEVER the raw query.';

comment on column public.memory_recall_log.surface is
  'Retrieval surface: recall | search | index | timeline | graph | webhook. '
  'MCP-stdio paths log their native surface; the webhook stamps ''webhook'' '
  'for over-the-wire recall/search.';

comment on column public.memory_recall_log.cited is
  'true once the memory was confirmed used — a memory_get (the strongest '
  'signal) or an op:''feedback'' event:''cited''. Set on the most-recent log '
  'row for the memory by mark_recall_feedback().';

-- (memory_id, created_at desc): the most-recent-row lookup in
-- mark_recall_feedback, the cited/dismissed updates, and per-memory rollup.
create index if not exists memory_recall_log_memory_created_idx
  on public.memory_recall_log (memory_id, created_at desc);

-- created_at: the 90-day purge scan.
create index if not exists memory_recall_log_created_at_idx
  on public.memory_recall_log (created_at);

-- surface: telemetry-by-surface aggregation.
create index if not exists memory_recall_log_surface_idx
  on public.memory_recall_log (surface);

-- ====================================================================
-- 2. Denormalized per-memory counters on memory_items
--    (collision guard: OWNED BY 027 — Sprint 79 must NOT re-add these)
-- ====================================================================

-- recall_count default 0 is a non-volatile default → fast metadata-only add
-- even on a large memory_items (PG11+). last_recalled_at is nullable.
alter table public.memory_items
  add column if not exists recall_count int not null default 0;
alter table public.memory_items
  add column if not exists last_recalled_at timestamptz;

comment on column public.memory_items.recall_count is
  'Sprint 78 (migration 027): running count of times this memory appeared in '
  'a RETURNED recall set. Bumped statement-level (batched, never per-row) by '
  'log_recall_hits(). This is the rollup that survives memory_recall_log '
  'purges. OWNED BY migration 027 — Sprint 79 must not re-add.';
comment on column public.memory_items.last_recalled_at is
  'Sprint 78 (migration 027): timestamp of the most recent recall that '
  'returned this memory. OWNED BY migration 027 — Sprint 79 must not re-add.';

-- ====================================================================
-- 3. RLS + table-grant hygiene
-- ====================================================================

-- [GATE 1] RLS on, in the same migration that creates the table.
alter table public.memory_recall_log enable row level security;

-- [GATE 2] Deliberately NO "create policy" statements: with RLS enabled and
-- zero policies, anon and authenticated are denied every operation;
-- service_role bypasses RLS by design (the recall paths write via the
-- service-role client).

-- [GATE 5 belt-and-suspenders] Strip the table-level grants Supabase's
-- default privileges hand anon/authenticated on new public tables, so even a
-- future accidentally-permissive policy would expose nothing through the anon
-- key. service_role keeps its grant (it bypasses RLS anyway; PostgREST still
-- needs the table privilege).
revoke all on table public.memory_recall_log from public, anon, authenticated;

-- ====================================================================
-- 4. log_recall_hits(jsonb) — the ONLY insert path (+ batched denorm bump)
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
  -- types each element; rows with a NULL memory_id are skipped.
  insert into public.memory_recall_log
    (memory_id, query_hash, query_preview, score, rank, surface,
     source_session_id, source_agent)
  select h.memory_id,
         h.query_hash,
         -- DB-level backstop on top of the TS redactor's <=120 truncation: a
         -- future caller that bypasses redactQueryPreview still cannot store an
         -- unbounded preview. left(NULL,...) is NULL — preview stays nullable.
         left(h.query_preview, 200),
         h.score,
         h.rank,
         coalesce(h.surface, 'recall'),
         h.source_session_id,
         h.source_agent
    from jsonb_to_recordset(p_hits) as h(
      memory_id          uuid,
      query_hash         text,
      query_preview      text,
      score              double precision,
      rank               int,
      surface            text,
      source_session_id  text,
      source_agent       text
    )
   where h.memory_id is not null;

  get diagnostics v_inserted = row_count;

  -- Batched / statement-level denorm bump: ONE UPDATE touching K distinct
  -- rows via a join, NEVER per-row — so a 4-panel boot can't trigger hot-row
  -- lock storms on the most-recalled kitchen rows. Memories that no longer
  -- exist are simply not matched (self-healing — see the no-FK rationale).
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
  'Sprint 78: sole insert path into memory_recall_log. One statement-level '
  'insert of the K returned hits + one batched (never per-row) bump of '
  'memory_items.recall_count / .last_recalled_at. SECURITY DEFINER with '
  'pinned search_path; EXECUTE: service_role only. Called fire-and-forget '
  'from the recall paths — never awaited, so recall latency is unchanged.';

-- [GATE 3]
revoke execute on function public.log_recall_hits(jsonb)
  from public, anon, authenticated;
grant  execute on function public.log_recall_hits(jsonb)
  to service_role;

-- ====================================================================
-- 5. mark_recall_feedback(jsonb, text) — cited / dismissed signal
-- ====================================================================

create or replace function public.mark_recall_feedback(
  p_memory_ids jsonb,
  p_event      text default 'cited'
)
returns int
language plpgsql
security definer
set search_path = public, pg_catalog  -- [GATE 4]
as $$
declare
  v_updated int := 0;
  v_ids     uuid[];
begin
  if p_memory_ids is null
     or jsonb_typeof(p_memory_ids) <> 'array'
     or jsonb_array_length(p_memory_ids) = 0 then
    return 0;
  end if;
  -- Fail-soft on an unknown event (the caller validates; this is a backstop).
  if p_event not in ('cited', 'dismissed') then
    return 0;
  end if;

  v_ids := array(select jsonb_array_elements_text(p_memory_ids)::uuid);

  -- Flip the flag on the MOST-RECENT log row per memory_id. distinct on +
  -- order by created_at desc selects the latest row; the outer UPDATE is ONE
  -- set-based statement (no per-row loop).
  if p_event = 'cited' then
    update public.memory_recall_log l
       set cited = true
      from (
        select distinct on (memory_id) id
          from public.memory_recall_log
         where memory_id = any(v_ids)
         order by memory_id, created_at desc
      ) latest
     where l.id = latest.id;
  else
    update public.memory_recall_log l
       set dismissed = true
      from (
        select distinct on (memory_id) id
          from public.memory_recall_log
         where memory_id = any(v_ids)
         order by memory_id, created_at desc
      ) latest
     where l.id = latest.id;
  end if;

  get diagnostics v_updated = row_count;
  return v_updated;
end;
$$;

comment on function public.mark_recall_feedback(jsonb, text) is
  'Sprint 78: flip cited|dismissed on the most-recent memory_recall_log row '
  'for each memory id. Used by memory_get (batch cited — "actually used") and '
  'the webhook op:''feedback'' receiver. SECURITY DEFINER, pinned search_path; '
  'EXECUTE: service_role only. Fire-and-forget from the callers.';

-- [GATE 3]
revoke execute on function public.mark_recall_feedback(jsonb, text)
  from public, anon, authenticated;
grant  execute on function public.mark_recall_feedback(jsonb, text)
  to service_role;

-- ====================================================================
-- 6. purge_recall_log(int) — age out raw rows past retention
-- ====================================================================

create or replace function public.purge_recall_log(p_retention_days int default 90)
returns int
language plpgsql
security definer
set search_path = public, pg_catalog  -- [GATE 4]
as $$
declare
  v_deleted int := 0;
begin
  -- Rollup-before-delete: the per-memory aggregate (recall_count,
  -- last_recalled_at on memory_items) is maintained at WRITE time by
  -- log_recall_hits, so it survives this purge by construction — deleting raw
  -- rows never loses the counts. This function only ages out the raw per-hit
  -- rows past the retention window.
  delete from public.memory_recall_log
   where created_at < now() - make_interval(days => greatest(p_retention_days, 1));
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

comment on function public.purge_recall_log(int) is
  'Sprint 78: delete memory_recall_log rows older than p_retention_days '
  '(default 90). The per-memory rollup (recall_count/last_recalled_at) is '
  'maintained at write time and survives. SECURITY DEFINER, pinned '
  'search_path; EXECUTE: service_role only. Registered as a daily pg_cron job '
  'below when pg_cron is installed.';

-- [GATE 3]
revoke execute on function public.purge_recall_log(int)
  from public, anon, authenticated;
grant  execute on function public.purge_recall_log(int)
  to service_role;

-- ====================================================================
-- 7. pg_cron purge job — guarded (only if pg_cron is installed) + idempotent
-- ====================================================================

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    -- Idempotent: drop any prior registration before re-scheduling, so a
    -- re-apply doesn't error on a duplicate jobname (older pg_cron) or
    -- silently stack (newer).
    if exists (select 1 from cron.job where jobname = 'mnestra-recall-log-purge') then
      perform cron.unschedule('mnestra-recall-log-purge');
    end if;
    perform cron.schedule(
      'mnestra-recall-log-purge',
      '17 3 * * *',
      $cron$select public.purge_recall_log(90)$cron$
    );
    raise notice '[027] pg_cron purge job registered: mnestra-recall-log-purge (daily 03:17, 90-day retention).';
  else
    raise notice '[027] pg_cron not installed — purge job NOT registered (fail-soft). Enable pg_cron, then run: select cron.schedule(''mnestra-recall-log-purge'', ''17 3 * * *'', $q$select public.purge_recall_log(90)$q$);';
  end if;
end$$;

-- ====================================================================
-- 8. Apply-time receipt — HARD-FAILING. Any gate violation raises, rolling
--    back the whole migration transaction. (Same idiom as migration 026.)
-- ====================================================================

do $$
declare
  v_rls          boolean;
  v_policy_count int;
  v_has_count    boolean;
  v_has_last     boolean;
  v_sig          text;
  v_oid          oid;
  v_anon         boolean;
  v_auth         boolean;
  v_pub          boolean;
  v_svc          boolean;
  v_cfg          text;
  fn_sigs text[] := array[
    'public.log_recall_hits(jsonb)',
    'public.mark_recall_feedback(jsonb,text)',
    'public.purge_recall_log(integer)'
  ];
begin
  select c.relrowsecurity into v_rls
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname = 'memory_recall_log';

  select count(*)::int into v_policy_count
    from pg_policies
   where schemaname = 'public' and tablename = 'memory_recall_log';

  select exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'memory_items'
       and column_name = 'recall_count'
  ) into v_has_count;
  select exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'memory_items'
       and column_name = 'last_recalled_at'
  ) into v_has_last;

  raise notice '[027] memory_recall_log RLS enabled: % (expect t)', v_rls;
  raise notice '[027] memory_recall_log policy count: % (expect 0)', v_policy_count;
  raise notice '[027] memory_items denorm columns — recall_count: %, last_recalled_at: % (expect t t)',
    v_has_count, v_has_last;

  if v_rls is distinct from true then
    raise exception '[027] GATE 1 VIOLATION: RLS not enabled on public.memory_recall_log';
  end if;
  if v_policy_count <> 0 then
    raise exception '[027] GATE 2 VIOLATION: % policies present on public.memory_recall_log (expected none)', v_policy_count;
  end if;
  if not v_has_count or not v_has_last then
    raise exception '[027] DENORM COLUMN MISSING: recall_count=%, last_recalled_at=% (both must exist on memory_items)',
      v_has_count, v_has_last;
  end if;

  foreach v_sig in array fn_sigs loop
    -- Sprint 81 receipt-OID sweep: resolve the OID from the (literal, type-only)
    -- signature and pass the OID to has_function_privilege — the portable form
    -- (migration 029 reference; the text form rejects the name-carrying identity
    -- args some Postgres builds return). Receipt-only; fn_sigs stays the
    -- documented function list.
    v_oid := v_sig::regprocedure;

    v_anon := has_function_privilege('anon',          v_oid, 'EXECUTE');
    v_auth := has_function_privilege('authenticated', v_oid, 'EXECUTE');
    v_pub  := has_function_privilege('public',        v_oid, 'EXECUTE');
    v_svc  := has_function_privilege('service_role',  v_oid, 'EXECUTE');

    select array_to_string(p.proconfig, '; ') into v_cfg
      from pg_proc p
     where p.oid = v_oid;

    raise notice '[027] % EXECUTE — anon:%, authenticated:%, public:% (expect f f f); service_role:% (expect t); proconfig: %',
      v_sig, v_anon, v_auth, v_pub, v_svc, coalesce(v_cfg, '<none>');

    if v_anon or v_auth or v_pub then
      raise exception '[027] GATE 3 VIOLATION: % is executable by anon/authenticated/public (anon=%, authenticated=%, public=%)',
        v_sig, v_anon, v_auth, v_pub;
    end if;
    if not v_svc then
      raise exception '[027] GATE 3 VIOLATION: service_role lost EXECUTE on %', v_sig;
    end if;
    if v_cfg is null or v_cfg not like '%search_path=public, pg_catalog%' then
      raise exception '[027] GATE 4 VIOLATION: % search_path not pinned (proconfig: %)', v_sig, coalesce(v_cfg, '<none>');
    end if;
  end loop;

  raise notice '[027] receipt: five gates verified on memory_recall_log + 3 RPCs (gate 5 = no INSERT/UPDATE path besides the service-role RPCs: zero table grants for anon/authenticated [revoked above], zero policies [gate 2]).';
end$$;

-- ====================================================================
-- 9a. Post-apply verification (ORCH, Studio SQL editor — commented so the
--     migration runner doesn't choke on result sets):
--
--   -- Table + RLS + zero policies
--   select c.relname, c.relrowsecurity
--     from pg_class c join pg_namespace n on n.oid = c.relnamespace
--    where n.nspname='public' and c.relname='memory_recall_log';     -- expect t
--   select count(*) from pg_policies
--    where schemaname='public' and tablename='memory_recall_log';    -- expect 0
--
--   -- Table grants: anon/authenticated must hold NOTHING
--   select grantee, privilege_type from information_schema.role_table_grants
--    where table_schema='public' and table_name='memory_recall_log'
--      and grantee in ('anon','authenticated');                      -- expect 0 rows
--
--   -- RPC privileges (all three)
--   select f as fn,
--          has_function_privilege('anon', f, 'EXECUTE')          as anon_exec,          -- f
--          has_function_privilege('authenticated', f, 'EXECUTE') as authenticated_exec, -- f
--          has_function_privilege('public', f, 'EXECUTE')        as public_exec,        -- f
--          has_function_privilege('service_role', f, 'EXECUTE')  as service_role_exec   -- t
--     from unnest(array['public.log_recall_hits(jsonb)',
--                       'public.mark_recall_feedback(jsonb,text)',
--                       'public.purge_recall_log(integer)']) as f;
--
--   -- Denorm columns present
--   select column_name from information_schema.columns
--    where table_schema='public' and table_name='memory_items'
--      and column_name in ('recall_count','last_recalled_at');       -- expect 2 rows
--
--   -- pg_cron job registered (if pg_cron installed)
--   select jobname, schedule, command from cron.job
--    where jobname='mnestra-recall-log-purge';                       -- expect 1 row
--
--   -- Round trip (service_role): K returned hits -> K rows; counter bumped
--   select public.log_recall_hits(
--     jsonb_build_array(
--       jsonb_build_object('memory_id', (select id from public.memory_items limit 1),
--                          'query_hash','smoke','query_preview','smoke probe',
--                          'score',0.9,'rank',1,'surface','recall')
--     ));                                                             -- expect 1
--   select recall_count, last_recalled_at from public.memory_items
--    where id=(select id from public.memory_items limit 1);          -- recall_count>=1
--   delete from public.memory_recall_log where query_hash='smoke';   -- clean up
--
--   -- Supabase advisors must show ZERO new 0011 (mutable search_path) /
--   -- 0013 (RLS disabled) lints attributable to migration 027:
--   --   mcp__supabase__get_advisors(type='security')
--
-- 9b. Reversal (commented — apply by hand to roll back):
--
--   do $$ begin
--     if exists (select 1 from pg_extension where extname='pg_cron')
--        and exists (select 1 from cron.job where jobname='mnestra-recall-log-purge')
--     then perform cron.unschedule('mnestra-recall-log-purge'); end if;
--   end $$;
--   drop function if exists public.purge_recall_log(int);
--   drop function if exists public.mark_recall_feedback(jsonb, text);
--   drop function if exists public.log_recall_hits(jsonb);
--   drop table if exists public.memory_recall_log;
--   alter table public.memory_items drop column if exists last_recalled_at;
--   alter table public.memory_items drop column if exists recall_count;
-- ====================================================================

-- migrations/036_memory_inbox_hygiene.sql
-- Sprint 84 T3 (TermDeck) — memory_inbox hygiene: retention purge + drain alarm.
--
-- Migration 026 built the quarantine table and its trust boundary. Nothing
-- since has answered the two operational questions that follow from having a
-- queue at all:
--
--   1. RETENTION — a settled proposal (promoted or rejected) is an audit
--      record, and audit records are not kept forever. `purge_memory_inbox`
--      ages them out at 90 days on a daily pg_cron job, exactly the shape
--      migration 027 §6/§7 established for `purge_recall_log`.
--
--   2. LIVENESS — a quarantine queue whose drain has died looks identical, at
--      the table, to a quarantine queue with nothing to do. Both are "rows sit
--      there." `memory_inbox_health` makes the difference legible: pending
--      rows that have aged past the alarm threshold mean the promoter is not
--      running, and that is the single most consequential silent failure this
--      subsystem has (proposals accumulate, nothing is recallable, and no
--      error is ever raised anywhere).
--
-- ── WHY THE ALARM IS A VIEW AND NOT A LINE IN SOME JOB'S REPORT ─────────
--
-- The condition being detected is "the drain is dead." Any surface computed
-- BY the drain is silent in precisely the case it exists to catch: a promoter
-- that never runs never reports that it never ran. A view is evaluated at read
-- time by whoever asks, so it is still correct — and still says the alarming
-- thing — when every promoter invocation since the last one has failed.
--
-- It is also the cheapest surface anyone will actually read: one
-- `select * from public.memory_inbox_health` works from an orchestrator's SQL
-- tool, from psql, and from a monitor loop, with nothing deployed.
--
-- ── WHY PENDING ROWS ARE NEVER PURGED ───────────────────────────────────
--
-- `status <> 'pending'` is the whole selection predicate. A pending row is
-- undrained work; deleting it destroys a proposal nobody ever adjudicated, and
-- it would do so most aggressively in exactly the scenario the alarm above
-- describes — a broken drain, where pending rows are BOTH the oldest rows in
-- the table and the evidence of the outage. The two halves of this migration
-- are therefore load-bearing on each other: the purge is only safe to schedule
-- because it structurally cannot touch the rows the alarm counts.
--
-- The live status vocabulary is `pending | promoted | rejected` (026's CHECK).
-- There is no `accepted` or `expired`; `status <> 'pending'` is the exact
-- expression of "settled rows only." Note also that the promotion pass's claim
-- lease lives in `metadata.rumen` and leaves `status = 'pending'` — so a row
-- claimed by an in-flight promoter run is likewise unpurgeable, by
-- construction rather than by a second predicate that could drift.
--
-- ── FIVE RLS/PRIVILEGE GATES (global CLAUDE.md § Supabase RLS) ──────────
--   GATE 1  RLS: no new table; memory_inbox's RLS (026) is re-verified below.
--   GATE 2  No policies created here (026's zero-policy posture is preserved
--           and re-verified).
--   GATE 3  REVOKE EXECUTE ... FROM public, anon, authenticated on the new
--           function + targeted GRANT to service_role only.
--   GATE 4  SET search_path = public, pg_catalog on the new function.
--   GATE 5  No raw anon-key path: the view is security_invoker (so it runs
--           under the caller's own RLS, not the definer's) and its SELECT
--           grant goes to service_role alone.
--
-- Idempotent / rerun-safe: CREATE OR REPLACE FUNCTION/VIEW; REVOKE/GRANT are
-- naturally idempotent; the cron registration unschedules before scheduling;
-- COMMENTs are last-write-wins; the receipt block only SELECTs (and raises).
--
-- APPLY: written + tested locally only. Nobody applies this to the
-- daily-driver from a lane — ORCH applies at sprint close, then runs the
-- commented post-apply verification at the bottom.

-- ====================================================================
-- 1. purge_memory_inbox(int) — age out SETTLED proposals past retention
-- ====================================================================

create or replace function public.purge_memory_inbox(p_retention_days int default 90)
returns int
language plpgsql
security definer
set search_path = public, pg_catalog  -- [GATE 4]
as $$
declare
  v_deleted int := 0;
begin
  -- status <> 'pending' is the safety property, not an optimization: see the
  -- header. `greatest(p_retention_days, 1)` mirrors purge_recall_log — a 0 or
  -- negative retention must not degenerate into "delete everything settled."
  delete from public.memory_inbox
   where status <> 'pending'
     and created_at < now() - make_interval(days => greatest(p_retention_days, 1));
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

comment on function public.purge_memory_inbox(int) is
  'Sprint 84: delete SETTLED memory_inbox rows (status promoted|rejected) '
  'older than p_retention_days (default 90). Pending rows — including rows '
  'held under an in-flight promoter claim lease, which stay pending — are '
  'never deleted at any retention value. The canonical memory created at '
  'promotion lives in memory_items and is untouched; only the inbox audit '
  'record ages out. SECURITY DEFINER, pinned search_path; EXECUTE: '
  'service_role only. Registered as a daily pg_cron job below.';

-- [GATE 3]
revoke execute on function public.purge_memory_inbox(int)
  from public, anon, authenticated;
grant  execute on function public.purge_memory_inbox(int)
  to service_role;

-- ====================================================================
-- 2. memory_inbox_health — the drain-liveness surface
--    security_invoker=true: runs under the QUERYING role's own RLS on
--    memory_inbox, not the view definer's (Supabase advisor lint 0010).
--    Precedent: mnestra_capture_health (migration 028 §6).
-- ====================================================================

create or replace view public.memory_inbox_health
with (security_invoker = true) as
with agg as (
  select
    count(*) filter (where status = 'pending')                     as pending_count,
    min(created_at) filter (where status = 'pending')              as oldest_pending_at,
    count(*) filter (where status = 'promoted')                    as promoted_total,
    count(*) filter (where status = 'rejected')                    as rejected_total,
    count(*) filter (where status = 'promoted'
                       and created_at > now() - interval '24 hours') as promoted_24h,
    count(*) filter (where status = 'rejected'
                       and created_at > now() - interval '24 hours') as rejected_24h,
    count(*) filter (where created_at > now() - interval '24 hours') as arrived_24h
  from public.memory_inbox
)
select
  pending_count,
  oldest_pending_at,
  -- Raw age is exposed alongside the boolean so a consumer with a different
  -- tolerance can apply its own threshold without re-deriving the query.
  round(
    extract(epoch from (now() - oldest_pending_at)) / 3600.0
  )::int                                                            as oldest_pending_age_hours,
  arrived_24h,
  promoted_24h,
  rejected_24h,
  promoted_total,
  rejected_total,
  7                                                                 as alarm_threshold_days,
  -- An empty queue is healthy, not alarming: `oldest_pending_at` is NULL
  -- there and the comparison is false, which is the intended reading.
  (oldest_pending_at is not null
     and oldest_pending_at < now() - interval '7 days')             as alarm,
  case
    when pending_count = 0 then 'ok: no pending proposals'
    when oldest_pending_at < now() - interval '7 days' then
      'ALARM: oldest pending proposal is ' ||
      round(extract(epoch from (now() - oldest_pending_at)) / 86400.0)::int ||
      'd old (>7d) across ' || pending_count ||
      ' pending row(s) — the promotion drain is not running. Check: '
      'select jobname, schedule, active from cron.job where jobname like ''%inbox-promote%'';'
    else
      'ok: ' || pending_count || ' pending, oldest ' ||
      round(extract(epoch from (now() - oldest_pending_at)) / 3600.0)::int || 'h'
  end                                                               as alarm_reason
from agg;

comment on view public.memory_inbox_health is
  'Sprint 84 T3: memory_inbox drain liveness + throughput. One row. '
  'alarm=true means the oldest PENDING proposal has aged past 7 days, which '
  'means the inbox-promote drain is not running — the subsystem''s one '
  'silent failure (proposals accumulate, nothing becomes recallable, no '
  'error is raised anywhere). Deliberately a VIEW rather than a field in a '
  'job''s report: a surface computed by the drain is silent in exactly the '
  'case it exists to detect. security_invoker=true (runs under the caller''s '
  'own memory_inbox RLS, not the view definer''s).';

-- Explicit grant hygiene (028 §6 / 019 mnestra_recent_activity precedent):
-- security_invoker controls whose RLS the view runs under, not who may SELECT
-- the view itself. This store has no default ACL granting anything on new
-- public-schema relations, so without the targeted grant not even service_role
-- could read it. [GATE 5]
revoke all    on public.memory_inbox_health from public, anon, authenticated;
grant  select on public.memory_inbox_health to service_role;

-- ====================================================================
-- 3. pg_cron purge job — guarded (only if pg_cron is installed) + idempotent
--
--    04:20 UTC. The 03:00–04:00 band is fully owned (graph-inference 03:00,
--    recall-log-purge 03:17, doctrine-scan 03:30, rumen-reinforce 03:45) and
--    04:00 belongs to graph-consolidation, so this sits clear of both.
-- ====================================================================

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    -- Idempotent: drop any prior registration before re-scheduling, so a
    -- re-apply doesn't error on a duplicate jobname (older pg_cron) or
    -- silently stack (newer).
    if exists (select 1 from cron.job where jobname = 'mnestra-inbox-purge') then
      perform cron.unschedule('mnestra-inbox-purge');
    end if;
    perform cron.schedule(
      'mnestra-inbox-purge',
      '20 4 * * *',
      $cron$select public.purge_memory_inbox(90)$cron$
    );
    raise notice '[036] pg_cron purge job registered: mnestra-inbox-purge (daily 04:20 UTC, 90-day retention, settled rows only).';
  else
    raise notice '[036] pg_cron not installed — purge job NOT registered (fail-soft). Enable pg_cron, then run: select cron.schedule(''mnestra-inbox-purge'', ''20 4 * * *'', $q$select public.purge_memory_inbox(90)$q$);';
  end if;
end$$;

-- ====================================================================
-- 4. Apply-time receipt — HARD-FAILING. Any gate violation raises, rolling
--    back the whole migration transaction. (Same idiom as 026/027/028.)
-- ====================================================================

do $$
declare
  v_rls           boolean;
  v_policy_count  int;
  v_view_invoker  boolean;
  v_oid           oid;
  v_anon          boolean;
  v_auth          boolean;
  v_pub           boolean;
  v_svc           boolean;
  v_cfg           text;
  v_view_anon     boolean;
  v_view_auth     boolean;
  v_view_svc      boolean;
  v_sig  constant text := 'public.purge_memory_inbox(integer)';
begin
  -- Prerequisite: 026 must have run. Without memory_inbox everything below is
  -- meaningless, and a clear message beats a cascade of "relation not found".
  if to_regclass('public.memory_inbox') is null then
    raise exception '[036] PREREQUISITE MISSING: public.memory_inbox does not exist — apply migration 026 first';
  end if;

  -- [GATE 1] / [GATE 2] — 026's posture must still hold. This migration does
  -- not change it; the receipt exists so a drift introduced elsewhere cannot
  -- ride in unnoticed under a hygiene migration's name.
  select c.relrowsecurity into v_rls
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname = 'memory_inbox';

  select count(*)::int into v_policy_count
    from pg_policies
   where schemaname = 'public' and tablename = 'memory_inbox';

  raise notice '[036] memory_inbox RLS enabled: % (expect t); policy count: % (expect 0)',
    v_rls, v_policy_count;

  if v_rls is distinct from true then
    raise exception '[036] GATE 1 VIOLATION: RLS not enabled on public.memory_inbox';
  end if;
  if v_policy_count <> 0 then
    raise exception '[036] GATE 2 VIOLATION: % policies present on public.memory_inbox (expected none)', v_policy_count;
  end if;

  -- [GATE 3] / [GATE 4] on the purge function. OID form of
  -- has_function_privilege (027's Sprint-81 receipt-OID sweep): the text form
  -- rejects the name-carrying identity args some Postgres builds return.
  v_oid := v_sig::regprocedure;
  v_anon := has_function_privilege('anon',          v_oid, 'EXECUTE');
  v_auth := has_function_privilege('authenticated', v_oid, 'EXECUTE');
  v_pub  := has_function_privilege('public',        v_oid, 'EXECUTE');
  v_svc  := has_function_privilege('service_role',  v_oid, 'EXECUTE');

  select array_to_string(p.proconfig, '; ') into v_cfg
    from pg_proc p where p.oid = v_oid;

  raise notice '[036] % EXECUTE — anon:%, authenticated:%, public:% (expect f f f); service_role:% (expect t); proconfig: %',
    v_sig, v_anon, v_auth, v_pub, v_svc, coalesce(v_cfg, '<none>');

  if v_anon or v_auth or v_pub then
    raise exception '[036] GATE 3 VIOLATION: % is executable by anon/authenticated/public (anon=%, authenticated=%, public=%)',
      v_sig, v_anon, v_auth, v_pub;
  end if;
  if not v_svc then
    raise exception '[036] GATE 3 VIOLATION: service_role lost EXECUTE on %', v_sig;
  end if;
  if v_cfg is null or v_cfg not like '%search_path=public, pg_catalog%' then
    raise exception '[036] GATE 4 VIOLATION: % search_path not pinned (proconfig: %)', v_sig, coalesce(v_cfg, '<none>');
  end if;

  -- [GATE 5] the view must be security_invoker AND must not be readable by
  -- anon/authenticated. Either half alone is insufficient: invoker-without-
  -- grant-hygiene still hands anon a relation to probe, and grant-hygiene-
  -- without-invoker is the definer view the advisor flags.
  select coalesce(
           (select 'security_invoker=true' = any(c.reloptions)
              from pg_class c
              join pg_namespace n on n.oid = c.relnamespace
             where n.nspname = 'public' and c.relname = 'memory_inbox_health'),
           false)
    into v_view_invoker;

  v_view_anon := has_table_privilege('anon',          'public.memory_inbox_health', 'SELECT');
  v_view_auth := has_table_privilege('authenticated', 'public.memory_inbox_health', 'SELECT');
  v_view_svc  := has_table_privilege('service_role',  'public.memory_inbox_health', 'SELECT');

  raise notice '[036] memory_inbox_health security_invoker=true: % (expect t); SELECT — anon:%, authenticated:% (expect f f); service_role:% (expect t)',
    v_view_invoker, v_view_anon, v_view_auth, v_view_svc;

  if not v_view_invoker then
    raise exception '[036] VIEW GATE VIOLATION: memory_inbox_health is missing security_invoker=true';
  end if;
  if v_view_anon or v_view_auth then
    raise exception '[036] GATE 5 VIOLATION: memory_inbox_health is SELECTable by anon/authenticated (anon=%, authenticated=%)',
      v_view_anon, v_view_auth;
  end if;
  if not v_view_svc then
    raise exception '[036] GATE 5 VIOLATION: service_role cannot SELECT memory_inbox_health';
  end if;

  raise notice '[036] receipt: purge_memory_inbox five-gate clean (settled-rows-only predicate; pending never deleted), memory_inbox_health invoker+grant clean, memory_inbox RLS/zero-policy posture from 026 unchanged.';
end$$;

-- ====================================================================
-- 5. Post-apply verification (ORCH, Studio SQL editor — commented so the
--    migration runner doesn't choke on result sets):
--
--   -- Function privileges
--   select has_function_privilege('anon',          'public.purge_memory_inbox(integer)', 'EXECUTE'),  -- f
--          has_function_privilege('authenticated', 'public.purge_memory_inbox(integer)', 'EXECUTE'),  -- f
--          has_function_privilege('public',        'public.purge_memory_inbox(integer)', 'EXECUTE'),  -- f
--          has_function_privilege('service_role',  'public.purge_memory_inbox(integer)', 'EXECUTE');  -- t
--
--   -- The alarm surface
--   select * from public.memory_inbox_health;
--   --   expect one row; alarm=false on a live install with a running drain
--
--   -- The cron job
--   select jobname, schedule, active from cron.job
--    where jobname = 'mnestra-inbox-purge';                    -- expect 1 row, 20 4 * * *, t
--
--   -- Purge is a no-op on a young inbox (safe to invoke by hand)
--   select public.purge_memory_inbox(90);                      -- expect 0 on a fresh store
--
--   -- Pending-safety spot check: must be 0 at every retention value
--   select count(*) from public.memory_inbox
--    where status = 'pending' and created_at < now() - interval '90 days';
--
-- ROLLBACK (if ever needed):
--   do $$ begin
--     if exists (select 1 from pg_extension where extname='pg_cron')
--        and exists (select 1 from cron.job where jobname='mnestra-inbox-purge')
--     then perform cron.unschedule('mnestra-inbox-purge'); end if;
--   end $$;
--   drop view     if exists public.memory_inbox_health;
--   drop function if exists public.purge_memory_inbox(int);
-- ====================================================================

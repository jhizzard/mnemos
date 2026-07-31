-- migrations/035_memory_session_record.sql
-- Sprint 84 T2 (Write-Side Completion) — end-of-conversation session capture
-- for web surfaces.
--
-- WHAT THIS IS. A CLI panel that closes writes a `memory_sessions` row via the
-- bundled SessionEnd hook; the Rumen tick then sweeps unprocessed rows and
-- synthesizes insights from them. A web chat (claude.ai / ChatGPT / Grok /
-- Gemini) has no panel and no hook, so its conversations have never reached
-- that loop at all. This migration is the substrate for the web equivalent:
--
--   1. public.memory_sessions gains `metadata` + `source_agent` (see § 1).
--   2. public.memory_session_record(...) — a validating SECURITY DEFINER RPC,
--      the ONLY web-reachable insert path into memory_sessions. service_role
--      is the sole grantee; the MCP bridge reaches it through the webhook
--      server's service-role client, never with a raw anon key.
--
-- WHY THIS IS NOT A HOLE IN THE SPRINT-76 QUARANTINE DOCTRINE. "CLIs write
-- canonical; web chats write proposals" (migration 026) governs memory_items,
-- which recall reads directly. memory_sessions is not read by any recall path
-- — it is an input queue for the Rumen tick, whose extract → relate →
-- synthesize pass is itself a gate: nothing a web surface records here becomes
-- recallable without passing through that synthesis. A session record is
-- therefore quarantine-equivalent, not a canonical write. What it DOES buy an
-- attacker is influence over synthesis inputs, which is why the validation
-- below is as strict as memory_propose's, and why § 3's two upsert guards
-- exist.
--
-- THE TWO GUARDS (the load-bearing part of this file):
--   a. `session_id` is MINTED SERVER-SIDE as 'web:<source_agent>:<key>'. It is
--      never caller-supplied. A CLI/hook-written row's session_id is a bare
--      Claude Code session UUID, so a web caller cannot construct a session_id
--      that addresses one. Without this, `on conflict (session_id) do update`
--      would be an arbitrary-session-summary-overwrite primitive reachable
--      from a web chat.
--   b. The `do update` fires only where the EXISTING row's source_agent equals
--      the caller's AND its rumen_processed_at is still NULL. So a caller may
--      amend its own not-yet-swept record, may never touch another agent's
--      row, and may never re-arm an already-consumed row for a second
--      synthesis pass. rumen_processed_at is never written here.
--
-- Five RLS hygiene gates (global CLAUDE.md § "Supabase RLS + privilege
-- hygiene"), each marked [GATE n] inline and each verified by the
-- HARD-FAILING receipt in § 4 — same posture as migration 026:
--   GATE 1  RLS enabled on memory_sessions (already true on every install
--           that ran 019; asserted and idempotently re-applied here).
--   GATE 2  No PUBLIC/permissive policy on memory_sessions — the only policy
--           is the service_role one; anon/authenticated match nothing and are
--           denied by RLS.
--   GATE 3  REVOKE EXECUTE ... FROM PUBLIC, anon, authenticated on the new
--           RPC + targeted GRANT to service_role. NOT optional here:
--           migration 014 set `alter default privileges in schema public grant
--           execute on functions to service_role, authenticated, anon`, so a
--           freshly-created function is born anon-callable on any install that
--           ran 014. The revoke is what closes it.
--   GATE 4  SET search_path = public, pg_catalog on the function.
--   GATE 5  No raw anon-key write path: the RPC is the only web-reachable
--           INSERT, and the residual anon/authenticated TABLE grants on
--           memory_sessions (Supabase auto-grant residue) are revoked.
--
-- NON-SUPERUSER APPLY (Sprint 83 lesson — the discriminator is the ROLE, not
-- the PG version). Every privileged statement in this file is either (a)
-- guarded so it is skipped when already in the desired state, or (b) wrapped
-- so an insufficient_privilege error names the role and the exact statement
-- rather than dying anonymously. Supabase's `postgres` is NOT a superuser but
-- IS the table owner, which is sufficient for all of them.

-- ====================================================================
-- 1. memory_sessions — provenance + metadata columns
--
--    `metadata` is a RECONCILIATION, not a new idea: migration 001 declares
--    memory_sessions with `metadata jsonb not null default '{}'::jsonb`, but
--    installs whose memory_sessions came from the rag-system flavor (the
--    reference Mnestra project among them) never had it — migration 017
--    reconciled the two shapes in the other direction only (rag-system columns
--    onto canonical) and left this one behind. Result before this migration:
--    code written against canonical memory_sessions.metadata passes tests on a
--    fresh install and raises 42703 on a rag-system-shaped one. ADD COLUMN IF
--    NOT EXISTS makes both shapes converge.
--
--    `source_agent` is new to this table (memory_items has carried it since
--    migration 015). NULL means "written by a CLI/hook writer" — which is
--    every pre-existing row, and stays true for the SessionEnd hook, which
--    does not populate it. Non-NULL means a *-web surface recorded it. No
--    CHECK constraint, matching migration 025's fail-soft doctrine: taxonomy
--    enforcement is write-side (this RPC's whitelist) and read-side, never a
--    constraint that could cost a writer its capture on taxonomy skew.
-- ====================================================================

alter table public.memory_sessions
  add column if not exists metadata     jsonb not null default '{}'::jsonb,
  add column if not exists source_agent text;

comment on column public.memory_sessions.metadata is
  'Free-form session metadata. Declared by migration 001 but absent on installs whose memory_sessions came from the rag-system flavor; migration 035 reconciles the two shapes. For web-recorded sessions this carries the bridge provenance stamp (connector client_id / client_name).';

comment on column public.memory_sessions.source_agent is
  'Agent that recorded this session. NULL = CLI/hook-written (every pre-035 row, and every row the bundled SessionEnd hook writes). Non-NULL = a web surface recorded it via public.memory_session_record, whitelisted to claude-web|chatgpt-web|grok-web|gemini-web. No CHECK constraint by design (migration 025 doctrine): enforcement is the RPC whitelist, not a constraint that could cost a fail-soft writer its capture.';

-- Partial index — mirrors idx_memory_items_source_agent (migration 015). Only
-- web-recorded rows are indexed; the CLI-written majority stays out of it.
create index if not exists memory_sessions_source_agent_idx
  on public.memory_sessions (source_agent)
  where source_agent is not null;

-- The RPC's `on conflict (session_id)` needs a unique index on that column.
-- Migration 017 creates it (under either its canonical name or a pre-existing
-- one). Fail LOUDLY here rather than at first RPC call if it is missing.
do $$
declare
  v_has_unique boolean;
begin
  select exists (
    select 1
      from pg_constraint c
      join pg_class t on t.oid = c.conrelid
      join pg_namespace n on n.oid = t.relnamespace
     where n.nspname = 'public'
       and t.relname = 'memory_sessions'
       and c.contype = 'u'
       and (
         select array_agg(att.attname order by att.attnum)
           from unnest(c.conkey) as colnum
           join pg_attribute att on att.attrelid = c.conrelid and att.attnum = colnum
       ) = ARRAY['session_id']::name[]
  ) into v_has_unique;

  if not v_has_unique then
    raise exception '[035] no unique constraint on memory_sessions(session_id) — migration 017 must be applied before 035 (memory_session_record upserts on that key)';
  end if;
end$$;

-- [GATE 1] RLS on memory_sessions. Already enabled everywhere migration 019
-- ran; the guard keeps this appliable by a non-owner role in the (already
-- correct) common case instead of failing on a redundant ALTER.
do $$
declare
  v_rls boolean;
begin
  select c.relrowsecurity into v_rls
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname = 'memory_sessions';
  if v_rls is distinct from true then
    execute 'alter table public.memory_sessions enable row level security';
    raise notice '[035] enabled RLS on public.memory_sessions (was off)';
  end if;
end$$;

-- [GATE 5] Revoke the residual anon/authenticated TABLE grants. These are
-- Supabase auto-grant residue, not a deliberate decision: migration 014 grants
-- tables to service_role ONLY. Revoking cannot break a working path — RLS is
-- enabled with a service_role-only policy, so anon/authenticated already match
-- no policy and are denied regardless of the grant. This removes the
-- belt-and-suspenders gap the global RLS doctrine calls out.
do $$
begin
  revoke all on table public.memory_sessions from anon, authenticated;
exception
  when insufficient_privilege then
    raise exception '[035] GATE 5: role % lacks privilege to REVOKE on public.memory_sessions; apply as the table owner (Supabase: postgres)', current_user;
end$$;

-- ====================================================================
-- 2. public.memory_session_record(...) — the validating RPC
--
--    Rejections raise with the stable, machine-matchable prefix
--    "MEMORY_SESSION_RECORD_REJECTED: <reason_code>", mirroring migration
--    026's MEMORY_PROPOSE_REJECTED. The TS mirror (src/session_record.ts)
--    pre-empts most of them for a fast client error; THIS is the
--    authoritative gate. Reason codes:
--      invalid_source_agent | empty_conversation_key |
--      conversation_key_too_long | invalid_conversation_key | empty_summary |
--      summary_too_long | project_too_long | negative_messages_count |
--      topics_not_array | topics_too_large | metadata_not_object |
--      metadata_too_large | started_after_ended | ended_at_in_future |
--      session_locked
-- ====================================================================

create or replace function public.memory_session_record(
  p_source_agent     text,
  p_conversation_key text,
  p_summary          text,
  p_project          text        default null,
  p_messages_count   int         default null,
  p_started_at       timestamptz default null,
  p_ended_at         timestamptz default null,
  p_topics           jsonb       default '[]'::jsonb,
  p_metadata         jsonb       default '{}'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_catalog  -- [GATE 4]
as $$
declare
  v_agent      text;
  v_key        text;
  v_summary    text;
  v_project    text;
  v_msgs       int;
  v_started    timestamptz;
  v_ended      timestamptz;
  v_topics     jsonb;
  v_meta       jsonb;
  v_session_id text;
  v_duration   int;
  v_id         uuid;
begin
  -- Whitelist: EXACTLY the four *-web values, after trim+lower normalization
  -- (mirrors memory_propose). CLI values (claude/codex/gemini/grok/
  -- orchestrator) are rejected — a web surface may never record a session
  -- under a CLI trust domain. Echoed input truncated to 80 chars so a hostile
  -- caller cannot bloat logs through the error path.
  v_agent := lower(regexp_replace(coalesce(p_source_agent, ''), '^\s+|\s+$', '', 'g'));
  if v_agent not in ('claude-web', 'chatgpt-web', 'grok-web', 'gemini-web') then
    raise exception 'MEMORY_SESSION_RECORD_REJECTED: invalid_source_agent (must be claude-web|chatgpt-web|grok-web|gemini-web; got %)',
      left(coalesce(p_source_agent, '<null>'), 80);
  end if;

  -- conversation_key: the web surface's own conversation identifier. It is the
  -- ONLY caller-controlled component of session_id, so it is charset-bounded —
  -- not for injection reasons (this is a parameterized insert) but so a
  -- session_id stays a legible, greppable operator-facing key.
  v_key := regexp_replace(coalesce(p_conversation_key, ''), '^\s+|\s+$', '', 'g');
  if v_key = '' then
    raise exception 'MEMORY_SESSION_RECORD_REJECTED: empty_conversation_key';
  end if;
  if length(v_key) > 200 then
    raise exception 'MEMORY_SESSION_RECORD_REJECTED: conversation_key_too_long (% chars; max 200)', length(v_key);
  end if;
  if v_key !~ '^[A-Za-z0-9._:@-]+$' then
    raise exception 'MEMORY_SESSION_RECORD_REJECTED: invalid_conversation_key (allowed: A-Z a-z 0-9 . _ - : @)';
  end if;

  -- summary: the payload. 8000 chars — twice memory_propose's 4000, because a
  -- proposal is one fact and a session summary is a whole conversation.
  v_summary := regexp_replace(coalesce(p_summary, ''), '^\s+|\s+$', '', 'g');
  if v_summary = '' then
    raise exception 'MEMORY_SESSION_RECORD_REJECTED: empty_summary';
  end if;
  if length(v_summary) > 8000 then
    raise exception 'MEMORY_SESSION_RECORD_REJECTED: summary_too_long (% chars; max 8000)', length(v_summary);
  end if;

  -- project: advisory tag; empty collapses to the table default 'global'.
  v_project := nullif(regexp_replace(coalesce(p_project, ''), '^\s+|\s+$', '', 'g'), '');
  if length(v_project) > 128 then
    raise exception 'MEMORY_SESSION_RECORD_REJECTED: project_too_long (% chars; max 128)', length(v_project);
  end if;
  v_project := coalesce(v_project, 'global');

  -- messages_count: the Rumen picker's floor filter reads this
  -- (COALESCE(messages_count,0) >= minEventCount, default 3). It is recorded
  -- as given and NEVER inflated here — a short conversation simply is not
  -- swept, and the caller is told so by the bridge tool rather than having its
  -- count silently rewritten.
  v_msgs := coalesce(p_messages_count, 0);
  if v_msgs < 0 then
    raise exception 'MEMORY_SESSION_RECORD_REJECTED: negative_messages_count (got %)', v_msgs;
  end if;

  v_topics := coalesce(p_topics, '[]'::jsonb);
  if jsonb_typeof(v_topics) <> 'array' then
    raise exception 'MEMORY_SESSION_RECORD_REJECTED: topics_not_array (got %)', jsonb_typeof(v_topics);
  end if;
  if pg_column_size(v_topics) > 4096 then
    raise exception 'MEMORY_SESSION_RECORD_REJECTED: topics_too_large (% bytes; max 4096)', pg_column_size(v_topics);
  end if;

  v_meta := coalesce(p_metadata, '{}'::jsonb);
  if jsonb_typeof(v_meta) <> 'object' then
    raise exception 'MEMORY_SESSION_RECORD_REJECTED: metadata_not_object (got %)', jsonb_typeof(v_meta);
  end if;
  if pg_column_size(v_meta) > 8192 then
    raise exception 'MEMORY_SESSION_RECORD_REJECTED: metadata_too_large (% bytes; max 8192)', pg_column_size(v_meta);
  end if;

  -- ended_at drives BOTH of the Rumen picker's time predicates
  -- (`ended_at IS NOT NULL` and `ended_at >= now() - lookback`), so it is
  -- never left NULL. A future-dated ended_at would hold the row inside the
  -- lookback window indefinitely, so it is bounded — generously, to absorb
  -- client clock skew, not to be clever.
  v_ended := coalesce(p_ended_at, now());
  if v_ended > now() + interval '24 hours' then
    raise exception 'MEMORY_SESSION_RECORD_REJECTED: ended_at_in_future (% is more than 24h ahead of server time)', v_ended;
  end if;

  v_started := p_started_at;
  if v_started is not null and v_started > v_ended then
    raise exception 'MEMORY_SESSION_RECORD_REJECTED: started_after_ended (started_at % is after ended_at %)', v_started, v_ended;
  end if;
  v_duration := case
    when v_started is null then null
    else greatest(0, floor(extract(epoch from (v_ended - v_started)) / 60)::int)
  end;

  -- GUARD (a): session_id is minted here, never taken from the caller. See the
  -- header — this is what makes the upsert safe.
  v_session_id := 'web:' || v_agent || ':' || v_key;

  -- GUARD (b): the do-update is narrowed to rows this agent owns and that
  -- Rumen has not yet consumed. rumen_processed_at, facts_extracted,
  -- summary_embedding, transcript_path and files_changed are deliberately
  -- absent from the SET list: none of them is a web surface's to write.
  insert into public.memory_sessions as ms (
    session_id, summary, project, source_agent, metadata,
    started_at, ended_at, duration_minutes, messages_count, topics
  ) values (
    v_session_id, v_summary, v_project, v_agent, v_meta,
    v_started, v_ended, v_duration, v_msgs, v_topics
  )
  on conflict (session_id) do update
    set summary          = excluded.summary,
        project          = excluded.project,
        metadata         = excluded.metadata,
        started_at       = excluded.started_at,
        ended_at         = excluded.ended_at,
        duration_minutes = excluded.duration_minutes,
        messages_count   = excluded.messages_count,
        topics           = excluded.topics
    where ms.source_agent = v_agent
      and ms.rumen_processed_at is null
  returning ms.id into v_id;

  -- RETURNING yields nothing when the conflict target existed but the update
  -- guard suppressed it. Both sub-cases are refusals, and the message names
  -- neither the row's contents nor its other columns.
  if v_id is null then
    raise exception 'MEMORY_SESSION_RECORD_REJECTED: session_locked (a record already exists for this conversation key and is not amendable — it has already been processed by the learning pass, or it belongs to a different source agent)';
  end if;

  return v_id;
end;
$$;

comment on function public.memory_session_record(text, text, text, text, int, timestamptz, timestamptz, jsonb, jsonb) is
  'Sprint 84: sole web-reachable insert path into memory_sessions (end-of-conversation capture for claude.ai/ChatGPT/Grok/Gemini). Validates the *-web whitelist and size caps, MINTS session_id as web:<agent>:<key> (never caller-supplied), and upserts only onto rows of the same source_agent whose rumen_processed_at is still NULL. Never writes rumen_processed_at. SECURITY DEFINER with pinned search_path; EXECUTE: service_role only. Rejections raise with the stable prefix MEMORY_SESSION_RECORD_REJECTED: <reason>.';

-- [GATE 3] Revoke the default grants (PUBLIC from Postgres itself; anon /
-- authenticated from migration 014's default privileges — which DO apply to
-- this brand-new function), then grant the single intended caller.
revoke execute on function public.memory_session_record(text, text, text, text, int, timestamptz, timestamptz, jsonb, jsonb)
  from public, anon, authenticated;
grant  execute on function public.memory_session_record(text, text, text, text, int, timestamptz, timestamptz, jsonb, jsonb)
  to service_role;

-- ====================================================================
-- 3. Apply-time receipt — HARD-FAILING. Any gate violation raises, rolling
--    back the whole migration transaction. (Same rationale as 026: a receipt
--    that cannot fail is not a receipt, and apply_migration has a known
--    silent-no-op failure mode upstream.)
-- ====================================================================

do $$
declare
  v_rls           boolean;
  v_bad_policies  int;
  v_oid           oid;
  v_anon_exec     boolean;
  v_auth_exec     boolean;
  v_public_exec   boolean;
  v_service_exec  boolean;
  v_proconfig     text;
  v_anon_tbl      int;
  v_has_metadata  boolean;
  v_has_agent     boolean;
begin
  -- Columns landed?
  select count(*) filter (where column_name = 'metadata')     > 0,
         count(*) filter (where column_name = 'source_agent') > 0
    into v_has_metadata, v_has_agent
    from information_schema.columns
   where table_schema = 'public' and table_name = 'memory_sessions';

  if not v_has_metadata then
    raise exception '[035] memory_sessions.metadata did not land';
  end if;
  if not v_has_agent then
    raise exception '[035] memory_sessions.source_agent did not land';
  end if;

  select c.relrowsecurity into v_rls
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname = 'memory_sessions';

  -- [GATE 2] Any policy reaching PUBLIC (roles '{public}' or the empty '{}'
  -- Supabase-Studio shape) is a violation; the service_role policy is not.
  select count(*)::int into v_bad_policies
    from pg_policies
   where schemaname = 'public' and tablename = 'memory_sessions'
     and ('public' = any(roles) or roles = '{}');

  select p.oid into v_oid
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'memory_session_record'
   limit 1;
  if v_oid is null then
    raise exception '[035] memory_session_record not found';
  end if;

  v_anon_exec    := has_function_privilege('anon',          v_oid, 'EXECUTE');
  v_auth_exec    := has_function_privilege('authenticated', v_oid, 'EXECUTE');
  v_public_exec  := has_function_privilege('public',        v_oid, 'EXECUTE');
  v_service_exec := has_function_privilege('service_role',  v_oid, 'EXECUTE');

  select array_to_string(p.proconfig, '; ') into v_proconfig
    from pg_proc p where p.oid = v_oid;

  select count(*)::int into v_anon_tbl
    from information_schema.role_table_grants
   where table_schema = 'public' and table_name = 'memory_sessions'
     and grantee in ('anon', 'authenticated');

  raise notice '[035] memory_sessions RLS enabled: % (expect t)', v_rls;
  raise notice '[035] memory_sessions PUBLIC-reaching policies: % (expect 0)', v_bad_policies;
  raise notice '[035] memory_sessions anon/authenticated table grants: % (expect 0)', v_anon_tbl;
  raise notice '[035] memory_session_record EXECUTE — anon: %, authenticated: %, public: % (expect f f f); service_role: % (expect t)',
    v_anon_exec, v_auth_exec, v_public_exec, v_service_exec;
  raise notice '[035] memory_session_record proconfig: % (expect search_path=public, pg_catalog)',
    coalesce(v_proconfig, '<none>');

  if v_rls is distinct from true then
    raise exception '[035] GATE 1 VIOLATION: RLS not enabled on public.memory_sessions';
  end if;
  if v_bad_policies <> 0 then
    raise exception '[035] GATE 2 VIOLATION: % PUBLIC-reaching policies on public.memory_sessions', v_bad_policies;
  end if;
  if v_anon_exec or v_auth_exec or v_public_exec then
    raise exception '[035] GATE 3 VIOLATION: memory_session_record is executable by anon/authenticated/public (anon=%, authenticated=%, public=%)',
      v_anon_exec, v_auth_exec, v_public_exec;
  end if;
  if not v_service_exec then
    raise exception '[035] GATE 3 VIOLATION: service_role lost EXECUTE on memory_session_record';
  end if;
  if v_proconfig is null or v_proconfig not like '%search_path=public, pg_catalog%' then
    raise exception '[035] GATE 4 VIOLATION: memory_session_record search_path not pinned (proconfig: %)',
      coalesce(v_proconfig, '<none>');
  end if;
  if v_anon_tbl <> 0 then
    raise exception '[035] GATE 5 VIOLATION: % residual anon/authenticated table grants on public.memory_sessions', v_anon_tbl;
  end if;

  raise notice '[035] receipt: all five gates verified (gate 5 = no web-reachable INSERT besides memory_session_record: zero anon/authenticated table grants, service_role-only policy, session_id minted server-side, upsert narrowed to same-agent + unprocessed rows).';
end$$;

-- ====================================================================
-- 4a. Post-apply verification (ORCH, Studio SQL editor — commented so the
--     migration runner does not choke on result sets):
--
--   -- Columns + index
--   select column_name from information_schema.columns
--    where table_schema='public' and table_name='memory_sessions'
--      and column_name in ('metadata','source_agent');            -- expect 2 rows
--
--   -- RPC privileges (resolve by OID; identity-args text form is rejected on Supabase)
--   select has_function_privilege('anon',         p.oid,'EXECUTE') as anon_exec,          -- expect f
--          has_function_privilege('authenticated',p.oid,'EXECUTE') as authenticated_exec, -- expect f
--          has_function_privilege('public',       p.oid,'EXECUTE') as public_exec,        -- expect f
--          has_function_privilege('service_role', p.oid,'EXECUTE') as service_role_exec   -- expect t
--     from pg_proc p join pg_namespace n on n.oid=p.pronamespace
--    where n.nspname='public' and p.proname='memory_session_record';
--
--   -- Round trip (service_role): record, verify the Rumen picker would take it, clean up
--   select public.memory_session_record('grok-web','receipt-smoke','receipt smoke session summary','termdeck',5);
--   select session_id, source_agent, project, messages_count, ended_at is not null as ended_set
--     from public.memory_sessions where session_id='web:grok-web:receipt-smoke';
--     -- expect: web:grok-web:receipt-smoke | grok-web | termdeck | 5 | t
--   select count(*) from public.memory_sessions s
--    where s.rumen_processed_at is null and s.ended_at is not null
--      and s.ended_at >= now() - ('72' || ' hours')::interval
--      and coalesce(s.messages_count,0) >= 3
--      and s.summary is not null and s.summary <> ''
--      and s.session_id='web:grok-web:receipt-smoke';             -- expect 1 (picker would sweep it)
--   select public.memory_session_record('grok','impersonation','x');
--     -- expect MEMORY_SESSION_RECORD_REJECTED: invalid_source_agent
--   delete from public.memory_sessions where session_id='web:grok-web:receipt-smoke';
--
-- 4b. Reversal (commented — apply by hand to roll back):
--
--   drop function if exists public.memory_session_record(text, text, text, text, int, timestamptz, timestamptz, jsonb, jsonb);
--   drop index  if exists public.memory_sessions_source_agent_idx;
--   -- the two columns are additive and harmless; drop only if you mean it:
--   -- alter table public.memory_sessions drop column if exists source_agent;
--   -- alter table public.memory_sessions drop column if exists metadata;
-- ====================================================================

-- migrations/026_memory_inbox.sql
-- Sprint 76 T1 (Memory Inbox) — quarantined write path for web-chat surfaces.
--
-- Policy (adopted 2026-06-11, binding): "CLIs write canonical; web chats
-- write proposals." A web surface's context window contains whatever the
-- page / pasted content / other tool results put there — prompt injection
-- on a web surface must NOT be able to write directly into the store every
-- CLI session trusts at boot. This migration is the trust boundary's
-- substrate:
--
--   1. public.memory_inbox — quarantine table for web-originated proposals.
--      A row here is NOT a memory: no recall path reads this table (T1
--      inventory FINDING, Sprint 76 STATUS.md; pinned by
--      tests/quarantine-proof.test.ts). Content becomes recallable ONLY
--      when the Rumen promotion pass (Sprint 76 T3) vets it and inserts a
--      NEW row into memory_items, stamping promoted_memory_id +
--      status='promoted' here as the audit trail.
--   2. public.memory_propose(...) — the ONLY insert path for proposals: a
--      validating SECURITY DEFINER RPC. service_role is the sole grantee;
--      the bridge reaches it through the webhook server's service-role
--      client, never with a raw anon key.
--
-- Five RLS hygiene gates (global CLAUDE.md § "Supabase RLS + privilege
-- hygiene") — each marked [GATE n] inline, each verified by the
-- HARD-FAILING receipt block at the bottom:
--   GATE 1  RLS enabled on memory_inbox in this same migration.
--   GATE 2  NO policies at all (no WITH CHECK (true), no PUBLIC, nothing):
--           anon/authenticated are denied everything; service_role
--           bypasses RLS by design.
--   GATE 3  REVOKE EXECUTE ... FROM PUBLIC (and anon/authenticated — see
--           note on migration 014 below) + targeted GRANT to service_role
--           only, on memory_propose.
--   GATE 4  SET search_path = public, pg_catalog on every function —
--           SECURITY DEFINER makes this load-bearing (search_path shadow
--           attack is a privilege-escalation primitive otherwise).
--   GATE 5  No raw anon-key write path: the RPC is the only proposal
--           INSERT; table grants for anon/authenticated are revoked
--           outright (belt-and-suspenders vs. Supabase's default-privilege
--           GRANT ALL ON TABLES to anon/authenticated on new public
--           tables).
--
-- Migration-014 note (why the revokes name three grantees, not just
-- PUBLIC): Postgres grants EXECUTE on new functions to PUBLIC by default,
-- AND this database's migration 014 set ALTER DEFAULT PRIVILEGES granting
-- EXECUTE to service_role/authenticated/anon on functions in schema
-- public. A bare "revoke ... from public" would leave the direct anon /
-- authenticated grants standing. Same reasoning as migration 023's
-- re-pin block.
--
-- Idempotent / rerun-safe: CREATE TABLE/INDEX IF NOT EXISTS; CREATE OR
-- REPLACE FUNCTION; ENABLE ROW LEVEL SECURITY, REVOKE and GRANT are
-- naturally idempotent; COMMENTs are last-write-wins; the receipt DO block
-- only SELECTs (and raises). Re-applying is a no-op that re-verifies the
-- gates.
--
-- APPLY: write + test locally only. Nobody applies this to the
-- daily-driver project from a lane — ORCH applies at sprint close
-- (PLANNING.md § Hard constraints), then runs the commented post-apply
-- verification at the bottom.

-- ====================================================================
-- 1. Quarantine table
-- ====================================================================

create table if not exists public.memory_inbox (
  id                  uuid primary key default gen_random_uuid(),
  created_at          timestamptz not null default now(),

  -- Constrained BY CONVENTION to the four *-web values; NO CHECK
  -- constraint on purpose (Sprint 50/74 fail-soft doctrine — see migration
  -- 025's "no CHECK by design" rationale): the whitelist lives in
  -- memory_propose() below, where a violation produces a clean,
  -- attributable MEMORY_PROPOSE_REJECTED error instead of a 23514
  -- check_violation inside a writer. Provenance survives promotion (T3
  -- copies this value into the canonical row's source_agent) so a poisoned
  -- proposal remains attributable and filterable forever.
  source_agent        text not null,

  -- Proposer's CLAIMED project. Advisory only — the Rumen promotion pass
  -- may re-map it; it is never trusted as canonical.
  project_hint        text,

  -- The proposal body. Cap: 4000 chars after trim (BINDING default —
  -- Sprint 76 T2 bridge ingress and T3 promotion gates mirror this exact
  -- number; enforced in memory_propose()).
  text                text not null,

  -- status writers are controlled code (the RPC always writes 'pending';
  -- Rumen stamps 'promoted'/'rejected') — a CHECK here is pure safety,
  -- unlike source_agent whose writers are fail-soft by doctrine.
  status              text not null default 'pending'
                      check (status in ('pending', 'promoted', 'rejected')),

  -- Audit pointer to the canonical row created at promotion. ON DELETE SET
  -- NULL: hard-deleting a promoted memory must not orphan-error the inbox
  -- audit trail (memory_forget is a soft archive, but exports/imports and
  -- manual surgery can hard-delete).
  promoted_memory_id  uuid references public.memory_items(id) on delete set null,

  rejection_reason    text,

  -- Connector metadata: bridge client_id / connector label / request id
  -- (T2 stamps metadata.bridge server-side), caps snapshot, and the
  -- promotion pass's claim/attempt counters (T3 stamps metadata.rumen).
  -- Cap: 8192 bytes by pg_column_size, enforced in memory_propose().
  metadata            jsonb not null default '{}'::jsonb,

  -- Keep the audit trail honest: a promotion pointer only on promoted
  -- rows, a rejection reason only on rejected rows. NULLs always pass —
  -- e.g. the FK's SET NULL on a hard-deleted canonical row leaves
  -- status='promoted' with a nulled pointer, which these accept.
  constraint memory_inbox_promoted_consistency
    check (promoted_memory_id is null or status = 'promoted'),
  constraint memory_inbox_rejection_consistency
    check (rejection_reason is null or status = 'rejected')
);

comment on table public.memory_inbox is
  'Sprint 76 quarantine for web-chat memory proposals ("CLIs write '
  'canonical; web chats write proposals"). Rows are INVISIBLE to every '
  'recall path by construction; the only insert path is the validating '
  'SECURITY DEFINER RPC memory_propose(); the Rumen promotion pass '
  '(status pending -> promoted|rejected) is the only thing that turns a '
  'proposal into a canonical memory_items row.';

comment on column public.memory_inbox.source_agent is
  'Proposing web surface: claude-web|chatgpt-web|grok-web|gemini-web. '
  'Whitelist enforced in memory_propose() (trim+lower then exact match); '
  'no CHECK constraint by design (migration 025 fail-soft doctrine). CLI '
  'values are rejected at the RPC: web surfaces may never impersonate a '
  'CLI trust domain.';

comment on column public.memory_inbox.project_hint is
  'Proposer''s claimed project; advisory only. Rumen may re-map at '
  'promotion; never trusted as canonical. Cap 128 chars (RPC-enforced).';

comment on column public.memory_inbox.text is
  'Proposal body, trimmed. Cap 4000 chars (RPC-enforced; binding default '
  'mirrored by the T2 bridge ingress and T3 promotion gates).';

comment on column public.memory_inbox.status is
  'pending = quarantined, awaiting the Rumen promotion pass; promoted = '
  'canonical copy inserted into memory_items (see promoted_memory_id); '
  'rejected = failed a promotion gate (see rejection_reason).';

comment on column public.memory_inbox.promoted_memory_id is
  'memory_items.id of the canonical row created at promotion; NULL unless '
  'status=promoted (consistency CHECK), or re-nulled by the FK if the '
  'canonical row is later hard-deleted.';

comment on column public.memory_inbox.rejection_reason is
  'Stable rejection vocabulary stamped by the Rumen promotion pass; NULL '
  'unless status=rejected (consistency CHECK).';

comment on column public.memory_inbox.metadata is
  'Connector + pipeline metadata: metadata.bridge (client_id, connector '
  'label, request id — stamped server-side by the MCP bridge), '
  'metadata.rumen (claim lease, attempt counters, gate verdicts — stamped '
  'by the promotion pass). Cap 8192 bytes pg_column_size (RPC-enforced).';

-- The promotion pass's scan (T3): all pending rows, oldest first.
create index if not exists memory_inbox_status_pending_idx
  on public.memory_inbox (status)
  where status = 'pending';

-- Drain ordering + ops queries ("what arrived lately").
create index if not exists memory_inbox_created_at_idx
  on public.memory_inbox (created_at desc);

-- Per-connector accounting (T2 rate-limit forensics, T3 24h promotion
-- caps, per-agent rejection rates).
create index if not exists memory_inbox_source_agent_idx
  on public.memory_inbox (source_agent);

-- ====================================================================
-- 2. RLS + table-grant hygiene
-- ====================================================================

-- [GATE 1] RLS on, in the same migration that creates the table.
alter table public.memory_inbox enable row level security;

-- [GATE 2] Deliberately NO "create policy" statements anywhere in this
-- file: with RLS enabled and zero policies, anon and authenticated are
-- denied every operation; service_role bypasses RLS by design (and the
-- Rumen promotion pass rides a service-role/pg connection).

-- [GATE 5 belt-and-suspenders] Strip the table-level grants Supabase's
-- default privileges hand anon/authenticated on new public tables, so even
-- a future accidentally-permissive policy would expose nothing through the
-- anon key. service_role keeps its grant (it bypasses RLS anyway; PostgREST
-- still needs the table privilege).
revoke all on table public.memory_inbox from public, anon, authenticated;

-- ====================================================================
-- 3. memory_propose() — the ONLY proposal insert path
-- ====================================================================

create or replace function public.memory_propose(
  p_source_agent text,
  p_text         text,
  p_project_hint text default null,
  p_metadata     jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_catalog  -- [GATE 4]
as $$
declare
  v_agent text;
  v_text  text;
  v_hint  text;
  v_meta  jsonb;
  v_id    uuid;
begin
  -- All rejections raise with the stable, machine-matchable prefix
  -- "MEMORY_PROPOSE_REJECTED: <reason_code>" — the bridge (T2) surfaces the
  -- message to the connector; tests and the TS mirror in src/propose.ts
  -- match on the prefix. Reason codes: invalid_source_agent | empty_text |
  -- text_too_long | project_hint_too_long | metadata_not_object |
  -- metadata_too_large.

  -- Whitelist: EXACTLY the four *-web values, matched after trim+lower
  -- normalization (mirrors src/remember.ts normalizeSourceAgent). CLI
  -- values (claude/codex/gemini/grok/orchestrator) and everything else are
  -- rejected: web surfaces may never impersonate a CLI trust domain. The
  -- echoed input is truncated to 80 chars (same cap normalizeSourceAgent
  -- uses) so a hostile caller cannot bloat logs through the error path.
  v_agent := lower(regexp_replace(coalesce(p_source_agent, ''), '^\s+|\s+$', '', 'g'));
  if v_agent not in ('claude-web', 'chatgpt-web', 'grok-web', 'gemini-web') then
    raise exception 'MEMORY_PROPOSE_REJECTED: invalid_source_agent (must be claude-web|chatgpt-web|grok-web|gemini-web; got %)',
      left(coalesce(p_source_agent, '<null>'), 80);
  end if;

  -- Body: non-empty after trim, <= 4000 chars (BINDING cap — T2/T3 mirror
  -- this number; see also PROPOSE_TEXT_MAX_CHARS in src/propose.ts).
  v_text := regexp_replace(coalesce(p_text, ''), '^\s+|\s+$', '', 'g');
  if v_text = '' then
    raise exception 'MEMORY_PROPOSE_REJECTED: empty_text';
  end if;
  if length(v_text) > 4000 then
    raise exception 'MEMORY_PROPOSE_REJECTED: text_too_long (% chars; max 4000)', length(v_text);
  end if;

  -- project_hint: advisory; trimmed; empty collapses to NULL; <= 128 chars.
  -- (length(NULL) is NULL, so the comparison is never true for NULL hints.)
  v_hint := nullif(regexp_replace(coalesce(p_project_hint, ''), '^\s+|\s+$', '', 'g'), '');
  if length(v_hint) > 128 then
    raise exception 'MEMORY_PROPOSE_REJECTED: project_hint_too_long (% chars; max 128)', length(v_hint);
  end if;

  -- metadata: a JSON object only (not array/scalar/json-null); explicit SQL
  -- NULL collapses to '{}'. Cap 8192 bytes by pg_column_size (binding —
  -- PROPOSE_METADATA_MAX_BYTES in src/propose.ts mirrors it approximately
  -- via serialized length; this check is the authoritative one).
  v_meta := coalesce(p_metadata, '{}'::jsonb);
  if jsonb_typeof(v_meta) <> 'object' then
    raise exception 'MEMORY_PROPOSE_REJECTED: metadata_not_object (got %)', jsonb_typeof(v_meta);
  end if;
  if pg_column_size(v_meta) > 8192 then
    raise exception 'MEMORY_PROPOSE_REJECTED: metadata_too_large (% bytes; max 8192)', pg_column_size(v_meta);
  end if;

  -- [GATE 5] The one and only proposal INSERT. status is hardcoded
  -- 'pending' (no parameter): a proposer cannot mint a pre-promoted row.
  insert into public.memory_inbox (source_agent, project_hint, text, metadata)
  values (v_agent, v_hint, v_text, v_meta)
  returning id into v_id;

  return v_id;
end;
$$;

comment on function public.memory_propose(text, text, text, jsonb) is
  'Sprint 76: sole insert path into memory_inbox (web-chat proposal '
  'quarantine). Validates the *-web whitelist + size caps and always '
  'inserts status=pending. SECURITY DEFINER with pinned search_path; '
  'EXECUTE: service_role only. Rejections raise with the stable prefix '
  'MEMORY_PROPOSE_REJECTED: <reason>.';

-- [GATE 3] Revoke the default grants (PUBLIC from Postgres itself, anon /
-- authenticated from migration 014's default privileges), then grant the
-- single intended caller.
revoke execute on function public.memory_propose(text, text, text, jsonb)
  from public, anon, authenticated;
grant  execute on function public.memory_propose(text, text, text, jsonb)
  to service_role;

-- ====================================================================
-- 4. Apply-time receipt — HARD-FAILING (deliberate strengthening of the
--    migration-025 notice-only idiom: the five gates are release-blocking,
--    and apply_migration has a known silent-no-op failure mode upstream —
--    a receipt that cannot fail is not a receipt. Any gate violation
--    raises, rolling back the whole migration transaction.)
-- ====================================================================

do $$
declare
  v_rls          boolean;
  v_policy_count int;
  v_oid          oid;
  v_anon_exec    boolean;
  v_auth_exec    boolean;
  v_public_exec  boolean;
  v_service_exec boolean;
  v_proconfig    text;
begin
  select c.relrowsecurity into v_rls
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname = 'memory_inbox';

  select count(*)::int into v_policy_count
    from pg_policies
   where schemaname = 'public' and tablename = 'memory_inbox';

  -- Sprint 81 receipt-OID sweep: resolve the function OID by proname and pass
  -- it to has_function_privilege, rather than a reconstructed text signature —
  -- the portable form (pg_get_function_identity_arguments returns arg NAMES on
  -- Supabase's Postgres, which the text form rejects; migration 029 is the
  -- reference). Receipt-only — no DDL/backfill change.
  select p.oid into v_oid
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'memory_propose'
   limit 1;
  if v_oid is null then
    raise exception '[026] memory_propose not found';
  end if;

  v_anon_exec    := has_function_privilege('anon',          v_oid, 'EXECUTE');
  v_auth_exec    := has_function_privilege('authenticated', v_oid, 'EXECUTE');
  v_public_exec  := has_function_privilege('public',        v_oid, 'EXECUTE');
  v_service_exec := has_function_privilege('service_role',  v_oid, 'EXECUTE');

  select array_to_string(p.proconfig, '; ') into v_proconfig
    from pg_proc p
   where p.oid = v_oid;

  raise notice '[026] memory_inbox RLS enabled: % (expect t)', v_rls;
  raise notice '[026] memory_inbox policy count: % (expect 0)', v_policy_count;
  raise notice '[026] memory_propose EXECUTE — anon: %, authenticated: %, public: % (expect f f f); service_role: % (expect t)',
    v_anon_exec, v_auth_exec, v_public_exec, v_service_exec;
  raise notice '[026] memory_propose proconfig: % (expect search_path=public, pg_catalog)',
    coalesce(v_proconfig, '<none>');

  if v_rls is distinct from true then
    raise exception '[026] GATE 1 VIOLATION: RLS not enabled on public.memory_inbox';
  end if;
  if v_policy_count <> 0 then
    raise exception '[026] GATE 2 VIOLATION: % policies present on public.memory_inbox (expected none)', v_policy_count;
  end if;
  if v_anon_exec or v_auth_exec or v_public_exec then
    raise exception '[026] GATE 3 VIOLATION: memory_propose is executable by anon/authenticated/public (anon=%, authenticated=%, public=%)',
      v_anon_exec, v_auth_exec, v_public_exec;
  end if;
  if not v_service_exec then
    raise exception '[026] GATE 3 VIOLATION: service_role lost EXECUTE on memory_propose';
  end if;
  if v_proconfig is null or v_proconfig not like '%search_path=public, pg_catalog%' then
    raise exception '[026] GATE 4 VIOLATION: memory_propose search_path not pinned (proconfig: %)',
      coalesce(v_proconfig, '<none>');
  end if;

  raise notice '[026] receipt: all five gates verified (gate 5 = no INSERT path besides memory_propose: zero table grants for anon/authenticated [revoked above], zero policies [gate 2], status hardcoded pending in the RPC).';
end$$;

-- ====================================================================
-- 5a. Post-apply verification (ORCH, Studio SQL editor — commented so the
--     migration runner doesn't choke on result sets):
--
--   -- Table + RLS + zero policies
--   select c.relname, c.relrowsecurity
--     from pg_class c join pg_namespace n on n.oid = c.relnamespace
--    where n.nspname='public' and c.relname='memory_inbox';      -- expect t
--   select count(*) from pg_policies
--    where schemaname='public' and tablename='memory_inbox';     -- expect 0
--
--   -- Table grants: anon/authenticated must hold NOTHING
--   select grantee, privilege_type from information_schema.role_table_grants
--    where table_schema='public' and table_name='memory_inbox'
--      and grantee in ('anon','authenticated');                  -- expect 0 rows
--
--   -- RPC privileges
--   select has_function_privilege('anon',          'public.memory_propose(text,text,text,jsonb)', 'EXECUTE') as anon_exec,          -- expect f
--          has_function_privilege('authenticated', 'public.memory_propose(text,text,text,jsonb)', 'EXECUTE') as authenticated_exec, -- expect f
--          has_function_privilege('public',        'public.memory_propose(text,text,text,jsonb)', 'EXECUTE') as public_exec,        -- expect f
--          has_function_privilege('service_role',  'public.memory_propose(text,text,text,jsonb)', 'EXECUTE') as service_role_exec;  -- expect t
--
--   -- Round trip (service_role): valid proposal inserts pending; CLI value rejected
--   select public.memory_propose('grok-web', 'receipt smoke proposal');           -- expect uuid
--   select status, source_agent from public.memory_inbox
--    order by created_at desc limit 1;                                            -- expect pending | grok-web
--   select public.memory_propose('grok', 'impersonation attempt');                -- expect MEMORY_PROPOSE_REJECTED: invalid_source_agent
--   delete from public.memory_inbox where text = 'receipt smoke proposal';        -- clean up the smoke row
--
-- 5b. Reversal (commented — apply by hand to roll back):
--
--   drop function if exists public.memory_propose(text, text, text, jsonb);
--   drop table if exists public.memory_inbox;
-- ====================================================================

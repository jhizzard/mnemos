-- migrations/038_objective_tier.sql
-- Sprint 71 B-T1 (Objective Tier, Deck B) — tier 0: per-project OBJECTIVES that
-- are INJECTED, never retrieved, and mutate only by ratification.
--
-- Deck A owns 037 (graph-boosted recall). This file touches nothing 037 touches:
-- no column, index, constraint, function or grant on memory_items,
-- memory_relationships, or any surface in that migration. Seam §2.
--
-- WHY THIS TIER EXISTS. Mnestra already has a de-facto hierarchy — doctrine
-- (029's elevation loop), kitchen-level decisions, leaf evidence — but every
-- level of it is RETRIEVED. Retrieval is a ranking function, and a ranking
-- function can always be outvoted: a project's founding constraint competes for
-- context against whatever happens to be semantically close to the current
-- question, and loses on any turn where the question is about something else.
-- That is the drift this sprint exists to stop. Tier 0 is the answer, and its
-- defining property is that recall is not involved: objectives are pinned into
-- the context at session start and re-pinned at PreCompact, above results,
-- unranked, undecayed.
--
-- ── WHY A SEPARATE TABLE, NOT MARKED ROWS IN memory_items ───────────────
--
-- The brief left the storage choice open. Both shapes can hold the data; only
-- one can hold the GUARANTEES.
--
--   1. EXCLUSION. Objectives must never be consolidated, decayed, near-duped,
--      judge-rejected or recalled. As marked rows that is a predicate every one
--      of those pipelines must remember to carry, whose failure mode is silent
--      (an objective quietly joins the decay pool and the permanent tier starts
--      aging), and which the NEXT pipeline anyone writes violates by default —
--      omission, not commission. In a separate table the exclusion is
--      structural: those pipelines read memory_items and cannot see this table,
--      including pipelines not yet written. Nothing to remember, nothing to
--      forget.
--
--   2. RATIFY-ONLY MUTATION. service_role already holds blanket write on
--      memory_items and no grant can fence a subset of its rows; fencing them
--      would take a trigger, which the same role can disable. Here the table
--      takes NO insert/update/delete grant for any role at all and the sole
--      write path is a SECURITY DEFINER function. "No UPDATE grant that
--      bypasses ratify" becomes literally true rather than aspirational.
--
-- Cost accepted: memory_relationships' endpoints are memory_items ids, so an
-- objective cannot be a graph endpoint. Tier 0 is injected, not traversed, so
-- nothing this sprint needs that edge; Rumen's drift flags key on
-- memory_objectives.id directly (same database).
--
-- ── THE MARKER, FOR DECK A (seam §3) ────────────────────────────────────
--
-- Posted as [B-T1] SCHEMA-READY: tier-0 rows are NOT in memory_items, so 037's
-- walk structurally cannot reach one and needs no predicate for correctness.
-- The reserved-but-unused sentinel `memory_items.source_type = 'objective'`
-- (0 rows live at authoring time, verified) lets A-T1 write the exclusion
-- explicitly if they want it legible:
--     AND m.source_type IS DISTINCT FROM 'objective'
-- This migration deliberately adds NO CHECK constraint enforcing that reservation
-- on memory_items: source_type there is 94.9% foreign values with no existing
-- constraint, and a vocabulary CHECK on that column is the exact shape migration
-- 025's fail-soft doctrine rejects — it would cost a writer its capture on
-- taxonomy skew, to defend a value nothing writes.
--
-- ── ON "ADD ... NOT VALID + VALIDATE" (brief §5) ────────────────────────
--
-- That instruction addresses constraints added to an EXISTING populated table,
-- where a validating ADD takes a lock proportional to the row count. Every
-- constraint here is inline on a table created empty in this same file, so it is
-- valid at creation with no scan and no lock to avoid. There is no populated
-- table in this migration's blast radius. The receipt below re-asserts each
-- constraint by name, so a divergent pre-existing table (hand-made, or a partial
-- earlier apply) hard-fails instead of silently under-enforcing.
--
-- ── FIVE RLS/PRIVILEGE GATES (global CLAUDE.md § Supabase RLS) ──────────
--   GATE 1  RLS enabled on public.memory_objectives.
--   GATE 2  ZERO policies. Not "a narrow policy" — none. service_role reads via
--           BYPASSRLS + an explicit SELECT grant; anon/authenticated match no
--           policy and are denied whatever else changes around them.
--   GATE 3  REVOKE EXECUTE FROM public, anon, authenticated on both functions,
--           then targeted GRANT to service_role.
--   GATE 4  SET search_path = public, pg_catalog on both functions.
--   GATE 5  No write path that skips ratification: ALL table privileges revoked
--           from every role INCLUDING service_role, then SELECT alone re-granted.
--           This is load-bearing — Supabase default privileges hand a brand-new
--           public-schema table to service_role with full DML, so creating the
--           table and walking away leaves the bypass wide open.
--   GATE 6  EXACTLY ONE grant-reachable mutation entry point. Counted as a
--           privilege fact in the receipt: of every public.objective_* function
--           executable by service_role, exactly one may be a mutator, and it
--           must be objective_ratify.
--
-- ── WHY RETIREMENT IS A MODE OF RATIFY, NOT ITS OWN FUNCTION ────────────
--
-- The first draft of this file shipped a separate objective_retire(). B-T4
-- declined to ratify it and ORCH upheld the contract: a second grant-reachable
-- mutation path is not a smaller version of the property tier 0 sells, it is
-- the absence of it. "Mutation only through ratification" has to be checkable
-- by counting entry points, and the count has to be one — otherwise every
-- future audit re-derives which of N functions are safe, and the third one
-- somebody adds inherits the argument that justified the second.
--
-- So retirement is now "supersede with nothing": objective_ratify with a
-- p_supersedes and no p_content marks the predecessor and inserts no
-- replacement. Same gate, same lock, same validation, same rejection prefix,
-- same never-delete guarantee — one door.
--
-- ── WHY THE ACTIVE-COUNT CAP TAKES AN ADVISORY LOCK ─────────────────────
--
-- Rank uniqueness is constraint-backed (the partial unique index), so that race
-- was always closed by the database. The CAP was not: `select count(*) …` then
-- `insert` is a check-then-act, and under READ COMMITTED two concurrent
-- ratifies for the same project both see 14, both pass, and both insert. The
-- cap is not a nicety — it is what keeps tier 0 small enough to inject into
-- every session and every compaction, so silently exceeding it degrades every
-- future context window rather than raising anything.
--
-- pg_advisory_xact_lock keyed on the project serializes ratification per
-- project and releases at commit/rollback with no unlock path to forget. It is
-- keyed on the PROJECT, not the table, so ratifying in two different projects
-- never contends. A unique index cannot express "at most 15 rows per project",
-- and a trigger counting rows has the same read-then-decide race one level
-- down; the lock is the honest primitive for this shape.
--
-- NON-SUPERUSER APPLY (Sprint 83 lesson — the discriminator is the ROLE, not the
-- PG version). Supabase's `postgres` is not a superuser but is the table owner,
-- which is sufficient for every statement here. Privileged statements that could
-- fail on a non-owner role are wrapped to name the role and the statement.
--
-- IDEMPOTENT: create table/index if not exists + create or replace function.
-- Re-running is a no-op that still re-verifies all five gates.
-- ====================================================================


-- ====================================================================
-- 1. public.memory_objectives — the tier-0 store
--
--    Tiny by construction: ~5-15 rows per project (the ratify path hard-caps
--    active rows at OBJECTIVE_MAX_ACTIVE = 15). The cap is not a performance
--    concern — it is the feature. A tier that is always injected is only
--    affordable while it is small, and a tier-0 of 60 rows is a context tax on
--    every session that has stopped meaning anything.
--
--    HISTORY IS NEVER DELETED. Superseding an objective marks the old row and
--    inserts a new one; retiring marks the row. Nothing in this file DELETEs.
--    "What did this project used to believe, and who changed it" is the audit
--    question tier 0 has to be able to answer.
--
--    COLUMN NAMES ARE A CROSS-DECK CONTRACT. `project`, `rank`, `status` are
--    read verbatim by TermDeck's tier-0 provider (packages/server/src/tier0.js)
--    over PostgREST; `content` lands in its normalized `text` field via its
--    TEXT_KEYS variant list. Renaming any of the four is a breaking change to a
--    consumer in another repo.
-- ====================================================================

create table if not exists public.memory_objectives (
  id           uuid primary key default gen_random_uuid(),
  project      text        not null,
  rank         smallint    not null,
  content      text        not null,
  status       text        not null default 'active',
  supersedes   uuid        null references public.memory_objectives(id) on delete restrict,
  ratified_by  text        not null,
  ratified_at  timestamptz not null default now(),
  retired_at   timestamptz null,
  retired_by   text        null,
  created_at   timestamptz not null default now(),
  metadata     jsonb       not null default '{}'::jsonb,

  constraint memory_objectives_project_nonempty
    check (btrim(project) <> '' and length(project) <= 120),

  -- Lockstep with TIER0_MAX_TEXT_CHARS in packages/server/src/tier0.js. The
  -- consumer CLAMPS at 600 with an ellipsis; rejecting at 600 here means the
  -- operator finds out at ratification time, when they can rewrite it, instead
  -- of discovering months later that the second half of an objective has never
  -- been injected into anything.
  constraint memory_objectives_content_len
    check (btrim(content) <> '' and length(content) <= 600),

  constraint memory_objectives_status_vocab
    check (status in ('active', 'superseded', 'retired')),

  constraint memory_objectives_rank_range
    check (rank >= 1 and rank <= 99),

  constraint memory_objectives_ratified_by_nonempty
    check (btrim(ratified_by) <> '' and length(ratified_by) <= 120),

  constraint memory_objectives_no_self_supersede
    check (supersedes is distinct from id),

  -- The retirement provenance and the status bit cannot disagree. Without this
  -- an UPDATE that flips status alone leaves a row that reads "retired" with
  -- nobody's name on it — which is precisely the state a bypass write would
  -- produce, so making it unrepresentable is worth one CHECK.
  constraint memory_objectives_retirement_consistent
    check (
      (status =  'active' and retired_at is     null and retired_by is     null) or
      (status <> 'active' and retired_at is not null and retired_by is not null)
    )
);

comment on table public.memory_objectives is
  'Tier 0 — per-project objectives. INJECTED at session start and PreCompact, never retrieved: no recall, consolidation, decay, near-dup or judge pipeline reads this table, and that exclusion is structural rather than predicated. Mutation ONLY via objective_ratify() — one entry point, which also performs retirement (supersede with no content); no role holds INSERT/UPDATE/DELETE. Sprint 71 B-T1, migration 038.';

comment on column public.memory_objectives.rank is
  'Ascending pin order within a project, 1-based. Unique among ACTIVE rows of a project (partial unique index); superseded/retired rows keep their historical rank and do not contend.';
comment on column public.memory_objectives.content is
  'The objective prose, <= 600 chars — lockstep with TIER0_MAX_TEXT_CHARS in TermDeck packages/server/src/tier0.js, so nothing injected is ever truncated.';
comment on column public.memory_objectives.status is
  'active | superseded | retired. Every inactive value is inside the consumer deny-list in packages/server/src/tier0.js (INACTIVE_STATUSES), so a retired objective can never be injected.';
comment on column public.memory_objectives.supersedes is
  'Forward pointer on the NEW row to the row it replaced. Lives on the LIVE row — it is a provenance link, not a retirement signal; the retired row is the one carrying status=''superseded''.';
comment on column public.memory_objectives.retired_by is
  'Operator who ratified the deactivation. Named retired_by, NOT superseded_by/is_active, deliberately: those two keys are retirement sentinels in the TermDeck consumer and a top-level column by either name on a LIVE row would blank it from injection.';

-- Rank uniqueness among the live set only. This is what makes "the pin order"
-- a fact rather than a hope, and it is partial because history must be allowed
-- to hold the rank it held at the time.
create unique index if not exists memory_objectives_active_rank_uidx
  on public.memory_objectives (project, rank)
  where status = 'active';

-- The injection read: `where project = ? and status = 'active' order by rank`.
-- Served by the partial unique index above. The only additional access path is
-- walking a supersession chain backwards.
create index if not exists memory_objectives_supersedes_idx
  on public.memory_objectives (supersedes)
  where supersedes is not null;


-- ====================================================================
-- 2. Gates 1, 2 and 5 — the privilege posture
--
--    Read this as one statement, not three: the table is readable by exactly
--    one role and writable by none. Every mutation in the rest of this file
--    happens inside a SECURITY DEFINER function running as the table owner.
-- ====================================================================

-- [GATE 1]
do $$
declare
  v_rls boolean;
begin
  select c.relrowsecurity into v_rls
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname = 'memory_objectives';
  if v_rls is distinct from true then
    execute 'alter table public.memory_objectives enable row level security';
    raise notice '[038] enabled RLS on public.memory_objectives';
  end if;
end$$;

-- [GATE 2] No policy is created here, ever. Documented as an assertion in the
-- receipt rather than left as an absence somebody later reads as an oversight
-- and "fixes" with a Studio template (`WITH CHECK (true)`, roles '{}').

-- [GATE 5] Revoke from EVERY role, service_role included, then re-grant SELECT
-- alone. The `service_role` half is the one that matters: Supabase's default
-- privileges grant full DML on new public tables to service_role, so a table
-- created and left alone is writable by the same key TermDeck uses for reads.
do $$
begin
  revoke all on table public.memory_objectives from public, anon, authenticated, service_role;
  grant select on table public.memory_objectives to service_role;
exception
  when insufficient_privilege then
    raise exception '[038] GATE 5: role % lacks privilege to REVOKE/GRANT on public.memory_objectives; apply as the table owner (Supabase: postgres)', current_user;
end$$;


-- ====================================================================
-- 3. public.objective_list(p_project text) — the injection fetch
--
--    The exact name and argument name posted as [B-T1] SCHEMA-READY and coded
--    against by TermDeck's provider (TIER0_RPC_DEFAULT = 'objective_list',
--    first probe shape 'p_project'). PostgREST binds RPC arguments BY NAME:
--    renaming p_project is a breaking change even with the type unchanged.
--
--    NULL p_project RETURNS ZERO ROWS, deliberately. A panel with no project is
--    the one case where "all objectives" is tempting and wrong: handing an agent
--    36 projects' binding constraints, interleaved by rank, is worse than
--    handing it none — it would defend constraints belonging to code it is not
--    editing. Empty is the honest answer, and the consumer already renders
--    empty as "no tier 0".
-- ====================================================================

create or replace function public.objective_list(p_project text)
returns table (
  id          uuid,
  project     text,
  rank        smallint,
  content     text,
  status      text,
  supersedes  uuid,
  ratified_by text,
  ratified_at timestamptz,
  created_at  timestamptz,
  metadata    jsonb
)
language sql
stable
security definer
set search_path = public, pg_catalog  -- [GATE 4]
as $$
  select o.id, o.project, o.rank, o.content, o.status, o.supersedes,
         o.ratified_by, o.ratified_at, o.created_at, o.metadata
    from public.memory_objectives o
   where p_project is not null
     and o.project = p_project
     and o.status  = 'active'
   order by o.rank asc, o.ratified_at asc;
$$;

comment on function public.objective_list(text) is
  'Tier-0 injection fetch: active objectives for one project, rank ascending. NULL p_project returns zero rows by design (cross-project tier 0 is never correct). Sprint 71 B-T1, migration 038.';

-- [GATE 3]
revoke execute on function public.objective_list(text) from public, anon, authenticated;
grant  execute on function public.objective_list(text) to service_role;


-- ====================================================================
-- 4. public.objective_ratify(...) — the ONE mutation entry point
--
--    THREE MODES, one door:
--      CREATE    p_content, p_rank, no p_supersedes      → insert
--      REPLACE   p_content + p_supersedes                → mark old, insert new
--      RETIRE    p_supersedes, NO p_content              → mark old, insert none
--    Returns the new objective's id in CREATE/REPLACE, and the retired row's id
--    in RETIRE (there is no new row to name).
--
--    Rejections raise with the machine-matchable prefix
--    "OBJECTIVE_RATIFY_REJECTED: <reason_code>", mirroring 035's
--    MEMORY_SESSION_RECORD_REJECTED and 026's MEMORY_PROPOSE_REJECTED. The TS
--    mirror (src/objectives.ts) pre-empts most of them for a fast client error;
--    THIS is the authoritative gate — the MCP tool's operator gate can be
--    bypassed by anyone with the service key and a REST client, this cannot.
--
--    Reason codes:
--      empty_project | project_too_long | empty_ratified_by |
--      ratified_by_too_long | content_or_supersedes_required |
--      content_too_long | rank_required | rank_not_allowed_on_retire |
--      rank_out_of_range | rank_taken | metadata_not_object |
--      metadata_too_large | supersedes_not_found | supersedes_wrong_project |
--      supersedes_not_active | too_many_active
--
--    SERIALIZATION. The advisory lock is taken on the PROJECT before anything
--    reads the objective set, and released at commit/rollback. It exists for
--    the cap check, which is a check-then-act that two concurrent ratifies
--    would both pass under READ COMMITTED. Note the ordering: lock, THEN read.
--    A lock taken after the count is decoration.
--
--    SUPERSESSION ORDER IS ALSO LOAD-BEARING. The old row is marked BEFORE the
--    rank and cap checks, for two reasons: the partial unique index on
--    (project, rank) would otherwise reject a replacement that keeps its
--    predecessor's rank (the common case), and the cap would otherwise count
--    the outgoing row against its own replacement at exactly 15 objectives.
--    Both failures appear only at the boundary, i.e. in production, months on.
-- ====================================================================

create or replace function public.objective_ratify(
  p_project     text,
  p_ratified_by text,
  p_content     text     default null,
  p_rank        smallint default null,
  p_supersedes  uuid     default null,
  p_metadata    jsonb    default '{}'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_catalog  -- [GATE 4]
as $$
declare
  v_project text;
  v_content text;
  v_by      text;
  v_meta    jsonb;
  v_rank    smallint;
  v_old     public.memory_objectives%rowtype;
  v_active  int;
  v_id      uuid;
  v_retire  boolean;
begin
  v_project := nullif(btrim(coalesce(p_project, '')), '');
  v_content := nullif(btrim(coalesce(p_content, '')), '');
  v_by      := nullif(btrim(coalesce(p_ratified_by, '')), '');
  v_meta    := coalesce(p_metadata, '{}'::jsonb);

  -- RETIRE is "supersede with nothing".
  v_retire  := (v_content is null and p_supersedes is not null);

  if v_project is null then
    raise exception 'OBJECTIVE_RATIFY_REJECTED: empty_project';
  end if;
  if length(v_project) > 120 then
    raise exception 'OBJECTIVE_RATIFY_REJECTED: project_too_long (% > 120)', length(v_project);
  end if;
  if v_by is null then
    raise exception 'OBJECTIVE_RATIFY_REJECTED: empty_ratified_by';
  end if;
  if length(v_by) > 120 then
    raise exception 'OBJECTIVE_RATIFY_REJECTED: ratified_by_too_long (% > 120)', length(v_by);
  end if;
  if v_content is null and p_supersedes is null then
    raise exception 'OBJECTIVE_RATIFY_REJECTED: content_or_supersedes_required (nothing to ratify: pass content to create, or supersedes alone to retire)';
  end if;
  if v_content is not null and length(v_content) > 600 then
    raise exception 'OBJECTIVE_RATIFY_REJECTED: content_too_long (% > 600)', length(v_content);
  end if;
  if v_retire and p_rank is not null then
    -- Silently ignoring it would let an operator believe they had moved an
    -- objective they were in fact retiring.
    raise exception 'OBJECTIVE_RATIFY_REJECTED: rank_not_allowed_on_retire (a retirement has no rank to set)';
  end if;
  if jsonb_typeof(v_meta) <> 'object' then
    raise exception 'OBJECTIVE_RATIFY_REJECTED: metadata_not_object';
  end if;
  if pg_column_size(v_meta) > 8192 then
    raise exception 'OBJECTIVE_RATIFY_REJECTED: metadata_too_large (% > 8192 bytes)', pg_column_size(v_meta);
  end if;

  -- ── SERIALIZE THIS PROJECT'S RATIFICATIONS ────────────────────────────
  -- Before ANY read of the objective set. Released at commit/rollback, so
  -- there is no unlock path to forget and no leak on an exception. Keyed on
  -- the project, so two projects never contend.
  perform pg_advisory_xact_lock(hashtext('mnestra.memory_objectives'), hashtext(v_project));

  -- Supersession/retirement: resolve and row-lock the predecessor.
  if p_supersedes is not null then
    select * into v_old
      from public.memory_objectives
     where id = p_supersedes
     for update;

    if not found then
      raise exception 'OBJECTIVE_RATIFY_REJECTED: supersedes_not_found (%)', p_supersedes;
    end if;
    if v_old.project <> v_project then
      raise exception 'OBJECTIVE_RATIFY_REJECTED: supersedes_wrong_project (row belongs to %)', v_old.project;
    end if;
    if v_old.status <> 'active' then
      raise exception 'OBJECTIVE_RATIFY_REJECTED: supersedes_not_active (status %)', v_old.status;
    end if;

    -- Mark it. 'superseded' when something takes its place, 'retired' when
    -- nothing does — the vocabulary stays meaningful either way.
    update public.memory_objectives
       set status     = case when v_retire then 'retired' else 'superseded' end,
           retired_at = now(),
           retired_by = v_by,
           metadata   = metadata || v_meta
     where id = p_supersedes;

    if v_retire then
      -- One door, and this is where it stops for a retirement: nothing is
      -- inserted, nothing is deleted, the row survives as history.
      return p_supersedes;
    end if;

    -- A replacement inherits its predecessor's slot unless moved.
    v_rank := coalesce(p_rank, v_old.rank);
  else
    v_rank := p_rank;
  end if;

  if v_rank is null then
    raise exception 'OBJECTIVE_RATIFY_REJECTED: rank_required';
  end if;
  if v_rank < 1 or v_rank > 99 then
    raise exception 'OBJECTIVE_RATIFY_REJECTED: rank_out_of_range (%)', v_rank;
  end if;

  if exists (
    select 1 from public.memory_objectives
     where project = v_project and status = 'active' and rank = v_rank
  ) then
    raise exception 'OBJECTIVE_RATIFY_REJECTED: rank_taken (project %, rank %)', v_project, v_rank;
  end if;

  select count(*)::int into v_active
    from public.memory_objectives
   where project = v_project and status = 'active';

  if v_active >= 15 then
    raise exception 'OBJECTIVE_RATIFY_REJECTED: too_many_active (% active; cap 15 — supersede or retire one first)', v_active;
  end if;

  insert into public.memory_objectives
    (project, rank, content, status, supersedes, ratified_by, ratified_at, metadata)
  values
    (v_project, v_rank, v_content, 'active', p_supersedes, v_by, now(), v_meta)
  returning id into v_id;

  return v_id;
end;
$$;

comment on function public.objective_ratify(text, text, text, smallint, uuid, jsonb) is
  'The ONLY mutation path for tier-0 objectives — create, replace, and retire (supersede with no content). Operator-gated at the MCP layer (MNESTRA_ALLOW_OBJECTIVE_RATIFY); authoritative validation here. Serializes per project on an advisory xact lock so the active-row cap cannot be raced. Marks, never deletes. Sprint 71 B-T1, migration 038.';

-- [GATE 3]
revoke execute on function public.objective_ratify(text, text, text, smallint, uuid, jsonb) from public, anon, authenticated;
grant  execute on function public.objective_ratify(text, text, text, smallint, uuid, jsonb) to service_role;


-- ====================================================================
-- 6. Apply-time receipt — HARD-FAILING. Any gate violation raises and rolls the
--    whole migration back. (Same rationale as 026/035: a receipt that cannot
--    fail is not a receipt, and apply_migration has a known silent-no-op
--    failure mode upstream.)
--
--    GATE 5 is checked as a PRIVILEGE FACT, not as "the REVOKE statement ran" —
--    the thing that must be true is that no grantee other than the table owner
--    can write, however it came to be that way.
-- ====================================================================

do $$
declare
  v_rls          boolean;
  v_bad_policies int;
  v_owner        name;
  v_write_grants int;
  v_read_grants  int;
  v_missing      text;
  v_extra_mutators text;
  v_fn           text;
  v_oid          oid;
  v_proconfig    text;
  v_anon_exec    boolean;
  v_auth_exec    boolean;
  v_public_exec  boolean;
  v_service_exec boolean;
  v_constraints  text[] := array[
    'memory_objectives_project_nonempty',
    'memory_objectives_content_len',
    'memory_objectives_status_vocab',
    'memory_objectives_rank_range',
    'memory_objectives_ratified_by_nonempty',
    'memory_objectives_no_self_supersede',
    'memory_objectives_retirement_consistent'
  ];
begin
  if to_regclass('public.memory_objectives') is null then
    raise exception '[038] public.memory_objectives did not land';
  end if;

  -- Every constraint present under its exact name. This is what makes a
  -- divergent pre-existing table (which `create table if not exists` would have
  -- silently accepted) fail loudly instead of under-enforcing.
  select string_agg(c, ', ') into v_missing
    from unnest(v_constraints) as c
   where not exists (
     select 1 from pg_constraint pc
       join pg_class t on t.oid = pc.conrelid
       join pg_namespace n on n.oid = t.relnamespace
      where n.nspname = 'public' and t.relname = 'memory_objectives' and pc.conname = c
   );
  if v_missing is not null then
    raise exception '[038] missing constraint(s) on public.memory_objectives: % — the table exists in a shape this migration did not create', v_missing;
  end if;

  if to_regclass('public.memory_objectives_active_rank_uidx') is null then
    raise exception '[038] the partial unique index on (project, rank) where status=''active'' did not land';
  end if;

  select c.relrowsecurity, pg_get_userbyid(c.relowner)
    into v_rls, v_owner
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname = 'memory_objectives';

  -- [GATE 2] Any policy at all is a violation here — including a narrow one.
  select count(*)::int into v_bad_policies
    from pg_policies
   where schemaname = 'public' and tablename = 'memory_objectives';

  -- [GATE 5] Write privileges held by anyone other than the owner.
  select count(*)::int into v_write_grants
    from information_schema.role_table_grants
   where table_schema = 'public' and table_name = 'memory_objectives'
     and privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')
     and grantee <> v_owner::text;

  select count(*)::int into v_read_grants
    from information_schema.role_table_grants
   where table_schema = 'public' and table_name = 'memory_objectives'
     and privilege_type = 'SELECT'
     and grantee = 'service_role';

  raise notice '[038] memory_objectives RLS: % (expect t); policies: % (expect 0); non-owner write grants: % (expect 0); service_role SELECT: % (expect 1)',
    v_rls, v_bad_policies, v_write_grants, v_read_grants;

  if v_rls is distinct from true then
    raise exception '[038] GATE 1 VIOLATION: RLS not enabled on public.memory_objectives';
  end if;
  if v_bad_policies <> 0 then
    raise exception '[038] GATE 2 VIOLATION: % policy/policies exist on public.memory_objectives; tier 0 is a zero-policy table', v_bad_policies;
  end if;
  if v_write_grants <> 0 then
    raise exception '[038] GATE 5 VIOLATION: % non-owner INSERT/UPDATE/DELETE/TRUNCATE grant(s) on public.memory_objectives — a write path that skips ratification exists', v_write_grants;
  end if;
  if v_read_grants < 1 then
    raise exception '[038] GATE 5 VIOLATION: service_role lost SELECT on public.memory_objectives (the tier-0 table-read fallback would go dark)';
  end if;

  -- [GATE 6] EXACTLY ONE grant-reachable mutation entry point.
  --
  -- Counted as a privilege fact over whatever is actually in the schema, not as
  -- "the file only defines one" — the failure this guards against is somebody
  -- adding objective_archive() in migration 041 with a service_role grant,
  -- which no assertion about THIS file's text would ever see. objective_list is
  -- the sole permitted non-mutator; anything else executable by service_role
  -- under the objective_ prefix has to justify itself by failing this.
  select coalesce(string_agg(p.proname, ', '), '') into v_extra_mutators
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname like 'objective\_%'
     and p.proname not in ('objective_list', 'objective_ratify')
     and has_function_privilege('service_role', p.oid, 'EXECUTE');

  if v_extra_mutators <> '' then
    raise exception '[038] GATE 6 VIOLATION: additional service_role-executable objective function(s): % — tier 0 permits exactly one mutation entry point (objective_ratify) plus the objective_list read', v_extra_mutators;
  end if;

  -- [GATES 3 + 4] for both functions.
  foreach v_fn in array array['objective_list', 'objective_ratify'] loop
    select p.oid into v_oid
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = v_fn
     limit 1;
    if v_oid is null then
      raise exception '[038] function public.% not found', v_fn;
    end if;

    v_anon_exec    := has_function_privilege('anon',          v_oid, 'EXECUTE');
    v_auth_exec    := has_function_privilege('authenticated', v_oid, 'EXECUTE');
    v_public_exec  := has_function_privilege('public',        v_oid, 'EXECUTE');
    v_service_exec := has_function_privilege('service_role',  v_oid, 'EXECUTE');

    select array_to_string(p.proconfig, '; ') into v_proconfig from pg_proc p where p.oid = v_oid;

    if v_anon_exec or v_auth_exec or v_public_exec then
      raise exception '[038] GATE 3 VIOLATION: public.% is executable by anon/authenticated/public (anon=%, authenticated=%, public=%)',
        v_fn, v_anon_exec, v_auth_exec, v_public_exec;
    end if;
    if not v_service_exec then
      raise exception '[038] GATE 3 VIOLATION: service_role lacks EXECUTE on public.%', v_fn;
    end if;
    if v_proconfig is null or v_proconfig not like '%search_path=public, pg_catalog%' then
      raise exception '[038] GATE 4 VIOLATION: public.% search_path not pinned (proconfig: %)', v_fn, coalesce(v_proconfig, '<none>');
    end if;
  end loop;

  raise notice '[038] receipt: all six gates verified. Tier 0 is readable by service_role, writable by nobody, and mutable through exactly one entry point: objective_ratify().';
end$$;


-- ====================================================================
-- 7a. Post-apply verification (ORCH, Studio SQL editor — commented so the
--     migration runner does not choke on result sets):
--
--   -- Privilege posture: expect zero rows (no non-owner write grant)
--   select grantee, privilege_type from information_schema.role_table_grants
--    where table_schema='public' and table_name='memory_objectives'
--      and privilege_type in ('INSERT','UPDATE','DELETE','TRUNCATE')
--      and grantee <> 'postgres';
--
--   -- Function privileges (resolve by OID; identity-args text form is rejected on Supabase)
--   select p.proname,
--          has_function_privilege('anon',         p.oid,'EXECUTE') as anon_exec,          -- expect f
--          has_function_privilege('authenticated',p.oid,'EXECUTE') as authenticated_exec, -- expect f
--          has_function_privilege('service_role', p.oid,'EXECUTE') as service_role_exec   -- expect t
--     from pg_proc p join pg_namespace n on n.oid=p.pronamespace
--    where n.nspname='public' and p.proname like 'objective\_%';
--                                                 -- expect EXACTLY 2 rows (list, ratify) — [GATE 6]
--
--   -- Round trip (service_role): create, replace, retire, inspect history
--   select public.objective_ratify('termdeck','orch','Zero build step: no TypeScript, no bundler, vanilla JS on the client.',1);
--   select public.objective_list('termdeck');                     -- expect 1 row, rank 1
--   select public.objective_ratify('termdeck','orch','Zero build step is a locked architectural decision — no TypeScript anywhere in the tree.',null,
--            (select id from public.memory_objectives where project='termdeck' and status='active' and rank=1));
--   select rank, status, retired_by, supersedes is not null as chained
--     from public.memory_objectives where project='termdeck' order by ratified_at;
--                                                                 -- expect: 1 superseded orch f / 1 active <null> t
--   select public.objective_list('termdeck');                     -- expect 1 row (the replacement only)
--   -- RETIRE = supersede with nothing (no p_content), through the SAME entry point:
--   select public.objective_ratify('termdeck','orch',null,null,
--            (select id from public.memory_objectives where project='termdeck' and status='active'));
--   select status from public.memory_objectives where project='termdeck' order by ratified_at;
--                                                                 -- expect: superseded / retired
--   select public.objective_list('termdeck');                     -- expect 0 rows
--   select public.objective_list(null);                           -- expect 0 rows, by design
--
--   -- The bypass must be refused even holding the service key:
--   --   (run as service_role) update public.memory_objectives set content='x';
--   --   expect: ERROR permission denied for table memory_objectives
--
--   -- CAP RACE — two sessions, proves the advisory lock rather than its presence:
--   --   Session A:  begin; select public.objective_ratify('captest','orch','o1',1);
--   --   Session B:  begin; select public.objective_ratify('captest','orch','o2',2);
--   --               -- B BLOCKS here until A commits or rolls back.
--   --   Session A:  rollback;   -- B then proceeds immediately
--   --   Different projects must NOT contend: rerun B against 'captest2' — no block.
--
--   -- Clean up the smoke rows
--   delete from public.memory_objectives where project in ('termdeck','captest','captest2') and ratified_by='orch';
--
-- 7b. Reversal (commented — apply by hand to roll back):
--
--   drop function if exists public.objective_ratify(text, text, text, smallint, uuid, jsonb);
--   drop function if exists public.objective_list(text);
--   -- The table holds ratified operator intent and its full history. Dropping it
--   -- is not part of a routine rollback; do it only if you mean it:
--   -- drop table if exists public.memory_objectives;
-- ====================================================================

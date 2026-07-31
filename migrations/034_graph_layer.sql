-- migrations/034_graph_layer.sql
-- Sprint 83 T1 (Graph layer) — give the ~7,400-edge relationship graph temporal
-- validity, a widening-safe typed-predicate vocabulary, an entity layer, and
-- the SQL surfaces the recall-telemetry label channel and the write-time
-- extractor have always lacked.
--
-- This file is the SINGLE frozen schema surface for Sprint 83 (ORCH RULING
-- 2026-07-31 14:42 ET). It reconciles T1's own SCHEMA-READY with T2's
-- SCHEMA-REQUEST (SR-1..SR-5) and T3's (REQ-1..REQ-4, I4-b), which were
-- authored concurrently. Where they disagreed, the consumer's contract won:
-- memory_expand_typed carries T3's REQ-1 signature verbatim because PostgREST
-- binds RPC arguments by NAME and T3 is its only caller.
--
-- WHY: five structural gaps, all of which make an existing asset unusable
-- rather than missing.
--
--   G1  NO TEMPORAL VALIDITY. memory_relationships has created_at and nothing
--       else. Nothing distinguishes a still-true edge from one that later
--       events invalidated, so a traversal cannot be trusted and the only
--       "retraction" available is DELETE — which destroys the provenance that
--       made the edge interesting. Community benchmarks rank valid_at /
--       invalid_at (invalidate-don't-delete) the single highest-value edge
--       semantic. Nothing in this migration, or this sprint, DELETEs an edge.
--
--   G2  NO PREDICATE DISCIPLINE, AND THE ENFORCEMENT MECHANISM ITSELF DRIFTS.
--       relationship_type is governed by a hard-coded CHECK re-authored three
--       times — 001 (5 values), 009 (8), 028 (10) — each restating the whole
--       list from scratch. 009's copy is already stale on disk. A CHECK is the
--       wrong shape for a vocabulary that grows: every widening is a full
--       rewrite, and a migration that restates it incompletely deletes values
--       from the language with no error. Replaced by a lookup table + FK, where
--       widening is one INSERT and forgetting is impossible. This also gives T2
--       what SR-2 asked for: ONE copy of the vocabulary, in SQL, so the
--       extractor never transcribes it into TS and drifts.
--
--   G3  NO ENTITY LAYER. Triples are stored (memory_relationships), but the
--       things they are about are not. Entity resolution and community
--       detection have nothing to converge on, because "the same entity
--       mentioned in N memories" is not representable without a canonical row.
--
--   G4  THE LABEL CHANNEL HAS NO SQL SURFACE ON THE DOMINANT PATH.
--       memory_recall_log.cited is the positive label every calibration,
--       pruning and elevation threshold is blocked on, and it is reachable only
--       through mark_recall_feedback() — which keys on "most recent log row per
--       memory_id". With several panels recalling concurrently that lands a
--       citation on ANOTHER panel's reinjection event: a silently mis-attributed
--       label, worse than no label (T2, SR-1). Migration 031 already stamps
--       recall_group_id on every hit row of a recall; the key exists, the writer
--       does not. §6 adds it, keyed on the group.
--
--   G5  CONSOLIDATION OUTPUT HAS NOWHERE LEGAL TO LAND. memory_items.source_type
--       is pinned by 028 to an 11-value allowlist, so a community-summary INSERT
--       raises 23514 (T3, I4-b). §2b extends it — see that section for why a
--       distinct source_type rather than metadata-only provenance.
--
-- WHAT:
--   §1  memory_relationships gains valid_at / invalid_at + partial live-edge
--       traversal indexes.
--   §2  public.memory_relationship_types — the vocabulary, as data; CHECK
--       introspected and dropped, FK put in its place.
--   §2b memory_items.source_type CHECK extended with 'consolidation_summary'.
--   §2c memory_hybrid_search replaced at the SAME signature to repair 033's
--       solved-problem decay profile (its two flattening arms keyed on
--       source_type values that the source_type CHECK makes impossible).
--   §3  memory_entity_types / memory_entities / memory_entity_mentions.
--   §4  Expression indexes for T2's problem_signature object shape (I3) and
--       T3's consolidation idempotency key (REQ-4).
--   §5  Edge lifecycle — invalidate by id, invalidate by endpoints, the
--       conservative supersession sweep, and upsert_memory_edges (SR-2: batch,
--       drop-invalid, resurrection-safe).
--   §6  memory_recall_log.group_resolved_at (SR-5) + mark_recall_cited_group
--       (SR-1 × SCHEMA-READY §7) — the label producer's entire SQL surface.
--   §7  memory_expand_typed (REQ-1 verbatim) + a same-signature replacement of
--       expand_memory_neighborhood that stops traversing invalidated edges.
--   §8  upsert_memory_entities (SR-3).
--
-- BACKWARD COMPATIBILITY, stated precisely because this migration touches a
-- table with ~7,400 live rows and a function two other functions depend on:
--   * Every existing edge stays valid. valid_at backfills from created_at,
--     invalid_at is NULL for all of them, and the FK is seeded from the table's
--     own DISTINCT relationship_type before it is added.
--   * expand_memory_neighborhood is replaced at the IDENTICAL signature
--     (uuid, int) — no second overload, grants preserved on the same OID — and
--     its only behavioral change is `and r.invalid_at is null`. On apply day
--     every edge is live, so memory_recall_graph's output is bit-identical; the
--     change takes effect from the first invalidation forward.
--   * NO defaulted parameters are added to any existing function, and no
--     function here has more than one signature. Adding an overload makes every
--     existing call ambiguous and PostgREST answers "could not find the
--     function" — the 15-sprint 404 outage documented at
--     mnestra-bridge/index.js:96-110. The receipt asserts single-overload on
--     every function it touches.
--
-- ⚠ CREATE OR REPLACE AND proconfig: replacing a function REPLACES its
--   proconfig. expand_memory_neighborhood's `search_path=public, extensions,
--   pg_catalog` was set by migration 019 via ALTER FUNCTION, NOT in 009's
--   CREATE — so a CREATE OR REPLACE without an explicit SET clause silently
--   nulls it and un-hardens GATE 4. §7b re-pins it in-statement, and the
--   receipt fails the apply if it is missing.
--
-- Five RLS hygiene gates (global CLAUDE.md § "Supabase RLS + privilege
-- hygiene"), marked [GATE n] inline and verified by the HARD-FAILING receipt in
-- §10 (apply_migration has a known silent-no-op failure mode, so a receipt that
-- cannot fail is not a receipt — 026/027/031/033 precedent):
--   GATE 1  RLS enabled on all four new tables in this same migration.
--   GATE 2  NO policies at all. RLS-on + zero-policies denies anon and
--           authenticated everything; service_role bypasses RLS by design.
--           No WITH CHECK (true) anywhere in this file.
--   GATE 3  REVOKE EXECUTE ... FROM public, anon, authenticated on every
--           function + targeted GRANT to service_role. MANDATORY, not
--           defensive: migration 014:45 sets `alter default privileges in
--           schema public grant execute on functions to service_role,
--           authenticated, anon`, so every function created here is
--           anon-executable the instant it exists until revoked.
--   GATE 4  SET search_path on every function. The two traversal functions use
--           `public, extensions, pg_catalog` (019's exact pin on
--           expand_memory_neighborhood; REQ-1i for memory_expand_typed); the
--           rest use `public, pg_catalog` — no vector types in their
--           signatures, so `extensions` is unnecessary (027/031 precedent).
--   GATE 5  No raw anon-key write path. Table grants revoked from public, anon,
--           authenticated on all four new tables; the only writers are the
--           SECURITY DEFINER functions below, all service_role-only. The two
--           read-only traversal functions stay INVOKER and STABLE.
--
-- Idempotent / rerun-safe: ADD COLUMN IF NOT EXISTS; CREATE TABLE/INDEX IF NOT
-- EXISTS; INSERT ... ON CONFLICT DO NOTHING; the CHECK-drops and FK-add are
-- guarded DO blocks; CREATE OR REPLACE FUNCTION; REVOKE/GRANT and ENABLE RLS
-- are naturally idempotent; the receipt only SELECTs (and raises). Re-applying
-- re-verifies the gates.
--
-- APPLY: write + test locally only. Nobody applies this to the daily-driver
-- project from a lane — ORCH applies at sprint close (PLANNING.md § Non-goals),
-- then runs the commented post-apply verification in §11 and the five-gate
-- get_advisors check.

-- ====================================================================
-- 1. Temporal validity on memory_relationships
-- ====================================================================

-- Added NULLABLE first, then backfilled, then defaulted, then made NOT NULL.
-- The one-shot `add column valid_at timestamptz not null default now()` would
-- take Postgres' fast path and stamp all ~7,400 existing rows with the SINGLE
-- apply-time transaction timestamp — throwing away the true creation time this
-- column exists to carry. Four statements, correct history.
alter table public.memory_relationships
  add column if not exists valid_at   timestamptz,
  add column if not exists invalid_at timestamptz;

update public.memory_relationships
   set valid_at = created_at
 where valid_at is null;

alter table public.memory_relationships
  alter column valid_at set default now();

alter table public.memory_relationships
  alter column valid_at set not null;

comment on column public.memory_relationships.valid_at is
  'Sprint 83: when this edge became true. Backfilled from created_at at 034 '
  'apply; defaults to now() for new edges. Distinct from created_at, which is '
  'when the ROW was written — an extractor may assert an edge that became true '
  'earlier.';

comment on column public.memory_relationships.invalid_at is
  'Sprint 83: when this edge stopped being true. NULL = LIVE. Invalidate, '
  'never DELETE — a retracted edge is evidence, and the provenance in '
  'inferred_by/inferred_at is what makes it evidence. Every traversal in this '
  'migration filters on invalid_at IS NULL.';

-- Live-edge traversal indexes. The bidirectional walk joins on
-- `(source_id = n OR target_id = n)`, which the planner serves as a BitmapOr of
-- two index scans — hence one partial index per endpoint rather than a
-- composite. relationship_type rides along so a predicate-filtered expansion
-- (memory_expand_typed's p_predicates) is answered from the index. Both are
-- restricted to live edges, which is the only thing any traversal here reads.
create index if not exists memory_relationships_live_source_idx
  on public.memory_relationships (source_id, relationship_type)
  where invalid_at is null;

create index if not exists memory_relationships_live_target_idx
  on public.memory_relationships (target_id, relationship_type)
  where invalid_at is null;

-- ====================================================================
-- 2. Predicate vocabulary — as DATA, not as a CHECK
-- ====================================================================

create table if not exists public.memory_relationship_types (
  type        text primary key,
  description text not null default '',
  added_in    text not null default ''
);

comment on table public.memory_relationship_types is
  'Sprint 83: the relationship_type vocabulary, as data. memory_relationships '
  'has an FK onto this table, and upsert_memory_edges validates against it — so '
  'the vocabulary exists in exactly ONE place and no client transcribes it. '
  'Widening is one INSERT ... ON CONFLICT DO NOTHING, never a CHECK rewrite. '
  'Rows are never deleted: the FK refuses while any edge still uses the value.';

-- The 14 shipped predicates. The first 10 are the live/declared vocabulary
-- (001 -> 009 -> 028); the last 4 are Sprint 83's additions. caused_by is NOT
-- new — 106 live edges going back to 2026-04-13 — and is listed in its original
-- position.
--
-- DIRECTION SEMANTICS (T3 REQ-2). For every ASYMMETRIC predicate, the
-- convention is fixed here and nowhere else: read every edge as
--     source_id --predicate--> target_id
-- as an English sentence with source as the subject. So for `A --fixed_by--> B`,
-- A is the PROBLEM and B is the FIX. The `direction` column returned by
-- memory_expand_typed says which end the traversal arrived from, which is what
-- lets the caller phrase it correctly rather than guess:
--
--   predicate         | source_id is…      | target_id is…       | symmetric?
--   ------------------+--------------------+---------------------+-----------
--   supersedes        | the NEWER memory   | the STALE memory    | no
--   caused_by         | the EFFECT/symptom | the CAUSE           | no
--   fixed_by          | the PROBLEM        | the FIX             | no
--   same_pattern_as   | one instance       | the other instance  | YES
--   relates_to        | either             | either              | YES
--   contradicts       | the asserter       | the contradicted    | no (weakly)
--   elaborates        | the DETAIL         | the thing detailed  | no
--   blocks            | the BLOCKER        | the blocked         | no
--   inspired_by       | the derived work   | the inspiration     | no
--   cross_project_link| either             | either              | YES
--   amends_rule       | the AMENDMENT      | the doctrine rule   | no
--   elevated_to       | the source memory  | the doctrine entry  | no
--   documented_at     | the thing          | its documentation   | no
--   part_of           | the COMPONENT      | the whole           | no
--
-- Worked example for the "you solved this before" copy (T3's use case):
-- seed = A, edge `A --fixed_by--> B`, traversal walked A→B, direction =
-- 'outbound' ⇒ B is the fix ⇒ "you fixed this before: B". Seed = B, same edge,
-- traversal walked B→A, direction = 'inbound' ⇒ A is the problem ⇒ "this is the
-- fix for A".
insert into public.memory_relationship_types (type, description, added_in) values
  ('supersedes',         'source is the newer memory; target is stale.',                          '001'),
  ('relates_to',         'Generic association, the graph-inference default. Symmetric.',          '001'),
  ('contradicts',        'source asserts something incompatible with target.',                    '001'),
  ('elaborates',         'source adds detail to target without replacing it.',                    '001'),
  ('caused_by',          'source is the effect/symptom; target is the cause.',                    '001'),
  ('blocks',             'source blocks progress on target.',                                     '009'),
  ('inspired_by',        'source was prompted by target. Declared, no live edges yet.',           '009'),
  ('cross_project_link', 'Association spanning two project tags. Symmetric.',                     '009'),
  ('amends_rule',        'source is the amendment; target is the doctrine rule.',                 '028'),
  ('elevated_to',        'source memory was elevated into the doctrine entry at target.',         '028'),
  ('same_pattern_as',    'source and target are instances of one recurring problem class. Symmetric.', '034'),
  ('fixed_by',           'source is the PROBLEM; target is the FIX.',                             '034'),
  ('documented_at',      'source is the thing; target documents it (doc, ADR, sprint record).',   '034'),
  ('part_of',            'source is a component of the larger unit at target.',                   '034')
on conflict (type) do nothing;

-- THE BACKWARD-COMPATIBILITY GUARANTEE. Before the FK exists, adopt every
-- distinct value the table already contains on THIS install. Seeding only the
-- 14 above would be correct for the reference install and a hard apply failure
-- for any install carrying a value this file has not heard of — a third-party
-- writer, a hand-inserted edge, a graph-inference vocabulary that shipped ahead
-- of its migration. This makes "every existing live edge remains valid" a
-- property of the mechanism rather than of my inventory being right.
insert into public.memory_relationship_types (type, description, added_in)
select distinct
       r.relationship_type,
       'Value discovered in memory_relationships at 034 apply time and adopted '
       'so the FK could not reject an existing edge. Describe it when its '
       'writer is identified.',
       'pre-034 (adopted)'
  from public.memory_relationships r
 where r.relationship_type is not null
on conflict (type) do nothing;

-- Drop whatever CHECK currently governs relationship_type. Its name is not
-- reliable across installs — 001 defined it inline (auto-generated name), 009
-- and 028 gave it an explicit one — so introspect by DEFINITION, exactly as
-- 009:31-46 did. The predicate matches only constraints mentioning
-- relationship_type, so a separate (source_id <> target_id) CHECK survives.
do $$
declare
  c record;
begin
  for c in
    select con.conname
      from pg_constraint con
      join pg_class cls on cls.oid = con.conrelid
      join pg_namespace nsp on nsp.oid = cls.relnamespace
     where nsp.nspname = 'public'
       and cls.relname = 'memory_relationships'
       and con.contype = 'c'
       and pg_get_constraintdef(con.oid) ilike '%relationship_type%'
  loop
    execute format('alter table public.memory_relationships drop constraint %I', c.conname);
    raise notice '[034] dropped CHECK % (superseded by FK to memory_relationship_types)', c.conname;
  end loop;
end
$$;

-- The FK. Guarded so a re-apply is a no-op rather than a duplicate-name error.
-- ON UPDATE CASCADE so renaming a predicate is possible without orphaning
-- edges; no ON DELETE clause, so the default (NO ACTION) refuses to delete a
-- vocabulary row any edge still uses — the desired behavior.
do $$
begin
  if not exists (
    select 1
      from pg_constraint con
      join pg_class cls on cls.oid = con.conrelid
      join pg_namespace nsp on nsp.oid = cls.relnamespace
     where nsp.nspname = 'public'
       and cls.relname = 'memory_relationships'
       and con.contype = 'f'
       and con.conname = 'memory_relationships_relationship_type_fkey'
  ) then
    alter table public.memory_relationships
      add constraint memory_relationships_relationship_type_fkey
      foreign key (relationship_type)
      references public.memory_relationship_types (type)
      on update cascade;
  end if;
end
$$;

-- [GATE 1] / [GATE 2] / [GATE 5]
alter table public.memory_relationship_types enable row level security;
revoke all on table public.memory_relationship_types from public, anon, authenticated;

-- ====================================================================
-- 2b. memory_items.source_type — extend with 'consolidation_summary'
-- ====================================================================
--
-- T3's I4-b(1), granted as option (a). Migration 028:253-260 pins source_type to
-- 11 values, so a consolidation community-summary INSERT raises 23514 and
-- deliverable 2 cannot write its output at all.
--
-- WHY A DISTINCT source_type RATHER THAN metadata-ONLY PROVENANCE: T3's
-- acceptance bar says consolidation products must be provenance-marked "so it
-- can never impersonate a primary memory." Metadata-only provenance makes
-- non-impersonation conditional on every present and future consumer
-- remembering to read metadata.consolidation — the flashback toast,
-- memory_recall output, doctrine-scan's clustering input, the Obsidian
-- exporter, and whatever ships next sprint. That is the
-- convention-instead-of-enforcement pattern the global rules single out. A
-- distinct source_type makes it structural: filter_source_type excludes them,
-- memory_hybrid_search can be told to skip them, and they are visibly
-- non-primary in every listing without a metadata probe. It also lets the
-- graph-inference candidate query exclude them with an indexed `source_type <>`
-- test instead of an unindexed jsonb predicate on the hot nightly path (T3's
-- I4-b(2) self-amplification defense).
--
-- Acknowledged tension: this is the same CHECK-as-vocabulary shape §2 just
-- replaced for relationship_type. Converting source_type to a lookup table is
-- NOT done here — memory_items is the core table with many consumers and a
-- generated content_hash, and that conversion is a sprint of its own with a real
-- blast radius. 028's DROP/ADD pattern is followed exactly, all 11 existing
-- values preserved verbatim, one arm added.
alter table public.memory_items
  drop constraint if exists memory_items_source_type_check;
alter table public.memory_items
  add constraint memory_items_source_type_check
  check (source_type = any (array[
    'fact', 'decision', 'preference', 'bug_fix', 'architecture', 'code_context',
    'session_summary', 'document_chunk', 'commit_context', 'pre_compact_snapshot',
    'doctrine',
    'consolidation_summary'
  ]));

-- ====================================================================
-- 2c. memory_hybrid_search — repair the solved-problem decay profile
-- ====================================================================
--
-- T3's 14:48 FINDING, folded in per ORCH nudge-4. Migration 033 shipped a
-- `solved-problem` decay profile whose two flattening arms key on
-- `e.source_type`:
--
--     when 'convention'      then  90.0                      -- 033:447
--     when 'debugging'       then <365 if solved-problem>     -- 033:451-453
--
-- Neither value is a legal source_type. 028's memory_items_source_type_check
-- pins the column to 11 values (fact, decision, preference, bug_fix,
-- architecture, code_context, session_summary, document_chunk, commit_context,
-- pre_compact_snapshot, doctrine) and neither `debugging` nor `convention` is
-- among them. Because 028's ADD CONSTRAINT succeeded, no row could ever have
-- violated it — so those arms are unreachable BY CONSTRUCTION, not merely
-- unused. They are Category values (src/types.ts:5) that were written as if they
-- were SourceType values (src/types.ts:14).
--
-- Measured live, read-only (is_active and not archived, 8,910 rows):
--     source_type = 'bug_fix'                              252
--     category    = 'debugging'                            550
--     category = 'debugging' AND source_type <> 'bug_fix'   379
--     source_type in ('debugging','convention')               0
--
-- Of those 379, only 324 CHANGE BEHAVIOUR, and the distinction matters enough to
-- record. Breakdown of category='debugging' by source_type, with each type's
-- standard decay tier:
--     fact            322   90d  -> 365d   flattened
--     bug_fix         171   30d  -> 365d   already covered by 033
--     decision         42  365d  -> 365d   NO-OP (already the top tier)
--     architecture     12  365d  -> 365d   NO-OP
--     code_context      2   14d  -> 365d   flattened
--     preference        1  365d  -> 365d   NO-OP
-- So the fix newly protects 324 memories (322 fact + 2 code_context); the other
-- 55 were never buried because decision/architecture/preference/doctrine already
-- sit at 365d. Post-fix, every solved-problem-class memory that COULD be buried
-- is protected. Worth stating because a future test that picks a
-- decision+debugging row to prove the fix will observe NOTHING and read as a
-- regression — the observable population is the sub-365d tiers.
--
-- So `p_decay_profile='solved-problem'` reached 252 of ~631 solved-problem-class
-- memories — 40% — while the function's own COMMENT (033:514) advertised
-- "bug_fix/debugging". The 379 debugging-class memories written under a
-- decision/fact/code_context type kept their standard half-life and stayed
-- buried at exactly the moment a recurrence makes them most valuable. Nothing
-- about it looks broken from outside: the profile IS applied, it just silently
-- covers less than half its population. That is also the seed pool for Sprint
-- 83's "you solved this before" surface, so the graph layer would have inherited
-- the same 40% ceiling.
--
-- THE FIX — exactly two arms, no other change:
--   * the debugging arm now keys on `e.category = 'debugging'` (available in the
--     `enriched` CTE at 033:391 and already returned by the function at 033:301);
--   * the dead `convention` arm is dropped.
-- The condition is hoisted into a searched CASE so it can test category and
-- source_type together; the inner CASE is 033's table verbatim minus those two
-- arms. `p_decay_profile='standard'` is unchanged TO THE BIT — the new WHEN is
-- false for every standard call, and removing arms nothing could match cannot
-- alter a result.
--
-- ⚠ SAME-SIGNATURE REPLACE, AND WHY NOT A DROP. This is CREATE OR REPLACE at the
-- identical 10-arg signature: same OID, so 019/033's grants survive and no
-- second overload appears (a 10-arg call matching two candidates is the
-- "function is not unique" failure 033:521-526 went out of its way to avoid).
-- 033 had to DROP first only because it was ADDING two parameters; we are not.
--
-- ⚠ BOTH SET CLAUSES ARE RESTATED BELOW. CREATE OR REPLACE replaces proconfig
-- wholesale — omitting them would null BOTH the GATE 4 search_path pin AND
-- 033's hnsw.ef_search=120 tuning, silently un-hardening the function and
-- de-tuning the vector branch in one statement. This is the same proconfig trap
-- §7b documents for expand_memory_neighborhood; here it has two victims.
--
-- memory_hybrid_search_explain is deliberately NOT touched: it takes the same 10
-- args and DELEGATES (033:564-578, `select * from public.memory_hybrid_search(
-- $1..$10)`) rather than duplicating the decay CASE, so it inherits this fix and
-- stays in lockstep by construction. The §10 receipt re-asserts both functions
-- are still single-overload, so a future divergence fails the apply.

create or replace function public.memory_hybrid_search (
  query_text          text,
  query_embedding     vector(1536),
  match_count         int default 20,
  full_text_weight    float default 1.0,
  semantic_weight     float default 1.0,
  rrf_k               int default 60,
  filter_project      text default null,
  filter_source_type  text default null,
  p_branch_limit      int default 60,
  p_decay_profile     text default 'standard'
)
returns table (
  id                  uuid,
  content             text,
  source_type         text,
  category            text,
  project             text,
  metadata            jsonb,
  score               float,
  created_at          timestamptz,
  privacy_tags        text[],
  semantic_similarity double precision
)
language sql stable
set search_path = public, extensions, pg_catalog  -- [GATE 4] restated: see above
set hnsw.ef_search = '120'                        -- 033's tuning, restated
as $$
-- PHASE 1a — full-text branch. GIN-servable: the `@@` predicate matches
-- memory_items_content_fts_gin, so ts_rank_cd is computed only for documents
-- that actually match, never for the corpus. `nulls last` mirrors 032; the
-- `, id` tiebreak is change S4 (determinism).
with ft_branch as materialized (
  select t.id,
         row_number() over (order by t.ft_rank desc nulls last, t.id) as rank
    from (
      select m.id,
             ts_rank_cd(
               to_tsvector('english', m.content),
               plainto_tsquery('english', query_text)
             ) as ft_rank
        from public.memory_items m
       where m.is_active = true
         and m.archived = false
         and m.superseded_by is null
         and m.embedding is not null
         and (filter_project is null or m.project = filter_project)
         and (filter_source_type is null or m.source_type = filter_source_type)
         -- The index-matching predicate. Equivalent in practice to 032's
         -- `where ft_rank > 0` (a document scores 0 exactly when it does not
         -- match), but expressed as an operator the GIN index can answer.
         -- NULL/empty query_text yields a NULL/empty tsquery → zero rows,
         -- matching 032's behavior for the same input.
         and to_tsvector('english', m.content)
             @@ plainto_tsquery('english', query_text)
       order by ft_rank desc nulls last, m.id
       limit least(
               greatest(coalesce(p_branch_limit, 60), greatest(match_count, 1)),
               500
             )
    ) t
),
-- PHASE 1b — semantic branch. `order by <=> limit` over the filter set is the
-- canonical pgvector HNSW shape. The `query_embedding is not null` guard is
-- change S3: with no embedding there is no semantic signal, so the branch
-- yields nothing rather than an arbitrary ordering of NULL distances.
vec_branch as materialized (
  select t.id,
         row_number() over (order by t.dist asc nulls last, t.id) as rank
    from (
      select m.id,
             (m.embedding <=> query_embedding) as dist
        from public.memory_items m
       where m.is_active = true
         and m.archived = false
         and m.superseded_by is null
         and m.embedding is not null
         and query_embedding is not null
         and (filter_project is null or m.project = filter_project)
         and (filter_source_type is null or m.source_type = filter_source_type)
       -- NO secondary sort key here, deliberately — unlike the full-text branch
       -- above. `<=>` alone is the ordering pgvector's HNSW AM can satisfy
       -- directly; adding `, m.id` forces the planner to sort on a key the
       -- index cannot provide, and the whole point of this branch is that the
       -- index serves the ordering. The deterministic `, t.id` tiebreak is
       -- applied in the row_number() window OUTSIDE this subquery instead,
       -- where it operates on ≤branch_limit already-fetched rows and costs
       -- nothing. Residual nondeterminism is limited to which rows sit exactly
       -- on the top-k boundary when two float8 distances are bit-identical.
       order by m.embedding <=> query_embedding
       limit least(
               greatest(coalesce(p_branch_limit, 60), greatest(match_count, 1)),
               500
             )
    ) t
),
-- PHASE 2 — fuse. Everything below runs on ≤2×branch_limit rows.
fused_ids as (
  select id from ft_branch
  union
  select id from vec_branch
),
enriched as (
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
    extract(epoch from (now() - m.created_at))::float as age_seconds,
    -- Defect D3: the cosine is RETURNED now, not discarded. Recomputed here
    -- (not carried from vec_branch) so FTS-only rows carry it too — contract
    -- I1 promises every returned row has it. NULL only when the caller gave us
    -- no embedding to compare against.
    case
      when query_embedding is null then null::double precision
      else (1 - (m.embedding <=> query_embedding))::double precision
    end as semantic_similarity,
    -- Reciprocal-rank fusion, arithmetically identical to 032:226-227 — the
    -- only difference is that `rank` is now a within-top-k rank (change S2).
    coalesce(full_text_weight / (rrf_k + ft.rank), 0.0) +
    coalesce(semantic_weight  / (rrf_k + vb.rank), 0.0) as base_score
  from fused_ids f
  join public.memory_items m on m.id = f.id
  left join ft_branch  ft on ft.id = f.id
  left join vec_branch vb on vb.id = f.id
),
scored as (
  select
    e.id,
    e.content,
    e.source_type,
    e.category,
    e.project,
    e.metadata,
    e.privacy_tags,
    e.created_at,
    e.semantic_similarity,
    e.base_score
      -- FACTOR 1 — tiered recency decay. Refactored from 032:243-256's
      -- eleven-arm CASE-of-whole-expressions into one CASE over the decay
      -- CONSTANT, which is the only thing that ever varied. Same formula
      -- 1/(1 + age/(days × 86400)), same constants, same result to the bit for
      -- p_decay_profile = 'standard' — and it makes the solved-problem profile
      -- a two-token change instead of a duplicated eleven-arm block.
      --
      -- p_decay_profile = 'solved-problem' flattens ONLY bug_fix and debugging
      -- from 30d to 365d. A six-month-old solved bug is multiplied by ~0.14
      -- under 'standard' — buried exactly when a recurrence makes it most
      -- valuable. Every other type is untouched. Any unknown or NULL value
      -- falls through to 'standard'; this never raises.
      * (1.0 / (1.0 + e.age_seconds / (
          case
            -- Sprint 83 (034 §2c) — THE FIX. 033 keyed both solved-problem arms
            -- on e.source_type, but 'debugging' is a CATEGORY, not a
            -- source_type: 028's memory_items_source_type_check pins the column
            -- to 11 values and 'debugging'/'convention' are not among them, so
            -- both arms were unreachable BY CONSTRUCTION. Measured on the live
            -- corpus (8,910 active rows): source_type='bug_fix' 252,
            -- category='debugging' 550, of which 379 carry some other
            -- source_type, and source_type in ('debugging','convention') = 0.
            -- The profile therefore flattened 252 of ~631 solved-problem-class
            -- memories — 40% — while its own comment claimed
            -- "bug_fix/debugging". The other 379 stayed buried at exactly the
            -- moment a recurrence makes them most valuable.
            when coalesce(p_decay_profile, 'standard') = 'solved-problem'
             and (e.source_type = 'bug_fix' or e.category = 'debugging')
              then 365.0
            else
              -- 033's table, verbatim, minus the two dead arms. Removing them is
              -- behaviour-identical because no row could ever have matched them;
              -- 'standard' output is unchanged to the bit.
              case e.source_type
                when 'decision'        then 365.0
                when 'architecture'    then 365.0
                when 'preference'      then 365.0
                when 'doctrine'        then 365.0
                when 'fact'            then  90.0
                when 'bug_fix'         then  30.0
                when 'session_summary' then  14.0
                when 'document_chunk'  then  14.0
                when 'code_context'    then  14.0
                else                         30.0
              end
          end * 86400.0)))
      -- FACTOR 2 — source_type weight. Verbatim 032:257-266.
      * case e.source_type
          when 'decision'       then 1.5
          when 'doctrine'       then 1.5
          when 'architecture'   then 1.4
          when 'bug_fix'        then 1.3
          when 'preference'     then 1.2
          when 'fact'           then 1.0
          when 'document_chunk' then 0.6
          else                       1.0
        end
      -- FACTOR 3 — project affinity. Verbatim 032:267-272.
      * case
          when filter_project is null then 1.0
          when e.project = filter_project then 1.5
          when e.project = 'global' then 1.0
          else 0.7
        end
      -- FACTOR 4 — Sprint 81 (032:273-279) recall-usage boost. Verbatim:
      -- bounded multiplier, STRICT no-op at 1.0, floor 1.0 (never a penalty —
      -- pruning moratorium), ceiling 2.0 = RECALL_BOOST_MAX (no
      -- rich-get-richer). Unchanged by this migration.
      * (least(greatest(coalesce(e.recall_boost, 1.0), 1.0), 2.0))::double precision
      as score
  from enriched e
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
  s.privacy_tags,
  s.semantic_similarity
from scored s
-- `, s.id` is change S4. The match_count cap (004) is preserved verbatim.
order by s.score desc, s.id
limit least(
  greatest(match_count, 1),
  coalesce(nullif(current_setting('mnestra.max_match_count', true), '')::int, 200)
);
$$;

comment on function public.memory_hybrid_search(text, vector, int, float, float, int, text, text, int, text) is
  'Sprint 82 (033) two-phase top-k hybrid recall, with Sprint 83 (034) repairing '
  'the solved-problem decay profile. Each branch takes its own INDEX-SERVED '
  'top-k first (GIN on to_tsvector for full-text, HNSW for vector), then RRF '
  'fusion and the decay/type/project/recall_boost stack run only on the union. '
  '`score` is an ORDINAL RRF composite with a hard ceiling near 0.074 and must '
  'never be rendered as a similarity percentage; semantic_similarity is the '
  'cardinal, cross-query-comparable signal. p_decay_profile = ''solved-problem'' '
  'flattens decay from its standard tier to 365d for source_type = ''bug_fix'' OR '
  'category = ''debugging'' — the CATEGORY test is the 034 fix; 033 keyed both '
  'arms on source_type, where ''debugging'' is not a legal value, so the profile '
  'reached only 40% of its intended population. Read-only, SECURITY INVOKER, '
  'pinned search_path; EXECUTE: service_role only.';

-- [GATE 3] Re-pinned in-statement. CREATE OR REPLACE preserves grants on the
-- same OID, so this is belt-and-suspenders rather than a repair — but it keeps
-- the receipt honest against a hand-edited install, and it costs nothing.
revoke execute on function public.memory_hybrid_search(text, vector, int, float, float, int, text, text, int, text)
  from public, anon, authenticated;
grant  execute on function public.memory_hybrid_search(text, vector, int, float, float, int, text, text, int, text)
  to service_role;

-- ====================================================================
-- 3. Entity layer  (T3 REQ-3: this section IS the confirmed shape)
-- ====================================================================
--
-- TABLES, NOT metadata JSONB. The deciding requirement is entity RESOLUTION:
-- consolidation has to converge "the same entity mentioned in N memories" onto
-- one thing and then run connected components over the result. A JSONB array
-- per memory can hold the mentions but not the identity — there is no row for
-- the components pass to group on, and dedup degrades to scanning every
-- document. A canonical entity row plus a mention join gives both.
--
-- T3 reads these directly over postgres.js — no RPC needed, and none is
-- provided for reads. Write-time resolution (normalize + exact match) lives in
-- upsert_memory_entities (§8); DEEP resolution/merging is T3's consolidation and
-- operates on entity records only.

create table if not exists public.memory_entity_types (
  entity_type text primary key,
  description text not null default '',
  added_in    text not null default ''
);

comment on table public.memory_entity_types is
  'Sprint 83: the entity_type vocabulary, as data — same widening-safe shape as '
  'memory_relationship_types, and the single source upsert_memory_entities '
  'validates against. Adding a type is one INSERT.';

insert into public.memory_entity_types (entity_type, description, added_in) values
  ('file',          'A path in a repository.',                                          '034'),
  ('symbol',        'A function, class, method, or exported identifier.',               '034'),
  ('error_class',   'A concrete error/exception identity (message shape or code).',     '034'),
  ('problem_class', 'A problem-taxonomy entry; pairs with problem_signature.class.',    '034'),
  ('project',       'A project tag from the canonical taxonomy.',                       '034'),
  ('sprint',        'A sprint identifier.',                                             '034'),
  ('package',       'A published or vendored package.',                                 '034'),
  ('service',       'An external or internal running service.',                         '034'),
  ('command',       'A CLI command or script invocation.',                              '034'),
  ('env_var',       'An environment variable NAME. Never a value.',                     '034'),
  ('person',        'A human collaborator.',                                            '034'),
  ('concept',       'A named technique, pattern, or architectural idea.',               '034')
on conflict (entity_type) do nothing;

create table if not exists public.memory_entities (
  id            uuid primary key default gen_random_uuid(),

  -- The DEDUP/CANONICAL key: normalized (btrim + lower) surface form, applied
  -- server-side by upsert_memory_entities so no client can skip it. Unique per
  -- type, so 'index.ts' the file and 'index.ts' the symbol stay distinct.
  entity_key    text not null,
  entity_type   text not null references public.memory_entity_types (entity_type) on update cascade,

  -- The human-facing form, as first seen. Never used for matching.
  display_name  text not null,

  -- Aliases and anything else the extractor retained. Merge target for T3's
  -- consolidation-time entity resolution.
  metadata      jsonb       not null default '{}'::jsonb,

  first_seen_at timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),

  -- Denormalized. memory_entity_mentions is the source of truth; this is the
  -- cheap ordering key for "most-mentioned entities" without a group-by.
  mention_count int not null default 0,

  constraint memory_entities_key_not_blank check (length(btrim(entity_key)) > 0),
  unique (entity_type, entity_key)
);

comment on table public.memory_entities is
  'Sprint 83: canonical entities extracted at write time. One row per '
  '(entity_type, normalized entity_key) — the row entity resolution converges '
  'on and community detection groups over. Service-role-only; RLS on, no '
  'policies.';

create table if not exists public.memory_entity_mentions (
  memory_id  uuid not null references public.memory_items(id)    on delete cascade,
  entity_id  uuid not null references public.memory_entities(id) on delete cascade,

  -- The surface form as it appeared in THIS memory (may differ from
  -- display_name); NULL when the extractor did not retain a span.
  span       text,
  confidence double precision,
  created_at timestamptz not null default now(),

  primary key (memory_id, entity_id),
  constraint memory_entity_mentions_confidence_range
    check (confidence is null or (confidence >= 0.0 and confidence <= 1.0))
);

comment on table public.memory_entity_mentions is
  'Sprint 83: which memory mentions which entity. PK (memory_id, entity_id) '
  'makes re-extraction of the same memory idempotent. ON DELETE CASCADE from '
  'both sides — the one place in the graph layer where deletion is correct: a '
  'mention is a pointer, not an assertion that can be retracted.';

-- entity_id-first: the PK serves memory -> entities; this serves
-- entities -> memories, the direction consolidation walks.
create index if not exists memory_entity_mentions_entity_idx
  on public.memory_entity_mentions (entity_id);

create index if not exists memory_entities_key_idx
  on public.memory_entities (entity_key);

-- [GATE 1] / [GATE 2] / [GATE 5]
alter table public.memory_entities        enable row level security;
alter table public.memory_entity_mentions enable row level security;
alter table public.memory_entity_types    enable row level security;
revoke all on table public.memory_entities        from public, anon, authenticated;
revoke all on table public.memory_entity_mentions from public, anon, authenticated;
revoke all on table public.memory_entity_types    from public, anon, authenticated;

-- ====================================================================
-- 4. Expression indexes — problem_signature (T2 I3 / SR-4) + REQ-4
-- ====================================================================
--
-- problem_signature itself stays in memory_items.metadata — its SHAPE is T2's
-- (I3) and needs no DDL. What needs DDL is making T3's symptom lookup
-- index-servable rather than a jsonb scan, because it sits on the error-recall
-- path where latency is visible.
--
-- Pointed at T2's frozen OBJECT shape: metadata.problem_signature is one object
-- key (chosen because remember.ts:250 shallow-merges metadata on a dedup
-- reinforcement, so sibling scalars can desync across two writes). Both of T3's
-- match paths get an index: exact on symptom_hash, class-level on class.
create index if not exists memory_items_problem_signature_class_idx
  on public.memory_items ((metadata->'problem_signature'->>'class'))
  where metadata ? 'problem_signature';

create index if not exists memory_items_problem_signature_hash_idx
  on public.memory_items ((metadata->'problem_signature'->>'symptom_hash'))
  where metadata ? 'problem_signature';

-- T3 REQ-4 — TAKEN (it is two lines, and structural insurance beats a
-- SELECT-then-update race even for a single-runner nightly job). Partial UNIQUE
-- so a second consolidation run cannot create a duplicate summary for a
-- community it already summarized.
create unique index if not exists memory_items_consolidation_community_key_idx
  on public.memory_items ((metadata->'consolidation'->>'community_key'))
  where metadata->'consolidation'->>'kind' = 'community_summary';

-- ====================================================================
-- 5. Edge lifecycle — invalidate, supersession sweep, batch upsert
-- ====================================================================

-- 5a. Invalidate one edge by id.
create or replace function public.memory_invalidate_edge(
  p_edge_id uuid,
  p_at      timestamptz default now()
)
returns int
language plpgsql
security definer
set search_path = public, pg_catalog  -- [GATE 4]
as $$
declare
  v_updated int := 0;
begin
  if p_edge_id is null then
    return 0;
  end if;

  -- `invalid_at is null` makes this idempotent AND makes it preserve the
  -- ORIGINAL invalidation time: re-invalidating an already-dead edge must not
  -- move the timestamp, or the history the column exists to record is lost.
  update public.memory_relationships
     set invalid_at = coalesce(p_at, now())
   where id = p_edge_id
     and invalid_at is null;

  get diagnostics v_updated = row_count;
  return v_updated;
end;
$$;

comment on function public.memory_invalidate_edge(uuid, timestamptz) is
  'Sprint 83: mark one edge invalid (invalidate-don''t-delete). Idempotent; a '
  'repeat call returns 0 and leaves the original invalid_at intact. SECURITY '
  'DEFINER, pinned search_path; EXECUTE: service_role only.';

-- 5b. Invalidate by endpoints (+ optional type). DIRECTED: invalidates edges
--     FROM p_source_id TO p_target_id, not the reverse. Callers meaning "both
--     directions" call twice — an undirected default would make it too easy to
--     retract an assertion nobody asked to retract.
create or replace function public.memory_invalidate_edges(
  p_source_id         uuid,
  p_target_id         uuid,
  p_relationship_type text default null,
  p_at                timestamptz default now()
)
returns int
language plpgsql
security definer
set search_path = public, pg_catalog  -- [GATE 4]
as $$
declare
  v_updated int := 0;
begin
  if p_source_id is null or p_target_id is null then
    return 0;
  end if;

  update public.memory_relationships
     set invalid_at = coalesce(p_at, now())
   where source_id = p_source_id
     and target_id = p_target_id
     and (p_relationship_type is null or relationship_type = p_relationship_type)
     and invalid_at is null;

  get diagnostics v_updated = row_count;
  return v_updated;
end;
$$;

comment on function public.memory_invalidate_edges(uuid, uuid, text, timestamptz) is
  'Sprint 83: mark every LIVE edge from source to target (optionally of one '
  'type) invalid. DIRECTED — does not touch target->source. Idempotent. '
  'SECURITY DEFINER, pinned search_path; EXECUTE: service_role only.';

-- 5c. Supersession sweep — DELIBERATELY NARROW.
--
--     When memory B supersedes memory A, which of A's edges stop being true?
--     The conservative answer, and the one shipped: A's OUTBOUND `contradicts`
--     edges, and nothing else.
--
--       * outbound contradicts — A's assertion that it is incompatible with
--         something. A is superseded, so A no longer asserts it. Retract.
--       * relates_to / elaborates / caused_by / ... — relatedness is not a claim
--         supersession refutes. A superseded memory is still about what it was
--         about. Retracting these on every supersede would invalidate a large
--         fraction of a 6,000-edge relation for no semantic reason; the blast
--         radius alone disqualifies it.
--       * INBOUND edges of any type — other memories' assertions about A. Not
--         ours to retract on A's behalf.
--       * `supersedes` edges — never touched in either direction. The
--         supersession chain IS the provenance record; breaking it to record a
--         supersession would be self-defeating.
--
--     Live blast radius of the shipped rule: 46 contradicts edges exist across
--     the entire graph, so any single call touches at most a handful.
--
--     NOT a trigger. An explicit RPC the supersedes path may call
--     fire-and-forget; a trigger would make a schema-level side effect out of an
--     ordinary UPDATE and would fire on backfills nobody meant as supersessions.
create or replace function public.memory_invalidate_superseded_edges(
  p_superseded_id uuid,
  p_at            timestamptz default now()
)
returns int
language plpgsql
security definer
set search_path = public, pg_catalog  -- [GATE 4]
as $$
declare
  v_updated int := 0;
begin
  if p_superseded_id is null then
    return 0;
  end if;

  update public.memory_relationships
     set invalid_at = coalesce(p_at, now())
   where source_id = p_superseded_id
     and relationship_type = 'contradicts'
     and invalid_at is null;

  get diagnostics v_updated = row_count;
  return v_updated;
end;
$$;

comment on function public.memory_invalidate_superseded_edges(uuid, timestamptz) is
  'Sprint 83: when a memory is superseded, retract the claims IT made that '
  'supersession refutes — outbound `contradicts` edges only. Never relates_to '
  '(relatedness survives supersession), never inbound (other memories'' claims), '
  'never supersedes (the provenance chain). Idempotent. SECURITY DEFINER, '
  'pinned search_path; EXECUTE: service_role only.';

-- 5d. upsert_memory_edges — T2's SR-2. Batch, DROP-INVALID, resurrection-safe.
--
--     THREE properties, each load-bearing:
--
--     (1) BATCH. N extracted triples in one round-trip is the difference
--         between fitting and blowing the extraction budget.
--
--     (2) DROP-INVALID, NEVER RAISE. A hallucinated predicate must not bubble a
--         23514 into a write path whose contract is fail-open. Validating
--         client-side would duplicate the vocabulary in TS and drift the first
--         time 034 is amended; validating here keeps ONE copy, in the table §2
--         created. Every row is processed inside its own exception block, so a
--         malformed uuid, an unparseable timestamp, a missing memory, a
--         self-edge or an unknown predicate drops THAT edge and nothing else —
--         the batch always returns a result.
--
--     (3) RESURRECTION-SAFE (the hazard behind the withdrawn memory_assert_edge;
--         ORCH RULING clause 3 folded it in here). src/relationships.ts:129-131
--         upserts on the (source_id, target_id, relationship_type) unique tuple
--         and sets only weight/inferred_at/inferred_by. Once invalid_at exists,
--         re-asserting a previously-invalidated edge through THAT path updates
--         the dead row and leaves invalid_at set — the edge stays invisible to
--         every live-only traversal, silently, forever. The ON CONFLICT clause
--         below clears it. Re-assert through this RPC, not the PostgREST upsert.
--
--     Input:  [{source_id, target_id, predicate, weight?, inferred_by?, valid_at?}]
--     Output: {accepted, dropped, dropped_predicates[]}
create or replace function public.upsert_memory_edges(p_edges jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_catalog  -- [GATE 4]
as $$
declare
  e          jsonb;
  v_accepted int := 0;
  v_dropped  int := 0;
  v_bad      text[] := '{}';
  v_src      uuid;
  v_tgt      uuid;
  v_pred     text;
  v_weight   double precision;
  v_by       text;
  v_valid    timestamptz;
  -- Canonical uuid shape. Tested BEFORE the cast, because a bad cast raises and
  -- this function's whole contract is that it does not.
  c_uuid_re  constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
begin
  if p_edges is null
     or jsonb_typeof(p_edges) <> 'array'
     or jsonb_array_length(p_edges) = 0 then
    return jsonb_build_object('accepted', 0, 'dropped', 0,
                              'dropped_predicates', '[]'::jsonb);
  end if;

  for e in select jsonb_array_elements(p_edges)
  loop
    begin
      v_src   := null;
      v_tgt   := null;
      v_pred  := e->>'predicate';

      if (e->>'source_id') ~* c_uuid_re then v_src := (e->>'source_id')::uuid; end if;
      if (e->>'target_id') ~* c_uuid_re then v_tgt := (e->>'target_id')::uuid; end if;

      -- Structural validity.
      if v_src is null or v_tgt is null or v_pred is null or v_src = v_tgt then
        v_dropped := v_dropped + 1;
        continue;
      end if;

      -- Vocabulary validity — the ONE copy, read from the table.
      if not exists (
        select 1 from public.memory_relationship_types t where t.type = v_pred
      ) then
        v_dropped := v_dropped + 1;
        if not (v_pred = any (v_bad)) then
          v_bad := v_bad || v_pred;
        end if;
        continue;
      end if;

      -- Referential validity, checked rather than left to the FK: an FK
      -- violation would abort this row's subtransaction with a less specific
      -- error, and a missing memory is an ordinary drop, not an anomaly.
      if not exists (select 1 from public.memory_items m where m.id = v_src)
         or not exists (select 1 from public.memory_items m where m.id = v_tgt) then
        v_dropped := v_dropped + 1;
        continue;
      end if;

      v_weight := null;
      v_by     := nullif(e->>'inferred_by', '');
      v_valid  := null;
      begin
        v_weight := nullif(e->>'weight', '')::double precision;
      exception when invalid_text_representation or numeric_value_out_of_range then
        v_weight := null;   -- a malformed weight is not worth dropping the edge
      end;
      begin
        v_valid := nullif(e->>'valid_at', '')::timestamptz;
      exception when invalid_text_representation
                 or invalid_datetime_format
                 or datetime_field_overflow then
        v_valid := null;
      end;

      insert into public.memory_relationships as r
        (source_id, target_id, relationship_type, weight,
         inferred_at, inferred_by, valid_at, invalid_at)
      values
        (v_src, v_tgt, v_pred, v_weight,
         now(), v_by, coalesce(v_valid, now()), null)
      on conflict (source_id, target_id, relationship_type) do update
         set invalid_at  = null,                      -- (3) resurrect
             valid_at    = case
                             -- Only restamp validity if it HAD been retracted; a
                             -- plain re-assertion of a live edge must not rewrite
                             -- the moment it originally became true.
                             when r.invalid_at is not null then coalesce(excluded.valid_at, now())
                             else r.valid_at
                           end,
             weight      = coalesce(excluded.weight, r.weight),
             inferred_at = now(),
             inferred_by = coalesce(excluded.inferred_by, r.inferred_by);

      v_accepted := v_accepted + 1;

    -- ⚠ DELIBERATELY NOT `when others`. A blanket handler makes a DEFECT IN THIS
    -- FUNCTION indistinguishable from bad caller input: Sprint 83 shipped a
    -- draft whose RETURNING clause used an uncastable `0::xid`, and every valid
    -- entity came back as a clean `dropped` — the batch reported success at
    -- every level while writing nothing. Only the exact-count assertions in
    -- 034b caught it.
    --
    -- So: catch the DATA errors that genuinely mean "this element is bad" and
    -- let everything else propagate. A class-42 error (undefined column,
    -- uncastable expression, wrong arity) is a broken function, not a broken
    -- edge, and it must be loud. T2's fail-open contract is unaffected — their
    -- extraction path wraps this call, so a raise still means "the write
    -- succeeded, extraction did not", which is exactly the intended behaviour.
    exception when invalid_text_representation      -- malformed uuid/number
                 or invalid_datetime_format
                 or datetime_field_overflow
                 or numeric_value_out_of_range
                 or string_data_right_truncation
                 or not_null_violation
                 or foreign_key_violation           -- endpoint vanished mid-batch
                 or unique_violation
                 or check_violation then
      v_dropped := v_dropped + 1;
    end;
  end loop;

  return jsonb_build_object(
    'accepted',           v_accepted,
    'dropped',            v_dropped,
    'dropped_predicates', to_jsonb(v_bad)
  );
end;
$$;

comment on function public.upsert_memory_edges(jsonb) is
  'Sprint 83 (SR-2): batch typed-edge upsert. Input '
  '[{source_id,target_id,predicate,weight?,inferred_by?,valid_at?}]; returns '
  '{accepted,dropped,dropped_predicates[]}. DROPS invalid edges rather than '
  'raising — the vocabulary is validated against memory_relationship_types, the '
  'single copy, so no client transcribes it. Idempotent on '
  '(source_id,target_id,predicate) and RESURRECTION-SAFE: re-asserting a '
  'previously invalidated edge clears invalid_at (the PostgREST upsert in '
  'src/relationships.ts does not). SECURITY DEFINER, pinned search_path; '
  'EXECUTE: service_role only.';

-- ====================================================================
-- 6. The label producer  (SR-1 × SCHEMA-READY §7; SR-5 adopted)
-- ====================================================================

-- SR-5, ADOPTED. Rank [1,3] cited means ranks [2,4,5] were SEEN AND NOT USED —
-- a far stronger negative than today's "surfaced ⇒ assumed negative", which is
-- what makes the existing ~39k negatives mostly uninformative. Stamping the
-- whole group lets a later fit separate OBSERVED negatives from unobserved ones.
--
-- Deliberately NOT `dismissed = true` on the complement: `dismissed` means "the
-- agent explicitly rejected this", and conflating the two would corrupt an
-- existing signal to manufacture a new one.
alter table public.memory_recall_log
  add column if not exists group_resolved_at timestamptz;

comment on column public.memory_recall_log.group_resolved_at is
  'Sprint 83 (SR-5): set on EVERY row of a recall group the first time any hit '
  'in it is cited. Rows with group_resolved_at IS NOT NULL and cited = false are '
  'OBSERVED negatives (seen, not used); rows with it NULL are merely unobserved. '
  'Distinct from `dismissed`, which means explicit rejection — never conflate.';

create index if not exists memory_recall_log_group_resolved_idx
  on public.memory_recall_log (group_resolved_at)
  where group_resolved_at is not null;

-- mark_recall_cited_group — the name is T2's SR-1 spelling, kept deliberately:
-- it matches the existing mark_recall_feedback family in 027 and is what T2
-- already wrote its client against, so there is one less thing to drift.
--
-- WHY GROUP-KEYED: mark_recall_feedback (027 §5) targets the most-recent log row
-- per memory_id. With several panels recalling concurrently that lands the
-- citation on another panel's reinjection event — a silently mis-attributed
-- label. Migration 031's recall_group_id names the exact reinjection, so the
-- label is exact.
--
-- ⚠ TWO FILTERS IN scripts/calibration/fit-platt.ts DECIDE WHETHER A CITATION
--   REACHES THE FIT, and neither is visible from here:
--     * EXCLUDED_SURFACES = ['graph'] (fit-platt.ts:54) — surface='graph' rows
--       are dropped entirely; their scores live on a different scale.
--     * SMOKE_SCORE_FLOOR = 0.4, applied as `l.score < $1` (fit-platt.ts:46,
--       :212) — score >= 0.4, or NULL score, is excluded.
--   This function does NOT enforce them: a caller may legitimately mark a
--   graph-surface hit as used, and it is not this function's business to
--   silently refuse. But a fixture that cites a score-NULL or graph-surface row
--   will "pass" while `positives` stays 0.
create or replace function public.mark_recall_cited_group(
  p_recall_group_id uuid,
  p_ranks           int[]  default null,
  p_memory_ids      uuid[] default null,
  p_source_agent    text   default null
)
returns int
language plpgsql
security definer
set search_path = public, pg_catalog  -- [GATE 4]
as $$
declare
  v_cited int := 0;
begin
  if p_recall_group_id is null then
    return 0;
  end if;

  -- Guarded on `cited = false` so a repeat call performs no write at all.
  update public.memory_recall_log
     set cited = true
   where recall_group_id = p_recall_group_id
     and (p_ranks      is null or rank      = any (p_ranks))
     and (p_memory_ids is null or memory_id = any (p_memory_ids))
     and cited = false;

  -- SR-5: stamp the WHOLE group (not just the narrowed rows) — the complement
  -- is precisely what becomes an observed negative. `is null` guard preserves
  -- the FIRST resolution time on a repeat call.
  update public.memory_recall_log
     set group_resolved_at = now()
   where recall_group_id = p_recall_group_id
     and group_resolved_at is null;

  -- Provenance repair, additive only: fill source_agent where it is NULL (the
  -- pre-Sprint-81 MCP-stdio slice, migration 031 § G2). NEVER overwrites a
  -- recorded value — a citation is not evidence about who ran the recall.
  if p_source_agent is not null then
    update public.memory_recall_log
       set source_agent = p_source_agent
     where recall_group_id = p_recall_group_id
       and (p_ranks      is null or rank      = any (p_ranks))
       and (p_memory_ids is null or memory_id = any (p_memory_ids))
       and source_agent is null;
  end if;

  -- POST-CONDITION count, not row_count. row_count would make this idempotent in
  -- state but not in reporting: the second identical call would return 0 and
  -- read like a failure. This returns "how many rows in the narrowed group are
  -- now cited", which is the same number every time — AND is still an honest 0
  -- for an unknown or stale group, which is what memory_cite needs to tell the
  -- agent "0 rows — unknown group" instead of reporting a success it never had.
  select count(*)
    into v_cited
    from public.memory_recall_log
   where recall_group_id = p_recall_group_id
     and (p_ranks      is null or rank      = any (p_ranks))
     and (p_memory_ids is null or memory_id = any (p_memory_ids))
     and cited;

  return v_cited;
end;
$$;

comment on function public.mark_recall_cited_group(uuid, int[], uuid[], text) is
  'Sprint 83 (SR-1): mark hits of ONE recall — by migration-031 recall_group_id, '
  'optionally narrowed by rank and/or memory id — as CITED, the positive label '
  'scripts/calibration/fit-platt.ts reads. Group-keyed, so a concurrent panel''s '
  'reinjection can never absorb the label (which mark_recall_feedback''s '
  'most-recent-row targeting allows). Idempotent in state AND return value: the '
  'return is the post-condition count of cited rows in the narrowed group, so a '
  'repeat returns the same number and an unknown/stale group honestly returns 0. '
  'Also stamps group_resolved_at on the WHOLE group (SR-5 observed negatives) '
  'and fills source_agent only where NULL. SECURITY DEFINER, pinned search_path; '
  'EXECUTE: service_role only.';

-- ====================================================================
-- 7. Typed + temporal expansion
-- ====================================================================

-- 7a. memory_expand_typed — T3's REQ-1, signature VERBATIM.
--
--     Parameter NAMES are the contract: PostgREST binds RPC arguments by name
--     from the JSON key set, so renaming one is a breaking change even when the
--     types match. Exactly ONE signature, no overloads — a second overload
--     re-creates the 404 outage documented at mnestra-bridge/index.js:96-110.
--
--     A NEW function, not an upgrade of 009/010. 010's memory_recall_graph
--     re-ranks the union it returns (final_score = vector_score × edge_weight ×
--     recency_score, 010:118), which is exactly the hybrid-ranking mutation
--     PLANNING §Non-goals forbids; it also traverses untyped edges, predates
--     valid_at/invalid_at, and mixes depth-0 seeds into its output. 010 and 009
--     are otherwise untouched here (except 7b's temporal filter).
--
--     Semantics, per REQ-1 (a)-(i) — all confirmed as requested:
--       (a) LIVE edges only: invalid_at is null and valid_at <= now(). The
--           valid_at half is defensive — §1 makes the column NOT NULL — but it
--           is what makes "traverses only live edges" enforced HERE rather than
--           a convention held by the caller.
--       (b) TYPED-ONLY PATHS: every edge on the path is in the effective
--           predicate set. No mixed paths. Default set when p_predicates is
--           null: {caused_by, fixed_by, supersedes, same_pattern_as} — all four
--           are shipped §2 spellings, so T3's semantic roles and the vocabulary
--           agree with no translation. (Without this, one relates_to hop at
--           depth 2 pulls in most of a 6,000-edge relation.)
--       (c) DIRECTION reported, traversal bidirectional. `direction` describes
--           the LAST edge relative to how the walk crossed it: 'outbound' when
--           the walk went source_id -> target_id, 'inbound' when it went
--           target_id -> source_id. At depth 1 the previous node IS the seed, so
--           this reads exactly as REQ-1c specified; at depth 2 it generalizes to
--           the intermediate node, which is the only definition that stays
--           correct. Combine with the direction table in §2 to render copy.
--       (d) TOMBSTONE HYGIENE ON EVERY NODE of the path, not just the returned
--           one — enforced in the recursive step, so a path cannot even route
--           THROUGH a superseded memory.
--       (e) PRIVACY PARITY BY PASSTHROUGH: privacy_tags is returned and the TS
--           layer decides, exactly as 023/033 do. No include_privacy param. The
--           risk T3 named is real and worth restating: expansion reaches
--           memories hybrid search never scored, so a privacy-tagged item is
--           reachable via an edge from an untagged one. Passthrough plus the
--           caller-side default-exclude is what closes it; dropping the column
--           would leave the caller unable to filter at all.
--       (f) STABLE, not VOLATILE. A STABLE function cannot execute
--           INSERT/UPDATE/DELETE — Postgres raises at runtime — so read-only is
--           a structural guarantee rather than a code-inspection promise. The
--           §10 receipt asserts provolatile = 's'.
--       (g) DEDUP + NO SEED ECHO: distinct on (memory_id) keeping shortest
--           depth, then highest edge_weight; any memory_id already in p_seed_ids
--           is excluded (returning a seed as its own neighbor would double-count
--           it in a ranking this sprint is explicitly not allowed to touch).
--       (h) CAPS CLAMPED INSIDE: depth to [1,2], rows to [1,25]. Not trusted
--           from the caller.
--       (i) INVOKER, pinned search_path, service_role-only EXECUTE.
create or replace function public.memory_expand_typed(
  p_seed_ids   uuid[],
  p_predicates text[] default null,
  p_max_depth  int    default 1,
  p_max_rows   int    default 10,
  p_project    text   default null
)
returns table (
  memory_id     uuid,
  seed_id       uuid,
  content       text,
  source_type   text,
  project       text,
  metadata      jsonb,
  privacy_tags  text[],
  created_at    timestamptz,
  depth         int,
  edge_type     text,
  edge_path     text[],
  direction     text,
  edge_weight   float,
  path          uuid[]
)
language sql
stable                                            -- [REQ-1f] read-only, structurally
security invoker                                  -- [REQ-1i]
set search_path = public, extensions, pg_catalog  -- [GATE 4] / [REQ-1i]
as $$
  with recursive seeds as (
    select distinct s as seed_id
      from unnest(coalesce(p_seed_ids, '{}'::uuid[])) as s
     where s is not null
  ),
  walk as (
    select
      s.seed_id,
      s.seed_id                as node_id,
      0                        as depth,
      array[s.seed_id]         as path,
      array[]::text[]          as edge_path,
      null::text               as edge_type,
      null::text               as direction,
      0::float                 as w_sum
    from seeds s
    union all
    select
      w.seed_id,
      case when r.source_id = w.node_id then r.target_id else r.source_id end,
      w.depth + 1,
      w.path || (case when r.source_id = w.node_id then r.target_id else r.source_id end),
      w.edge_path || r.relationship_type,
      r.relationship_type,
      -- [REQ-1c] how the walk crossed this edge.
      case when r.source_id = w.node_id then 'outbound' else 'inbound' end,
      -- Running sum; divided by depth at the end for the mean. NULL weight (the
      -- unclassified pre-graph-inference edges) counts as 0.5, matching 010.
      w.w_sum + coalesce(r.weight, 0.5)
    from walk w
    join public.memory_relationships r
      on (r.source_id = w.node_id or r.target_id = w.node_id)
    -- [REQ-1d] tombstone hygiene on the node being ADDED, so no path routes
    -- through a superseded memory.
    join public.memory_items nxt
      on nxt.id = (case when r.source_id = w.node_id then r.target_id else r.source_id end)
     and nxt.is_active     = true
     and nxt.archived      = false
     and nxt.superseded_by is null
    -- [REQ-1h] depth clamped INSIDE, to [1,2].
    where w.depth < least(greatest(coalesce(p_max_depth, 1), 1), 2)
      -- [REQ-1a] live edges only.
      and r.invalid_at is null
      and (r.valid_at is null or r.valid_at <= now())
      -- [REQ-1b] typed-only paths; every hop is in the effective set.
      and r.relationship_type = any (
            coalesce(p_predicates,
                     array['caused_by', 'fixed_by', 'supersedes', 'same_pattern_as'])
          )
      -- Cycle guard (009's idiom): never revisit a node already on this path.
      and not (
        case when r.source_id = w.node_id then r.target_id else r.source_id end
        = any (w.path)
      )
  ),
  -- [REQ-1g] one row per reached memory: shortest path wins, then strongest.
  best as (
    select distinct on (w.node_id)
      w.node_id                     as memory_id,
      w.seed_id,
      mi.content,
      mi.source_type,
      mi.project,
      mi.metadata,
      mi.privacy_tags,              -- [REQ-1e] passthrough; caller filters
      mi.created_at,
      w.depth,
      w.edge_type,
      w.edge_path,
      w.direction,
      (w.w_sum / w.depth)::float    as edge_weight,
      w.path
    from walk w
    join public.memory_items mi
      on mi.id = w.node_id
     and mi.is_active     = true
     and mi.archived      = false
     and mi.superseded_by is null
    where w.depth > 0                                            -- never a seed row
      and not (w.node_id = any (coalesce(p_seed_ids, '{}'::uuid[])))  -- [REQ-1g] no echo
      and (p_project is null or mi.project = p_project)
    order by w.node_id, w.depth asc, (w.w_sum / w.depth) desc
  )
  select
    memory_id, seed_id, content, source_type, project, metadata, privacy_tags,
    created_at, depth, edge_type, edge_path, direction, edge_weight, path
  from best
  order by depth asc, edge_weight desc, memory_id
  -- [REQ-1h] rows clamped INSIDE, to [1,25].
  limit least(greatest(coalesce(p_max_rows, 10), 1), 25);
$$;

comment on function public.memory_expand_typed(uuid[], text[], int, int, text) is
  'Sprint 83 (T3 REQ-1): bidirectional 1-2 hop expansion from seed memories over '
  'LIVE (invalid_at IS NULL) edges whose predicate is in the effective set — no '
  'mixed/untyped paths. Tombstone-clean on every node of the path; returns '
  'depth>0 only and never echoes a seed. `direction` reports how the walk '
  'crossed the LAST edge (outbound = source->target), which with the direction '
  'table in migration 034 §2 is what lets a caller say "you fixed this before" '
  'rather than pointing at the bug. privacy_tags passes through for caller-side '
  'filtering. STABLE — structurally incapable of writing. INVOKER, pinned '
  'search_path; EXECUTE: service_role only. Exactly one signature: do not add '
  'an overload.';

-- 7b. expand_memory_neighborhood — SAME SIGNATURE, now temporal-aware.
--
--     Replaced at the identical (uuid, int) signature: same OID, so grants
--     survive and no second overload is created. The ONLY change to the body is
--     `and r.invalid_at is null`.
--
--     Behavioral impact on apply day: NONE. Every edge in the table is live
--     (invalid_at was just created as NULL for all of them), so this returns
--     exactly what it returned before, and memory_recall_graph — which consumes
--     it — is bit-identical. The change takes effect from the first invalidation
--     forward, which is the point.
--
--     ⚠ search_path MUST be restated here. Migration 019 pinned it with ALTER
--     FUNCTION, not in 009's CREATE; CREATE OR REPLACE replaces proconfig
--     wholesale, so omitting the SET clause would null it and silently un-harden
--     GATE 4. Kept byte-identical to what 019 set.
create or replace function public.expand_memory_neighborhood(
  start_id  uuid,
  max_depth int default 2
)
returns table (
  memory_id  uuid,
  depth      int,
  path       uuid[],
  edge_kinds text[]
)
language sql
stable
set search_path = public, extensions, pg_catalog  -- [GATE 4] — 019's exact pin
as $$
  with recursive neighborhood as (
    select
      start_id                  as memory_id,
      0                         as depth,
      array[start_id]           as path,
      array[]::text[]           as edge_kinds
    union all
    select
      case when r.source_id = n.memory_id then r.target_id else r.source_id end,
      n.depth + 1,
      n.path || (case when r.source_id = n.memory_id then r.target_id else r.source_id end),
      n.edge_kinds || r.relationship_type
    from neighborhood n
    join memory_relationships r
      on (r.source_id = n.memory_id or r.target_id = n.memory_id)
    where n.depth < max_depth
      -- Sprint 83: stop traversing retracted edges. No-op on apply day (every
      -- edge is live); load-bearing from the first invalidation forward.
      and r.invalid_at is null
      and not (
        case when r.source_id = n.memory_id then r.target_id else r.source_id end
        = any (n.path)
      )
  )
  select memory_id, depth, path, edge_kinds from neighborhood;
$$;

comment on function public.expand_memory_neighborhood(uuid, int) is
  'Sprint 38 / Sprint 83: bidirectional cycle-safe N-hop traversal. Sprint 83 '
  'restricted it to LIVE edges (invalid_at IS NULL); signature, grants and '
  'search_path pin are unchanged. memory_recall_graph (migration 010) consumes '
  'this and inherits the temporal filter.';

-- FORWARD NOTE (not fixed here, deliberately): migration 010's
-- memory_recall_graph computes its path edge_weight with its own join onto
-- memory_relationships that does NOT filter invalid_at. Because the PATH it
-- averages over is produced by expand_memory_neighborhood, every node on it was
-- reached via live edges; the only residue is that a pair connected by BOTH a
-- live and an invalidated edge OF A DIFFERENT TYPE would average across both.
-- That is a weighting nuance, not a correctness break — it cannot surface a
-- retracted relationship — and fixing it means rewriting 010's function body for
-- no behavior change today. Left for whoever next touches 010's scoring.

-- ====================================================================
-- 8. upsert_memory_entities — T2's SR-3
-- ====================================================================
--
-- Input:  p_memory_id uuid, p_entities jsonb = [{name, type, aliases?}]
-- Output: {entity_ids[], created, linked, dropped}
--
-- Write-time resolution is deliberately LIGHT — normalize (btrim + lower) and
-- exact-match only. Deep entity resolution is T3's consolidation, which operates
-- on entity records. Normalization happens SERVER-SIDE so no client can skip it
-- and split one entity into two.
--
-- Same drop-invalid discipline as upsert_memory_edges, and for the same reason:
-- a hallucinated entity type must not raise into a fail-open write path. The
-- type vocabulary is read from memory_entity_types — again, one copy.
create or replace function public.upsert_memory_entities(
  p_memory_id uuid,
  p_entities  jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_catalog  -- [GATE 4]
as $$
declare
  e         jsonb;
  v_ids     uuid[] := '{}';
  v_created int := 0;
  v_linked  int := 0;
  v_dropped int := 0;
  v_name    text;
  v_type    text;
  v_key     text;
  v_id      uuid;
  v_is_new  boolean;
  v_aliases jsonb;
begin
  if p_memory_id is null
     or p_entities is null
     or jsonb_typeof(p_entities) <> 'array'
     or jsonb_array_length(p_entities) = 0 then
    return jsonb_build_object('entity_ids', '[]'::jsonb, 'created', 0,
                              'linked', 0, 'dropped', 0);
  end if;

  -- A missing memory drops the whole batch rather than half-writing entities
  -- with no mention to hang them on.
  if not exists (select 1 from public.memory_items m where m.id = p_memory_id) then
    return jsonb_build_object('entity_ids', '[]'::jsonb, 'created', 0,
                              'linked', 0,
                              'dropped', jsonb_array_length(p_entities));
  end if;

  for e in select jsonb_array_elements(p_entities)
  loop
    begin
      v_name := e->>'name';
      v_type := e->>'type';
      v_key  := lower(btrim(coalesce(v_name, '')));

      if v_name is null or v_type is null or v_key = '' then
        v_dropped := v_dropped + 1;
        continue;
      end if;

      if not exists (
        select 1 from public.memory_entity_types t where t.entity_type = v_type
      ) then
        v_dropped := v_dropped + 1;
        continue;
      end if;

      v_aliases := case
                     when jsonb_typeof(e->'aliases') = 'array' then e->'aliases'
                     else '[]'::jsonb
                   end;

      -- Upsert the canonical entity. display_name is kept AS FIRST SEEN — the
      -- normalized key is what matches, so overwriting the display form on every
      -- mention would just churn it. Aliases accumulate.
      insert into public.memory_entities as en
        (entity_key, entity_type, display_name, metadata, mention_count)
      values
        (v_key, v_type, btrim(v_name),
         jsonb_build_object('aliases', v_aliases), 0)
      on conflict (entity_type, entity_key) do update
         set last_seen_at = now(),
             metadata = jsonb_set(
               en.metadata,
               '{aliases}',
               ( select coalesce(jsonb_agg(distinct a), '[]'::jsonb)
                   from jsonb_array_elements(
                          coalesce(en.metadata->'aliases', '[]'::jsonb) || v_aliases
                        ) as a ),
               true
             )
      -- xmax = 0 is the canonical "this row was INSERTed, not UPDATEd" test on
      -- an upsert's RETURNING: a freshly inserted tuple has no deleting xid.
      -- Written as a bare `= 0` deliberately — `0::xid` does not compile
      -- ("cannot cast type integer to xid"); the comparison relies on the
      -- xid = integer operator instead.
      returning en.id, (xmax = 0) into v_id, v_is_new;

      v_ids := v_ids || v_id;
      if v_is_new then
        v_created := v_created + 1;
      end if;

      -- The mention. PK (memory_id, entity_id) makes re-extraction of the same
      -- memory idempotent; DO NOTHING so a re-run neither errors nor
      -- double-counts mention_count.
      insert into public.memory_entity_mentions
        (memory_id, entity_id, span, confidence)
      values
        (p_memory_id, v_id, nullif(e->>'span', ''),
         case when (e->>'confidence') ~ '^[0-9]*\.?[0-9]+$'
              then least(greatest((e->>'confidence')::double precision, 0.0), 1.0)
              else null end)
      on conflict (memory_id, entity_id) do nothing;

      if found then
        v_linked := v_linked + 1;
        update public.memory_entities
           set mention_count = mention_count + 1
         where id = v_id;
      end if;

    -- Narrowed for the same reason as upsert_memory_edges: a blanket `when
    -- others` here is what let an uncastable RETURNING expression present as
    -- four clean drops instead of a hard failure. Data errors drop one entity;
    -- a defect in this function raises.
    exception when invalid_text_representation
                 or string_data_right_truncation
                 or numeric_value_out_of_range
                 or not_null_violation
                 or foreign_key_violation
                 or unique_violation
                 or check_violation then
      v_dropped := v_dropped + 1;
    end;
  end loop;

  return jsonb_build_object(
    'entity_ids', to_jsonb(v_ids),
    'created',    v_created,
    'linked',     v_linked,
    'dropped',    v_dropped
  );
end;
$$;

comment on function public.upsert_memory_entities(uuid, jsonb) is
  'Sprint 83 (SR-3): resolve-and-link entities for one memory. Input '
  '[{name,type,aliases?,span?,confidence?}]; returns '
  '{entity_ids[],created,linked,dropped}. Normalization (btrim+lower) is '
  'SERVER-SIDE so no client can split one entity into two. Drops invalid '
  'entries rather than raising; the type vocabulary is read from '
  'memory_entity_types, the single copy. Idempotent per (memory_id, entity_id). '
  'Write-time resolution is exact-match only — deep resolution is '
  'consolidation''s job. SECURITY DEFINER, pinned search_path; EXECUTE: '
  'service_role only.';

-- ====================================================================
-- 9. Grants — [GATE 3]
-- ====================================================================
--
-- MANDATORY, not defensive. Migration 014:45 sets
--   alter default privileges in schema public
--     grant execute on functions to service_role, authenticated, anon;
-- so every function above is anon- AND authenticated-executable from the instant
-- it is created until these REVOKEs run. The grant set matches what migration
-- 019 left on the sibling graph functions: service_role only.

revoke execute on function public.memory_invalidate_edge(uuid, timestamptz)
  from public, anon, authenticated;
grant  execute on function public.memory_invalidate_edge(uuid, timestamptz)
  to service_role;

revoke execute on function public.memory_invalidate_edges(uuid, uuid, text, timestamptz)
  from public, anon, authenticated;
grant  execute on function public.memory_invalidate_edges(uuid, uuid, text, timestamptz)
  to service_role;

revoke execute on function public.memory_invalidate_superseded_edges(uuid, timestamptz)
  from public, anon, authenticated;
grant  execute on function public.memory_invalidate_superseded_edges(uuid, timestamptz)
  to service_role;

revoke execute on function public.upsert_memory_edges(jsonb)
  from public, anon, authenticated;
grant  execute on function public.upsert_memory_edges(jsonb)
  to service_role;

revoke execute on function public.mark_recall_cited_group(uuid, int[], uuid[], text)
  from public, anon, authenticated;
grant  execute on function public.mark_recall_cited_group(uuid, int[], uuid[], text)
  to service_role;

revoke execute on function public.memory_expand_typed(uuid[], text[], int, int, text)
  from public, anon, authenticated;
grant  execute on function public.memory_expand_typed(uuid[], text[], int, int, text)
  to service_role;

revoke execute on function public.upsert_memory_entities(uuid, jsonb)
  from public, anon, authenticated;
grant  execute on function public.upsert_memory_entities(uuid, jsonb)
  to service_role;

-- Re-pinned rather than assumed: CREATE OR REPLACE preserves grants, but this
-- keeps the hygiene receipt honest against a hand-edited install.
revoke execute on function public.expand_memory_neighborhood(uuid, int)
  from public, anon, authenticated;
grant  execute on function public.expand_memory_neighborhood(uuid, int)
  to service_role;

-- ====================================================================
-- 10. Apply-time receipt — HARD-FAILING
-- ====================================================================
--
-- OID form throughout: pg_get_function_identity_arguments returns argument NAMES
-- on Supabase's Postgres, so a receipt that reconstructs a text signature
-- silently matches nothing. Resolve by proname and assert overload count.
-- apply_migration has a known silent-no-op failure mode — every check below
-- RAISES rather than NOTICEs, so a clean apply IS the evidence.

do $$
declare
  fn        text;
  tbl       text;
  v_oid     oid;
  v_n       int;
  v_anon    boolean;
  v_auth    boolean;
  v_pub     boolean;
  v_svc     boolean;
  v_cfg     text;
  v_secdef  boolean;
  v_missing text;
begin
  -- ── §1 temporal columns ────────────────────────────────────────────────
  if not exists (
    select 1 from information_schema.columns
     where table_schema='public' and table_name='memory_relationships'
       and column_name='valid_at' and is_nullable='NO'
  ) then
    raise exception '[034] valid_at missing or still nullable on memory_relationships';
  end if;
  if not exists (
    select 1 from information_schema.columns
     where table_schema='public' and table_name='memory_relationships'
       and column_name='invalid_at'
  ) then
    raise exception '[034] invalid_at missing on memory_relationships';
  end if;
  select count(*) into v_n from public.memory_relationships where valid_at is null;
  if v_n > 0 then
    raise exception '[034] % edges have NULL valid_at after backfill', v_n;
  end if;

  -- ── indexes ────────────────────────────────────────────────────────────
  foreach tbl in array array[
      'memory_relationships_live_source_idx',
      'memory_relationships_live_target_idx',
      'memory_items_problem_signature_class_idx',
      'memory_items_problem_signature_hash_idx',
      'memory_items_consolidation_community_key_idx',
      'memory_entity_mentions_entity_idx',
      'memory_entities_key_idx',
      'memory_recall_log_group_resolved_idx']
  loop
    if not exists (select 1 from pg_indexes where schemaname='public' and indexname=tbl) then
      raise exception '[034] index % missing', tbl;
    end if;
  end loop;

  -- ── §2 vocabulary: FK replaced the CHECK, and NOTHING was orphaned ─────
  if exists (
    select 1 from pg_constraint con
      join pg_class cls on cls.oid = con.conrelid
      join pg_namespace nsp on nsp.oid = cls.relnamespace
     where nsp.nspname='public' and cls.relname='memory_relationships'
       and con.contype='c'
       and pg_get_constraintdef(con.oid) ilike '%relationship_type%'
  ) then
    raise exception '[034] a CHECK on relationship_type survived — the FK is not the only governor';
  end if;

  if not exists (
    select 1 from pg_constraint con
      join pg_class cls on cls.oid = con.conrelid
      join pg_namespace nsp on nsp.oid = cls.relnamespace
     where nsp.nspname='public' and cls.relname='memory_relationships'
       and con.contype='f'
       and con.conname='memory_relationships_relationship_type_fkey'
  ) then
    raise exception '[034] relationship_type FK to memory_relationship_types missing';
  end if;

  select string_agg(t, ', ') into v_missing
    from unnest(array['supersedes','relates_to','contradicts','elaborates','caused_by',
                      'blocks','inspired_by','cross_project_link','amends_rule','elevated_to',
                      'same_pattern_as','fixed_by','documented_at','part_of']) as t
   where not exists (select 1 from public.memory_relationship_types v where v.type = t);
  if v_missing is not null then
    raise exception '[034] shipped vocabulary incomplete — missing: %', v_missing;
  end if;

  -- The four predicates memory_expand_typed defaults to MUST exist, or the
  -- default allowlist silently expands nothing.
  select string_agg(t, ', ') into v_missing
    from unnest(array['caused_by','fixed_by','supersedes','same_pattern_as']) as t
   where not exists (select 1 from public.memory_relationship_types v where v.type = t);
  if v_missing is not null then
    raise exception '[034] memory_expand_typed default predicate set is not in the vocabulary — missing: %', v_missing;
  end if;

  -- BACKWARD COMPATIBILITY, asserted rather than assumed: no existing edge may
  -- reference a type the vocabulary lacks. The FK would already have refused to
  -- be created, but an explicit count names the failure instead of leaving a
  -- generic constraint error.
  select count(*) into v_n
    from public.memory_relationships r
   where not exists (
     select 1 from public.memory_relationship_types v where v.type = r.relationship_type
   );
  if v_n > 0 then
    raise exception '[034] % existing edges reference an unknown relationship_type', v_n;
  end if;

  -- ── §2b source_type extension held, and lost nothing ───────────────────
  if not exists (
    select 1 from pg_constraint con
      join pg_class cls on cls.oid = con.conrelid
      join pg_namespace nsp on nsp.oid = cls.relnamespace
     where nsp.nspname='public' and cls.relname='memory_items'
       and con.conname='memory_items_source_type_check'
       and pg_get_constraintdef(con.oid) like '%consolidation_summary%'
  ) then
    raise exception '[034] memory_items source_type CHECK does not carry consolidation_summary';
  end if;
  select string_agg(t, ', ') into v_missing
    from unnest(array['fact','decision','preference','bug_fix','architecture','code_context',
                      'session_summary','document_chunk','commit_context','pre_compact_snapshot',
                      'doctrine']) as t
   where not exists (
     select 1 from pg_constraint con
       join pg_class cls on cls.oid = con.conrelid
       join pg_namespace nsp on nsp.oid = cls.relnamespace
      where nsp.nspname='public' and cls.relname='memory_items'
        and con.conname='memory_items_source_type_check'
        and pg_get_constraintdef(con.oid) like '%''' || t || '''%'
   );
  if v_missing is not null then
    raise exception '[034] source_type CHECK rewrite DROPPED pre-existing values: %', v_missing;
  end if;

  -- ── §2c solved-problem decay repair ────────────────────────────────────
  -- Lockstep: neither function may have grown an overload.
  foreach fn in array array['memory_hybrid_search','memory_hybrid_search_explain']
  loop
    select count(*) into v_n
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace
     where n.nspname='public' and p.proname=fn;
    if v_n <> 1 then
      raise exception '[034] expected exactly 1 % overload, found % — the 033 "function is not unique" hazard is back', fn, v_n;
    end if;
  end loop;

  -- The repair is IN the body: the debugging arm now tests category, and the
  -- two unreachable source_type arms are gone. prosrc is the only place this can
  -- be checked — the fix is a predicate, not a schema artifact.
  select p.prosrc into v_cfg
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public' and p.proname='memory_hybrid_search';
  if v_cfg not like '%e.category = ''debugging''%' then
    raise exception '[034] §2c did not land: memory_hybrid_search does not key the solved-problem arm on category';
  end if;
  if v_cfg like '%when ''debugging''%' or v_cfg like '%when ''convention''%' then
    raise exception '[034] §2c incomplete: a dead source_type arm (debugging/convention) survives in memory_hybrid_search';
  end if;

  -- BOTH SET clauses must have survived the CREATE OR REPLACE. Omitting them
  -- would null the GATE 4 pin and 033's hnsw tuning in one statement.
  select array_to_string(p.proconfig, '; ') into v_cfg
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public' and p.proname='memory_hybrid_search';
  if v_cfg is null or v_cfg not like '%search_path=public, extensions, pg_catalog%' then
    raise exception '[034] GATE 4 VIOLATION: §2c dropped memory_hybrid_search''s search_path pin (proconfig: %)',
      coalesce(v_cfg, '<none>');
  end if;
  if v_cfg not like '%hnsw.ef_search=120%' then
    raise exception '[034] §2c dropped 033''s hnsw.ef_search tuning (proconfig: %)', v_cfg;
  end if;

  -- And its grants are untouched (CREATE OR REPLACE preserves them; assert it).
  select p.oid into v_oid
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public' and p.proname='memory_hybrid_search';
  if has_function_privilege('anon', v_oid, 'EXECUTE')
     or has_function_privilege('authenticated', v_oid, 'EXECUTE')
     or has_function_privilege('public', v_oid, 'EXECUTE') then
    raise exception '[034] GATE 3 VIOLATION: §2c left memory_hybrid_search executable by anon/authenticated/public';
  end if;
  if not has_function_privilege('service_role', v_oid, 'EXECUTE') then
    raise exception '[034] GATE 3 VIOLATION: §2c cost service_role EXECUTE on memory_hybrid_search';
  end if;

  -- ── §3/§6 tables: [GATE 1] RLS + [GATE 2] zero policies + [GATE 5] ─────
  foreach tbl in array array['memory_relationship_types','memory_entity_types',
                             'memory_entities','memory_entity_mentions']
  loop
    if not exists (
      select 1 from information_schema.tables
       where table_schema='public' and table_name=tbl
    ) then
      raise exception '[034] table % missing', tbl;
    end if;
    if not exists (
      select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
       where n.nspname='public' and c.relname=tbl and c.relrowsecurity
    ) then
      raise exception '[034] GATE 1 VIOLATION: RLS not enabled on %', tbl;
    end if;
    select count(*) into v_n from pg_policies where schemaname='public' and tablename=tbl;
    if v_n > 0 then
      raise exception '[034] GATE 2 VIOLATION: % has % policies; expected zero', tbl, v_n;
    end if;
    if has_table_privilege('anon', 'public.'||tbl, 'SELECT')
       or has_table_privilege('anon', 'public.'||tbl, 'INSERT')
       or has_table_privilege('authenticated', 'public.'||tbl, 'SELECT')
       or has_table_privilege('authenticated', 'public.'||tbl, 'INSERT') then
      raise exception '[034] GATE 5 VIOLATION: anon/authenticated retain table privileges on %', tbl;
    end if;
  end loop;

  if not exists (
    select 1 from information_schema.columns
     where table_schema='public' and table_name='memory_recall_log'
       and column_name='group_resolved_at'
  ) then
    raise exception '[034] group_resolved_at missing on memory_recall_log (SR-5)';
  end if;

  -- ── functions: overload count, [GATE 3] grants, [GATE 4] search_path ───
  foreach fn in array array['memory_invalidate_edge','memory_invalidate_edges',
                            'memory_invalidate_superseded_edges','upsert_memory_edges',
                            'mark_recall_cited_group','upsert_memory_entities',
                            'memory_expand_typed','expand_memory_neighborhood']
  loop
    select count(*) into v_n
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace
     where n.nspname='public' and p.proname=fn;
    if v_n <> 1 then
      raise exception '[034] expected exactly 1 % overload, found % — ambiguous-overload hazard (PostgREST 404)', fn, v_n;
    end if;

    select p.oid, p.prosecdef, array_to_string(p.proconfig, '; ')
      into v_oid, v_secdef, v_cfg
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace
     where n.nspname='public' and p.proname=fn;

    v_anon := has_function_privilege('anon',          v_oid, 'EXECUTE');
    v_auth := has_function_privilege('authenticated', v_oid, 'EXECUTE');
    v_pub  := has_function_privilege('public',        v_oid, 'EXECUTE');
    v_svc  := has_function_privilege('service_role',  v_oid, 'EXECUTE');
    raise notice '[034] % EXECUTE — anon:%, auth:%, public:% (expect f f f); service_role:% (expect t); secdef:%; proconfig:%',
      fn, v_anon, v_auth, v_pub, v_svc, v_secdef, coalesce(v_cfg, '<none>');

    if v_anon or v_auth or v_pub then
      raise exception '[034] GATE 3 VIOLATION: % executable by anon/authenticated/public (%, %, %)',
        fn, v_anon, v_auth, v_pub;
    end if;
    if not v_svc then
      raise exception '[034] GATE 3 VIOLATION: service_role lacks EXECUTE on %', fn;
    end if;
    if v_cfg is null or v_cfg not like '%search_path=%' then
      raise exception '[034] GATE 4 VIOLATION: % has no pinned search_path (proconfig: %)',
        fn, coalesce(v_cfg, '<none>');
    end if;
  end loop;

  -- [REQ-1f] STABLE is T3's structural read-only proof — assert it here too, so
  -- a future edit to VOLATILE fails the apply rather than only their test.
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
     where n.nspname='public' and p.proname='memory_expand_typed' and p.provolatile='s'
  ) then
    raise exception '[034] REQ-1f VIOLATION: memory_expand_typed is not STABLE — its read-only guarantee is gone';
  end if;

  -- [GATE 5] the read-only traversal functions must stay INVOKER.
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
     where n.nspname='public'
       and p.proname in ('memory_expand_typed','expand_memory_neighborhood')
       and p.prosecdef
  ) then
    raise exception '[034] GATE 5 VIOLATION: a read-only traversal function is SECURITY DEFINER';
  end if;

  -- [REQ-1i] both traversal functions need `extensions` on the path.
  foreach fn in array array['memory_expand_typed','expand_memory_neighborhood']
  loop
    select array_to_string(p.proconfig, '; ') into v_cfg
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace
     where n.nspname='public' and p.proname=fn;
    if v_cfg not like '%search_path=public, extensions, pg_catalog%' then
      raise exception
        '[034] GATE 4 VIOLATION: % lost the `public, extensions, pg_catalog` pin (proconfig: %) — CREATE OR REPLACE nulls proconfig when the SET clause is omitted',
        fn, coalesce(v_cfg, '<none>');
    end if;
  end loop;

  -- The one behavioral assertion static tests cannot make: the replaced body
  -- actually filters on invalid_at.
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
     where n.nspname='public' and p.proname='expand_memory_neighborhood'
       and p.prosrc like '%invalid_at is null%'
  ) then
    raise exception '[034] expand_memory_neighborhood was not replaced with the temporal filter';
  end if;

  raise notice '[034] receipt: temporal columns + backfill clean, vocabulary FK-governed with % types and 0 orphaned edges, source_type extended without loss, 4 tables + group_resolved_at five-gate clean, 8 functions single-overload + service_role-only + search_path pinned, memory_expand_typed STABLE.',
    (select count(*) from public.memory_relationship_types);
end$$;

-- ====================================================================
-- 11. Post-apply verification (ORCH, Studio SQL editor — commented)
-- ====================================================================
--
--   -- (i) Nothing was retracted by the apply itself. Expect invalid=0.
--   select count(*) filter (where invalid_at is null)     as live,
--          count(*) filter (where invalid_at is not null) as invalid
--     from public.memory_relationships;
--
--   -- (ii) valid_at carries real history, not the apply timestamp. Expect the
--   --      min to be the corpus's first edge (2026-03-06), NOT today.
--   select min(valid_at), max(valid_at) from public.memory_relationships;
--
--   -- (iii) The vocabulary adopted every live value. Expect zero rows.
--   select distinct r.relationship_type
--     from public.memory_relationships r
--    where not exists (select 1 from public.memory_relationship_types v
--                       where v.type = r.relationship_type);
--
--   -- (iv) memory_recall_graph still runs (it consumes
--   --      expand_memory_neighborhood):
--   --   select count(*) from public.expand_memory_neighborhood(
--   --     (select source_id from public.memory_relationships limit 1), 2);
--
--   -- (v) Five-gate advisor sweep — the standing release checklist from global
--   --     CLAUDE.md § "Supabase RLS + privilege hygiene". Expect no new
--   --     0011_function_search_path_mutable and no new
--   --     0013_rls_disabled_in_public entries for any 034 object.
--
--   -- (vi) Round-trip the label producer WITHOUT leaving a real label behind.
--   --   begin;
--   --     insert into public.memory_recall_log
--   --       (memory_id, surface, score, rank, query_hash, recall_group_id)
--   --     select id, 'recall', 0.02, 1, 'post-apply-check', gen_random_uuid()
--   --       from public.memory_items limit 1
--   --     returning recall_group_id \gset
--   --     select public.mark_recall_cited_group(:'recall_group_id');  -- expect 1
--   --     select public.mark_recall_cited_group(:'recall_group_id');  -- expect 1 (idempotent)
--   --     select cited, group_resolved_at is not null
--   --       from public.memory_recall_log where query_hash='post-apply-check';
--   --   rollback;
--
-- ====================================================================
-- 12. Rollback (commented — nobody runs this without ORCH sign-off)
-- ====================================================================
--
--   -- Restoring the CHECK means re-authoring the full vocabulary; take it from
--   -- memory_relationship_types rather than from any migration file on disk.
--   alter table public.memory_relationships
--     drop constraint if exists memory_relationships_relationship_type_fkey;
--   drop function if exists public.memory_expand_typed(uuid[], text[], int, int, text);
--   drop function if exists public.upsert_memory_entities(uuid, jsonb);
--   drop function if exists public.mark_recall_cited_group(uuid, int[], uuid[], text);
--   drop function if exists public.upsert_memory_edges(jsonb);
--   drop function if exists public.memory_invalidate_superseded_edges(uuid, timestamptz);
--   drop function if exists public.memory_invalidate_edges(uuid, uuid, text, timestamptz);
--   drop function if exists public.memory_invalidate_edge(uuid, timestamptz);
--   drop table if exists public.memory_entity_mentions;
--   drop table if exists public.memory_entities;
--   drop table if exists public.memory_entity_types;
--   drop table if exists public.memory_relationship_types;
--   drop index if exists public.memory_items_consolidation_community_key_idx;
--   drop index if exists public.memory_items_problem_signature_hash_idx;
--   drop index if exists public.memory_items_problem_signature_class_idx;
--   drop index if exists public.memory_relationships_live_target_idx;
--   drop index if exists public.memory_relationships_live_source_idx;
--   -- §2b: reverting the source_type CHECK STRANDS any consolidation_summary row
--   -- already written — delete or retype those first, or the ADD CONSTRAINT
--   -- fails. valid_at / invalid_at are deliberately NOT in this list: dropping
--   -- invalid_at discards every retraction ever recorded, which is exactly the
--   -- data loss invalidate-don't-delete exists to prevent. Drop them only with
--   -- an explicit decision to discard that history.
--   -- expand_memory_neighborhood must be restored from migration 009's body PLUS
--   -- 019's search_path pin — 009 alone re-introduces the GATE 4 hole.

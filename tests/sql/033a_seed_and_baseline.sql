-- tests/sql/033a_seed_and_baseline.sql — Sprint 82 T1, part 1 of 2.
--
-- Runs against a database with migrations 001..032 applied and 033 NOT yet
-- applied. Seeds two isolated fixtures and records what the PRE-033 function
-- does with them, so that 033b can prove — against the real 032 function rather
-- than a hand-copied reference of it — that:
--
--   * the two-phase rewrite returns byte-identical (id, score) pairs for
--     default args on a corpus smaller than the branch limit, and
--   * the pre-033 full-text branch could not use an index EVEN WITH
--     enable_seqscan disabled, which is the claim migration 033 rests on.
--
-- Pairing 033a/033b this way means the equivalence assertion has no duplicated
-- SQL to drift: the baseline IS migration 032's output.
--
-- ⚠ THIS SCRIPT WRITES TO public.memory_items. Two independent guards keep it
-- away from a real store: it refuses to run outside a database named
-- 'mnestra_test', and every row it touches carries one of two sentinel
-- projects that no real memory uses. 033b deletes exactly those.

\set ON_ERROR_STOP on
set search_path = public, extensions, pg_catalog;

-- ── Guard 1: throwaway database only ────────────────────────────────────────
do $$
begin
  if current_database() <> 'mnestra_test' then
    raise exception
      '[033-test] REFUSING TO RUN: this script seeds and deletes rows in memory_items. Expected database "mnestra_test", got "%".',
      current_database();
  end if;
end $$;

-- ── Fixture helpers ─────────────────────────────────────────────────────────
-- A unit vector whose cosine similarity with the query vector mk_vec(1.0) is
-- exactly p_cos: [p_cos, sqrt(1 - p_cos²), 0, 0, ...] has unit length, and the
-- query vector is the first basis vector, so the dot product IS p_cos. That
-- makes every similarity in this fixture an exact, hand-chosen number instead
-- of an artifact of whatever text got embedded.
create or replace function public.__t033_mk_vec(p_cos double precision)
returns vector(1536)
language sql
immutable
set search_path = public, extensions, pg_catalog
as $$
  select ('[' || string_agg(
            case i
              when 1 then p_cos::text
              when 2 then sqrt(greatest(1.0 - p_cos * p_cos, 0.0))::text
              else '0'
            end, ',' order by i) || ']')::vector(1536)
    from generate_series(1, 1536) as i;
$$;

-- The query this whole test is built around, stored so 033b uses the identical
-- one. plainto_tsquery('english', …) is AND-semantics, so only rows carrying
-- ALL THREE of flashback/timeout/regression enter the full-text branch.
drop table if exists public.__t033_query;
create table public.__t033_query (
  qtext text not null,
  qvec  vector(1536) not null
);
insert into public.__t033_query (qtext, qvec)
values ('flashback timeout regression', public.__t033_mk_vec(1.0));

-- ── Fixture A: __t033_small__ (12 rows) ─────────────────────────────────────
-- Smaller than the default branch limit of 60, so BOTH branches return the
-- whole filtered set and the two-phase function is provably identical to 032
-- rather than merely close. Queried with filter_project = '__t033_small__' so
-- the assertion is independent of anything else in the database.
--
-- The two rows the decay-profile assertion turns on:
--   s01  bug_fix, 200 days old, cosine 0.95 → semantic rank 1
--   s02  fact,    300 days old, cosine 0.94 → semantic rank 2
-- Neither contains a query term, so neither enters the full-text branch and
-- their scores come purely from the semantic ranks. Worked arithmetic:
--   standard:        s01 = 1/61 × 1/(1+200/30)  × 1.3 = 0.002780
--                    s02 = 1/62 × 1/(1+300/90)  × 1.0 = 0.003722   → s02 first
--   solved-problem:  s01 = 1/61 × 1/(1+200/365) × 1.3 = 0.013767
--                    s02 unchanged                     = 0.003722   → s01 first
-- A 1.3× margin one way and 3.7× the other — the flip is not a rounding
-- accident. (Both are additionally multiplied by the uniform 1.5 project
-- affinity factor, which cannot reorder anything.)
-- ⚠ EVERY source_type below must be a member of memory_items_source_type_check
-- (migration 028_capture_gates.sql:252-259). The permitted set is:
--   fact, decision, preference, bug_fix, architecture, code_context,
--   session_summary, document_chunk, commit_context, pre_compact_snapshot,
--   doctrine
-- Note what is NOT in it: 'debugging' and 'convention'. Both appear as arms of
-- memory_hybrid_search's decay CASE (inherited unchanged from 032 back through
-- 023/004/002) but they are Category values, not SourceType values — see
-- src/types.ts, where `debugging` and `convention` are members of `Category`.
-- Those two decay arms are therefore unreachable, which is a defect in the
-- inherited function rather than in this fixture; it is written up as a T1
-- FINDING and left for ORCH to scope. A fixture row using either value fails
-- the CHECK at INSERT and takes the whole CI job down before it reaches a
-- single assertion. tests/migration-033-hygiene.test.ts parses the permitted
-- set straight out of 028 and fails if anything here drifts outside it.
delete from public.memory_items where project in ('__t033_small__', '__t033_bulk__');

insert into public.memory_items (id, content, embedding, source_type, project, created_at) values
  ('00000000-0000-4000-8000-000000000001',
   'postgres connection pool exhaustion resolved by lowering max clients',
   public.__t033_mk_vec(0.95), 'bug_fix', '__t033_small__', now() - interval '200 days'),
  ('00000000-0000-4000-8000-000000000002',
   'the staging cluster runs three replicas behind a single load balancer',
   public.__t033_mk_vec(0.94), 'fact', '__t033_small__', now() - interval '300 days'),
  -- Rows carrying all three query terms: these exercise the full-text branch
  -- and therefore the fusion arithmetic, not just the vector branch.
  ('00000000-0000-4000-8000-000000000003',
   'flashback toast timeout regression traced to the dismissal blacklist',
   public.__t033_mk_vec(0.55), 'code_context', '__t033_small__', now() - interval '10 days'),
  ('00000000-0000-4000-8000-000000000004',
   'regression: flashback fires on every timeout even when suppressed',
   public.__t033_mk_vec(0.50), 'bug_fix', '__t033_small__', now() - interval '45 days'),
  -- Partial-term rows: deliberately do NOT match (AND semantics), so they
  -- appear in the vector branch only.
  ('00000000-0000-4000-8000-000000000005',
   'flashback rendering uses the recall composite as a percentage',
   public.__t033_mk_vec(0.45), 'architecture', '__t033_small__', now() - interval '5 days'),
  ('00000000-0000-4000-8000-000000000006',
   'timeout handling in the panel input path',
   public.__t033_mk_vec(0.40), 'code_context', '__t033_small__', now() - interval '3 days'),
  ('00000000-0000-4000-8000-000000000007',
   'decision: keep smartRank type-first ordering unchanged',
   public.__t033_mk_vec(0.35), 'decision', '__t033_small__', now() - interval '30 days'),
  ('00000000-0000-4000-8000-000000000008',
   'doctrine: never render an ordinal score as a similarity percentage',
   public.__t033_mk_vec(0.30), 'doctrine', '__t033_small__', now() - interval '60 days'),
  ('00000000-0000-4000-8000-000000000009',
   'the reinforcement loop writes recall_boost through a batched rpc',
   public.__t033_mk_vec(0.25), 'preference', '__t033_small__', now() - interval '90 days'),
  ('00000000-0000-4000-8000-00000000000a',
   'session wrap notes from an unrelated afternoon',
   public.__t033_mk_vec(0.20), 'session_summary', '__t033_small__', now() - interval '7 days'),
  ('00000000-0000-4000-8000-00000000000b',
   'an excerpt from a long vendor document about billing',
   public.__t033_mk_vec(0.15), 'document_chunk', '__t033_small__', now() - interval '20 days'),
  ('00000000-0000-4000-8000-00000000000c',
   'commit context: lane posts use an anchored bracketed header',
   public.__t033_mk_vec(0.10), 'commit_context', '__t033_small__', now() - interval '120 days');

-- ── Fixture B: __t033_bulk__ (1200 rows) ────────────────────────────────────
-- Large enough that "did the planner use an index" is a meaningful question.
-- Every 37th row carries all three query terms, giving the full-text branch a
-- selective (~3%) predicate — the case a GIN index exists to serve.
insert into public.memory_items (id, content, embedding, source_type, project, created_at)
select
  gen_random_uuid(),
  case when i % 37 = 0
       then 'flashback timeout regression filler row ' || i
       else 'unrelated filler memory about deployment topic ' || i
  end,
  public.__t033_mk_vec(0.9 * (i::double precision / 1200.0)),
  (array['fact','decision','bug_fix','architecture','code_context'])[1 + (i % 5)],
  '__t033_bulk__',
  now() - (i || ' hours')::interval
from generate_series(1, 1200) as i;

-- One distinguished row that is provably FULL-TEXT-ONLY, so 033b can pin the
-- I1 contract clause "every returned row carries semantic_similarity, including
-- rows the vector branch never saw". Three repetitions of every query term put
-- it at ts_rank_cd rank 1 with no tie to break; cosine 0.01 puts it about as
-- far from the vector branch's top-k (cosine ≥ 0.88) as the fixture allows.
-- Being one hour old and source_type 'fact', it also comfortably clears the
-- final match_count cut, so the assertion never depends on a near-miss.
insert into public.memory_items (id, content, embedding, source_type, project, created_at) values
  ('00000000-0000-4000-8000-0000000000f1',
   'flashback timeout regression flashback timeout regression flashback timeout regression',
   public.__t033_mk_vec(0.01), 'fact', '__t033_bulk__', now() - interval '1 hour');

analyze public.memory_items;

-- ── Baseline 1: migration 032's exact output on fixture A ───────────────────
-- (id, score) pairs, not an ordering — comparing scores is the stronger claim,
-- and it sidesteps any assumption about the order a function scan emits rows.
-- `captured_at` is load-bearing, not bookkeeping. Every score carries a recency
-- decay of 1/(1 + (now() - created_at)/τ), and `now()` is transaction time — so
-- the baseline and 033b's re-run see DIFFERENT clocks, separated by however long
-- migration 033 takes to apply. The scores therefore CANNOT be bit-identical,
-- and 033b derives its comparison tolerance from this timestamp rather than
-- hard-coding one. See 033b § 1.
drop table if exists public.__t033_baseline;
create table public.__t033_baseline as
select h.id, h.score, now() as captured_at
  from public.__t033_query q,
       lateral public.memory_hybrid_search(
         q.qtext, q.qvec, 20, 1.0, 1.0, 60, '__t033_small__', null
       ) as h;

do $$
declare
  v_n int;
begin
  select count(*) into v_n from public.__t033_baseline;
  raise notice '[033-test] pre-033 baseline captured: % rows (expect 12)', v_n;
  if v_n <> 12 then
    raise exception '[033-test] baseline should contain all 12 fixture-A rows, got % — fixture or filter is wrong, later assertions would be meaningless', v_n;
  end if;
end $$;

-- Plan capture deliberately lives entirely in 033b. The before/after index
-- evidence compares two QUERY SHAPES (032's whole-corpus scan vs 033's
-- indexed top-k), and both shapes are plain SQL the test writes for itself —
-- so neither needs the pre-033 function to still exist. See the header of
-- 033b § 6 for why explaining the function itself cannot produce this
-- evidence at all.

\echo '[033-test] 033a complete: fixtures seeded, pre-033 baseline captured.'

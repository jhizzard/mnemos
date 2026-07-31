-- tests/sql/034a_seed_legacy_edges.sql — Sprint 83 T1, part 1 of 2.
--
-- Runs against a database with migrations 001..033 applied and 034 NOT yet
-- applied. This ordering is the whole point of the file: 034's central
-- backward-compatibility claim is "every edge that existed before me is still
-- valid after me", and that claim can only be tested by edges that genuinely
-- pre-date it. A fixture seeded AFTER 034 would be proving something else.
--
-- (This is the Sprint 82 lesson applied: every fixture must be legal under the
-- constraints in force at ITS step. Everything below is legal pre-034 — the
-- edge types used are all in 028's 10-value CHECK, and no row references a
-- column 034 has not created yet.)
--
-- What it seeds:
--   1. Eight sentinel memories forming the graph 034b walks.
--   2. Legacy edges with BACKDATED created_at, so 034b can prove valid_at was
--      backfilled from created_at rather than stamped with the apply time.
--   3. One edge carrying a relationship_type that 034's hard-coded 14-value
--      list has never heard of. This is the important one: it simulates an
--      install with a third-party edge writer, a hand-inserted edge, or a
--      graph-inference vocabulary that shipped ahead of its migration. 034
--      adopts DISTINCT relationship_type into the vocabulary table before
--      adding the FK precisely so that install still applies; without that
--      adoption pass this fixture makes migration 034 FAIL, which is exactly
--      the regression we want a test to catch.
--
-- ⚠ THIS SCRIPT WRITES TO public.memory_items AND public.memory_relationships.
-- Two guards keep it away from a real store: it refuses to run outside a
-- database named 'mnestra_test', and every row it touches carries the sentinel
-- project '__t034__'. 034b deletes exactly those.

\set ON_ERROR_STOP on
set search_path = public, extensions, pg_catalog;

-- ── Guard: throwaway database only ──────────────────────────────────────────
do $$
begin
  if current_database() <> 'mnestra_test' then
    raise exception
      '[034-test] REFUSING TO RUN: this script seeds and deletes rows in memory_items/memory_relationships. Expected database "mnestra_test", got "%".',
      current_database();
  end if;
end $$;

-- ── Guard: we really are pre-034 ────────────────────────────────────────────
-- If 034 has already run, the "legacy" edges below are not legacy and every
-- assertion in 034b built on them is vacuous. Fail loudly rather than silently
-- degrade into a test that proves nothing.
do $$
begin
  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public'
       and table_name   = 'memory_relationships'
       and column_name  = 'invalid_at'
  ) then
    raise exception
      '[034-test] REFUSING TO RUN: migration 034 has already been applied, so these fixtures would not pre-date it. Run 034a between migration 033 and migration 034.';
  end if;
end $$;

-- ── Fixture memories ────────────────────────────────────────────────────────
-- Ids are fixed so 034b can reference them without a lookup table.
--
--   M1  the SYMPTOM (carries T2's problem_signature object shape)
--   M2  the FIX
--   M3  a same-pattern sibling
--   M4  reachable from M1 only via relates_to  → must NOT appear in a default
--       (typed) expansion
--   M5  TOMBSTONED (superseded_by = M2)        → must never be returned
--   M6  reachable only THROUGH M5              → must never be returned either,
--       which is the difference between filtering results and filtering paths
--   M7  reached via an edge 034b invalidates   → must disappear after retraction
--   M8  depth-2 from M1 via M2                 → exercises the depth clamp
insert into public.memory_items
  (id, content, source_type, project, metadata, created_at)
values
  ('00000000-0000-4000-9000-000000000001',
   'permission denied for table memory_items when the anon key hit PostgREST',
   'bug_fix', '__t034__',
   jsonb_build_object(
     'problem_signature', jsonb_build_object(
       'v', 1,
       'class', 'err-pg-permission-denied',
       'symptom', 'permission denied for table memory_items',
       'symptom_hash', '9f2c00000000000000000000000000ab',
       'extracted_by', 'fixture@034a',
       'extracted_at', '2026-07-31T18:00:00.000Z'
     )
   ),
   now() - interval '120 days'),
  ('00000000-0000-4000-9000-000000000002',
   'fix: grant execute to service_role and revoke from anon after every CREATE',
   'decision', '__t034__', '{}'::jsonb, now() - interval '119 days'),
  ('00000000-0000-4000-9000-000000000003',
   'the same permission-denied shape appeared in the rumen edge function',
   'fact', '__t034__', '{}'::jsonb, now() - interval '100 days'),
  ('00000000-0000-4000-9000-000000000004',
   'loosely related note about PostgREST schema cache reloads',
   'architecture', '__t034__', '{}'::jsonb, now() - interval '90 days'),
  ('00000000-0000-4000-9000-000000000005',
   'superseded advice: just grant anon and move on',
   'fact', '__t034__', '{}'::jsonb, now() - interval '80 days'),
  ('00000000-0000-4000-9000-000000000006',
   'reachable only through the tombstoned memory',
   'fact', '__t034__', '{}'::jsonb, now() - interval '70 days'),
  ('00000000-0000-4000-9000-000000000007',
   'a cause that will later be retracted',
   'fact', '__t034__', '{}'::jsonb, now() - interval '60 days'),
  ('00000000-0000-4000-9000-000000000008',
   'two hops from the symptom, via the fix',
   'decision', '__t034__', '{}'::jsonb, now() - interval '50 days');

-- M5 is tombstoned. Set AFTER the inserts so the FK target exists.
update public.memory_items
   set superseded_by = '00000000-0000-4000-9000-000000000002',
       is_active     = false
 where id = '00000000-0000-4000-9000-000000000005';

-- ── Legacy edges, all with types legal under 028's CHECK ────────────────────
-- created_at is BACKDATED. 034 backfills valid_at from created_at, so 034b can
-- assert valid_at is the historical timestamp and not the apply time — the
-- difference between "we recorded when this became true" and "we stamped
-- everything with today", which is the failure the four-statement backfill in
-- §1 of the migration exists to avoid.
insert into public.memory_relationships
  (source_id, target_id, relationship_type, weight, created_at, inferred_by)
values
  -- M1 --caused_by--> M7 : retracted in 034b, proving live-only traversal.
  ('00000000-0000-4000-9000-000000000001',
   '00000000-0000-4000-9000-000000000007', 'caused_by', 0.90,
   now() - interval '59 days', 'fixture-034a'),
  -- M1 --relates_to--> M4 : off the default predicate allowlist.
  ('00000000-0000-4000-9000-000000000001',
   '00000000-0000-4000-9000-000000000004', 'relates_to', 0.88,
   now() - interval '89 days', 'fixture-034a'),
  -- M1 --supersedes--> M5 : reaches a TOMBSTONE. On the allowlist, so only the
  -- tombstone check can keep M5 out of the result.
  ('00000000-0000-4000-9000-000000000001',
   '00000000-0000-4000-9000-000000000005', 'supersedes', 0.80,
   now() - interval '79 days', 'fixture-034a'),
  -- M5 --supersedes--> M6 : the ONLY route to M6 runs through the tombstone.
  ('00000000-0000-4000-9000-000000000005',
   '00000000-0000-4000-9000-000000000006', 'supersedes', 0.80,
   now() - interval '69 days', 'fixture-034a'),
  -- M2 --supersedes--> M8 : gives M1 a depth-2 neighbour (M1→M2→M8).
  ('00000000-0000-4000-9000-000000000002',
   '00000000-0000-4000-9000-000000000008', 'supersedes', 0.70,
   now() - interval '49 days', 'fixture-034a'),
  -- M1 --contradicts--> M4 : the supersession sweep's only legitimate target.
  ('00000000-0000-4000-9000-000000000001',
   '00000000-0000-4000-9000-000000000004', 'contradicts', 0.60,
   now() - interval '88 days', 'fixture-034a');

-- ── The exotic-vocabulary edge ──────────────────────────────────────────────
-- Drop the CHECK first: this is precisely the state an install reaches when
-- someone widened the vocabulary out-of-band, and it is the one input that can
-- make 034's FK creation fail. Dropping a constraint we are about to replace is
-- legal at this step and is not a shortcut around the test — the shape being
-- tested is "034 encounters a value it does not know", and there is no other way
-- to produce it.
alter table public.memory_relationships
  drop constraint if exists memory_relationships_relationship_type_check;

insert into public.memory_relationships
  (source_id, target_id, relationship_type, weight, created_at, inferred_by)
values
  ('00000000-0000-4000-9000-000000000003',
   '00000000-0000-4000-9000-000000000004', 'legacy_exotic_link', 0.55,
   now() - interval '95 days', 'fixture-034a');

-- ── Capture the pre-034 state 034b compares against ─────────────────────────
drop table if exists public.__t034_baseline;
create table public.__t034_baseline as
select
  r.id,
  r.source_id,
  r.target_id,
  r.relationship_type,
  r.created_at
from public.memory_relationships r
join public.memory_items m on m.id = r.source_id
where m.project = '__t034__';

-- Corpus-wide edge count, so 034b can prove the migration retracted nothing
-- anywhere — not just inside the sentinel project.
drop table if exists public.__t034_counts;
create table public.__t034_counts as
select count(*) as edges_before from public.memory_relationships;

\echo '[034-test] 034a complete: 8 memories, 7 legacy edges (1 with an unknown relationship_type), baseline captured. Migration 034 may now apply.'

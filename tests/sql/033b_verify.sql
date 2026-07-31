-- tests/sql/033b_verify.sql — Sprint 82 T1, part 2 of 2.
--
-- Runs against a database where 033a seeded the fixtures and captured migration
-- 032's output, and migration 033 has since been applied. Everything here is
-- self-checking: each section RAISEs on failure, so a green run of this file is
-- the acceptance evidence, not a transcript somebody has to read.
--
-- Sections:
--   1  Equivalence — on a corpus smaller than the branch limit, 033 returns the
--      same SET in the same RANK ORDER as 032 (both exact), with scores agreeing
--      to within a derived clock-drift bound.
--   2  semantic_similarity is present, in range, and numerically the cosine.
--   3  Full-text-only rows carry it too (interface I1's hardest clause).
--   4  p_decay_profile = 'solved-problem' reorders old bug_fix vs old fact, and
--      leaves every other source_type untouched.
--   5  Unknown / NULL profiles degrade to 'standard' instead of raising.
--   6  A NULL query embedding degrades to full-text-only, honestly.
--   7  Index usage, before-shape vs after-shape.
--   8  The five RLS hygiene gates, re-checked independently of the migration's
--      own apply-time receipt.
--   9  p_branch_limit is clamped up to match_count.
--  10  Cleanup.

\set ON_ERROR_STOP on
set search_path = public, extensions, pg_catalog;

do $$
begin
  if current_database() <> 'mnestra_test' then
    raise exception
      '[033-test] REFUSING TO RUN: expected database "mnestra_test", got "%".',
      current_database();
  end if;
end $$;

-- Shared clock-drift tolerance. EVERY cross-capture score comparison in this
-- file needs it, not just § 1: any two result sets captured by two different
-- statements see two different `now()` values, and the recency decay turns that
-- into a score difference. § 4 and § 5 compare tables captured milliseconds
-- apart, which is still ~6e-10 — above a naive 1e-12 epsilon. Derivation of the
-- 6.099e-8/s constant is in § 1.
create or replace function public.__t033_tol(p_a timestamptz, p_b timestamptz)
returns double precision
language sql
immutable
set search_path = public, pg_catalog
as $$
  select 6.099e-8 * abs(extract(epoch from (p_a - p_b))) + 1e-12;
$$;

-- ════════════════════════════════════════════════════════════════════════════
-- 1. EQUIVALENCE against the real migration 032 output.
--
-- Fixture A has 12 rows and the branch limit is 60, so both branches return the
-- entire filtered set: 033's within-top-k ranks ARE 032's whole-corpus ranks,
-- and every multiplier is unchanged. The rank order must therefore be IDENTICAL,
-- which is asserted exactly, with no tolerance. The scores cannot be identical —
-- they depend on now() and the two captures straddle the migration apply — so
-- they are asserted against a bound derived from the measured elapsed time.
-- ════════════════════════════════════════════════════════════════════════════

drop table if exists public.__t033_new;
create table public.__t033_new as
select h.id, h.score, h.semantic_similarity, now() as captured_at
  from public.__t033_query q,
       lateral public.memory_hybrid_search(
         q.qtext, q.qvec, 20, 1.0, 1.0, 60, '__t033_small__', null
       ) as h;

-- Three assertions, strongest first. The scores CANNOT be bit-identical and it
-- is worth being precise about why, because the first version of this test
-- asserted 1e-9 and failed on exactly three rows:
--
--   score = base × decay × type_weight × project × recall_boost
--   decay = 1 / (1 + age/τ),  age = now() - created_at
--
-- `now()` is transaction time. The baseline is captured before migration 033 is
-- applied and this comparison runs after, so the two see clocks separated by
-- however long the apply takes. Differentiating:
--
--   |∂score/∂t| = base × weights × decay² / τ  ≤  Bmax × Wmax / τmin
--
-- with, for this fixture: Bmax = 2/61 (both branches rank 1) = 3.279e-2,
-- Wmax = 1.5 (doctrine/decision type weight) × 1.5 (project affinity) = 2.25,
-- τmin = 14 days = 1 209 600 s (code_context / session_summary / document_chunk).
--
--   SENSITIVITY_BOUND = 3.279e-2 × 2.25 / 1 209 600 = 6.099e-8 per second
--
-- The three rows that failed at 1e-9 were s03, s06 and s0a — precisely the three
-- τ=14d rows, i.e. the three highest sensitivities in the fixture, at an implied
-- elapsed time of ~0.2 s. Random floating-point noise would have hit arbitrary
-- rows; a monotonic hit on the top-3 sensitivities is the clock.
--
-- So: the tolerance is DERIVED from the measured elapsed time rather than picked.
-- A flat 1e-6 would have been wrong for this fixture anyway — its smallest
-- adjacent-rank gap is 2.97e-6 (s01→s0c, which land unusually close), not the
-- ~2.7e-4 a generic 1/61−1/62 argument suggests, leaving only ~3× headroom.
-- Assertion 2 measures that gap at runtime instead of assuming it.
--
-- (If you ever want this bit-exact: run 033a + 033 + 033b inside ONE transaction,
-- which pins now() and makes the decay identical on both sides. Not done here —
-- it would couple the migration apply to the test and roll the schema back on any
-- assertion failure, and the rank-order claim below is the one that matters.)
do $$
declare
  SENSITIVITY_BOUND constant double precision := 6.099e-8;  -- per second, derived above
  FLOAT_FLOOR       constant double precision := 1e-12;     -- pure IEEE754 noise
  v_n        int;
  v_elapsed  double precision;
  v_tol      double precision;
  v_missing  int;
  v_reordered int;
  v_bad      int;
  v_max_diff double precision;
  v_min_gap  double precision;
begin
  select count(*) into v_n from public.__t033_new;
  if v_n <> 12 then
    raise exception '[033-test §1] expected 12 rows from the two-phase function, got %', v_n;
  end if;

  select extract(epoch from (max(n.captured_at) - max(b.captured_at)))
    into v_elapsed
    from public.__t033_new n, public.__t033_baseline b;
  v_tol := SENSITIVITY_BOUND * greatest(v_elapsed, 0) + FLOAT_FLOOR;

  -- ── Assertion 1 (PRIMARY): the returned SET is identical. ────────────────
  select count(*) into v_missing
    from public.__t033_new n
    full join public.__t033_baseline b on b.id = n.id
   where n.id is null or b.id is null;
  if v_missing <> 0 then
    raise exception
      '[033-test §1] EQUIVALENCE FAILED: % row(s) added or dropped vs migration 032 on a corpus smaller than the branch limit — the rewrite changed WHICH rows come back, not just their scores',
      v_missing;
  end if;

  -- ── Assertion 2 (PRIMARY): the RANK ORDER is identical, exactly. ─────────
  -- This is what "equivalent ranking function" actually means, it is an integer
  -- comparison with no tolerance at all, and it is immune to clock drift: the
  -- drift is ~1e-8 while the smallest gap between adjacent ranks is ~3e-6.
  select count(*) into v_reordered
    from (select id, row_number() over (order by score desc, id) as pos
            from public.__t033_baseline) b
    join (select id, row_number() over (order by score desc, id) as pos
            from public.__t033_new) n on n.id = b.id
   where b.pos <> n.pos;
  if v_reordered <> 0 then
    raise exception
      '[033-test §1] EQUIVALENCE FAILED: % row(s) changed rank position vs migration 032. This is a real ranking regression, not clock drift.',
      v_reordered;
  end if;

  -- ── Assertion 3 (SECONDARY): scores agree within the derived bound. ──────
  select max(abs(n.score - b.score)) into v_max_diff
    from public.__t033_new n join public.__t033_baseline b on b.id = n.id;

  select min(gap) into v_min_gap
    from (select score - lead(score) over (order by score desc) as gap
            from public.__t033_new) g
   where gap > 0;

  raise notice '[033-test §1] elapsed % s → tolerance %; max |Δscore| = %; smallest adjacent-rank gap = % (headroom %×)',
    round(v_elapsed::numeric, 3), v_tol, coalesce(v_max_diff, 0), v_min_gap,
    round((v_min_gap / v_tol)::numeric, 1);

  select count(*) into v_bad
    from public.__t033_new n join public.__t033_baseline b on b.id = n.id
   where abs(n.score - b.score) > v_tol;
  if v_bad <> 0 then
    raise exception
      '[033-test §1] % row(s) differ by more than the clock-drift bound (max |Δ| = %, tolerance = % for % s elapsed). Ranks matched, so this is not a reordering — but the scores moved more than elapsed time can explain.',
      v_bad, v_max_diff, v_tol, round(v_elapsed::numeric, 3);
  end if;

  -- Self-check: a tolerance as large as the smallest adjacent-rank gap would
  -- make assertion 3 vacuous. Assertion 2 still holds independently, so this is
  -- belt-and-suspenders — but if it trips, the apply took absurdly long and the
  -- pair should be re-run back-to-back.
  if v_tol >= v_min_gap then
    raise exception
      '[033-test §1] tolerance (%) has grown to the smallest adjacent-rank gap (%) after % s elapsed — the score comparison is no longer meaningful; re-run 033a → 033 → 033b back-to-back',
      v_tol, v_min_gap, round(v_elapsed::numeric, 3);
  end if;
  if v_min_gap / v_tol < 10 then
    raise notice '[033-test §1] WARNING: only %× headroom between the smallest rank gap and the drift tolerance; the apply is running slower than expected',
      round((v_min_gap / v_tol)::numeric, 1);
  end if;
end $$;

-- ════════════════════════════════════════════════════════════════════════════
-- 2. semantic_similarity — present, in range, and actually the cosine.
--
-- Fixture A's embeddings were built so each row's cosine with the query is a
-- number chosen by hand, which turns "is this really the cosine?" into an exact
-- comparison instead of a smell test. Tolerance 1e-4 covers pgvector's float4
-- element storage comfortably.
-- ════════════════════════════════════════════════════════════════════════════

do $$
declare
  v_null_or_out int;
  v_s01 double precision;
  v_s02 double precision;
begin
  select count(*) into v_null_or_out
    from public.__t033_new
   where semantic_similarity is null
      or semantic_similarity < -1.0 - 1e-6
      or semantic_similarity >  1.0 + 1e-6;
  if v_null_or_out <> 0 then
    raise exception '[033-test §2] % row(s) have a NULL or out-of-[-1,1] semantic_similarity', v_null_or_out;
  end if;

  select semantic_similarity into v_s01
    from public.__t033_new where id = '00000000-0000-4000-8000-000000000001';
  select semantic_similarity into v_s02
    from public.__t033_new where id = '00000000-0000-4000-8000-000000000002';

  raise notice '[033-test §2] cosines: s01=% (expect 0.95), s02=% (expect 0.94)', v_s01, v_s02;

  if v_s01 is null or abs(v_s01 - 0.95) > 1e-4 then
    raise exception '[033-test §2] s01 semantic_similarity should be 0.95, got %', v_s01;
  end if;
  if v_s02 is null or abs(v_s02 - 0.94) > 1e-4 then
    raise exception '[033-test §2] s02 semantic_similarity should be 0.94, got %', v_s02;
  end if;
end $$;

-- ════════════════════════════════════════════════════════════════════════════
-- 3. Interface I1's hardest clause: a row that entered on the FULL-TEXT branch
--    only — never seen by the vector branch — still carries its cosine, because
--    033 recomputes it over the fused set.
--
--    The distinguished bulk row has ts_rank_cd rank 1 (three repetitions of
--    every query term) and cosine 0.01 against a vector top-k that starts near
--    0.88, so its full-text-only status is structural, not incidental.
-- ════════════════════════════════════════════════════════════════════════════

do $$
declare
  v_sim  double precision;
  v_seen boolean;
begin
  select true, h.semantic_similarity into v_seen, v_sim
    from public.__t033_query q,
         lateral public.memory_hybrid_search(
           q.qtext, q.qvec, 20, 1.0, 1.0, 60, '__t033_bulk__', null
         ) as h
   where h.id = '00000000-0000-4000-8000-0000000000f1';

  if not coalesce(v_seen, false) then
    raise exception '[033-test §3] the full-text-only row never appeared in the fused result — the FTS branch is not contributing to fusion';
  end if;

  raise notice '[033-test §3] full-text-only row cosine = % (expect ~0.01, and NOT NULL)', v_sim;

  if v_sim is null then
    raise exception '[033-test §3] CONTRACT I1 VIOLATED: a row that matched only on the full-text branch came back with semantic_similarity = NULL; it must be recomputed for every returned row';
  end if;
  if abs(v_sim - 0.01) > 1e-4 then
    raise exception '[033-test §3] full-text-only row cosine should be 0.01, got % — it is not being recomputed against this query', v_sim;
  end if;
end $$;

-- ════════════════════════════════════════════════════════════════════════════
-- 4. p_decay_profile = 'solved-problem'.
--
--    s01 (bug_fix, 200d) vs s02 (fact, 300d): 'standard' buries the solved bug
--    under a 30-day half-life and s02 wins; 'solved-problem' flattens ONLY
--    bug_fix/debugging to 365 days and s01 wins. Worked arithmetic is in 033a's
--    fixture comment — the margins are 1.3× and 3.7×, not rounding.
--
--    The second assertion is the one that keeps the feature honest: every row
--    that is NOT bug_fix or debugging must score IDENTICALLY under both
--    profiles. A profile that quietly moved anything else would be a different,
--    unreviewed ranking change.
-- ════════════════════════════════════════════════════════════════════════════

drop table if exists public.__t033_std;
create table public.__t033_std as
select h.id, h.source_type, h.score, now() as captured_at
  from public.__t033_query q,
       lateral public.memory_hybrid_search(
         q.qtext, q.qvec, 20, 1.0, 1.0, 60, '__t033_small__', null, 60, 'standard'
       ) as h;

drop table if exists public.__t033_solved;
create table public.__t033_solved as
select h.id, h.source_type, h.score, now() as captured_at
  from public.__t033_query q,
       lateral public.memory_hybrid_search(
         q.qtext, q.qvec, 20, 1.0, 1.0, 60, '__t033_small__', null, 60, 'solved-problem'
       ) as h;

do $$
declare
  v_std_01    double precision;
  v_std_02    double precision;
  v_solved_01 double precision;
  v_solved_02 double precision;
  v_moved     int;
  v_lifted    int;
  v_tol       double precision;
begin
  -- The two profile runs are separate captures, so the same clock drift that
  -- § 1 accounts for applies here too.
  select public.__t033_tol(max(v.captured_at), max(s.captured_at)) into v_tol
    from public.__t033_std s, public.__t033_solved v;
  select score into v_std_01    from public.__t033_std    where id = '00000000-0000-4000-8000-000000000001';
  select score into v_std_02    from public.__t033_std    where id = '00000000-0000-4000-8000-000000000002';
  select score into v_solved_01 from public.__t033_solved where id = '00000000-0000-4000-8000-000000000001';
  select score into v_solved_02 from public.__t033_solved where id = '00000000-0000-4000-8000-000000000002';

  raise notice '[033-test §4] standard: bug_fix=% fact=% | solved-problem: bug_fix=% fact=%',
    v_std_01, v_std_02, v_solved_01, v_solved_02;

  if not (v_std_01 < v_std_02) then
    raise exception '[033-test §4] under ''standard'' the 200-day bug_fix (%) should still rank BELOW the 300-day fact (%) — the fixture no longer demonstrates the burial this feature exists to fix', v_std_01, v_std_02;
  end if;
  if not (v_solved_01 > v_solved_02) then
    raise exception '[033-test §4] under ''solved-problem'' the 200-day bug_fix (%) must outrank the 300-day fact (%) — the flattened decay is not being applied', v_solved_01, v_solved_02;
  end if;

  -- bug_fix / debugging must be lifted...
  select count(*) into v_lifted
    from public.__t033_std s join public.__t033_solved v on v.id = s.id
   where s.source_type in ('bug_fix', 'debugging')
     and v.score > s.score + v_tol;
  if v_lifted = 0 then
    raise exception '[033-test §4] no bug_fix/debugging row was lifted by the solved-problem profile';
  end if;

  -- ...and nothing else may move at all.
  select count(*) into v_moved
    from public.__t033_std s
    full join public.__t033_solved v on v.id = s.id
   where s.id is null
      or v.id is null
      or (s.source_type not in ('bug_fix', 'debugging') and abs(s.score - v.score) > v_tol);
  raise notice '[033-test §4] rows lifted: %; non-bug_fix/debugging rows moved: % (expect 0)', v_lifted, v_moved;
  if v_moved <> 0 then
    raise exception '[033-test §4] the solved-problem profile changed % row(s) outside bug_fix/debugging — it must touch nothing else', v_moved;
  end if;
end $$;

-- ════════════════════════════════════════════════════════════════════════════
-- 5. Unknown and NULL profiles fall back to 'standard' — silently, never an
--    error. A recall path that raises because a caller passed a typo would be
--    strictly worse than one that ranks slightly differently.
-- ════════════════════════════════════════════════════════════════════════════

do $$
declare
  v_bad int;
  v_tol double precision;
begin
  -- __t033_std was captured by an earlier statement, so the same clock drift
  -- accounted for in section 1 applies to every comparison against it. The
  -- inline queries below run inside THIS transaction, so now() is their capture
  -- time.
  select public.__t033_tol(now(), max(captured_at)) into v_tol
    from public.__t033_std;

  select count(*) into v_bad
    from (
      select h.id, h.score
        from public.__t033_query q,
             lateral public.memory_hybrid_search(
               q.qtext, q.qvec, 20, 1.0, 1.0, 60, '__t033_small__', null, 60, 'not-a-real-profile'
             ) as h
    ) x
    full join public.__t033_std s on s.id = x.id
   where x.id is null or s.id is null or abs(x.score - s.score) > v_tol;
  if v_bad <> 0 then
    raise exception '[033-test §5] an unknown p_decay_profile did not behave exactly like ''standard'' (% differing row(s))', v_bad;
  end if;

  select count(*) into v_bad
    from (
      select h.id, h.score
        from public.__t033_query q,
             lateral public.memory_hybrid_search(
               q.qtext, q.qvec, 20, 1.0, 1.0, 60, '__t033_small__', null, 60, null
             ) as h
    ) x
    full join public.__t033_std s on s.id = x.id
   where x.id is null or s.id is null or abs(x.score - s.score) > v_tol;
  if v_bad <> 0 then
    raise exception '[033-test §5] a NULL p_decay_profile did not behave exactly like ''standard'' (% differing row(s))', v_bad;
  end if;

  raise notice '[033-test §5] unknown and NULL profiles both degrade to standard.';
end $$;

-- ════════════════════════════════════════════════════════════════════════════
-- 6. A NULL query embedding degrades to full-text-only.
--
--    Migration 032 handed every row a semantic rank in this case — ordering
--    NULL distances and feeding the resulting arbitrary permutation straight
--    into the RRF sum. 033 gates the branch off instead: only genuine full-text
--    matches come back (s03 and s04, the two fixture-A rows carrying all three
--    query terms), each reporting semantic_similarity = NULL rather than a
--    fabricated number.
-- ════════════════════════════════════════════════════════════════════════════

do $$
declare
  v_n        int;
  v_non_null int;
begin
  select count(*), count(semantic_similarity) into v_n, v_non_null
    from public.__t033_query q,
         lateral public.memory_hybrid_search(
           q.qtext, null::vector(1536), 20, 1.0, 1.0, 60, '__t033_small__', null
         ) as h;

  raise notice '[033-test §6] NULL-embedding call returned % row(s) (expect 2), % with a non-null cosine (expect 0)',
    v_n, v_non_null;

  if v_n <> 2 then
    raise exception '[033-test §6] expected exactly the 2 full-text matches with no embedding, got % — the vector branch is still contributing a fabricated ranking', v_n;
  end if;
  if v_non_null <> 0 then
    raise exception '[033-test §6] semantic_similarity must be NULL when no query embedding was supplied, found % non-null', v_non_null;
  end if;
end $$;

-- ════════════════════════════════════════════════════════════════════════════
-- 7. INDEX USAGE — before-shape vs after-shape.
--
-- ⚠ Why this section explains QUERY SHAPES rather than calling
--   memory_hybrid_search_explain: EXPLAIN over a call to a non-inlinable
--   function reports a single "Function Scan" line and NOTHING about the plan
--   inside the function body. memory_hybrid_search carries a SET clause (it
--   must — GATE 4 pins search_path), which makes it non-inlinable by
--   construction, so the 004-era wrapper can report timing and buffers for the
--   call but can NEVER evidence which indexes the body used. Anyone who
--   "verifies both indexes are used" by reading that wrapper's output is
--   reading a Function Scan line and seeing what they expected to see.
--
--   So the honest test explains the two branch shapes directly: migration 032's
--   (whole-corpus ts_rank_cd, no @@; bare cosine, no ORDER BY … LIMIT) against
--   033's (@@ prefilter + ORDER BY … LIMIT; distance ORDER BY … LIMIT). The
--   risk this trades in is drift between these copies and the real function
--   body — closed by tests/migration-033-hygiene.test.ts, which pins the exact
--   shape tokens in the migration file itself.
--
--   enable_seqscan = off throughout: it tells the planner "use an index if you
--   possibly can", which makes the before-result the strong claim it needs to
--   be. 032's shape cannot use these indexes even when the planner is pushed.
--
-- ⚠ SERVABILITY vs CHOICE — the distinction this section turns on, learned the
--   hard way. An earlier version asserted that the rewritten vector branch WOULD
--   BE PLANNED with the HNSW index, and it failed on a clean database: the
--   planner chose a bitmap scan on memory_items_source_type_idx_v2 (005 —
--   partial on exactly the live-row predicate, so it answers the WHERE clause
--   outright) followed by a top-N distance sort. That is not a defect. At 1212
--   rows sorting really is cheaper, and Postgres's cost model understates `<=>`
--   by pricing it as one operator call rather than 1536 multiply-adds, so it
--   leans that way anyway. Asserting a planner CHOICE on a toy corpus is
--   asserting something that is both unguaranteeable and, here, wrong.
--
--   What 033 actually changes is SERVABILITY: 032's vector shape has no
--   ORDER BY … LIMIT, so no HNSW plan exists for it at ANY planner setting;
--   033's does, so one exists. That is the property under test, and it is
--   verifiable on a small fixture. The vector branch is therefore checked with
--   enable_sort ALSO disabled — forcing the planner to reach the ordering
--   through an index if it can — and the unconstrained plan is recorded
--   alongside as evidence rather than asserted.
--
--   The full-text branch keeps its CHOICE assertion, because there the `@@`
--   predicate is selective and GIN is the only way to answer it at all — the
--   planner has no comparable alternative to be tempted by.
--
--   CHOICE at daily-driver scale is a real question this test cannot answer,
--   and it is the one that decides whether the vector half of the perf fix
--   lands. ORCH confirms it post-apply against the real corpus; the query is in
--   § 6a(i) of the migration.
-- ════════════════════════════════════════════════════════════════════════════

create or replace function public.__t033_plan(p_sql text)
returns text
language plpgsql
set search_path = public, extensions, pg_catalog
as $$
declare
  v_line text;
  v_all  text := '';
begin
  for v_line in execute 'explain (analyze, buffers, format text) ' || p_sql loop
    v_all := v_all || v_line || E'\n';
  end loop;
  return v_all;
end;
$$;

set enable_seqscan = off;

do $$
declare
  v_qtext  text;
  v_qvec   text;
  v_filter text := 'm.is_active = true and m.archived = false '
                || 'and m.superseded_by is null and m.embedding is not null';
  v_before_ft  text;
  v_before_vec text;
  v_after_ft   text;
  v_after_vec  text;
  v_choice_vec text;
begin
  select qtext, qvec::text into v_qtext, v_qvec from public.__t033_query;

  -- BEFORE — migration 032's full-text shape: ts_rank_cd over every candidate
  -- row, no @@ predicate for an index to answer.
  v_before_ft := public.__t033_plan(format($q$
    select m.id,
           ts_rank_cd(to_tsvector('english', m.content),
                      plainto_tsquery('english', %L)) as ft_rank
      from public.memory_items m
     where %s
  $q$, v_qtext, v_filter));

  -- BEFORE — 032's vector shape: the cosine as a projected column, with no
  -- ORDER BY … LIMIT for the HNSW access method to satisfy.
  v_before_vec := public.__t033_plan(format($q$
    select m.id, 1 - (m.embedding <=> %L::vector(1536)) as sem_rank
      from public.memory_items m
     where %s
  $q$, v_qvec, v_filter));

  -- AFTER — 033's full-text branch.
  v_after_ft := public.__t033_plan(format($q$
    select m.id,
           ts_rank_cd(to_tsvector('english', m.content),
                      plainto_tsquery('english', %L)) as ft_rank
      from public.memory_items m
     where %s
       and to_tsvector('english', m.content) @@ plainto_tsquery('english', %L)
     order by ft_rank desc nulls last, m.id
     limit 60
  $q$, v_qtext, v_filter, v_qtext));

  -- AFTER — 033's vector branch, with sorting ALSO disabled. See the header:
  -- this asks "can the HNSW index satisfy this query's ordering", which is the
  -- property 032 lacked, rather than "did the planner pick it on 1212 rows",
  -- which is a cost decision and legitimately goes the other way here.
  perform set_config('enable_sort', 'off', false);
  v_after_vec := public.__t033_plan(format($q$
    select m.id, (m.embedding <=> %L::vector(1536)) as dist
      from public.memory_items m
     where %s
     order by m.embedding <=> %L::vector(1536)
     limit 60
  $q$, v_qvec, v_filter, v_qvec));
  perform set_config('enable_sort', 'on', false);

  -- OBSERVED — the same shape with the planner completely unconstrained. NOT
  -- asserted: recorded so the choice is visible in the run log and so ORCH can
  -- compare it against the daily driver post-apply.
  perform set_config('enable_seqscan', 'on', false);
  v_choice_vec := public.__t033_plan(format($q$
    select m.id, (m.embedding <=> %L::vector(1536)) as dist
      from public.memory_items m
     where %s
     order by m.embedding <=> %L::vector(1536)
     limit 60
  $q$, v_qvec, v_filter, v_qvec));
  perform set_config('enable_seqscan', 'off', false);

  raise notice E'[033-test §7] BEFORE full-text plan:\n%', v_before_ft;
  raise notice E'[033-test §7] AFTER  full-text plan:\n%', v_after_ft;
  raise notice E'[033-test §7] BEFORE vector plan:\n%', v_before_vec;
  raise notice E'[033-test §7] AFTER  vector plan (servability, sort disabled):\n%', v_after_vec;
  raise notice E'[033-test §7] OBSERVED vector plan (planner unconstrained, NOT asserted):\n%', v_choice_vec;

  -- The regression this migration exists to fix.
  if v_before_ft like '%memory_items_content_fts_gin%' then
    raise exception '[033-test §7] unexpected: migration 032''s full-text shape DID use the GIN index — the premise of this migration is wrong, re-derive before shipping';
  end if;
  if v_before_vec like '%memory_items_embedding_hnsw%' then
    raise exception '[033-test §7] unexpected: migration 032''s vector shape DID use the HNSW index — the premise of this migration is wrong, re-derive before shipping';
  end if;

  -- The fix.
  if v_after_ft not like '%memory_items_content_fts_gin%' then
    raise exception E'[033-test §7] the rewritten full-text branch did NOT use memory_items_content_fts_gin. Plan:\n%', v_after_ft;
  end if;
  -- Servability, hard-asserted: with sorting disabled the planner must reach the
  -- ordering through an index, and an HNSW index CAN provide it for this shape.
  -- Matches either HNSW index (001's unqualified one or 033's partial live-row
  -- one) — which of the two wins is a cost decision, that one is reachable at
  -- all is the property under test.
  if v_after_vec not like '%memory_items_embedding_hnsw%' then
    raise exception E'[033-test §7] SERVABILITY FAILED: with enable_sort=off the rewritten vector branch still could not be answered by an HNSW index. The ORDER BY … LIMIT shape is not index-servable — this is the actual regression. Plan:\n%', v_after_vec;
  end if;

  -- Choice, observed only. On this fixture the planner is EXPECTED to prefer a
  -- bitmap scan + distance sort, and that is the correct call at 1212 rows.
  if v_choice_vec like '%memory_items_embedding_hnsw%' then
    raise notice '[033-test §7] the unconstrained planner CHOSE an HNSW index on this fixture.';
  else
    raise notice '[033-test §7] the unconstrained planner chose a non-HNSW plan on this fixture (expected at 1212 rows: sorting a small set is genuinely cheaper, and Postgres prices <=> as one operator call rather than 1536 multiply-adds). Servability is asserted above; CHOICE at daily-driver scale must be confirmed post-apply — see § 6a(i) of the migration.';
  end if;

  raise notice '[033-test §7] index usage: neither index was reachable by the 032 shapes even with enable_seqscan=off; the 033 full-text shape is CHOSEN and the 033 vector shape is SERVABLE.';
end $$;

reset enable_seqscan;

-- ════════════════════════════════════════════════════════════════════════════
-- 8. RLS hygiene gates, re-checked independently of the migration's own
--    apply-time receipt. A receipt that lives inside the artifact it certifies
--    is worth having, but it is not an independent check.
-- ════════════════════════════════════════════════════════════════════════════

do $$
declare
  fn      text;
  v_oid   oid;
  v_cnt   int;
  v_cfg   text;
begin
  foreach fn in array array['memory_hybrid_search', 'memory_hybrid_search_explain']
  loop
    select count(*) into v_cnt
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = fn;
    if v_cnt <> 1 then
      raise exception '[033-test §8] % has % overloads; exactly 1 is required or 8-arg calls become ambiguous', fn, v_cnt;
    end if;

    select p.oid, array_to_string(p.proconfig, '; ') into v_oid, v_cfg
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = fn;

    if has_function_privilege('anon', v_oid, 'EXECUTE')
       or has_function_privilege('authenticated', v_oid, 'EXECUTE')
       or has_function_privilege('public', v_oid, 'EXECUTE') then
      raise exception '[033-test §8] GATE 3: % is executable by anon/authenticated/public', fn;
    end if;
    if not has_function_privilege('service_role', v_oid, 'EXECUTE') then
      raise exception '[033-test §8] GATE 3: service_role lost EXECUTE on %', fn;
    end if;
    if coalesce(v_cfg, '') not like '%search_path=public, extensions, pg_catalog%' then
      raise exception '[033-test §8] GATE 4: % search_path not pinned (proconfig: %)', fn, coalesce(v_cfg, '<none>');
    end if;
  end loop;

  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public'
                and p.proname in ('memory_hybrid_search', 'memory_hybrid_search_explain')
                and p.prosecdef) then
    raise exception '[033-test §8] GATE 5: a 033 function is SECURITY DEFINER';
  end if;

  if not (select c.relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public' and c.relname = 'memory_items') then
    raise exception '[033-test §8] GATE 1: RLS is not enabled on public.memory_items';
  end if;

  raise notice '[033-test §8] hygiene gates 1/3/4/5 clean on both functions.';
end $$;

-- ════════════════════════════════════════════════════════════════════════════
-- 9. p_branch_limit is clamped UP to match_count. Without the clamp, asking for
--    12 rows with a branch limit of 1 would fuse at most 2 candidates and
--    silently return 2 rows — a caller-supplied tuning knob able to truncate
--    the result set is a footgun, not a knob.
-- ════════════════════════════════════════════════════════════════════════════

do $$
declare
  v_n int;
begin
  select count(*) into v_n
    from public.__t033_query q,
         lateral public.memory_hybrid_search(
           q.qtext, q.qvec, 12, 1.0, 1.0, 60, '__t033_small__', null, 1, 'standard'
         ) as h;
  raise notice '[033-test §9] match_count=12 with p_branch_limit=1 returned % row(s) (expect 12)', v_n;
  if v_n <> 12 then
    raise exception '[033-test §9] p_branch_limit was not clamped up to match_count: got % rows instead of 12', v_n;
  end if;
end $$;

-- ════════════════════════════════════════════════════════════════════════════
-- 10. Cleanup — remove every fixture row and helper this pair created. Scoped
--     to the two sentinel projects and the __t033_ prefix; touches nothing else
--     even if it were somehow run against a populated database (which the
--     current_database() guard already prevents).
-- ════════════════════════════════════════════════════════════════════════════

delete from public.memory_items where project in ('__t033_small__', '__t033_bulk__');

drop table    if exists public.__t033_new;
drop table    if exists public.__t033_std;
drop table    if exists public.__t033_solved;
drop table    if exists public.__t033_baseline;
drop table    if exists public.__t033_query;
drop function if exists public.__t033_plan(text);
drop function if exists public.__t033_tol(timestamptz, timestamptz);
drop function if exists public.__t033_mk_vec(double precision);

analyze public.memory_items;

\echo '[033-test] 033b complete: equivalence, semantic_similarity, decay profiles, NULL-embedding degradation, index usage, hygiene gates and branch-limit clamp all verified.'

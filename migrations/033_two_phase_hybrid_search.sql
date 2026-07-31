-- migrations/033_two_phase_hybrid_search.sql
-- Sprint 82 T1 (Calibration & Solved-Problem Recall) — the two-phase top-k
-- rewrite of memory_hybrid_search, the cardinal `semantic_similarity` output
-- column, and the `solved-problem` decay profile.
--
-- WHY (three defects, one migration):
--
--  D1. FULL-SCAN ON BOTH BRANCHES. 032's `candidates` CTE (:182-205) computes
--      ts_rank_cd AND the cosine distance for EVERY active row before any
--      ranking happens. There is no `@@` prefilter and no
--      `order by embedding <=> $q limit k` inner query, so neither index can be
--      matched by the planner. At ~9.3k rows this is already implicated in the
--      2026-07-28 live recall statement timeouts — and the failure mode was
--      diagnosed once before and routed AROUND rather than fixed, see
--      024_email_assistant_recall.sql:47-49:
--        "do NOT use memory_hybrid_search here — it recomputes to_tsvector over
--         the whole corpus at query time and times out (57014)".
--      033 fixes it at the source: each branch takes its own indexed top-k
--      FIRST, and RRF fusion + the multiplier stack run only on the union.
--
--  D2. NO FTS INDEX EXISTS TO USE. The pre-033 story was "the GIN index goes
--      unused". Sharper: there is no FTS GIN index at all. 001:39-40 creates
--      `gin (content gin_trgm_ops)` — a pg_trgm index, which serves LIKE / %
--      / similarity() and CANNOT serve `to_tsvector(...) @@ plainto_tsquery(...)`
--      (different opclass, different operator, and it indexes the raw column,
--      not its tsvector). No migration 001→032 ever created one. Restructuring
--      the query alone would leave the FTS branch a seq scan forever, so §1
--      below creates the expression index the rewrite depends on.
--      The vector side is subtler. 001:46-48 DOES create an HNSW index, and 032
--      cannot use it at all (no ORDER BY … LIMIT for the access method to
--      satisfy). §2's rewrite makes it reachable — but reachable is not the same
--      as chosen. 005 also created memory_items_source_type_idx_v2, partial on
--      exactly `is_active and not archived`, so the planner can always answer
--      the live-row predicate with a bitmap scan and then sort by distance; on a
--      small corpus it prefers exactly that, because Postgres prices `<=>` as a
--      single operator call rather than 1536 multiply-adds. §1b adds a partial
--      HNSW index matching the live-row predicate so the good plan is available
--      AND cheap. Plan CHOICE remains cost-based — no migration can promise it.
--
--  D3. THE COSINE IS COMPUTED AND THROWN AWAY. 032:196 computes
--      `1 - (embedding <=> query_embedding)` and discards it, returning only
--      the ordinal RRF composite. That composite has a hard arithmetic ceiling
--      of 2/61 × 1.5 × 1.5 ≈ 0.074 (live telemetry over ~38.8k memory_recall_log
--      rows: p50 0.0216, max 0.074 — theory and production agree exactly), so it
--      is ORDINAL, not cardinal: no weight tuning can calibrate it, and rendering
--      it as a "similarity %" shows 2% for an excellent hit. 033 returns the raw
--      cosine as `semantic_similarity` — the one absolute, cross-query-comparable
--      signal the function already had in hand. Sprint 82 T2 renders it; T3
--      calibrates on top of it.
--
-- WHAT:
--   1. index public.memory_items_content_fts_gin — gin(to_tsvector('english',
--      content)). The prerequisite D2 identifies.
--   1b. index public.memory_items_embedding_hnsw_live_idx — partial HNSW over
--      the live-row predicate, so the filtered vector branch can run as a pure
--      ordered index scan instead of losing to a bitmap scan + distance sort.
--   2. public.memory_hybrid_search — DROP + CREATE (RETURNS TABLE changes, so
--      CREATE OR REPLACE alone raises "cannot change return type"). Two-phase
--      body; +2 defaulted params; +1 output column. Every 032 multiplier
--      preserved arithmetically identically for default args.
--   3. public.memory_hybrid_search_explain — the 004 sibling, kept in lockstep
--      at 10 args. MUST be dropped+recreated too: adding defaulted params to a
--      function creates a NEW OVERLOAD rather than replacing, and an 8-arg call
--      against a coexisting 8-arg and 10-arg pair is an ambiguous-overload
--      error (this is the exact trap 002:20-37 and 029:75-77 document).
--   4. REVOKE/GRANT re-pin on BOTH functions — REQUIRED, not belt-and-suspenders:
--      a DROP loses grants, and a freshly created function gets Postgres's
--      DEFAULT of EXECUTE-to-PUBLIC. 019:107-124 revoked `memory_hybrid_search_
--      explain` historically via its `proname like 'memory_%'` loop; without the
--      re-pin below, 033 would silently REOPEN that hole on a function whose
--      whole job is running EXPLAIN (ANALYZE) — which executes the query.
--   5. A hard-failing OID-form apply receipt covering both functions, all three
--      indexes, and the new output column.
--
-- BEHAVIOR CONTRACT (frozen and published to T2/T3 as Sprint 82 interface I1):
--   memory_hybrid_search(query_text, query_embedding, match_count=20,
--     full_text_weight=1.0, semantic_weight=1.0, rrf_k=60, filter_project=null,
--     filter_source_type=null, p_branch_limit=60, p_decay_profile='standard')
--   returns (id, content, source_type, category, project, metadata, score,
--     created_at, privacy_tags, semantic_similarity)
--   All three callers (src/recall.ts:141, src/search.ts:27, src/layered.ts:104)
--   pass NAMED RPC args, so both new params are additive-safe with zero
--   call-site edits — verified, not assumed.
--
-- FOUR DELIBERATE, DOCUMENTED SEMANTIC CHANGES (T4: these are the audit
-- surface; everything else is arithmetically identical to 032):
--
--   S1. EXACT → APPROXIMATE semantic ranking. 032 ranked the whole corpus by
--       exact cosine. 033's vector branch is an HNSW (ANN) top-k. That IS the
--       performance fix — an index scan is by construction approximate — but it
--       means the k-th semantic candidate may differ from 032's. Mitigated by
--       pinning hnsw.ef_search (see §2) well above the branch limit. On a corpus
--       smaller than the branch limit the planner does not use the index at all
--       and results are exactly identical, which is what the equivalence test
--       asserts — approximation is a large-corpus behaviour by construction.
--
--   S2. RANKS ARE NOW ASSIGNED WITHIN THE TOP-K, NOT THE WHOLE CORPUS. For any
--       row inside a branch's top-k the row_number is IDENTICAL to 032's (same
--       ORDER BY over a prefix of the same sequence). Rows beyond k lose that
--       branch's RRF contribution — worth < 1/(60+k) ≈ 0.008 at the default and
--       incapable of reaching a top-20 slot. Rows in NEITHER branch are no longer
--       returned at all; 032 returned them on a base_score of exactly 0.0 to pad
--       out match_count. Padding a recall result with provably-irrelevant rows is
--       not a feature, and the fused set is ≥ match_count on any real corpus.
--
--   S3. NULL query_embedding NO LONGER FABRICATES A SEMANTIC RANKING. In 032,
--       `1 - (embedding <=> NULL)` is NULL for every row, `row_number() over
--       (order by sem_rank desc nulls last)` still hands out ranks 1..n in
--       arbitrary order, and every row collects a semantic RRF term from pure
--       noise. 033 gates the vector branch off when query_embedding is NULL, so
--       an embedding-less call degrades honestly to FTS-only (and reports
--       semantic_similarity = NULL, per contract I1).
--
--   S4. TIE-BREAKS AND FINAL ORDER ARE NOW DETERMINISTIC. 032's window ORDER BYs
--       and its final `order by score desc` carried no tiebreak, so tied rows —
--       common in ts_rank_cd — came back in whatever order the executor chose,
--       and a top-k boundary would shuffle between identical calls. 033 breaks
--       ties on `id` in both row_number() windows and in the final ORDER BY.
--       Same rows, stable order; a reproducible search API is a precondition
--       for anyone else reproducing a result. The ONE place the tiebreak is
--       deliberately withheld is the vector branch's inner ORDER BY, where it
--       would cost the HNSW index scan — see the comment at that line.
--
-- Five RLS hygiene gates (global CLAUDE.md), verified by the hard-failing
-- receipt in §5:
--   GATE 1  No NEW table (two indexes + two functions). memory_items already has
--           RLS enabled (028 §6b); the receipt re-checks as a regression guard.
--   GATE 2  No new policies; no WITH CHECK (true) anywhere.
--   GATE 3  REVOKE EXECUTE FROM public, anon, authenticated + GRANT service_role
--           on BOTH functions — matching 032's grant set exactly.
--   GATE 4  SET search_path = public, extensions, pg_catalog on both (the
--           vector(1536) param needs `extensions`; matches 029/032).
--   GATE 5  No raw anon-key path: 033 adds no write surface at all — both
--           functions are read-only, and neither is SECURITY DEFINER.
--
-- Idempotent / rerun-safe: CREATE INDEX IF NOT EXISTS; overload-drop guards
-- before each CREATE; REVOKE/GRANT naturally idempotent; the receipt only
-- SELECTs (and raises).
--
-- APPLY: write + test locally only. ORCH applies at sprint close. 033 runs
-- AFTER 032 (the current memory_hybrid_search owner).

-- ====================================================================
-- 1. The FTS GIN index the two-phase rewrite depends on (defect D2).
--
--    to_tsvector(regconfig, text) — the TWO-ARG form with a literal config —
--    is IMMUTABLE, so it is legal in an expression index. The one-arg
--    to_tsvector(text) is only STABLE (it reads default_text_search_config)
--    and would be rejected here; the function body below is careful to use
--    the same two-arg 'english' form so the predicate matches this index
--    expression exactly. A mismatch means a silent seq scan.
--
--    NOT partial. 001's project/source_type indexes are partial on
--    `is_active and not archived`, and mirroring that would shrink this index
--    slightly — but a partial index only helps when the planner can prove the
--    query implies the predicate, and a plain expression index is usable by
--    every present and future FTS caller with no proof obligation. At ~9.3k
--    rows the size difference is noise; planner robustness is not.
--
--    NOT CONCURRENTLY: every prior Mnestra migration uses plain CREATE INDEX,
--    CONCURRENTLY is illegal inside the bundled runner's transaction, and at
--    this row count the ACCESS EXCLUSIVE window is milliseconds.
-- ====================================================================

create index if not exists memory_items_content_fts_gin
  on public.memory_items using gin (to_tsvector('english', content));

-- ────────────────────────────────────────────────────────────────────────────
-- 1b. Partial HNSW index matching the vector branch's always-applied predicates.
--
--     001's HNSW index is unqualified, so a filtered `ORDER BY embedding <=> $q
--     LIMIT k` can only use it as an index scan WITH a residual filter — the
--     planner must over-scan and discard non-live rows, and it prices that
--     accordingly. Meanwhile 005 created `memory_items_source_type_idx_v2`,
--     partial on exactly `is_active = true and archived = false`, which fully
--     answers the live-row predicate. So the planner has a standing alternative:
--     bitmap-scan that index, then sort by distance. On a small corpus it takes
--     it — sorting a few thousand rows looks cheap, and Postgres's cost model
--     materially UNDERSTATES `<=>` (it prices an operator call, not 1536
--     floating-point multiply-adds). That is the classic pgvector
--     filtered-ORDER-BY trap, and it is what a clean-DB reproduction hits.
--
--     This index closes it for the common case: its predicate is exactly the
--     three live-row conditions every vector query in this codebase applies
--     (memory_hybrid_search here, match_memories in 001, email_assistant_recall
--     in 024), so a query carrying them can use it as a PURE ordered index scan
--     with no recheck and no over-scan. That is pgvector's own documented
--     recommendation for filtered vector search.
--
--     It does NOT make the planner's choice unconditional — plan choice remains
--     cost-based and therefore scale- and selectivity-dependent, and no
--     migration can promise otherwise. What it does is make the good plan
--     genuinely available and genuinely cheap. See the § 7 header of
--     tests/sql/033b_verify.sql for what is asserted versus merely observed.
--
--     ⚠ APPLY COST: this builds a second HNSW graph over every live row. On the
--     ~9.3k-row daily driver expect seconds-to-a-minute holding ACCESS
--     EXCLUSIVE, NOT the millisecond window the GIN index above takes. Budget
--     for it. (Follow-up worth measuring, deliberately NOT taken here: 001's
--     unqualified HNSW index may now be redundant, since every vector query in
--     the codebase applies the live-row predicate. Dropping an index on the hot
--     table is a decision that deserves its own measurement, not a side effect
--     of this migration.)
-- ────────────────────────────────────────────────────────────────────────────

create index if not exists memory_items_embedding_hnsw_live_idx
  on public.memory_items using hnsw (embedding vector_cosine_ops)
  where is_active = true and archived = false and superseded_by is null;

comment on index public.memory_items_embedding_hnsw_live_idx is
  'Sprint 82 (migration 033): partial HNSW index whose predicate is exactly the '
  'live-row conditions every vector query applies (is_active, not archived, not '
  'superseded). Lets a filtered ORDER BY embedding <=> $q LIMIT k run as a pure '
  'ordered index scan with no recheck, instead of losing to a bitmap scan on '
  'memory_items_source_type_idx_v2 (005) followed by a distance sort. Keep the '
  'query predicates a superset of this WHERE clause or the planner stops '
  'matching it.';

comment on index public.memory_items_content_fts_gin is
  'Sprint 82 (migration 033): GIN index on to_tsvector(''english'', content) — '
  'the FTS half of memory_hybrid_search''s two-phase top-k. Before 033 the only '
  'GIN index on this table was gin(content gin_trgm_ops) (001), a pg_trgm index '
  'that cannot serve the @@ operator, so the full-text branch seq-scanned the '
  'corpus on every recall. Keep the function''s predicate spelled exactly '
  'to_tsvector(''english'', m.content) or the planner silently stops matching.';

-- ====================================================================
-- 2. memory_hybrid_search — two-phase top-k.
--
--    Shape, and why each piece is shaped that way:
--
--      ft_branch  — inner subquery carries the `@@` predicate (GIN-servable)
--                   plus `order by ft_rank desc limit k`; the OUTER query
--                   assigns row_number(). The limit MUST be inside, or the
--                   window function forces a sort of every matching row before
--                   the limit can apply.
--      vec_branch — inner subquery is a bare `order by embedding <=> $q limit k`
--                   over the filter set: the exact shape pgvector's HNSW AM
--                   matches. Same outer-row_number trick.
--      fused_ids  — UNION of the two id sets. This is the ONLY set that reaches
--                   the multiplier stack; it is at most 2×k rows (≤120 at
--                   defaults) versus 032's whole-corpus scoring.
--      enriched   — re-joins memory_items by PK to fetch the payload and to
--                   RECOMPUTE the cosine for rows that arrived FTS-only, so
--                   every returned row carries semantic_similarity (contract
--                   I1). ≤2k PK lookups — cheap.
--
--    Both branch CTEs are MATERIALIZED. Since PG12 a once-referenced CTE is
--    inlined by default, and inlining a LIMIT subquery into the join is exactly
--    the transformation that would undo the two-phase property. `materialized`
--    is the explicit fence; at ≤k rows each the materialization cost is nil.
--
--    hnsw.ef_search is pinned at 120. pgvector's default is 40 — BELOW the
--    default branch limit of 60 — so an unpinned HNSW scan would silently
--    return a worse top-60 than the index is capable of. The GUC is a qualified
--    (dotted) name, so Postgres accepts it as a placeholder even in a session
--    where pgvector has not yet been loaded; it does not make this migration
--    depend on load order. 120 = 2× the default branch limit, the usual
--    recall/latency compromise.
--
--    Stays `language sql stable`, matching 029/032 — the decay profile is a
--    CASE over a parameter, not control flow, so nothing here needs plpgsql.
-- ====================================================================

-- Overload-drop guard (mirrors 002/023/029/032). REQUIRED here for two
-- independent reasons: RETURNS TABLE gains a column (CREATE OR REPLACE would
-- raise "cannot change return type of existing function"), AND the two new
-- defaulted params would otherwise create a second overload that makes every
-- existing 8-arg call ambiguous.
do $$
declare
  r record;
begin
  for r in
    select p.oid::regprocedure as sig
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where p.proname = 'memory_hybrid_search'
       and n.nspname = 'public'
  loop
    execute 'drop function ' || r.sig::text;
  end loop;
end $$;

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
set search_path = public, extensions, pg_catalog
set hnsw.ef_search = '120'
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
          case e.source_type
            when 'decision'        then 365.0
            when 'architecture'    then 365.0
            when 'preference'      then 365.0
            when 'doctrine'        then 365.0
            when 'fact'            then  90.0
            when 'convention'      then  90.0
            when 'bug_fix'         then
              case when coalesce(p_decay_profile, 'standard') = 'solved-problem'
                   then 365.0 else 30.0 end
            when 'debugging'       then
              case when coalesce(p_decay_profile, 'standard') = 'solved-problem'
                   then 365.0 else 30.0 end
            when 'session_summary' then  14.0
            when 'document_chunk'  then  14.0
            when 'code_context'    then  14.0
            else                         30.0
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
  'Sprint 82 (migration 033): two-phase top-k hybrid recall. Each branch takes '
  'its own INDEX-SERVED top-k first (GIN on to_tsvector for full-text, HNSW for '
  'vector), then RRF fusion and the decay/type/project/recall_boost multiplier '
  'stack run only on the union — replacing 032''s whole-corpus scan, the '
  'suspected cause of the 2026-07-28 recall statement timeouts. Returns the raw '
  'cosine as semantic_similarity: `score` is an ORDINAL RRF composite with a '
  'hard ceiling near 0.074 and must never be rendered as a similarity '
  'percentage; semantic_similarity is the cardinal, cross-query-comparable '
  'signal. p_decay_profile = ''solved-problem'' flattens bug_fix/debugging decay '
  'from 30d to 365d so old solved problems stay recallable. Read-only, SECURITY '
  'INVOKER, pinned search_path; EXECUTE: service_role only.';

-- ====================================================================
-- 3. memory_hybrid_search_explain — the 004 sibling, kept in lockstep.
--
--    MUST be dropped first for the same overload reason as §2: adding two
--    defaulted params ADDS an overload rather than replacing, and then an
--    8-arg call matches both candidates → "function ... is not unique".
--    `mnestra diagnose` calls this; leaving it at 8 args while the inner
--    function is 10 would also make the EXPLAIN output describe a call shape
--    nobody actually issues.
-- ====================================================================

do $$
declare
  r record;
begin
  for r in
    select p.oid::regprocedure as sig
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where p.proname = 'memory_hybrid_search_explain'
       and n.nspname = 'public'
  loop
    execute 'drop function ' || r.sig::text;
  end loop;
end $$;

create or replace function public.memory_hybrid_search_explain (
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
returns setof text
language plpgsql
-- Volatility deliberately left at the default VOLATILE, exactly as 004 had it.
-- EXPLAIN ANALYZE genuinely executes the plan; marking the wrapper STABLE would
-- be a claim about a body we only ever run for its side-channel (the plan text).
set search_path = public, extensions, pg_catalog
as $$
begin
  return query execute
    'explain (analyze, buffers, format text) '
    || 'select * from public.memory_hybrid_search('
    || '$1, $2, $3, $4, $5, $6, $7, $8, $9, $10)'
  using
    query_text,
    query_embedding,
    match_count,
    full_text_weight,
    semantic_weight,
    rrf_k,
    filter_project,
    filter_source_type,
    p_branch_limit,
    p_decay_profile;
end;
$$;

comment on function public.memory_hybrid_search_explain(text, vector, int, float, float, int, text, text, int, text) is
  'Sprint 82 (migration 033): EXPLAIN (ANALYZE, BUFFERS) wrapper over '
  'memory_hybrid_search, kept at the same 10-arg shape. Used by `mnestra '
  'diagnose` and to evidence that both the GIN and HNSW indexes are being '
  'used. ANALYZE genuinely EXECUTES the query, so this stays service-role-only '
  'and SECURITY INVOKER. Read-only, pinned search_path.';

-- ====================================================================
-- 4. Re-pin RLS/EXECUTE hygiene on BOTH functions [GATE 3].
--
--    REQUIRED, not defensive. A DROP discards grants and a newly created
--    function gets Postgres's default of EXECUTE to PUBLIC. 019:107-124
--    revoked memory_hybrid_search_explain historically (its loop matches
--    `proname like 'memory_%'`); without this block, 033 would silently hand
--    PUBLIC back EXECUTE on an EXPLAIN-ANALYZE wrapper — i.e. on something that
--    runs the underlying query for real.
--
--    Signature resolved from pg_proc rather than reconstructed as text: per
--    019, pg_get_function_identity_arguments returns arg NAMES on Supabase's
--    Postgres, and the vector type's schema location varies by install.
-- ====================================================================

do $$
declare
  fn   text;
  sig  text;
begin
  foreach fn in array array['memory_hybrid_search', 'memory_hybrid_search_explain']
  loop
    select format('public.%I(%s)', p.proname, pg_get_function_identity_arguments(p.oid))
      into sig
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname = fn
     limit 1;

    if sig is not null then
      execute format('revoke execute on function %s from public, anon, authenticated', sig);
      execute format('grant  execute on function %s to service_role', sig);
    end if;
  end loop;
end $$;

-- ====================================================================
-- 5. Apply-time receipt — HARD-FAILING, OID form (resolve each function OID by
--    proname; never a reconstructed text signature — see §4).
-- ====================================================================

do $$
declare
  v_oid     oid;
  v_anon    boolean;
  v_auth    boolean;
  v_pub     boolean;
  v_svc     boolean;
  v_cfg     text;
  v_result  text;
  v_nargs   int;
  v_rls     boolean;
  v_has_gin boolean;
  v_has_hnsw boolean;
  v_has_hnsw_live boolean;
  fn        text;
begin
  -- [GATE 1] memory_items RLS still enabled (regression guard; 028 §6b owns it).
  select c.relrowsecurity into v_rls
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname = 'memory_items';
  raise notice '[033] memory_items RLS enabled:% (expect t)', v_rls;
  if v_rls is distinct from true then
    raise exception '[033] GATE 1 VIOLATION: RLS not enabled on public.memory_items';
  end if;

  -- The two indexes the rewrite depends on. The GIN one is NEW in 033; the
  -- HNSW one is from 001 and is checked as a regression guard, because a
  -- missing HNSW index turns the vector branch back into a full scan silently.
  select exists (select 1 from pg_indexes
                  where schemaname = 'public' and tablename = 'memory_items'
                    and indexname = 'memory_items_content_fts_gin') into v_has_gin;
  select exists (select 1 from pg_indexes
                  where schemaname = 'public' and tablename = 'memory_items'
                    and indexname = 'memory_items_embedding_hnsw_idx') into v_has_hnsw;
  select exists (select 1 from pg_indexes
                  where schemaname = 'public' and tablename = 'memory_items'
                    and indexname = 'memory_items_embedding_hnsw_live_idx') into v_has_hnsw_live;
  raise notice '[033] indexes — content_fts_gin:% embedding_hnsw_idx:% embedding_hnsw_live_idx:% (expect t t t)',
    v_has_gin, v_has_hnsw, v_has_hnsw_live;
  if not v_has_gin then
    raise exception '[033] INDEX MISSING: memory_items_content_fts_gin — the FTS branch would seq-scan';
  end if;
  if not v_has_hnsw then
    raise exception '[033] INDEX MISSING: memory_items_embedding_hnsw_idx (from migration 001) — the vector branch would seq-scan';
  end if;
  if not v_has_hnsw_live then
    raise exception '[033] INDEX MISSING: memory_items_embedding_hnsw_live_idx — the filtered vector branch loses to a bitmap scan + distance sort without it';
  end if;

  -- memory_hybrid_search: shape + five-gate.
  select p.oid, p.pronargs into v_oid, v_nargs
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'memory_hybrid_search';
  if v_oid is null then
    raise exception '[033] memory_hybrid_search not found after DROP+CREATE';
  end if;
  if v_nargs <> 10 then
    raise exception '[033] memory_hybrid_search must take 10 args (found %) — overload drop failed or signature drifted', v_nargs;
  end if;

  -- The new output column — defect D3's whole point.
  select pg_get_function_result(v_oid) into v_result;
  raise notice '[033] memory_hybrid_search RETURNS: %', v_result;
  if v_result not like '%semantic_similarity%' then
    raise exception '[033] RETURNS TABLE missing semantic_similarity (found: %)', v_result;
  end if;
  if v_result not like '%privacy_tags%' then
    raise exception '[033] RETURNS TABLE regressed — privacy_tags (migration 023) is gone (found: %)', v_result;
  end if;

  -- memory_hybrid_search_explain must have been kept in lockstep, or a stale
  -- 8-arg overload is still sitting there waiting to raise "is not unique".
  select count(*) into v_nargs
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'memory_hybrid_search_explain';
  if v_nargs <> 1 then
    raise exception '[033] expected exactly 1 memory_hybrid_search_explain overload, found % — ambiguous-overload hazard', v_nargs;
  end if;
  select count(*) into v_nargs
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'memory_hybrid_search';
  if v_nargs <> 1 then
    raise exception '[033] expected exactly 1 memory_hybrid_search overload, found % — ambiguous-overload hazard', v_nargs;
  end if;

  -- [GATE 3] + [GATE 4] on both functions.
  foreach fn in array array['memory_hybrid_search', 'memory_hybrid_search_explain']
  loop
    select p.oid into v_oid
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = fn limit 1;
    if v_oid is null then
      raise exception '[033] % not found', fn;
    end if;
    v_anon := has_function_privilege('anon',          v_oid, 'EXECUTE');
    v_auth := has_function_privilege('authenticated', v_oid, 'EXECUTE');
    v_pub  := has_function_privilege('public',        v_oid, 'EXECUTE');
    v_svc  := has_function_privilege('service_role',  v_oid, 'EXECUTE');
    select array_to_string(p.proconfig, '; ') into v_cfg from pg_proc p where p.oid = v_oid;
    raise notice '[033] % EXECUTE — anon:%, auth:%, public:% (expect f f f); service_role:% (expect t); proconfig:%',
      fn, v_anon, v_auth, v_pub, v_svc, coalesce(v_cfg, '<none>');
    if v_anon or v_auth or v_pub then
      raise exception '[033] GATE 3 VIOLATION: % executable by anon/authenticated/public (%, %, %)', fn, v_anon, v_auth, v_pub;
    end if;
    if not v_svc then
      raise exception '[033] GATE 3 VIOLATION: service_role lost EXECUTE on % (re-pin failed after overload drop)', fn;
    end if;
    if v_cfg is null or v_cfg not like '%search_path=public, extensions, pg_catalog%' then
      raise exception '[033] GATE 4 VIOLATION: % search_path not pinned (proconfig: %)', fn, coalesce(v_cfg, '<none>');
    end if;
  end loop;

  -- [GATE 5] Neither function may be SECURITY DEFINER — both are read-only and
  -- there is no reason for either to escalate.
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in ('memory_hybrid_search', 'memory_hybrid_search_explain')
       and p.prosecdef
  ) then
    raise exception '[033] GATE 5 VIOLATION: a 033 function is SECURITY DEFINER; both must stay INVOKER';
  end if;

  raise notice '[033] receipt: FTS GIN + HNSW indexes present, memory_hybrid_search 10-arg with semantic_similarity, explain sibling in lockstep, both five-gate clean.';
end$$;

-- ====================================================================
-- 6a. Post-apply verification (ORCH, Studio SQL editor — commented).
--
--   -- (i) DOES THE VECTOR BRANCH ACTUALLY GET AN HNSW PLAN AT REAL SCALE?
--   --     This is the one acceptance question the test suite CANNOT answer, and
--   --     it decides whether the vector half of the performance fix lands.
--   --
--   --     Do NOT use memory_hybrid_search_explain for this. EXPLAIN over a
--   --     non-inlinable function prints one "Function Scan" line and nothing
--   --     about the plan inside the body — and this function is non-inlinable by
--   --     construction, because GATE 4 pins its search_path. The wrapper reports
--   --     timing and buffers; it cannot report index usage. Explain the branch
--   --     shape directly instead:
--   --
--   --   explain (analyze, buffers)
--   --   select m.id, (m.embedding <=> (select embedding from public.memory_items
--   --                                  where embedding is not null limit 1)) as dist
--   --     from public.memory_items m
--   --    where m.is_active = true and m.archived = false
--   --      and m.superseded_by is null and m.embedding is not null
--   --    order by m.embedding <=> (select embedding from public.memory_items
--   --                              where embedding is not null limit 1)
--   --    limit 60;
--   --
--   --     WANT: "Index Scan using memory_items_embedding_hnsw_live_idx".
--   --     If instead you see a Bitmap Index Scan on memory_items_source_type_idx_v2
--   --     or a Seq Scan followed by a Sort, the planner is still choosing to sort
--   --     — the corpus is small enough that it is cheaper, or the statistics say
--   --     so. That is not a correctness problem (results are identical either
--   --     way) but the vector branch is then NOT getting its speedup. Options, in
--   --     order of preference: (1) leave it — the full-text branch is the
--   --     documented timeout cause (024:47-49) and is fixed unconditionally;
--   --     (2) on pgvector 0.8+, SET hnsw.iterative_scan = 'relaxed_order', which
--   --     is designed for exactly this filtered-ORDER-BY case; (3) restructure
--   --     the branch to scan bare and filter outside with an over-fetch factor —
--   --     REJECTED for this migration because under a selective filter_project an
--   --     over-fetch can return zero surviving rows, trading a performance
--   --     problem for silent recall loss, which is the worse failure for a
--   --     memory store.
--   --
--   -- (i-b) The full-text branch, which should be unambiguous:
--   --   explain (analyze, buffers)
--   --   select m.id, ts_rank_cd(to_tsvector('english', m.content),
--   --                           plainto_tsquery('english', 'supabase rls hygiene'))
--   --     from public.memory_items m
--   --    where m.is_active = true and m.archived = false
--   --      and m.superseded_by is null and m.embedding is not null
--   --      and to_tsvector('english', m.content)
--   --          @@ plainto_tsquery('english', 'supabase rls hygiene')
--   --    order by 2 desc nulls last, m.id
--   --    limit 60;
--   --     WANT: "Bitmap Index Scan on memory_items_content_fts_gin".
--
--   -- (ii) The cardinal signal is present and sane (expect 0..1, descending-ish
--   --     but NOT monotonic in score — that is the whole point of D3).
--   select left(content, 60) as snippet, source_type,
--          round(score::numeric, 5) as rrf_score,
--          round(semantic_similarity::numeric, 4) as cosine
--     from public.memory_hybrid_search(
--       'supabase rls hygiene',
--       (select embedding from public.memory_items where embedding is not null limit 1),
--       10);
--
--   -- (iii) solved-problem profile lifts old bug_fix/debugging rows. Run the
--   --     same query under both profiles and diff the ordering:
--   select p.profile, x.source_type, left(x.content, 50) as snippet,
--          round(x.score::numeric, 6) as score
--     from (values ('standard'), ('solved-problem')) as p(profile),
--          lateral public.memory_hybrid_search(
--            'flashback timeout bug',
--            (select embedding from public.memory_items where embedding is not null limit 1),
--            10, 1.0, 1.0, 60, null, null, 60, p.profile) as x
--    order by p.profile, x.score desc;
--
--   -- (iv) Unknown profile must degrade to 'standard', never raise:
--   select count(*) from public.memory_hybrid_search(
--     'smoke', array_fill(0::real, ARRAY[1536])::vector, 5,
--     1.0, 1.0, 60, null, null, 60, 'not-a-real-profile');   -- expect no error
--
--   -- (v) Privileges: both functions service_role-only.
--   select p.proname,
--          has_function_privilege('service_role', p.oid, 'EXECUTE') as svc,   -- t
--          has_function_privilege('anon',         p.oid, 'EXECUTE') as anon,  -- f
--          has_function_privilege('public',       p.oid, 'EXECUTE') as pub    -- f
--     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--    where n.nspname = 'public'
--      and p.proname in ('memory_hybrid_search', 'memory_hybrid_search_explain');
--
--   -- (vi) Supabase advisors: ZERO new 0011/0013 lints attributable to 033:
--   --   mcp__supabase__get_advisors(type='security')
--
-- 6b. Reversal (commented — apply by hand):
--   drop index if exists public.memory_items_content_fts_gin;
--   drop index if exists public.memory_items_embedding_hnsw_live_idx;
--   drop function if exists public.memory_hybrid_search(text, vector, int, float, float, int, text, text, int, text);
--   drop function if exists public.memory_hybrid_search_explain(text, vector, int, float, float, int, text, text, int, text);
--   -- then re-apply 032 in full (it recreates memory_hybrid_search at 8 args)
--   -- and 004's memory_hybrid_search_explain block (lines 147-176) to restore
--   -- the 8-arg sibling. Re-run 019's revoke loop, or hand-revoke, afterwards.
-- ====================================================================

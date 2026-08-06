-- migrations/037_graph_walk_expansion.sql
-- Sprint 70 A-T1 (Graph-Boosted Recall, Deck A) — wire the migration-034 graph
-- substrate into the recall walk, and give the walk a way to be entered by
-- KEYWORD rather than by embedding alone.
--
-- Migration number 037 is pre-assigned to Deck A by the cross-deck seam contract
-- (sprint-70 PLANNING §Seam item 2). Deck B owns 038. Never renumber.
--
-- WHY. The live diagnosis, one call, 2026-08-02:
--
--     memory_recall_graph(project=termdeck, query="vault readability navigation
--     layer", k=6, depth=2)  ->  d0=6
--
-- Six hits, all six vector seeds, ZERO graph neighbors. A-T4 reproduced it
-- independently at 2026-08-05 19:38 ET against the daily driver and located the
-- cause precisely: the walk's only edge source is
-- migrations/010_memory_recall_graph.sql:87, a join onto memory_relationships —
-- and those six seeds have 0 live memory_relationships edges between them. What
-- they DO have, by read-only count on the same store, is 27 entity mentions and
-- 41 shared-entity neighbor memories.
--
-- So the substrate is not missing and the primitive is not broken. Migration 034
-- shipped memory_entities / memory_entity_mentions (1,643 entities, 2,406
-- mentions live) and consolidation community summaries (51 live), and the recall
-- walk reads NONE of it. This migration is the wiring, and nothing else.
--
-- WHAT:
--   §1  memory_recall_graph_boosted — a NEW function (see §0 for why NEW and not
--       a replacement of 010). Three changes over 010's walk:
--
--       (a) EDGE SET. The recursive expansion now follows the union of three
--           arms instead of one:
--             arm 1  typed edges      — memory_relationships, LIVE only, keeping
--                                       its existing weight (coalesce(weight,0.5),
--                                       010's convention, unchanged by design).
--             arm 2  entity co-mention — two memories that mention the same
--                                       memory_entity. Weight p_entity_weight.
--             arm 3  community co-membership — two memories in the same
--                                       consolidation community, AND every member
--                                       to that community's summary row. Weight
--                                       p_community_weight.
--           Bidirectional throughout: arm 1 keeps 009/034's CASE-WHEN
--           source/target flip so an edge is reachable from either endpoint;
--           arms 2 and 3 are symmetric by construction.
--
--       (b) KEYWORD -> ENTITY TRIGGERING. Query terms are matched against
--           memory_entities (entity_key AND metadata->'aliases') BEFORE any
--           walking; every matched entity's mention set becomes a walk seed,
--           UNIONed with the vector seeds. This is the literal "a few key words
--           trigger the chain" mechanism — it is what lets recall enter the graph
--           at a named thing rather than only at whatever the embedding happened
--           to land near. Verified against the canonical query on the live store:
--           "vault readability navigation layer" matches 6 entities, including
--           the multi-word keys 'vault readability' and 'navigation layer'.
--
--       (c) TIER-0 EXCLUSION HOOK for the cross-deck seam (§Seam item 3):
--           objectives are INJECTED, not retrieved, so the walk must not surface
--           them. See §0.3 — this ships as a fenced placeholder that excludes
--           NOTHING, because Deck B-T1 had not posted its marker at freeze time.
--
-- WHAT THIS FILE DELIBERATELY DOES NOT DO:
--   * It does not touch migration 010's memory_recall_graph. Not replaced, not
--     dropped, not overloaded. See §0.1.
--   * It does not change any ranking formula. final_score stays
--     vector_score x edge_weight x recency_score, 010's exact shape, so the only
--     variable this sprint introduces is WHICH ROWS REACH the ranking — not how
--     they are ordered once there.
--   * It does not write. STABLE, so Postgres refuses INSERT/UPDATE/DELETE at
--     runtime; read-only is structural, not a promise (034 REQ-1f precedent).
--   * It does not create, infer, or persist edges. Arms 2 and 3 are derived at
--     traversal time from tables 034 already maintains. Nothing here needs a
--     backfill and nothing here can be stale.
--
-- ====================================================================
-- 0. Three decisions that are load-bearing, recorded before the DDL
-- ====================================================================
--
-- 0.1  A NEW FUNCTION NAME, NOT AN EXTENSION OF 010's SIGNATURE.
--      010's memory_recall_graph(vector, text, int, int) is called by name from
--      src/recall_graph.ts:78. Adding the eleven arguments below to it — even
--      all-defaulted — creates a SECOND OVERLOAD, and PostgREST then cannot
--      resolve the RPC and answers "could not find the function": the 15-sprint
--      404 outage documented at 034_graph_layer.sql:87-92 and
--      mnestra-bridge/index.js:96-110. Replacing 010 in place at its existing
--      4-arg signature would avoid the overload but forfeit every tunable the
--      lane brief asks for, AND would break the sprint's own acceptance criterion
--      that the MNESTRA_GRAPH_RECALL-off path stay byte-identical to current
--      behavior. A distinct name is the only shape that satisfies both. 010 is
--      left untouched, so "off" is byte-identical for free.
--
--      Exactly ONE signature is created here. Do not add an overload later;
--      widen by adding a defaulted argument to THIS function only if no caller
--      has bound it yet, and prefer a new name if one has.
--
-- 0.2  ARGUMENT NAMES ARE THE CONTRACT. PostgREST binds RPC arguments BY NAME
--      from the JSON key set, so renaming one is a breaking change even when the
--      types are unchanged (034:1360-1363). The first five names are 010's
--      VERBATIM — query_embedding, project_filter, max_depth, k, plus the new
--      query_text — so A-T2's existing supabase.rpc() argument object at
--      src/recall_graph.ts:78-83 stays valid and only gains keys. The remaining
--      arguments carry the 034 house p_ prefix. The mixed convention is
--      deliberate and is the lesser evil: call-site parity on the inherited names
--      is worth more than cosmetic uniformity.
--
-- 0.3  THE TIER-0 EXCLUSION IS STRUCTURAL; THE PREDICATE HERE IS BELT.
--      Seam item 3 requires this walk to exclude tier-0/objective rows. Deck
--      B-T1 published the marker as SCHEMA-READY at 2026-08-05 20:00 ET
--      (docs/sprint-71-objective-tier/STATUS.md:174, migration 038:47-59), and
--      the answer removes the problem rather than parameterizing it:
--
--        Tier-0 objectives live in their own table, public.memory_objectives.
--        They are NEVER written to memory_items. memory_relationships' endpoints
--        are memory_items ids, so an objective cannot be a graph endpoint at all.
--
--      This walk therefore CANNOT reach an objective, and needs no predicate for
--      correctness. Verified independently against the live store rather than
--      taken on the post: 0 rows in memory_items carry source_type='objective',
--      and public.memory_objectives does not exist there yet (038 unapplied).
--
--      p_exclude_tier0 is nevertheless WIRED, to B-T1's reserved sentinel
--      (source_type IS DISTINCT FROM 'objective'), for one reason: 038
--      deliberately adds no CHECK reserving that value on memory_items — 025's
--      fail-soft doctrine says a vocabulary CHECK on a column that is 94.9%
--      foreign values would cost a writer its capture to defend a value nothing
--      writes. So the reservation is a convention, and a convention that is free
--      to enforce HERE should be enforced here. The test costs nothing: it reads
--      a column already fetched on a row already joined.
--
--      Precedence to keep straight if this is ever revisited: the separate table
--      is the guarantee, this predicate is the belt. If they ever disagree, the
--      table is right and something upstream has gone wrong.
--
-- ====================================================================
-- Hygiene gates — global CLAUDE.md § "Supabase RLS + privilege hygiene",
-- marked [GATE n] inline, all verified by the HARD-FAILING receipt in §3
-- ====================================================================
--   GATE 1  No new tables, so no new RLS surface. (Nothing here creates a table.)
--   GATE 2  No policies created; no WITH CHECK (true) anywhere in this file.
--   GATE 3  REVOKE EXECUTE ... FROM public, anon, authenticated, then targeted
--           GRANT to service_role only. MANDATORY, not defensive: migration
--           014:45 sets `alter default privileges in schema public grant execute
--           on functions to service_role, authenticated, anon`, so this function
--           is anon-executable the instant it exists until revoked.
--
--           NOTE the deliberate divergence from 010, which granted
--           `to authenticated, service_role, anon` (010:146-147). This function
--           reaches STRICTLY MORE memories than 010 does — that is its entire
--           purpose — so inheriting 010's laxer grant would widen an anon-key
--           read surface at the same moment the reachable set grows. 034 §9
--           granted service_role only on every function it created, including
--           the traversal functions; that is the precedent followed here. The MCP
--           server holds the service role key, so nothing legitimate loses access.
--   GATE 4  SET search_path pinned in-statement. `public, extensions,
--           pg_catalog` — the `extensions` element is REQUIRED, not copied:
--           vector(1536) is in the extensions schema on Supabase and appears in
--           this signature and in the match_memories call.
--   GATE 5  No raw anon-key write path; this function cannot write at all
--           (STABLE) and is SECURITY INVOKER, so it adds no privilege surface.
--
-- Constraints: this migration adds none, so the ADD ... NOT VALID / VALIDATE
-- CONSTRAINT rule has nothing to bind to here.
--
-- Idempotent / rerun-safe: CREATE OR REPLACE FUNCTION; CREATE INDEX IF NOT
-- EXISTS; REVOKE/GRANT are naturally idempotent; the receipt only SELECTs (and
-- raises). Re-applying re-verifies the gates.
--
-- APPLY: authored and asserted locally only. Nobody applies this from a lane —
-- ORCH applies at sprint close, then runs the commented post-apply verification
-- in §4.

-- ====================================================================
-- 1. Supporting index
-- ====================================================================
--
-- The community arm reads community summaries by their consolidation kind. 034
-- §4 already created a partial UNIQUE index on
-- ((metadata->'consolidation'->>'community_key')) WHERE
-- metadata->'consolidation'->>'kind' = 'community_summary', whose predicate is
-- exactly this filter, so the 51 live summaries are reachable without a seq scan
-- of ~9,300 memory_items. Nothing further is needed for arm 3.
--
-- Arm 2 is served entirely by 034's existing indexes: the
-- memory_entity_mentions PK (memory_id, entity_id) answers node -> entities, and
-- memory_entity_mentions_entity_idx (entity_id) answers entity -> memories.
--
-- What is NOT already served is the keyword->entity trigger, which evaluates a
-- word-boundary regex against every candidate entity_key. That is a scan of
-- memory_entities by design — a regex is not index-servable by a btree — but the
-- scan is bounded by the hub cap, and mention_count is the only selective
-- predicate available before the regex runs. This index lets the planner discard
-- hub entities before evaluating regexes against them, which is the difference
-- between 1,643 regex evaluations and the ~1,500 that survive the cap today, and
-- a much larger difference as the entity table grows.
create index if not exists memory_entities_mention_count_idx
  on public.memory_entities (mention_count);

-- ====================================================================
-- 2. memory_recall_graph_boosted
-- ====================================================================
--
-- SCORING, stated plainly because it is the thing most likely to be
-- misread later:
--
--   final_score = vector_score x edge_weight x recency_score      (010's formula)
--
--   vector_score   the SEED's strength, propagated unchanged to everything the
--                  seed reaches. Neighbors are not re-embedded — 010's
--                  assumption, kept: "if A is relevant and B is connected to A,
--                  B inherits some of A's relevance, attenuated by path weight."
--                  A vector seed contributes its cosine similarity. An
--                  ENTITY-TRIGGERED seed has no similarity to contribute, so it
--                  enters at p_entity_weight — a keyword->entity trigger is
--                  worth exactly what an entity co-mention edge is worth, which
--                  keeps the tunable count down and the semantics explainable. A
--                  memory that is BOTH takes greatest() of the two: an exact
--                  keyword hit should never DEMOTE a row the vector already found.
--   edge_weight    1.0 at depth 0 (no path traversed); otherwise the mean
--                  per-hop weight along the path, exactly as 010 computes it —
--                  except 010 recomputed it by re-joining memory_relationships
--                  after the fact (010:85-90), which cannot express arms 2 and 3
--                  at all. Here each arm reports its own weight AS it is
--                  traversed and the walk carries a running sum. That also
--                  retires the weighting nuance 034:1606-1614 left open: a pair
--                  joined by both a live and an invalidated edge can no longer
--                  average across both, because only live edges are ever crossed.
--   recency_score  exp(-age / 30 days), 010's 30-day half-life, unchanged.
--
--   The default weight ladder is deliberately CONSERVATIVE and ordered
--   typed > entity > community: live typed weights on the store cluster at
--   0.85-0.93 (mean ~0.87, with 1,257 unclassified NULLs entering at 0.5), so
--   p_entity_weight 0.45 and p_community_weight 0.35 both sit below every real
--   typed edge and below the NULL floor. A new arm can therefore ADD reachability
--   without REORDERING anything the typed graph already ranked. Raise them only
--   with evidence.
--
-- BLAST-RADIUS CONTROL, three mechanisms, because a co-mention arm is a clique
-- generator and cliques are how a graph walk becomes a table scan. Both caps are
-- set from the LIVE distribution rather than picked to sound cautious — a cap
-- that silently bites the current data is a recall bug wearing a safety label:
--   * p_entity_hub_cap (default 12) — an entity mentioned in more than N
--     memories is not usable as an edge OR as a seed source. Without this, the
--     ubiquitous 'person'/'project' entities each manufacture a clique of their
--     mention_count and the walk drowns in them at depth 2. Measured on the live
--     store: p95 = 3, p99 = 9, max = 51, and a cap of 12 excludes 11 of 1,643
--     entities (0.7%). So it lands just above p99 and removes precisely the
--     hubs, keeping 99.3% of the entity layer in play. The cap is a SPECIFICITY
--     filter first and a performance guard second: an entity mentioned
--     everywhere carries almost no information about WHICH memories belong
--     together.
--   * p_community_cap (default 40) — same argument for oversized communities,
--     but the live distribution is much tighter: 51 communities, sizes 4..30,
--     only one above 25. An earlier draft defaulted this to 25 and therefore
--     silently dropped that one community entirely — exactly the failure this
--     sprint exists to fix, reintroduced by a cautious-looking constant. 40
--     leaves headroom over the observed max, binds on NOTHING live today, and
--     still stops a future runaway community from becoming a 500-clique. When it
--     starts binding, that is a signal to build a real membership table (see the
--     community_members note below), not to raise the number again.
--   * depth clamped INSIDE to [1,2] and rows to [1,200], never trusted from the
--     caller (034 REQ-1h precedent). Depth 3 over a co-mention arm is a
--     different order of magnitude and is not enabled by a caller typo.
--
-- MEASURED COST, live store, warm cache, versus 010 on the same seed embedding:
--   010  cross-project  depth 2, k=10  ->  ~300 ms
--   037  cross-project  depth 2, k=10  ->  ~350 ms   (all three arms + seeding)
--   037  project-filtered depth 2, k=6 ->  ~170 ms   (the realistic MCP call)
-- roughly +15% for a strictly larger reachable set. A first, COLD call in a
-- fresh backend measured ~2.2 s while it faulted pages into shared buffers;
-- that is first-touch, not steady state, and it does not reproduce on the second
-- call. Recorded here because a 2.2 s number seen once and unexplained is how a
-- healthy function gets reverted later.
--
-- PRIVACY: privacy_tags is RETURNED, and filtering is the CALLER's job — 034
-- REQ-1e's passthrough contract (034:1393-1399), and the same shape src/recall.ts
-- already uses at :213-224. This is load-bearing here, not ceremonial: expansion
-- reaches memories that hybrid search never scored, so a privacy-tagged row is
-- reachable via an edge from an untagged one, and a wider edge set widens that
-- reach. 010's return table has no privacy_tags column at all, which is why the
-- pre-existing graph surface cannot apply the gate — filed as a FINDING for ORCH
-- (Deck A STATUS, 2026-08-05 19:58 ET); NOT fixed here, because fixing it means
-- editing 010 and perturbing the default-OFF path this sprint must keep
-- byte-identical.
create or replace function public.memory_recall_graph_boosted(
  query_embedding    vector(1536),
  query_text         text    default null,
  project_filter     text    default null,
  max_depth          int     default 2,
  k                  int     default 10,
  p_entity_weight    float   default 0.45,
  p_community_weight float   default 0.35,
  p_entity_hub_cap   int     default 12,
  p_community_cap    int     default 40,
  p_max_rows         int     default 50,
  p_exclude_tier0    boolean default true
)
returns table (
  memory_id      uuid,
  content        text,
  project        text,
  source_type    text,
  metadata       jsonb,
  privacy_tags   text[],
  created_at     timestamptz,
  depth          int,
  seed_kind      text,
  edge_path      text[],
  vector_score   float,
  edge_weight    float,
  recency_score  float,
  final_score    float,
  path           uuid[]
)
language sql
stable                                            -- [GATE 5] read-only, structurally
security invoker                                  -- [GATE 5]
set search_path = public, extensions, pg_catalog  -- [GATE 4]
as $$
  with recursive
  -- TIER-0 EXCLUSION (seam item 3) is applied inline as
  --     source_type is distinct from 'objective'
  -- on every row admitted to the walk — see seeds_clean and the recursive step,
  -- both gated on p_exclude_tier0. There is no exclusion CTE because there is
  -- nothing to exclude BY: per B-T1's SCHEMA-READY (2026-08-05 20:00 ET,
  -- migration 038:47-59) objectives live in public.memory_objectives and are
  -- never written to memory_items, so this walk cannot reach one. §0.3 has the
  -- full reasoning and the precedence rule.

  -- Normalized query text. NULL/blank disables the entity arm's SEEDING
  -- entirely (the edge arms still fire) — callers that pass only an embedding
  -- get 010's entry behavior plus the wider edge set.
  q as (
    select nullif(btrim(lower(coalesce(query_text, ''))), '') as qt
  ),

  -- KEYWORD -> ENTITY TRIGGER.
  --
  -- Word-boundary regex rather than token equality, because entity_key is a
  -- normalized SURFACE FORM and the informative ones are multi-word: token
  -- equality would match 'vault' and miss 'vault readability', which is the
  -- more specific and therefore more useful trigger. The (^|[^a-z0-9]) /
  -- ($|[^a-z0-9]) guards are what keep it from degenerating into substring
  -- matching, where a 3-char key hits inside an unrelated longer word.
  --
  -- entity_key is stored already-normalized by upsert_memory_entities (034 §8:
  -- btrim + lower, server-side); aliases are normalized here because nothing
  -- guarantees the extractor did. Metachars are escaped before the key is
  -- interpolated into a pattern — an entity named 'c++' or 'foo.bar' must be a
  -- literal, and an unescaped one is both a wrong match and an error waiting for
  -- whichever extraction run first produces an unbalanced bracket.
  --
  -- length >= 3 drops the keys too short to be evidence of anything.
  matched_entities as (
    select e.id, e.entity_key, e.mention_count
      from public.memory_entities e
      cross join q
     where q.qt is not null
       and e.mention_count <= greatest(coalesce(p_entity_hub_cap, 12), 1)
       and length(e.entity_key) >= 3
       and q.qt ~ ('(^|[^a-z0-9])'
                   || regexp_replace(e.entity_key, '([\^$.|?*+()\[\]{}\\])', '\\\1', 'g')
                   || '($|[^a-z0-9])')
    union
    select e.id, e.entity_key, e.mention_count
      from public.memory_entities e
      -- jsonb_typeof guard INSIDE the lateral: a WHERE-clause guard would not
      -- protect it, because the set-returning function is evaluated as part of
      -- the join, before WHERE filters anything.
      cross join lateral jsonb_array_elements_text(
        case when jsonb_typeof(e.metadata->'aliases') = 'array'
             then e.metadata->'aliases'
             else '[]'::jsonb end
      ) as a(alias)
      cross join q
     where q.qt is not null
       and e.mention_count <= greatest(coalesce(p_entity_hub_cap, 12), 1)
       and length(btrim(lower(a.alias))) >= 3
       and q.qt ~ ('(^|[^a-z0-9])'
                   || regexp_replace(btrim(lower(a.alias)), '([\^$.|?*+()\[\]{}\\])', '\\\1', 'g')
                   || '($|[^a-z0-9])')
  ),

  -- Community membership, materialized ONCE per call rather than probed
  -- per-node. This is the deliberate asymmetry with arms 1 and 2, which expand
  -- lazily: membership lives in a jsonb array inside memory_items.metadata, and
  -- the only per-node probe available for it is a containment test over ~9,300
  -- rows with no index that answers it. Materializing instead costs one partial
  -- index scan of the 51 live summaries. This is precisely the full-scan-per-
  -- branch shape that caused the July-28 recall timeouts; it is affordable here
  -- ONLY because the summary count is two orders of magnitude smaller. If
  -- community summaries ever reach the thousands, this CTE needs a real
  -- membership table, not a bigger cap.
  community_member_raw as (
    select cs.id as summary_id,
           coalesce(cs.metadata->'consolidation'->>'community_key', cs.id::text) as community_key,
           m.value as member_txt
      from public.memory_items cs
      cross join lateral jsonb_array_elements_text(
        case when jsonb_typeof(cs.metadata->'consolidation'->'member_ids') = 'array'
             then cs.metadata->'consolidation'->'member_ids'
             else '[]'::jsonb end
      ) as m(value)
     where cs.metadata->'consolidation'->>'kind' = 'community_summary'
       and cs.is_active     = true
       and cs.archived      = false
       and cs.superseded_by is null
       and jsonb_array_length(
             case when jsonb_typeof(cs.metadata->'consolidation'->'member_ids') = 'array'
                  then cs.metadata->'consolidation'->'member_ids'
                  else '[]'::jsonb end
           ) <= greatest(coalesce(p_community_cap, 40), 1)
  ),
  community_members as (
    -- The uuid cast is inside a CASE so it is evaluated ONLY for values that
    -- already matched the shape. A cast in the select list of the same query
    -- level as its guard is not order-guaranteed, and one malformed member_id
    -- written by a future consolidation run would otherwise fail every recall.
    select summary_id, community_key, member_id
      from (
        select summary_id,
               community_key,
               case when member_txt ~
                      '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
                    then member_txt::uuid end as member_id
          from community_member_raw
      ) z
     where member_id is not null
  ),

  -- ── SEEDS ───────────────────────────────────────────────────────────
  -- match_memories filters is_active / archived / superseded_by / project
  -- itself, so vector seeds are tombstone-clean on arrival. match_threshold 0.0
  -- returns the full top-K: ranking is by the combined signal, not by a raw
  -- similarity cut (010's choice, kept).
  vector_seeds as (
    select mm.id as memory_id, mm.similarity::float as vscore
      from match_memories(query_embedding, 0.0, greatest(coalesce(k, 10), 1), project_filter) mm
  ),
  -- Bounded by 4k, ordered most-specific-entity-first, so a query that happens
  -- to name several entities cannot enter the walk from a hundred places at
  -- once. Derived from k rather than exposed as a knob: it is a consequence of
  -- how much recall the caller asked for, not an independent policy.
  --
  -- ⚠ FILTER BEFORE LIMIT — every predicate that can REJECT a seed runs INSIDE
  -- this subquery, ahead of the cap. This is not stylistic. A candidate the
  -- caller could never have received still consumes budget if it is discarded
  -- after the LIMIT, and it silently evicts a candidate the caller WOULD have
  -- received. Filtering afterwards (in seeds_clean) cannot recover the evicted
  -- row: the information is already gone.
  --
  -- Found live by A-T4 (AUDIT-FAIL 2026-08-05 20:22) on the project filter:
  -- entity 'helena' has 7 mentions in chopin-in-bohemia and 1 in termdeck, so
  -- at k=1 the pre-limit top 4 were all chopin-in-bohemia and a
  -- project_filter='termdeck' recall got ZERO entity seeds instead of the one
  -- that exists. The same eviction applies identically to tombstoned rows
  -- (mentions point at rows regardless of is_active/archived/superseded_by) and
  -- to the tier-0 belt, so all three predicates moved here together — fixing
  -- only the reported one would have left the same bug wearing two other hats.
  entity_seeds as (
    select memory_id
      from (
        select m.memory_id, min(me.mention_count) as best_mc
          from matched_entities me
          join public.memory_entity_mentions m on m.entity_id = me.id
          join public.memory_items mi
            on mi.id            = m.memory_id
           and mi.is_active     = true
           and mi.archived      = false
           and mi.superseded_by is null
         where (project_filter is null or mi.project = project_filter)
           -- [seam §3] belt, applied here too so an objective row cannot
           -- consume seed budget even in the world where one exists.
           and (not coalesce(p_exclude_tier0, true)
                or mi.source_type is distinct from 'objective')
         group by m.memory_id
         order by min(me.mention_count) asc, m.memory_id
         limit least(4 * greatest(coalesce(k, 10), 1), 100)
      ) es
  ),
  seeds as (
    select
      coalesce(v.memory_id, e.memory_id) as memory_id,
      case
        when v.memory_id is not null and e.memory_id is not null then 'both'
        when v.memory_id is not null                             then 'vector'
        else                                                          'entity'
      end as seed_kind,
      -- greatest(): an exact keyword->entity hit must never demote a row the
      -- vector already scored above p_entity_weight.
      greatest(
        coalesce(v.vscore, 0::float),
        case when e.memory_id is not null then coalesce(p_entity_weight, 0.45) else 0::float end
      )::float as vector_score
    from vector_seeds v
    full outer join entity_seeds e on e.memory_id = v.memory_id
  ),
  -- Two different jobs, deliberately kept in one place:
  --   * for VECTOR seeds this is the PRIMARY gate for the tier-0 belt —
  --     match_memories filters project and tombstones itself, but knows nothing
  --     about source_type.
  --   * for ENTITY seeds it is now defense-in-depth; entity_seeds already
  --     applied all three predicates before its cap, which is where they have to
  --     run to be correct. Re-checking here is free and keeps this CTE's
  --     guarantee true independent of what fed it.
  seeds_clean as (
    select s.memory_id, s.seed_kind, s.vector_score
      from seeds s
      join public.memory_items mi
        on mi.id            = s.memory_id
       and mi.is_active     = true
       and mi.archived      = false
       and mi.superseded_by is null
     where (project_filter is null or mi.project = project_filter)
       -- [seam §3] belt; the guarantee is that objectives are not in this table.
       and (not coalesce(p_exclude_tier0, true)
            or mi.source_type is distinct from 'objective')
  ),

  -- ── WALK ────────────────────────────────────────────────────────────
  -- The three arms live in ONE lateral rather than three UNIONed recursive
  -- terms, because a recursive term may reference its own CTE exactly once —
  -- three arms each selecting `from walk` is rejected outright. The lateral
  -- correlates on w.node_id, so each arm still expands lazily per node and the
  -- planner keeps its index paths.
  walk as (
    select
      s.memory_id        as node_id,
      0                  as depth,
      array[s.memory_id] as path,
      array[]::text[]    as edge_path,
      0::float           as w_sum,
      s.vector_score     as seed_score,
      s.seed_kind        as seed_kind
    from seeds_clean s
    union all
    select
      nb.next_id,
      w.depth + 1,
      w.path      || nb.next_id,
      w.edge_path || nb.label,
      w.w_sum     + nb.w,
      w.seed_score,
      w.seed_kind
    from walk w
    cross join lateral (
      -- arm 1 — typed edges. LIVE only (034 §1's temporal columns); existing
      -- weight untouched, NULL entering at 0.5 exactly as 010 and 034 do.
      select
        case when r.source_id = w.node_id then r.target_id else r.source_id end as next_id,
        'typed:' || r.relationship_type                                        as label,
        coalesce(r.weight, 0.5)::float                                         as w
        from public.memory_relationships r
       where (r.source_id = w.node_id or r.target_id = w.node_id)
         and r.invalid_at is null
         and (r.valid_at is null or r.valid_at <= now())

      union all

      -- arm 2 — entity co-mention. Hub cap applied to the SHARED entity, so a
      -- memory that happens to mention one ubiquitous entity is not thereby
      -- joined to everything else that mentions it.
      select
        m2.memory_id,
        'entity:' || e.entity_key,
        coalesce(p_entity_weight, 0.45)::float
        from public.memory_entity_mentions m1
        join public.memory_entities e
          on e.id            = m1.entity_id
         and e.mention_count <= greatest(coalesce(p_entity_hub_cap, 12), 1)
        join public.memory_entity_mentions m2
          on m2.entity_id = e.id
         and m2.memory_id <> w.node_id
       where m1.memory_id = w.node_id

      union all

      -- arm 3a — community co-membership, member <-> member.
      select
        cm2.member_id,
        'community:' || cm.community_key,
        coalesce(p_community_weight, 0.35)::float
        from community_members cm
        join community_members cm2
          on cm2.summary_id = cm.summary_id
         and cm2.member_id <> w.node_id
       where cm.member_id = w.node_id

      union all

      -- arm 3b — member -> the community's SUMMARY row. This is what makes
      -- A-T2's hub coarse-to-fine possible at all: reaching one member of a
      -- community puts the compiled consolidation_summary in the result set,
      -- where it can be promoted to primary with its members as citations.
      select
        cm.summary_id,
        'community:' || cm.community_key,
        coalesce(p_community_weight, 0.35)::float
        from community_members cm
       where cm.member_id = w.node_id
    ) nb
    -- Tombstone hygiene on the node being ADDED, so no path routes THROUGH a
    -- superseded memory (034 REQ-1d).
    join public.memory_items nxt
      on nxt.id            = nb.next_id
     and nxt.is_active     = true
     and nxt.archived      = false
     and nxt.superseded_by is null
    where w.depth < least(greatest(coalesce(max_depth, 2), 1), 2)   -- clamped inside
      -- Cycle guard (009/034 idiom): never revisit a node already on this path.
      and not (nb.next_id = any (w.path))
      and (project_filter is null or nxt.project = project_filter)
      -- [seam §3] belt, same as seeds_clean: a walk cannot route INTO tier 0.
      and (not coalesce(p_exclude_tier0, true)
           or nxt.source_type is distinct from 'objective')
  ),

  scored as (
    select
      w.node_id as memory_id,
      mi.content,
      mi.project,
      mi.source_type,
      mi.metadata,
      mi.privacy_tags,                                    -- passthrough; caller filters
      mi.created_at,
      w.depth,
      -- seed_kind describes how the row ENTERED the walk, so it is meaningful
      -- only at depth 0; a neighbor's provenance is its edge_path.
      case when w.depth = 0 then w.seed_kind end as seed_kind,
      w.edge_path,
      w.seed_score as vector_score,
      case when w.depth = 0 then 1.0::float
           else (w.w_sum / w.depth)::float end as edge_weight,
      exp(-extract(epoch from (now() - mi.created_at))::float / (30.0 * 86400.0))::float
        as recency_score,
      w.path
    from walk w
    join public.memory_items mi on mi.id = w.node_id
  ),
  ranked as (
    -- The same memory is commonly reached several ways — as a vector seed AND
    -- via a neighbor, or through two different arms. Keep the strongest single
    -- path; depth 0 wins ties so a genuine vector hit is never relabeled as a
    -- neighbor of itself.
    select distinct on (memory_id)
      memory_id, content, project, source_type, metadata, privacy_tags, created_at,
      depth, seed_kind, edge_path, vector_score, edge_weight, recency_score,
      (vector_score * edge_weight * recency_score)::float as final_score,
      path
    from scored
    order by memory_id, (vector_score * edge_weight * recency_score) desc, depth asc
  )
  select
    memory_id, content, project, source_type, metadata, privacy_tags, created_at,
    depth, seed_kind, edge_path, vector_score, edge_weight, recency_score,
    final_score, path
  from ranked
  order by final_score desc, depth asc, memory_id
  limit least(greatest(coalesce(p_max_rows, 50), 1), 200);          -- clamped inside
$$;

comment on function public.memory_recall_graph_boosted(
  vector, text, text, int, int, float, float, int, int, int, boolean) is
  'Sprint 70 (A-T1): graph-boosted recall. Extends migration 010''s walk in two '
  'ways — the recursive expansion follows typed memory_relationships edges UNION '
  'entity co-mention (034 memory_entity_mentions) UNION consolidation community '
  'co-membership including each community''s summary row; and query terms are '
  'matched against memory_entities (key + aliases, word-boundary) to seed the '
  'walk by KEYWORD alongside the vector seeds. Ranking is unchanged from 010 '
  '(vector_score x edge_weight x recency_score) — this widens WHICH rows reach '
  'the ranking, not how they are ordered. Weights, hub caps and the tier-0 '
  'switch are arguments with conservative defaults; depth is clamped to [1,2] '
  'and rows to [1,200] inside. edge_path labels every hop by arm '
  '(typed:/entity:/community:) so a caller can see which arm fired. privacy_tags '
  'passes through for caller-side filtering (034 REQ-1e). STABLE — structurally '
  'incapable of writing. INVOKER, pinned search_path; EXECUTE: service_role '
  'only. Migration 010''s memory_recall_graph is untouched and remains the '
  'default path. Exactly one signature: do not add an overload.';

-- ====================================================================
-- 2b. Grants — [GATE 3]
-- ====================================================================
--
-- Migration 014:45 grants EXECUTE on new public functions to service_role,
-- authenticated AND anon by default privilege, so the REVOKE is what actually
-- closes the surface. See the GATE 3 note in the header for why this is
-- deliberately TIGHTER than 010's grant set.
revoke execute on function public.memory_recall_graph_boosted(
  vector, text, text, int, int, float, float, int, int, int, boolean)
  from public, anon, authenticated;

grant execute on function public.memory_recall_graph_boosted(
  vector, text, text, int, int, float, float, int, int, int, boolean)
  to service_role;

-- ====================================================================
-- 3. Apply-time receipt — HARD-FAILING
-- ====================================================================
--
-- apply_migration has a known silent-no-op failure mode, so a receipt that
-- cannot fail is not a receipt (026/027/031/033/034 precedent). Every check
-- below RAISES rather than NOTICEs: a clean apply IS the evidence.
--
-- OID form throughout. pg_get_function_identity_arguments returns argument NAMES
-- on Supabase's Postgres, so a receipt that reconstructs a text signature and
-- compares it silently matches nothing.
do $$
declare
  v_oid    oid;
  v_n      int;
  v_cfg    text;
  v_secdef boolean;
  v_vol    "char";
begin
  -- ── the function exists, exactly once ──────────────────────────────────
  select count(*) into v_n
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'memory_recall_graph_boosted';

  if v_n = 0 then
    raise exception '[037] memory_recall_graph_boosted missing after apply';
  end if;
  if v_n > 1 then
    raise exception
      '[037] memory_recall_graph_boosted has % overloads — PostgREST cannot bind an ambiguous RPC (see 034:87-92)',
      v_n;
  end if;

  select p.oid into v_oid
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'memory_recall_graph_boosted';

  -- ── [GATE 4] search_path pinned, and it includes extensions (vector type) ──
  select array_to_string(p.proconfig, ',') into v_cfg from pg_proc p where p.oid = v_oid;
  if v_cfg is null or v_cfg not like '%search_path=%' then
    raise exception '[037] memory_recall_graph_boosted has no pinned search_path [GATE 4]';
  end if;
  if v_cfg not like '%extensions%' then
    raise exception
      '[037] memory_recall_graph_boosted search_path lacks `extensions` — the vector(1536) argument will not resolve [GATE 4]';
  end if;

  -- ── [GATE 5] read-only + invoker ───────────────────────────────────────
  select p.provolatile, p.prosecdef into v_vol, v_secdef from pg_proc p where p.oid = v_oid;
  if v_vol <> 's' then
    raise exception
      '[037] memory_recall_graph_boosted is not STABLE (provolatile=%) — read-only is meant to be structural [GATE 5]',
      v_vol;
  end if;
  if v_secdef then
    raise exception '[037] memory_recall_graph_boosted must be SECURITY INVOKER [GATE 5]';
  end if;

  -- ── [GATE 3] no PUBLIC/anon/authenticated EXECUTE; service_role has it ──
  if has_function_privilege('public',        v_oid, 'EXECUTE') then
    raise exception '[037] PUBLIC still has EXECUTE on memory_recall_graph_boosted [GATE 3]';
  end if;
  if has_function_privilege('anon',          v_oid, 'EXECUTE') then
    raise exception '[037] anon still has EXECUTE on memory_recall_graph_boosted [GATE 3]';
  end if;
  if has_function_privilege('authenticated', v_oid, 'EXECUTE') then
    raise exception '[037] authenticated still has EXECUTE on memory_recall_graph_boosted [GATE 3]';
  end if;
  if not has_function_privilege('service_role', v_oid, 'EXECUTE') then
    raise exception '[037] service_role LACKS EXECUTE on memory_recall_graph_boosted — the MCP server cannot call it [GATE 3]';
  end if;

  -- ── the substrate this migration exists to reach is actually present ───
  -- A silent apply against a store where 034 never landed would leave a
  -- function that runs, returns 010-equivalent output, and looks fine.
  if to_regclass('public.memory_entity_mentions') is null
     or to_regclass('public.memory_entities') is null then
    raise exception '[037] migration 034 entity tables absent — 037 has nothing to wire';
  end if;

  if not exists (
    select 1 from pg_indexes
     where schemaname = 'public' and indexname = 'memory_entities_mention_count_idx'
  ) then
    raise exception '[037] index memory_entities_mention_count_idx missing';
  end if;

  -- ── 010 must still be intact and single-signature ──────────────────────
  -- This migration's whole compatibility story is "010 is untouched"; assert it
  -- rather than trust it, because a hand-edited install is exactly where the
  -- default-OFF path would silently stop being byte-identical.
  select count(*) into v_n
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'memory_recall_graph';
  if v_n <> 1 then
    raise exception
      '[037] memory_recall_graph should have exactly 1 signature, found % — the MNESTRA_GRAPH_RECALL-off path is no longer byte-identical',
      v_n;
  end if;

  raise notice '[037] OK — memory_recall_graph_boosted installed, gates 3/4/5 verified, 010 intact';
end $$;

-- ====================================================================
-- 4. Post-apply verification (ORCH runs at close; commented on purpose)
-- ====================================================================
--
-- The acceptance criterion is that the canonical diagnosis query stops
-- returning d0-only. Run BOTH and diff the depth distributions — the point is
-- the delta, not either number alone.
--
--   -- 4.1  Which entities the query text triggers (should be non-empty):
--   -- select e.entity_type, e.entity_key, e.mention_count
--   --   from memory_entities e
--   --  where e.mention_count <= 12
--   --    and length(e.entity_key) >= 3
--   --    and lower('vault readability navigation layer') ~
--   --        ('(^|[^a-z0-9])' || regexp_replace(e.entity_key,'([\^$.|?*+()\[\]{}\\])','\\\1','g')
--   --                         || '($|[^a-z0-9])')
--   --  order by e.mention_count;
--
--   -- 4.2  Depth distribution + which arms fired. BEFORE this migration the
--   --      same query returns d0=6 and nothing else.
--   -- select depth, count(*),
--   --        count(*) filter (where exists (
--   --          select 1 from unnest(edge_path) lbl where lbl like 'entity:%')) as via_entity,
--   --        count(*) filter (where exists (
--   --          select 1 from unnest(edge_path) lbl where lbl like 'community:%')) as via_community,
--   --        count(*) filter (where exists (
--   --          select 1 from unnest(edge_path) lbl where lbl like 'typed:%')) as via_typed
--   --   from memory_recall_graph_boosted(
--   --          query_embedding := <embedding of 'vault readability navigation layer'>,
--   --          query_text      := 'vault readability navigation layer',
--   --          project_filter  := 'termdeck',
--   --          max_depth       := 2,
--   --          k               := 6)
--   --  group by depth order by depth;
--
--   -- 4.3  Five-gate advisor sweep (global CLAUDE.md § Supabase RLS hygiene):
--   --      mcp__supabase__get_advisors, plus the PUBLIC-EXECUTE query from that
--   --      section. This file creates no table and no policy, so 0011/0013 have
--   --      no new surface; 0011 (mutable search_path) is asserted by §3 above.

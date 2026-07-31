-- tests/sql/034b_verify.sql — Sprint 83 T1, part 2 of 2.
--
-- Runs against a database where 034a seeded pre-034 fixtures and migration 034
-- has since been applied. Everything here is self-checking: each section RAISEs
-- on failure, so a green run of this file IS the acceptance evidence rather than
-- a transcript somebody has to read.
--
-- Sections:
--   1  Legacy survival — every pre-034 edge still exists, including one whose
--      relationship_type 034 had never heard of.
--   2  Temporal backfill — valid_at carries HISTORY, not the apply timestamp.
--   3  upsert_memory_edges — accept / drop-invalid / dropped_predicates, and
--      the two new predicates actually work end to end.
--   4  memory_expand_typed — REQ-1 semantics (a)-(h).
--   5  Invalidate-don't-delete, and expansion stops seeing a retracted edge.
--   6  The supersession sweep is as narrow as it claims.
--   7  upsert_memory_entities.
--   8  mark_recall_cited_group — idempotency, honest zero, observed negatives,
--      and the label reaching fit-platt's ACTUAL query.
--   9  Five hygiene gates, re-checked independently of the migration's receipt.
--  10  Cleanup.

\set ON_ERROR_STOP on
set search_path = public, extensions, pg_catalog;

do $$
begin
  if current_database() <> 'mnestra_test' then
    raise exception '[034-test] REFUSING TO RUN: expected database "mnestra_test", got "%".',
      current_database();
  end if;
  if not exists (select 1 from public.__t034_baseline) then
    raise exception '[034-test] 034a fixtures are missing — run 034a before migration 034, then this file.';
  end if;
end $$;

-- ════════════════════════════════════════════════════════════════════════════
-- 1. Legacy survival
-- ════════════════════════════════════════════════════════════════════════════
do $$
declare
  v_missing int;
  v_before  bigint;
  v_after   bigint;
  v_adopted text;
begin
  -- Every edge captured before 034 must still be present, by id.
  select count(*) into v_missing
    from public.__t034_baseline b
   where not exists (select 1 from public.memory_relationships r where r.id = b.id);
  if v_missing > 0 then
    raise exception '[034-test §1] % pre-034 edges disappeared across the migration', v_missing;
  end if;

  -- And nothing anywhere else was deleted either.
  select edges_before into v_before from public.__t034_counts;
  select count(*)    into v_after   from public.memory_relationships;
  if v_after < v_before then
    raise exception '[034-test §1] corpus edge count FELL across the migration: % -> %', v_before, v_after;
  end if;

  -- The unknown-vocabulary edge is the load-bearing case: 034 must have adopted
  -- its type rather than rejecting the edge. If the adoption pass is ever
  -- removed, migration 034 itself fails on this fixture — which is the point.
  if not exists (
    select 1 from public.memory_relationships r
     where r.relationship_type = 'legacy_exotic_link'
  ) then
    raise exception '[034-test §1] the pre-existing legacy_exotic_link edge did not survive 034';
  end if;

  select added_in into v_adopted
    from public.memory_relationship_types where type = 'legacy_exotic_link';
  if v_adopted is null then
    raise exception '[034-test §1] legacy_exotic_link was never adopted into memory_relationship_types — the FK would reject this install';
  end if;
  if v_adopted <> 'pre-034 (adopted)' then
    raise exception '[034-test §1] legacy_exotic_link adopted with unexpected provenance "%"', v_adopted;
  end if;

  -- All 14 shipped predicates present, and the FK really is in force.
  if (select count(*) from public.memory_relationship_types) < 15 then
    raise exception '[034-test §1] expected >= 15 vocabulary rows (14 shipped + 1 adopted), got %',
      (select count(*) from public.memory_relationship_types);
  end if;

  begin
    insert into public.memory_relationships (source_id, target_id, relationship_type)
    values ('00000000-0000-4000-9000-000000000001',
            '00000000-0000-4000-9000-000000000003', 'not_a_real_predicate');
    raise exception '[034-test §1] FK did NOT reject an unknown relationship_type — the vocabulary is unenforced';
  exception
    when foreign_key_violation then null;   -- expected
  end;
end $$;

-- ════════════════════════════════════════════════════════════════════════════
-- 2. Temporal backfill carries history, not the apply timestamp
-- ════════════════════════════════════════════════════════════════════════════
do $$
declare
  v_drifted int;
  v_live    int;
begin
  -- valid_at must EQUAL the row's created_at for every backfilled edge. A
  -- volatile-default ADD COLUMN would have stamped them all with the apply
  -- transaction's now(), which is the specific mistake §1 of the migration is
  -- written four statements long to avoid.
  select count(*) into v_drifted
    from public.__t034_baseline b
    join public.memory_relationships r on r.id = b.id
   where r.valid_at is distinct from b.created_at;
  if v_drifted > 0 then
    raise exception '[034-test §2] % edges have valid_at <> created_at — the backfill used the apply time instead of history', v_drifted;
  end if;

  -- Sanity: those timestamps really are old, so the check above cannot pass
  -- trivially by everything having been created seconds ago.
  if (select min(valid_at) from public.memory_relationships
       where id in (select id from public.__t034_baseline)) > now() - interval '30 days' then
    raise exception '[034-test §2] fixture valid_at values are not backdated; the backfill assertion would be vacuous';
  end if;

  -- The migration retracts nothing.
  select count(*) into v_live from public.memory_relationships where invalid_at is not null;
  if v_live > 0 then
    raise exception '[034-test §2] % edges were invalidated by the migration itself; 034 must retract nothing', v_live;
  end if;
end $$;

-- ════════════════════════════════════════════════════════════════════════════
-- 3. upsert_memory_edges — accept, drop-invalid, and the new predicates
-- ════════════════════════════════════════════════════════════════════════════
-- Also seeds the two 034-only predicates the expansion tests need. They cannot
-- be inserted by 034a (they did not exist pre-034), so creating them through the
-- RPC is both the natural order and a real end-to-end check that widening the
-- vocabulary actually works.
do $$
declare
  v_res jsonb;
begin
  v_res := public.upsert_memory_edges(jsonb_build_array(
    -- valid: M1 --fixed_by--> M2   (the symptom is fixed by the fix)
    jsonb_build_object('source_id','00000000-0000-4000-9000-000000000001',
                       'target_id','00000000-0000-4000-9000-000000000002',
                       'predicate','fixed_by','weight',0.95,'inferred_by','fixture-034b'),
    -- valid: M1 --same_pattern_as--> M3
    jsonb_build_object('source_id','00000000-0000-4000-9000-000000000001',
                       'target_id','00000000-0000-4000-9000-000000000003',
                       'predicate','same_pattern_as','weight',0.85,'inferred_by','fixture-034b'),
    -- dropped: hallucinated predicate
    jsonb_build_object('source_id','00000000-0000-4000-9000-000000000001',
                       'target_id','00000000-0000-4000-9000-000000000004',
                       'predicate','invented_by_the_model'),
    -- dropped: malformed uuid (must NOT raise — this is the whole contract)
    jsonb_build_object('source_id','not-a-uuid',
                       'target_id','00000000-0000-4000-9000-000000000004',
                       'predicate','relates_to'),
    -- dropped: self-edge
    jsonb_build_object('source_id','00000000-0000-4000-9000-000000000001',
                       'target_id','00000000-0000-4000-9000-000000000001',
                       'predicate','relates_to'),
    -- dropped: target memory does not exist
    jsonb_build_object('source_id','00000000-0000-4000-9000-000000000001',
                       'target_id','00000000-0000-4000-9000-0000000000ff',
                       'predicate','relates_to')
  ));

  if (v_res->>'accepted')::int <> 2 then
    raise exception '[034-test §3] expected 2 accepted edges, got % (%)', v_res->>'accepted', v_res;
  end if;
  if (v_res->>'dropped')::int <> 4 then
    raise exception '[034-test §3] expected 4 dropped edges, got % (%)', v_res->>'dropped', v_res;
  end if;
  if not (v_res->'dropped_predicates' @> '["invented_by_the_model"]'::jsonb) then
    raise exception '[034-test §3] dropped_predicates did not report the unknown predicate: %', v_res;
  end if;
  -- Only genuinely-unknown PREDICATES belong in that list; a malformed uuid on a
  -- legal predicate is not a vocabulary problem.
  if v_res->'dropped_predicates' @> '["relates_to"]'::jsonb then
    raise exception '[034-test §3] dropped_predicates wrongly lists a VALID predicate: %', v_res;
  end if;

  -- Idempotent: the same batch again accepts the same 2 and creates nothing new.
  v_res := public.upsert_memory_edges(jsonb_build_array(
    jsonb_build_object('source_id','00000000-0000-4000-9000-000000000001',
                       'target_id','00000000-0000-4000-9000-000000000002',
                       'predicate','fixed_by','weight',0.95)
  ));
  if (v_res->>'accepted')::int <> 1 then
    raise exception '[034-test §3] re-assert should still report accepted=1, got %', v_res;
  end if;
  if (select count(*) from public.memory_relationships
       where source_id='00000000-0000-4000-9000-000000000001'
         and target_id='00000000-0000-4000-9000-000000000002'
         and relationship_type='fixed_by') <> 1 then
    raise exception '[034-test §3] re-assert duplicated the edge instead of upserting it';
  end if;

  -- Empty / malformed input returns a result rather than raising.
  if (public.upsert_memory_edges(null)->>'accepted')::int <> 0 then
    raise exception '[034-test §3] null input should return accepted=0, not raise';
  end if;
  if (public.upsert_memory_edges('"nonsense"'::jsonb)->>'dropped')::int <> 0 then
    raise exception '[034-test §3] non-array input should return a zeroed result, not raise';
  end if;
end $$;

-- ════════════════════════════════════════════════════════════════════════════
-- 4. memory_expand_typed — REQ-1 (a)-(h)
-- ════════════════════════════════════════════════════════════════════════════
do $$
declare
  v_n     int;
  v_row   record;
  v_ids   uuid[];
begin
  -- (b) Default allowlist at depth 1 from the symptom: the fix (fixed_by), the
  -- sibling (same_pattern_as) and the cause (caused_by). NOT M4 (reached only
  -- by relates_to, off the allowlist) and NOT M5 (supersedes is ON the
  -- allowlist, so only the tombstone check can exclude it).
  select array_agg(memory_id order by memory_id) into v_ids
    from public.memory_expand_typed(
      array['00000000-0000-4000-9000-000000000001']::uuid[], null, 1, 25, null);

  if not (v_ids @> array['00000000-0000-4000-9000-000000000002',
                         '00000000-0000-4000-9000-000000000003',
                         '00000000-0000-4000-9000-000000000007']::uuid[]) then
    raise exception '[034-test §4b] depth-1 expansion missed an expected neighbour: %', v_ids;
  end if;
  if v_ids && array['00000000-0000-4000-9000-000000000004']::uuid[] then
    raise exception '[034-test §4b] relates_to neighbour leaked into a typed expansion — untyped hops are not excluded';
  end if;

  -- (d) Tombstone hygiene, on results AND on paths. M5 is superseded; M6 is
  -- reachable ONLY through M5. Both must be absent — the second is what
  -- distinguishes filtering paths from filtering results.
  if v_ids && array['00000000-0000-4000-9000-000000000005']::uuid[] then
    raise exception '[034-test §4d] a superseded memory was returned as a neighbour';
  end if;
  select array_agg(memory_id) into v_ids
    from public.memory_expand_typed(
      array['00000000-0000-4000-9000-000000000001']::uuid[], null, 2, 25, null);
  if v_ids && array['00000000-0000-4000-9000-000000000006']::uuid[] then
    raise exception '[034-test §4d] expansion routed THROUGH a tombstoned memory to reach M6';
  end if;

  -- (g) No seed echo, ever.
  if v_ids && array['00000000-0000-4000-9000-000000000001']::uuid[] then
    raise exception '[034-test §4g] the seed was returned as its own neighbour';
  end if;

  -- Depth 2 reaches M8 via M1 -fixed_by-> M2 -supersedes-> M8, and reports both
  -- hops in edge_path with the terminal predicate in edge_type.
  select * into v_row
    from public.memory_expand_typed(
      array['00000000-0000-4000-9000-000000000001']::uuid[], null, 2, 25, null)
   where memory_id = '00000000-0000-4000-9000-000000000008';
  if v_row is null then
    raise exception '[034-test §4] depth-2 neighbour M8 was not reached';
  end if;
  if v_row.depth <> 2 then
    raise exception '[034-test §4] M8 reported at depth % instead of 2', v_row.depth;
  end if;
  if v_row.edge_type <> 'supersedes' then
    raise exception '[034-test §4] edge_type should be the LAST predicate on the path, got %', v_row.edge_type;
  end if;
  if v_row.edge_path <> array['fixed_by','supersedes']::text[] then
    raise exception '[034-test §4] edge_path should list every predicate in order, got %', v_row.edge_path;
  end if;
  -- edge_weight is the MEAN along the path: (0.95 + 0.70) / 2.
  if abs(v_row.edge_weight - 0.825) > 1e-9 then
    raise exception '[034-test §4] edge_weight should be the path mean 0.825, got %', v_row.edge_weight;
  end if;

  -- (c) Direction. M1 --caused_by--> M7: seeding M1 walks source->target.
  select direction into v_row
    from public.memory_expand_typed(
      array['00000000-0000-4000-9000-000000000001']::uuid[], array['caused_by'], 1, 25, null)
   where memory_id = '00000000-0000-4000-9000-000000000007';
  if v_row.direction <> 'outbound' then
    raise exception '[034-test §4c] seed=source should report outbound, got %', v_row.direction;
  end if;
  -- Seeding the OTHER end of the same edge walks target->source.
  select direction into v_row
    from public.memory_expand_typed(
      array['00000000-0000-4000-9000-000000000007']::uuid[], array['caused_by'], 1, 25, null)
   where memory_id = '00000000-0000-4000-9000-000000000001';
  if v_row.direction <> 'inbound' then
    raise exception '[034-test §4c] seed=target should report inbound, got %', v_row.direction;
  end if;

  -- (h) Caps clamped INSIDE the function, not trusted from the caller.
  select count(*) into v_n
    from public.memory_expand_typed(
      array['00000000-0000-4000-9000-000000000001']::uuid[], null, 2, 1, null);
  if v_n <> 1 then
    raise exception '[034-test §4h] p_max_rows=1 returned % rows', v_n;
  end if;
  select coalesce(max(depth), 0) into v_n
    from public.memory_expand_typed(
      array['00000000-0000-4000-9000-000000000001']::uuid[], null, 99, 25, null);
  if v_n > 2 then
    raise exception '[034-test §4h] p_max_depth=99 was not clamped to 2 (max depth %)', v_n;
  end if;
  -- A zero/negative depth must still mean "one hop", not "no expansion".
  select count(*) into v_n
    from public.memory_expand_typed(
      array['00000000-0000-4000-9000-000000000001']::uuid[], null, 0, 25, null);
  if v_n = 0 then
    raise exception '[034-test §4h] p_max_depth=0 was not clamped up to 1';
  end if;

  -- p_project narrows the RETURNED node.
  select count(*) into v_n
    from public.memory_expand_typed(
      array['00000000-0000-4000-9000-000000000001']::uuid[], null, 2, 25, '__nonexistent_project__');
  if v_n <> 0 then
    raise exception '[034-test §4] p_project filter did not apply (% rows)', v_n;
  end if;

  -- Degenerate inputs return empty rather than raising.
  if (select count(*) from public.memory_expand_typed(null, null, 1, 10, null)) <> 0 then
    raise exception '[034-test §4] null seed array should return no rows';
  end if;

  -- (e) privacy_tags is passed through for caller-side filtering.
  if not exists (
    select 1 from public.memory_expand_typed(
      array['00000000-0000-4000-9000-000000000001']::uuid[], null, 1, 25, null)
     where privacy_tags is not null
  ) then
    raise exception '[034-test §4e] privacy_tags was not passed through';
  end if;

  -- (f) STABLE is the structural read-only proof.
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'memory_expand_typed'
       and p.provolatile = 's'
  ) then
    raise exception '[034-test §4f] memory_expand_typed is not STABLE — it is no longer structurally incapable of writing';
  end if;
end $$;

-- ════════════════════════════════════════════════════════════════════════════
-- 5. Invalidate-don't-delete
-- ════════════════════════════════════════════════════════════════════════════
do $$
declare
  v_edge   uuid;
  v_n      int;
  v_first  timestamptz;
  v_second timestamptz;
  v_total  bigint;
  v_after  bigint;
begin
  select count(*) into v_total from public.memory_relationships;

  select id into v_edge
    from public.memory_relationships
   where source_id = '00000000-0000-4000-9000-000000000001'
     and target_id = '00000000-0000-4000-9000-000000000007'
     and relationship_type = 'caused_by';

  v_n := public.memory_invalidate_edge(v_edge);
  if v_n <> 1 then
    raise exception '[034-test §5] first invalidation should update 1 row, got %', v_n;
  end if;

  -- The ROW is still there. This is the entire thesis of the design.
  if not exists (select 1 from public.memory_relationships where id = v_edge) then
    raise exception '[034-test §5] invalidation DELETED the edge — invalidate-don''t-delete violated';
  end if;
  select count(*) into v_after from public.memory_relationships;
  if v_after <> v_total then
    raise exception '[034-test §5] edge count changed during invalidation: % -> %', v_total, v_after;
  end if;

  select invalid_at into v_first from public.memory_relationships where id = v_edge;
  if v_first is null then
    raise exception '[034-test §5] invalid_at was not set';
  end if;

  -- Idempotent, AND the original retraction time survives. Re-invalidating must
  -- not rewrite history.
  v_n := public.memory_invalidate_edge(v_edge);
  if v_n <> 0 then
    raise exception '[034-test §5] repeat invalidation should be a no-op, updated % rows', v_n;
  end if;
  select invalid_at into v_second from public.memory_relationships where id = v_edge;
  if v_second is distinct from v_first then
    raise exception '[034-test §5] repeat invalidation moved invalid_at from % to %', v_first, v_second;
  end if;

  -- (a) A retracted edge is invisible to expansion — the read side of the design.
  if exists (
    select 1 from public.memory_expand_typed(
      array['00000000-0000-4000-9000-000000000001']::uuid[], array['caused_by'], 1, 25, null)
     where memory_id = '00000000-0000-4000-9000-000000000007'
  ) then
    raise exception '[034-test §5a] expansion still traverses a retracted edge';
  end if;

  -- ...and to the 009 traversal that 010's memory_recall_graph consumes.
  if exists (
    select 1 from public.expand_memory_neighborhood(
      '00000000-0000-4000-9000-000000000001'::uuid, 1)
     where memory_id = '00000000-0000-4000-9000-000000000007'
  ) then
    raise exception '[034-test §5a] expand_memory_neighborhood still traverses a retracted edge';
  end if;

  -- Re-assertion RESURRECTS (the hole the PostgREST upsert would leave open).
  perform public.upsert_memory_edges(jsonb_build_array(
    jsonb_build_object('source_id','00000000-0000-4000-9000-000000000001',
                       'target_id','00000000-0000-4000-9000-000000000007',
                       'predicate','caused_by','weight',0.9)));
  if (select invalid_at from public.memory_relationships where id = v_edge) is not null then
    raise exception '[034-test §5] re-assertion did not clear invalid_at — the resurrection hole is open';
  end if;
  if not exists (
    select 1 from public.memory_expand_typed(
      array['00000000-0000-4000-9000-000000000001']::uuid[], array['caused_by'], 1, 25, null)
     where memory_id = '00000000-0000-4000-9000-000000000007'
  ) then
    raise exception '[034-test §5] a resurrected edge is still invisible to expansion';
  end if;

  -- Endpoint-form invalidation is DIRECTED.
  v_n := public.memory_invalidate_edges(
    '00000000-0000-4000-9000-000000000007', '00000000-0000-4000-9000-000000000001', 'caused_by');
  if v_n <> 0 then
    raise exception '[034-test §5] reverse-direction invalidation should match nothing, updated %', v_n;
  end if;
  v_n := public.memory_invalidate_edges(
    '00000000-0000-4000-9000-000000000001', '00000000-0000-4000-9000-000000000007', 'caused_by');
  if v_n <> 1 then
    raise exception '[034-test §5] forward-direction invalidation should update 1 row, updated %', v_n;
  end if;

  -- Restore for later sections.
  perform public.upsert_memory_edges(jsonb_build_array(
    jsonb_build_object('source_id','00000000-0000-4000-9000-000000000001',
                       'target_id','00000000-0000-4000-9000-000000000007',
                       'predicate','caused_by','weight',0.9)));
end $$;

-- ════════════════════════════════════════════════════════════════════════════
-- 6. The supersession sweep is as narrow as it claims
-- ════════════════════════════════════════════════════════════════════════════
do $$
declare
  v_n int;
begin
  v_n := public.memory_invalidate_superseded_edges('00000000-0000-4000-9000-000000000001');

  -- Exactly the one outbound `contradicts` edge.
  if v_n <> 1 then
    raise exception '[034-test §6] sweep touched % edges; expected exactly the 1 outbound contradicts', v_n;
  end if;
  if (select invalid_at from public.memory_relationships
       where source_id='00000000-0000-4000-9000-000000000001'
         and target_id='00000000-0000-4000-9000-000000000004'
         and relationship_type='contradicts') is null then
    raise exception '[034-test §6] the outbound contradicts edge was not retracted';
  end if;

  -- Everything else the memory participates in survives. Retracting relates_to
  -- on supersession would be a mass-invalidation event on the real corpus.
  if (select invalid_at from public.memory_relationships
       where source_id='00000000-0000-4000-9000-000000000001'
         and target_id='00000000-0000-4000-9000-000000000004'
         and relationship_type='relates_to') is not null then
    raise exception '[034-test §6] the sweep retracted a relates_to edge';
  end if;
  if (select invalid_at from public.memory_relationships
       where source_id='00000000-0000-4000-9000-000000000001'
         and target_id='00000000-0000-4000-9000-000000000005'
         and relationship_type='supersedes') is not null then
    raise exception '[034-test §6] the sweep broke the supersedes provenance chain';
  end if;
  if (select invalid_at from public.memory_relationships
       where source_id='00000000-0000-4000-9000-000000000001'
         and target_id='00000000-0000-4000-9000-000000000002'
         and relationship_type='fixed_by') is not null then
    raise exception '[034-test §6] the sweep retracted a fixed_by edge';
  end if;

  -- Idempotent.
  if public.memory_invalidate_superseded_edges('00000000-0000-4000-9000-000000000001') <> 0 then
    raise exception '[034-test §6] repeat sweep was not a no-op';
  end if;
end $$;

-- ════════════════════════════════════════════════════════════════════════════
-- 7. upsert_memory_entities
-- ════════════════════════════════════════════════════════════════════════════
do $$
declare
  v_res jsonb;
  v_id  uuid;
  v_n   int;
begin
  v_res := public.upsert_memory_entities(
    '00000000-0000-4000-9000-000000000001',
    jsonb_build_array(
      jsonb_build_object('name','  Migrations/034_Graph_Layer.SQL  ', 'type','file',
                         'aliases', jsonb_build_array('034')),
      jsonb_build_object('name','err-pg-permission-denied', 'type','problem_class'),
      jsonb_build_object('name','bad', 'type','not_a_real_entity_type'),
      jsonb_build_object('name','   ', 'type','file')
    ));

  if (v_res->>'created')::int <> 2 then
    raise exception '[034-test §7] expected 2 created entities, got % (%)', v_res->>'created', v_res;
  end if;
  if (v_res->>'linked')::int <> 2 then
    raise exception '[034-test §7] expected 2 mention links, got % (%)', v_res->>'linked', v_res;
  end if;
  if (v_res->>'dropped')::int <> 2 then
    raise exception '[034-test §7] expected 2 dropped entities, got % (%)', v_res->>'dropped', v_res;
  end if;

  -- Normalization is SERVER-SIDE: the key is lowercased and trimmed, the
  -- display name keeps its original form (minus surrounding whitespace).
  select id into v_id from public.memory_entities
   where entity_type='file' and entity_key='migrations/034_graph_layer.sql';
  if v_id is null then
    raise exception '[034-test §7] entity_key was not normalized to lower(btrim(name))';
  end if;
  if (select display_name from public.memory_entities where id = v_id)
       <> 'Migrations/034_Graph_Layer.SQL' then
    raise exception '[034-test §7] display_name should keep the surface form as first seen';
  end if;

  -- Re-extracting the same memory is idempotent: no duplicate mention, and
  -- mention_count does not inflate.
  v_res := public.upsert_memory_entities(
    '00000000-0000-4000-9000-000000000001',
    jsonb_build_array(
      jsonb_build_object('name','migrations/034_graph_layer.sql', 'type','file')));
  if (v_res->>'linked')::int <> 0 then
    raise exception '[034-test §7] re-extraction created a duplicate mention (linked=%)', v_res->>'linked';
  end if;
  select mention_count into v_n from public.memory_entities where id = v_id;
  if v_n <> 1 then
    raise exception '[034-test §7] mention_count inflated to % on re-extraction', v_n;
  end if;
  if (select count(*) from public.memory_entity_mentions where entity_id = v_id) <> 1 then
    raise exception '[034-test §7] duplicate mention row created';
  end if;

  -- A different memory mentioning the same entity converges on ONE row — the
  -- property the entity layer exists to provide.
  perform public.upsert_memory_entities(
    '00000000-0000-4000-9000-000000000002',
    jsonb_build_array(jsonb_build_object('name','MIGRATIONS/034_graph_layer.sql','type','file')));
  if (select count(*) from public.memory_entities
       where entity_type='file' and entity_key='migrations/034_graph_layer.sql') <> 1 then
    raise exception '[034-test §7] the same entity split into multiple canonical rows';
  end if;
  if (select count(*) from public.memory_entity_mentions where entity_id = v_id) <> 2 then
    raise exception '[034-test §7] the second memory''s mention was not linked to the shared entity';
  end if;

  -- A missing memory drops the batch instead of half-writing.
  v_res := public.upsert_memory_entities(
    '00000000-0000-4000-9000-0000000000ff',
    jsonb_build_array(jsonb_build_object('name','ghost','type','file')));
  if (v_res->>'dropped')::int <> 1 or (v_res->>'created')::int <> 0 then
    raise exception '[034-test §7] a batch for a nonexistent memory should drop entirely: %', v_res;
  end if;

  -- Degenerate input returns a result rather than raising.
  if (public.upsert_memory_entities(null, null)->>'created')::int <> 0 then
    raise exception '[034-test §7] null input should return a zeroed result, not raise';
  end if;
end $$;

-- ════════════════════════════════════════════════════════════════════════════
-- 8. mark_recall_cited_group — and the label actually reaching fit-platt
-- ════════════════════════════════════════════════════════════════════════════
do $$
declare
  v_group   uuid := '00000000-0000-4000-a000-000000000001';
  v_graph   uuid := '00000000-0000-4000-a000-000000000002';
  v_n       int;
  v_first   timestamptz;
  v_second  timestamptz;
  v_positives int;
begin
  -- Five hits of one recall, on the `recall` surface with scores BELOW
  -- fit-platt's smoke floor, i.e. rows the fit will actually read.
  insert into public.memory_recall_log
    (memory_id, surface, score, rank, query_hash, recall_group_id, source_agent)
  values
    ('00000000-0000-4000-9000-000000000001','recall',0.031,1,'__t034__',v_group,null),
    ('00000000-0000-4000-9000-000000000002','recall',0.028,2,'__t034__',v_group,null),
    ('00000000-0000-4000-9000-000000000003','recall',0.025,3,'__t034__',v_group,null),
    ('00000000-0000-4000-9000-000000000004','recall',0.022,4,'__t034__',v_group,null),
    ('00000000-0000-4000-9000-000000000006','recall',0.019,5,'__t034__',v_group,null);

  -- Rank-narrowed citation: the agent used hits 1 and 3.
  v_n := public.mark_recall_cited_group(v_group, array[1,3], null, 'claude');
  if v_n <> 2 then
    raise exception '[034-test §8] expected 2 cited rows, got %', v_n;
  end if;

  -- Idempotent in STATE and in RETURN VALUE — a repeat must not read as failure.
  v_n := public.mark_recall_cited_group(v_group, array[1,3], null, 'claude');
  if v_n <> 2 then
    raise exception '[034-test §8] repeat citation returned % instead of the same 2', v_n;
  end if;
  if (select count(*) from public.memory_recall_log
       where recall_group_id = v_group and cited) <> 2 then
    raise exception '[034-test §8] repeat citation changed how many rows are cited';
  end if;

  -- Only the named ranks.
  if exists (select 1 from public.memory_recall_log
              where recall_group_id = v_group and rank in (2,4,5) and cited) then
    raise exception '[034-test §8] narrowing by p_ranks leaked into un-named ranks';
  end if;

  -- SR-5: the WHOLE group is stamped resolved — the complement is what becomes
  -- an OBSERVED negative — and `dismissed` is left strictly alone.
  if (select count(*) from public.memory_recall_log
       where recall_group_id = v_group and group_resolved_at is not null) <> 5 then
    raise exception '[034-test §8/SR-5] group_resolved_at was not stamped on every row of the group';
  end if;
  if exists (select 1 from public.memory_recall_log
              where recall_group_id = v_group and dismissed) then
    raise exception '[034-test §8/SR-5] the complement was marked dismissed — observed-negative and explicit-rejection must stay separate';
  end if;
  select min(group_resolved_at) into v_first
    from public.memory_recall_log where recall_group_id = v_group;
  perform public.mark_recall_cited_group(v_group, array[2], null, null);
  select min(group_resolved_at) into v_second
    from public.memory_recall_log where recall_group_id = v_group;
  if v_second is distinct from v_first then
    raise exception '[034-test §8/SR-5] a later citation moved the first resolution time';
  end if;

  -- source_agent is filled only where NULL, never overwritten.
  if (select count(*) from public.memory_recall_log
       where recall_group_id = v_group and source_agent = 'claude') < 2 then
    raise exception '[034-test §8] source_agent was not filled on the cited rows';
  end if;
  perform public.mark_recall_cited_group(v_group, array[1], null, 'codex');
  if exists (select 1 from public.memory_recall_log
              where recall_group_id = v_group and rank = 1 and source_agent <> 'claude') then
    raise exception '[034-test §8] source_agent was OVERWRITTEN; it must only fill NULLs';
  end if;

  -- Honest zero for an unknown / stale group — what memory_cite reports back.
  if public.mark_recall_cited_group('00000000-0000-4000-a000-0000000000ff') <> 0 then
    raise exception '[034-test §8] an unknown group did not return 0';
  end if;
  if public.mark_recall_cited_group(null) <> 0 then
    raise exception '[034-test §8] a null group did not return 0';
  end if;
  -- ...and for a real group narrowed to a rank it does not contain.
  if public.mark_recall_cited_group(v_group, array[99]) <> 0 then
    raise exception '[034-test §8] narrowing to a nonexistent rank did not return 0';
  end if;

  -- THE ACCEPTANCE BAR: the citation is visible as a POSITIVE to the exact query
  -- scripts/calibration/fit-platt.ts runs (fit-platt.ts:201-215 — score not null,
  -- score < SMOKE_SCORE_FLOOR 0.4, surface not in EXCLUDED_SURFACES ['graph']).
  select count(*) into v_positives
    from public.memory_recall_log l
    left join public.memory_items m on m.id = l.memory_id
   where l.score is not null
     and l.score < 0.4
     and not (l.surface = any (array['graph']))
     and l.cited
     and l.query_hash = '__t034__';
  if v_positives < 3 then
    raise exception '[034-test §8] fit-platt would see % positives from this round-trip, expected >= 3', v_positives;
  end if;

  -- The documented trap, asserted so nobody rediscovers it in a fixture: a
  -- graph-surface citation succeeds at the RPC and is still invisible to the fit.
  insert into public.memory_recall_log
    (memory_id, surface, score, rank, query_hash, recall_group_id)
  values
    ('00000000-0000-4000-9000-000000000001','graph',0.91,1,'__t034_graph__',v_graph);
  if public.mark_recall_cited_group(v_graph) <> 1 then
    raise exception '[034-test §8] the RPC should honestly report citing the graph-surface row';
  end if;
  if exists (
    select 1 from public.memory_recall_log l
     where l.query_hash = '__t034_graph__'
       and l.score is not null and l.score < 0.4
       and not (l.surface = any (array['graph']))
  ) then
    raise exception '[034-test §8] a graph-surface row unexpectedly survived fit-platt''s filters';
  end if;
end $$;

-- ════════════════════════════════════════════════════════════════════════════
-- 8b. §2c — the solved-problem decay profile reaches category='debugging'
-- ════════════════════════════════════════════════════════════════════════════
-- The fix is a predicate inside a scoring expression, so the only honest proof
-- is a score comparison: the SAME row must score higher under 'solved-problem'
-- than under 'standard', and ONLY because of its category.
--
-- Row choice matters. A decision+debugging row would prove nothing — `decision`
-- already sits at the 365d tier, so the flattening is a no-op for it. The
-- observable population is the sub-365d tiers; `fact` (90d -> 365d) is both the
-- clearest and by far the largest slice of the real corpus (322 of the 324 rows
-- this fix newly protects).
-- A non-null embedding is REQUIRED for a fixture to be reachable at all: 033's
-- FULL-TEXT branch carries `and m.embedding is not null` (033:330) alongside the
-- vector branch's own guard (033:361), so a row without one is invisible to both
-- branches and therefore to the function. The value is irrelevant here — we call
-- with query_embedding = null, so the vector branch yields nothing and the
-- comparison is pure full-text — but it must exist.
create or replace function public.__t034_vec()
returns vector(1536)
language sql
immutable
set search_path = public, extensions, pg_catalog
as $$ select ('[1' || repeat(',0', 1535) || ']')::vector(1536); $$;

do $$
declare
  v_std    float;
  v_solved float;
  v_ctl_s  float;
  v_ctl_v  float;
begin
  -- An OLD fact-typed, debugging-category memory: exactly the shape that stayed
  -- buried under 033.
  insert into public.memory_items (id, content, embedding, source_type, category, project, created_at)
  values ('00000000-0000-4000-b000-000000000001',
          'zzqx decayprobe debugging memory about a resolved deadlock',
          public.__t034_vec(), 'fact', 'debugging', '__t034__', now() - interval '400 days');

  -- Control: identical age and content shape, but a category the profile must
  -- NOT touch. If BOTH rows move, the profile is flattening indiscriminately.
  insert into public.memory_items (id, content, embedding, source_type, category, project, created_at)
  values ('00000000-0000-4000-b000-000000000002',
          'zzqx decayprobe workflow memory about a resolved deadlock',
          public.__t034_vec(), 'fact', 'workflow', '__t034__', now() - interval '400 days');

  select score into v_std
    from public.memory_hybrid_search('zzqx decayprobe debugging', null, 20,
                                     1.0, 1.0, 60, null, null, 60, 'standard')
   where id = '00000000-0000-4000-b000-000000000001';
  select score into v_solved
    from public.memory_hybrid_search('zzqx decayprobe debugging', null, 20,
                                     1.0, 1.0, 60, null, null, 60, 'solved-problem')
   where id = '00000000-0000-4000-b000-000000000001';

  if v_std is null or v_solved is null then
    raise exception '[034-test §8b] the decay probe row was not returned by memory_hybrid_search (std=%, solved=%)',
      v_std, v_solved;
  end if;

  -- 400 days old: standard fact tier 90d gives 1/(1+400/90) ≈ 0.184;
  -- flattened to 365d gives 1/(1+400/365) ≈ 0.477. Materially higher, not noise.
  if v_solved <= v_std then
    raise exception '[034-test §8b] category=debugging did NOT get the flattened half-life: standard=% solved-problem=% (033''s defect is still present)',
      v_std, v_solved;
  end if;
  if v_solved / v_std < 2.0 then
    raise exception '[034-test §8b] flattening moved the score by only %x; expected ~2.6x for a 400-day fact row (90d -> 365d)',
      round((v_solved / v_std)::numeric, 3);
  end if;

  -- The control row must be IDENTICAL across profiles — proof that the profile
  -- keys on category and has not simply become a blanket age discount.
  select score into v_ctl_s
    from public.memory_hybrid_search('zzqx decayprobe workflow', null, 20,
                                     1.0, 1.0, 60, null, null, 60, 'standard')
   where id = '00000000-0000-4000-b000-000000000002';
  select score into v_ctl_v
    from public.memory_hybrid_search('zzqx decayprobe workflow', null, 20,
                                     1.0, 1.0, 60, null, null, 60, 'solved-problem')
   where id = '00000000-0000-4000-b000-000000000002';
  if v_ctl_s is null or v_ctl_v is null then
    raise exception '[034-test §8b] the control row was not returned (std=%, solved=%)', v_ctl_s, v_ctl_v;
  end if;
  -- Both captures see different now() values, so allow a clock-drift epsilon
  -- rather than demanding bitwise equality (033b uses the same reasoning).
  if abs(v_ctl_v - v_ctl_s) > 1e-9 then
    raise exception '[034-test §8b] a non-debugging row changed across profiles (% -> %) — the profile is flattening indiscriminately',
      v_ctl_s, v_ctl_v;
  end if;

  -- The dead arms really are gone from the shipped body.
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname='public' and p.proname='memory_hybrid_search'
       and (p.prosrc like '%when ''debugging''%' or p.prosrc like '%when ''convention''%')
  ) then
    raise exception '[034-test §8b] a dead source_type arm survives in memory_hybrid_search';
  end if;

  -- ...and neither value was ever a legal source_type, which is why they were
  -- unreachable. This is T4's clean reproduction target, asserted rather than
  -- described.
  if exists (select 1 from public.memory_items
              where source_type in ('debugging','convention')) then
    raise exception '[034-test §8b] a row carries source_type debugging/convention — the CHECK is not in force';
  end if;
  begin
    insert into public.memory_items (id, content, source_type, project)
    values ('00000000-0000-4000-b000-0000000000ff', 'illegal', 'debugging', '__t034__');
    raise exception '[034-test §8b] source_type=''debugging'' was ACCEPTED — 028''s CHECK is gone, and 033''s arms were reachable after all';
  exception
    when check_violation then null;   -- expected: the arms were dead by construction
  end;

  -- Lockstep: the explain sibling still delegates at the same 10-arg shape.
  if (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
       where n.nspname='public' and p.proname='memory_hybrid_search_explain') <> 1 then
    raise exception '[034-test §8b] memory_hybrid_search_explain is no longer a single 10-arg overload';
  end if;
end $$;

-- ════════════════════════════════════════════════════════════════════════════
-- 9. Five hygiene gates — re-checked independently of the migration's receipt
-- ════════════════════════════════════════════════════════════════════════════
do $$
declare
  fn   text;
  tbl  text;
  v_oid oid;
  v_cfg text;
begin
  foreach fn in array array['memory_invalidate_edge','memory_invalidate_edges',
                            'memory_invalidate_superseded_edges','upsert_memory_edges',
                            'mark_recall_cited_group','upsert_memory_entities',
                            'memory_expand_typed','expand_memory_neighborhood',
                            -- §2c replaced these two; a replace that leaked
                            -- EXECUTE would be invisible without checking here.
                            'memory_hybrid_search','memory_hybrid_search_explain']
  loop
    if (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
         where n.nspname='public' and p.proname=fn) <> 1 then
      raise exception '[034-test §9] % does not have exactly one overload', fn;
    end if;
    select p.oid, array_to_string(p.proconfig,'; ') into v_oid, v_cfg
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace
     where n.nspname='public' and p.proname=fn;
    if has_function_privilege('anon', v_oid, 'EXECUTE')
       or has_function_privilege('authenticated', v_oid, 'EXECUTE')
       or has_function_privilege('public', v_oid, 'EXECUTE') then
      raise exception '[034-test §9 GATE 3] % is executable by anon/authenticated/public', fn;
    end if;
    if not has_function_privilege('service_role', v_oid, 'EXECUTE') then
      raise exception '[034-test §9 GATE 3] service_role lost EXECUTE on %', fn;
    end if;
    if v_cfg is null or v_cfg not like '%search_path=%' then
      raise exception '[034-test §9 GATE 4] % has no pinned search_path', fn;
    end if;
  end loop;

  foreach tbl in array array['memory_relationship_types','memory_entity_types',
                             'memory_entities','memory_entity_mentions']
  loop
    if not exists (select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
                    where n.nspname='public' and c.relname=tbl and c.relrowsecurity) then
      raise exception '[034-test §9 GATE 1] RLS not enabled on %', tbl;
    end if;
    if exists (select 1 from pg_policies where schemaname='public' and tablename=tbl) then
      raise exception '[034-test §9 GATE 2] % has policies; expected none', tbl;
    end if;
    if has_table_privilege('anon','public.'||tbl,'SELECT')
       or has_table_privilege('anon','public.'||tbl,'INSERT') then
      raise exception '[034-test §9 GATE 5] anon retains privileges on %', tbl;
    end if;
  end loop;
end $$;

-- ════════════════════════════════════════════════════════════════════════════
-- 10. Cleanup — scoped to the sentinel project and the __t034_ prefix.
-- ════════════════════════════════════════════════════════════════════════════

-- Mentions and edges cascade from memory_items; entities do not (they are
-- corpus-level), so remove the two this file created by key.
delete from public.memory_entities
 where entity_type = 'file' and entity_key = 'migrations/034_graph_layer.sql';
delete from public.memory_entities
 where entity_type = 'problem_class' and entity_key = 'err-pg-permission-denied';

delete from public.memory_recall_log where query_hash in ('__t034__', '__t034_graph__');
delete from public.memory_items      where project = '__t034__';

-- The adopted fixture predicate: only removable once its edges are gone (which
-- the cascade above just did), which is itself the FK behaving as designed.
delete from public.memory_relationship_types where type = 'legacy_exotic_link';

drop table    if exists public.__t034_baseline;
drop table    if exists public.__t034_counts;
drop function if exists public.__t034_vec();

analyze public.memory_relationships;

\echo '[034-test] 034b complete: legacy survival + unknown-vocabulary adoption, history-preserving backfill, drop-invalid batch upsert, REQ-1 expansion semantics (a)-(h), invalidate-don''t-delete + resurrection, narrow supersession sweep, entity convergence, citation idempotency + observed negatives + fit-platt visibility, and the five gates — all verified.'

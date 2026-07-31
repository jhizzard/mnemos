/**
 * Mnestra — migration 033 static hygiene assertions (Sprint 82 T1)
 *
 * Pins the two-phase query shape, the new FTS GIN index, the frozen 10-arg
 * signature + semantic_similarity output column, the decay-profile table, the
 * five RLS gates and the apply-time receipt — all without a database.
 *
 * The database-backed half lives in tests/sql/033a_seed_and_baseline.sql +
 * tests/sql/033b_verify.sql and runs in CI against pgvector/pgvector:pg16,
 * where it can assert on real EXPLAIN plans. The last test in this file is the
 * seam between the two: 033b explains hand-written COPIES of the branch shapes
 * (EXPLAIN over a non-inlinable function reveals nothing about its body), so
 * these assertions pin the tokens that make those copies faithful. If someone
 * changes the migration's query shape, this fails rather than letting CI keep
 * cheerfully explaining a shape the function no longer uses.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const MIGRATION_PATH = path.join(
  REPO_ROOT,
  'migrations',
  '033_two_phase_hybrid_search.sql'
);

const sql = fs.readFileSync(MIGRATION_PATH, 'utf8');
const lower = sql.toLowerCase();
/** Comment-stripped, for assertions that must not be satisfied by prose. */
const effective = sql
  .split('\n')
  .map((line) => line.replace(/--.*$/, ''))
  .join('\n')
  .toLowerCase();
/** Comment-stripped AND whitespace-collapsed, for multi-line SQL fragments. */
const squashed = effective.replace(/\s+/g, ' ');

test('creates the FTS GIN index the rewrite depends on (the index that never existed)', () => {
  // Two-arg to_tsvector with a literal config — the one-arg form is only
  // STABLE and would be rejected as an index expression.
  assert.match(
    squashed,
    /create index if not exists memory_items_content_fts_gin on public\.memory_items using gin \(to_tsvector\('english', content\)\)/
  );
  // CONCURRENTLY cannot run inside the bundled runner's transaction.
  assert.ok(
    !/create index concurrently/.test(effective),
    'CREATE INDEX CONCURRENTLY is illegal inside the migration runner transaction'
  );
});

test('full-text branch is index-servable: @@ prefilter + inner ORDER BY … LIMIT', () => {
  // The @@ predicate is what the GIN index answers. Spelled with the same
  // two-arg to_tsvector as the index expression, or the planner stops matching.
  assert.match(
    squashed,
    /and to_tsvector\('english', m\.content\) @@ plainto_tsquery\('english', query_text\)/
  );
  // The LIMIT must be INSIDE the subquery; a window function over the whole
  // match set before limiting would re-introduce the full sort.
  assert.match(squashed, /order by ft_rank desc nulls last, m\.id limit least\(/);
  // 032's whole-corpus filter must be gone.
  assert.ok(
    !/where ft_rank > 0/.test(effective),
    "032's post-hoc `where ft_rank > 0` filter should be replaced by the @@ prefilter"
  );
});

test('creates the partial HNSW index matching the vector branch predicates', () => {
  // 001's HNSW index is unqualified, so a filtered ORDER BY … LIMIT can only use
  // it with a residual filter, and 005's memory_items_source_type_idx_v2 (partial
  // on exactly is_active + archived) gives the planner a bitmap+sort alternative
  // it will happily take. The partial HNSW index makes the ordered index scan
  // available with no recheck. Its predicate must remain a SUBSET of the branch's
  // WHERE clause or the planner cannot prove the implication and stops matching.
  assert.match(
    squashed,
    /create index if not exists memory_items_embedding_hnsw_live_idx on public\.memory_items using hnsw \(embedding vector_cosine_ops\) where is_active = true and archived = false and superseded_by is null/
  );
  // Every predicate in the index must also be applied by the vector branch.
  const vecBranch = squashed.match(/vec_branch as materialized \((.*?)\) t \)/);
  assert.ok(vecBranch, 'vector branch not found');
  for (const pred of [
    'm.is_active = true',
    'm.archived = false',
    'm.superseded_by is null',
  ]) {
    assert.ok(
      vecBranch[1]!.includes(pred),
      `vector branch must apply "${pred}" or the partial HNSW index is unusable`
    );
  }
});

test('vector branch is index-servable: bare distance ORDER BY … LIMIT, no extra sort key', () => {
  // pgvector's HNSW AM can satisfy an ordering on `<=>` alone. A secondary sort
  // key here would force a sort the index cannot provide and cost the scan —
  // the deterministic tiebreak lives in the row_number() window instead.
  assert.match(
    squashed,
    /order by m\.embedding <=> query_embedding limit least\(/
  );
  assert.ok(
    !/order by m\.embedding <=> query_embedding, m\.id/.test(squashed),
    'the vector branch inner ORDER BY must not carry a secondary key'
  );
  // ef_search default (40) is below the default branch limit (60), so an
  // unpinned scan would silently under-retrieve.
  assert.match(lower, /set hnsw\.ef_search = '\d+'/);
});

test('branch CTEs are MATERIALIZED so the LIMITs cannot be inlined away', () => {
  assert.match(squashed, /with ft_branch as materialized \(/);
  assert.match(squashed, /vec_branch as materialized \(/);
});

test('frozen signature: the 8 existing args plus p_branch_limit and p_decay_profile', () => {
  assert.match(lower, /create or replace function public\.memory_hybrid_search \(/);
  assert.match(lower, /query_embedding\s+vector\(1536\)/);
  assert.match(lower, /filter_source_type\s+text default null/);
  assert.match(lower, /p_branch_limit\s+int default 60/);
  assert.match(lower, /p_decay_profile\s+text default 'standard'/);
  // Both new params defaulted → every existing 8-arg call site still resolves.
  assert.match(lower, /set search_path = public, extensions, pg_catalog/);
});

test('RETURNS TABLE gains semantic_similarity and keeps privacy_tags (023)', () => {
  const returns = squashed.match(/returns table \((.*?)\) language sql/);
  assert.ok(returns, 'memory_hybrid_search RETURNS TABLE not found');
  const cols = returns[1]!;
  assert.match(cols, /privacy_tags text\[\]/, 'migration 023 column must survive');
  assert.match(cols, /semantic_similarity double precision/);
  // Appended LAST, so positional consumers of the 9 existing columns are safe.
  assert.ok(
    cols.trimEnd().endsWith('semantic_similarity double precision'),
    'semantic_similarity must be the final column'
  );
});

test('the cosine is returned, not discarded (defect D3), and recomputed for FTS-only rows', () => {
  // Computed in the enriched CTE — i.e. over the fused set, which is what makes
  // it available for rows the vector branch never saw.
  assert.match(
    squashed,
    /when query_embedding is null then null::double precision else \(1 - \(m\.embedding <=> query_embedding\)\)::double precision end as semantic_similarity/
  );
});

test('decay table: 032 constants preserved, solved-problem lifts ONLY bug_fix + debugging', () => {
  const decay = squashed.match(/case e\.source_type when 'decision' then 365\.0(.*?)end \* 86400\.0/);
  assert.ok(decay, 'decay-constant CASE not found');
  const body = decay[1]!;
  // Every 032 half-life, unchanged.
  for (const [type, days] of [
    ['architecture', '365.0'],
    ['preference', '365.0'],
    ['doctrine', '365.0'],
    ['fact', '90.0'],
    ['convention', '90.0'],
    ['session_summary', '14.0'],
    ['document_chunk', '14.0'],
    ['code_context', '14.0'],
  ] as const) {
    assert.match(
      body,
      new RegExp(`when '${type}' then\\s+${days.replace('.', '\\.')}`),
      `${type} half-life must stay ${days} days`
    );
  }
  assert.match(body, /else 30\.0 end/, 'the unknown-source_type fallback stays 30 days');

  // The profile switch applies to exactly two source types.
  const switches = body.match(
    /when coalesce\(p_decay_profile, 'standard'\) = 'solved-problem' then 365\.0 else 30\.0 end/g
  );
  assert.equal(switches?.length, 2, 'exactly two types may consult p_decay_profile');
  assert.match(body, /when 'bug_fix' then case when coalesce\(p_decay_profile/);
  assert.match(body, /when 'debugging' then case when coalesce\(p_decay_profile/);
});

test('an unknown or NULL p_decay_profile degrades to standard rather than raising', () => {
  // coalesce(...) = 'solved-problem' is false for NULL and for any typo, and
  // there is no error path on the parameter at all.
  assert.ok(
    !/p_decay_profile[^\n]*raise/.test(effective),
    'p_decay_profile must never raise'
  );
  assert.match(squashed, /coalesce\(p_decay_profile, 'standard'\)/);
});

test('the other three ranking factors are carried over from 032 unchanged', () => {
  // Type weights.
  assert.match(squashed, /when 'decision' then 1\.5 when 'doctrine' then 1\.5 when 'architecture' then 1\.4 when 'bug_fix' then 1\.3 when 'preference' then 1\.2 when 'fact' then 1\.0 when 'document_chunk' then 0\.6/);
  // Project affinity.
  assert.match(squashed, /when filter_project is null then 1\.0 when e\.project = filter_project then 1\.5 when e\.project = 'global' then 1\.0 else 0\.7/);
  // Sprint 81 recall_boost: bounded, strict no-op at 1.0.
  assert.match(
    squashed,
    /least\(greatest\(coalesce\(e\.recall_boost, 1\.0\), 1\.0\), 2\.0\)\)::double precision/
  );
  // The match_count cap from 004.
  assert.match(
    squashed,
    /limit least\( greatest\(match_count, 1\), coalesce\(nullif\(current_setting\('mnestra\.max_match_count', true\), ''\)::int, 200\) \)/
  );
});

test('p_branch_limit is clamped up to match_count and capped', () => {
  const clamps = squashed.match(
    /limit least\( greatest\(coalesce\(p_branch_limit, 60\), greatest\(match_count, 1\)\), 500 \)/g
  );
  assert.equal(clamps?.length, 2, 'both branches clamp identically');
});

test('overload-drop guard runs for BOTH functions (return-type change + new overload)', () => {
  for (const fn of ['memory_hybrid_search', 'memory_hybrid_search_explain']) {
    assert.match(
      squashed,
      new RegExp(`select p\\.oid::regprocedure as sig from pg_proc p join pg_namespace n on n\\.oid = p\\.pronamespace where p\\.proname = '${fn}'`),
      `${fn} needs its overloads dropped or 8-arg calls become ambiguous`
    );
  }
  assert.match(squashed, /execute 'drop function ' \|\| r\.sig::text/);
});

test('GATE 3: the post-drop re-pin covers BOTH functions', () => {
  // A DROP loses grants and a new function defaults to EXECUTE for PUBLIC —
  // 019 revoked the explain sibling historically, and 033 must not undo that.
  assert.match(
    squashed,
    /foreach fn in array array\['memory_hybrid_search', 'memory_hybrid_search_explain'\]/
  );
  assert.match(squashed, /revoke execute on function %s from public, anon, authenticated/);
  assert.match(squashed, /grant execute on function %s to service_role/);
});

test('GATES 2 + 5: no policies, no WITH CHECK (true), no SECURITY DEFINER, no write surface', () => {
  assert.ok(!/create\s+policy/.test(effective), '033 introduces no policies');
  assert.ok(!/with\s+check\s*\(\s*true\s*\)/.test(effective), 'no WITH CHECK (true)');

  // Scoped to each CREATE FUNCTION's header — the span between the signature
  // and its `as $$` body delimiter, which is the only place the attribute can
  // legally appear. A bare substring search would match the receipt's own
  // 'GATE 5 VIOLATION: … is SECURITY DEFINER' message, i.e. the guard against
  // the thing would be mistaken for the thing.
  const headers = squashed.match(/create or replace function .*?(?= as \$\$)/g) ?? [];
  assert.ok(headers.length >= 2, 'expected both 033 function definitions');
  for (const header of headers) {
    assert.ok(
      !/security definer/.test(header),
      `both 033 functions are read-only and must stay SECURITY INVOKER: ${header.slice(0, 80)}…`
    );
  }
  for (const write of [/\binsert\s+into\b/, /\bupdate\s+public\./, /\bdelete\s+from\b/]) {
    assert.ok(!write.test(effective), `033 adds no write surface (matched ${write})`);
  }
});

test('receipt is OID-form and hard-fails on every gate it checks', () => {
  assert.match(squashed, /where n\.nspname = 'public' and p\.proname = 'memory_hybrid_search'/);
  assert.match(lower, /has_function_privilege\('service_role', {2}v_oid/);
  assert.match(lower, /pg_get_function_result\(v_oid\)/);
  for (const expected of [
    'INDEX MISSING: memory_items_content_fts_gin',
    'INDEX MISSING: memory_items_embedding_hnsw_idx',
    'RETURNS TABLE missing semantic_similarity',
    'must take 10 args',
    'ambiguous-overload hazard',
    'GATE 1 VIOLATION',
    'GATE 3 VIOLATION',
    'GATE 4 VIOLATION',
    'GATE 5 VIOLATION',
  ]) {
    assert.ok(sql.includes(expected), `receipt must be able to raise: ${expected}`);
  }
});

test('the CI behavioral test explains the shapes the migration actually uses', () => {
  // 033b_verify.sql explains hand-written copies of the two branch shapes,
  // because EXPLAIN over a non-inlinable function reports only "Function Scan".
  // That copy is the one drift risk in the DB-backed test; this pins it.
  const verify = fs
    .readFileSync(path.join(REPO_ROOT, 'tests', 'sql', '033b_verify.sql'), 'utf8')
    .toLowerCase()
    .replace(/\s+/g, ' ');

  // The AFTER shapes it explains must be the shapes the migration ships.
  assert.match(
    verify,
    /and to_tsvector\('english', m\.content\) @@ plainto_tsquery\('english', %l\)/,
    'the explained full-text shape must carry the @@ prefilter'
  );
  assert.match(
    verify,
    /order by m\.embedding <=> %l::vector\(1536\) limit 60/,
    'the explained vector shape must be a bare distance ORDER BY … LIMIT'
  );
  // And it must assert on the index names this migration depends on.
  for (const idx of [
    'memory_items_content_fts_gin',
    'memory_items_embedding_hnsw_live_idx',
  ]) {
    assert.ok(lower.includes(idx), `033 must reference ${idx}`);
  }
  assert.ok(verify.includes('memory_items_content_fts_gin'), '033b must assert on the FTS index');

  // The vector check must test SERVABILITY (can an HNSW index answer this
  // ordering at all — the property 032 lacked), not planner CHOICE on a toy
  // corpus. Asserting choice is what failed on a clean database: at 1212 rows a
  // bitmap scan + distance sort is genuinely cheaper and the planner is right to
  // pick it. enable_sort=off is what makes the servability question answerable.
  assert.match(verify, /enable_sort', 'off'/, 'servability check must disable sorting');
  assert.match(
    verify,
    /servability failed/i,
    'the vector assertion must be framed as servability'
  );
  // Matching a prefix, not a specific index: which of the two HNSW indexes wins
  // is a cost decision; that one is reachable is the claim.
  assert.ok(
    verify.includes("like '%memory_items_embedding_hnsw%'"),
    'the vector plan assertion must accept either HNSW index'
  );
  // The unconstrained plan must be recorded but NOT asserted.
  // NB: `verify` is lower-cased above, so this pattern is deliberately lower-case.
  assert.match(verify, /not asserted/, 'the observed planner choice must be explicitly non-asserted');
  // The seed script must refuse to run outside the throwaway CI database.
  const seed = fs.readFileSync(
    path.join(REPO_ROOT, 'tests', 'sql', '033a_seed_and_baseline.sql'),
    'utf8'
  );
  assert.match(
    seed,
    /current_database\(\) <> 'mnestra_test'/,
    'the seeding script must be gated to the throwaway test database'
  );
});

test('the equivalence test asserts rank order exactly and derives its score tolerance', () => {
  // Scores depend on now() via the recency decay, and the baseline is captured
  // before migration 033 is applied while the comparison runs after — so a
  // hard-coded epsilon is wrong by construction. It failed for real at 1e-9 on
  // exactly the three shortest-half-life rows (T4, Sprint 82). Two invariants
  // must survive: rank order is compared with NO tolerance (that is the real
  // equivalence claim, and it is immune to drift), and every cross-capture
  // score comparison scales with measured elapsed time.
  const verify = fs.readFileSync(
    path.join(REPO_ROOT, 'tests', 'sql', '033b_verify.sql'),
    'utf8'
  );

  assert.match(
    verify.replace(/\s+/g, ' '),
    /row_number\(\) over \(order by score desc, id\) as pos from public\.__t033_baseline/,
    'rank order must be compared position-by-position, not inferred from scores'
  );
  assert.match(verify, /where b\.pos <> n\.pos/, 'exact positional comparison, zero tolerance');

  // Every capture that is later compared must be timestamped.
  const captures = verify.match(/create table public\.__t033_\w+ as/g) ?? [];
  assert.ok(captures.length >= 3, `expected ≥3 result captures, found ${captures.length}`);
  assert.equal(
    (verify.match(/now\(\) as captured_at/g) ?? []).length,
    captures.length,
    'every result capture must record now() so drift can be measured'
  );
  assert.match(
    fs.readFileSync(path.join(REPO_ROOT, 'tests', 'sql', '033a_seed_and_baseline.sql'), 'utf8'),
    /now\(\) as captured_at/,
    'the 033a baseline must record its capture time too'
  );

  // No bare epsilon may remain in a CROSS-CAPTURE score comparison (`a.score -
  // b.score`), since those are the ones the clock moves. Comparisons of a cosine
  // against a literal (§ 2, § 3) are time-invariant and correctly use a fixed
  // epsilon — pgvector's float4 element storage, not elapsed time.
  const crossCapture = [
    ...verify.matchAll(/abs\([\w.]+\.score - [\w.]+\.score\) > ([^\s;)]+)/g),
  ];
  assert.ok(crossCapture.length >= 3, `expected ≥3 cross-capture score checks, found ${crossCapture.length}`);
  for (const [, expr] of crossCapture) {
    assert.match(
      expr,
      /v_tol|public\.__t033_tol/,
      `cross-capture score comparison must use the derived tolerance, found hard-coded ${expr}`
    );
  }
  // And the derivation must be stated, not asserted by fiat.
  assert.match(verify, /SENSITIVITY_BOUND/, 'the per-second bound must be named');
  assert.match(verify, /6\.099e-8/, 'the derived constant must be present');
});

test('every fixture source_type is legal under the 028 CHECK constraint', () => {
  // A fixture row carrying a source_type outside memory_items_source_type_check
  // fails at INSERT and takes the entire CI job down before a single assertion
  // runs — so the DB-backed suite would be red for a reason that has nothing to
  // do with migration 033. Caught once for real (T4, Sprint 82: 'debugging' and
  // 'convention' are Category values, not SourceType values). The permitted set
  // is parsed out of 028 rather than restated here, so extending the constraint
  // in a later migration widens this guard automatically.
  const capture = fs.readFileSync(
    path.join(REPO_ROOT, 'migrations', '028_capture_gates.sql'),
    'utf8'
  );
  const check = capture.match(
    /add constraint memory_items_source_type_check\s+check \(source_type = any \(array\[([\s\S]*?)\]\)\)/i
  );
  assert.ok(check, 'could not locate the source_type CHECK in migration 028');
  const allowed = new Set(
    [...check[1]!.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!)
  );
  assert.ok(allowed.has('fact') && allowed.has('doctrine'), 'parsed an implausible allow-list');

  const seedSql = fs.readFileSync(
    path.join(REPO_ROOT, 'tests', 'sql', '033a_seed_and_baseline.sql'),
    'utf8'
  );
  // Both shapes the fixture uses: the literal 6th VALUES column, and the
  // array[...] the bulk generator indexes into.
  const used = new Set<string>();
  for (const m of seedSql.matchAll(
    /public\.__t033_mk_vec\([^)]*\),\s*'([a-z_]+)'/g
  )) {
    used.add(m[1]!);
  }
  const bulkArray = seedSql.match(/\(array\[([^\]]*)\]\)\[1 \+ \(i % \d+\)\]/);
  assert.ok(bulkArray, 'bulk-fixture source_type array not found');
  for (const m of bulkArray[1]!.matchAll(/'([a-z_]+)'/g)) used.add(m[1]!);

  assert.ok(used.size >= 8, `expected a varied fixture, found ${used.size} source_types`);
  const illegal = [...used].filter((t) => !allowed.has(t));
  assert.deepEqual(
    illegal,
    [],
    `fixture source_type(s) rejected by memory_items_source_type_check: ${illegal.join(', ')}. Permitted: ${[...allowed].join(', ')}`
  );
});

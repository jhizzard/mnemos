/**
 * Mnestra — migration 034 static hygiene assertions (Sprint 83 T1)
 *
 * Pins the frozen SCHEMA-READY-2 surface without a database: the exact RPC
 * signatures T2/T3 code against, the five RLS gates, the invalidate-don't-delete
 * invariant, the proconfig traps, and the §2c decay repair.
 *
 * The database-backed half lives in tests/sql/034a_seed_legacy_edges.sql +
 * tests/sql/034b_verify.sql and runs in CI against pgvector/pgvector:pg16, where
 * it can execute the functions and compare real scores. The split is the same as
 * 033's: behaviour belongs in SQL where it can be run; what belongs HERE is
 * everything whose failure mode is "somebody edited the migration and nothing
 * noticed" — signatures other lanes bind to by name, and hygiene clauses whose
 * absence is invisible until an advisor sweep months later.
 *
 * The single most valuable assertion in this file is the DELETE fence: 034's
 * whole thesis is invalidate-don't-delete, and a future edit that adds a DELETE
 * to an edge path would pass every behavioural test that does not happen to
 * check row counts.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// Two levels: these run compiled from dist-tests/tests/, not from tests/.
const REPO_ROOT = path.resolve(HERE, '..', '..');
const MIGRATION_PATH = path.join(REPO_ROOT, 'migrations', '034_graph_layer.sql');

const sql = fs.readFileSync(MIGRATION_PATH, 'utf8');
/** Comment-stripped, so no assertion can be satisfied by prose. */
const effective = sql
  .split('\n')
  .map((line) => line.replace(/--.*$/, ''))
  .join('\n')
  .toLowerCase();
/** Comment-stripped AND whitespace-collapsed, for multi-line SQL fragments. */
const squashed = effective.replace(/\s+/g, ' ');

// ── The frozen RPC surface (SCHEMA-READY-2) ────────────────────────────────
//
// PostgREST binds RPC arguments by NAME, so a renamed parameter is a breaking
// change even when the types match. T2 and T3 wrote their clients against these
// exact names; these tests are what make "the surface is frozen" enforceable
// rather than a promise in a STATUS post.

test('memory_expand_typed carries T3 REQ-1 parameter names, in order', () => {
  assert.match(
    squashed,
    /create or replace function public\.memory_expand_typed\( p_seed_ids uuid\[\], p_predicates text\[\] default null, p_max_depth int default 1, p_max_rows int default 10, p_project text default null \)/
  );
});

test('memory_expand_typed returns all 14 REQ-1 columns', () => {
  for (const col of [
    'memory_id uuid', 'seed_id uuid', 'content text', 'source_type text',
    'project text', 'metadata jsonb', 'privacy_tags text\\[\\]',
    'created_at timestamptz', 'depth int', 'edge_type text',
    'edge_path text\\[\\]', 'direction text', 'edge_weight float', 'path uuid\\[\\]',
  ]) {
    assert.match(squashed, new RegExp(col), `missing return column: ${col}`);
  }
});

test('memory_expand_typed is STABLE and INVOKER — the structural read-only proof', () => {
  // REQ-1f: a STABLE function cannot execute INSERT/UPDATE/DELETE; Postgres
  // raises at runtime. That is a guarantee, where "we reviewed the body" is not.
  assert.match(squashed, /public\.memory_expand_typed\(.*?\).*?language sql stable security invoker/);
  assert.ok(
    !/create or replace function public\.memory_expand_typed[\s\S]*?language sql volatile/.test(effective),
    'memory_expand_typed must never be VOLATILE'
  );
});

test('memory_expand_typed traverses live edges only, with no opt-out flag', () => {
  assert.match(squashed, /and r\.invalid_at is null and \(r\.valid_at is null or r\.valid_at <= now\(\)\)/);
  // An include-invalidated parameter would eventually be passed by someone who
  // did not read why it should not exist.
  assert.ok(
    !/p_include_invalid/.test(effective),
    'no opt-in flag for traversing retracted edges'
  );
});

test('memory_expand_typed clamps depth and rows INSIDE the function', () => {
  assert.match(squashed, /w\.depth < least\(greatest\(coalesce\(p_max_depth, 1\), 1\), 2\)/);
  assert.match(squashed, /limit least\(greatest\(coalesce\(p_max_rows, 10\), 1\), 25\)/);
});

test('memory_expand_typed default predicate set is the four semantic roles', () => {
  assert.match(
    squashed,
    /coalesce\(p_predicates, array\['caused_by', 'fixed_by', 'supersedes', 'same_pattern_as'\]\)/
  );
});

test('citation RPC is group-keyed with SR-1 narrowing', () => {
  assert.match(
    squashed,
    /create or replace function public\.mark_recall_cited_group\( p_recall_group_id uuid, p_ranks int\[\] default null, p_memory_ids uuid\[\] default null, p_source_agent text default null \)/
  );
});

test('citation RPC returns a post-condition count, not row_count', () => {
  // Idempotent in return value as well as state: a repeat call must not report 0
  // and read like a failure. Guarded UPDATE, then a fresh count.
  assert.match(squashed, /set cited = true where recall_group_id = p_recall_group_id/);
  assert.match(squashed, /and cited = false;/);
  assert.match(squashed, /select count\(\*\) into v_cited/);
  assert.ok(
    !/get diagnostics v_cited = row_count/.test(effective),
    'the return must be the post-condition count, not the number of rows this call happened to flip'
  );
});

test('SR-5 stamps the whole group and never touches `dismissed`', () => {
  assert.match(squashed, /set group_resolved_at = now\(\) where recall_group_id = p_recall_group_id and group_resolved_at is null/);
  // Conflating observed-negative with explicit-rejection would corrupt an
  // existing signal to manufacture a new one.
  assert.ok(
    !/set dismissed = true/.test(effective),
    '034 must never write dismissed'
  );
});

test('source_agent is filled only where NULL', () => {
  assert.match(squashed, /set source_agent = p_source_agent where recall_group_id = p_recall_group_id.*?and source_agent is null/);
});

test('batch write RPCs carry the SR-2 / SR-3 signatures and return shapes', () => {
  assert.match(squashed, /create or replace function public\.upsert_memory_edges\(p_edges jsonb\) returns jsonb/);
  assert.match(squashed, /create or replace function public\.upsert_memory_entities\( p_memory_id uuid, p_entities jsonb \) returns jsonb/);
  for (const key of ['accepted', 'dropped', 'dropped_predicates']) {
    assert.match(squashed, new RegExp(`'${key}'`), `upsert_memory_edges must return ${key}`);
  }
  for (const key of ['entity_ids', 'created', 'linked', 'dropped']) {
    assert.match(squashed, new RegExp(`'${key}'`), `upsert_memory_entities must return ${key}`);
  }
});

test('the drop-invalid handlers catch DATA errors only — never a bare `when others`', () => {
  // The failure this prevents, from Sprint 83 itself: a draft of
  // upsert_memory_entities used an uncastable `0::xid` in its RETURNING clause,
  // and the blanket handler turned every valid entity into a clean `dropped`.
  // The batch reported success at every level while writing nothing. A broken
  // function must not be able to present as bad caller input.
  const bodies = sql.match(/create or replace function public\.upsert_memory_(edges|entities)[\s\S]*?\n\$\$;/g) ?? [];
  assert.equal(bodies.length, 2, 'expected both batch-write functions');
  for (const body of bodies) {
    const name = /function public\.(upsert_memory_\w+)/.exec(body)?.[1];
    assert.ok(
      !/exception\s+when\s+others/i.test(body),
      `${name} must not use a blanket \`when others\` handler`
    );
    // ...and it must still catch the data errors that are genuine input faults.
    assert.match(
      body.toLowerCase(),
      /exception when invalid_text_representation/,
      `${name} must still drop on malformed input`
    );
  }
});

test('upsert_memory_edges resurrects a previously invalidated edge', () => {
  // The hazard: src/relationships.ts upserts on the same unique tuple and sets
  // only weight/inferred_*, so a re-asserted edge would keep invalid_at and stay
  // invisible to every live-only traversal — silently, forever.
  assert.match(
    squashed,
    /on conflict \(source_id, target_id, relationship_type\) do update set invalid_at = null/
  );
});

// ── The invariant the whole migration rests on ─────────────────────────────

test('nothing in 034 DELETEs an edge or a memory', () => {
  const deletes = effective
    .split('\n')
    .map((l, i) => [i + 1, l] as const)
    .filter(([, l]) => /\bdelete\s+from\b/.test(l));
  assert.deepEqual(
    deletes.map(([n, l]) => `${n}: ${l.trim()}`),
    [],
    'invalidate-don\'t-delete: 034 must contain no DELETE. Retraction is invalid_at.'
  );
});

test('invalidation preserves the original retraction time', () => {
  // Re-invalidating an already-dead edge must not move invalid_at, or the
  // history the column exists to record is destroyed by an idempotent call.
  const invalidations = squashed.match(/set invalid_at = coalesce\(p_at, now\(\)\)[^;]*?;/g) ?? [];
  assert.ok(invalidations.length >= 3, `expected the three invalidation paths, found ${invalidations.length}`);
  for (const stmt of invalidations) {
    assert.match(stmt, /and invalid_at is null/, `unguarded invalidation would rewrite history: ${stmt}`);
  }
});

test('the supersession sweep is scoped to outbound contradicts only', () => {
  assert.match(
    squashed,
    /where source_id = p_superseded_id and relationship_type = 'contradicts' and invalid_at is null/
  );
  // A trigger would make a schema-level side effect out of an ordinary UPDATE
  // and fire on backfills nobody meant as supersessions.
  assert.ok(!/create trigger/.test(effective), '034 installs no triggers');
});

// ── Vocabulary as data, not as a CHECK ─────────────────────────────────────

test('relationship_type is governed by an FK to a lookup table, not a CHECK', () => {
  assert.match(
    squashed,
    /add constraint memory_relationships_relationship_type_fkey foreign key \(relationship_type\) references public\.memory_relationship_types \(type\)/
  );
  assert.ok(
    !/check \(relationship_type in \(/.test(effective) &&
      !/check \(relationship_type = any/.test(effective),
    'the vocabulary must not be re-introduced as a CHECK — that is the drift 034 removes'
  );
});

test('the vocabulary adopts values already in the table before adding the FK', () => {
  // This is what makes backward compatibility a property of the MECHANISM rather
  // than of the author's inventory being right. Without it, an install carrying
  // an unknown relationship_type fails at ADD CONSTRAINT.
  assert.match(
    squashed,
    /select distinct r\.relationship_type,.*?from public\.memory_relationships r/
  );
  const adoptIdx = squashed.indexOf('select distinct r.relationship_type');
  const fkIdx = squashed.indexOf('memory_relationships_relationship_type_fkey foreign key');
  assert.ok(adoptIdx > -1 && fkIdx > -1 && adoptIdx < fkIdx,
    'the adoption pass must run BEFORE the FK is added');
});

test('all 14 shipped predicates are seeded', () => {
  for (const p of [
    'supersedes', 'relates_to', 'contradicts', 'elaborates', 'caused_by', 'blocks',
    'inspired_by', 'cross_project_link', 'amends_rule', 'elevated_to',
    'same_pattern_as', 'fixed_by', 'documented_at', 'part_of',
  ]) {
    assert.match(squashed, new RegExp(`\\('${p}',`), `predicate not seeded: ${p}`);
  }
});

// ── §2c — the solved-problem decay repair ──────────────────────────────────

test('§2c keys the solved-problem arm on category, and drops the dead arms', () => {
  assert.match(
    squashed,
    /when coalesce\(p_decay_profile, 'standard'\) = 'solved-problem' and \(e\.source_type = 'bug_fix' or e\.category = 'debugging'\) then 365\.0/
  );
  // 'debugging' and 'convention' are Category values; 028's CHECK makes them
  // impossible as source_type, so these arms were unreachable by construction.
  assert.ok(!/when 'debugging'/.test(effective), "the dead source_type 'debugging' arm must be gone");
  assert.ok(!/when 'convention'/.test(effective), "the dead source_type 'convention' arm must be gone");
});

test('§2c replaces memory_hybrid_search at the SAME signature and restates BOTH SET clauses', () => {
  // CREATE OR REPLACE replaces proconfig wholesale. Omitting these would null
  // the GATE 4 pin AND 033's hnsw tuning in one statement.
  // Non-greedy `.*?` rather than `[^)]*`: the parameter list contains
  // `vector(1536)`, whose closing paren ends a negated-class match early.
  assert.match(
    squashed,
    /create or replace function public\.memory_hybrid_search \( query_text text, query_embedding vector\(1536\),.*?p_decay_profile text default 'standard' \) returns table/
  );
  assert.match(
    squashed,
    /language sql stable set search_path = public, extensions, pg_catalog set hnsw\.ef_search = '120'/
  );
  // A DROP would discard grants and re-open the PUBLIC-EXECUTE hole 033 §4 closed.
  assert.ok(
    !/drop function[^;]*memory_hybrid_search/.test(effective),
    '§2c must not DROP memory_hybrid_search — same-signature replace preserves grants'
  );
});

// ── The five RLS hygiene gates ─────────────────────────────────────────────

test('[GATE 1] RLS is enabled on every new table', () => {
  for (const t of [
    'memory_relationship_types', 'memory_entity_types',
    'memory_entities', 'memory_entity_mentions',
  ]) {
    assert.match(
      squashed,
      new RegExp(`alter table public\\.${t} enable row level security`),
      `RLS not enabled on ${t}`
    );
  }
});

test('[GATE 2] no policies, and no WITH CHECK (true) anywhere', () => {
  assert.ok(!/create policy/.test(effective), '034 must create no policies');
  assert.ok(!/with check \(true\)/.test(effective), 'the Studio "allow all" template must never appear');
});

test('[GATE 3] every function REVOKEs from public, anon, authenticated then grants service_role', () => {
  // Mandatory, not defensive: migration 014 sets ALTER DEFAULT PRIVILEGES
  // granting EXECUTE on new functions to anon AND authenticated, so a function
  // is anon-executable from the instant it exists until revoked.
  for (const fn of [
    'memory_invalidate_edge', 'memory_invalidate_edges',
    'memory_invalidate_superseded_edges', 'upsert_memory_edges',
    'mark_recall_cited_group', 'upsert_memory_entities',
    'memory_expand_typed', 'expand_memory_neighborhood', 'memory_hybrid_search',
  ]) {
    assert.match(
      squashed,
      new RegExp(`revoke execute on function public\\.${fn}\\([^)]*\\) from public, anon, authenticated`),
      `missing REVOKE for ${fn}`
    );
    assert.match(
      squashed,
      new RegExp(`grant execute on function public\\.${fn}\\([^)]*\\) to service_role`),
      `missing service_role GRANT for ${fn}`
    );
  }
});

test('[GATE 4] every function pins search_path', () => {
  const defs = sql.match(/create or replace function public\.[a-z_]+\s*\([\s\S]*?\bas \$\$/g) ?? [];
  assert.ok(defs.length >= 9, `expected >= 9 function definitions, found ${defs.length}`);
  for (const def of defs) {
    const name = /function public\.([a-z_]+)/.exec(def)?.[1];
    assert.match(def.toLowerCase(), /set search_path = public,/, `${name} does not pin search_path`);
  }
});

test('[GATE 4] the two traversal functions keep the `extensions` pin 019 set', () => {
  // expand_memory_neighborhood's pin was set by 019 via ALTER FUNCTION, not in
  // 009's CREATE — so a CREATE OR REPLACE without the SET clause silently nulls
  // it. That trap is why this is asserted separately from the generic check.
  for (const fn of ['memory_expand_typed', 'expand_memory_neighborhood']) {
    const def = new RegExp(
      `create or replace function public\\.${fn}[\\s\\S]*?set search_path = public, extensions, pg_catalog`
    );
    assert.match(effective, def, `${fn} must pin search_path = public, extensions, pg_catalog`);
  }
});

test('[GATE 5] table grants are revoked from public, anon, authenticated', () => {
  for (const t of [
    'memory_relationship_types', 'memory_entity_types',
    'memory_entities', 'memory_entity_mentions',
  ]) {
    assert.match(
      squashed,
      new RegExp(`revoke all on table public\\.${t} from public, anon, authenticated`),
      `table grants not revoked on ${t}`
    );
  }
});

test('[GATE 5] the read-only traversal functions are not SECURITY DEFINER', () => {
  for (const fn of ['memory_expand_typed', 'expand_memory_neighborhood']) {
    const body = new RegExp(
      `create or replace function public\\.${fn}[\\s\\S]*?\\bas \\$\\$`
    ).exec(effective)?.[0] ?? '';
    assert.ok(!/security definer/.test(body), `${fn} must stay SECURITY INVOKER`);
  }
});

// ── Apply-time discipline ──────────────────────────────────────────────────

test('the receipt is hard-failing, not a notice', () => {
  // apply_migration has a known silent-no-op failure mode; a receipt that cannot
  // fail is not a receipt.
  assert.ok(
    (sql.match(/raise exception '\[034\]/g) ?? []).length >= 20,
    'the receipt must RAISE on every gate, not merely NOTICE'
  );
});

test('the receipt asserts single-overload on every function it touches', () => {
  // A second overload makes every existing call ambiguous and PostgREST answers
  // "could not find the function" — the outage mnestra-bridge documents.
  assert.match(squashed, /ambiguous-overload hazard/);
  assert.match(squashed, /raise exception '\[034\] expected exactly 1 % overload/);
});

test('no CREATE INDEX CONCURRENTLY — illegal inside the runner transaction', () => {
  assert.ok(!/create index concurrently/.test(effective));
});

test('the migration is rerun-safe', () => {
  const creates = (sql.match(/create table (?!if not exists)/gi) ?? []);
  assert.deepEqual(creates, [], 'every CREATE TABLE must be IF NOT EXISTS');
  const indexes = (effective.match(/create (unique )?index (?!if not exists)/g) ?? []);
  assert.deepEqual(indexes, [], 'every CREATE INDEX must be IF NOT EXISTS');
});

test('the vendored TermDeck copy is byte-identical', () => {
  // Migration vendoring is the mechanism that keeps `termdeck init --mnestra`
  // from shipping a different 034 than this repo's. A drifted copy is worse than
  // a missing one: it applies, and disagrees.
  const vendored = path.join(
    process.env.HOME ?? '',
    'Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck',
    'packages/server/src/setup/mnestra-migrations/034_graph_layer.sql'
  );
  if (!fs.existsSync(vendored)) {
    // An external contributor has no termdeck checkout; parity is re-proven by
    // termdeck's own drift test. Skipping beats failing on a missing sibling repo.
    return;
  }
  assert.equal(fs.readFileSync(vendored, 'utf8'), sql, 'vendored 034 has drifted from engram/migrations/034');
});

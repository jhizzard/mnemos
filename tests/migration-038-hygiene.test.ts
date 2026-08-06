/**
 * Mnestra — migration 038 static hygiene assertions (Sprint 71 B-T1)
 *
 * Pins the tier-0 surface without a database: the frozen RPC names and argument
 * names, the six gates, the grant posture that IS the ratify-only guarantee,
 * the per-project lock that closes the cap race, and the TS <-> SQL constant
 * lockstep. The behavioural half runs live — rolled back against the real store,
 * and end-to-end (including the concurrency race) in an ephemeral container;
 * see the [B-T1] FIX-LANDED post in the Sprint 71 STATUS.
 *
 * What belongs HERE is everything whose failure mode is "somebody edited the
 * migration and nothing noticed". Five assertions carry most of the weight:
 *
 *   1. THE service_role REVOKE. Supabase default privileges grant full DML on a
 *      new public table to service_role — the exact key TermDeck's tier-0
 *      provider authenticates with. Drop `service_role` from that one REVOKE
 *      and the table is writable by every holder of the read key, while every
 *      comment in the file still claims mutation is ratification-only. Proven,
 *      not assumed: removing it makes the migration's own receipt raise
 *      "GATE 5 VIOLATION: 4 non-owner INSERT/UPDATE/DELETE/TRUNCATE grant(s)".
 *
 *   2. THE ARGUMENT NAMES. PostgREST binds RPC arguments by NAME, and the
 *      consumer here is in ANOTHER REPO (TermDeck packages/server/src/tier0.js,
 *      TIER0_RPC_DEFAULT = 'objective_list', probe shape 'p_project'). A rename
 *      is invisible to every test in this repo and dark-fails tier-0 injection
 *      in that one.
 *
 *   3. THE SUPERSESSION ORDER. The predecessor must be marked BEFORE the
 *      rank-collision and cap checks, or a replacement that keeps its
 *      predecessor's rank is rejected by its own predecessor — and only at the
 *      15-objective boundary, i.e. in production, months later.
 *
 *   4. THE ENTRY-POINT COUNT (GATE 6). "Mutation only through ratification" is
 *      checkable only by counting doors, and the count has to be one. The first
 *      draft shipped a separate objective_retire(); B-T4 declined it and ORCH
 *      upheld the contract. Retirement is now a MODE of ratify.
 *
 *   5. THE LOCK ORDERING. pg_advisory_xact_lock must precede every read of the
 *      objective set. A lock taken after the count still looks like
 *      serialization in a diff and closes nothing.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  OBJECTIVE_LIST_RPC,
  OBJECTIVE_RATIFY_RPC,
  OBJECTIVE_TABLE,
  OBJECTIVE_MAX_ACTIVE,
  OBJECTIVE_TEXT_MAX_CHARS,
  OBJECTIVE_PROJECT_MAX_CHARS,
  OBJECTIVE_RATIFIED_BY_MAX_CHARS,
  OBJECTIVE_METADATA_MAX_BYTES,
  OBJECTIVE_RANK_MIN,
  OBJECTIVE_RANK_MAX,
  OBJECTIVE_STATUSES,
  OBJECTIVE_RATIFY_REJECTED_PREFIX,
} from '../src/objectives.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// Two levels: these run compiled from dist-tests/tests/, not from tests/.
const REPO_ROOT = path.resolve(HERE, '..', '..');
const MIGRATION_PATH = path.join(REPO_ROOT, 'migrations', '038_objective_tier.sql');

const sql = fs.readFileSync(MIGRATION_PATH, 'utf8');
/** Comment-stripped, so no assertion can be satisfied by prose. */
const effective = sql
  .split('\n')
  .map((line) => line.replace(/--.*$/, ''))
  .join('\n')
  .toLowerCase();
/** Comment-stripped AND whitespace-collapsed, for multi-line SQL fragments. */
const squashed = effective.replace(/\s+/g, ' ');

// ── the frozen cross-repo surface ───────────────────────────────────────────

test('the table is named what the TermDeck consumer defaults to', () => {
  assert.equal(OBJECTIVE_TABLE, 'memory_objectives');
  assert.match(squashed, new RegExp(`create table if not exists public\\.${OBJECTIVE_TABLE} \\(`));
});

test('objective_list carries the SCHEMA-READY name and argument name', () => {
  assert.equal(OBJECTIVE_LIST_RPC, 'objective_list');
  assert.match(
    squashed,
    new RegExp(`create or replace function public\\.${OBJECTIVE_LIST_RPC}\\(p_project text\\)`)
  );
});

test('objective_list returns the four contract columns under their contract names', () => {
  const start = squashed.indexOf('create or replace function public.objective_list');
  const block = squashed.slice(start, squashed.indexOf('language sql', start));
  for (const col of ['project text', 'rank smallint', 'content text', 'status text']) {
    assert.ok(block.includes(col), `objective_list must return ${col}; block was: ${block}`);
  }
});

test('objective_list filters to active and orders by rank ascending', () => {
  assert.match(squashed, /o\.status = 'active'/);
  assert.match(squashed, /order by o\.rank asc/);
});

test('a NULL project returns zero rows rather than every project', () => {
  // The guard that keeps a project-less panel from being handed every project's
  // binding constraints, interleaved by rank.
  assert.match(squashed, /where p_project is not null/);
});

test('the single mutation RPC carries its frozen signature', () => {
  assert.equal(OBJECTIVE_RATIFY_RPC, 'objective_ratify');
  assert.match(
    squashed,
    /create or replace function public\.objective_ratify\( p_project text, p_ratified_by text, p_content text default null, p_rank smallint default null, p_supersedes uuid default null, p_metadata jsonb default '\{\}'::jsonb \) returns uuid/
  );
});

// ── GATE 6: EXACTLY ONE mutation entry point ────────────────────────────────

test('GATE 6: the migration defines exactly two objective functions — one read, one mutation', () => {
  const defined = [...squashed.matchAll(/create or replace function public\.(objective_[a-z_]+)\(/g)].map(
    (m) => m[1]!
  );
  assert.deepEqual(
    [...new Set(defined)].sort(),
    ['objective_list', 'objective_ratify'],
    'a second mutation function is not a smaller version of ratification-only mutation — it is the absence of it'
  );
});

test('GATE 6: no objective_retire survives anywhere in the migration', () => {
  assert.ok(
    !/objective_retire/.test(effective),
    'retirement is a MODE of objective_ratify (supersede with no content), not its own grant-reachable function'
  );
});

test('GATE 6: the receipt counts extra service_role-executable mutators as a live privilege fact', () => {
  // Asserting the FILE only defines one would miss the real failure: somebody
  // adding objective_archive() with a service_role grant in a later migration.
  assert.match(squashed, /p\.proname like 'objective\\_%'/);
  assert.match(squashed, /p\.proname not in \('objective_list', 'objective_ratify'\)/);
  assert.match(squashed, /has_function_privilege\('service_role', p\.oid, 'execute'\)/);
  assert.ok(effective.includes('gate 6 violation'));
});

test('retire is reachable as a MODE of ratify — supersede with no content', () => {
  assert.match(squashed, /v_retire := \(v_content is null and p_supersedes is not null\);/);
  // ...and it marks 'retired' rather than 'superseded' when nothing replaces it.
  assert.match(squashed, /case when v_retire then 'retired' else 'superseded' end/);
  // ...and it returns before inserting anything.
  assert.match(squashed, /if v_retire then return p_supersedes; end if;/);
  assert.ok(effective.includes('content_or_supersedes_required'));
  assert.ok(effective.includes('rank_not_allowed_on_retire'));
});

// ── the cap race ────────────────────────────────────────────────────────────

test('the cap is serialized by a per-project advisory xact lock', () => {
  assert.match(
    squashed,
    /perform pg_advisory_xact_lock\(hashtext\('mnestra\.memory_objectives'\), hashtext\(v_project\)\);/,
    'the cap is a check-then-act; without serialization two concurrent ratifies both pass it'
  );
});

test('the lock is taken BEFORE anything reads the objective set — a lock after the count is decoration', () => {
  const body = squashed.slice(squashed.indexOf('create or replace function public.objective_ratify'));
  const lockAt = body.indexOf('pg_advisory_xact_lock');
  const countAt = body.indexOf('select count(*)::int into v_active');
  const predecessorReadAt = body.indexOf('select * into v_old');
  const insertAt = body.indexOf('insert into public.memory_objectives');
  assert.ok(lockAt > 0 && countAt > 0 && predecessorReadAt > 0 && insertAt > 0, 'sanity: sites located');
  assert.ok(lockAt < countAt, 'the cap count must happen under the lock');
  assert.ok(lockAt < predecessorReadAt, 'the predecessor read must happen under the lock');
  assert.ok(lockAt < insertAt, 'the insert must happen under the lock');
});

test('the lock is xact-scoped (no unlock path to forget, no leak on an exception)', () => {
  assert.ok(
    !/pg_advisory_lock\(/.test(effective),
    'a session-scoped advisory lock would leak on any exception path'
  );
  assert.ok(!/pg_advisory_unlock/.test(effective), 'an xact lock needs no unlock; an unlock implies the wrong lock');
});

test('the lock key is the PROJECT, so two projects never contend', () => {
  assert.match(squashed, /hashtext\(v_project\)/);
});

// ── GATE 5: the ratify-only guarantee is a GRANT fact ───────────────────────

test('GATE 5: all table privileges are revoked from service_role, then SELECT alone re-granted', () => {
  assert.match(
    squashed,
    /revoke all on table public\.memory_objectives from public, anon, authenticated, service_role;/,
    'service_role MUST be in the revoke list — Supabase default privileges grant it full DML on a new public table'
  );
  assert.match(squashed, /grant select on table public\.memory_objectives to service_role;/);
});

test('GATE 5: no role is ever granted a write privilege on the table', () => {
  const grants = squashed.match(/grant [^;]*on table public\.memory_objectives[^;]*;/g) ?? [];
  assert.ok(grants.length > 0, 'sanity: the grant statements were located');
  for (const g of grants) {
    for (const priv of ['insert', 'update', 'delete', 'truncate', 'all']) {
      assert.ok(
        !new RegExp(`grant[^;]*\\b${priv}\\b`).test(g),
        `a write grant on tier 0 defeats ratification-only mutation: ${g}`
      );
    }
  }
});

test('the receipt hard-fails on a non-owner write grant however it arose', () => {
  // Checked as a privilege FACT, not as "the REVOKE statement ran".
  assert.match(squashed, /privilege_type in \('insert', 'update', 'delete', 'truncate'\)/);
  assert.match(squashed, /grantee <> v_owner::text/);
  assert.ok(effective.includes('gate 5 violation'));
});

// ── the remaining gates ─────────────────────────────────────────────────────

test('GATE 1: RLS is enabled on the new table', () => {
  assert.match(squashed, /alter table public\.memory_objectives enable row level security/);
  assert.ok(effective.includes('gate 1 violation'));
});

test('GATE 2: the table is ZERO-policy, and the receipt counts ALL policies not just PUBLIC ones', () => {
  assert.ok(
    !/create policy/.test(effective),
    'tier 0 is a zero-policy table; a policy here is a read/write path nobody audited'
  );
  const start = squashed.indexOf('into v_bad_policies');
  const block = squashed.slice(start, start + 260);
  assert.ok(
    block.includes("tablename = 'memory_objectives'"),
    'sanity: the policy count targets this table'
  );
  assert.ok(
    !block.includes('any(roles)'),
    'unlike a shared table, ANY policy here is a violation — the count must not be narrowed to PUBLIC-reaching ones'
  );
  assert.ok(effective.includes('gate 2 violation'));
});

test('GATE 3: EXECUTE is revoked from public/anon/authenticated on all three functions', () => {
  for (const sig of [
    'public\\.objective_list\\(text\\)',
    'public\\.objective_ratify\\(text, text, text, smallint, uuid, jsonb\\)',
  ]) {
    assert.match(
      squashed,
      new RegExp(`revoke execute on function ${sig} from public, anon, authenticated;`)
    );
    assert.match(squashed, new RegExp(`grant execute on function ${sig} to service_role;`));
  }
  assert.ok(
    !/grant execute on function public\.objective_[^;]*to [^;]*\b(anon|authenticated)\b/.test(squashed),
    'no objective function may be granted to anon/authenticated'
  );
  assert.ok(effective.includes('gate 3 violation'));
});

test('GATE 4: search_path is pinned on both functions', () => {
  const pinned = squashed.match(/set search_path = public, pg_catalog/g) ?? [];
  assert.ok(pinned.length >= 2, `expected 2 pinned search_paths, found ${pinned.length}`);
  assert.ok(effective.includes('gate 4 violation'));
});

test('the receipt hard-fails rather than only raising notices', () => {
  for (const gate of [
    'gate 1 violation',
    'gate 2 violation',
    'gate 3 violation',
    'gate 4 violation',
    'gate 5 violation',
    'gate 6 violation',
  ]) {
    assert.ok(effective.includes(gate), `receipt is missing a hard failure for ${gate}`);
  }
});

// ── never-delete ────────────────────────────────────────────────────────────

test('the migration never DELETEs or DROPs anything outside its commented reversal', () => {
  assert.ok(!/\bdelete from\b/.test(effective), 'no DELETE belongs in this migration');
  assert.ok(!/\bdrop (table|column|function|index)\b/.test(effective), 'no live DROP belongs here');
});

test('neither mutation function ever deletes a row — history is marked, not removed', () => {
  // Scoped to each function BODY. The receipt further down legitimately contains
  // the word "delete" inside its GATE 5 privilege_type list, and a whole-file
  // grep would match that and read as a pass-by-accident either way.
  for (const fn of ['objective_ratify']) {
    const from = squashed.indexOf(`create or replace function public.${fn}`);
    const to = squashed.indexOf(`revoke execute on function public.${fn}`, from);
    assert.ok(from >= 0 && to > from, `sanity: could not isolate the ${fn} body`);
    const body = squashed.slice(from, to);
    assert.ok(!/\bdelete\b/.test(body), `${fn} must MARK rows, never remove them`);
    assert.ok(!/\btruncate\b/.test(body), `${fn} must not truncate`);
  }
});

test('037 / Deck A surfaces are untouched', () => {
  for (const foreign of ['memory_items', 'memory_relationships', 'memory_recall_graph', 'memory_entities']) {
    assert.ok(
      !new RegExp(`(alter|create|drop)[^;]*\\b${foreign}\\b`).test(squashed),
      `038 must not touch ${foreign} — seam §2 gives Deck A that surface`
    );
  }
});

// ── the supersession ordering guard ─────────────────────────────────────────

test('the predecessor is marked BEFORE the rank-collision and cap checks', () => {
  const body = squashed.slice(squashed.indexOf('create or replace function public.objective_ratify'));
  const markAt = body.indexOf("set status = case when v_retire then 'retired' else 'superseded' end");
  const rankCheckAt = body.indexOf('rank_taken');
  const capCheckAt = body.indexOf('too_many_active');
  assert.ok(markAt > 0 && rankCheckAt > 0 && capCheckAt > 0, 'sanity: all three sites located');
  assert.ok(
    markAt < rankCheckAt,
    'a replacement inheriting its predecessor rank would be rejected by its own predecessor'
  );
  assert.ok(
    markAt < capCheckAt,
    'at exactly the cap, a replacement would be counted against itself'
  );
});

test('supersession is locked with FOR UPDATE before it is read', () => {
  assert.match(squashed, /select \* into v_old from public\.memory_objectives where id = p_supersedes for update;/);
});

test('a superseded target must be active and in the same project', () => {
  assert.ok(effective.includes('supersedes_wrong_project'));
  assert.ok(effective.includes('supersedes_not_active'));
  assert.ok(effective.includes('supersedes_not_found'));
});

test('the rank-uniqueness index is PARTIAL on active rows', () => {
  assert.match(
    squashed,
    /create unique index if not exists memory_objectives_active_rank_uidx on public\.memory_objectives \(project, rank\) where status = 'active';/
  );
});

// ── TS <-> SQL lockstep ─────────────────────────────────────────────────────

test('every cap in the SQL matches its TS mirror constant', () => {
  assert.match(squashed, new RegExp(`length\\(v_content\\) > ${OBJECTIVE_TEXT_MAX_CHARS}`));
  assert.match(squashed, new RegExp(`length\\(v_project\\) > ${OBJECTIVE_PROJECT_MAX_CHARS}`));
  assert.match(squashed, new RegExp(`length\\(v_by\\) > ${OBJECTIVE_RATIFIED_BY_MAX_CHARS}`));
  assert.match(squashed, new RegExp(`pg_column_size\\(v_meta\\) > ${OBJECTIVE_METADATA_MAX_BYTES}`));
  assert.match(squashed, new RegExp(`v_active >= ${OBJECTIVE_MAX_ACTIVE}`));
  assert.match(
    squashed,
    new RegExp(`v_rank < ${OBJECTIVE_RANK_MIN} or v_rank > ${OBJECTIVE_RANK_MAX}`)
  );
});

test('the content cap is in lockstep with the TermDeck consumer clamp', () => {
  // TIER0_MAX_TEXT_CHARS in packages/server/src/tier0.js CLAMPS at this length.
  // Rejecting at the same number is what keeps "stored" and "injected" the same
  // string — a store cap ABOVE the clamp means silently half-injected objectives.
  assert.equal(OBJECTIVE_TEXT_MAX_CHARS, 600);
  assert.match(squashed, /check \(btrim\(content\) <> '' and length\(content\) <= 600\)/);
});

test('the status vocabulary is the same on both sides', () => {
  const m = squashed.match(/check \(status in \(([^)]+)\)\)/);
  assert.ok(m, 'status CHECK not found');
  const sqlStatuses = m[1]!
    .split(',')
    .map((s) => s.trim().replace(/^'|'$/g, ''))
    .sort();
  assert.deepEqual(sqlStatuses, [...OBJECTIVE_STATUSES].sort());
});

test('every inactive status is inside the TermDeck consumer deny-list', () => {
  // packages/server/src/tier0.js INACTIVE_STATUSES. A status this store can emit
  // that the consumer does not recognise as inactive would INJECT a retired
  // objective — handing an agent a constraint the operator explicitly retired.
  const consumerDenyList = [
    'superseded',
    'retired',
    'archived',
    'inactive',
    'revoked',
    'draft',
    'deleted',
  ];
  for (const s of OBJECTIVE_STATUSES) {
    if (s === 'active') continue;
    assert.ok(consumerDenyList.includes(s), `status '${s}' is not in the consumer deny-list`);
  }
});

test('every rejection uses the shared prefix', () => {
  const raises = sql.match(/raise exception '([^']*)'/g) ?? [];
  const rejections = raises.filter((r) => /REJECTED/.test(r));
  assert.ok(rejections.length >= 15, `expected the full rejection matrix, got ${rejections.length}`);
  for (const r of rejections) {
    assert.ok(
      r.includes(`${OBJECTIVE_RATIFY_REJECTED_PREFIX}: `),
      `rejection does not carry the shared prefix: ${r}`
    );
  }
});

test('the retirement-consistency CHECK makes an unstamped deactivation unrepresentable', () => {
  assert.match(
    squashed,
    /check \( \(status = 'active' and retired_at is null and retired_by is null\) or \(status <> 'active' and retired_at is not null and retired_by is not null\) \)/
  );
});

test('no top-level column is named superseded_by or is_active', () => {
  // Both are retirement SENTINELS in the TermDeck consumer (tier0.js
  // isRetiredObjective). A column by either name on a LIVE row would blank it
  // from injection — the failure mode being "the objectives silently stop
  // appearing", which looks identical to correct degradation.
  const createBlock = squashed.slice(
    squashed.indexOf('create table if not exists public.memory_objectives'),
    squashed.indexOf('comment on table public.memory_objectives')
  );
  assert.ok(!/\bsuperseded_by\b/.test(createBlock));
  assert.ok(!/\bis_active\b/.test(createBlock));
  assert.ok(/\bsupersedes uuid\b/.test(createBlock), 'sanity: the forward pointer IS present');
});

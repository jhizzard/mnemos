/**
 * Mnestra — migration 035 static hygiene assertions (Sprint 84 T2)
 *
 * Pins the SCHEMA-READY surface without a database: the exact RPC signature
 * the bridge codes against, the five RLS gates, the two upsert guards, and the
 * TS <-> SQL cap lockstep. The behavioural half runs against a real
 * pgvector/pgvector:pg17 container applied by a NOSUPERUSER role (Sprint 83
 * lesson: the discriminator is the role, not the PG version).
 *
 * What belongs HERE is everything whose failure mode is "somebody edited the
 * migration and nothing noticed". Two assertions carry most of the weight:
 *
 *   1. THE MINTED session_id. 035's whole thesis is that a web caller cannot
 *      address a CLI-written memory_sessions row, and the only thing making
 *      that true is that session_id is built inside the RPC from the
 *      whitelisted agent plus the caller's key. A future edit adding a
 *      p_session_id parameter would pass every cap test and quietly hand away
 *      the guard.
 *   2. THE NARROWED UPSERT. `do update ... where source_agent = v_agent and
 *      rumen_processed_at is null` is what stops cross-agent overwrite and
 *      re-arming an already-swept row for a second synthesis pass. Dropping
 *      the WHERE is invisible until someone audits the diff.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  SESSION_SUMMARY_MAX_CHARS,
  SESSION_CONVERSATION_KEY_MAX_CHARS,
  SESSION_PROJECT_MAX_CHARS,
  SESSION_TOPICS_MAX_BYTES,
  SESSION_METADATA_MAX_BYTES,
  SESSION_RECORD_REJECTED_PREFIX,
  webSessionId,
} from '../src/session_record.js';
import { WEB_SOURCE_AGENTS } from '../src/types.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// Two levels: these run compiled from dist-tests/tests/, not from tests/.
const REPO_ROOT = path.resolve(HERE, '..', '..');
const MIGRATION_PATH = path.join(REPO_ROOT, 'migrations', '035_memory_session_record.sql');

const sql = fs.readFileSync(MIGRATION_PATH, 'utf8');
/** Comment-stripped, so no assertion can be satisfied by prose. */
const effective = sql
  .split('\n')
  .map((line) => line.replace(/--.*$/, ''))
  .join('\n')
  .toLowerCase();
/** Comment-stripped AND whitespace-collapsed, for multi-line SQL fragments. */
const squashed = effective.replace(/\s+/g, ' ');

// ── the frozen RPC surface ──────────────────────────────────────────────────
//
// PostgREST binds RPC arguments by NAME, so a renamed parameter is a breaking
// change even when the types match. The bridge client was written against
// these exact names.

test('memory_session_record carries the SCHEMA-READY parameter names, in order', () => {
  assert.match(
    squashed,
    /create or replace function public\.memory_session_record\( p_source_agent text, p_conversation_key text, p_summary text, p_project text default null, p_messages_count int default null, p_started_at timestamptz default null, p_ended_at timestamptz default null, p_topics jsonb default '\[\]'::jsonb, p_metadata jsonb default '\{\}'::jsonb \) returns uuid/
  );
});

test('the RPC takes NO session_id parameter — it is minted, never supplied', () => {
  const signature = squashed.slice(
    squashed.indexOf('create or replace function public.memory_session_record'),
    squashed.indexOf('returns uuid')
  );
  assert.ok(signature.length > 0, 'signature block not found');
  assert.ok(
    !signature.includes('session_id'),
    `no session_id parameter may exist; signature was: ${signature}`
  );
});

test('session_id is minted from the whitelisted agent + the caller key', () => {
  assert.match(squashed, /v_session_id := 'web:' \|\| v_agent \|\| ':' \|\| v_key;/);
  // ...and the TS mirror builds the identical string.
  assert.equal(webSessionId('grok-web', 'abc'), 'web:grok-web:abc');
  assert.match(squashed, /'web:'/);
});

// ── the two upsert guards ───────────────────────────────────────────────────

test('the do-update is narrowed to same-agent AND not-yet-swept rows', () => {
  assert.match(
    squashed,
    /on conflict \(session_id\) do update set .* where ms\.source_agent = v_agent and ms\.rumen_processed_at is null/
  );
});

/** The INSERT column list only — `insert into … as ms ( <here> ) values`. */
function insertColumnList(): string {
  const start = squashed.indexOf('insert into public.memory_sessions as ms (');
  assert.ok(start >= 0, 'insert statement not found');
  const open = squashed.indexOf('(', start);
  const close = squashed.indexOf(')', open);
  return squashed.slice(open + 1, close);
}

/** The UPDATE assignment list only — `do update set <here> where …`. */
function updateSetList(): string {
  const start = squashed.indexOf('on conflict (session_id) do update set');
  assert.ok(start >= 0, 'on-conflict clause not found');
  const from = start + 'on conflict (session_id) do update set'.length;
  const to = squashed.indexOf(' where ', from);
  assert.ok(to > from, 'the do-update must carry a WHERE guard');
  return squashed.slice(from, to);
}

test('rumen_processed_at is never assigned — only read as a guard', () => {
  // The picker's claim stamp belongs to Rumen. A web caller that could clear
  // it would get unlimited re-synthesis of the same content. It may appear in
  // the WHERE guard (read) but never in an INSERT column list or a SET
  // assignment (write).
  assert.ok(!insertColumnList().includes('rumen_processed_at'));
  assert.ok(!updateSetList().includes('rumen_processed_at'));
  assert.ok(
    !/rumen_processed_at\s*=\s*(now\(\)|excluded|null)/.test(effective),
    'migration 035 must never assign rumen_processed_at'
  );
});

test('columns a web surface has no business writing are absent from the SET list', () => {
  const setBlock = updateSetList();
  assert.ok(setBlock.includes('summary = excluded.summary'), 'sanity: the SET list was located');
  for (const col of [
    'rumen_processed_at',
    'facts_extracted',
    'summary_embedding',
    'transcript_path',
    'files_changed',
    'session_id',
  ]) {
    assert.ok(!setBlock.includes(col), `${col} must not be assignable from a web session record`);
  }
});

test('the INSERT writes only the ten intended columns', () => {
  const cols = insertColumnList()
    .split(',')
    .map((c) => c.trim())
    .filter(Boolean)
    .sort();
  assert.deepEqual(cols, [
    'duration_minutes',
    'ended_at',
    'messages_count',
    'metadata',
    'project',
    'session_id',
    'source_agent',
    'started_at',
    'summary',
    'topics',
  ]);
});

// ── whitelist lockstep (SQL literal vs the TS list) ─────────────────────────

test('the SQL whitelist is exactly WEB_SOURCE_AGENTS', () => {
  const m = squashed.match(/v_agent not in \(([^)]+)\)/);
  assert.ok(m, 'whitelist clause not found');
  const sqlAgents = m[1]!
    .split(',')
    .map((s) => s.trim().replace(/^'|'$/g, ''))
    .sort();
  assert.deepEqual(sqlAgents, [...WEB_SOURCE_AGENTS].sort());
});

test('no CLI source agent appears anywhere in the effective SQL', () => {
  for (const cli of ["'claude'", "'codex'", "'gemini'", "'grok'", "'orchestrator'"]) {
    assert.ok(!effective.includes(cli), `${cli} must not be reachable from this RPC`);
  }
});

// ── TS <-> SQL cap lockstep ─────────────────────────────────────────────────

test('every cap in the SQL matches its TS mirror constant', () => {
  assert.match(squashed, new RegExp(`length\\(v_summary\\) > ${SESSION_SUMMARY_MAX_CHARS}`));
  assert.match(
    squashed,
    new RegExp(`length\\(v_key\\) > ${SESSION_CONVERSATION_KEY_MAX_CHARS}`)
  );
  assert.match(squashed, new RegExp(`length\\(v_project\\) > ${SESSION_PROJECT_MAX_CHARS}`));
  assert.match(
    squashed,
    new RegExp(`pg_column_size\\(v_topics\\) > ${SESSION_TOPICS_MAX_BYTES}`)
  );
  assert.match(
    squashed,
    new RegExp(`pg_column_size\\(v_meta\\) > ${SESSION_METADATA_MAX_BYTES}`)
  );
});

test('the conversation-key charset is the same on both sides', () => {
  assert.match(squashed, /v_key !~ '\^\[a-za-z0-9\._:@-\]\+\$'/);
});

test('every rejection uses the shared prefix', () => {
  const raises = sql.match(/raise exception '([^']*)'/g) ?? [];
  const rejections = raises.filter((r) => /REJECTED/.test(r));
  assert.ok(rejections.length >= 14, `expected the full rejection matrix, got ${rejections.length}`);
  for (const r of rejections) {
    assert.ok(
      r.includes(`${SESSION_RECORD_REJECTED_PREFIX}: `),
      `rejection does not carry the shared prefix: ${r}`
    );
  }
});

// ── the five gates ──────────────────────────────────────────────────────────

test('GATE 3: EXECUTE is revoked from public/anon/authenticated and granted only to service_role', () => {
  assert.match(
    squashed,
    /revoke execute on function public\.memory_session_record\(text, text, text, text, int, timestamptz, timestamptz, jsonb, jsonb\) from public, anon, authenticated;/
  );
  assert.match(
    squashed,
    /grant execute on function public\.memory_session_record\(text, text, text, text, int, timestamptz, timestamptz, jsonb, jsonb\) to service_role;/
  );
  // No stray grant to a client-facing role.
  assert.ok(
    !/grant execute on function public\.memory_session_record[^;]*to [^;]*\b(anon|authenticated)\b/.test(
      squashed
    ),
    'memory_session_record must never be granted to anon/authenticated'
  );
});

test('GATE 4: search_path is pinned on the function', () => {
  assert.match(squashed, /security definer set search_path = public, pg_catalog/);
});

test('GATE 5: the residual anon/authenticated table grants are revoked', () => {
  assert.match(squashed, /revoke all on table public\.memory_sessions from anon, authenticated;/);
});

test('the receipt hard-fails on every gate rather than only raising notices', () => {
  for (const gate of [
    'gate 1 violation',
    'gate 2 violation',
    'gate 3 violation',
    'gate 4 violation',
    'gate 5 violation',
  ]) {
    assert.ok(effective.includes(gate), `receipt is missing a hard failure for ${gate}`);
  }
});

test('the migration never DELETEs or DROPs anything outside its own commented reversal', () => {
  assert.ok(!/\bdelete from\b/.test(effective), 'no DELETE belongs in this migration');
  assert.ok(!/\bdrop (table|column|function)\b/.test(effective), 'no live DROP belongs here');
});

// ── the column reconciliation ───────────────────────────────────────────────

test('both column adds are idempotent and non-destructive', () => {
  assert.match(
    squashed,
    /alter table public\.memory_sessions add column if not exists metadata jsonb not null default '\{\}'::jsonb, add column if not exists source_agent text;/
  );
});

test('source_agent carries no CHECK constraint (migration 025 fail-soft doctrine)', () => {
  assert.ok(
    !/check\s*\([^)]*source_agent/.test(effective),
    'a CHECK on source_agent would cost a fail-soft writer its capture on taxonomy skew'
  );
});

test('the migration refuses to proceed without the mig-017 unique constraint on session_id', () => {
  // `on conflict (session_id)` needs it; failing at apply time beats failing
  // at first RPC call in production.
  assert.match(squashed, /no unique constraint on memory_sessions\(session_id\)/);
});

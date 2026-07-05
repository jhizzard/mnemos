/**
 * Mnestra — migration 028 static hygiene assertions (Sprint 79 T1)
 *
 * Same house idiom as migration-026/027-hygiene: read the SQL as text and pin
 * the five release-blocking RLS hygiene gates, the collision guards (027's
 * columns untouched, content_hash not re-declared), the backfill's
 * never-DELETE property, the relationship_type CHECK's final 10-value set,
 * and the HARD-FAILING receipt block. Dumb string/regex checks that catch
 * high-cost silent regressions without needing a database.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const MIGRATION_PATH = path.join(REPO_ROOT, 'migrations', '028_capture_gates.sql');

const sql = fs.readFileSync(MIGRATION_PATH, 'utf8');
const lower = sql.toLowerCase();

// Comment-stripped "effective" SQL for the negative scans (the header prose
// documents forbidden shapes, e.g. "no WITH CHECK (true)", which would
// otherwise trip the gate's own assertion). No string literal in the file
// contains `--`, so a line-wise strip is safe (same idiom as migration-027).
const effective = sql
  .split('\n')
  .map((line) => line.replace(/--.*$/, ''))
  .join('\n');

test('genuinely-new columns are additive (ADD COLUMN IF NOT EXISTS)', () => {
  assert.match(lower, /add column if not exists reinforcement_count int not null default 1/);
  assert.match(lower, /add column if not exists sprint_ref text/);
  assert.match(lower, /add column if not exists rule_ref text/);
});

test('content_hash IS declared via ADD COLUMN IF NOT EXISTS, for replay-safety on a fresh install', () => {
  // Re-declaring an EXISTING generated column errors — but IF NOT EXISTS
  // short-circuits before any re-declaration is attempted, so this is a
  // true no-op on the live store (where content_hash pre-dates this
  // migration) AND the statement that makes a clean 001->028 replay (a
  // fresh install, or CI) actually create the column at all.
  assert.match(
    lower,
    /add column if not exists content_hash text generated always as \(md5\(content\)\) stored/
  );
});

test('collision guard: migration-027-owned columns are never re-added here', () => {
  assert.ok(
    !/add column if not exists recall_count/.test(lower),
    'recall_count is owned by migration 027'
  );
  assert.ok(
    !/add column if not exists last_recalled_at/.test(lower),
    'last_recalled_at is owned by migration 027'
  );
});

test('backfill collapse never DELETEs — supersede + is_active=false only', () => {
  assert.ok(!/delete\s+from\s+public\.memory_items/i.test(effective), 'the backfill must never DELETE rows');
  assert.match(lower, /set\s+is_active\s+=\s+false,\s*\n\s*superseded_by\s+=\s+dg\.canonical_id/);
});

test('backfill grouping is data-driven (a live GROUP BY), not a hardcoded row count', () => {
  assert.match(lower, /group by content_hash/);
  assert.match(lower, /having count\(\*\) > 1/);
  // No stale literal group-count anywhere in the executable SQL (comments may
  // legitimately mention historical numbers like "56" or "138" for context).
  assert.ok(!/=\s*56\b/.test(effective), 'no hardcoded group-count literal in executable SQL');
});

test('two partial unique indexes exist with the exact ON CONFLICT arbiter predicates', () => {
  assert.match(
    lower,
    /create unique index if not exists memory_items_content_hash_active_uidx\s*\n\s*on public\.memory_items \(content_hash\)\s*\n\s*where \(is_active = true\)/
  );
  assert.match(
    lower,
    /create unique index if not exists memory_items_precompact_session_uidx\s*\n\s*on public\.memory_items \(source_session_id\)\s*\n\s*where \(source_type = 'pre_compact_snapshot' and is_active = true\)/
  );
  // The RPC's two ON CONFLICT clauses must use the IDENTICAL predicates.
  assert.match(lower, /on conflict \(content_hash\) where \(is_active = true\)/);
  assert.match(
    lower,
    /on conflict \(source_session_id\) where \(source_type = 'pre_compact_snapshot' and is_active = true\)/
  );
});

test('relationship_type CHECK carries the final 10-value set (base 8 + amends_rule + elevated_to)', () => {
  assert.match(lower, /drop constraint if exists memory_relationships_relationship_type_check/);
  assert.match(lower, /add constraint memory_relationships_relationship_type_check/);
  for (const value of [
    'supersedes',
    'relates_to',
    'contradicts',
    'elaborates',
    'caused_by',
    'blocks',
    'inspired_by',
    'cross_project_link',
    'amends_rule',
    'elevated_to',
  ]) {
    assert.ok(lower.includes(`'${value}'`), `relationship_type CHECK must include '${value}'`);
  }
});

test("source_type CHECK preserves the 10 pre-existing live values and adds 'doctrine' (unblocks T3's flow-back insert)", () => {
  assert.match(lower, /drop constraint if exists memory_items_source_type_check/);
  assert.match(lower, /add constraint memory_items_source_type_check/);
  for (const value of [
    'fact',
    'decision',
    'preference',
    'bug_fix',
    'architecture',
    'code_context',
    'session_summary',
    'document_chunk',
    'commit_context',
    'pre_compact_snapshot',
    'doctrine',
  ]) {
    assert.ok(lower.includes(`'${value}'`), `source_type CHECK must include '${value}'`);
  }
});

test('gate 3: EXECUTE revoked from public/anon/authenticated, granted service_role only — ingest_capture', () => {
  assert.match(
    lower,
    /revoke execute on function public\.ingest_capture\(jsonb\)\s*\n\s*from public, anon, authenticated/
  );
  assert.match(
    lower,
    /grant\s+execute on function public\.ingest_capture\(jsonb\)\s*\n\s*to service_role/
  );
  const grantStatements = effective.match(/\bgrant\b[^;]*;/gi) ?? [];
  for (const stmt of grantStatements) {
    if (/ingest_capture/i.test(stmt)) {
      assert.ok(!/\b(anon|authenticated)\b/i.test(stmt), `a grant on ingest_capture names a client role: ${stmt}`);
    }
  }
});

test('gate 4: ingest_capture is SECURITY DEFINER with search_path pinned including extensions (vector type lives there on this store)', () => {
  assert.match(lower, /security definer/);
  assert.match(lower, /set search_path = public, extensions, pg_catalog/);
});

test('gate 2: zero new policies, never WITH CHECK (true)', () => {
  assert.ok(!/create\s+policy/i.test(effective), 'this migration adds no new policies');
  assert.ok(!/with\s+check\s*\(\s*true\s*\)/i.test(effective), 'WITH CHECK (true) is the forbidden Studio-template shape');
});

test('gate 1: no new table is created (the migration only ALTERs existing tables + adds a function/view)', () => {
  assert.ok(!/create table/i.test(effective), 'migration 028 creates no new table');
});

test('mnestra_capture_health view is security_invoker, not a SECURITY DEFINER view', () => {
  assert.match(lower, /create or replace view public\.mnestra_capture_health\s*\n\s*with \(security_invoker = true\)/);
});

test('mnestra_capture_health has explicit grant hygiene (migration 019 precedent) — security_invoker alone grants no one SELECT', () => {
  assert.match(
    lower,
    /revoke all on public\.mnestra_capture_health from public, anon, authenticated/
  );
  assert.match(lower, /grant\s+select on public\.mnestra_capture_health to service_role/);
  const grantStatements = effective.match(/\bgrant\b[^;]*;/gi) ?? [];
  for (const stmt of grantStatements) {
    if (/mnestra_capture_health/i.test(stmt)) {
      assert.ok(!/\b(anon|authenticated)\b/i.test(stmt), `a grant on the health view names a client role: ${stmt}`);
    }
  }
});

test('idempotency idioms: IF NOT EXISTS + CREATE OR REPLACE + DROP CONSTRAINT IF EXISTS', () => {
  const addCol = lower.match(/add column if not exists/g) ?? [];
  assert.ok(addCol.length >= 4, `expected >=4 ADD COLUMN IF NOT EXISTS (content_hash + 3 new), found ${addCol.length}`);
  assert.match(lower, /create unique index if not exists/);
  assert.match(lower, /drop constraint if exists/);
  assert.match(lower, /create or replace function/);
  assert.match(lower, /create or replace view/);
});

test('receipt block exists and HARD-FAILS on gate violations', () => {
  for (const expected of [
    'NEW COLUMN MISSING',
    'COLLISION GUARD VIOLATION',
    'BACKFILL REGRESSION',
    'INDEX MISSING',
    'RELATIONSHIP_TYPE CHECK VIOLATION',
    'SOURCE_TYPE CHECK VIOLATION',
    'GATE 3 VIOLATION',
    'GATE 4 VIOLATION',
    'VIEW GATE VIOLATION',
    'RLS REGRESSION',
    "has_function_privilege('anon'",
    "has_function_privilege('service_role'",
  ]) {
    assert.ok(sql.includes(expected), `receipt block must check/raise: ${expected}`);
  }
});

test('early backfill guard raises BEFORE the unique index attempt (clearer error than a raw constraint violation)', () => {
  const guardIdx = sql.indexOf('BACKFILL INCOMPLETE');
  const indexIdx = sql.indexOf('memory_items_content_hash_active_uidx');
  assert.ok(guardIdx > -1 && indexIdx > -1, 'both the early guard and the index creation must be present');
  assert.ok(guardIdx < indexIdx, 'the early guard must appear before the unique index is created');
});

test('ingest_capture branches on source_type before choosing an ON CONFLICT arbiter (one INSERT cannot target two)', () => {
  assert.match(lower, /if v_source_type = 'pre_compact_snapshot' and v_source_session_id is not null then/);
  // The pre_compact_snapshot branch must return before falling through to the
  // content_hash branch (no double-insert risk).
  const branchStart = lower.indexOf("if v_source_type = 'pre_compact_snapshot'");
  const branchReturn = lower.indexOf('return jsonb_build_object', branchStart);
  const branchEnd = lower.indexOf('end if;', branchReturn);
  const fallthroughInsert = lower.indexOf('-- everything else', branchEnd);
  assert.ok(
    branchStart < branchReturn && branchReturn < branchEnd && branchEnd < fallthroughInsert,
    'pre_compact_snapshot branch must return before the content_hash fallback path'
  );
});

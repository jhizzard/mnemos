/**
 * Mnestra — migration 032 static hygiene assertions (Sprint 81 T1)
 *
 * Pins the recall_boost column, the set_recall_boost RPC contract (T2 / R5),
 * the bounded no-op-at-1.0 ranking factor in memory_hybrid_search, the five RLS
 * gates, and the OID-form receipt — all without a database.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const MIGRATION_PATH = path.join(REPO_ROOT, 'migrations', '032_recall_boost.sql');

const sql = fs.readFileSync(MIGRATION_PATH, 'utf8');
const lower = sql.toLowerCase();
const effective = sql
  .split('\n')
  .map((line) => line.replace(/--.*$/, ''))
  .join('\n')
  .toLowerCase();

test('recall_boost column: numeric NOT NULL DEFAULT 1.0, idempotent add', () => {
  assert.match(
    lower,
    /add column if not exists recall_boost numeric not null default 1\.0/,
    'bounded multiplier column, no-op default 1.0'
  );
});

test('set_recall_boost matches T2 contract: (id uuid, boost numeric), batched, clamp [1.0, 2.0]', () => {
  assert.match(lower, /create or replace function public\.set_recall_boost\(p_updates jsonb\)/);
  // recordset typing is the {id, boost} shape T2's reinforce.ts targets.
  assert.match(lower, /jsonb_to_recordset\(p_updates\) as u\(id uuid, boost numeric\)/);
  // server-side clamp to [1.0, RECALL_BOOST_MAX=2.0].
  assert.match(lower, /set recall_boost = least\(greatest\(u\.boost, 1\.0\), 2\.0\)/);
  // batched / set-based — no per-row loop over the updates array.
  assert.ok(
    !/for\s+\w+\s+in\s+select[^;]*from\s+jsonb_array_elements/i.test(effective),
    'set_recall_boost must be one set-based UPDATE, not a per-row loop'
  );
});

test('set_recall_boost is doctrine-clean: touches ONLY recall_boost (not content/embedding/updated_at)', () => {
  // The ONLY write in 032 is the single recall_boost UPDATE.
  const updates = effective.match(/update\s+public\.memory_items/g) ?? [];
  assert.equal(updates.length, 1, 'exactly one UPDATE (set_recall_boost) in 032');
  // No content/embedding write, and deliberately NOT updated_at — reinforcement
  // must not be conflated with a content mutation (T2 contract: only recall_boost).
  assert.ok(!/set\s+content\s*=/.test(effective), 'must not write content');
  assert.ok(!/\bupdated_at\s*=\s*now\(\)/.test(effective), 'must not bump updated_at');
  assert.ok(
    !/set[^;]*\bembedding\s*=/.test(effective),
    'must not write embedding'
  );
});

test('set_recall_boost gate 3/4: service_role-only EXECUTE, pinned search_path (no extensions)', () => {
  assert.match(
    lower,
    /revoke execute on function public\.set_recall_boost\(jsonb\)\s*\n?\s*from public, anon, authenticated/
  );
  assert.match(
    lower,
    /grant\s+execute on function public\.set_recall_boost\(jsonb\)\s*\n?\s*to service_role/
  );
  assert.match(lower, /security definer/);
  // set_recall_boost uses no vector type → search_path must be public, pg_catalog.
  assert.match(lower, /set search_path = public, pg_catalog/);
});

test('memory_hybrid_search: recall_boost factor is a bounded STRICT no-op at 1.0', () => {
  // The exact clamp: floor 1.0 (no penalty), ceiling 2.0 (no rich-get-richer),
  // coalesce guard, no-op at recall_boost = 1.0.
  assert.match(
    lower,
    /least\(greatest\(coalesce\(f\.recall_boost, 1\.0\), 1\.0\), 2\.0\)\)::double precision/
  );
  // recall_boost is threaded through candidates + fused so the factor can see it.
  assert.match(lower, /m\.recall_boost/);
  assert.match(lower, /c\.recall_boost/);
});

test('memory_hybrid_search keeps the identical signature + RETURNS TABLE (body-only change)', () => {
  // 8-arg signature unchanged.
  assert.match(lower, /create or replace function public\.memory_hybrid_search \(/);
  assert.match(lower, /query_embedding\s+vector\(1536\)/);
  assert.match(lower, /filter_source_type\s+text default null/);
  // 9-col RETURNS TABLE unchanged (privacy_tags text[] is the last column).
  assert.match(lower, /returns table \([\s\S]*privacy_tags text\[\]\s*\)/);
  // vector param → search_path retains extensions (matches 029).
  assert.match(lower, /set search_path = public, extensions, pg_catalog/);
});

test('memory_hybrid_search: overload-drop guard + REQUIRED re-pin after drop', () => {
  // Drops stale overloads before replace (mirrors 029 / ledger #17/#18).
  assert.match(lower, /select p\.oid::regprocedure as sig[\s\S]*where p\.proname = 'memory_hybrid_search'/);
  assert.match(lower, /execute 'drop function ' \|\| r\.sig::text/);
  // A DROP loses grants → re-pin REVOKE/GRANT is mandatory.
  assert.match(lower, /revoke execute on function %s from public, anon, authenticated/);
  assert.match(lower, /grant\s+execute on function %s to service_role/);
});

test('no permissive policy anywhere; no WITH CHECK (true)', () => {
  assert.ok(!/create\s+policy/i.test(effective), '032 introduces no policies');
  assert.ok(!/with\s+check\s*\(\s*true\s*\)/i.test(effective), 'no WITH CHECK (true)');
});

test('receipt is OID-form and HARD-FAILS on column/gate violations for BOTH functions', () => {
  // Both functions resolved by proname → oid (never a text signature).
  assert.match(lower, /where n\.nspname='public' and p\.proname='set_recall_boost'/);
  assert.match(lower, /where n\.nspname='public' and p\.proname='memory_hybrid_search'/);
  assert.match(lower, /has_function_privilege\('service_role',\s*v_oid/);
  for (const expected of [
    'COLUMN MISSING',
    'must be NOT NULL',
    'default must be 1.0',
    'GATE 3 VIOLATION',
    'GATE 4 VIOLATION',
  ]) {
    assert.ok(sql.includes(expected), `receipt must be able to raise: ${expected}`);
  }
});

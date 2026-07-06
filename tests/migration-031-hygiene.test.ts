/**
 * Mnestra — migration 031 static hygiene assertions (Sprint 81 T1)
 *
 * Same house idiom as migration-026/027-hygiene: read the SQL as text and pin
 * the release-blocking properties without needing a database — the three new
 * provenance columns, the collision guard (does NOT re-add 027's denorm
 * columns), the extended log_recall_hits recordset/INSERT, the preserved
 * batched (never per-row) denorm bump, the five RLS gates, and the OID-form
 * HARD-FAILING receipt.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const MIGRATION_PATH = path.join(REPO_ROOT, 'migrations', '031_recall_provenance.sql');

const sql = fs.readFileSync(MIGRATION_PATH, 'utf8');
const lower = sql.toLowerCase();

// Comment-stripped "effective" SQL for the negative scans (the header prose
// documents forbidden shapes; strip line comments so they don't trip a gate).
const effective = sql
  .split('\n')
  .map((line) => line.replace(/--.*$/, ''))
  .join('\n');

test('adds the three provenance columns (idempotent ADD COLUMN IF NOT EXISTS)', () => {
  assert.match(lower, /add column if not exists source_type text/);
  assert.match(lower, /add column if not exists token_budget int/);
  assert.match(lower, /add column if not exists recall_group_id uuid/);
});

test('collision guard: does NOT re-add 027-owned recall_count / last_recalled_at', () => {
  assert.ok(
    !/add column if not exists recall_count/i.test(effective),
    'recall_count is owned by migration 027 — must not be re-added'
  );
  assert.ok(
    !/add column if not exists last_recalled_at/i.test(effective),
    'last_recalled_at is owned by migration 027 — must not be re-added'
  );
});

test('recall_group_id is indexed for the reinjection-event lookup', () => {
  assert.match(
    lower,
    /create index if not exists memory_recall_log_group_idx\s*\n?\s*on public\.memory_recall_log \(recall_group_id\)/
  );
});

test('log_recall_hits recordset + INSERT carry the three new fields', () => {
  assert.match(lower, /create or replace function public\.log_recall_hits\(p_hits jsonb\)/);
  // recordset typing gains the three columns
  assert.match(lower, /source_type\s+text/);
  assert.match(lower, /token_budget\s+int/);
  assert.match(lower, /recall_group_id\s+uuid/);
  // INSERT column list names them
  assert.match(
    lower,
    /insert into public\.memory_recall_log[\s\S]*source_type, token_budget, recall_group_id\)/
  );
});

test('the batched (never per-row) denorm bump is preserved verbatim from 027', () => {
  assert.match(lower, /update public\.memory_items m\s+set recall_count/);
  assert.match(lower, /group by 1/);
  assert.match(lower, /jsonb_to_recordset\(p_hits\)/);
  assert.ok(
    !/for\s+\w+\s+in\s+select[^;]*from\s+jsonb_array_elements/i.test(effective),
    'no per-row loop over the hit array'
  );
});

test('gate 3: EXECUTE revoked from public/anon/authenticated, granted service_role only', () => {
  assert.match(
    lower,
    /revoke execute on function public\.log_recall_hits\(jsonb\)\s*\n?\s*from public, anon, authenticated/
  );
  assert.match(
    lower,
    /grant\s+execute on function public\.log_recall_hits\(jsonb\)\s*\n?\s*to service_role/
  );
  // No grant on log_recall_hits may name a client role.
  const grants = effective.match(/\bgrant\b[^;]*;/gi) ?? [];
  for (const stmt of grants) {
    if (/log_recall_hits/i.test(stmt)) {
      assert.ok(!/\b(anon|authenticated)\b/i.test(stmt), `grant names a client role: ${stmt}`);
    }
  }
});

test('gate 4: SECURITY DEFINER with pinned search_path = public, pg_catalog (no extensions)', () => {
  assert.match(lower, /security definer/);
  assert.match(lower, /set search_path = public, pg_catalog/);
  // 031's function types are jsonb/uuid/text/int/double precision only — no
  // vector — so `extensions` must NOT be in the pinned path (unlike 028/029).
  assert.ok(
    !/set search_path = public, extensions/i.test(effective),
    '031 has no vector type; extensions must not be in the search_path'
  );
});

test('gate 1/2 regression guards + no permissive policy anywhere', () => {
  assert.ok(!/create\s+policy/i.test(effective), '031 introduces no policies');
  assert.ok(!/with\s+check\s*\(\s*true\s*\)/i.test(effective), 'no WITH CHECK (true)');
  // Receipt re-checks RLS still on and zero policies.
  assert.match(lower, /relrowsecurity/);
  assert.match(lower, /pg_policies/);
});

test('receipt is OID-form and HARD-FAILS on gate/column/index violations', () => {
  // OID resolved by proname, never a reconstructed text signature.
  assert.match(lower, /where n\.nspname = 'public' and p\.proname = 'log_recall_hits'/);
  assert.match(lower, /has_function_privilege\('anon',\s*v_oid/);
  assert.match(lower, /has_function_privilege\('service_role',\s*v_oid/);
  for (const expected of [
    'PROVENANCE COLUMN MISSING',
    'INDEX MISSING',
    'GATE 1 REGRESSION',
    'GATE 2 REGRESSION',
    'GATE 3 VIOLATION',
    'GATE 4 VIOLATION',
  ]) {
    assert.ok(sql.includes(expected), `receipt must be able to raise: ${expected}`);
  }
  // Column-existence checks for all three new columns.
  for (const col of ['source_type', 'token_budget', 'recall_group_id']) {
    assert.ok(
      new RegExp(`column_name='${col}'`).test(sql),
      `receipt checks existence of ${col}`
    );
  }
});

test('idempotency idioms present (rerun-safe)', () => {
  const adds = lower.match(/add column if not exists/g) ?? [];
  assert.ok(adds.length >= 3, `expected >=3 ADD COLUMN IF NOT EXISTS, found ${adds.length}`);
  assert.match(lower, /create index if not exists/);
  assert.match(lower, /create or replace function/);
});

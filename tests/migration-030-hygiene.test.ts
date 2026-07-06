/**
 * Mnestra — migration 030 static hygiene assertions (Sprint 81 T1)
 *
 * Pins the pre_compact_snapshot rolling unit: the keep-newest per-session
 * collapse (reversible, never DELETE), the ARBITER-FREE ingest_capture redefine
 * (R3 — no ON CONFLICT on the deferred index), the DEFERRED integrity index
 * (present for ORCH but not active — the "real index-present" assertion moved
 * here from 028 per R4), the five gates, and the OID-form receipt.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const MIGRATION_PATH = path.join(REPO_ROOT, 'migrations', '030_precompact_rolling.sql');

const sql = fs.readFileSync(MIGRATION_PATH, 'utf8');
const lower = sql.toLowerCase();
// Comment-stripped "effective" (ACTIVE) SQL — for negative scans + active-SQL checks.
const effective = sql
  .split('\n')
  .map((line) => line.replace(/--.*$/, ''))
  .join('\n')
  .toLowerCase();
// Leading-comment-marker-stripped view — lets us assert the DEFERRED index SQL
// is present (for ORCH) even though it's commented out.
const uncommented = sql
  .split('\n')
  .map((line) => line.replace(/^\s*--\s?/, ''))
  .join('\n')
  .toLowerCase();

test('collapse keeps NEWEST per session, scoped to pre_compact_snapshot + non-null session', () => {
  // keep-newest = order by created_at DESC (028 kept oldest for content_hash;
  // here the latest snapshot is canonical).
  assert.match(lower, /array_agg\(id order by created_at desc, id desc\)\)\[1\] as keep_id/);
  assert.match(lower, /source_type = 'pre_compact_snapshot'/);
  assert.match(lower, /source_session_id is not null/);
  assert.match(lower, /group by source_session_id/);
});

test('collapse never DELETEs — reversible supersede (is_active=false + superseded_by)', () => {
  assert.ok(!/delete\s+from\s+public\.memory_items/i.test(effective), 'must never DELETE snapshot rows');
  assert.match(lower, /set\s+is_active\s+=\s+false,\s*\n\s*superseded_by\s+=\s+sg\.keep_id/);
});

test('collapse has a hard-failing completeness guard (0 remaining >1-active groups)', () => {
  assert.match(lower, /group by source_session_id having count\(\*\) > 1/);
  assert.match(sql, /BACKFILL INCOMPLETE/);
});

test('R3: ingest_capture pre_compact_snapshot branch is ARBITER-FREE (no ON CONFLICT on the deferred index)', () => {
  assert.match(lower, /create or replace function public\.ingest_capture\(p_payload jsonb\)/);
  // NO ON CONFLICT on source_session_id anywhere in the ACTIVE SQL.
  assert.ok(
    !/on conflict \(source_session_id\)/i.test(effective),
    'the precompact branch must NOT use ON CONFLICT (source_session_id) — the arbiter index is deferred'
  );
  // Instead: advisory-lock + explicit SELECT-active → UPDATE-else-INSERT.
  assert.match(lower, /pg_advisory_xact_lock\(hashtextextended\('mnestra_precompact:' \|\| v_source_session_id, 0\)\)/);
  assert.match(lower, /from public\.memory_items\s+where source_session_id = v_source_session_id\s+and source_type = 'pre_compact_snapshot'\s+and is_active = true/);
});

test('the content_hash idempotency branch is UNCHANGED (its arbiter exists)', () => {
  assert.match(lower, /on conflict \(content_hash\) where \(is_active = true\)\s*\n\s*do nothing/);
});

test('R4: the precompact integrity index is DEFERRED (present for ORCH, NOT active SQL)', () => {
  // Not active — applying 030 must NOT create it.
  assert.ok(
    !/create unique index if not exists memory_items_precompact_session_uidx/i.test(effective),
    'the precompact index must be commented (ORCH creates it LAST), not active in 030'
  );
  // But the exact SQL IS present (commented) so ORCH has it verbatim — the
  // "real index-present" assertion moved here from the 028 test.
  assert.match(
    uncommented,
    /create unique index if not exists memory_items_precompact_session_uidx\s*\n\s*on public\.memory_items \(source_session_id\)\s*\n\s*where \(source_type = 'pre_compact_snapshot' and is_active = true\)/
  );
});

test('ingest_capture gate 3/4: service_role-only EXECUTE, pinned search_path (with extensions for vector)', () => {
  assert.match(
    lower,
    /revoke execute on function public\.ingest_capture\(jsonb\)\s*\n?\s*from public, anon, authenticated/
  );
  assert.match(
    lower,
    /grant\s+execute on function public\.ingest_capture\(jsonb\)\s*\n?\s*to service_role/
  );
  assert.match(lower, /security definer/);
  assert.match(lower, /set search_path = public, extensions, pg_catalog/);
});

test('no permissive policy anywhere; no WITH CHECK (true)', () => {
  assert.ok(!/create\s+policy/i.test(effective), '030 introduces no policies');
  assert.ok(!/with\s+check\s*\(\s*true\s*\)/i.test(effective), 'no WITH CHECK (true)');
});

test('receipt is OID-form and HARD-FAILS on collapse/gate violations', () => {
  assert.match(lower, /where n\.nspname='public' and p\.proname='ingest_capture'/);
  assert.match(lower, /has_function_privilege\('service_role',\s*v_oid/);
  for (const expected of ['BACKFILL REGRESSION', 'GATE 3 VIOLATION', 'GATE 4 VIOLATION']) {
    assert.ok(sql.includes(expected), `receipt must be able to raise: ${expected}`);
  }
});

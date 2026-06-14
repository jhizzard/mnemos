/**
 * Mnestra — migration 027 static hygiene assertions (Sprint 78 T3)
 *
 * Same house idiom as migration-026-hygiene: read the SQL as text and pin the
 * five release-blocking RLS hygiene gates (× table + 3 RPCs), the batched
 * (never per-row) denorm bump, the pg_cron guard, the collision guard, and the
 * HARD-FAILING receipt block. Dumb string/regex checks that catch the
 * high-cost silent regressions (a dropped REVOKE, an "allow" policy, a per-row
 * loop) without needing a database.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// dist-tests/tests → repo root (same resolution as migration-026-hygiene).
const REPO_ROOT = path.resolve(HERE, '..', '..');
const MIGRATION_PATH = path.join(REPO_ROOT, 'migrations', '027_recall_telemetry.sql');

const sql = fs.readFileSync(MIGRATION_PATH, 'utf8');
const lower = sql.toLowerCase();

// Comment-stripped "effective" SQL for the negative scans (the header prose
// documents the forbidden shapes, e.g. "no WITH CHECK (true)", which would
// otherwise trip the gate's own assertion). No string literal in the file
// contains `--`, so a line-wise strip is safe.
const effective = sql
  .split('\n')
  .map((line) => line.replace(/--.*$/, ''))
  .join('\n');

const FN_SIGS = [
  'public.log_recall_hits(jsonb)',
  'public.mark_recall_feedback(jsonb, text)',
  'public.purge_recall_log(int)',
];

test('gate 1: RLS enabled on memory_recall_log in this same migration', () => {
  assert.match(
    lower,
    /alter table public\.memory_recall_log enable row level security/,
    'must enable RLS on the table it creates'
  );
});

test('gate 2: zero policies — no CREATE POLICY, never WITH CHECK (true)', () => {
  assert.ok(!/create\s+policy/i.test(effective), 'the telemetry table gets NO policies');
  assert.ok(
    !/with\s+check\s*\(\s*true\s*\)/i.test(effective),
    'WITH CHECK (true) is the forbidden Studio-template shape'
  );
});

test('gate 3: EXECUTE revoked from public/anon/authenticated, granted service_role only — on ALL 3 RPCs', () => {
  for (const sig of FN_SIGS) {
    const esc = sig.replace(/[.()]/g, (c) => '\\' + c);
    assert.match(
      lower,
      new RegExp(`revoke execute on function ${esc}\\s*\\n?\\s*from public, anon, authenticated`),
      `revoke must name all three default grantees for ${sig}`
    );
    assert.match(
      lower,
      new RegExp(`grant\\s+execute on function ${esc}\\s*\\n?\\s*to service_role`),
      `service_role is the sole grantee for ${sig}`
    );
  }
  // No grant on any of the 3 RPCs may name anon/authenticated.
  const grantStatements = effective.match(/\bgrant\b[^;]*;/gi) ?? [];
  for (const stmt of grantStatements) {
    if (/log_recall_hits|mark_recall_feedback|purge_recall_log/i.test(stmt)) {
      assert.ok(
        !/\b(anon|authenticated)\b/i.test(stmt),
        `a grant on a recall-log RPC names a client role: ${stmt}`
      );
    }
  }
});

test('gate 3 belt-and-suspenders: table grants revoked for anon/authenticated', () => {
  assert.match(
    lower,
    /revoke all on table public\.memory_recall_log from public, anon, authenticated/,
    'table-level default grants must be stripped'
  );
});

test('gate 4: every RPC is SECURITY DEFINER with pinned search_path = public, pg_catalog', () => {
  const definers = lower.match(/security definer/g) ?? [];
  assert.ok(definers.length >= 3, `expected 3 SECURITY DEFINER functions, found ${definers.length}`);
  const pinned = lower.match(/set search_path = public, pg_catalog/g) ?? [];
  assert.ok(pinned.length >= 3, `expected search_path pinned on 3 functions, found ${pinned.length}`);
});

test('gate 5: the only insert path is log_recall_hits; the only update path is the RPCs', () => {
  // Exactly one INSERT, into memory_recall_log, inside the RPC.
  const inserts = effective.match(/insert\s+into\s+public\.memory_recall_log/gi) ?? [];
  assert.equal(inserts.length, 1, 'memory_recall_log must have exactly one INSERT path (the RPC)');
});

test('denorm columns are added (collision-guarded for Sprint 79)', () => {
  assert.match(
    lower,
    /add column if not exists recall_count int not null default 0/,
    'recall_count denorm counter'
  );
  assert.match(
    lower,
    /add column if not exists last_recalled_at timestamptz/,
    'last_recalled_at denorm column'
  );
  // The collision guard must be documented so Sprint 79 does not re-add these.
  assert.match(sql, /Sprint 79/);
  assert.match(lower, /must not re-add|must not re-add/);
});

test('denorm bump is BATCHED / statement-level — no per-row loop over hits', () => {
  // The bump is one UPDATE ... FROM (grouped subquery), not a loop.
  assert.match(
    lower,
    /update public\.memory_items m\s+set recall_count/,
    'denorm bump must be a single set-based UPDATE'
  );
  assert.match(lower, /group by 1/, 'the bump aggregates per memory_id in one statement');
  // log_recall_hits must use set-based jsonb expansion, not a row loop.
  assert.match(lower, /jsonb_to_recordset\(p_hits\)/, 'the insert is set-based');
  // No FOR ... LOOP that iterates the hits/ids inside the writer RPCs.
  assert.ok(
    !/for\s+\w+\s+in\s+select[^;]*from\s+jsonb_array_elements/i.test(effective),
    'no per-row loop over the hit/id array'
  );
});

test('mark_recall_feedback targets the MOST-RECENT log row per id (distinct on + desc)', () => {
  assert.match(lower, /create or replace function public\.mark_recall_feedback/);
  assert.match(lower, /distinct on \(memory_id\)/);
  assert.match(lower, /order by memory_id, created_at desc/);
  // Both signals handled.
  assert.match(lower, /set cited = true/);
  assert.match(lower, /set dismissed = true/);
});

test('purge_recall_log ages out >90d rows; rollup survives by construction', () => {
  assert.match(lower, /create or replace function public\.purge_recall_log/);
  assert.match(lower, /delete from public\.memory_recall_log/);
  assert.match(lower, /make_interval\(days =>/);
});

test('pg_cron purge job: guarded on extension presence + idempotent (unschedule before schedule)', () => {
  assert.match(lower, /if exists \(select 1 from pg_extension where extname = 'pg_cron'\)/);
  assert.match(lower, /cron\.unschedule\('mnestra-recall-log-purge'\)/);
  assert.match(lower, /cron\.schedule\(\s*\n?\s*'mnestra-recall-log-purge'/);
  assert.match(lower, /select public\.purge_recall_log\(90\)/);
});

test('idempotency idioms: IF NOT EXISTS + CREATE OR REPLACE + ADD COLUMN IF NOT EXISTS', () => {
  assert.match(lower, /create table if not exists public\.memory_recall_log/);
  const idx = lower.match(/create index if not exists/g) ?? [];
  assert.ok(idx.length >= 3, `expected >=3 indexes, found ${idx.length}`);
  const replaces = lower.match(/create or replace function/g) ?? [];
  assert.ok(replaces.length >= 3, `expected >=3 functions, found ${replaces.length}`);
  const adds = lower.match(/add column if not exists/g) ?? [];
  assert.ok(adds.length >= 2, `expected 2 denorm columns, found ${adds.length}`);
});

test('receipt block exists and HARD-FAILS on gate violations', () => {
  for (const expected of [
    'relrowsecurity',
    'pg_policies',
    "has_function_privilege('anon'",
    "has_function_privilege('authenticated'",
    "has_function_privilege('public'",
    "has_function_privilege('service_role'",
    'GATE 1 VIOLATION',
    'GATE 2 VIOLATION',
    'GATE 3 VIOLATION',
    'GATE 4 VIOLATION',
  ]) {
    assert.ok(sql.includes(expected), `receipt block must check/raise: ${expected}`);
  }
  // The receipt iterates all three function signatures.
  assert.match(sql, /public\.log_recall_hits\(jsonb\)/);
  assert.match(sql, /public\.mark_recall_feedback\(jsonb,text\)/);
  assert.match(sql, /public\.purge_recall_log\(integer\)/);
});

test('query_preview is documented as redacted + has a DB-level length cap', () => {
  assert.match(lower, /query_preview/);
  assert.match(lower, /redact/);
  // DB-level backstop on top of the TS redactor's <=120 truncation.
  assert.match(lower, /left\(h\.query_preview, 200\)/);
});

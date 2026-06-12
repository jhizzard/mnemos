/**
 * Mnestra — migration 026 static hygiene assertions (Sprint 76 T1)
 *
 * House idiom (gitleaks-style static checks): read the migration SQL as
 * text and pin the five release-blocking RLS hygiene gates plus the
 * TS <-> SQL contract lockstep (whitelist values + cap numbers). These are
 * deliberately dumb string/regex checks — they catch the high-cost silent
 * regressions (a dropped REVOKE, a helpful "allow insert" policy, a cap
 * number drifting on one side) without needing a database.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  PROPOSE_TEXT_MAX_CHARS,
  PROPOSE_PROJECT_HINT_MAX_CHARS,
  PROPOSE_METADATA_MAX_BYTES,
  PROPOSE_REJECTED_PREFIX,
} from '../src/propose.js';
import { WEB_SOURCE_AGENTS } from '../src/types.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// dist-tests/tests → repo root (same resolution as main-field.test.ts).
const REPO_ROOT = path.resolve(HERE, '..', '..');
const MIGRATION_PATH = path.join(REPO_ROOT, 'migrations', '026_memory_inbox.sql');

const sql = fs.readFileSync(MIGRATION_PATH, 'utf8');
const lower = sql.toLowerCase();

// The migration documents the forbidden shapes in its comments ("no WITH
// CHECK (true)", "no create policy …"), so the negative checks must scan
// the EFFECTIVE SQL with `-- …` comments stripped — otherwise the prose
// that explains a gate would trip the gate's own assertion. (No string
// literal in the file contains `--`, so a line-wise strip is safe.)
const effective = sql
  .split('\n')
  .map((line) => line.replace(/--.*$/, ''))
  .join('\n');

test('gate 1: RLS is enabled on memory_inbox in this same migration', () => {
  assert.match(
    lower,
    /alter table public\.memory_inbox enable row level security/,
    'migration must enable RLS on the table it creates'
  );
});

test('gate 2: zero policies — no CREATE POLICY, and never WITH CHECK (true)', () => {
  assert.ok(
    !/create\s+policy/i.test(effective),
    'the quarantine table gets NO policies at all'
  );
  assert.ok(
    !/with\s+check\s*\(\s*true\s*\)/i.test(effective),
    'WITH CHECK (true) is the forbidden Studio-template shape'
  );
});

test('gate 3: EXECUTE revoked from public/anon/authenticated; granted to service_role only', () => {
  assert.match(
    lower,
    /revoke execute on function public\.memory_propose\(text, text, text, jsonb\)\s*\n?\s*from public, anon, authenticated/,
    'the function must be revoked from all three default grantees (migration 014 default privileges)'
  );
  assert.match(
    lower,
    /grant\s+execute on function public\.memory_propose\(text, text, text, jsonb\)\s*\n?\s*to service_role/,
    'service_role is the sole grantee'
  );
  // No grant statement on the RPC may name anon or authenticated
  // (statements scanned over comment-stripped SQL).
  const grantStatements = effective.match(/\bgrant\b[^;]*;/gi) ?? [];
  assert.ok(grantStatements.length >= 1, 'sanity: the grant statement is visible to the scan');
  for (const stmt of grantStatements) {
    if (/memory_propose/i.test(stmt)) {
      assert.ok(
        !/\b(anon|authenticated)\b/i.test(stmt),
        `a grant on memory_propose names a client role: ${stmt}`
      );
    }
  }
});

test('gate 3 belt-and-suspenders: table grants revoked for anon/authenticated', () => {
  assert.match(
    lower,
    /revoke all on table public\.memory_inbox from public, anon, authenticated/,
    'table-level default grants must be stripped'
  );
});

test('gate 4: SECURITY DEFINER with pinned search_path = public, pg_catalog', () => {
  assert.match(lower, /security definer/);
  assert.match(
    lower,
    /set search_path = public, pg_catalog/,
    'SECURITY DEFINER without a pinned search_path is the shadow-attack primitive'
  );
});

test('gate 5: the RPC is the only insert path — status hardcoded, no status parameter', () => {
  // The INSERT names only the four caller-supplied columns; status rides
  // the column default ('pending') and is not insertable via the RPC.
  assert.match(
    lower,
    /insert into public\.memory_inbox \(source_agent, project_hint, text, metadata\)/,
    'the RPC INSERT must not accept a status'
  );
  assert.ok(
    !/p_status/i.test(sql),
    'no status parameter: a proposer cannot mint a pre-promoted row'
  );
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
});

test('TS <-> SQL lockstep: the whitelist is exactly WEB_SOURCE_AGENTS', () => {
  // The SQL whitelist line: v_agent not in ('claude-web', 'chatgpt-web', …)
  const whitelistMatch = sql.match(/v_agent not in \(([^)]+)\)/i);
  assert.ok(whitelistMatch, 'the RPC must whitelist via v_agent not in (…)');
  const sqlValues = whitelistMatch![1]!
    .split(',')
    .map((s) => s.trim().replace(/^'|'$/g, ''))
    .sort();
  assert.deepEqual(
    sqlValues,
    ([...WEB_SOURCE_AGENTS] as string[]).sort(),
    'SQL whitelist and WEB_SOURCE_AGENTS must stay in lockstep (SQL cannot import types.ts; this test is the link)'
  );
  // And no CLI value ever appears in the whitelist.
  for (const cli of ['claude', 'codex', 'gemini', 'grok', 'orchestrator']) {
    assert.ok(!sqlValues.includes(cli), `CLI value '${cli}' must never be proposable`);
  }
});

test('TS <-> SQL lockstep: cap numbers match the exported constants', () => {
  assert.equal(PROPOSE_TEXT_MAX_CHARS, 4000);
  assert.equal(PROPOSE_PROJECT_HINT_MAX_CHARS, 128);
  assert.equal(PROPOSE_METADATA_MAX_BYTES, 8192);
  assert.match(lower, new RegExp(`length\\(v_text\\) > ${PROPOSE_TEXT_MAX_CHARS}\\b`));
  assert.match(lower, new RegExp(`length\\(v_hint\\) > ${PROPOSE_PROJECT_HINT_MAX_CHARS}\\b`));
  assert.match(lower, new RegExp(`pg_column_size\\(v_meta\\) > ${PROPOSE_METADATA_MAX_BYTES}\\b`));
});

test('rejections carry the stable machine-matchable prefix', () => {
  assert.equal(PROPOSE_REJECTED_PREFIX, 'MEMORY_PROPOSE_REJECTED');
  const raises = sql.match(/raise exception 'MEMORY_PROPOSE_REJECTED: [a-z_]+/g) ?? [];
  const reasons = raises.map((r) => r.replace(/^.*: /, '')).sort();
  assert.deepEqual(
    reasons,
    [
      'empty_text',
      'invalid_source_agent',
      'metadata_not_object',
      'metadata_too_large',
      'project_hint_too_long',
      'text_too_long',
    ],
    'the SQL reason-code vocabulary is pinned (T2 surfaces these; T3 mirrors the caps)'
  );
});

test('source_agent column has NO CHECK constraint (fail-soft doctrine); status DOES', () => {
  // status: controlled writers, CHECK is pure safety.
  assert.match(lower, /check \(status in \('pending', 'promoted', 'rejected'\)\)/);
  // source_agent: the whitelist lives in the RPC, not a column constraint.
  // No CHECK may mention source_agent (the comment-documented 025 doctrine).
  const checkClauses = sql.match(/check\s*\([^)]*\)/gi) ?? [];
  for (const clause of checkClauses) {
    assert.ok(
      !/source_agent/i.test(clause),
      `source_agent must not be CHECK-constrained (found: ${clause})`
    );
  }
});

test('audit-trail consistency CHECKs are present', () => {
  assert.match(lower, /promoted_memory_id is null or status = 'promoted'/);
  assert.match(lower, /rejection_reason is null or status = 'rejected'/);
});

test('idempotency idioms: IF NOT EXISTS + CREATE OR REPLACE', () => {
  assert.match(lower, /create table if not exists public\.memory_inbox/);
  assert.match(lower, /create index if not exists memory_inbox_status_pending_idx/);
  assert.match(lower, /create index if not exists memory_inbox_created_at_idx/);
  assert.match(lower, /create index if not exists memory_inbox_source_agent_idx/);
  assert.match(lower, /create or replace function public\.memory_propose/);
});

test('FK to memory_items uses ON DELETE SET NULL (audit trail survives hard deletes)', () => {
  assert.match(
    lower,
    /references public\.memory_items\(id\) on delete set null/
  );
});

// (No internal-identifier scan here on purpose: the gitleaks pre-commit +
// pre-push hooks are the load-bearing, repo-wide defense for that class —
// a test would have to embed the forbidden literals in a public file to
// check for them, which is the violation itself.)

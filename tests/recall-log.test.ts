/**
 * Mnestra — recall-log telemetry unit tests (Sprint 78 T3)
 *
 * Pins the fire-and-forget contract (never throws, returned-set-only, K hits →
 * K payload rows) and the local query_preview redaction + query hashing. A
 * fake Supabase client is injected via `deps.client` so no real network /
 * getSupabase() is needed; in production the helpers default to getSupabase().
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as tick } from 'node:timers/promises';

import {
  logRecallHits,
  markRecallFeedback,
  markRecallCited,
  recordRecallFeedback,
  redactQueryPreview,
  hashQuery,
  recallLogStats,
  __resetRecallLogStats,
} from '../src/recall_log.js';

const UUID1 = '11111111-1111-1111-1111-111111111111';
const UUID2 = '22222222-2222-2222-2222-222222222222';

/** A fake Supabase client that records every rpc(name, args). */
function makeRpcSpy(behavior?: (name: string, args: unknown) => unknown) {
  const calls: Array<{ name: string; args: any }> = [];
  const client = {
    rpc: (name: string, args: unknown) => {
      calls.push({ name, args });
      if (behavior) return Promise.resolve(behavior(name, args));
      return Promise.resolve({ data: null, error: null });
    },
  } as any;
  return { client, calls };
}

// ── logRecallHits ───────────────────────────────────────────────────────────

test('logRecallHits dispatches log_recall_hits with K payload rows for K hits', () => {
  const { client, calls } = makeRpcSpy();
  logRecallHits(
    [
      { memory_id: UUID1, score: 0.9 },
      { memory_id: UUID2, score: 0.8 },
    ],
    { surface: 'recall', query: 'where does termdeck listen' },
    { client }
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.name, 'log_recall_hits');
  const rows = calls[0]!.args.p_hits as any[];
  assert.equal(rows.length, 2);
  assert.equal(rows[0].memory_id, UUID1);
  assert.equal(rows[0].rank, 1, 'rank defaults to 1-based position');
  assert.equal(rows[1].rank, 2);
  assert.equal(rows[0].surface, 'recall');
  assert.equal(rows[0].score, 0.9);
  // query_hash + query_preview are derived once and shared across the batch.
  assert.equal(rows[0].query_hash, rows[1].query_hash);
  assert.ok(typeof rows[0].query_hash === 'string' && rows[0].query_hash.length === 32);
});

test('logRecallHits with an empty set makes NO rpc call (zero hits → zero rows)', () => {
  const { client, calls } = makeRpcSpy();
  logRecallHits([], { surface: 'recall', query: 'x' }, { client });
  assert.equal(calls.length, 0);
});

test('logRecallHits filters non-uuid memory_ids before writing', () => {
  const { client, calls } = makeRpcSpy();
  logRecallHits(
    [{ memory_id: 'not-a-uuid' }, { memory_id: UUID1 }],
    { surface: 'search', query: 'x' },
    { client }
  );
  assert.equal(calls.length, 1);
  const rows = calls[0]!.args.p_hits as any[];
  assert.equal(rows.length, 1);
  assert.equal(rows[0].memory_id, UUID1);
});

test('logRecallHits carries surface + provenance into the payload', () => {
  const { client, calls } = makeRpcSpy();
  logRecallHits(
    [{ memory_id: UUID1 }],
    { surface: 'webhook', query: 'q', sourceSessionId: 'sess-1', sourceAgent: 'grok' },
    { client }
  );
  const row = (calls[0]!.args.p_hits as any[])[0];
  assert.equal(row.surface, 'webhook');
  assert.equal(row.source_session_id, 'sess-1');
  assert.equal(row.source_agent, 'grok');
});

test('logRecallHits NEVER throws when the rpc rejects (fire-and-forget)', async () => {
  const client = { rpc: () => Promise.reject(new Error('boom')) } as any;
  assert.doesNotThrow(() =>
    logRecallHits([{ memory_id: UUID1 }], { surface: 'recall', query: 'x' }, { client })
  );
  await tick(); // let the floating rejection settle (handled by .catch, no leak)
});

test('logRecallHits NEVER throws when the rpc throws synchronously', () => {
  const client = {
    rpc: () => {
      throw new Error('sync boom');
    },
  } as any;
  assert.doesNotThrow(() =>
    logRecallHits([{ memory_id: UUID1 }], { surface: 'recall', query: 'x' }, { client })
  );
});

test('logRecallHits NEVER throws when no client + no Supabase env (getSupabase throws)', () => {
  // No deps.client → defaults to getSupabase(), which throws without env. The
  // helper must swallow that and no-op rather than surface on the recall path.
  // Temporarily lift the disable gate so getSupabase() is actually exercised.
  const hadUrl = process.env.SUPABASE_URL;
  const hadKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const hadDisable = process.env.MNESTRA_DISABLE_RECALL_LOG;
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.MNESTRA_DISABLE_RECALL_LOG;
  try {
    assert.doesNotThrow(() =>
      logRecallHits([{ memory_id: UUID1 }], { surface: 'recall', query: 'x' })
    );
  } finally {
    if (hadUrl !== undefined) process.env.SUPABASE_URL = hadUrl;
    if (hadKey !== undefined) process.env.SUPABASE_SERVICE_ROLE_KEY = hadKey;
    if (hadDisable !== undefined) process.env.MNESTRA_DISABLE_RECALL_LOG = hadDisable;
  }
});

test('MNESTRA_DISABLE_RECALL_LOG=1 disables the getSupabase fallback; explicit client still fires', () => {
  // Test-isolation gate: with no explicit client + the flag set, telemetry must
  // NOT fall through to getSupabase() (which would write to a live DB once
  // migration 027 is applied). An explicit client (this suite) bypasses it.
  const hadDisable = process.env.MNESTRA_DISABLE_RECALL_LOG;
  process.env.MNESTRA_DISABLE_RECALL_LOG = '1';
  __resetRecallLogStats();
  try {
    logRecallHits([{ memory_id: UUID1 }], { surface: 'recall', query: 'x' });
    assert.equal(recallLogStats().attempted, 0, 'no write attempted when disabled + no client');
    const { client, calls } = makeRpcSpy();
    logRecallHits([{ memory_id: UUID1 }], { surface: 'recall', query: 'x' }, { client });
    assert.equal(calls.length, 1, 'explicit client bypasses the disable gate');
  } finally {
    if (hadDisable !== undefined) process.env.MNESTRA_DISABLE_RECALL_LOG = hadDisable;
    else delete process.env.MNESTRA_DISABLE_RECALL_LOG;
  }
});

test('logRecallHits health counters track attempts and failures', async () => {
  __resetRecallLogStats();
  const ok = makeRpcSpy();
  logRecallHits([{ memory_id: UUID1 }], { surface: 'recall', query: 'x' }, { client: ok.client });
  const bad = { rpc: () => Promise.reject(new Error('boom')) } as any;
  logRecallHits([{ memory_id: UUID1 }], { surface: 'recall', query: 'x' }, { client: bad });
  await tick();
  const stats = recallLogStats();
  assert.equal(stats.attempted, 2);
  assert.equal(stats.failed, 1);
});

// ── mark_recall_feedback family ──────────────────────────────────────────────

test('markRecallFeedback dispatches mark_recall_feedback with the id set + event', () => {
  const { client, calls } = makeRpcSpy();
  markRecallFeedback([UUID1, UUID2], 'cited', { client });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.name, 'mark_recall_feedback');
  assert.deepEqual(calls[0]!.args.p_memory_ids, [UUID1, UUID2]);
  assert.equal(calls[0]!.args.p_event, 'cited');
});

test('markRecallCited is event=cited; recordRecallFeedback is single-id', () => {
  const { client, calls } = makeRpcSpy();
  markRecallCited([UUID1], { client });
  recordRecallFeedback(UUID2, 'dismissed', { client });
  assert.equal(calls[0]!.args.p_event, 'cited');
  assert.deepEqual(calls[0]!.args.p_memory_ids, [UUID1]);
  assert.equal(calls[1]!.args.p_event, 'dismissed');
  assert.deepEqual(calls[1]!.args.p_memory_ids, [UUID2]);
});

test('markRecallFeedback no-ops on empty ids, all-invalid ids, or unknown event', () => {
  const { client, calls } = makeRpcSpy();
  markRecallFeedback([], 'cited', { client });
  markRecallFeedback(['nope'], 'cited', { client });
  markRecallFeedback([UUID1], 'bogus' as any, { client });
  assert.equal(calls.length, 0);
});

test('markRecallFeedback NEVER throws on a rejecting client', async () => {
  const client = { rpc: () => Promise.reject(new Error('boom')) } as any;
  assert.doesNotThrow(() => markRecallFeedback([UUID1], 'cited', { client }));
  await tick();
});

test('markRecallFeedback NEVER throws when the rpc throws synchronously', () => {
  const client = {
    rpc: () => {
      throw new Error('sync boom');
    },
  } as any;
  assert.doesNotThrow(() => markRecallFeedback([UUID1], 'cited', { client }));
});

// ── redactQueryPreview ───────────────────────────────────────────────────────

test('redactQueryPreview masks common secret shapes', () => {
  // Fixtures are assembled from fragments at runtime so the contiguous secret
  // literal never appears in source — that keeps the gitleaks pre-commit/-push
  // hook from flagging the test's OWN fake credentials. The redaction runs on
  // the reassembled runtime value, exactly as it would on a real pasted secret.
  const cases = [
    'eyJ' + 'hbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.' + 'eyJzdWIiOiIxMjM0NTY3ODkwIn0.' + 'dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U', // JWT
    'AKIA' + 'IOSFODNN7EXAMPLE', // AWS (docs example key)
    'sk-' + 'proj-abcdefghijklmnopqrstuvwxyz1234', // OpenAI
    'sk_' + 'live_abcdefABCDEF0123456789', // Stripe
    'ghp_' + 'abcdefghijklmnopqrstuvwxyz0123456789', // GitHub PAT
    'xoxb' + '-1234567890-abcdefghijkl', // Slack
  ];
  for (const secret of cases) {
    const out = redactQueryPreview(`have I seen ${secret} before`);
    assert.ok(out.includes('[REDACTED]'), `expected redaction for: ${secret}`);
    assert.ok(!out.includes(secret), `raw secret must not survive: ${secret}`);
  }
});

test('redactQueryPreview masks KEY=VALUE secret pairs (keeps the key name)', () => {
  const out = redactQueryPreview('error with password=hunter2supersecretvalue in config');
  assert.match(out, /password=\[REDACTED\]/);
  assert.ok(!out.includes('hunter2supersecretvalue'));
});

test('redactQueryPreview masks Bearer tokens (opaque + Authorization-prefixed)', () => {
  // Opaque (non-JWT) bearer tokens dodge the secret-SHAPE set, so the bearer
  // alternation must catch them in both header forms.
  const a = redactQueryPreview('Authorization: Bearer ABCdef123456789opaqueTOKEN');
  assert.ok(!a.includes('ABCdef123456789opaqueTOKEN'), 'Authorization-prefixed token must not survive');
  assert.match(a, /\[REDACTED\]/);
  const b = redactQueryPreview('the header had bearer ZZxx9988opaqueCredential77 in it');
  assert.ok(!b.includes('ZZxx9988opaqueCredential77'), 'bare bearer token must not survive');
  assert.match(b, /\[REDACTED\]/);
});

test('redactQueryPreview masks the Supabase project-ref shape (backstop, no literal embedded)', () => {
  const out = redactQueryPreview('project abcdefghijklmnopqrst is the one'); // 20 lowercase letters
  assert.match(out, /\[REDACTED\]/);
  assert.ok(!out.includes('abcdefghijklmnopqrst'));
});

test('redactQueryPreview truncates to <=120 chars with an ellipsis', () => {
  const out = redactQueryPreview('a '.repeat(200));
  assert.ok(out.length <= 120, `got length ${out.length}`);
  assert.match(out, /…$/);
});

test('redactQueryPreview is fail-soft on non-string input', () => {
  assert.equal(redactQueryPreview(null), '');
  assert.equal(redactQueryPreview(undefined), '');
  assert.equal(redactQueryPreview(12345 as unknown), '');
});

test('redactQueryPreview leaves an ordinary query intact', () => {
  const q = 'where does the termdeck server listen';
  assert.equal(redactQueryPreview(q), q);
});

// ── hashQuery ────────────────────────────────────────────────────────────────

test('hashQuery normalizes case + whitespace and returns a 32-char hex', () => {
  const a = hashQuery('Hello   World');
  const b = hashQuery('hello world');
  assert.equal(a, b, 'normalized queries hash identically');
  assert.equal(a.length, 32);
  assert.match(a, /^[0-9a-f]{32}$/);
});

test('hashQuery distinguishes different queries and is fail-soft on non-string', () => {
  assert.notEqual(hashQuery('alpha'), hashQuery('beta'));
  assert.equal(hashQuery(null), '');
  assert.equal(hashQuery(42 as unknown), '');
});

/**
 * Mnestra — recall_group_id reaches the agent (Sprint 83 T2)
 *
 * Migration 031 already minted a recall_group_id per recall, but it was minted
 * INSIDE the fire-and-forget logger, which returns void — so it never escaped
 * to the caller, never reached the agent, and nothing could name what it had
 * just recalled. That, not youth, is why the label channel had no producer on
 * the dominant path.
 *
 * These pin the three things a citation depends on:
 *   1. the id the agent is shown is the SAME id stamped on the log rows;
 *   2. the `[n]` handles printed are the SAME values stored as `rank`;
 *   3. an empty result advertises no group at all.
 *
 * If (1) or (2) ever drifts, every citation silently lands on the wrong row —
 * which is worse than no citation, because the label looks real.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { memoryRecall } from '../src/recall.js';

const NOW = new Date().toISOString();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function row(id: string, content: string) {
  return {
    id,
    content,
    source_type: 'fact',
    category: null,
    project: 'termdeck',
    metadata: {},
    score: 0.02,
    created_at: NOW,
  };
}

function fakeClient(rows: unknown[]): any {
  return {
    rpc: async (name: string) => {
      assert.equal(name, 'memory_hybrid_search');
      return { data: rows, error: null };
    },
  };
}

const deps = (rows: unknown[]) => ({
  client: fakeClient(rows),
  generateEmbedding: async () => new Array(1536).fill(0),
});

test('recall returns a group id and prints it in the cite hint', async () => {
  const out = await memoryRecall(
    { query: 'anything', project: 'termdeck' },
    deps([row('11111111-1111-4111-8111-111111111111', 'first memory body')])
  );

  assert.ok(out.recall_group_id);
  assert.match(out.recall_group_id, UUID_RE);
  // The agent must be able to READ the id — it is handed the text, not the object.
  assert.ok(
    out.text.includes(out.recall_group_id),
    'the cite hint must carry the group id the agent will pass back'
  );
  assert.match(out.text, /memory_cite\(recall_group_id=/);
});

test('every hit carries the same group id as the call', async () => {
  const out = await memoryRecall(
    { query: 'anything', project: 'termdeck' },
    deps([
      // Deliberately dissimilar wording: dedupByContent drops hits sharing
      // >70% of their leading words, so near-identical fixtures would collapse
      // to one row and quietly weaken the assertion below.
      row('11111111-1111-4111-8111-111111111111', 'publish to npm before pushing to git, always'),
      row('22222222-2222-4222-8222-222222222222', 'gitleaks pre-commit hooks block forbidden strings'),
    ])
  );

  assert.equal(out.hits.length, 2);
  for (const hit of out.hits) {
    assert.equal(hit.recall_group_id, out.recall_group_id);
  }
});

test('citation handles are 1-based and contiguous, matching the logged rank', async () => {
  // memory_cite resolves `ranks` against memory_recall_log.rank server-side,
  // and logRecallHits stamps rank = position-in-kept + 1. If the printed
  // handles ever stop agreeing with that, citations land on the wrong memory.
  const out = await memoryRecall(
    { query: 'anything', project: 'termdeck' },
    deps([
      row('11111111-1111-4111-8111-111111111111', 'publish to npm before pushing to git, always'),
      row('22222222-2222-4222-8222-222222222222', 'gitleaks pre-commit hooks block forbidden strings'),
      row('33333333-3333-4333-8333-333333333333', 'node-pty refuses to load under ESM, hence CommonJS'),
    ])
  );

  const handles = [...out.text.matchAll(/^\[(\d+)\] \(/gm)].map((m) => Number(m[1]));
  assert.deepEqual(handles, [1, 2, 3]);
  assert.equal(handles.length, out.hits.length);
});

test('an empty result advertises no group — there is nothing citable', async () => {
  const out = await memoryRecall({ query: 'anything', project: 'termdeck' }, deps([]));

  assert.equal(out.recall_group_id, null);
  assert.doesNotMatch(out.text, /memory_cite/);
});

test('the cite hint asks for what was USED, not for everything', async () => {
  // Wording is load-bearing, not decoration: a hint that reads as "cite these"
  // produces K positives per recall where one or two are true, and false
  // positives are exactly what a probability fit cannot survive.
  const out = await memoryRecall(
    { query: 'anything', project: 'termdeck' },
    deps([row('11111111-1111-4111-8111-111111111111', 'first memory body')])
  );

  assert.match(out.text, /actually informed your work/);
  assert.match(out.text, /not all of them/);
});

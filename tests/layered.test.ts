/**
 * Mnestra — layered tools unit tests
 *
 * Drives dispatchOp() with mocked deps for the three-layer search surface
 * (memory_index → memory_timeline → memory_get).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { dispatchOp, type OpDeps } from '../src/webhook-server.js';
import type { RecallOutput } from '../src/recall.js';
import type { IndexHit } from '../src/layered.js';
import type { MemoryItem, StatusReport } from '../src/types.js';

function mockDeps(overrides: Partial<OpDeps> = {}): OpDeps {
  const emptyStatus: StatusReport = {
    total_active: 0,
    sessions: 0,
    by_project: {},
    by_source_type: {},
    by_category: {},
  };
  return {
    remember: async () => 'inserted',
    recall: async () =>
      ({ hits: [], tokens_used: 0, text: '', recall_group_id: null }) satisfies RecallOutput,
    search: async () => [],
    status: async () => emptyStatus,
    index: async () => [],
    timeline: async () => [],
    get: async () => [],
    propose: async () => ({ id: '00000000-0000-0000-0000-000000000099' }),
    ...overrides,
  };
}

const sampleHit: IndexHit = {
  id: '11111111-2222-3333-4444-555555555555',
  snippet: 'TermDeck listens on :3000',
  source_type: 'fact',
  project: 'termdeck',
  created_at: '2026-04-13T00:00:00.000Z',
};

const sampleItem: MemoryItem = {
  id: sampleHit.id,
  content: 'TermDeck listens on :3000',
  source_type: 'fact',
  category: null,
  project: 'termdeck',
  metadata: {},
  is_active: true,
  archived: false,
  superseded_by: null,
  created_at: sampleHit.created_at,
  updated_at: sampleHit.created_at,
};

test('index → get round-trip: pick IDs from index, resolve to full rows', async () => {
  const deps = mockDeps({
    index: async (input) => {
      assert.equal(input.query, 'termdeck port');
      return [sampleHit];
    },
    get: async ({ ids }) => {
      assert.deepEqual(ids, [sampleHit.id]);
      return [sampleItem];
    },
  });

  const indexRes = await dispatchOp({ op: 'index', query: 'termdeck port' }, deps);
  assert.equal(indexRes.status, 200);
  const indexBody = indexRes.body as { ok: boolean; hits: IndexHit[] };
  assert.equal(indexBody.ok, true);
  assert.equal(indexBody.hits.length, 1);
  const pickedIds = indexBody.hits.map((h) => h.id);

  const getRes = await dispatchOp({ op: 'get', ids: pickedIds }, deps);
  assert.equal(getRes.status, 200);
  const getBody = getRes.body as { ok: boolean; rows: MemoryItem[] };
  assert.equal(getBody.rows.length, 1);
  assert.equal(getBody.rows[0]!.id, sampleHit.id);
  assert.equal(getBody.rows[0]!.content, 'TermDeck listens on :3000');
});

test('timeline forwards around_id and window', async () => {
  let captured: { around_id?: string; window?: string } = {};
  const deps = mockDeps({
    timeline: async (input) => {
      captured = { around_id: input.around_id, window: input.window };
      return [sampleHit];
    },
  });
  const res = await dispatchOp(
    { op: 'timeline', around_id: sampleHit.id, window: '7d' },
    deps
  );
  assert.equal(res.status, 200);
  const body = res.body as { ok: boolean; hits: IndexHit[] };
  assert.equal(body.hits.length, 1);
  assert.equal(captured.around_id, sampleHit.id);
  assert.equal(captured.window, '7d');
});

test('get rejects empty ids', async () => {
  const deps = mockDeps({
    get: async () => {
      throw new Error('should not be called');
    },
  });
  const res = await dispatchOp({ op: 'get' }, deps);
  assert.equal(res.status, 400);
});

test('index rejects missing query', async () => {
  const res = await dispatchOp({ op: 'index' }, mockDeps());
  assert.equal(res.status, 400);
});

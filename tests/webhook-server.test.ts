/**
 * Mnestra — webhook-server unit tests
 *
 * Drives dispatchOp() with mocked deps so no Supabase client is required.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';

import { dispatchOp, startWebhookServer, type OpDeps } from '../src/webhook-server.js';
import type { RecallOutput } from '../src/recall.js';
import type { RecallHit, StatusReport } from '../src/types.js';

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
      ({ hits: [], tokens_used: 0, text: 'No relevant memories found.', recall_group_id: null }) satisfies RecallOutput,
    search: async () => [],
    status: async () => emptyStatus,
    index: async () => [],
    timeline: async () => [],
    get: async () => [],
    propose: async () => ({ id: '00000000-0000-0000-0000-000000000099' }),
    ...overrides,
  };
}

test('dispatchOp recall returns JSON shape matching MCP stdio output', async () => {
  const fakeHit: RecallHit = {
    id: '11111111-2222-3333-4444-555555555555',
    content: 'TermDeck server listens on :3000',
    source_type: 'fact',
    category: null,
    project: 'termdeck',
    score: 0.91,
    metadata: { importance: 'important' },
    created_at: '2026-04-13T00:00:00.000Z',
  };

  let captured: { query?: string; project?: string | null } = {};
  const deps = mockDeps({
    recall: async (input) => {
      captured = { query: input.query, project: input.project ?? null };
      return {
        hits: [fakeHit],
        tokens_used: 42,
        text: '1 memory (42 tokens, project: termdeck):\n\n[1] (fact/important) TermDeck server listens on :3000',
        recall_group_id: 'b0f0d6b2-6a9f-4a2f-8f4a-2c1d9f0e3a11',
      };
    },
  });

  const result = await dispatchOp(
    { op: 'recall', question: 'where does termdeck listen', project: 'termdeck' },
    deps
  );

  assert.equal(result.status, 200);
  const body = result.body as {
    ok: boolean;
    hits: RecallHit[];
    tokens_used: number;
    text: string;
  };
  assert.equal(body.ok, true);
  assert.equal(body.tokens_used, 42);
  assert.equal(body.hits.length, 1);
  assert.equal(body.hits[0]!.id, fakeHit.id);
  assert.equal(body.hits[0]!.source_type, 'fact');
  assert.match(body.text, /TermDeck server listens on :3000/);

  assert.equal(captured.query, 'where does termdeck listen');
  assert.equal(captured.project, 'termdeck');
});

test('dispatchOp remember forwards content and returns result', async () => {
  let captured = '';
  const deps = mockDeps({
    remember: async (input) => {
      captured = input.content;
      return 'inserted';
    },
  });

  const result = await dispatchOp(
    { op: 'remember', content: 'Session started at 9am', project: 'mnestra' },
    deps
  );
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { ok: true, result: 'inserted' });
  assert.equal(captured, 'Session started at 9am');
});

test('dispatchOp remember forwards source_agent (Sprint 74 T1 — the webhook used to drop it)', async () => {
  let capturedAgent: string | null | undefined = 'sentinel-not-touched';
  const deps = mockDeps({
    remember: async (input) => {
      capturedAgent = input.source_agent;
      return 'inserted';
    },
  });

  const result = await dispatchOp(
    {
      op: 'remember',
      content: 'web-chat grok panel capture',
      project: 'termdeck',
      source_agent: 'grok-web',
    },
    deps
  );
  assert.equal(result.status, 200);
  assert.equal(
    capturedAgent,
    'grok-web',
    'TermDeck has sent source_agent since Sprint 50; the webhook must no longer silently null provenance'
  );
});

test('dispatchOp remember without source_agent leaves the field undefined (back-compat)', async () => {
  let capturedAgent: string | null | undefined = 'sentinel-not-touched';
  const deps = mockDeps({
    remember: async (input) => {
      capturedAgent = input.source_agent;
      return 'inserted';
    },
  });

  const result = await dispatchOp(
    { op: 'remember', content: 'a payload from an older hook build' },
    deps
  );
  assert.equal(result.status, 200);
  assert.equal(capturedAgent, undefined);
});

test('dispatchOp status returns report fields', async () => {
  const deps = mockDeps({
    status: async () => ({
      total_active: 2600,
      sessions: 42,
      by_project: { termdeck: 1000, mnestra: 1600 },
      by_source_type: { fact: 2000, decision: 600 },
      by_category: { technical: 2600 },
    }),
  });
  const result = await dispatchOp({ op: 'status' }, deps);
  assert.equal(result.status, 200);
  const body = result.body as { ok: boolean; total_active: number; by_project: Record<string, number> };
  assert.equal(body.ok, true);
  assert.equal(body.total_active, 2600);
  assert.equal(body.by_project.termdeck, 1000);
});

test('dispatchOp rejects missing op', async () => {
  const result = await dispatchOp({ foo: 'bar' }, mockDeps());
  assert.equal(result.status, 400);
});

test('dispatchOp rejects unknown op', async () => {
  const result = await dispatchOp({ op: 'nope' }, mockDeps());
  assert.equal(result.status, 400);
});

test('dispatchOp recall requires question or query', async () => {
  const result = await dispatchOp({ op: 'recall' }, mockDeps());
  assert.equal(result.status, 400);
});

test('POST /mnestra with malformed JSON returns 400, not 500', async () => {
  // Sprint 78 T3: the webhook now requires the shared secret (auth gate runs
  // before body parsing), so authenticate first — the point of this test is
  // the 400 (bad JSON) path, which is only reachable past the gate.
  const server = startWebhookServer({ port: 0, secret: 'wh-test-secret', deps: mockDeps() });
  await new Promise<void>((resolve) => {
    if (server.listening) resolve();
    else server.once('listening', () => resolve());
  });
  try {
    const { port } = server.address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${port}/mnestra`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-mnestra-secret': 'wh-test-secret' },
      body: 'not json',
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { ok: boolean; error: string };
    assert.equal(body.ok, false);
    assert.match(body.error, /invalid JSON/i);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('dispatchOp wraps thrown errors as 500', async () => {
  const deps = mockDeps({
    recall: async () => {
      throw new Error('boom');
    },
  });
  const result = await dispatchOp({ op: 'recall', question: 'x' }, deps);
  assert.equal(result.status, 500);
  assert.deepEqual(result.body, { ok: false, error: 'boom' });
});

/**
 * Mnestra — webhook auth + bind + feedback-op tests (Sprint 78 T3, ITEM ZERO)
 *
 * Pins the three hardening properties:
 *   1. Shared-secret gate on every route except /healthz (constant-time, both
 *      header shapes), fail-CLOSED when no secret is configured.
 *   2. Default bind 127.0.0.1 with an env/opts host override.
 *   3. The op:'feedback' receiver contract { memory_id, event:cited|dismissed }.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import {
  dispatchOp,
  startWebhookServer,
  type OpDeps,
} from '../src/webhook-server.js';
import type { RecallOutput } from '../src/recall.js';
import type { StatusReport } from '../src/types.js';

// Deterministic bind: drop ambient host/secret env so the opts are the only
// source. (node --test runs each file in its own process, so this is local.)
delete process.env.MNESTRA_WEBHOOK_HOST;
delete process.env.MNESTRA_WEBHOOK_BIND;
delete process.env.MNESTRA_WEBHOOK_SECRET;

const TEST_SECRET = 'sprint78-test-secret';
const MEMID = '11111111-2222-3333-4444-555555555555';

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

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => {
    if (server.listening) resolve();
    else server.once('listening', () => resolve());
  });
  return (server.address() as AddressInfo).port;
}

function close(server: Server): Promise<void> {
  return new Promise<void>((resolve) => server.close(() => resolve()));
}

// ── op:'feedback' receiver (dispatchOp-direct, no HTTP) ─────────────────────

test('feedback op: valid memory_id + cited → 200 and fires deps.feedback once', async () => {
  const seen: Array<{ id: string; event: string }> = [];
  const deps = mockDeps({ feedback: (id, event) => seen.push({ id, event }) });
  const result = await dispatchOp({ op: 'feedback', memory_id: MEMID, event: 'cited' }, deps);
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { ok: true, recorded: 'cited' });
  assert.deepEqual(seen, [{ id: MEMID, event: 'cited' }]);
});

test('feedback op: event dismissed → 200 recorded dismissed', async () => {
  const seen: string[] = [];
  const deps = mockDeps({ feedback: (_id, event) => seen.push(event) });
  const result = await dispatchOp({ op: 'feedback', memory_id: MEMID, event: 'dismissed' }, deps);
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { ok: true, recorded: 'dismissed' });
  assert.deepEqual(seen, ['dismissed']);
});

test('feedback op: invalid memory_id → 400, feedback NOT fired', async () => {
  let fired = false;
  const deps = mockDeps({ feedback: () => (fired = true) });
  const result = await dispatchOp({ op: 'feedback', memory_id: 'nope', event: 'cited' }, deps);
  assert.equal(result.status, 400);
  assert.equal(fired, false);
});

test('feedback op: missing memory_id → 400', async () => {
  const result = await dispatchOp({ op: 'feedback', event: 'cited' }, mockDeps());
  assert.equal(result.status, 400);
});

test('feedback op: invalid event → 400, feedback NOT fired', async () => {
  let fired = false;
  const deps = mockDeps({ feedback: () => (fired = true) });
  const result = await dispatchOp({ op: 'feedback', memory_id: MEMID, event: 'maybe' }, deps);
  assert.equal(result.status, 400);
  assert.equal(fired, false);
});

// ── HTTP auth gate ──────────────────────────────────────────────────────────

test('POST /mnestra without the secret header → 401, dispatchOp never reached', async () => {
  let recalled = false;
  const deps = mockDeps({
    recall: async () => {
      recalled = true;
      return { hits: [], tokens_used: 0, text: '', recall_group_id: null };
    },
  });
  const server = startWebhookServer({ port: 0, secret: TEST_SECRET, deps });
  try {
    const port = await listen(server);
    const res = await fetch(`http://127.0.0.1:${port}/mnestra`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ op: 'recall', question: 'x' }),
    });
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { ok: false, error: 'unauthorized' });
    assert.equal(recalled, false, 'the op must never execute without the secret');
  } finally {
    await close(server);
  }
});

test('POST /mnestra with x-mnestra-secret → reaches the op (200)', async () => {
  const server = startWebhookServer({ port: 0, secret: TEST_SECRET, deps: mockDeps() });
  try {
    const port = await listen(server);
    const res = await fetch(`http://127.0.0.1:${port}/mnestra`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-mnestra-secret': TEST_SECRET },
      body: JSON.stringify({ op: 'recall', question: 'x' }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean };
    assert.equal(body.ok, true);
  } finally {
    await close(server);
  }
});

test('POST /mnestra with Authorization: Bearer <secret> → 200', async () => {
  const server = startWebhookServer({ port: 0, secret: TEST_SECRET, deps: mockDeps() });
  try {
    const port = await listen(server);
    const res = await fetch(`http://127.0.0.1:${port}/mnestra`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', authorization: `Bearer ${TEST_SECRET}` },
      body: JSON.stringify({ op: 'status' }),
    });
    assert.equal(res.status, 200);
  } finally {
    await close(server);
  }
});

test('POST /mnestra with the WRONG secret → 401', async () => {
  const server = startWebhookServer({ port: 0, secret: TEST_SECRET, deps: mockDeps() });
  try {
    const port = await listen(server);
    const res = await fetch(`http://127.0.0.1:${port}/mnestra`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-mnestra-secret': 'wrong' },
      body: JSON.stringify({ op: 'status' }),
    });
    assert.equal(res.status, 401);
  } finally {
    await close(server);
  }
});

test('GET /healthz is the ONE unauthenticated route → 200 without a secret', async () => {
  const server = startWebhookServer({ port: 0, secret: TEST_SECRET, deps: mockDeps() });
  try {
    const port = await listen(server);
    const res = await fetch(`http://127.0.0.1:${port}/healthz`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean };
    assert.equal(body.ok, true);
  } finally {
    await close(server);
  }
});

test('GET /observation/:id is gated (read-exfil path) → 401 without a secret', async () => {
  const server = startWebhookServer({ port: 0, secret: TEST_SECRET, deps: mockDeps() });
  try {
    const port = await listen(server);
    const res = await fetch(`http://127.0.0.1:${port}/observation/${MEMID}`);
    assert.equal(res.status, 401, 'memory-content reads require the secret too');
  } finally {
    await close(server);
  }
});

test('fail-closed: with NO secret configured, even a header-bearing request is 401', async () => {
  // secret:'' forces fail-closed deterministically (?? only catches null/undef;
  // '' is falsy → isAuthorized returns false for everything). The server still
  // boots (fail-soft for the process).
  const server = startWebhookServer({ port: 0, secret: '', deps: mockDeps() });
  try {
    const port = await listen(server);
    assert.ok(server.listening, 'fail-closed server still boots, never crashes');
    const res = await fetch(`http://127.0.0.1:${port}/mnestra`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-mnestra-secret': 'anything' },
      body: JSON.stringify({ op: 'status' }),
    });
    assert.equal(res.status, 401);
  } finally {
    await close(server);
  }
});

// ── bind host ───────────────────────────────────────────────────────────────

test('default bind is 127.0.0.1 (loopback only)', async () => {
  const server = startWebhookServer({ port: 0, secret: TEST_SECRET, deps: mockDeps() });
  try {
    await listen(server);
    const addr = server.address() as AddressInfo;
    assert.equal(addr.address, '127.0.0.1', 'must NOT bind all interfaces by default');
  } finally {
    await close(server);
  }
});

test('host override flows through to the listen() bind', async () => {
  const server = startWebhookServer({
    port: 0,
    secret: TEST_SECRET,
    host: '0.0.0.0',
    deps: mockDeps(),
  });
  try {
    await listen(server);
    const addr = server.address() as AddressInfo;
    assert.equal(addr.address, '0.0.0.0', 'the LAN override must reach server.listen(port, host)');
  } finally {
    await close(server);
  }
});

test('empty-string host collapses back to 127.0.0.1 (no silent all-interfaces bind)', async () => {
  // `??` does not catch '' — a bare `export MNESTRA_WEBHOOK_HOST=` would
  // otherwise bind all interfaces. The .trim() || fallback must catch it.
  const server = startWebhookServer({ port: 0, secret: TEST_SECRET, host: '', deps: mockDeps() });
  try {
    await listen(server);
    const addr = server.address() as AddressInfo;
    assert.equal(addr.address, '127.0.0.1', 'empty host must NOT bind all interfaces');
  } finally {
    await close(server);
  }
});

/**
 * Mnestra — webhook `propose` op round-trip tests (Sprint 76 T1)
 *
 * Drives dispatchOp() with the REAL memoryPropose (fake Supabase client
 * underneath), pinning the exact contract the MCP bridge (Sprint 76 T2)
 * builds against:
 *
 *   POST /mnestra { op:'propose', source_agent, text, project_hint?, metadata? }
 *     → 200 { ok:true, id:<uuid>, status:'pending' }
 *     → 400 { ok:false, error:'propose requires source_agent'|'propose requires text'
 *                            |'MEMORY_PROPOSE_REJECTED: <reason> …' }
 *     → 500 { ok:false, error } for non-validation failures only
 *
 * And the quarantine-side invariant: the dispatch path never touches
 * memory_items — the only store interaction is rpc('memory_propose').
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { dispatchOp, type OpDeps } from '../src/webhook-server.js';
import { memoryPropose } from '../src/propose.js';
import type { RecallOutput } from '../src/recall.js';
import type { StatusReport } from '../src/types.js';

const FAKE_ID = 'abcdefab-1111-2222-3333-444455556666';

function makeFakeClient() {
  const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const tableTouches: string[] = [];
  const client = {
    rpc: async (name: string, args: Record<string, unknown>) => {
      rpcCalls.push({ name, args });
      if (name === 'memory_propose') return { data: FAKE_ID, error: null };
      return { data: null, error: { message: `unexpected rpc ${name}` } };
    },
    from: (table: string) => {
      tableTouches.push(table);
      throw new Error(`propose dispatch must not touch tables (got .from('${table}'))`);
    },
  } as any;
  return { client, rpcCalls, tableTouches };
}

function depsWithRealPropose(client: any): OpDeps {
  const emptyStatus: StatusReport = {
    total_active: 0,
    sessions: 0,
    by_project: {},
    by_source_type: {},
    by_category: {},
  };
  const unreachable = (op: string) => async () => {
    throw new Error(`unexpected ${op} call in propose test`);
  };
  return {
    remember: unreachable('remember') as OpDeps['remember'],
    recall: async () =>
      ({ hits: [], tokens_used: 0, text: '', recall_group_id: null, tier0: [] }) satisfies RecallOutput,
    search: async () => [],
    status: async () => emptyStatus,
    index: async () => [],
    timeline: async () => [],
    get: async () => [],
    propose: (input) => memoryPropose(input, { client }),
  };
}

test('propose round-trip: valid input → 200 { ok, id, status: pending }', async () => {
  const { client, rpcCalls, tableTouches } = makeFakeClient();
  const result = await dispatchOp(
    {
      op: 'propose',
      source_agent: 'claude-web',
      text: 'web-chat proposal body',
      project_hint: 'termdeck',
      metadata: { bridge: { client_id: 'cid-1' } },
    },
    depsWithRealPropose(client)
  );
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { ok: true, id: FAKE_ID, status: 'pending' });

  assert.equal(rpcCalls.length, 1);
  assert.equal(rpcCalls[0]!.name, 'memory_propose');
  assert.deepEqual(rpcCalls[0]!.args, {
    p_source_agent: 'claude-web',
    p_text: 'web-chat proposal body',
    p_project_hint: 'termdeck',
    p_metadata: { bridge: { client_id: 'cid-1' } },
  });
  assert.deepEqual(tableTouches, [], 'the dispatch never touches memory_items');
});

test('propose without source_agent → 400 before any deps call', async () => {
  const { client, rpcCalls } = makeFakeClient();
  const result = await dispatchOp(
    { op: 'propose', text: 'orphan proposal' },
    depsWithRealPropose(client)
  );
  assert.equal(result.status, 400);
  assert.deepEqual(result.body, { ok: false, error: 'propose requires source_agent' });
  assert.equal(rpcCalls.length, 0);
});

test('propose without text → 400 before any deps call', async () => {
  const { client, rpcCalls } = makeFakeClient();
  const result = await dispatchOp(
    { op: 'propose', source_agent: 'claude-web' },
    depsWithRealPropose(client)
  );
  assert.equal(result.status, 400);
  assert.deepEqual(result.body, { ok: false, error: 'propose requires text' });
  assert.equal(rpcCalls.length, 0);
});

test('CLI source_agent (grok) → 400 with the MEMORY_PROPOSE_REJECTED reason, zero RPC calls', async () => {
  const { client, rpcCalls } = makeFakeClient();
  const result = await dispatchOp(
    { op: 'propose', source_agent: 'grok', text: 'CLI impersonation attempt' },
    depsWithRealPropose(client)
  );
  assert.equal(result.status, 400);
  const body = result.body as { ok: boolean; error: string };
  assert.equal(body.ok, false);
  assert.match(body.error, /^MEMORY_PROPOSE_REJECTED: invalid_source_agent/);
  assert.equal(rpcCalls.length, 0, 'rejected before the DB round-trip');
});

test('oversize text → 400 with the reason', async () => {
  const { client } = makeFakeClient();
  const result = await dispatchOp(
    { op: 'propose', source_agent: 'grok-web', text: 'y'.repeat(4001) },
    depsWithRealPropose(client)
  );
  assert.equal(result.status, 400);
  assert.match(
    (result.body as { error: string }).error,
    /^MEMORY_PROPOSE_REJECTED: text_too_long/
  );
});

test('SQL-side rejection surfaces as 400 too (authoritative gate, same prefix)', async () => {
  const client = {
    rpc: async () => ({
      data: null,
      error: { message: 'MEMORY_PROPOSE_REJECTED: metadata_too_large (9000 bytes; max 8192)' },
    }),
    from: () => {
      throw new Error('no tables');
    },
  } as any;
  const result = await dispatchOp(
    { op: 'propose', source_agent: 'grok-web', text: 'sql gate rejection' },
    depsWithRealPropose(client)
  );
  assert.equal(result.status, 400);
  assert.match(
    (result.body as { error: string }).error,
    /^MEMORY_PROPOSE_REJECTED: metadata_too_large/
  );
});

test('non-validation failure → 500, not 400 (grant regressions are server errors)', async () => {
  const client = {
    rpc: async () => ({
      data: null,
      error: { message: 'permission denied for function memory_propose' },
    }),
    from: () => {
      throw new Error('no tables');
    },
  } as any;
  const result = await dispatchOp(
    { op: 'propose', source_agent: 'grok-web', text: 'grant regression' },
    depsWithRealPropose(client)
  );
  assert.equal(result.status, 500);
  assert.match((result.body as { error: string }).error, /permission denied/);
});

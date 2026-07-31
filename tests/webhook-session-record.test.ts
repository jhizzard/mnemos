/**
 * Mnestra — webhook `session_record` op round-trip tests (Sprint 84 T2)
 *
 * Drives dispatchOp() with the REAL memorySessionRecord (fake Supabase client
 * underneath), pinning the exact contract the MCP bridge builds against:
 *
 *   POST /mnestra { op:'session_record', source_agent, conversation_key,
 *                   summary, project?, messages_count?, started_at?,
 *                   ended_at?, topics?, metadata? }
 *     → 200 { ok:true, id:<uuid>, session_id:'web:<agent>:<key>' }
 *     → 400 { ok:false, error:'session_record requires <field>'
 *                            |'MEMORY_SESSION_RECORD_REJECTED: <reason> …' }
 *     → 501 { ok:false, error } when the deps object predates this op
 *     → 500 for non-validation failures only
 *
 * And the invariant that matters most: the dispatch path touches
 * memory_sessions through the RPC alone, and never memory_items.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { dispatchOp, type OpDeps } from '../src/webhook-server.js';
import { memorySessionRecord } from '../src/session_record.js';
import type { RecallOutput } from '../src/recall.js';
import type { StatusReport } from '../src/types.js';

const FAKE_ID = 'abcdefab-1111-2222-3333-444455556666';

function makeFakeClient(error?: { message: string }) {
  const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const tableTouches: string[] = [];
  const client = {
    rpc: async (name: string, args: Record<string, unknown>) => {
      rpcCalls.push({ name, args });
      if (name === 'memory_session_record') {
        return error ? { data: null, error } : { data: FAKE_ID, error: null };
      }
      return { data: null, error: { message: `unexpected rpc ${name}` } };
    },
    from: (table: string) => {
      tableTouches.push(table);
      throw new Error(`session_record dispatch must not touch tables (got .from('${table}'))`);
    },
  } as any;
  return { client, rpcCalls, tableTouches };
}

function baseDeps(): Omit<OpDeps, 'session_record'> {
  const emptyStatus: StatusReport = {
    total_active: 0,
    sessions: 0,
    by_project: {},
    by_source_type: {},
    by_category: {},
  };
  const unreachable = (op: string) => async () => {
    throw new Error(`unexpected ${op} call in session_record test`);
  };
  return {
    remember: unreachable('remember') as OpDeps['remember'],
    recall: async () =>
      ({ hits: [], tokens_used: 0, text: '', recall_group_id: null }) satisfies RecallOutput,
    search: async () => [],
    status: async () => emptyStatus,
    index: async () => [],
    timeline: async () => [],
    get: async () => [],
    propose: unreachable('propose') as OpDeps['propose'],
  };
}

function depsWithRealSessionRecord(client: any): OpDeps {
  return {
    ...baseDeps(),
    session_record: (input) => memorySessionRecord(input, { client }),
  };
}

test('session_record round-trip: valid input → 200 { ok, id, session_id }', async () => {
  const { client, rpcCalls, tableTouches } = makeFakeClient();
  const result = await dispatchOp(
    {
      op: 'session_record',
      source_agent: 'chatgpt-web',
      conversation_key: 'conv-77',
      summary: 'A ChatGPT conversation worth keeping.',
      project: 'termdeck',
      messages_count: 12,
      started_at: '2026-07-31T10:00:00.000Z',
      ended_at: '2026-07-31T10:40:00.000Z',
      topics: ['bridge', 'sessions'],
      metadata: { bridge: { client_id: 'cid-1' } },
    },
    depsWithRealSessionRecord(client)
  );
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, {
    ok: true,
    id: FAKE_ID,
    session_id: 'web:chatgpt-web:conv-77',
  });

  assert.equal(rpcCalls.length, 1);
  assert.equal(rpcCalls[0]!.name, 'memory_session_record');
  assert.deepEqual(rpcCalls[0]!.args, {
    p_source_agent: 'chatgpt-web',
    p_conversation_key: 'conv-77',
    p_summary: 'A ChatGPT conversation worth keeping.',
    p_project: 'termdeck',
    p_messages_count: 12,
    p_started_at: '2026-07-31T10:00:00.000Z',
    p_ended_at: '2026-07-31T10:40:00.000Z',
    p_topics: ['bridge', 'sessions'],
    p_metadata: { bridge: { client_id: 'cid-1' } },
  });
  assert.deepEqual(tableTouches, [], 'the dispatch never touches a table builder');
});

for (const [missing, args] of [
  ['source_agent', { conversation_key: 'k', summary: 's' }],
  ['conversation_key', { source_agent: 'grok-web', summary: 's' }],
  ['summary', { source_agent: 'grok-web', conversation_key: 'k' }],
] as const) {
  test(`session_record without ${missing} → 400 before any deps call`, async () => {
    const { client, rpcCalls } = makeFakeClient();
    const result = await dispatchOp(
      { op: 'session_record', ...args },
      depsWithRealSessionRecord(client)
    );
    assert.equal(result.status, 400);
    assert.deepEqual(result.body, {
      ok: false,
      error: `session_record requires ${missing}`,
    });
    assert.equal(rpcCalls.length, 0);
  });
}

test('a CLI source_agent is a 400, not a 500 — and never reaches the RPC', async () => {
  const { client, rpcCalls } = makeFakeClient();
  const result = await dispatchOp(
    {
      op: 'session_record',
      source_agent: 'claude',
      conversation_key: 'k',
      summary: 'impersonation attempt',
    },
    depsWithRealSessionRecord(client)
  );
  assert.equal(result.status, 400);
  assert.match(
    (result.body as { error: string }).error,
    /^MEMORY_SESSION_RECORD_REJECTED: invalid_source_agent/
  );
  assert.equal(rpcCalls.length, 0);
});

test('an RPC-side rejection (session_locked) surfaces as 400 with its reason', async () => {
  const { client } = makeFakeClient({
    message: 'MEMORY_SESSION_RECORD_REJECTED: session_locked (already processed)',
  });
  const result = await dispatchOp(
    {
      op: 'session_record',
      source_agent: 'grok-web',
      conversation_key: 'conv-1',
      summary: 'second amendment attempt',
    },
    depsWithRealSessionRecord(client)
  );
  assert.equal(result.status, 400);
  assert.match((result.body as { error: string }).error, /session_locked/);
});

test('a non-validation failure is NOT laundered into a 400 — it stays a 500', async () => {
  const { client } = makeFakeClient({ message: 'connection reset by peer' });
  const result = await dispatchOp(
    {
      op: 'session_record',
      source_agent: 'grok-web',
      conversation_key: 'conv-1',
      summary: 'body',
    },
    depsWithRealSessionRecord(client)
  );
  assert.equal(result.status, 500, 'infrastructure failures must not read as client rejections');
  assert.match((result.body as { error: string }).error, /memory_session_record rpc failed/);
});

test('a pre-84 deps object gets 501, never a 200 for a write that did not happen', async () => {
  const result = await dispatchOp(
    {
      op: 'session_record',
      source_agent: 'grok-web',
      conversation_key: 'conv-1',
      summary: 'body',
    },
    baseDeps() as OpDeps
  );
  assert.equal(result.status, 501);
  assert.deepEqual(result.body, {
    ok: false,
    error: 'session_record op not available on this Mnestra build',
  });
});

test('the op does not accept a caller-supplied session_id under any spelling', async () => {
  const { client, rpcCalls } = makeFakeClient();
  await dispatchOp(
    {
      op: 'session_record',
      source_agent: 'grok-web',
      conversation_key: 'conv-1',
      summary: 'body',
      // Both of these must be ignored outright — the RPC mints the key.
      session_id: '4cf3a05f-d627-4c96-80fe-ef39d85e357f',
      p_session_id: '4cf3a05f-d627-4c96-80fe-ef39d85e357f',
    },
    depsWithRealSessionRecord(client)
  );
  const keys = Object.keys(rpcCalls[0]!.args);
  assert.ok(
    !keys.some((k) => k.toLowerCase().includes('session_id')),
    `no session_id-ish argument may cross the wire; got ${keys.join(',')}`
  );
});

/**
 * Mnestra — memorySessionRecord unit tests (Sprint 84 T2)
 *
 * Pins the TS mirror of the memory_session_record RPC contract:
 *   - whitelist: exactly the four *-web values, trim+lower normalized; every
 *     CLI value and everything unknown is REJECTED (a web surface may never
 *     record a session under a CLI trust domain)
 *   - caps: summary 8000 / conversation_key 200 + charset / project 128 /
 *     topics 4096 bytes / metadata 8192 bytes
 *   - temporal sanity: started_after_ended
 *   - rejections are SessionRecordRejectedError carrying the stable
 *     MEMORY_SESSION_RECORD_REJECTED prefix, raised BEFORE any DB round-trip
 *   - the deps seam: the accept path issues exactly one
 *     rpc('memory_session_record', …) call and NEVER touches a table builder
 *   - NO session_id crosses the wire — the RPC mints it, and that is the
 *     guard that stops a web caller addressing a CLI-written session row
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  memorySessionRecord,
  SessionRecordRejectedError,
  isSessionRecordRejected,
  webSessionId,
  SESSION_RECORD_REJECTED_PREFIX,
  SESSION_SUMMARY_MAX_CHARS,
  SESSION_CONVERSATION_KEY_MAX_CHARS,
  SESSION_PROJECT_MAX_CHARS,
  SESSION_TOPICS_MAX_BYTES,
  SESSION_METADATA_MAX_BYTES,
} from '../src/session_record.js';
import { WEB_SOURCE_AGENTS, SOURCE_AGENTS } from '../src/types.js';

const FAKE_ID = '12345678-1234-1234-1234-123456789abc';

interface RpcCall {
  name: string;
  args: Record<string, unknown>;
}

function makeFakeClient(
  rpcResult: { data: unknown; error: { message: string } | null } = {
    data: FAKE_ID,
    error: null,
  }
) {
  const calls: RpcCall[] = [];
  const client = {
    rpc: async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      return rpcResult;
    },
    from: (table: string) => {
      throw new Error(
        `memorySessionRecord must not touch table builders (attempted .from('${table}'))`
      );
    },
  } as any;
  return { client, calls };
}

const OK = {
  source_agent: 'claude-web',
  conversation_key: 'conv-alpha',
  summary: 'A web conversation about the bridge write path.',
};

async function expectRejected(
  p: Promise<unknown>,
  reason: string
): Promise<SessionRecordRejectedError> {
  try {
    await p;
  } catch (err) {
    assert.ok(
      err instanceof SessionRecordRejectedError,
      `expected SessionRecordRejectedError, got ${String(err)}`
    );
    assert.equal(err.reason, reason);
    assert.ok(err.message.startsWith(SESSION_RECORD_REJECTED_PREFIX));
    assert.ok(isSessionRecordRejected(err));
    return err;
  }
  throw new Error(`expected rejection "${reason}" but the call resolved`);
}

// ── whitelist ───────────────────────────────────────────────────────────────

test('every *-web source agent is accepted, trim+lower normalized', async () => {
  for (const agent of WEB_SOURCE_AGENTS) {
    const { client, calls } = makeFakeClient();
    const res = await memorySessionRecord(
      { ...OK, source_agent: `  ${agent.toUpperCase()}  ` },
      { client }
    );
    assert.equal(res.id, FAKE_ID);
    assert.equal(calls[0]!.args.p_source_agent, agent);
    assert.equal(res.session_id, `web:${agent}:conv-alpha`);
  }
});

test('every CLI source agent is REJECTED — a web surface cannot record as a CLI', async () => {
  const cliAgents = SOURCE_AGENTS.filter((a) => !a.endsWith('-web'));
  assert.ok(cliAgents.length >= 5, 'expected the CLI agents to still exist');
  for (const agent of cliAgents) {
    const { client, calls } = makeFakeClient();
    await expectRejected(
      memorySessionRecord({ ...OK, source_agent: agent }, { client }),
      'invalid_source_agent'
    );
    assert.equal(calls.length, 0, 'rejection must cost zero DB round-trips');
  }
});

test('unknown / near-miss source agents are rejected', async () => {
  for (const agent of ['', '   ', 'chatgpt', 'claude-web2', 'web', 'CLAUDE']) {
    const { client } = makeFakeClient();
    await expectRejected(
      memorySessionRecord({ ...OK, source_agent: agent }, { client }),
      'invalid_source_agent'
    );
  }
});

// ── conversation key ────────────────────────────────────────────────────────

test('conversation_key: empty / oversize / bad charset are rejected', async () => {
  const { client } = makeFakeClient();
  await expectRejected(
    memorySessionRecord({ ...OK, conversation_key: '   ' }, { client }),
    'empty_conversation_key'
  );
  await expectRejected(
    memorySessionRecord(
      { ...OK, conversation_key: 'a'.repeat(SESSION_CONVERSATION_KEY_MAX_CHARS + 1) },
      { client }
    ),
    'conversation_key_too_long'
  );
  for (const bad of ['has space', 'slash/es', 'quote"', 'semi;colon', 'new\nline']) {
    await expectRejected(
      memorySessionRecord({ ...OK, conversation_key: bad }, { client }),
      'invalid_conversation_key'
    );
  }
});

test('conversation_key at the cap, with every allowed character class, passes', async () => {
  const { client, calls } = makeFakeClient();
  const key = ('aZ0._-:@' + 'x'.repeat(SESSION_CONVERSATION_KEY_MAX_CHARS)).slice(
    0,
    SESSION_CONVERSATION_KEY_MAX_CHARS
  );
  await memorySessionRecord({ ...OK, conversation_key: key }, { client });
  assert.equal(calls[0]!.args.p_conversation_key, key);
});

// ── the session_id guard ────────────────────────────────────────────────────

test('no session_id ever crosses the wire — the RPC mints it', async () => {
  const { client, calls } = makeFakeClient();
  // A caller trying to smuggle a CLI session UUID in as the key gets it
  // namespaced under its own agent, never used raw.
  const cliSessionUuid = '4cf3a05f-d627-4c96-80fe-ef39d85e357f';
  const res = await memorySessionRecord(
    { ...OK, source_agent: 'grok-web', conversation_key: cliSessionUuid },
    { client }
  );
  const argKeys = Object.keys(calls[0]!.args);
  assert.ok(!argKeys.includes('p_session_id'), 'session_id must not be an RPC argument');
  assert.ok(
    !argKeys.some((k) => k.toLowerCase().includes('session_id')),
    `no session_id-ish argument may exist; got ${argKeys.join(',')}`
  );
  assert.equal(res.session_id, `web:grok-web:${cliSessionUuid}`);
  assert.notEqual(res.session_id, cliSessionUuid);
});

test('webSessionId is namespaced per agent, so two agents never collide on one key', () => {
  assert.notEqual(webSessionId('grok-web', 'k'), webSessionId('chatgpt-web', 'k'));
  assert.equal(webSessionId('claude-web', 'k'), 'web:claude-web:k');
});

// ── caps ────────────────────────────────────────────────────────────────────

test('summary: empty and oversize are rejected; the cap boundary passes', async () => {
  const { client, calls } = makeFakeClient();
  await expectRejected(
    memorySessionRecord({ ...OK, summary: '  \n  ' }, { client }),
    'empty_summary'
  );
  await expectRejected(
    memorySessionRecord({ ...OK, summary: 'x'.repeat(SESSION_SUMMARY_MAX_CHARS + 1) }, { client }),
    'summary_too_long'
  );
  await memorySessionRecord(
    { ...OK, summary: 'x'.repeat(SESSION_SUMMARY_MAX_CHARS) },
    { client }
  );
  assert.equal(
    String(calls.at(-1)!.args.p_summary).length,
    SESSION_SUMMARY_MAX_CHARS,
    'the boundary value is forwarded intact'
  );
});

test('summary is trimmed before the cap is measured and before forwarding', async () => {
  const { client, calls } = makeFakeClient();
  await memorySessionRecord({ ...OK, summary: '   padded   ' }, { client });
  assert.equal(calls[0]!.args.p_summary, 'padded');
});

test('project: oversize rejected, empty collapses to null, non-string rejected', async () => {
  const { client, calls } = makeFakeClient();
  await expectRejected(
    memorySessionRecord({ ...OK, project: 'p'.repeat(SESSION_PROJECT_MAX_CHARS + 1) }, { client }),
    'project_too_long'
  );
  await expectRejected(
    memorySessionRecord({ ...OK, project: 42 as unknown as string }, { client }),
    'project_not_text'
  );
  await memorySessionRecord({ ...OK, project: '   ' }, { client });
  assert.equal(calls.at(-1)!.args.p_project, null);
});

test('messages_count: negatives and non-numbers rejected; absent forwards null', async () => {
  const { client, calls } = makeFakeClient();
  await expectRejected(
    memorySessionRecord({ ...OK, messages_count: -1 }, { client }),
    'negative_messages_count'
  );
  await expectRejected(
    memorySessionRecord({ ...OK, messages_count: 'seven' as unknown as number }, { client }),
    'messages_count_not_number'
  );
  await expectRejected(
    memorySessionRecord({ ...OK, messages_count: Number.NaN }, { client }),
    'messages_count_not_number'
  );
  await memorySessionRecord(OK, { client });
  assert.equal(calls.at(-1)!.args.p_messages_count, null);
  await memorySessionRecord({ ...OK, messages_count: 7.9 }, { client });
  assert.equal(calls.at(-1)!.args.p_messages_count, 7, 'truncated, never rounded up');
});

test('messages_count is NEVER inflated to clear the Rumen sweep floor', async () => {
  // The floor (rumen DEFAULT_MIN_EVENT_COUNT = 3) is the consumer's business.
  // Silently rewriting a 1-message conversation into a 3-message one would be
  // a lie told to the learning loop, so the mirror forwards what it was given.
  const { client, calls } = makeFakeClient();
  await memorySessionRecord({ ...OK, messages_count: 1 }, { client });
  assert.equal(calls[0]!.args.p_messages_count, 1);
});

test('topics: non-array rejected, oversize rejected, default is []', async () => {
  const { client, calls } = makeFakeClient();
  await expectRejected(
    memorySessionRecord({ ...OK, topics: { a: 1 } as unknown as unknown[] }, { client }),
    'topics_not_array'
  );
  await expectRejected(
    memorySessionRecord({ ...OK, topics: ['x'.repeat(SESSION_TOPICS_MAX_BYTES)] }, { client }),
    'topics_too_large'
  );
  await memorySessionRecord(OK, { client });
  assert.deepEqual(calls.at(-1)!.args.p_topics, []);
});

test('metadata: non-object rejected, oversize rejected, circular rejected', async () => {
  const { client, calls } = makeFakeClient();
  await expectRejected(
    memorySessionRecord({ ...OK, metadata: [1] as unknown as Record<string, unknown> }, { client }),
    'metadata_not_object'
  );
  await expectRejected(
    memorySessionRecord(
      { ...OK, metadata: { big: 'x'.repeat(SESSION_METADATA_MAX_BYTES) } },
      { client }
    ),
    'metadata_too_large'
  );
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  await expectRejected(
    memorySessionRecord({ ...OK, metadata: circular }, { client }),
    'metadata_not_serializable'
  );
  await memorySessionRecord(OK, { client });
  assert.deepEqual(calls.at(-1)!.args.p_metadata, {});
});

// ── timestamps ──────────────────────────────────────────────────────────────

test('started_at after ended_at is rejected before the round-trip', async () => {
  const { client, calls } = makeFakeClient();
  await expectRejected(
    memorySessionRecord(
      { ...OK, started_at: '2026-07-31T12:00:00Z', ended_at: '2026-07-31T11:00:00Z' },
      { client }
    ),
    'started_after_ended'
  );
  assert.equal(calls.length, 0);
});

test('Date and ISO-string timestamps both normalize to ISO; garbage is rejected', async () => {
  const { client, calls } = makeFakeClient();
  const started = new Date('2026-07-31T10:00:00.000Z');
  await memorySessionRecord(
    { ...OK, started_at: started, ended_at: '2026-07-31T10:30:00.000Z' },
    { client }
  );
  assert.equal(calls[0]!.args.p_started_at, '2026-07-31T10:00:00.000Z');
  assert.equal(calls[0]!.args.p_ended_at, '2026-07-31T10:30:00.000Z');

  await expectRejected(
    memorySessionRecord({ ...OK, ended_at: 'not-a-date' }, { client }),
    'invalid_ended_at'
  );
  await expectRejected(
    memorySessionRecord({ ...OK, started_at: new Date('nope') }, { client }),
    'invalid_started_at'
  );
});

test('absent ended_at forwards null — the RPC defaults it to now()', async () => {
  // The Rumen picker requires ended_at IS NOT NULL, so the DEFAULT lives in
  // SQL where it cannot be skipped by a caller that talks to the RPC directly.
  const { client, calls } = makeFakeClient();
  await memorySessionRecord(OK, { client });
  assert.equal(calls[0]!.args.p_ended_at, null);
});

// ── the deps seam / RPC surface ─────────────────────────────────────────────

test('the accept path makes exactly one rpc call and never touches a table', async () => {
  const { client, calls } = makeFakeClient();
  await memorySessionRecord({ ...OK, project: 'termdeck', messages_count: 5 }, { client });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.name, 'memory_session_record');
  assert.deepEqual(Object.keys(calls[0]!.args).sort(), [
    'p_conversation_key',
    'p_ended_at',
    'p_messages_count',
    'p_metadata',
    'p_project',
    'p_source_agent',
    'p_started_at',
    'p_summary',
    'p_topics',
  ]);
});

test('an RPC-side rejection is re-thrown in the shared shape with its reason code', async () => {
  const { client } = makeFakeClient({
    data: null,
    error: {
      message:
        'MEMORY_SESSION_RECORD_REJECTED: session_locked (a record already exists for this conversation key)',
    },
  });
  const err = await expectRejected(memorySessionRecord(OK, { client }), 'session_locked');
  assert.match(err.message, /session_locked/);
});

test('a non-validation RPC failure is NOT laundered into a rejection', async () => {
  const { client } = makeFakeClient({
    data: null,
    error: { message: 'connection reset by peer' },
  });
  await assert.rejects(
    memorySessionRecord(OK, { client }),
    (err: unknown) =>
      err instanceof Error &&
      !isSessionRecordRejected(err) &&
      /memory_session_record rpc failed/.test(err.message)
  );
});

test('a non-uuid rpc return is a hard error, not a silent success', async () => {
  const { client } = makeFakeClient({ data: 'not-a-uuid', error: null });
  await assert.rejects(memorySessionRecord(OK, { client }), /returned no row id/);
});

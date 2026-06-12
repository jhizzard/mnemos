/**
 * Mnestra — memoryPropose unit tests (Sprint 76 T1)
 *
 * Pins the TS mirror of the memory_propose RPC contract:
 *   - whitelist: exactly the four *-web values, trim+lower normalized;
 *     every CLI value and everything unknown is REJECTED (web surfaces may
 *     never impersonate a CLI trust domain)
 *   - caps: text 4000 chars / project_hint 128 chars / metadata 8192 bytes
 *   - rejections are ProposeRejectedError with the stable
 *     MEMORY_PROPOSE_REJECTED prefix, raised BEFORE any DB round-trip
 *   - the deps seam: the accept path issues exactly one
 *     rpc('memory_propose', …) call and NEVER touches a table builder
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  memoryPropose,
  ProposeRejectedError,
  isProposeRejected,
  PROPOSE_REJECTED_PREFIX,
  PROPOSE_TEXT_MAX_CHARS,
  PROPOSE_PROJECT_HINT_MAX_CHARS,
  PROPOSE_METADATA_MAX_BYTES,
} from '../src/propose.js';
import { WEB_SOURCE_AGENTS, SOURCE_AGENTS } from '../src/types.js';

const FAKE_ID = '12345678-1234-1234-1234-123456789abc';

interface RpcCall {
  name: string;
  args: Record<string, unknown>;
}

/**
 * Fake Supabase client for the propose path. rpc() records and succeeds;
 * from() throws — memoryPropose must reach the store through the RPC alone
 * (the table has no other write path; see migration 026 gate 5).
 */
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
        `memoryPropose must not touch table builders (attempted .from('${table}'))`
      );
    },
  } as any;
  return { client, calls };
}

async function expectRejected(
  p: Promise<unknown>,
  reason: string
): Promise<ProposeRejectedError> {
  try {
    await p;
  } catch (err) {
    assert.ok(
      err instanceof ProposeRejectedError,
      `expected ProposeRejectedError, got ${(err as Error).constructor.name}: ${(err as Error).message}`
    );
    assert.equal((err as ProposeRejectedError).reason, reason);
    assert.ok(
      (err as Error).message.startsWith(`${PROPOSE_REJECTED_PREFIX}: ${reason}`),
      `message must carry the stable prefix (got: ${(err as Error).message})`
    );
    return err as ProposeRejectedError;
  }
  assert.fail(`expected rejection '${reason}' but the proposal was accepted`);
}

test('WEB_SOURCE_AGENTS is the *-web subset of SOURCE_AGENTS (derived, in lockstep)', () => {
  assert.deepEqual(WEB_SOURCE_AGENTS, ['claude-web', 'chatgpt-web', 'grok-web', 'gemini-web']);
  // Derivation property: exactly the SOURCE_AGENTS members with the -web suffix.
  assert.deepEqual(
    WEB_SOURCE_AGENTS,
    SOURCE_AGENTS.filter((a) => a.endsWith('-web'))
  );
});

test('accepts all four *-web agents and forwards normalized RPC args', async () => {
  for (const agent of WEB_SOURCE_AGENTS) {
    const { client, calls } = makeFakeClient();
    const result = await memoryPropose(
      { source_agent: agent, text: 'a kitchen-level proposal', project_hint: 'termdeck' },
      { client }
    );
    assert.deepEqual(result, { id: FAKE_ID });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.name, 'memory_propose');
    assert.deepEqual(calls[0]!.args, {
      p_source_agent: agent,
      p_text: 'a kitchen-level proposal',
      p_project_hint: 'termdeck',
      p_metadata: {},
    });
  }
});

test('normalizes source_agent (trim + lowercase) before the whitelist check', async () => {
  const { client, calls } = makeFakeClient();
  await memoryPropose({ source_agent: '  Claude-Web ', text: 'normalized' }, { client });
  assert.equal(calls[0]!.args.p_source_agent, 'claude-web');
});

test('rejects every CLI agent value — web must not impersonate the CLI trust domain', async () => {
  const cliAgents = SOURCE_AGENTS.filter((a) => !a.endsWith('-web'));
  assert.ok(cliAgents.length >= 5, 'sanity: the CLI taxonomy is present');
  for (const agent of cliAgents) {
    const { client, calls } = makeFakeClient();
    await expectRejected(
      memoryPropose({ source_agent: agent, text: 'impersonation attempt' }, { client }),
      'invalid_source_agent'
    );
    assert.equal(calls.length, 0, 'rejection must happen before any DB round-trip');
  }
});

test('rejects unknown / empty / non-string source_agent', async () => {
  for (const bad of ['chatgpt', 'grok-web2', 'web', '', '   ', undefined, null, 42]) {
    const { client, calls } = makeFakeClient();
    await expectRejected(
      memoryPropose({ source_agent: bad as any, text: 'x' }, { client }),
      'invalid_source_agent'
    );
    assert.equal(calls.length, 0);
  }
});

test('text caps: exactly 4000 chars passes, 4001 is rejected, empty/whitespace rejected', async () => {
  {
    const { client } = makeFakeClient();
    const result = await memoryPropose(
      { source_agent: 'grok-web', text: 'x'.repeat(PROPOSE_TEXT_MAX_CHARS) },
      { client }
    );
    assert.deepEqual(result, { id: FAKE_ID });
  }
  {
    const { client, calls } = makeFakeClient();
    await expectRejected(
      memoryPropose(
        { source_agent: 'grok-web', text: 'x'.repeat(PROPOSE_TEXT_MAX_CHARS + 1) },
        { client }
      ),
      'text_too_long'
    );
    assert.equal(calls.length, 0);
  }
  for (const bad of ['', '   \n\t  ', undefined, null]) {
    const { client, calls } = makeFakeClient();
    await expectRejected(
      memoryPropose({ source_agent: 'grok-web', text: bad as any }, { client }),
      'empty_text'
    );
    assert.equal(calls.length, 0);
  }
});

test('text is trimmed before the length check and before forwarding', async () => {
  const { client, calls } = makeFakeClient();
  // 4000 payload chars + surrounding whitespace: passes because trim runs first.
  await memoryPropose(
    { source_agent: 'grok-web', text: `  ${'x'.repeat(PROPOSE_TEXT_MAX_CHARS)}\n` },
    { client }
  );
  assert.equal(calls[0]!.args.p_text, 'x'.repeat(PROPOSE_TEXT_MAX_CHARS));
});

test('project_hint caps: 128 passes, 129 rejected, empty collapses to null, non-string rejected', async () => {
  {
    const { client, calls } = makeFakeClient();
    await memoryPropose(
      {
        source_agent: 'gemini-web',
        text: 'hint boundary',
        project_hint: 'p'.repeat(PROPOSE_PROJECT_HINT_MAX_CHARS),
      },
      { client }
    );
    assert.equal(
      (calls[0]!.args.p_project_hint as string).length,
      PROPOSE_PROJECT_HINT_MAX_CHARS
    );
  }
  {
    const { client, calls } = makeFakeClient();
    await expectRejected(
      memoryPropose(
        {
          source_agent: 'gemini-web',
          text: 'hint boundary',
          project_hint: 'p'.repeat(PROPOSE_PROJECT_HINT_MAX_CHARS + 1),
        },
        { client }
      ),
      'project_hint_too_long'
    );
    assert.equal(calls.length, 0);
  }
  {
    const { client, calls } = makeFakeClient();
    await memoryPropose(
      { source_agent: 'gemini-web', text: 'empty hint', project_hint: '   ' },
      { client }
    );
    assert.equal(calls[0]!.args.p_project_hint, null);
  }
  {
    const { client, calls } = makeFakeClient();
    await expectRejected(
      memoryPropose(
        { source_agent: 'gemini-web', text: 'bad hint', project_hint: 42 as any },
        { client }
      ),
      'project_hint_not_text'
    );
    assert.equal(calls.length, 0);
  }
});

test('metadata: object passes (and defaults to {}), array/scalar rejected, oversize rejected', async () => {
  {
    const { client, calls } = makeFakeClient();
    await memoryPropose({ source_agent: 'chatgpt-web', text: 'no metadata' }, { client });
    assert.deepEqual(calls[0]!.args.p_metadata, {});
  }
  {
    const { client, calls } = makeFakeClient();
    const metadata = { bridge: { client_id: 'abc', request_id: 'r1' } };
    await memoryPropose(
      { source_agent: 'chatgpt-web', text: 'with metadata', metadata },
      { client }
    );
    assert.deepEqual(calls[0]!.args.p_metadata, metadata);
  }
  for (const bad of [['a'], 'scalar', 42]) {
    const { client, calls } = makeFakeClient();
    await expectRejected(
      memoryPropose(
        { source_agent: 'chatgpt-web', text: 'bad metadata', metadata: bad as any },
        { client }
      ),
      'metadata_not_object'
    );
    assert.equal(calls.length, 0);
  }
  {
    const { client, calls } = makeFakeClient();
    await expectRejected(
      memoryPropose(
        {
          source_agent: 'chatgpt-web',
          text: 'oversize metadata',
          metadata: { blob: 'm'.repeat(PROPOSE_METADATA_MAX_BYTES) },
        },
        { client }
      ),
      'metadata_too_large'
    );
    assert.equal(calls.length, 0);
  }
});

test('an RPC-side MEMORY_PROPOSE_REJECTED error re-throws as ProposeRejectedError (shared shape)', async () => {
  const { client } = makeFakeClient({
    data: null,
    error: { message: 'MEMORY_PROPOSE_REJECTED: text_too_long (4321 chars; max 4000)' },
  });
  const err = await expectRejected(
    memoryPropose({ source_agent: 'grok-web', text: 'sql-side rejection' }, { client }),
    'text_too_long'
  );
  assert.ok(isProposeRejected(err));
});

test('a non-rejection RPC error stays a plain Error (webhook maps it to 500, not 400)', async () => {
  const { client } = makeFakeClient({
    data: null,
    error: { message: 'permission denied for function memory_propose' },
  });
  await assert.rejects(
    memoryPropose({ source_agent: 'grok-web', text: 'grant regression' }, { client }),
    (err: Error) => {
      assert.ok(!(err instanceof ProposeRejectedError));
      assert.ok(!isProposeRejected(err));
      assert.match(err.message, /memory_propose rpc failed: permission denied/);
      return true;
    }
  );
});

test('a malformed RPC result (no uuid) is a plain Error', async () => {
  const { client } = makeFakeClient({ data: { weird: true }, error: null });
  await assert.rejects(
    memoryPropose({ source_agent: 'grok-web', text: 'shape drift' }, { client }),
    /returned no row id/
  );
});

test('isProposeRejected also honors the prefix on foreign Error instances (injected deps contract)', () => {
  assert.ok(isProposeRejected(new Error('MEMORY_PROPOSE_REJECTED: empty_text')));
  assert.ok(!isProposeRejected(new Error('boom')));
  assert.ok(!isProposeRejected('MEMORY_PROPOSE_REJECTED: not-an-error'));
});

/**
 * Mnestra — tier-0 objectives unit tests (Sprint 71 B-T1)
 *
 * Pins the TS half of the objective surface:
 *   - the OPERATOR GATE is closed by default and opens only on the exact
 *     string '1' — and it is checked BEFORE any validation or round-trip, so a
 *     closed gate cannot be probed for schema details
 *   - mirror validation: caps, rank range, the rank-required-unless-superseding
 *     rule, uuid shapes, metadata shape/size — all raised as
 *     ObjectiveRejectedError before the wire
 *   - SQL rejections come back as the SAME error type with the reason code
 *     parsed out, so callers branch on `reason` rather than string-matching
 *   - the deps seam: the accept path issues exactly one rpc() call with the
 *     p_-prefixed argument names PostgREST binds by
 *   - fetchTier0Block is FAIL-SOFT (the injection path) where objectiveList
 *     THROWS (the operator-facing read) — the asymmetry is deliberate and is
 *     the property most likely to be "simplified" away later
 *   - tier0FetcherForRecall matches Deck A's RecallDeps.fetchTier0 signature
 *     and projects onto their Tier0Item shape
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  objectiveList,
  objectiveHistory,
  objectiveRatify,
  objectiveRetire,
  fetchTier0Block,
  tier0FetcherForRecall,
  formatObjectives,
  isObjectiveRejected,
  parseRejection,
  ObjectiveRejectedError,
  OBJECTIVE_LIST_RPC,
  OBJECTIVE_RATIFY_RPC,
  OBJECTIVE_MAX_ACTIVE,
  OBJECTIVE_TEXT_MAX_CHARS,
  OBJECTIVE_PROJECT_MAX_CHARS,
  OBJECTIVE_RATIFIED_BY_MAX_CHARS,
  OBJECTIVE_METADATA_MAX_BYTES,
  OBJECTIVE_RANK_MAX,
  OBJECTIVE_RATIFY_GATE_ENV,
  OBJECTIVE_RATIFY_REJECTED_PREFIX,
  type Objective,
} from '../src/objectives.js';

const ID_A = '11111111-2222-3333-4444-555555555555';
const ID_B = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

/** The gate open — every accept-path test passes this explicitly. */
const OPEN = { [OBJECTIVE_RATIFY_GATE_ENV]: '1' };

interface RpcCall {
  name: string;
  args: Record<string, unknown>;
}

function makeFakeClient(
  rpcResult: { data: unknown; error: { message: string } | null } = { data: ID_A, error: null }
) {
  const calls: RpcCall[] = [];
  const client = {
    rpc: async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      return rpcResult;
    },
    from: (table: string) => {
      throw new Error(`unexpected table access: .from('${table}')`);
    },
  } as never;
  return { client, calls };
}

function row(over: Partial<Objective> = {}): Objective {
  return {
    id: ID_A,
    project: 'termdeck',
    rank: 1,
    content: 'Zero build step is a locked architectural decision.',
    status: 'active',
    supersedes: null,
    ratified_by: 'josh',
    ratified_at: '2026-08-05T20:00:00.000Z',
    created_at: '2026-08-05T20:00:00.000Z',
    metadata: {},
    ...over,
  };
}

async function expectRejected(fn: () => Promise<unknown>, reason: string): Promise<void> {
  try {
    await fn();
  } catch (err) {
    assert.ok(err instanceof ObjectiveRejectedError, `expected ObjectiveRejectedError, got ${err}`);
    assert.equal((err as ObjectiveRejectedError).reason, reason);
    assert.ok((err as Error).message.startsWith(OBJECTIVE_RATIFY_REJECTED_PREFIX));
    assert.ok(isObjectiveRejected(err));
    return;
  }
  assert.fail(`expected rejection ${reason}, but the call resolved`);
}

// ── the operator gate ───────────────────────────────────────────────────────

test('ratify is refused when the gate env is absent', async () => {
  const { client, calls } = makeFakeClient();
  await expectRejected(
    () =>
      objectiveRatify(
        { project: 'termdeck', content: 'x', ratified_by: 'josh', rank: 1 },
        { client, env: {} }
      ),
    'operator_gate_closed'
  );
  assert.equal(calls.length, 0, 'a closed gate must not reach the wire');
});

test('retire is refused when the gate env is absent', async () => {
  const { client, calls } = makeFakeClient();
  await expectRejected(
    () => objectiveRetire({ project: 'termdeck', id: ID_A, ratified_by: 'josh' }, { client, env: {} }),
    'operator_gate_closed'
  );
  assert.equal(calls.length, 0);
});

test('the gate opens on exactly "1" — not on truthiness', async () => {
  for (const v of ['0', 'true', 'false', 'yes', '', ' 1', '1 ', 'TRUE']) {
    const { client } = makeFakeClient();
    await expectRejected(
      () =>
        objectiveRatify(
          { project: 'termdeck', content: 'x', ratified_by: 'josh', rank: 1 },
          { client, env: { [OBJECTIVE_RATIFY_GATE_ENV]: v } }
        ),
      'operator_gate_closed'
    );
  }
  const { client, calls } = makeFakeClient();
  await objectiveRatify(
    { project: 'termdeck', content: 'x', ratified_by: 'josh', rank: 1 },
    { client, env: OPEN }
  );
  assert.equal(calls.length, 1);
});

test('the gate is checked BEFORE validation — a closed gate is not a schema oracle', async () => {
  const { client } = makeFakeClient();
  // Wildly invalid input: with the gate shut, the gate is what answers.
  await expectRejected(
    () =>
      objectiveRatify(
        { project: '', content: '', ratified_by: '', rank: 9999 },
        { client, env: {} }
      ),
    'operator_gate_closed'
  );
});

test('reads are NOT gated — objective_list works with the gate shut', async () => {
  const { client, calls } = makeFakeClient({ data: [row()], error: null });
  const rows = await objectiveList('termdeck', { client, env: {} });
  assert.equal(rows.length, 1);
  assert.equal(calls[0]!.name, OBJECTIVE_LIST_RPC);
});

// ── mirror validation ───────────────────────────────────────────────────────

test('every mirror rejection fires before the wire', async () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ['empty_project', { project: '   ', content: 'x', ratified_by: 'josh', rank: 1 }],
    [
      'project_too_long',
      { project: 'p'.repeat(OBJECTIVE_PROJECT_MAX_CHARS + 1), content: 'x', ratified_by: 'josh', rank: 1 },
    ],
    ['content_or_supersedes_required', { project: 'termdeck', content: '  ', ratified_by: 'josh', rank: 1 }],
    [
      'content_too_long',
      {
        project: 'termdeck',
        content: 'x'.repeat(OBJECTIVE_TEXT_MAX_CHARS + 1),
        ratified_by: 'josh',
        rank: 1,
      },
    ],
    ['empty_ratified_by', { project: 'termdeck', content: 'x', ratified_by: '', rank: 1 }],
    [
      'ratified_by_too_long',
      {
        project: 'termdeck',
        content: 'x',
        ratified_by: 'j'.repeat(OBJECTIVE_RATIFIED_BY_MAX_CHARS + 1),
        rank: 1,
      },
    ],
    ['rank_required', { project: 'termdeck', content: 'x', ratified_by: 'josh' }],
    ['rank_out_of_range', { project: 'termdeck', content: 'x', ratified_by: 'josh', rank: 0 }],
    [
      'rank_out_of_range',
      { project: 'termdeck', content: 'x', ratified_by: 'josh', rank: OBJECTIVE_RANK_MAX + 1 },
    ],
    ['rank_not_number', { project: 'termdeck', content: 'x', ratified_by: 'josh', rank: 'two' }],
    [
      'supersedes_not_uuid',
      { project: 'termdeck', content: 'x', ratified_by: 'josh', rank: 1, supersedes: 'nope' },
    ],
    [
      'metadata_not_object',
      { project: 'termdeck', content: 'x', ratified_by: 'josh', rank: 1, metadata: ['a'] },
    ],
    [
      'metadata_too_large',
      {
        project: 'termdeck',
        content: 'x',
        ratified_by: 'josh',
        rank: 1,
        metadata: { blob: 'z'.repeat(OBJECTIVE_METADATA_MAX_BYTES + 100) },
      },
    ],
  ];

  for (const [reason, input] of cases) {
    const { client, calls } = makeFakeClient();
    await expectRejected(
      () => objectiveRatify(input as never, { client, env: OPEN }),
      reason
    );
    assert.equal(calls.length, 0, `${reason} must not reach the wire`);
  }
});

test('exactly-at-the-cap values are ACCEPTED (the boundary is inclusive)', async () => {
  const { client, calls } = makeFakeClient();
  await objectiveRatify(
    {
      project: 'p'.repeat(OBJECTIVE_PROJECT_MAX_CHARS),
      content: 'x'.repeat(OBJECTIVE_TEXT_MAX_CHARS),
      ratified_by: 'j'.repeat(OBJECTIVE_RATIFIED_BY_MAX_CHARS),
      rank: OBJECTIVE_RANK_MAX,
    },
    { client, env: OPEN }
  );
  assert.equal(calls.length, 1);
});

test('rank is optional when superseding — the replacement inherits the slot', async () => {
  const { client, calls } = makeFakeClient();
  const result = await objectiveRatify(
    { project: 'termdeck', content: 'revised', ratified_by: 'josh', supersedes: ID_B },
    { client, env: OPEN }
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.args.p_rank, null, 'null rank tells the SQL to inherit');
  assert.equal(calls[0]!.args.p_supersedes, ID_B);
  assert.equal(result.superseded, ID_B);
});

test('retire validates the uuid and ratifier before the wire', async () => {
  const { client, calls } = makeFakeClient();
  await expectRejected(
    () => objectiveRetire({ project: 'termdeck', id: 'not-a-uuid', ratified_by: 'josh' }, { client, env: OPEN }),
    'supersedes_not_uuid'
  );
  await expectRejected(
    () => objectiveRetire({ project: 'termdeck', id: ID_A, ratified_by: '  ' }, { client, env: OPEN }),
    'empty_ratified_by'
  );
  assert.equal(calls.length, 0);
});

// ── the wire contract ───────────────────────────────────────────────────────

test('ratify sends exactly the p_-prefixed names PostgREST binds by', async () => {
  const { client, calls } = makeFakeClient();
  await objectiveRatify(
    {
      project: '  termdeck  ',
      content: '  No TypeScript.  ',
      ratified_by: '  josh  ',
      rank: 3,
      metadata: { source: 'sprint-71' },
    },
    { client, env: OPEN }
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.name, OBJECTIVE_RATIFY_RPC);
  assert.deepEqual(Object.keys(calls[0]!.args).sort(), [
    'p_content',
    'p_metadata',
    'p_project',
    'p_rank',
    'p_ratified_by',
    'p_supersedes',
  ]);
  // Trimmed on the way out — the SQL trims too, but a caller reading the row
  // back should never see the whitespace it did not intend to store.
  assert.equal(calls[0]!.args.p_project, 'termdeck');
  assert.equal(calls[0]!.args.p_content, 'No TypeScript.');
  assert.equal(calls[0]!.args.p_ratified_by, 'josh');
});

test('retire goes through the SINGLE ratify RPC — there is no retire RPC to call', async () => {
  const { client, calls } = makeFakeClient({ data: ID_A, error: null });
  await objectiveRetire(
    { project: 'termdeck', id: ID_A, ratified_by: 'josh', reason: '  obsolete  ' },
    { client, env: OPEN }
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.name, OBJECTIVE_RATIFY_RPC, 'retirement must not reach a second entry point');
  assert.deepEqual(calls[0]!.args, {
    p_project: 'termdeck',
    p_ratified_by: 'josh',
    p_content: null, // ← "supersede with nothing" IS the retire mode
    p_rank: null,
    p_supersedes: ID_A,
    p_metadata: { retire_reason: 'obsolete' },
  });
});

test('no code path in this module ever names a second mutation RPC', async () => {
  // The ratification-only property is a COUNT of entry points. Exercise every
  // mutating call shape and assert they all land on the same one.
  const shapes: Array<() => Promise<unknown>> = [];
  const seen = new Set<string>();
  const mk = () => {
    const { client, calls } = makeFakeClient({ data: ID_A, error: null });
    return { client, calls };
  };
  for (const build of [
    (c: never) => objectiveRatify({ project: 'p', content: 'c', ratified_by: 'j', rank: 1 }, { client: c, env: OPEN }),
    (c: never) => objectiveRatify({ project: 'p', content: 'c', ratified_by: 'j', supersedes: ID_B }, { client: c, env: OPEN }),
    (c: never) => objectiveRatify({ project: 'p', ratified_by: 'j', supersedes: ID_B }, { client: c, env: OPEN }),
    (c: never) => objectiveRetire({ project: 'p', id: ID_B, ratified_by: 'j' }, { client: c, env: OPEN }),
  ]) {
    const { client, calls } = mk();
    await build(client as never);
    for (const call of calls) seen.add(call.name);
    shapes.push(async () => undefined);
  }
  assert.deepEqual([...seen], [OBJECTIVE_RATIFY_RPC], `expected one mutation RPC, saw ${[...seen].join(', ')}`);
});

test('a blank retire reason sends empty metadata, not a null-valued key', async () => {
  const { client, calls } = makeFakeClient({ data: ID_A, error: null });
  await objectiveRetire({ project: 'termdeck', id: ID_A, ratified_by: 'josh', reason: '   ' }, { client, env: OPEN });
  assert.deepEqual(calls[0]!.args.p_metadata, {});
});

test('retire mode: content omitted + supersedes present is accepted', async () => {
  const { client, calls } = makeFakeClient({ data: ID_B, error: null });
  const result = await objectiveRatify(
    { project: 'termdeck', ratified_by: 'josh', supersedes: ID_B },
    { client, env: OPEN }
  );
  assert.equal(calls[0]!.args.p_content, null);
  assert.equal(result.retired, true);
  assert.equal(result.superseded, ID_B);
});

test('a replace is NOT flagged as a retire', async () => {
  const { client } = makeFakeClient();
  const result = await objectiveRatify(
    { project: 'termdeck', content: 'replacement', ratified_by: 'josh', supersedes: ID_B },
    { client, env: OPEN }
  );
  assert.equal(result.retired, false);
});

test('neither content nor supersedes is refused — a call that would do nothing is a bug', async () => {
  const { client, calls } = makeFakeClient();
  await expectRejected(
    () => objectiveRatify({ project: 'termdeck', ratified_by: 'josh' }, { client, env: OPEN }),
    'content_or_supersedes_required'
  );
  assert.equal(calls.length, 0);
});

test('a rank on a retire is refused rather than silently ignored', async () => {
  const { client, calls } = makeFakeClient();
  await expectRejected(
    () =>
      objectiveRatify(
        { project: 'termdeck', ratified_by: 'josh', supersedes: ID_B, rank: 4 },
        { client, env: OPEN }
      ),
    'rank_not_allowed_on_retire'
  );
  assert.equal(calls.length, 0, 'silently dropping it would let an operator believe they had moved it');
});

// ── SQL rejections come back as the same shape ──────────────────────────────

test('a SQL rejection is re-raised as ObjectiveRejectedError with the reason parsed', async () => {
  const { client } = makeFakeClient({
    data: null,
    error: { message: 'OBJECTIVE_RATIFY_REJECTED: rank_taken (project termdeck, rank 1)' },
  });
  await expectRejected(
    () =>
      objectiveRatify(
        { project: 'termdeck', content: 'x', ratified_by: 'josh', rank: 1 },
        { client, env: OPEN }
      ),
    'rank_taken'
  );
});

test('the SQL cap rejection survives the round trip', async () => {
  const { client } = makeFakeClient({
    data: null,
    error: {
      message: `OBJECTIVE_RATIFY_REJECTED: too_many_active (${OBJECTIVE_MAX_ACTIVE} active; cap ${OBJECTIVE_MAX_ACTIVE})`,
    },
  });
  await expectRejected(
    () =>
      objectiveRatify(
        { project: 'termdeck', content: 'x', ratified_by: 'josh', rank: 16 },
        { client, env: OPEN }
      ),
    'too_many_active'
  );
});

test('a NON-rejection error stays an ordinary error — transport faults are not laundered', async () => {
  const { client } = makeFakeClient({ data: null, error: { message: 'fetch failed: ECONNRESET' } });
  await assert.rejects(
    () =>
      objectiveRatify(
        { project: 'termdeck', content: 'x', ratified_by: 'josh', rank: 1 },
        { client, env: OPEN }
      ),
    (err: Error) => {
      assert.ok(!(err instanceof ObjectiveRejectedError));
      assert.ok(!isObjectiveRejected(err));
      assert.match(err.message, /ECONNRESET/);
      return true;
    }
  );
});

test('parseRejection extracts the code and ignores everything else', () => {
  assert.equal(parseRejection('OBJECTIVE_RATIFY_REJECTED: rank_taken (x)'), 'rank_taken');
  assert.equal(parseRejection('OBJECTIVE_RATIFY_REJECTED: too_many_active'), 'too_many_active');
  assert.equal(parseRejection('some other error'), null);
  assert.equal(parseRejection(''), null);
  assert.equal(parseRejection(null), null);
});

// ── the read asymmetry: operator read THROWS, injection read DEGRADES ───────

test('objectiveList THROWS on transport failure (silence would read as "no objectives")', async () => {
  const { client } = makeFakeClient({ data: null, error: { message: 'boom' } });
  await assert.rejects(() => objectiveList('termdeck', { client }), /boom/);
});

test('fetchTier0Block DEGRADES on the same failure and says so', async () => {
  const { client } = makeFakeClient({ data: null, error: { message: 'boom' } });
  const block = await fetchTier0Block('termdeck', { client });
  assert.deepEqual(block.tier0, []);
  assert.equal(block.tier0_source, 'unavailable');
});

test('fetchTier0Block returns rows and source=rpc on the happy path', async () => {
  const { client } = makeFakeClient({ data: [row(), row({ id: ID_B, rank: 2 })], error: null });
  const block = await fetchTier0Block('termdeck', { client });
  assert.equal(block.tier0.length, 2);
  assert.equal(block.tier0_source, 'rpc');
});

test('fetchTier0Block short-circuits a blank project WITHOUT a round-trip', async () => {
  for (const p of [null, undefined, '', '   ']) {
    const { client, calls } = makeFakeClient();
    const block = await fetchTier0Block(p as never, { client });
    assert.deepEqual(block.tier0, []);
    assert.equal(block.tier0_source, 'unavailable');
    assert.equal(calls.length, 0, 'a project-less panel must not cost a round-trip');
  }
});

test('tier0 is never a null or absent field — always an array', async () => {
  const { client } = makeFakeClient({ data: null, error: null });
  const block = await fetchTier0Block('termdeck', { client });
  assert.ok(Array.isArray(block.tier0));
});

// ── Deck A's recall seam (§Seam 1) ──────────────────────────────────────────

test('tier0FetcherForRecall projects onto Deck A Tier0Item shape', async () => {
  const { client } = makeFakeClient({ data: [row({ rank: 2 })], error: null });
  const fetcher = tier0FetcherForRecall({ client });
  const items = await fetcher({ query: 'anything at all', project: 'termdeck' });
  assert.equal(items.length, 1);
  assert.deepEqual(Object.keys(items[0]!).sort(), [
    'content',
    'memory_id',
    'metadata',
    'project',
    'source_type',
  ]);
  assert.equal(items[0]!.memory_id, ID_A);
  assert.equal(items[0]!.source_type, 'objective');
  assert.equal(items[0]!.metadata.rank, 2);
  assert.equal(items[0]!.metadata.tier, 0);
});

test('the recall fetcher ignores the query — tier 0 is not retrieval', async () => {
  const { client, calls } = makeFakeClient({ data: [row()], error: null });
  const fetcher = tier0FetcherForRecall({ client });
  await fetcher({ query: 'how do I fix the PTY reaper', project: 'termdeck' });
  await fetcher({ query: 'something entirely unrelated', project: 'termdeck' });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0]!.args, calls[1]!.args, 'the same project must fetch the same block');
  assert.ok(
    !JSON.stringify(calls).includes('PTY reaper'),
    'the query must never reach the objectives RPC'
  );
});

test('the recall fetcher is fail-soft — a dead store degrades recall, never breaks it', async () => {
  const { client } = makeFakeClient({ data: null, error: { message: 'boom' } });
  const items = await tier0FetcherForRecall({ client })({ query: 'q', project: 'termdeck' });
  assert.deepEqual(items, []);
});

// ── history ─────────────────────────────────────────────────────────────────

test('objectiveHistory reads the table (not the RPC) and filters by project', async () => {
  const seen: Record<string, unknown> = {};
  const client = {
    rpc: async () => {
      throw new Error('objectiveHistory must not call the injection RPC');
    },
    from: (table: string) => {
      seen.table = table;
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: (col: string, val: unknown) => {
          seen.col = col;
          seen.val = val;
          return builder;
        },
        order: () => builder,
        then: (res: (v: unknown) => unknown) => res({ data: [row({ status: 'superseded' })], error: null }),
      };
      return builder;
    },
  } as never;
  const rows = await objectiveHistory('termdeck', { client });
  assert.equal(seen.table, 'memory_objectives');
  assert.equal(seen.col, 'project');
  assert.equal(seen.val, 'termdeck');
  assert.equal(rows[0]!.status, 'superseded');
});

// ── render ──────────────────────────────────────────────────────────────────

test('formatObjectives numbers in the order given and names the project when empty', () => {
  const out = formatObjectives([row({ content: 'first' }), row({ content: 'second', rank: 2 })], 'termdeck');
  assert.match(out, /## Objectives \(tier 0\) — termdeck/);
  assert.ok(out.indexOf('1. first') < out.indexOf('2. second'));
  assert.match(formatObjectives([], 'termdeck'), /No tier-0 objectives ratified for termdeck/);
  assert.match(formatObjectives([]), /No tier-0 objectives\./);
});

/**
 * Mnestra — memory_cite (Sprint 83 T2, the label producer)
 *
 * The acceptance bar for this sprint is that a REAL positive label flows from
 * an ordinary recall → cite round-trip. These are the unit half: that the
 * right RPC is called with the right narrowing, and — just as important — that
 * every failure is reported rather than swallowed. A citation tool that
 * silently records nothing is indistinguishable from one that works, and it
 * would leave the telemetry exactly as unusable as it is today while looking
 * fixed.
 *
 * Drives memoryCite through its deps seam; no Supabase access.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CITATION_RPC, memoryCite } from '../src/cite.js';

const GROUP = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const MEM_A = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';

interface Probe {
  rpcCalls: Array<{ name: string; args: Record<string, unknown> }>;
  logSelects: number;
}

function makeClient(
  probe: Probe,
  opts: {
    citeResult?: number;
    citeError?: string;
    groupRanks?: number[];
  } = {}
): any {
  return {
    rpc: async (name: string, args: Record<string, unknown>) => {
      probe.rpcCalls.push({ name, args });
      if (opts.citeError) return { data: null, error: { message: opts.citeError } };
      return { data: opts.citeResult ?? 0, error: null };
    },
    from: (table: string) => {
      assert.equal(table, 'memory_recall_log');
      return {
        select: (_cols: string) => ({
          eq: async (_col: string, _val: string) => {
            probe.logSelects++;
            return {
              data: (opts.groupRanks ?? []).map((rank) => ({ rank })),
              error: null,
            };
          },
        }),
      };
    },
  };
}

function newProbe(): Probe {
  return { rpcCalls: [], logSelects: 0 };
}

test('cites the named ranks through mark_recall_cited_group in one round-trip', async () => {
  const probe = newProbe();
  const client = makeClient(probe, { citeResult: 2 });

  const result = await memoryCite(
    { recall_group_id: GROUP, ranks: [1, 3], source_agent: 'claude' },
    { client }
  );

  assert.equal(result.ok, true);
  assert.equal(result.cited, 2);
  assert.equal(probe.rpcCalls.length, 1);
  assert.equal(probe.rpcCalls[0]!.name, CITATION_RPC);
  assert.deepEqual(probe.rpcCalls[0]!.args, {
    p_recall_group_id: GROUP,
    p_ranks: [1, 3],
    p_memory_ids: null,
    p_source_agent: 'claude',
  });
  // The happy path must not pay for the diagnostic lookup.
  assert.equal(probe.logSelects, 0);
});

test('all:true sends NULL narrowing rather than enumerating the group', async () => {
  const probe = newProbe();
  const client = makeClient(probe, { citeResult: 5 });

  const result = await memoryCite({ recall_group_id: GROUP, all: true }, { client });

  assert.equal(result.ok, true);
  assert.equal(probe.rpcCalls[0]!.args.p_ranks, null);
  assert.equal(probe.rpcCalls[0]!.args.p_memory_ids, null);
});

test('refuses to cite without narrowing — blanket citation must be deliberate', async () => {
  const probe = newProbe();
  const client = makeClient(probe, { citeResult: 9 });

  const result = await memoryCite({ recall_group_id: GROUP }, { client });

  assert.equal(result.ok, false);
  assert.match(result.error!, /nothing to cite/);
  // Nothing reached the database — the guard is before the round-trip.
  assert.equal(probe.rpcCalls.length, 0);
});

test('rejects a malformed recall_group_id before any round-trip', async () => {
  const probe = newProbe();
  const client = makeClient(probe, { citeResult: 1 });

  const result = await memoryCite({ recall_group_id: 'not-a-uuid', ranks: [1] }, { client });

  assert.equal(result.ok, false);
  assert.match(result.error!, /must be a UUID/);
  assert.equal(probe.rpcCalls.length, 0);
});

test('ranks are deduped and non-positive/non-integer values dropped', async () => {
  const probe = newProbe();
  const client = makeClient(probe, { citeResult: 1 });

  await memoryCite(
    { recall_group_id: GROUP, ranks: [2, 2, 0, -1, 3.5, 4] as number[] },
    { client }
  );

  assert.deepEqual(probe.rpcCalls[0]!.args.p_ranks, [2, 4]);
});

test('an unknown group is reported as unknown, NOT as "cited 0"', async () => {
  // The distinction matters: "you cited nothing" is a usage mistake the agent
  // can correct; "that id does not exist" means the label was lost and the
  // agent should not believe its work was recorded.
  const probe = newProbe();
  const client = makeClient(probe, { citeResult: 0, groupRanks: [] });

  const result = await memoryCite({ recall_group_id: GROUP, ranks: [1] }, { client });

  assert.equal(result.ok, false);
  assert.match(result.error!, /unknown recall_group_id/);
  assert.equal(probe.logSelects, 1);
});

test('out-of-range ranks get an explanation, not a bare failure', async () => {
  const probe = newProbe();
  const client = makeClient(probe, { citeResult: 0, groupRanks: [1, 2, 3] });

  const result = await memoryCite({ recall_group_id: GROUP, ranks: [9] }, { client });

  assert.equal(result.ok, false);
  assert.equal(result.group_size, 3);
  assert.match(result.error!, /3 hit\(s\).*ranks 1–3/);
});

test('an RPC error is returned, never thrown into the caller', async () => {
  const probe = newProbe();
  const client = makeClient(probe, { citeError: 'permission denied for function' });

  const result = await memoryCite({ recall_group_id: GROUP, ranks: [1] }, { client });

  assert.equal(result.ok, false);
  assert.match(result.error!, /permission denied/);
});

test('a thrown client never escapes memoryCite', async () => {
  const exploding: any = {
    rpc: async () => {
      throw new Error('socket hang up');
    },
  };

  const result = await memoryCite({ recall_group_id: GROUP, ranks: [1] }, { client: exploding });

  assert.equal(result.ok, false);
  assert.match(result.error!, /socket hang up/);
});

test('explicit memory_ids narrow the same way ranks do', async () => {
  const probe = newProbe();
  const client = makeClient(probe, { citeResult: 1 });

  await memoryCite({ recall_group_id: GROUP, memory_ids: [MEM_A, 'garbage'] }, { client });

  assert.deepEqual(probe.rpcCalls[0]!.args.p_memory_ids, [MEM_A]);
  assert.equal(probe.rpcCalls[0]!.args.p_ranks, null);
});

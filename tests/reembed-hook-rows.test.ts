/**
 * Mnestra — re-embed backfill script tests (Sprint 74 T3 scope-add).
 *
 * Pins the safety contract of src/reembed-hook-rows.ts:
 *   - dry-run (the default) performs ZERO writes and ZERO embed calls;
 *   - --execute re-embeds exactly the unstamped hook rows, spread-merging
 *     metadata (existing keys survive) and stamping the marker in the same
 *     update as the vector;
 *   - the marker makes a second run a no-op (idempotent / resumable);
 *   - a row whose embed fails is skipped, stays unstamped, and the run
 *     reports it; a batch with zero progress aborts instead of hot-looping;
 *   - --max-rows caps the work.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  runReembed,
  REEMBED_MARKER,
  HOOK_SOURCE_TYPES,
} from '../src/reembed-hook-rows.js';

interface FakeRow {
  id: string;
  content: string;
  metadata: Record<string, unknown> | null;
  source_type: string;
  is_active: boolean;
  archived: boolean;
  project: string;
  created_at: string;
  embedding: string | null;
  updated_at?: string;
}

function hookRow(id: string, overrides: Partial<FakeRow> = {}): FakeRow {
  return {
    id,
    content: `checkpoint content ${id}`,
    metadata: {},
    source_type: 'session_summary',
    is_active: true,
    archived: false,
    project: 'termdeck',
    created_at: `2026-05-0${id.slice(-1)}T00:00:00.000Z`,
    embedding: '[small]',
    ...overrides,
  };
}

/**
 * Fake Supabase client covering the exact builder chains the script uses:
 * select(+count/head).in().or().eq()*.order().limit() and update().eq('id').
 * The .or() arm is interpreted semantically as "unstamped" (the script always
 * passes the same IS-DISTINCT-FROM-marker filter).
 */
function makeFakeClient(rows: FakeRow[], probe: { updates: number }): any {
  function makeChain(): any {
    const state = {
      head: false,
      ins: null as string[] | null,
      or: false,
      eqs: [] as Array<[string, unknown]>,
      limit: Infinity,
      update: null as Record<string, unknown> | null,
    };
    const chain: any = {
      select: (_cols: string, opts?: { count?: string; head?: boolean }) => {
        state.head = Boolean(opts?.head);
        return chain;
      },
      in: (_col: string, vals: readonly string[]) => {
        state.ins = [...vals];
        return chain;
      },
      or: (_filter: string) => {
        state.or = true;
        return chain;
      },
      eq: (col: string, val: unknown) => {
        state.eqs.push([col, val]);
        return chain;
      },
      order: () => chain,
      limit: (n: number) => {
        state.limit = n;
        return chain;
      },
      update: (payload: Record<string, unknown>) => {
        state.update = payload;
        return chain;
      },
      then: (resolve: (v: unknown) => void) => {
        if (state.update) {
          const idEq = state.eqs.find(([c]) => c === 'id');
          const row = rows.find((r) => r.id === idEq?.[1]);
          if (row) {
            row.embedding = String(state.update.embedding);
            row.metadata = state.update.metadata as Record<string, unknown>;
            row.updated_at = String(state.update.updated_at);
            probe.updates += 1;
          }
          resolve({ error: row ? null : { message: 'row not found' } });
          return;
        }
        let matched = rows.filter(
          (r) =>
            (!state.ins || state.ins.includes(r.source_type)) &&
            (!state.or || (r.metadata ?? {}).embedding_model !== REEMBED_MARKER) &&
            state.eqs.every(([c, v]) => (r as unknown as Record<string, unknown>)[c] === v)
        );
        matched = [...matched]
          .sort((a, b) => a.created_at.localeCompare(b.created_at))
          .slice(0, state.head ? Infinity : state.limit);
        if (state.head) {
          resolve({ count: matched.length, error: null });
        } else {
          resolve({
            data: matched.map((r) => ({
              id: r.id,
              content: r.content,
              metadata: r.metadata,
              source_type: r.source_type,
            })),
            error: null,
          });
        }
      },
    };
    return chain;
  }
  return {
    from: (table: string) => {
      assert.equal(table, 'memory_items');
      return makeChain();
    },
  };
}

function makeEmbed(failFor: Set<string> = new Set()) {
  const calls: string[] = [];
  const embed = async (text: string) => {
    calls.push(text);
    if (failFor.has(text)) throw new Error('embed boom');
    return new Array(1536).fill(0.5);
  };
  return { embed, calls };
}

const FIXED_NOW = '2026-06-11T20:45:00.000Z';
const quietDeps = { log: () => {}, sleep: async () => {}, now: () => FIXED_NOW };

function fixture(): FakeRow[] {
  return [
    hookRow('row-1', { source_type: 'session_summary', metadata: { foo: 'bar' } }),
    hookRow('row-2', { source_type: 'pre_compact_snapshot' }),
    // Already stamped — must be excluded by selection.
    hookRow('row-3', { metadata: { embedding_model: REEMBED_MARKER } }),
    // Not a hook source_type — out of scope entirely.
    hookRow('row-4', { source_type: 'fact' }),
    // Archived — excluded under default options.
    hookRow('row-5', { archived: true }),
  ];
}

test('dry-run (default) counts and samples but performs zero writes and zero embeds', async () => {
  const rows = fixture();
  const probe = { updates: 0 };
  const { embed, calls } = makeEmbed();

  const stats = await runReembed({}, { client: makeFakeClient(rows, probe), generateEmbedding: embed, ...quietDeps });

  assert.equal(stats.dryRun, true);
  assert.equal(stats.pending, 2);
  assert.deepEqual(stats.pendingBySourceType, { session_summary: 1, pre_compact_snapshot: 1 });
  assert.deepEqual([...stats.sampleIds].sort(), ['row-1', 'row-2']);
  assert.equal(stats.reembedded, 0);
  assert.equal(probe.updates, 0, 'dry-run must not write');
  assert.equal(calls.length, 0, 'dry-run must not embed');
  assert.equal(rows[0]!.embedding, '[small]', 'vectors untouched in dry-run');
});

test('--execute re-embeds exactly the unstamped hook rows, stamping the marker and preserving metadata keys', async () => {
  const rows = fixture();
  const probe = { updates: 0 };
  const { embed, calls } = makeEmbed();

  const stats = await runReembed(
    { execute: true, sleepMs: 0 },
    { client: makeFakeClient(rows, probe), generateEmbedding: embed, ...quietDeps }
  );

  assert.equal(stats.reembedded, 2);
  assert.equal(stats.failed, 0);
  assert.equal(probe.updates, 2);
  assert.equal(calls.length, 2);

  const r1 = rows.find((r) => r.id === 'row-1')!;
  assert.notEqual(r1.embedding, '[small]', 'vector replaced');
  assert.match(r1.embedding!, /^\[0\.5,/, 'pgvector literal from the injected embedder');
  assert.equal(r1.metadata!.embedding_model, REEMBED_MARKER, 'marker stamped');
  assert.equal(r1.metadata!.foo, 'bar', 'pre-existing metadata keys preserved (merge, not replace)');
  assert.equal(r1.metadata!.reembedded_at, FIXED_NOW);
  assert.equal(r1.updated_at, FIXED_NOW);

  // Out-of-scope rows untouched.
  assert.equal(rows.find((r) => r.id === 'row-3')!.embedding, '[small]');
  assert.equal(rows.find((r) => r.id === 'row-4')!.embedding, '[small]');
  assert.equal(rows.find((r) => r.id === 'row-5')!.embedding, '[small]');
});

test('idempotent: a second --execute run is a no-op (marker-based resume)', async () => {
  const rows = fixture();
  const probe = { updates: 0 };
  const { embed } = makeEmbed();
  const deps = { client: makeFakeClient(rows, probe), generateEmbedding: embed, ...quietDeps };

  const first = await runReembed({ execute: true, sleepMs: 0 }, deps);
  assert.equal(first.reembedded, 2);

  const second = await runReembed({ execute: true, sleepMs: 0 }, deps);
  assert.equal(second.pending, 0);
  assert.equal(second.reembedded, 0);
  assert.equal(probe.updates, 2, 'no extra writes on the second run');
});

test('a failing embed skips the row (stays unstamped for the next run) and the run reports it', async () => {
  const rows = fixture();
  const probe = { updates: 0 };
  const { embed } = makeEmbed(new Set(['checkpoint content row-1']));

  const stats = await runReembed(
    { execute: true, sleepMs: 0 },
    { client: makeFakeClient(rows, probe), generateEmbedding: embed, ...quietDeps }
  );

  assert.equal(stats.reembedded, 1);
  assert.equal(stats.failed, 1);
  const r1 = rows.find((r) => r.id === 'row-1')!;
  assert.equal(r1.embedding, '[small]', 'failed row keeps its old vector');
  assert.notEqual((r1.metadata ?? {}).embedding_model, REEMBED_MARKER, 'failed row stays unstamped');
});

test('zero-progress batch aborts instead of hot-looping', async () => {
  const rows = fixture();
  const probe = { updates: 0 };
  const { embed, calls } = makeEmbed(
    new Set(['checkpoint content row-1', 'checkpoint content row-2'])
  );

  const stats = await runReembed(
    { execute: true, sleepMs: 0 },
    { client: makeFakeClient(rows, probe), generateEmbedding: embed, ...quietDeps }
  );

  assert.equal(stats.batches, 1, 'aborted after the first zero-progress batch');
  assert.equal(stats.reembedded, 0);
  assert.equal(stats.failed, 2);
  assert.equal(calls.length, 2, 'no re-attempt of the same poisoned batch in this run');
});

test('--max-rows caps the work and leaves the remainder pending', async () => {
  const rows = fixture();
  const probe = { updates: 0 };
  const { embed } = makeEmbed();
  const deps = { client: makeFakeClient(rows, probe), generateEmbedding: embed, ...quietDeps };

  const capped = await runReembed({ execute: true, sleepMs: 0, maxRows: 1 }, deps);
  assert.equal(capped.reembedded, 1);

  const rest = await runReembed({}, deps);
  assert.equal(rest.pending, 1, 'one row left for the next slice');
});

test('HOOK_SOURCE_TYPES stays pinned to the two hook-only source_types', () => {
  assert.deepEqual([...HOOK_SOURCE_TYPES], ['session_summary', 'pre_compact_snapshot']);
});

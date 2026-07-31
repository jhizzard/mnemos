/**
 * Mnestra — write-time extraction FAILS OPEN (Sprint 83 T2)
 *
 * The non-negotiable property: a memory write NEVER fails, and never slows
 * measurably, because extraction failed. Extraction is an enrichment — a
 * missing edge is recoverable by the nightly inference job and by T3's
 * consolidation, whereas a lost memory is not recoverable by anything.
 *
 * Every case here is a way extraction can go wrong (no API key, model throws,
 * budget blown, pre-034 database, malformed response) paired with the same
 * assertion: the write still landed, and nothing threw.
 */

import assert from 'node:assert/strict';
import { test, beforeEach, afterEach } from 'node:test';

import {
  __resetExtractState,
  drainWriteExtractions,
  extractGraphForMemory,
  scheduleWriteExtraction,
} from '../src/extract_write.js';
import { memoryRemember } from '../src/remember.js';

const MEM = 'cccccccc-3333-4333-8333-cccccccccccc';

const CONTENT =
  'KITCHEN — when a fail-soft writer starts emitting a NEW persisted enum value, ' +
  'the paired DB CHECK-constraint migration must ship in the SAME wave, or every ' +
  'write of that value fails with Postgres 23514 and the capture is silently lost.';

const SIGNATURE = {
  v: 1,
  class: 'err-pg-permission-denied',
  symptom: 'error: permission denied for table memory_items (code: <n>)',
  symptom_hash: '9a9696cad614c557c31d68c6e14c4253',
  extracted_by: 'write-time/regex@1',
  extracted_at: '2026-07-31T18:00:00.000Z',
};

const priorEnv = process.env.MNESTRA_EXTRACT_ENABLED;

beforeEach(() => {
  __resetExtractState();
  process.env.MNESTRA_EXTRACT_ENABLED = '1';
});

afterEach(() => {
  if (priorEnv === undefined) delete process.env.MNESTRA_EXTRACT_ENABLED;
  else process.env.MNESTRA_EXTRACT_ENABLED = priorEnv;
});

/** Client whose every DB surface is present and succeeds. */
function okClient(probe: { rpcs: Array<{ name: string; args: any }> }): any {
  return {
    rpc: async (name: string, args: Record<string, unknown>) => {
      probe.rpcs.push({ name, args });
      if (name === 'upsert_memory_entities') {
        return { data: { entity_ids: ['e1'], created: 1, linked: 1, dropped: 0 }, error: null };
      }
      if (name === 'upsert_memory_edges') {
        return { data: { accepted: 1, dropped: 0, dropped_predicates: [] }, error: null };
      }
      return { data: null, error: null };
    },
    from: (table: string) => {
      const chain: any = {
        select: () => chain,
        eq: () => chain,
        neq: () => chain,
        limit: async () => {
          if (table === 'memory_items') return { data: [{ id: 'dddddddd-4444-4444-8444-dddddddddddd' }], error: null };
          return { data: [], error: null };
        },
        then: undefined,
      };
      if (table === 'memory_relationship_types') {
        return { select: async () => ({ data: [{ type: 'same_pattern_as' }], error: null }) };
      }
      if (table === 'memory_entity_types') {
        return { select: async () => ({ data: [{ entity_type: 'file' }], error: null }) };
      }
      return chain;
    },
  };
}

/** Client that behaves like a database where migration 034 was never applied. */
function pre034Client(): any {
  return {
    rpc: async () => ({
      data: null,
      error: { message: 'Could not find the function public.upsert_memory_edges' },
    }),
    from: (table: string) => {
      if (table === 'memory_relationship_types' || table === 'memory_entity_types') {
        return {
          select: async () => ({ data: null, error: { message: 'relation does not exist' } }),
        };
      }
      const chain: any = {
        select: () => chain,
        eq: () => chain,
        neq: () => chain,
        limit: async () => ({ data: [{ id: 'dddddddd-4444-4444-8444-dddddddddddd' }], error: null }),
      };
      return chain;
    },
  };
}

test('disabled by default — no env flag means no model call and no writes', async () => {
  delete process.env.MNESTRA_EXTRACT_ENABLED;
  const probe = { rpcs: [] as any[] };
  const report = await extractGraphForMemory(
    { memory_id: MEM, content: CONTENT, project: 'termdeck' },
    { client: okClient(probe), extract: async () => assert.fail('must not call the model') }
  );
  assert.equal(report.ok, false);
  assert.equal(report.reason, 'disabled');
  assert.equal(probe.rpcs.length, 0);
});

test('a throwing extractor is reported, never rethrown', async () => {
  const probe = { rpcs: [] as any[] };
  const report = await extractGraphForMemory(
    { memory_id: MEM, content: CONTENT, project: 'termdeck' },
    {
      client: okClient(probe),
      extract: async () => {
        throw new Error('anthropic 529 overloaded');
      },
    }
  );
  assert.equal(report.ok, true, 'the run completed; only the model half failed');
  assert.match(report.reason!, /llm-failed: anthropic 529/);
  assert.equal(report.entities_written, 0);
});

test('budget exhaustion aborts the model call and is reported as such', async () => {
  const probe = { rpcs: [] as any[] };
  const report = await extractGraphForMemory(
    { memory_id: MEM, content: CONTENT, project: 'termdeck' },
    {
      client: okClient(probe),
      budgetMs: 20,
      extract: (_c, _v, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    }
  );
  assert.equal(report.reason, 'llm-budget-exceeded');
  assert.equal(report.ok, true);
});

test('a pre-034 database latches unavailable and stops re-probing', async () => {
  const client = pre034Client();
  const input = { memory_id: MEM, content: CONTENT, project: 'termdeck', problem_signature: SIGNATURE };
  const extract = async () => ({
    entities: [{ name: 'recall_log.ts', type: 'file' }],
    triples: [],
  });

  const first = await extractGraphForMemory(input, { client, extract });
  assert.equal(first.same_pattern_edges, 0);
  assert.equal(first.entities_written, 0);

  // Second call short-circuits on the latch: both capabilities are now known
  // unavailable, so it does not pay for the probe again.
  const second = await extractGraphForMemory(input, { client, extract });
  assert.equal(second.reason, 'pre-034-latched');
});

test('short content is skipped before any model or database work', async () => {
  const probe = { rpcs: [] as any[] };
  const report = await extractGraphForMemory(
    { memory_id: MEM, content: 'too short', project: 'termdeck' },
    { client: okClient(probe), extract: async () => assert.fail('must not call the model') }
  );
  assert.equal(report.reason, 'content-too-short');
  assert.equal(probe.rpcs.length, 0);
});

test('same_pattern_as edges land WITHOUT the model — deterministic half is independent', async () => {
  const probe = { rpcs: [] as any[] };
  const report = await extractGraphForMemory(
    { memory_id: MEM, content: CONTENT, project: 'termdeck', problem_signature: SIGNATURE },
    {
      client: okClient(probe),
      extract: async () => {
        throw new Error('no API key');
      },
    }
  );
  // The model failed; the edge that powers "you solved this before" still landed.
  assert.equal(report.same_pattern_edges, 1);
  const edgeCall = probe.rpcs.find((r) => r.name === 'upsert_memory_edges');
  assert.ok(edgeCall, 'expected an upsert_memory_edges call');
  assert.equal(edgeCall.args.p_edges[0].predicate, 'same_pattern_as');
  assert.equal(edgeCall.args.p_edges[0].source_id, MEM);
});

test('entities go through the RPC with the {name,type} shape — no client-side key derivation', async () => {
  const probe = { rpcs: [] as any[] };
  await extractGraphForMemory(
    { memory_id: MEM, content: CONTENT, project: 'termdeck' },
    {
      client: okClient(probe),
      extract: async () => ({
        entities: [{ name: '  Recall_Log.ts  ', type: 'file', span: 'recall_log.ts' }],
        triples: [{ subject: 'a', predicate: 'part_of', object: 'b' }],
      }),
    }
  );
  const call = probe.rpcs.find((r) => r.name === 'upsert_memory_entities');
  assert.ok(call);
  // The raw name is forwarded; normalization is the RPC's job so two clients
  // cannot split one canonical entity by disagreeing on whitespace.
  assert.equal(call.args.p_entities[0].name, 'Recall_Log.ts');
  assert.equal(call.args.p_entities[0].type, 'file');
  assert.ok(!('entity_key' in call.args.p_entities[0]));
});

test('entity-level triples are extracted but NOT written as memory edges', async () => {
  // memory_relationships is memory↔memory; a triple between two entity names
  // has nowhere to live in 034. Recording them anywhere else to look complete
  // would be worse than leaving them unstored.
  const probe = { rpcs: [] as any[] };
  const report = await extractGraphForMemory(
    { memory_id: MEM, content: CONTENT, project: 'termdeck' },
    {
      client: okClient(probe),
      extract: async () => ({
        entities: [{ name: 'mnestra', type: 'project' }],
        triples: [{ subject: 'recall_log.ts', predicate: 'part_of', object: 'mnestra' }],
      }),
    }
  );
  assert.equal(report.triples_extracted.length, 1);
  const edgeCalls = probe.rpcs.filter((r) => r.name === 'upsert_memory_edges');
  assert.equal(edgeCalls.length, 0, 'no problem_signature ⇒ no edges at all this run');
});

test('a malformed extractor response cannot crash the run', async () => {
  const probe = { rpcs: [] as any[] };
  const report = await extractGraphForMemory(
    { memory_id: MEM, content: CONTENT, project: 'termdeck' },
    {
      client: okClient(probe),
      extract: async () => ({ entities: null, triples: undefined } as any),
    }
  );
  assert.equal(report.ok, false);
  assert.match(report.reason!, /unexpected/);
});

test('scheduleWriteExtraction is synchronous and never throws', () => {
  assert.doesNotThrow(() => {
    scheduleWriteExtraction({ memory_id: MEM, content: CONTENT, project: 'termdeck' }, {
      client: pre034Client(),
      extract: async () => {
        throw new Error('boom');
      },
    });
  });
});

test('THE BAR: memoryRemember still succeeds when every extraction surface fails', async () => {
  // The whole contract in one case. The Supabase client here has no 034
  // functions and no vocabulary tables; extraction cannot do anything. The
  // write must land regardless, and the caller must see a normal result.
  const inserted: Record<string, unknown>[] = [];
  const client: any = {
    rpc: async (name: string) => {
      if (name === 'match_memories') return { data: [], error: null };
      return { data: null, error: { message: 'function does not exist' } };
    },
    from: (table: string) => {
      if (table === 'memory_relationship_types' || table === 'memory_entity_types') {
        return { select: async () => ({ data: null, error: { message: 'relation does not exist' } }) };
      }
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({
              eq: () => ({ neq: () => ({ eq: () => ({ limit: async () => ({ data: null, error: { message: 'no' } }) }) }) }),
            }),
          }),
        }),
        insert: (payload: Record<string, unknown>) => {
          inserted.push(payload);
          return {
            select: () => ({ maybeSingle: async () => ({ data: { id: MEM }, error: null }) }),
          };
        },
      };
    },
  };

  const result = await memoryRemember(
    {
      content: 'ERROR:  permission denied for table memory_items (code: 42501) — fixed by granting service_role.',
      project: 'termdeck',
      source_type: 'bug_fix',
    },
    { client, generateEmbedding: async () => new Array(1536).fill(0) }
  );

  assert.equal(result, 'inserted', 'the write must land even though extraction cannot');
  assert.equal(inserted.length, 1);

  // …and the inline, network-free half still stamped its signature. Exact
  // hash values are pinned by the golden vectors; what matters HERE is that
  // the signature survived a run in which every remote surface was broken.
  const metadata = inserted[0]!.metadata as Record<string, any>;
  assert.equal(metadata.problem_signature.class, 'err-pg-permission-denied');
  assert.match(metadata.problem_signature.symptom_hash, /^[0-9a-f]{32}$/);
  assert.match(metadata.problem_signature.symptom, /permission denied for table memory_items/);

  await drainWriteExtractions(2_000);
});

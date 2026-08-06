/**
 * Mnestra — Sprint 70 A-T2: `MNESTRA_GRAPH_RECALL` ships DARK.
 *
 * This is the fence, not a feature test. The sprint promotes the graph walk to
 * be `memory_recall`'s engine, on a live daily-driver store, behind an env
 * flag that defaults OFF — and "defaults OFF" is worth exactly as much as the
 * test that proves it. So the OFF assertions are deliberately paranoid:
 *
 *   • the RPC called is memory_hybrid_search and NOTHING else — a graph RPC
 *     firing at all would mean the flag leaked;
 *   • `text` is compared character-for-character, because the text IS the
 *     product on an MCP surface (a reordered line changes what the agent
 *     reads);
 *   • the `[n]` handles and the cite hint survive, because those are the label
 *     producer and a desync there silently poisons recall telemetry;
 *   • unset / '' / 'off' / '0' / 'no' all mean OFF. Only an explicit truthy
 *     value flips it.
 *
 * ON, the same call must keep every memory_recall contract it had — handles,
 * min_results-before-budget, ONE telemetry write, one recall_group_id — while
 * the ranking comes from the graph and hubs render with their citations.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { memoryRecall, graphRecallEnabled } from '../src/recall.js';
import {
  __resetGraphWalkProbe,
  renderTier0,
  LEGACY_GRAPH_RPC,
  BOOSTED_GRAPH_RPC,
} from '../src/recall_graph.js';

const FLAG = 'MNESTRA_GRAPH_RECALL';
const fakeEmbed = async (_text: string) => new Array(1536).fill(0);
const NOW = '2026-08-01T00:00:00.000Z';
const M = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const HUB = '11111111-1111-4111-8111-111111111111';

function withFlag<T>(value: string | undefined, fn: () => Promise<T>): Promise<T> {
  const prev = process.env[FLAG];
  if (value === undefined) delete process.env[FLAG];
  else process.env[FLAG] = value;
  return fn().finally(() => {
    if (prev === undefined) delete process.env[FLAG];
    else process.env[FLAG] = prev;
  });
}

const hybridRows = [
  {
    id: M(1),
    content: 'alpha fact about the deck',
    source_type: 'decision',
    category: null,
    project: 'termdeck',
    metadata: { importance: 'important' },
    score: 0.031,
    created_at: NOW,
    privacy_tags: [],
  },
  {
    id: M(2),
    content: 'bravo unrelated note',
    source_type: 'fact',
    category: null,
    project: 'termdeck',
    metadata: {},
    score: 0.021,
    created_at: NOW,
    privacy_tags: [],
  },
];

interface Probe {
  rpc: string[];
  from: string[];
}

function hybridClient(probe: Probe): any {
  return {
    rpc: async (name: string) => {
      probe.rpc.push(name);
      if (name === 'memory_hybrid_search') return { data: hybridRows, error: null };
      return { data: null, error: { message: `unexpected rpc ${name}` } };
    },
    from: (table: string) => {
      probe.from.push(table);
      const chain: any = {
        select: () => chain,
        eq: () => chain,
        in: () => chain,
        limit: () => chain,
        then: (resolve: (v: unknown) => void) => resolve({ data: [], error: null }),
      };
      return chain;
    },
  };
}

/**
 * The pre-Sprint-70 render, longhand. NOT hand-derived: an earlier draft of
 * this fixture carried a guessed "28 tokens" and A-T4 correctly refused to
 * accept a parity claim resting on a number nobody had observed. The values
 * below come from running HEAD's (pre-sprint) `memoryRecall` against this
 * exact fixture, and the whole OFF path was then differentially proven against
 * that same HEAD build across ten input shapes — plain, cross-project, tight
 * budget, budget-1/min-0 (the cite-hint suppression branch), privacy opt-in,
 * source_agents ± null-source, empty query, zero rows, rpc error — with text,
 * tokens_used, hit ids and recall_group_id nullability identical in every one.
 *
 * If a future change alters one character of memory_recall's default output,
 * this literal is what fails.
 */
const EXPECTED_OFF_TEXT_BODY =
  '2 memories (21 tokens, project: termdeck):\n\n' +
  '[1] (decision/important) alpha fact about the deck\n' +
  '[2] (fact) bravo unrelated note';

test('the seam block is a literal no-op when tier0 is empty', () => {
  // This is WHY threading tier0 through the default path cannot move a byte:
  // the rendered prefix is the empty string, and `${''}${header}` is `header`.
  // Pinned here so the OFF-path guarantee does not depend on reading recall.ts.
  assert.equal(renderTier0([]), '');
});

test('OFF is the default: unset flag routes through memory_hybrid_search, text unchanged', async () => {
  const probe: Probe = { rpc: [], from: [] };
  const out = await withFlag(undefined, () =>
    memoryRecall(
      { query: 'deck', project: 'termdeck' },
      { client: hybridClient(probe), generateEmbedding: fakeEmbed }
    )
  );

  assert.deepEqual(probe.rpc, ['memory_hybrid_search'], 'no graph RPC is reachable with the flag off');
  assert.ok(!probe.rpc.includes(LEGACY_GRAPH_RPC) && !probe.rpc.includes(BOOSTED_GRAPH_RPC));
  // FULL equality, not startsWith: a prefix assertion would pass even if the
  // seam appended something after the results.
  assert.equal(
    out.text,
    `${EXPECTED_OFF_TEXT_BODY}\n\nUsed any of these? Call memory_cite(recall_group_id="${out.recall_group_id}", ` +
      `ranks=[…]) with the [n] of the ones that actually informed your work — not all of them.`,
    'byte-identical: header, [n]-handled body, and cite hint — nothing before, nothing after'
  );
  assert.deepEqual(out.hits.map((h) => h.id), [M(1), M(2)]);
  assert.equal(out.tokens_used, 21);
  assert.deepEqual(out.tier0, [], 'the seam block exists on the DEFAULT envelope, empty');
  assert.equal(out.graph_units, undefined, 'no graph units on the default path');
});

test('only an explicit truthy value flips the flag', async () => {
  for (const off of ['', ' ', '0', 'off', 'no', 'false', 'graph']) {
    await withFlag(off, async () => {
      assert.equal(graphRecallEnabled(), false, `${JSON.stringify(off)} must read as OFF`);
    });
  }
  for (const on of ['1', 'true', 'on', 'YES', ' On ']) {
    await withFlag(on, async () => {
      assert.equal(graphRecallEnabled(), true, `${JSON.stringify(on)} must read as ON`);
    });
  }
});

test('OFF-path parity holds for the empty-result and error branches too', async () => {
  const empty: any = {
    rpc: async () => ({ data: [], error: null }),
    from: () => ({ select: () => ({ in: () => ({ then: (r: any) => r({ data: [], error: null }) }) }) }),
  };
  const outEmpty = await withFlag(undefined, () =>
    memoryRecall({ query: 'nothing' }, { client: empty, generateEmbedding: fakeEmbed })
  );
  assert.equal(outEmpty.text, 'No relevant memories found.');
  assert.deepEqual(outEmpty.tier0, []);

  const broken: any = {
    rpc: async () => ({ data: null, error: { message: 'rpc exploded' } }),
    from: () => ({ select: () => ({ in: () => ({ then: (r: any) => r({ data: [], error: null }) }) }) }),
  };
  const outErr = await withFlag(undefined, () =>
    memoryRecall({ query: 'boom' }, { client: broken, generateEmbedding: fakeEmbed })
  );
  assert.equal(outErr.text, 'Search error: rpc exploded');
});

// ─────────────────────────────────────────────────────────────────────────
// ON — the graph engine answers memory_recall, presentation contract intact
// ─────────────────────────────────────────────────────────────────────────

function graphClient(probe: Probe): any {
  const walkRows = [
    { memory_id: M(1), content: 'member one', project: 'termdeck', depth: 0, vector_score: 0.9, edge_weight: 1, recency_score: 1, final_score: 0.9, path: [M(1)] },
    { memory_id: M(2), content: 'member two', project: 'termdeck', depth: 1, vector_score: 0.8, edge_weight: 1, recency_score: 1, final_score: 0.8, path: [M(2)] },
    { memory_id: M(3), content: 'member three', project: 'termdeck', depth: 1, vector_score: 0.7, edge_weight: 1, recency_score: 1, final_score: 0.7, path: [M(3)] },
    { memory_id: M(9), content: 'a lone neighbour', project: 'termdeck', depth: 2, vector_score: 0.4, edge_weight: 1, recency_score: 1, final_score: 0.4, path: [M(9)] },
  ];
  const items = [
    { id: M(1) },
    { id: M(2) },
    { id: M(3) },
    { id: M(9) },
    {
      id: HUB,
      content: 'the compiled community summary',
      project: 'termdeck',
      source_type: 'consolidation_summary',
      created_at: NOW,
      metadata: {
        consolidation: {
          kind: 'community_summary',
          community_key: HUB,
          member_ids: [M(1), M(2), M(3)],
          member_count: 7,
        },
      },
    },
  ];
  return {
    rpc: async (name: string) => {
      probe.rpc.push(name);
      if (name === BOOSTED_GRAPH_RPC) return { data: null, error: { message: 'not deployed' } };
      if (name === LEGACY_GRAPH_RPC) return { data: walkRows, error: null };
      return { data: null, error: { message: `unexpected rpc ${name}` } };
    },
    from: (table: string) => {
      probe.from.push(table);
      const filters: ((r: any) => boolean)[] = [];
      const chain: any = {
        select: () => chain,
        eq: (col: string, val: unknown) => {
          filters.push((r) => r[col] === val);
          return chain;
        },
        in: (col: string, vals: unknown[]) => {
          filters.push((r) => vals.includes(r[col]));
          return chain;
        },
        limit: () => chain,
        then: (resolve: (v: unknown) => void) =>
          resolve({ data: items.filter((r) => filters.every((f) => f(r))), error: null }),
      };
      return chain;
    },
  };
}

test('ON: memory_recall is answered by the graph walk, hub-collapsed, handles intact', async () => {
  __resetGraphWalkProbe();
  const probe: Probe = { rpc: [], from: [] };
  const out = await withFlag('on', () =>
    memoryRecall(
      { query: 'community query', project: 'termdeck' },
      { client: graphClient(probe), generateEmbedding: fakeEmbed }
    )
  );

  assert.ok(probe.rpc.includes(LEGACY_GRAPH_RPC), 'the graph walk answered');
  assert.ok(!probe.rpc.includes('memory_hybrid_search'), 'and hybrid search was not called at all');

  assert.equal(out.graph_units!.length, 2, 'three members collapsed into one hub, plus the lone neighbour');
  assert.equal(out.graph_units![0]!.kind, 'hub');
  assert.match(out.text, /^2 memories \(graph-recall, \d+ tokens, project: termdeck, 1 hub\):/);
  assert.match(out.text, /\[1\] \(hub: 3 of 7 members\) the compiled community summary/);
  assert.match(out.text, /↳ collapsed members \(expand by id\):/);
  assert.match(out.text, /· 00000000 — member one/, 'members degrade to id + one-line gist');
  assert.match(out.text, /\[2\] \(memory d2\) a lone neighbour/);
  assert.ok(
    out.text.includes(`memory_cite(recall_group_id="${out.recall_group_id}"`),
    'the label producer survives the swap — a citation still resolves to a logged rank'
  );
  assert.deepEqual(
    out.hits.map((h) => h.id),
    [HUB, M(9)],
    'hits stays RecallHit-shaped: a hub arrives as its consolidation_summary row'
  );
  assert.equal(out.hits[0]!.source_type, 'consolidation_summary');
  assert.deepEqual(out.tier0, []);
});

test('ON: min_results is honoured before the token budget, exactly as on the default path', async () => {
  __resetGraphWalkProbe();
  const probe: Probe = { rpc: [], from: [] };
  const out = await withFlag('1', () =>
    memoryRecall(
      { query: 'community query', project: 'termdeck', token_budget: 1, min_results: 2 },
      { client: graphClient(probe), generateEmbedding: fakeEmbed }
    )
  );
  assert.equal(out.graph_units!.length, 2, 'a 1-token budget still yields min_results units');
  assert.ok(out.tokens_used > 1, 'because the minimum is built BEFORE the budget is applied');
});

test('ON: an empty walk returns the ordinary empty text, not an error', async () => {
  __resetGraphWalkProbe();
  const emptyGraph: any = {
    rpc: async (name: string) =>
      name === BOOSTED_GRAPH_RPC
        ? { data: null, error: { message: 'not deployed' } }
        : { data: [], error: null },
    from: () => ({
      select: () => ({
        eq: () => ({ limit: () => ({ then: (r: any) => r({ data: [], error: null }) }) }),
        in: () => ({ then: (r: any) => r({ data: [], error: null }) }),
      }),
    }),
  };
  const out = await withFlag('true', () =>
    memoryRecall({ query: 'nothing here' }, { client: emptyGraph, generateEmbedding: fakeEmbed })
  );
  assert.equal(out.text, 'No relevant memories found.');
  assert.equal(out.recall_group_id, null, 'nothing was logged, so there is no group to cite');
  assert.deepEqual(out.tier0, []);
});

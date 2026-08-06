/**
 * Mnestra — Sprint 70 A-T2: hub coarse-to-fine, the seam envelope, the
 * 037 compat shim, and the privacy gate the graph surface never had.
 *
 * What these tests pin, and why each one is load-bearing:
 *
 *   1. ENVELOPE (§Seam 1). `tier0` exists, is FIRST in the rendered text, is
 *      never interleaved with results and is never absorbed by a hub. Deck A
 *      emits `[]`; the test proves the block renders correctly when B-T1's
 *      `fetchTier0` is wired, because a stub nobody can fill is not a seam.
 *   2. COMPAT SHIM. The boosted walk (migration 037) is preferred and degrades
 *      to 010 when it isn't deployed — this file ships BEFORE 037 is applied
 *      anywhere, so the fallback is the normal path today, not the edge case.
 *      The negative probe is memoized: one 404 per process, not one per recall.
 *   3. HUB COLLAPSE. ≥ N members of one community → the community's compiled
 *      summary becomes the primary unit and the members degrade to id + gist
 *      citations. Below N, nothing changes. N is tunable, 0 disables.
 *   4. PRIVACY. 010 returns no privacy_tags, so this surface has been
 *      privacy-blind since Sprint 38; the gate now holds on both walks, and a
 *      summary the caller can't see cannot stand in for its members.
 *   5. RENDER PARITY. With no hub and no tier-0 the text is character-for-
 *      character the pre-Sprint-70 output. That is the fence that makes the
 *      whole feature safe to ship on a live daily-driver store.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  memoryRecallGraph,
  __resetGraphWalkProbe,
  BOOSTED_GRAPH_RPC,
  LEGACY_GRAPH_RPC,
  type GraphRecallHit,
} from '../src/recall_graph.js';

const fakeEmbed = async (_text: string) => new Array(1536).fill(0);

const M = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const HUB = '11111111-1111-4111-8111-111111111111';
const HUB2 = '22222222-2222-4222-8222-222222222222';

interface Probe {
  rpc: string[];
  from: string[];
  args: Record<string, unknown>[];
}

interface ItemRow {
  id: string;
  source_type?: string;
  metadata?: Record<string, unknown> | null;
  privacy_tags?: string[] | null;
  created_at?: string;
  source_agent?: string | null;
  content?: string;
  project?: string;
}

function walkRow(id: string, score: number, depth = 0): GraphRecallHit {
  return {
    memory_id: id,
    content: `body of ${id.slice(-4)}`,
    project: 'termdeck',
    depth,
    vector_score: score,
    edge_weight: 1,
    recency_score: 1,
    final_score: score,
    path: [id],
  };
}

function community(
  hubId: string,
  memberIds: string[],
  extra: Partial<ItemRow> = {}
): ItemRow {
  return {
    id: hubId,
    content: `compiled summary ${hubId.slice(0, 4)}`,
    project: 'termdeck',
    source_type: 'consolidation_summary',
    created_at: '2026-08-05T04:00:00.000Z',
    privacy_tags: null,
    metadata: {
      consolidation: {
        kind: 'community_summary',
        community_key: hubId,
        member_ids: memberIds,
        member_count: memberIds.length + 4, // community is bigger than the walk
      },
    },
    ...extra,
  };
}

/**
 * Fake Supabase. `boosted:false` (the default, and today's live reality) makes
 * the boosted RPC answer like a pre-037 PostgREST: "could not find the
 * function". `.from('memory_items')` serves both the hydrate batch and the
 * community index off one row list, filtered by whatever the chain asks for.
 */
function makeClient(opts: {
  rows: GraphRecallHit[];
  items?: ItemRow[];
  boosted?: boolean;
  boostedRows?: GraphRecallHit[];
  probe?: Probe;
}): any {
  const items = opts.items ?? [];
  return {
    rpc: async (name: string, args: Record<string, unknown>) => {
      opts.probe?.rpc.push(name);
      opts.probe?.args.push(args);
      if (name === BOOSTED_GRAPH_RPC) {
        if (!opts.boosted) {
          return {
            data: null,
            error: { message: `Could not find the function public.${name}`, code: 'PGRST202' },
          };
        }
        return { data: opts.boostedRows ?? opts.rows, error: null };
      }
      if (name === LEGACY_GRAPH_RPC) return { data: opts.rows, error: null };
      return { data: null, error: { message: `unexpected rpc ${name}` } };
    },
    from: (table: string) => {
      opts.probe?.from.push(table);
      const filters: ((r: ItemRow) => boolean)[] = [];
      const chain: any = {
        select: () => chain,
        eq: (col: string, val: unknown) => {
          filters.push((r) => (r as any)[col] === val);
          return chain;
        },
        in: (col: string, vals: unknown[]) => {
          filters.push((r) => vals.includes((r as any)[col]));
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

// ─────────────────────────────────────────────────────────────────────────
// 1. Envelope + compat shim
// ─────────────────────────────────────────────────────────────────────────

test('envelope reserves tier0 FIRST and emits [] this sprint', async () => {
  __resetGraphWalkProbe();
  const out = await memoryRecallGraph(
    { query: 'anything' },
    { client: makeClient({ rows: [walkRow(M(1), 0.9)], items: [{ id: M(1) }] }), generateEmbedding: fakeEmbed }
  );

  assert.deepEqual(out.tier0, [], 'Deck A emits an EMPTY tier0 — the shape is the deliverable');
  assert.ok(Object.keys(out)[0] === 'tier0', 'tier0 is declared first in the envelope');
  assert.equal(out.hub_count, 0);
  assert.equal(out.results.length, 1);
  assert.equal(out.results[0]!.kind, 'memory');
});

test('compat shim: prefers the boosted walk, degrades to 010, and memoizes the miss', async () => {
  __resetGraphWalkProbe();
  const probe: Probe = { rpc: [], from: [], args: [] };
  const client = makeClient({ rows: [walkRow(M(1), 0.9)], items: [{ id: M(1) }], probe });

  const first = await memoryRecallGraph({ query: 'a' }, { client, generateEmbedding: fakeEmbed });
  assert.deepEqual(
    probe.rpc,
    [BOOSTED_GRAPH_RPC, LEGACY_GRAPH_RPC],
    'boosted is tried first, then 010 answers'
  );
  assert.equal(first.walk.boosted, false);
  assert.equal(first.walk.rpc, LEGACY_GRAPH_RPC, 'walk provenance names the RPC that actually answered');

  probe.rpc.length = 0;
  await memoryRecallGraph({ query: 'b' }, { client, generateEmbedding: fakeEmbed });
  assert.deepEqual(
    probe.rpc,
    [LEGACY_GRAPH_RPC],
    'the missing-function verdict is memoized per process — no repeat 404 on every recall'
  );
});

test('compat shim: boosted walk gets query_text + no hydrate round-trip', async () => {
  __resetGraphWalkProbe();
  const probe: Probe = { rpc: [], from: [], args: [] };
  const boostedRow: GraphRecallHit = {
    ...walkRow(M(1), 0.9),
    source_type: 'decision',
    metadata: {},
    privacy_tags: [],
    created_at: '2026-08-01T00:00:00.000Z',
    seed_kind: 'entity',
    edge_path: ['entity:termdeck'],
  };
  const client = makeClient({ rows: [], boosted: true, boostedRows: [boostedRow], probe });

  const out = await memoryRecallGraph(
    { query: 'vault readability', project: 'termdeck', entity_weight: 0.6 },
    { client, generateEmbedding: fakeEmbed }
  );

  assert.deepEqual(probe.rpc, [BOOSTED_GRAPH_RPC]);
  assert.equal(out.walk.boosted, true);
  const args = probe.args[0]!;
  assert.equal(args.query_text, 'vault readability', 'raw query drives 037 keyword→entity triggering');
  assert.equal(args.p_entity_weight, 0.6, 'explicit tuning args are forwarded');
  assert.ok(!('p_community_weight' in args), 'un-set tuning args are omitted so the SQL defaults stand');
  assert.equal(args.max_depth, 2);
  assert.ok(
    !probe.from.includes('memory_items'),
    "037 returns the gate columns, so the boosted path must not pay for a hydrate round-trip"
  );
});

// ─────────────────────────────────────────────────────────────────────────
// 2. Hub coarse-to-fine
// ─────────────────────────────────────────────────────────────────────────

const HUB_MEMBERS = [M(1), M(2), M(3), M(4)];

function hubFixture(memberCount: number) {
  const rows = [
    ...HUB_MEMBERS.slice(0, memberCount).map((id, i) => walkRow(id, 0.9 - i * 0.05, i === 0 ? 0 : 1)),
    walkRow(M(9), 0.5, 1),
  ];
  const items: ItemRow[] = [
    ...rows.map((r) => ({ id: r.memory_id })),
    community(HUB, HUB_MEMBERS),
  ];
  return { rows, items };
}

test('hub collapse: 3+ community members become ONE compiled summary with member citations', async () => {
  __resetGraphWalkProbe();
  const { rows, items } = hubFixture(4);
  const out = await memoryRecallGraph(
    { query: 'q' },
    { client: makeClient({ rows, items }), generateEmbedding: fakeEmbed }
  );

  assert.equal(out.hub_count, 1);
  assert.equal(out.results.length, 2, 'four members collapse to one hub; the unrelated row survives');

  const hub = out.results[0]!;
  assert.equal(hub.kind, 'hub');
  assert.equal(hub.memory_id, HUB, 'the PRIMARY unit is the consolidation_summary, not a member');
  assert.equal(hub.matched_count, 4);
  assert.equal(hub.member_count, 8, 'member_count is the community size, not the walk overlap');
  assert.equal(hub.citations!.length, 4);
  assert.deepEqual(
    hub.citations!.map((c) => c.memory_id),
    HUB_MEMBERS,
    'citations are ordered by score, best first'
  );
  assert.ok(
    hub.citations!.every((c) => c.gist.length > 0 && !c.gist.includes('\n')),
    'a citation is an id + ONE-LINE gist — never a full body'
  );
  assert.equal(
    hub.final_score,
    0.9,
    'the hub inherits its best member’s score, so collapse rewrites what is at a rank, not the rank order'
  );
  assert.equal(out.results[1]!.memory_id, M(9), 'ordering below the hub is untouched');

  // Raw walk stays available for callers that want the uncollapsed set.
  assert.equal(out.hits.length, 5);
  assert.ok(out.text.includes('1 hub'), 'the header discloses that a collapse happened');
  assert.ok(out.text.includes('4 of 8 community members collapsed'));
});

test('hub collapse: below N nothing collapses, and the text is byte-identical to pre-Sprint-70', async () => {
  __resetGraphWalkProbe();
  const { rows, items } = hubFixture(2);
  const out = await memoryRecallGraph(
    { query: 'q' },
    { client: makeClient({ rows, items }), generateEmbedding: fakeEmbed }
  );

  assert.equal(out.hub_count, 0);
  assert.equal(out.results.length, 3);
  // The exact pre-Sprint-70 render: "- (vec|dN score) [project] content",
  // header "N memories (graph-recall, dK=n, all projects):". No hub clause,
  // no tier-0 block, no trailing anything.
  assert.equal(
    out.text,
    '3 memories (graph-recall, d0=1, d1=2, all projects):\n\n' +
      '- (vec 0.900) [termdeck] body of 0001\n' +
      '- (d1 0.850) [termdeck] body of 0002\n' +
      '- (d1 0.500) [termdeck] body of 0009'
  );
});

test('hub threshold is tunable, and 0 disables collapse entirely', async () => {
  __resetGraphWalkProbe();
  const { rows, items } = hubFixture(2);
  const client = makeClient({ rows, items });

  const collapsed = await memoryRecallGraph(
    { query: 'q', hub_min_members: 2 },
    { client, generateEmbedding: fakeEmbed }
  );
  assert.equal(collapsed.hub_count, 1, 'N=2 collapses the pair the default N=3 left alone');

  const off = await memoryRecallGraph(
    { query: 'q', hub_min_members: 0 },
    { client, generateEmbedding: fakeEmbed }
  );
  assert.equal(off.hub_count, 0);
  assert.equal(off.results.length, 3);
});

test('overlapping communities: the better-matched hub claims a shared member, never both', async () => {
  __resetGraphWalkProbe();
  const rows = [
    walkRow(M(1), 0.9),
    walkRow(M(2), 0.8),
    walkRow(M(3), 0.7),
    walkRow(M(4), 0.6),
    walkRow(M(5), 0.5),
    walkRow(M(6), 0.4),
  ];
  const items: ItemRow[] = [
    ...rows.map((r) => ({ id: r.memory_id })),
    community(HUB, [M(1), M(2), M(3), M(4)]), // 4 matched
    community(HUB2, [M(4), M(5), M(6)]), // 3 matched, shares M(4)
  ];

  const out = await memoryRecallGraph(
    { query: 'q' },
    { client: makeClient({ rows, items }), generateEmbedding: fakeEmbed }
  );

  assert.equal(out.hub_count, 1, 'HUB takes M(4) as the better match; HUB2 drops to 2 members < N');
  const hub = out.results.find((u) => u.kind === 'hub')!;
  assert.equal(hub.memory_id, HUB);
  assert.equal(hub.matched_count, 4);
  const ids = out.results.map((u) => u.memory_id);
  assert.deepEqual(ids, [HUB, M(5), M(6)], 'no member is claimed twice and none is silently dropped');
});

test('a summary that surfaced in the walk on its own merit is not ALSO listed under its hub', async () => {
  __resetGraphWalkProbe();
  const rows = [walkRow(HUB, 0.95), walkRow(M(1), 0.9), walkRow(M(2), 0.8), walkRow(M(3), 0.7)];
  const items: ItemRow[] = [
    ...rows.map((r) => ({ id: r.memory_id })),
    community(HUB, [M(1), M(2), M(3)]),
  ];

  const out = await memoryRecallGraph(
    { query: 'q' },
    { client: makeClient({ rows, items }), generateEmbedding: fakeEmbed }
  );

  assert.equal(out.results.length, 1);
  assert.equal(out.results[0]!.memory_id, HUB);
  assert.equal(
    out.results[0]!.final_score,
    0.95,
    'when the summary outranks its members it keeps its own, better score'
  );
});

// ─────────────────────────────────────────────────────────────────────────
// 3. Privacy — the gate the graph surface never had
// ─────────────────────────────────────────────────────────────────────────

test('privacy: a tagged row is hidden on the graph path by default, surfaced on opt-in', async () => {
  __resetGraphWalkProbe();
  const rows = [walkRow(M(1), 0.9), walkRow(M(7), 0.8)];
  const items: ItemRow[] = [{ id: M(1), privacy_tags: [] }, { id: M(7), privacy_tags: ['medical'] }];
  const client = makeClient({ rows, items });

  const closed = await memoryRecallGraph({ query: 'q' }, { client, generateEmbedding: fakeEmbed });
  assert.deepEqual(
    closed.results.map((r) => r.memory_id),
    [M(1)],
    'default-deny holds here exactly as it does in memoryRecall'
  );

  const opened = await memoryRecallGraph(
    { query: 'q', include_privacy: ['medical'] },
    { client, generateEmbedding: fakeEmbed }
  );
  assert.deepEqual(opened.results.map((r) => r.memory_id), [M(1), M(7)]);
});

test('privacy: a hydrate failure fails CLOSED — no silently unfiltered set', async () => {
  __resetGraphWalkProbe();
  const client: any = {
    rpc: async (name: string) =>
      name === BOOSTED_GRAPH_RPC
        ? { data: null, error: { message: 'missing' } }
        : { data: [walkRow(M(1), 0.9)], error: null },
    from: () => ({
      select: () => ({ in: () => ({ then: (r: any) => r({ data: null, error: { message: 'boom' } }) }) }),
    }),
  };

  const out = await memoryRecallGraph({ query: 'q' }, { client, generateEmbedding: fakeEmbed });
  assert.deepEqual(out.results, [], 'a privacy gate we cannot evaluate is not assumed open');
  assert.ok(out.text.startsWith('Search error:'));
});

test('privacy: a summary the caller cannot see cannot stand in for its members', async () => {
  __resetGraphWalkProbe();
  const { rows } = hubFixture(4);
  const items: ItemRow[] = [
    ...rows.map((r) => ({ id: r.memory_id })),
    community(HUB, HUB_MEMBERS, { privacy_tags: ['secret'] }),
  ];

  const out = await memoryRecallGraph(
    { query: 'q' },
    { client: makeClient({ rows, items }), generateEmbedding: fakeEmbed }
  );
  assert.equal(out.hub_count, 0, 'no collapse behind a privacy-tagged summary');
  assert.equal(out.results.length, 5, 'the members stay visible as raw rows — collapse is presentation, not a gate');
});

// ─────────────────────────────────────────────────────────────────────────
// 4. §Seam 1 — the tier-0 block, wired the way B-T1 will wire it
// ─────────────────────────────────────────────────────────────────────────

test('tier0 renders FIRST, is never absorbed by a hub, and never carries a citation handle', async () => {
  __resetGraphWalkProbe();
  const { rows, items } = hubFixture(4);
  const out = await memoryRecallGraph(
    { query: 'q' },
    {
      client: makeClient({ rows, items }),
      generateEmbedding: fakeEmbed,
      // B-T1's future fetch. Deliberately returns a memory that is ALSO a
      // collapsed community member: a pinned objective outranks the hub
      // machinery, it does not get folded into it.
      fetchTier0: async () => [
        { memory_id: M(1), content: 'OBJECTIVE: ship the graph seam', project: 'termdeck' },
      ],
    }
  );

  assert.equal(out.tier0.length, 1);
  assert.ok(out.text.startsWith('1 pinned objective (tier 0):'), 'the pinned block is the first thing rendered');
  assert.ok(
    out.text.indexOf('OBJECTIVE: ship the graph seam') < out.text.indexOf('memories (graph-recall'),
    'tier0 sits ABOVE the result header — never interleaved'
  );
  assert.ok(!out.text.includes('[1] OBJECTIVE'), 'tier0 carries no [n] handle: it is injected, not logged');
  assert.equal(out.hub_count, 1, 'the hub still forms — tier0 does not perturb ranking');
  assert.ok(
    !out.results.some((u) => u.kind === 'hub' && u.citations?.some((c) => c.gist.includes('OBJECTIVE'))),
    'a tier0 item is never absorbed into a hub'
  );
});

test('a tier0 fetch that throws degrades to ordinary recall instead of taking recall down', async () => {
  __resetGraphWalkProbe();
  const out = await memoryRecallGraph(
    { query: 'q' },
    {
      client: makeClient({ rows: [walkRow(M(1), 0.9)], items: [{ id: M(1) }] }),
      generateEmbedding: fakeEmbed,
      fetchTier0: async () => {
        throw new Error('objective tier is down');
      },
    }
  );
  assert.deepEqual(out.tier0, []);
  assert.equal(out.results.length, 1);
});

test('the A-T3 staleness hook re-ranks units after collapse and is never handed tier0', async () => {
  __resetGraphWalkProbe();
  const { rows, items } = hubFixture(4);
  let seen: string[] = [];
  const out = await memoryRecallGraph(
    { query: 'q' },
    {
      client: makeClient({ rows, items }),
      generateEmbedding: fakeEmbed,
      fetchTier0: async () => [{ memory_id: M(1), content: 'pinned', project: 'termdeck' }],
      applyStaleness: (units) => {
        seen = units.map((u) => u.memory_id);
        return [...units].reverse();
      },
    }
  );

  assert.deepEqual(seen, [HUB, M(9)], 'the hook sees COLLAPSED units — one hub, not four members');
  assert.ok(!seen.includes('pinned'), 'tier0 is never passed through staleness');
  assert.deepEqual(out.results.map((u) => u.memory_id), [M(9), HUB], 'the hook’s ordering is honoured');
});

// ─────────────────────────────────────────────────────────────────────────
// 5. Cross-deck integration — B-T1's fetcher wired behind MNESTRA_TIER0_INJECT
// ─────────────────────────────────────────────────────────────────────────

const TIER0_FLAG = 'MNESTRA_TIER0_INJECT';

function withTier0Flag<T>(value: string | undefined, fn: () => Promise<T>): Promise<T> {
  const prev = process.env[TIER0_FLAG];
  if (value === undefined) delete process.env[TIER0_FLAG];
  else process.env[TIER0_FLAG] = value;
  return fn().finally(() => {
    if (prev === undefined) delete process.env[TIER0_FLAG];
    else process.env[TIER0_FLAG] = prev;
  });
}

/** A client that also answers B-T1's objective_list RPC. */
function clientWithObjectives(opts: { rows: GraphRecallHit[]; items: ItemRow[]; probe: Probe; fail?: boolean }): any {
  const base = makeClient(opts);
  const rpc = base.rpc;
  base.rpc = async (name: string, args: Record<string, unknown>) => {
    if (name === 'objective_list') {
      opts.probe.rpc.push(name);
      if (opts.fail) return { data: null, error: { message: 'migration 038 not applied' } };
      return {
        data: [
          {
            id: '33333333-3333-4333-8333-333333333333',
            project: args.p_project,
            rank: 1,
            content: 'OBJECTIVE: never break the OFF path',
            status: 'active',
            supersedes: null,
            ratified_by: 'josh',
            ratified_at: '2026-08-05T00:00:00.000Z',
            created_at: '2026-08-05T00:00:00.000Z',
            metadata: {},
          },
        ],
        error: null,
      };
    }
    return rpc(name, args);
  };
  return base;
}

test('tier0 inject is DARK by default: B-T1s fetcher is never called with the flag unset', async () => {
  __resetGraphWalkProbe();
  const probe: Probe = { rpc: [], from: [], args: [] };
  const out = await withTier0Flag(undefined, () =>
    memoryRecallGraph(
      { query: 'q', project: 'termdeck' },
      { client: clientWithObjectives({ rows: [walkRow(M(1), 0.9)], items: [{ id: M(1) }], probe }), generateEmbedding: fakeEmbed }
    )
  );
  assert.deepEqual(out.tier0, []);
  assert.ok(!probe.rpc.includes('objective_list'), 'OFF costs zero — not even a round-trip');
});

test('tier0 inject ON: objectives arrive through B-T1s adapter and render first', async () => {
  __resetGraphWalkProbe();
  const probe: Probe = { rpc: [], from: [], args: [] };
  const out = await withTier0Flag('1', () =>
    memoryRecallGraph(
      { query: 'q', project: 'termdeck' },
      { client: clientWithObjectives({ rows: [walkRow(M(1), 0.9)], items: [{ id: M(1) }], probe }), generateEmbedding: fakeEmbed }
    )
  );

  assert.ok(probe.rpc.includes('objective_list'));
  assert.equal(out.tier0.length, 1);
  assert.equal(out.tier0[0]!.source_type, 'objective', "B-T1's synthesized sentinel survives the seam");
  assert.equal((out.tier0[0]!.metadata as any).tier, 0);
  assert.ok(out.text.startsWith('1 pinned objective (tier 0):'));
  assert.ok(out.text.includes('OBJECTIVE: never break the OFF path'));
  assert.equal(out.results.length, 1, 'and the retrieved results are untouched by the injection');
});

test('an explicitly injected fetchTier0 always beats the env default', async () => {
  __resetGraphWalkProbe();
  const probe: Probe = { rpc: [], from: [], args: [] };
  const out = await withTier0Flag('on', () =>
    memoryRecallGraph(
      { query: 'q', project: 'termdeck' },
      {
        client: clientWithObjectives({ rows: [walkRow(M(1), 0.9)], items: [{ id: M(1) }], probe }),
        generateEmbedding: fakeEmbed,
        fetchTier0: async () => [{ memory_id: M(8), content: 'caller-supplied objective' }],
      }
    )
  );
  assert.equal(out.tier0[0]!.memory_id, M(8));
  assert.ok(!probe.rpc.includes('objective_list'), 'the default fetcher is not consulted when one was injected');
});

test('tier0 inject ON against a store without 038: recall survives, tier0 degrades to []', async () => {
  __resetGraphWalkProbe();
  const probe: Probe = { rpc: [], from: [], args: [] };
  const out = await withTier0Flag('true', () =>
    memoryRecallGraph(
      { query: 'q', project: 'termdeck' },
      {
        client: clientWithObjectives({ rows: [walkRow(M(1), 0.9)], items: [{ id: M(1) }], probe, fail: true }),
        generateEmbedding: fakeEmbed,
      }
    )
  );
  assert.deepEqual(out.tier0, [], 'an objective-tier outage is not a recall outage');
  assert.equal(out.results.length, 1);
});

test('a throwing staleness hook is ignored — ranking may fail, results may not', async () => {
  __resetGraphWalkProbe();
  const out = await memoryRecallGraph(
    { query: 'q' },
    {
      client: makeClient({ rows: [walkRow(M(1), 0.9)], items: [{ id: M(1) }] }),
      generateEmbedding: fakeEmbed,
      applyStaleness: () => {
        throw new Error('nope');
      },
    }
  );
  assert.equal(out.results.length, 1);
});

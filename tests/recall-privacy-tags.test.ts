/**
 * Mnestra — privacy_tags `include_privacy` recall filter (Deck B, privacy_tags PR)
 *
 * Brad's pka (Personal Knowledge Archive) project mirrors a ~20-year corpus
 * into memory_items with project='archive'. Sensitive items get open-ended
 * categorical tags in the new `privacy_tags text[]` column (migration 023).
 * The recall layer (src/recall.ts) EXCLUDES any tagged row by default and
 * re-admits only the tags a caller explicitly opts into via
 * `include_privacy: string[]`.
 *
 * Architectural contract these tests pin — and where it DIVERGES from the
 * source_agent filter in recall-source-agent.test.ts:
 *
 *   1. Open-Q#1 = YES: migration 023 extends memory_hybrid_search's RETURNS
 *      TABLE with privacy_tags, so the filter reads `(row.privacy_tags ?? [])`
 *      straight off each RPC row. There is NO follow-up
 *      `.from('memory_items').select(...)` batch query — that N+1 is exactly
 *      what extending RETURNS TABLE exists to avoid. The fake RPC below
 *      therefore returns privacy_tags ON each row — the inverse of the
 *      source_agent fake, which strips its column to FORCE the batch lookup.
 *   2. Default behaviour is UNCONDITIONAL default-deny: the filter runs even
 *      when include_privacy is omitted (unlike source_agents, which only
 *      filters when set). Untagged rows (empty array) always pass; any tagged
 *      row is dropped unless opted in.
 *   3. Opt-in is ANY-OVERLAP: a row surfaces iff at least one of its tags is
 *      in include_privacy. `include_privacy: []` is treated as omitted
 *      (defensive, mirrors the source_agents empty-array contract).
 *
 *   default (no filter)         → only untagged rows.
 *   include_privacy:['secret']  → untagged + rows carrying 'secret'.
 *   include_privacy:['medical'] → untagged + rows carrying 'medical', incl.
 *                                 the multi-tag row → proves any-overlap.
 *   include_privacy:[]          → same as default (untagged only).
 *   untagged-only corpus        → unchanged by the PR (non-breaking guarantee).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { memoryRecall } from '../src/recall.js';

interface FakeRow {
  id: string;
  content: string;
  source_type: string;
  category: string | null;
  project: string;
  metadata: Record<string, unknown>;
  score: number;
  created_at: string;
  // migration 023's extended RETURNS TABLE column — present on every RPC row.
  privacy_tags: string[];
}

const NOW = new Date().toISOString();

// A single distinct word per row keeps dedupByContent (its 0.7 word-overlap
// heuristic) from collapsing any fixture rows, so each test asserts on the
// full, predictable id set.
function row(id: string, privacy_tags: string[], content: string): FakeRow {
  return {
    id,
    content,
    source_type: 'fact',
    category: null,
    project: 'archive',
    metadata: {},
    score: 0.5,
    created_at: NOW,
    privacy_tags,
  };
}

interface ProbeRecorder {
  rpcCalls: number;
  fromCalls: number;
}

/**
 * Fake Supabase client. `rpc('memory_hybrid_search', …)` returns rows WITH
 * privacy_tags (migration 023's extended RETURNS TABLE). `from('memory_items')`
 * must NOT be reached by a privacy-only recall — privacy_tags come off the RPC
 * row, not a batch lookup — but it is wired defensively so an unexpected call
 * is recorded (and asserted `== 0`) rather than throwing.
 */
function makeFakeClient(rows: FakeRow[], probe?: ProbeRecorder): any {
  return {
    rpc: async (name: string, _args: unknown) => {
      assert.equal(name, 'memory_hybrid_search');
      if (probe) probe.rpcCalls++;
      // Unlike the source_agent fake, privacy_tags are NOT stripped — the
      // real RPC now returns them (Open-Q#1 = YES).
      return { data: rows.map((r) => ({ ...r })), error: null };
    },
    from: (table: string) => {
      assert.equal(table, 'memory_items');
      if (probe) probe.fromCalls++;
      const ctx: { ids: string[] | null } = { ids: null };
      const chain: any = {
        select: () => chain,
        in: (_col: string, ids: string[]) => {
          ctx.ids = ids;
          return chain;
        },
        then: (resolve: (v: unknown) => void) => {
          const data = (ctx.ids ?? []).map((id) => {
            const fr = rows.find((r) => r.id === id);
            return { id, privacy_tags: fr ? fr.privacy_tags : [] };
          });
          resolve({ data, error: null });
        },
      };
      return chain;
    },
  };
}

const fakeEmbed = async (_text: string) => new Array(1536).fill(0);

const U1 = '00000000-0000-0000-0000-000000000001';
const U2 = '00000000-0000-0000-0000-000000000002';
const SECRET = '00000000-0000-0000-0000-000000000003';
const MEDICAL = '00000000-0000-0000-0000-000000000004';
const SECRET_MEDICAL = '00000000-0000-0000-0000-000000000005';

const fixture: FakeRow[] = [
  row(U1, [], 'alpha'),
  row(U2, [], 'bravo'),
  row(SECRET, ['secret'], 'charlie'),
  row(MEDICAL, ['medical'], 'delta'),
  row(SECRET_MEDICAL, ['secret', 'medical'], 'echo'),
];

test('default (no include_privacy) excludes every tagged row, keeps untagged', async () => {
  const probe: ProbeRecorder = { rpcCalls: 0, fromCalls: 0 };
  const client = makeFakeClient(fixture, probe);

  const out = await memoryRecall(
    { query: 'find anything' },
    { client, generateEmbedding: fakeEmbed }
  );

  const ids = out.hits.map((h) => h.id).sort();
  assert.deepEqual(ids, [U1, U2], 'only the two untagged rows survive a default recall');
  assert.equal(
    probe.fromCalls,
    0,
    'privacy filter reads privacy_tags off the RPC row — no .from() batch lookup (Open-Q#1 = YES, N+1 avoided)'
  );
});

test("include_privacy:['secret'] surfaces secret + untagged, drops medical-only", async () => {
  const client = makeFakeClient(fixture);

  const out = await memoryRecall(
    { query: 'find', include_privacy: ['secret'] },
    { client, generateEmbedding: fakeEmbed }
  );

  const ids = out.hits.map((h) => h.id).sort();
  assert.deepEqual(
    ids,
    [U1, U2, SECRET, SECRET_MEDICAL],
    "untagged always pass; 'secret' and the multi-tag secret+medical row opt in; medical-only stays hidden"
  );
  assert.ok(
    !ids.includes(MEDICAL),
    'a row tagged only medical must not leak under a secret opt-in'
  );
});

test("include_privacy:['medical'] proves ANY-OVERLAP (multi-tag row surfaces under either tag)", async () => {
  const client = makeFakeClient(fixture);

  const out = await memoryRecall(
    { query: 'find', include_privacy: ['medical'] },
    { client, generateEmbedding: fakeEmbed }
  );

  const ids = out.hits.map((h) => h.id).sort();
  assert.deepEqual(ids, [U1, U2, MEDICAL, SECRET_MEDICAL]);
  assert.ok(
    ids.includes(SECRET_MEDICAL),
    'secret+medical row surfaces under medical too → any-overlap match, not all-of / fully-covered'
  );
  assert.ok(
    !ids.includes(SECRET),
    'secret-only row stays hidden under a medical-only opt-in'
  );
});

test('include_privacy:[] is treated as omitted (defensive) → untagged only', async () => {
  const client = makeFakeClient(fixture);

  const out = await memoryRecall(
    { query: 'find', include_privacy: [] },
    { client, generateEmbedding: fakeEmbed }
  );

  const ids = out.hits.map((h) => h.id).sort();
  assert.deepEqual(
    ids,
    [U1, U2],
    'empty array must not opt anything in — mirrors the source_agents:[] contract'
  );
});

test('untagged-only corpus is unchanged by the PR (non-breaking guarantee)', async () => {
  const untaggedOnly: FakeRow[] = [row(U1, [], 'alpha'), row(U2, [], 'bravo')];

  // (a) No filter: both rows pass, zero batch lookups, no behaviour change.
  const probe: ProbeRecorder = { rpcCalls: 0, fromCalls: 0 };
  const outDefault = await memoryRecall(
    { query: 'find' },
    { client: makeFakeClient(untaggedOnly, probe), generateEmbedding: fakeEmbed }
  );
  assert.equal(outDefault.hits.length, 2);
  assert.equal(
    probe.fromCalls,
    0,
    'no privacy tags anywhere → no extra query, byte-for-byte the pre-PR path'
  );

  // (b) An opt-in against a corpus with no tagged rows is a no-op.
  const outOptIn = await memoryRecall(
    { query: 'find', include_privacy: ['secret'] },
    { client: makeFakeClient(untaggedOnly), generateEmbedding: fakeEmbed }
  );
  assert.equal(
    outOptIn.hits.length,
    2,
    'opt-in cannot conjure rows that do not exist; an untagged corpus is invariant'
  );
});

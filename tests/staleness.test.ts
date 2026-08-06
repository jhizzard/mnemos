/**
 * Mnestra — structural staleness tests (Sprint 70 A-T3).
 *
 * The load-bearing assertions here are the ones that would catch a silent
 * regression rather than a typo:
 *
 *   · the anchor invariant holds even when the stale row's raw score is much
 *     HIGHER than its successor's (the Jul-31 shape — a penalty multiplier
 *     alone does not guarantee this; the repair pass does),
 *   · output is always a permutation — staleness downranks, never drops,
 *   · inputs are never mutated,
 *   · community co-membership does NOT cluster (the near-miss that would have
 *     wrecked the sprint's own context chains),
 *   · tier-0 rows are untouchable at every entry point,
 *   · the module cannot apply a supersession, enforced against its source text.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import type { RecallDeps } from '../src/recall.js';
import type { GraphRecallUnit } from '../src/recall_graph.js';
import {
  downrankStaleSiblings,
  makeStalenessHook,
  assertAnchorInvariant,
  proposeSupersessions,
  tokenSetSimilarity,
  normalizeTokens,
  idOf,
  defaultIsTier0,
  scoreOf,
  DEFAULT_STALENESS_OPTIONS,
  SUPERSEDES_PROPOSAL_DETECTOR,
  type StaleableHit,
} from '../src/staleness.js';

// ── Fixtures ─────────────────────────────────────────────────────────────

const D = (iso: string) => `${iso}T00:00:00.000Z`;

/**
 * The Jul-31 shape: the SAME fact restated on three days as its status moved,
 * one word apart (token-set Jaccard ≈ 0.90). Note the score ordering is
 * inverted against recency — the stalest row scores highest — which is exactly
 * why the incident happened and why a recency tiebreak inside the ranker
 * would not have saved it.
 */
const STATUS_OLD: StaleableHit = {
  id: 'old',
  created_at: D('2026-07-20'),
  score: 0.070,
  project: 'termdeck',
  content:
    'Sprint 62 acceptance status PENDING for cross-agent panel capture on real exit across four panels in the daily driver store',
};
const STATUS_MID: StaleableHit = {
  id: 'mid',
  created_at: D('2026-07-25'),
  score: 0.040,
  project: 'termdeck',
  content:
    'Sprint 62 acceptance status PARTIAL for cross-agent panel capture on real exit across four panels in the daily driver store',
};
const STATUS_NEW: StaleableHit = {
  id: 'new',
  created_at: D('2026-07-31'),
  score: 0.020,
  project: 'termdeck',
  content:
    'Sprint 62 acceptance status CLOSED for cross-agent panel capture on real exit across four panels in the daily driver store',
};
const UNRELATED: StaleableHit = {
  id: 'unrelated',
  created_at: D('2026-07-28'),
  score: 0.055,
  project: 'termdeck',
  content: 'Postgres HNSW index build requires maintenance_work_mem raised before the vector column is populated',
};

const ids = (hits: readonly StaleableHit[]) => hits.map((h) => h.id);
const posOf = (hits: readonly StaleableHit[], id: string) => hits.findIndex((h) => h.id === id);

// ── The headline behavior ────────────────────────────────────────────────

test('Jul-31 shape: newest anchor outranks older siblings despite a much higher raw score', () => {
  const { ordered, clusters } = downrankStaleSiblings([STATUS_OLD, STATUS_MID, STATUS_NEW]);

  assert.equal(clusters.length, 1, 'the three status rows are one cluster');
  assert.equal(clusters[0]!.anchor_id, 'new');
  assert.deepEqual(clusters[0]!.member_ids, ['new', 'mid', 'old'], 'members newest-first');

  assert.ok(posOf(ordered, 'new') < posOf(ordered, 'mid'));
  assert.ok(posOf(ordered, 'new') < posOf(ordered, 'old'));
  assert.ok(assertAnchorInvariant(ordered).ok);
});

test('the invariant is a guarantee, not a tendency: it holds at penalty = 1 (no score help at all)', () => {
  // penalty 1 means the multiplier does nothing, so ONLY the repair pass can
  // satisfy the post-condition. If the repair is ever deleted, this fails.
  const { ordered, repositioned_ids } = downrankStaleSiblings(
    [STATUS_OLD, STATUS_MID, STATUS_NEW],
    { penalty: 1 }
  );
  assert.ok(assertAnchorInvariant(ordered).ok, 'anchor invariant must hold with no penalty');
  assert.ok(repositioned_ids.length > 0, 'repair pass must have done the work');
  assert.ok(posOf(ordered, 'new') < posOf(ordered, 'old'));
});

test('stale siblings are downranked, never dropped — output is a permutation', () => {
  const input = [STATUS_OLD, STATUS_MID, STATUS_NEW, UNRELATED];
  const { ordered } = downrankStaleSiblings(input);
  assert.equal(ordered.length, input.length);
  assert.deepEqual([...ids(ordered)].sort(), [...ids(input)].sort());
});

test('unrelated hits keep their own ranking and are never annotated', () => {
  const { ordered } = downrankStaleSiblings([STATUS_OLD, STATUS_MID, STATUS_NEW, UNRELATED]);
  const unrelated = ordered.find((h) => h.id === 'unrelated')!;
  assert.equal(unrelated.staleness, undefined);
  // 0.055 beats every penalized status row, so it should lead.
  assert.equal(ordered[0]!.id, 'unrelated');
});

test('inputs are never mutated (pure): no annotation leaks onto the caller objects', () => {
  const input = [{ ...STATUS_OLD }, { ...STATUS_NEW }];
  const snapshot = JSON.parse(JSON.stringify(input));
  downrankStaleSiblings(input);
  assert.deepEqual(JSON.parse(JSON.stringify(input)), snapshot);
  assert.ok(input.every((h) => !('staleness' in h)));
});

test('annotation carries an auditable trail: role, age_rank, basis, both scores', () => {
  const { ordered } = downrankStaleSiblings([STATUS_OLD, STATUS_MID, STATUS_NEW]);
  const anchor = ordered.find((h) => h.id === 'new')!.staleness!;
  const oldest = ordered.find((h) => h.id === 'old')!.staleness!;

  assert.equal(anchor.role, 'anchor');
  assert.equal(anchor.age_rank, 0);
  assert.equal(anchor.adjusted_score, anchor.original_score, 'anchor is never penalized');

  assert.equal(oldest.role, 'stale_sibling');
  assert.equal(oldest.age_rank, 2);
  assert.equal(oldest.basis, 'near_dup');
  assert.equal(oldest.anchor_id, 'new');
  assert.ok(oldest.adjusted_score < oldest.original_score);
  assert.equal(oldest.original_score, STATUS_OLD.score);
});

test('penalty floor bounds a long chain rather than collapsing it to zero', () => {
  const chain: StaleableHit[] = Array.from({ length: 8 }, (_, i) => ({
    id: `c${i}`,
    created_at: D(`2026-07-${String(10 + i).padStart(2, '0')}`),
    score: 0.05,
    project: 'p',
    content: `the deploy pipeline promotes the release candidate to production after the smoke suite passes ${i === 0 ? '' : 'again'}`,
  }));
  const { ordered, clusters } = downrankStaleSiblings(chain, { penaltyFloor: 0.05 });
  assert.equal(clusters.length, 1);
  for (const h of ordered) {
    if (h.staleness) assert.ok(h.staleness.adjusted_score >= 0.05 * 0.05);
  }
  assert.ok(assertAnchorInvariant(ordered).ok);
});

// ── The near-miss: communities must NOT cluster ──────────────────────────

test('community co-membership does NOT make siblings (topic-mates are not duplicates)', () => {
  // Eight members of one consolidation community, all about the same subject,
  // none near-duplicates of each other. Downranking seven of them would gut
  // exactly the context chain this sprint is building.
  const community = [
    'the HNSW index is built with m=16 and ef_construction=64 on the embedding column',
    'recall latency p95 sits near 240ms once the partial index is served from cache',
    'the RRF fusion constant k is 60 which caps the base score at two over sixty one',
    'privacy tags are filtered at the recall layer rather than inside the search RPC',
  ].map((content, i) => ({
    id: `com${i}`,
    created_at: D(`2026-07-${String(10 + i).padStart(2, '0')}`),
    score: 0.03,
    project: 'mnestra',
    content,
    metadata: { consolidation: { community_key: 'same-community-uuid', kind: 'community_summary' } },
  }));

  const { clusters, ordered } = downrankStaleSiblings(community);
  assert.equal(clusters.length, 0, 'a shared community_key must not form a staleness cluster');
  assert.deepEqual(ids(ordered), ids(community), 'order untouched');
  assert.ok(ordered.every((h) => h.staleness === undefined));
});

test('clusterKeyOf hook groups when the caller supplies an authoritative near-dup id', () => {
  const rows = [
    { id: 'a', created_at: D('2026-07-01'), score: 0.09, project: 'p', content: 'alpha text one' },
    { id: 'b', created_at: D('2026-07-09'), score: 0.01, project: 'p', content: 'beta text two' },
  ];
  const { clusters, ordered } = downrankStaleSiblings(rows, { clusterKeyOf: () => 'dup-1' });
  assert.equal(clusters.length, 1);
  assert.equal(clusters[0]!.basis, 'cluster_hint');
  assert.equal(clusters[0]!.anchor_id, 'b');
  assert.ok(posOf(ordered, 'b') < posOf(ordered, 'a'));
});

test('cross-project rows never cluster, however similar the text', () => {
  const a = { ...STATUS_OLD, id: 'x', project: 'termdeck' };
  const b = { ...STATUS_OLD, id: 'y', project: 'rumen', created_at: D('2026-07-30') };
  assert.equal(downrankStaleSiblings([a, b]).clusters.length, 0);
});

// ── Explicit supersession chains ─────────────────────────────────────────

test('explicit superseded_by groups a chain and labels it supersedes', () => {
  const rows: StaleableHit[] = [
    { id: 'p', created_at: D('2026-07-01'), score: 0.09, project: 'p', superseded_by: 's' },
    { id: 's', created_at: D('2026-07-08'), score: 0.01, project: 'p' },
  ];
  const { clusters, ordered } = downrankStaleSiblings(rows);
  assert.equal(clusters.length, 1);
  assert.equal(clusters[0]!.basis, 'supersedes');
  assert.equal(clusters[0]!.anchor_id, 's');
  assert.ok(posOf(ordered, 's') < posOf(ordered, 'p'));
});

test('a mixed cluster keeps the strongest basis label (supersedes beats near_dup)', () => {
  const rows: StaleableHit[] = [
    { ...STATUS_OLD, superseded_by: 'new' },
    STATUS_MID,
    STATUS_NEW,
  ];
  const { clusters } = downrankStaleSiblings(rows);
  assert.equal(clusters.length, 1);
  assert.equal(clusters[0]!.basis, 'supersedes', 'label must survive union re-rooting');
});

test('metadata-carried supersedes / consolidated_from links also group', () => {
  const rows: StaleableHit[] = [
    { id: 'canon', created_at: D('2026-07-10'), score: 0.02, project: 'p', metadata: { consolidated_from: ['m1'] } },
    { id: 'm1', created_at: D('2026-07-01'), score: 0.08, project: 'p' },
  ];
  const { clusters, ordered } = downrankStaleSiblings(rows);
  assert.equal(clusters.length, 1);
  assert.equal(clusters[0]!.anchor_id, 'canon');
  assert.ok(assertAnchorInvariant(ordered).ok);
});

// ── Tier-0 exemption (seam §1 / §3) ──────────────────────────────────────

test('tier-0 rows are never downranked, never absorbed, never annotated', () => {
  const objective: StaleableHit = {
    ...STATUS_OLD,
    id: 'obj',
    metadata: { tier: 0 },
    score: 0.001,
  };
  const { ordered, clusters } = downrankStaleSiblings([objective, STATUS_MID, STATUS_NEW]);
  const obj = ordered.find((h) => h.id === 'obj')!;
  assert.equal(obj.staleness, undefined, 'tier-0 must not be annotated');
  assert.ok(clusters.every((c) => !c.member_ids.includes('obj')));
});

test('a tier-0 row cannot be an anchor either — it is removed before grouping', () => {
  const newest: StaleableHit = { ...STATUS_NEW, id: 'obj-new', metadata: { objective: true } };
  const { clusters } = downrankStaleSiblings([STATUS_OLD, STATUS_MID, newest]);
  // OLD + MID still cluster with each other; the objective is simply absent.
  assert.ok(clusters.every((c) => !c.member_ids.includes('obj-new')));
});

test('defaultIsTier0 recognizes the provisional marker shapes, and nothing else', () => {
  assert.ok(defaultIsTier0({ id: '1', metadata: { tier: 0 } }));
  assert.ok(defaultIsTier0({ id: '2', metadata: { tier: '0' } }));
  assert.ok(defaultIsTier0({ id: '3', metadata: { objective: true } }));
  assert.ok(defaultIsTier0({ id: '4', metadata: { tier0: true } }));
  assert.ok(defaultIsTier0({ id: '5', metadata: { kind: 'objective' } }));
  assert.ok(defaultIsTier0({ id: '6', source_type: 'objective' }));
  assert.ok(!defaultIsTier0({ id: '7', metadata: { tier: 1 } }));
  assert.ok(!defaultIsTier0({ id: '8', metadata: {} }));
  assert.ok(!defaultIsTier0({ id: '9' }));
});

test('a custom isTier0 fully replaces the provisional default (B-T1 swap point)', () => {
  const isTier0 = (h: StaleableHit) => h.metadata?.pinned === true;
  const pinned: StaleableHit = { ...STATUS_OLD, id: 'pin', metadata: { pinned: true } };
  const { clusters } = downrankStaleSiblings([pinned, STATUS_MID, STATUS_NEW], { isTier0 });
  assert.ok(clusters.every((c) => !c.member_ids.includes('pin')));
  // And the default marker no longer exempts anything.
  const tierRow: StaleableHit = { ...STATUS_OLD, id: 'tier', metadata: { tier: 0 } };
  const { clusters: c2 } = downrankStaleSiblings([tierRow, STATUS_MID, STATUS_NEW], { isTier0 });
  assert.ok(c2.some((c) => c.member_ids.includes('tier')));
});

// ── Degenerate input, determinism, and the OFF path ──────────────────────

test('enabled:false is a pass-through; so are 0- and 1-hit pages', () => {
  const input = [STATUS_OLD, STATUS_MID, STATUS_NEW];
  const off = downrankStaleSiblings(input, { enabled: false });
  assert.deepEqual(ids(off.ordered), ids(input));
  assert.equal(off.clusters.length, 0);
  assert.deepEqual(downrankStaleSiblings([]).ordered, []);
  assert.deepEqual(ids(downrankStaleSiblings([STATUS_NEW]).ordered), ['new']);
});

test('no clusters found → order is byte-identical to input (default-OFF parity shape)', () => {
  const input = [UNRELATED, { ...STATUS_NEW, id: 'solo' }];
  assert.deepEqual(ids(downrankStaleSiblings(input).ordered), ids(input));
});

test('deterministic: same page twice → identical order and identical clusters', () => {
  const input = [STATUS_MID, UNRELATED, STATUS_NEW, STATUS_OLD];
  const a = downrankStaleSiblings(input);
  const b = downrankStaleSiblings(input);
  assert.deepEqual(ids(a.ordered), ids(b.ordered));
  assert.deepEqual(a.clusters, b.clusters);
});

test('missing/invalid timestamps sort oldest and never become the anchor', () => {
  const rows: StaleableHit[] = [
    { id: 'nodate', score: 0.09, project: 'p', content: STATUS_OLD.content },
    { id: 'baddate', created_at: 'not-a-date', score: 0.08, project: 'p', content: STATUS_MID.content },
    { id: 'dated', created_at: D('2026-07-31'), score: 0.01, project: 'p', content: STATUS_NEW.content },
  ];
  const { clusters, ordered } = downrankStaleSiblings(rows);
  assert.equal(clusters[0]!.anchor_id, 'dated');
  assert.ok(assertAnchorInvariant(ordered).ok);
});

test('short or empty contents never near-dup match (min-token guard)', () => {
  const rows: StaleableHit[] = [
    { id: 'a', created_at: D('2026-07-01'), score: 0.05, project: 'p', content: 'ok done' },
    { id: 'b', created_at: D('2026-07-02'), score: 0.05, project: 'p', content: 'ok done' },
    { id: 'c', created_at: D('2026-07-03'), score: 0.05, project: 'p', content: '' },
  ];
  assert.equal(downrankStaleSiblings(rows).clusters.length, 0);
});

test('scoreOf reads either surface, and prefers score when both are present', () => {
  assert.equal(scoreOf({ id: 'a', score: 0.5 }), 0.5);
  assert.equal(scoreOf({ id: 'b', final_score: 0.25 }), 0.25);
  assert.equal(scoreOf({ id: 'c', score: 0.5, final_score: 0.25 }), 0.5);
  assert.equal(scoreOf({ id: 'd' }), 0);
  assert.equal(scoreOf({ id: 'e', score: Number.NaN, final_score: 0.3 }), 0.3);
});

test('graph units (final_score, nullable created_at) work with no adapter', () => {
  const units = [
    { id: 'u-old', created_at: D('2026-07-01'), final_score: 0.9, project: 'p', content: STATUS_OLD.content, kind: 'memory' as const },
    { id: 'u-new', created_at: D('2026-07-31'), final_score: 0.1, project: 'p', content: STATUS_NEW.content, kind: 'memory' as const },
  ];
  const hook = makeStalenessHook<(typeof units)[number]>();
  const out = hook(units);
  assert.equal(out[0]!.id, 'u-new', 'newest anchor leads despite a 9x lower final_score');
  assert.equal(out.length, 2);
  // The rendered number must be untouched — we reorder, we do not rewrite.
  assert.equal(out.find((u) => u.id === 'u-old')!.final_score, 0.9);
});

test('makeStalenessHook matches downrankStaleSiblings ordering exactly', () => {
  const input = [STATUS_OLD, UNRELATED, STATUS_MID, STATUS_NEW];
  assert.deepEqual(ids(makeStalenessHook()(input)), ids(downrankStaleSiblings(input).ordered));
});

// ── Similarity primitives ────────────────────────────────────────────────

test('tokenSetSimilarity: identical = 1, disjoint = 0, empty-safe', () => {
  assert.equal(tokenSetSimilarity('alpha beta', 'alpha beta'), 1);
  assert.equal(tokenSetSimilarity('alpha beta', 'gamma delta'), 0);
  assert.equal(tokenSetSimilarity('', 'alpha'), 0);
  assert.equal(tokenSetSimilarity('Alpha, BETA!', 'alpha beta'), 1, 'case/punctuation normalized');
});

test('near-dup threshold is conservative: paraphrases below it stay unclustered', () => {
  const sim = tokenSetSimilarity(
    'the deployment failed because the database migration timed out',
    'the release was rolled back after a schema change exceeded its lock timeout'
  );
  assert.ok(sim < DEFAULT_STALENESS_OPTIONS.nearDupThreshold, `sim=${sim}`);
});

test('normalizeTokens dedupes and drops separators', () => {
  assert.deepEqual([...normalizeTokens('a-b  a_b, A B')].sort(), ['a', 'b']);
});

// ── Supersession PROPOSALS — never applied ───────────────────────────────

test('proposals: one per older sibling, aimed at the anchor (a star, not a chain)', () => {
  const proposals = proposeSupersessions([STATUS_OLD, STATUS_MID, STATUS_NEW]);
  assert.equal(proposals.length, 2);
  for (const p of proposals) {
    assert.equal(p.successor_id, 'new');
    assert.equal(p.source_id, 'new', 'source supersedes target');
    assert.equal(p.relationship_type, 'supersedes');
    assert.equal(p.status, 'proposed');
    assert.equal(p.evidence.detector, SUPERSEDES_PROPOSAL_DETECTOR);
    assert.ok(p.similarity !== null && p.similarity > 0);
  }
  assert.deepEqual(proposals.map((p) => p.predecessor_id).sort(), ['mid', 'old']);
});

test('proposals: evidence carries both timestamps, cluster size and age rank', () => {
  const [first] = proposeSupersessions([STATUS_OLD, STATUS_MID, STATUS_NEW]);
  assert.equal(first!.evidence.cluster_size, 3);
  assert.equal(first!.evidence.successor_created_at, STATUS_NEW.created_at);
  assert.ok(first!.evidence.age_rank >= 1);
  assert.equal(first!.evidence.project, 'termdeck');
});

test('proposals: no proposal ever names a tier-0 row, at either end', () => {
  // Exempting the NEWEST row does not dissolve the cluster: the two remaining
  // non-exempt rows are still near-duplicates of each other, and the newer of
  // THEM becomes the anchor. The contract is "a tier-0 row is never named in a
  // proposal", not "a tier-0 row suppresses its neighbours' proposals".
  const objAnchor = { ...STATUS_NEW, metadata: { tier: 0 } };
  const withObjAnchor = proposeSupersessions([STATUS_OLD, STATUS_MID, objAnchor]);
  assert.equal(withObjAnchor.length, 1);
  assert.equal(withObjAnchor[0]!.successor_id, 'mid');
  assert.equal(withObjAnchor[0]!.predecessor_id, 'old');
  assert.ok(withObjAnchor.every((p) => p.source_id !== 'new' && p.target_id !== 'new'));

  const objMember = { ...STATUS_OLD, metadata: { objective: true } };
  const withObjMember = proposeSupersessions([objMember, STATUS_MID, STATUS_NEW]);
  assert.ok(withObjMember.every((p) => p.predecessor_id !== 'old' && p.successor_id !== 'old'));
  assert.deepEqual(withObjMember.map((p) => p.predecessor_id), ['mid']);
});

test('proposals: nothing proposed for an already-applied supersession', () => {
  const applied = { ...STATUS_OLD, superseded_by: 'new' };
  const ps = proposeSupersessions([applied, STATUS_NEW]);
  assert.equal(ps.length, 0, 'explicit-link clusters have nothing left to propose');
});

test('proposals: same-instant rows are ambiguous and produce nothing', () => {
  const a = { ...STATUS_OLD, id: 'a', created_at: D('2026-07-20') };
  const b = { ...STATUS_MID, id: 'b', created_at: D('2026-07-20') };
  assert.equal(proposeSupersessions([a, b]).length, 0);
});

test('proposals: no clusters → no proposals; single row → no proposals', () => {
  assert.deepEqual(proposeSupersessions([UNRELATED, STATUS_NEW]), []);
  assert.deepEqual(proposeSupersessions([STATUS_NEW]), []);
});

test('proposals are inert data: no write/apply verb anywhere on the returned object', () => {
  const [p] = proposeSupersessions([STATUS_OLD, STATUS_NEW]);
  assert.ok(p);
  for (const v of Object.values(p!)) {
    assert.notEqual(typeof v, 'function', 'a proposal must not carry callable behavior');
  }
});

// ── Cross-lane seam handshake (A-T2) ─────────────────────────────────────

test('SEAM: makeStalenessHook is assignable to RecallDeps.applyStaleness', () => {
  // Compile-time assertion first — if A-T2 reshapes GraphRecallUnit or the dep
  // signature, this file stops compiling instead of silently un-wiring the
  // downrank at runtime. The runtime half proves a real unit array survives.
  const hook: NonNullable<RecallDeps['applyStaleness']> = makeStalenessHook<GraphRecallUnit>();

  // Real GraphRecallUnit shape: keyed on `memory_id`, scored on `final_score`.
  const unit = (memory_id: string, created_at: string, final_score: number, content: string) =>
    ({
      memory_id,
      content,
      project: 'termdeck',
      depth: 0,
      vector_score: 0,
      edge_weight: 1,
      recency_score: 1,
      final_score,
      path: [],
      source_type: 'fact',
      metadata: {},
      created_at,
      kind: 'memory',
    }) as GraphRecallUnit;

  const units = [
    unit('u-old', D('2026-07-20'), 0.9, STATUS_OLD.content!),
    unit('u-new', D('2026-07-31'), 0.1, STATUS_NEW.content!),
  ];

  const out = hook(units);
  assert.equal(out.length, 2);
  assert.equal(out[0]!.memory_id, 'u-new', 'newest anchor leads after the hook');
  assert.equal(
    out.find((u) => u.memory_id === 'u-old')!.final_score,
    0.9,
    'the rendered score is never rewritten'
  );
  assert.ok(assertAnchorInvariant(out).ok);
});

test('SEAM: a row with neither id nor memory_id is passed through, never grouped', () => {
  const rows = [
    { created_at: D('2026-07-01'), score: 0.09, project: 'p', content: STATUS_OLD.content },
    { created_at: D('2026-07-31'), score: 0.01, project: 'p', content: STATUS_NEW.content },
  ];
  const { clusters, ordered } = downrankStaleSiblings(rows);
  assert.equal(clusters.length, 0, 'unkeyed rows must not collide on an empty id');
  assert.equal(ordered.length, 2);
  assert.ok(ordered.every((h) => h.staleness === undefined));
});

test('idOf reads either surface and prefers id', () => {
  assert.equal(idOf({ id: 'a' }), 'a');
  assert.equal(idOf({ memory_id: 'b' }), 'b');
  assert.equal(idOf({ id: 'a', memory_id: 'b' }), 'a');
  assert.equal(idOf({}), '');
  assert.equal(idOf({ id: '', memory_id: 'b' }), 'b');
});

// ── Structural fence: this module cannot touch the database ──────────────

test('FENCE: staleness.ts imports no database client and no I/O — it cannot auto-apply', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  // dist-tests/tests/… → repo root → src/staleness.ts (source, not build output).
  const source = readFileSync(join(here, '..', '..', 'src', 'staleness.ts'), 'utf8');

  const importLines = source
    .split('\n')
    .filter((l) => /^\s*import\s/.test(l) || /\bfrom\s+['"]/.test(l));
  for (const line of importLines) {
    assert.ok(
      /from\s+'\.\/types\.js'/.test(line),
      `staleness.ts may only import types.js; found: ${line.trim()}`
    );
    assert.ok(/^\s*import type\s/.test(line), `imports must be type-only; found: ${line.trim()}`);
  }
  for (const forbidden of ['getSupabase', 'supabase', '.rpc(', 'fetch(', 'node:fs', 'update(', 'insert(']) {
    assert.ok(
      !source.includes(forbidden),
      `staleness.ts must not reference ${forbidden} — proposals are decided by the judged-promotion path, not applied here`
    );
  }
});

/**
 * Mnestra — structural staleness (Sprint 70 A-T3).
 *
 * THE FAILURE THIS KILLS (Jul-31 recall-staleness incident): a status-shaped
 * query surfaced a superseded row ABOVE its successor, and the reader acted on
 * the stale one. The store already defends the *applied* case — migration 033's
 * live-row predicate is `is_active and not archived and superseded_by is null`,
 * so a row that has been formally superseded never reaches recall at all. The
 * rows that actually bit are the ones nobody ever marked: three near-identical
 * "X is now Y" memories written on three different days, all live, all equally
 * matching, ordered by an RRF score that knows nothing about which is current.
 *
 * So this is structural, not advisory. We do not tell the model "prefer newer";
 * we reorder so the newest anchor of a sibling set is ABOVE its older siblings,
 * and that ordering is a hard post-condition (`assertAnchorInvariant`), not an
 * emergent property of a score multiplier that a future weight change could
 * silently undo.
 *
 * WHAT COUNTS AS A SIBLING SET — and the one thing it deliberately is NOT:
 *
 *   1. A supersession chain (`superseded_by`, or a `supersedes`/`consolidated_from`
 *      link carried in metadata) — an explicit, human- or judge-blessed claim
 *      that one row replaces another.
 *   2. A near-duplicate content cluster — token-set Jaccard over normalized
 *      content, same project, above a conservative threshold.
 *
 *   NOT community co-membership. The 034 substrate's consolidation communities
 *   (51 live, `metadata.consolidation.community_key`, 5–8 members each) group
 *   memories that are ABOUT THE SAME THING, not memories that SAY THE SAME
 *   THING. Downranking seven of eight community members because the eighth is
 *   newer would destroy exactly the context chain this sprint exists to build.
 *   A caller may inject its own authoritative near-dup cluster id via
 *   `clusterKeyOf` — but a community key is not one, and passing it is a bug.
 *
 * PURITY IS THE SAFETY PROPERTY. This module imports no database client and
 * performs no I/O; `proposeSupersessions` returns proposal objects and cannot,
 * by construction, apply one. A supersession is a destructive claim (the loser
 * leaves recall entirely under 033's predicate), so the machinery that decides
 * is the judged-promotion path — never a similarity threshold firing unattended.
 * `tests/staleness.test.ts` pins the no-I/O property against the source text.
 */

import type { RelationshipType } from './types.js';

// ── Input shape ──────────────────────────────────────────────────────────

/**
 * The subset of a recall hit staleness needs. Structural, not nominal, so it
 * accepts `RecallHit`, `GraphRecallHit`, or a raw `memory_items` row without
 * any of them importing this module. Everything past `id`/`created_at`/`score`
 * is optional and degrades to "signal unavailable", never to a throw.
 */
export interface StaleableHit {
  /**
   * Two names, same reason as the score pair: `recall.ts` hits and raw
   * `memory_items` rows carry `id`, while `recall_graph.ts` units carry
   * `memory_id` (the walk RPC's return column). A row with neither is passed
   * through untouched rather than grouped against a meaningless key.
   */
  id?: string;
  memory_id?: string;
  /** ISO timestamp. The recency axis; absent/unparseable values sort oldest. */
  created_at?: string | null;
  /**
   * The caller's ranking score. Two names because the two live surfaces
   * differ: `recall.ts` hits carry `score` (RRF composite), `recall_graph.ts`
   * units carry `final_score`. Whichever is present is read; neither is
   * written back — rewriting a number the caller renders would make its
   * displayed score a lie. The penalty lands on `staleness.adjusted_score`,
   * and the ORDER is the contract.
   */
  score?: number;
  final_score?: number;
  project?: string;
  content?: string;
  source_type?: string | null;
  metadata?: Record<string, unknown> | null;
  /**
   * Present on raw rows, absent on `RecallHit`. When present it is the
   * strongest possible grouping signal — though note that a row carrying it is
   * already excluded from recall by 033, so in practice this arrives only from
   * callers reading `memory_items` directly (e.g. the proposal path).
   */
  superseded_by?: string | null;
}

export type ClusterBasis = 'supersedes' | 'near_dup' | 'cluster_hint';

export interface StalenessAnnotation {
  /** Stable within one call: the anchor's id. */
  cluster_id: string;
  anchor_id: string;
  role: 'anchor' | 'stale_sibling';
  /** 0 for the anchor, 1 for the next-newest sibling, and so on. */
  age_rank: number;
  basis: ClusterBasis;
  original_score: number;
  adjusted_score: number;
  /** Set when the hard invariant had to move this row, not just rescore it. */
  repositioned?: boolean;
}

export type AnnotatedHit<T extends StaleableHit> = T & { staleness?: StalenessAnnotation };

export interface StalenessCluster {
  anchor_id: string;
  basis: ClusterBasis;
  /** Newest first; index 0 is the anchor. */
  member_ids: string[];
}

export interface StalenessOptions {
  /**
   * Tier-0 / objective rows: never an anchor, never a sibling, never
   * downranked, never repositioned (seam §1 + §3 — objectives are injected,
   * not retrieved, and must not be absorbed or decayed).
   *
   * PROVISIONAL DEFAULT. Deck B (B-T1) owns the authoritative marker and posts
   * its exact column/flag spec as SCHEMA-READY. Until then the default matches
   * the shapes a tier-0 row could plausibly carry — deliberately over-inclusive,
   * because a false exemption costs one un-downranked row while a false
   * non-exemption decays an objective. Swap this one function when B-T1 lands.
   */
  isTier0?: (hit: StaleableHit) => boolean;
  /**
   * Authoritative NEAR-DUP cluster id, when the caller has one. Returning a
   * consolidation community key here is a bug — see the module header.
   */
  clusterKeyOf?: (hit: StaleableHit) => string | null | undefined;
  /** Token-set Jaccard at or above which two contents are near-duplicates. */
  nearDupThreshold?: number;
  /** Contents with fewer distinct tokens than this never near-dup match. */
  nearDupMinTokens?: number;
  /** Multiplier applied per generation of age: score × penalty^age_rank. */
  penalty?: number;
  /** Lower bound on the multiplier, so a long chain's tail stays orderable. */
  penaltyFloor?: number;
  /** Escape hatch: false returns the input order untouched. */
  enabled?: boolean;
}

export const DEFAULT_STALENESS_OPTIONS: Required<
  Pick<StalenessOptions, 'nearDupThreshold' | 'nearDupMinTokens' | 'penalty' | 'penaltyFloor'>
> = {
  // 0.78 is conservative on purpose: the cost of a false near-dup is that a
  // genuinely distinct memory sinks below an unrelated one, which is worse than
  // the cost of a miss (status quo — the row simply isn't downranked).
  nearDupThreshold: 0.78,
  nearDupMinTokens: 6,
  penalty: 0.6,
  penaltyFloor: 0.05,
};

// ── Tier-0 detection (provisional — see StalenessOptions.isTier0) ─────────

export function defaultIsTier0(hit: StaleableHit): boolean {
  const md = hit.metadata;
  if (md && typeof md === 'object') {
    const tier = (md as Record<string, unknown>).tier;
    if (tier === 0 || tier === '0') return true;
    if ((md as Record<string, unknown>).objective === true) return true;
    if ((md as Record<string, unknown>).tier0 === true) return true;
    const kind = (md as Record<string, unknown>).kind;
    if (typeof kind === 'string' && kind.toLowerCase() === 'objective') return true;
  }
  return hit.source_type === 'objective';
}

// ── Near-duplicate similarity ────────────────────────────────────────────

/** Lowercase, strip non-alphanumerics, split, dedupe. No stopword list and no
 *  stemming: both are locale-dependent and would make the threshold's meaning
 *  drift with content language. */
export function normalizeTokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .split(' ')
      .filter((t) => t.length > 0)
  );
}

/** Jaccard over token sets: |A ∩ B| / |A ∪ B| ∈ [0, 1]. */
export function tokenSetSimilarity(a: string, b: string): number {
  const sa = normalizeTokens(a);
  const sb = normalizeTokens(b);
  if (sa.size === 0 || sb.size === 0) return 0;
  let intersection = 0;
  for (const t of sa) if (sb.has(t)) intersection += 1;
  const union = sa.size + sb.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

// ── Grouping ─────────────────────────────────────────────────────────────

class UnionFind {
  private parent = new Map<string, string>();

  find(x: string): string {
    const p = this.parent.get(x);
    if (p === undefined) {
      this.parent.set(x, x);
      return x;
    }
    if (p === x) return x;
    const root = this.find(p);
    this.parent.set(x, root);
    return root;
  }

  union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
}

/** ms since epoch; unparseable/absent timestamps sort oldest (never anchor). */
function timeOf(hit: StaleableHit): number {
  const t = Date.parse(hit.created_at ?? '');
  return Number.isNaN(t) ? Number.NEGATIVE_INFINITY : t;
}

/** Whichever id the surface carries; '' when neither is present. */
export function idOf(hit: StaleableHit): string {
  if (typeof hit.id === 'string' && hit.id !== '') return hit.id;
  if (typeof hit.memory_id === 'string' && hit.memory_id !== '') return hit.memory_id;
  return '';
}

/** Whichever ranking score the surface carries; 0 when neither is present. */
export function scoreOf(hit: StaleableHit): number {
  if (typeof hit.score === 'number' && Number.isFinite(hit.score)) return hit.score;
  if (typeof hit.final_score === 'number' && Number.isFinite(hit.final_score)) {
    return hit.final_score;
  }
  return 0;
}

/** Ids this hit explicitly claims to replace or be replaced by. */
function explicitLinks(hit: StaleableHit): string[] {
  const out: string[] = [];
  if (typeof hit.superseded_by === 'string' && hit.superseded_by) out.push(hit.superseded_by);
  const md = hit.metadata;
  if (md && typeof md === 'object') {
    const rec = md as Record<string, unknown>;
    for (const key of ['supersedes', 'superseded_by', 'consolidated_from']) {
      const v = rec[key];
      if (typeof v === 'string' && v) out.push(v);
      else if (Array.isArray(v)) for (const e of v) if (typeof e === 'string' && e) out.push(e);
    }
  }
  return out;
}

/**
 * Newest-first ordering with fully deterministic tie-breaks: time desc, then
 * score desc, then id desc. Determinism matters more than the specific rule —
 * an anchor that flips between two equal rows across calls would make the
 * whole feature untestable and its audit trail meaningless.
 */
function newestFirst(a: StaleableHit, b: StaleableHit): number {
  const ta = timeOf(a);
  const tb = timeOf(b);
  if (ta !== tb) return tb - ta;
  const sa = scoreOf(a);
  const sb = scoreOf(b);
  if (sa !== sb) return sb - sa;
  const ia = idOf(a);
  const ib = idOf(b);
  return ia < ib ? 1 : ia > ib ? -1 : 0;
}

interface GroupResult {
  clusters: StalenessCluster[];
  /** id → cluster it belongs to. Singletons and exempt rows are absent. */
  byId: Map<string, { cluster: StalenessCluster; ageRank: number }>;
}

function groupSiblings(hits: readonly StaleableHit[], opts: StalenessOptions): GroupResult {
  const isTier0 = opts.isTier0 ?? defaultIsTier0;
  const threshold = opts.nearDupThreshold ?? DEFAULT_STALENESS_OPTIONS.nearDupThreshold;
  const minTokens = opts.nearDupMinTokens ?? DEFAULT_STALENESS_OPTIONS.nearDupMinTokens;

  // Exempt rows are removed BEFORE any grouping — they cannot anchor, cannot be
  // absorbed, and cannot even contribute a near-dup edge between two others.
  // Rows with no resolvable id go with them: every structure here is keyed by
  // id, so two unkeyed rows would otherwise collide on '' and be "clustered"
  // for no reason other than both being anonymous.
  const eligible = hits.filter((h) => !isTier0(h) && idOf(h) !== '');
  const byId = new Map(eligible.map((h) => [idOf(h), h]));

  const uf = new UnionFind();
  // Edges are recorded, not labelled in place: union() can re-root a set at any
  // later merge, so a basis written against the root-of-the-moment would be
  // stranded (and a mixed cluster could silently lose its 'supersedes' label).
  // The cluster's basis is resolved once, after all unions, in the materialize
  // pass below.
  const edges: Array<{ a: string; kind: ClusterBasis }> = [];
  const noteBasis = (a: string, b: string, kind: ClusterBasis) => {
    uf.union(a, b);
    edges.push({ a, kind });
  };

  // 1. Explicit supersession links, in either direction.
  for (const h of eligible) {
    for (const other of explicitLinks(h)) {
      if (other !== idOf(h) && byId.has(other)) noteBasis(idOf(h), other, 'supersedes');
    }
  }

  // 2. Caller-supplied near-dup cluster ids.
  if (opts.clusterKeyOf) {
    const seen = new Map<string, string>();
    for (const h of eligible) {
      const key = opts.clusterKeyOf(h);
      if (key === null || key === undefined || key === '') continue;
      const scoped = `${h.project ?? ''}\u0000${key}`;
      const first = seen.get(scoped);
      if (first === undefined) seen.set(scoped, idOf(h));
      else noteBasis(idOf(h), first, 'cluster_hint');
    }
  }

  // 3. Content near-duplication, same project only. O(n²) over one page of
  //    hits (k ≤ ~50) — deliberately not indexed; the constant is trivial and
  //    an approximate index would make the result non-deterministic.
  const withContent = eligible.filter((h) => {
    if (typeof h.content !== 'string' || h.content.trim() === '') return false;
    return normalizeTokens(h.content).size >= minTokens;
  });
  for (let i = 0; i < withContent.length; i += 1) {
    for (let j = i + 1; j < withContent.length; j += 1) {
      const a = withContent[i]!;
      const b = withContent[j]!;
      if (a.project !== undefined && b.project !== undefined && a.project !== b.project) continue;
      if (tokenSetSimilarity(a.content!, b.content!) >= threshold) {
        noteBasis(idOf(a), idOf(b), 'near_dup');
      }
    }
  }

  // Resolve each cluster's basis from its edges, strongest claim winning:
  // an explicit supersession beats a caller's cluster hint beats content
  // near-duplication.
  const BASIS_RANK: Record<ClusterBasis, number> = {
    supersedes: 3,
    cluster_hint: 2,
    near_dup: 1,
  };
  const basis = new Map<string, ClusterBasis>();
  for (const edge of edges) {
    const root = uf.find(edge.a);
    const current = basis.get(root);
    if (current === undefined || BASIS_RANK[edge.kind] > BASIS_RANK[current]) {
      basis.set(root, edge.kind);
    }
  }

  // Materialize clusters (size ≥ 2 only), newest first.
  const members = new Map<string, StaleableHit[]>();
  for (const h of eligible) {
    const root = uf.find(idOf(h));
    const list = members.get(root);
    if (list) list.push(h);
    else members.set(root, [h]);
  }

  const clusters: StalenessCluster[] = [];
  const index = new Map<string, { cluster: StalenessCluster; ageRank: number }>();
  for (const [root, group] of members) {
    if (group.length < 2) continue;
    const ordered = [...group].sort(newestFirst);
    const cluster: StalenessCluster = {
      anchor_id: idOf(ordered[0]!),
      basis: basis.get(root) ?? 'near_dup',
      member_ids: ordered.map((m) => idOf(m)),
    };
    clusters.push(cluster);
    ordered.forEach((m, ageRank) => index.set(idOf(m), { cluster, ageRank }));
  }

  // Stable, id-sorted output so two runs over the same page are byte-identical.
  clusters.sort((a, b) => (a.anchor_id < b.anchor_id ? -1 : a.anchor_id > b.anchor_id ? 1 : 0));
  return { clusters, byId: index };
}

// ── Read-side downranking ────────────────────────────────────────────────

export interface DownrankResult<T extends StaleableHit> {
  /** Re-ordered hits; clustered rows carry a `staleness` annotation. */
  ordered: AnnotatedHit<T>[];
  clusters: StalenessCluster[];
  /** Rows moved by the hard invariant repair rather than by score alone. */
  repositioned_ids: string[];
}

/**
 * Rank a page of hits so that no older sibling outranks its newest anchor.
 *
 * Pure: inputs are never mutated (annotated rows are shallow copies) and the
 * output is a permutation of the input — nothing is dropped, ever. A stale
 * sibling is still retrievable; it just stops masquerading as current.
 *
 * Two mechanisms, in this order:
 *   1. Score penalty — `score × penalty^age_rank`, floored. This is the soft
 *      signal, and it is what a consumer sees if it re-sorts by score itself.
 *   2. Invariant repair — after sorting, any sibling still above its anchor is
 *      moved to immediately after it. Rare (the penalty usually settles it),
 *      but it is what makes the ordering a guarantee rather than a tendency,
 *      and it is what `assertAnchorInvariant` checks.
 */
export function downrankStaleSiblings<T extends StaleableHit>(
  hits: readonly T[],
  options: StalenessOptions = {}
): DownrankResult<T> {
  if (options.enabled === false || hits.length < 2) {
    return { ordered: [...hits] as AnnotatedHit<T>[], clusters: [], repositioned_ids: [] };
  }

  const penalty = options.penalty ?? DEFAULT_STALENESS_OPTIONS.penalty;
  const floor = options.penaltyFloor ?? DEFAULT_STALENESS_OPTIONS.penaltyFloor;
  const { clusters, byId } = groupSiblings(hits, options);

  if (clusters.length === 0) {
    return { ordered: [...hits] as AnnotatedHit<T>[], clusters: [], repositioned_ids: [] };
  }

  const annotated: AnnotatedHit<T>[] = hits.map((hit) => {
    const entry = byId.get(idOf(hit));
    if (!entry) return hit as AnnotatedHit<T>;
    const { cluster, ageRank } = entry;
    const multiplier = ageRank === 0 ? 1 : Math.max(Math.pow(penalty, ageRank), floor);
    const raw = scoreOf(hit);
    const adjusted = raw * multiplier;
    return {
      ...hit,
      staleness: {
        cluster_id: cluster.anchor_id,
        anchor_id: cluster.anchor_id,
        role: ageRank === 0 ? 'anchor' : 'stale_sibling',
        age_rank: ageRank,
        basis: cluster.basis,
        original_score: raw,
        adjusted_score: adjusted,
      },
    } as AnnotatedHit<T>;
  });

  // Stable sort by adjusted score desc; unclustered rows keep their own score.
  const withIndex = annotated.map((hit, i) => ({ hit, i }));
  withIndex.sort((a, b) => {
    const sa = a.hit.staleness?.adjusted_score ?? scoreOf(a.hit);
    const sb = b.hit.staleness?.adjusted_score ?? scoreOf(b.hit);
    if (sa !== sb) return sb - sa;
    return a.i - b.i;
  });

  // Invariant repair: hold back any sibling whose anchor has not been emitted,
  // and release it immediately after the anchor lands.
  const emitted = new Set<string>();
  const held = new Map<string, AnnotatedHit<T>[]>();
  const ordered: AnnotatedHit<T>[] = [];
  const repositioned: string[] = [];

  const release = (anchorId: string) => {
    const waiting = held.get(anchorId);
    if (!waiting) return;
    held.delete(anchorId);
    for (const h of waiting) {
      ordered.push(h);
      emitted.add(idOf(h));
      release(idOf(h));
    }
  };

  for (const { hit } of withIndex) {
    const s = hit.staleness;
    if (s && s.role === 'stale_sibling' && !emitted.has(s.anchor_id)) {
      const list = held.get(s.anchor_id);
      if (list) list.push(hit);
      else held.set(s.anchor_id, [hit]);
      if (s.repositioned !== true) {
        s.repositioned = true;
        repositioned.push(idOf(hit));
      }
      continue;
    }
    ordered.push(hit);
    emitted.add(idOf(hit));
    release(idOf(hit));
  }

  // Any still-held rows (anchor absent from this page — shouldn't happen, since
  // clusters are built from the page itself) go last rather than vanishing.
  for (const waiting of held.values()) for (const h of waiting) ordered.push(h);

  return { ordered, clusters, repositioned_ids: repositioned };
}

/**
 * The seam A-T2 consumes: `RecallDeps.applyStaleness`, shaped
 * `(units) => units` so the recall path can call it with no adapter and no
 * awareness of clusters. Same purity and same permutation guarantee as
 * `downrankStaleSiblings`; the richer return (clusters, repositioned ids) is
 * available from that function directly when a caller wants the audit trail.
 *
 * Safe by omission: if the hook is never installed, recall behaves exactly as
 * it does today — which is what keeps the default-OFF parity criterion honest.
 */
export function makeStalenessHook<T extends StaleableHit>(
  options: StalenessOptions = {}
): (units: readonly T[]) => T[] {
  return (units: readonly T[]) => downrankStaleSiblings(units, options).ordered;
}

/**
 * The post-condition, as a callable check: every stale sibling appears strictly
 * after its anchor. Exported so A-T2 can assert it in the recall path and so
 * A-T4 can verify it independently of this module's internals.
 */
export function assertAnchorInvariant<T extends StaleableHit>(
  ordered: readonly AnnotatedHit<T>[]
): { ok: boolean; violations: Array<{ id: string; anchor_id: string }> } {
  const position = new Map<string, number>();
  ordered.forEach((h, i) => position.set(idOf(h), i));
  const violations: Array<{ id: string; anchor_id: string }> = [];
  ordered.forEach((h, i) => {
    const s = h.staleness;
    if (!s || s.role !== 'stale_sibling') return;
    const anchorPos = position.get(s.anchor_id);
    if (anchorPos === undefined || anchorPos > i) {
      violations.push({ id: idOf(h), anchor_id: s.anchor_id });
    }
  });
  return { ok: violations.length === 0, violations };
}

// ── Mechanical supersession PROPOSALS (never applied) ────────────────────

export interface SupersedesProposal {
  /** `source supersedes target` — the newer row is the source. */
  source_id: string;
  target_id: string;
  successor_id: string;
  predecessor_id: string;
  relationship_type: Extract<RelationshipType, 'supersedes'>;
  basis: ClusterBasis;
  /** Token-set Jaccard between the pair, when content was available. */
  similarity: number | null;
  status: 'proposed';
  evidence: {
    cluster_anchor_id: string;
    cluster_size: number;
    age_rank: number;
    successor_created_at: string | null;
    predecessor_created_at: string | null;
    project?: string;
    detector: string;
  };
}

export const SUPERSEDES_PROPOSAL_DETECTOR = 'mnestra/staleness@1';

/**
 * Derive `supersedes` PROPOSALS from near-duplicate clusters. Returns objects;
 * writes nothing. Applying one is a destructive act — under 033's live-row
 * predicate the predecessor leaves recall entirely — so the decision belongs to
 * the judged-promotion machinery, and this module has no database handle with
 * which to shortcut it.
 *
 * Each older sibling gets exactly one proposal against the cluster anchor
 * (a star, not a chain), so rejecting one proposal never orphans another.
 *
 * Excluded by construction: tier-0/objective rows at either end, pairs where a
 * supersession is already applied, and clusters grouped solely by an explicit
 * link (there is nothing to propose — the claim already exists).
 */
export function proposeSupersessions(
  rows: readonly StaleableHit[],
  options: StalenessOptions = {}
): SupersedesProposal[] {
  if (rows.length < 2) return [];
  const isTier0 = options.isTier0 ?? defaultIsTier0;
  const { clusters } = groupSiblings(rows, options);
  const byId = new Map(rows.map((r) => [idOf(r), r]));
  const proposals: SupersedesProposal[] = [];

  for (const cluster of clusters) {
    if (cluster.basis === 'supersedes') continue;
    const anchor = byId.get(cluster.anchor_id);
    if (!anchor || isTier0(anchor)) continue;

    cluster.member_ids.forEach((memberId, ageRank) => {
      if (ageRank === 0) return;
      const member = byId.get(memberId);
      if (!member || isTier0(member)) return;
      // Already-applied supersession: nothing to propose.
      if (typeof member.superseded_by === 'string' && member.superseded_by) return;
      // Same-instant rows are ambiguous about which is the successor; a
      // proposal that could be argued either way is not worth a judge's time.
      if (timeOf(member) >= timeOf(anchor)) return;

      const similarity =
        typeof anchor.content === 'string' && typeof member.content === 'string'
          ? tokenSetSimilarity(anchor.content, member.content)
          : null;

      proposals.push({
        source_id: idOf(anchor),
        target_id: idOf(member),
        successor_id: idOf(anchor),
        predecessor_id: idOf(member),
        relationship_type: 'supersedes',
        basis: cluster.basis,
        similarity,
        status: 'proposed',
        evidence: {
          cluster_anchor_id: cluster.anchor_id,
          cluster_size: cluster.member_ids.length,
          age_rank: ageRank,
          successor_created_at: anchor.created_at ?? null,
          predecessor_created_at: member.created_at ?? null,
          ...(anchor.project !== undefined ? { project: anchor.project } : {}),
          detector: SUPERSEDES_PROPOSAL_DETECTOR,
        },
      });
    });
  }

  return proposals;
}

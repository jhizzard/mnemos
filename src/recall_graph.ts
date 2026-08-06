/**
 * Mnestra — memory_recall_graph (Sprint 38 / T3 · Sprint 70 A-T2)
 *
 * Graph-aware recall. Two RPC shapes live behind one TS surface:
 *
 *   • LEGACY — `memory_recall_graph` (migration 010). Vector top-K via
 *     match_memories, expanded through `memory_relationships` only, re-ranked
 *     by vector_score × edge_weight × recency_score.
 *   • BOOSTED — `memory_recall_graph_boosted` (migration 037, Sprint 70 A-T1).
 *     Same spine, but the edge set is widened to typed relationships ∪ entity
 *     co-mention ∪ community co-membership, and the walk can be SEEDED from
 *     entities matched against the raw query text — the "a few keywords pull
 *     the whole chain" mechanism. 037 is a NEW function, not a replacement:
 *     010 is untouched so the flag-off path stays byte-identical.
 *
 * Sprint 70 A-T2 adds three things on top of that walk:
 *
 *   1. **The seam envelope.** `{ tier0, results, hits, … }` with `tier0`
 *      FIRST — a pinned block reserved for Deck B's objective tier. Emitted
 *      `[]` this sprint; `RecallDeps.fetchTier0` is the wiring point. tier0 is
 *      never interleaved with results, never absorbed into a hub, never
 *      downranked by staleness.
 *   2. **Hub coarse-to-fine collapse.** When ≥ N members of one consolidation
 *      community appear in the walk, the community's `consolidation_summary`
 *      replaces them as the PRIMARY unit and the members degrade to citations
 *      (id + one-line gist). Compiled knowledge over raw chunks.
 *   3. **The privacy gate the graph surface never had.** `src/recall.ts`
 *      filters privacy-tagged rows caller-side off `row.privacy_tags`; 010
 *      returns no such column, so this surface has been privacy-blind since
 *      Sprint 38 (A-T1 filed the same finding from the SQL side). 037 returns
 *      `privacy_tags` as a passthrough; on the legacy path we hydrate the
 *      column with one batch select. Either way the gate now holds here.
 *
 * The shape returned to callers still mirrors `memoryRecall` so the MCP tool
 * surface is interchangeable, plus per-row `depth` / `final_score` so callers
 * can tell vector hits from graph-expanded neighbors.
 */

import { getSupabase } from './db.js';
import { generateEmbedding, formatEmbedding } from './embeddings.js';
import { logRecallHits } from './recall_log.js';
import { tier0FetcherForRecall } from './objectives.js';
import type { RecallDeps, Tier0Item } from './recall.js';

const DEFAULT_DEPTH = 2;
const DEFAULT_K = 10;
const MAX_CONTENT_LENGTH = 300;

/** RPC names. 037 is additive — 010 keeps answering its own callers. */
export const LEGACY_GRAPH_RPC = 'memory_recall_graph';
export const BOOSTED_GRAPH_RPC = 'memory_recall_graph_boosted';

/**
 * Hub coarse-to-fine threshold. Tuned against the live store: 51 communities,
 * member_count min 4 / avg 9.5 / max 30 — so 3 is a threshold that actually
 * discriminates rather than collapsing on any single incidental hit.
 */
export const DEFAULT_HUB_MIN_MEMBERS = 3;

/** One-line citation gist length. Deliberately far below MAX_CONTENT_LENGTH: a
 *  citation exists to let the reader decide whether to expand, not to be read. */
const HUB_GIST_LENGTH = 110;

/**
 * Cap on the community-summary index fetch. 51 rows live; the cap is a
 * runaway guard, not a design limit. Hitting it is WARNED, never silent —
 * a truncated index would silently stop collapsing hubs and look like
 * "the feature just doesn't fire".
 */
const HUB_COMMUNITY_FETCH_LIMIT = 500;

export type GraphWalkMode = 'auto' | 'boosted' | 'legacy';

export interface GraphRecallInput {
  query: string;
  project?: string | null;
  depth?: number;
  k?: number;
  /**
   * Collapse a community into its summary once this many of its members show
   * up in the walk. Default DEFAULT_HUB_MIN_MEMBERS; ≤ 0 disables collapse
   * entirely (the raw walk is returned unchanged).
   */
  hub_min_members?: number;
  /** 037 walk-tuning passthroughs. Omitted → the SQL defaults apply. */
  entity_weight?: number;
  community_weight?: number;
  entity_hub_cap?: number;
  community_cap?: number;
  max_rows?: number;
  /** §Seam 3 — 037's tier-0 exclusion switch. Omitted → SQL default (true). */
  exclude_tier0?: boolean;
  /** Force a walk shape. Default 'auto': boosted, falling back to legacy. */
  walk?: GraphWalkMode;
  /** Retrieval filters, same contracts as `memoryRecall`. */
  source_agents?: string[] | null;
  include_null_source?: boolean;
  include_privacy?: string[] | null;
  /** Fire recall telemetry. `memoryRecall` passes false and logs once itself. */
  log?: boolean;
}

export interface GraphRecallHit {
  memory_id: string;
  content: string;
  project: string;
  depth: number;
  vector_score: number;
  edge_weight: number;
  recency_score: number;
  final_score: number;
  path: string[];
  /**
   * 037 additions. Optional because the legacy 010 return table has none of
   * them; `source_type` / `metadata` / `privacy_tags` are backfilled by
   * hydrateRows() on that path so downstream code can treat them as present.
   */
  source_type?: string | null;
  metadata?: Record<string, unknown> | null;
  privacy_tags?: string[] | null;
  created_at?: string | null;
  /** 'vector' | 'entity' | 'both' | null (null = pure graph neighbor). */
  seed_kind?: string | null;
  /** Per-hop arm labels: `typed:<predicate>` | `entity:<key>` | `community:<key>`. */
  edge_path?: string[] | null;
}

/** A collapsed member: enough to decide whether to expand, nothing more. */
export interface HubCitation {
  memory_id: string;
  gist: string;
  depth: number;
  final_score: number;
}

/**
 * The unit a caller actually renders. A 'memory' unit is a walk row verbatim;
 * a 'hub' unit is a consolidation_summary standing in for ≥ N of its members.
 */
export interface GraphRecallUnit extends GraphRecallHit {
  kind: 'memory' | 'hub';
  community_key?: string;
  /** Members in the community overall (from metadata.consolidation). */
  member_count?: number;
  /** Members of it that this walk actually surfaced. */
  matched_count?: number;
  citations?: HubCitation[];
}

export interface GraphRecallOutput {
  /**
   * §Seam 1 — the pinned tier-0 block, ALWAYS first, never interleaved with
   * `results`, never absorbed into a hub. Deck A emits `[]` this sprint; Deck
   * B (B-T1) supplies the fetch via `RecallDeps.fetchTier0`.
   */
  tier0: Tier0Item[];
  /** Primary units after hub collapse — what a caller should render. */
  results: GraphRecallUnit[];
  /** The raw, uncollapsed walk rows. Back-compat for pre-Sprint-70 callers. */
  hits: GraphRecallHit[];
  depth_distribution: Record<number, number>;
  hub_count: number;
  /** Which walk actually answered — the auditor's evidence, not decoration. */
  walk: { rpc: string; boosted: boolean };
  text: string;
}

interface CommunityRow {
  id: string;
  content: string;
  project: string;
  metadata: Record<string, unknown> | null;
  created_at?: string | null;
  privacy_tags?: string[] | null;
}

interface Community {
  summary: CommunityRow;
  community_key: string;
  member_ids: Set<string>;
  member_count: number;
}

function truncate(content: string, maxLen: number): string {
  if (content.length <= maxLen) return content;
  return content.slice(0, maxLen).trimEnd() + '...';
}

/** One line, whitespace collapsed — a gist must never break the list layout. */
function gistOf(content: string): string {
  return truncate(content.replace(/\s+/g, ' ').trim(), HUB_GIST_LENGTH);
}

function envFlag(name: string): boolean {
  const raw = (process.env[name] ?? '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'on' || raw === 'yes';
}

/**
 * Walk-shape resolution. Explicit input wins, then `MNESTRA_GRAPH_WALK`, then
 * 'auto'. 'auto' tries boosted and silently degrades to legacy — the compat
 * shim that lets this file ship BEFORE migration 037 is applied anywhere.
 */
export function resolveWalkMode(input?: GraphWalkMode): GraphWalkMode {
  if (input === 'boosted' || input === 'legacy' || input === 'auto') return input;
  const raw = (process.env.MNESTRA_GRAPH_WALK ?? '').trim().toLowerCase();
  if (raw === 'boosted' || raw === 'legacy' || raw === 'auto') return raw;
  return 'auto';
}

/**
 * Per-process memo of "037 is not deployed here". A missing function is a
 * deployment fact, not a transient one, so probing once per process is right;
 * anything else re-pays a guaranteed 404 on every recall. Reset for tests.
 */
let boostedUnavailable = false;
export function __resetGraphWalkProbe(): void {
  boostedUnavailable = false;
}

interface RpcResult {
  rows: GraphRecallHit[];
  error: string | null;
  rpc: string;
  boosted: boolean;
}

/**
 * The compat shim. Builds the arg object for whichever walk we're calling.
 *
 * PostgREST binds by NAME: 037's first five argument names are 010's verbatim,
 * so the boosted arg object is a strict superset of the legacy one. Tuning
 * args are included ONLY when the caller set them, so the SQL defaults stay
 * the single source of truth for the numbers.
 */
function buildRpcArgs(
  input: GraphRecallInput,
  embedding: number[],
  boosted: boolean
): Record<string, unknown> {
  const args: Record<string, unknown> = {
    query_embedding: formatEmbedding(embedding),
    project_filter: input.project ?? null,
    max_depth: input.depth ?? DEFAULT_DEPTH,
    k: input.k ?? DEFAULT_K,
  };
  if (!boosted) return args;

  args.query_text = input.query.trim();
  if (typeof input.entity_weight === 'number') args.p_entity_weight = input.entity_weight;
  if (typeof input.community_weight === 'number') args.p_community_weight = input.community_weight;
  if (typeof input.entity_hub_cap === 'number') args.p_entity_hub_cap = input.entity_hub_cap;
  if (typeof input.community_cap === 'number') args.p_community_cap = input.community_cap;
  if (typeof input.max_rows === 'number') args.p_max_rows = input.max_rows;
  if (typeof input.exclude_tier0 === 'boolean') args.p_exclude_tier0 = input.exclude_tier0;
  return args;
}

/**
 * Call the walk, degrading boosted → legacy on ANY boosted-side failure.
 *
 * Deliberately not narrowed to PGRST202: a pre-037 store answers "could not
 * find the function", an older PostgREST answers 404, a schema-cache lag
 * answers something else again, and every one of those means the same thing
 * for us — the boosted walk isn't there, use the one that is. A real legacy
 * error still surfaces to the caller, so failures aren't swallowed, only
 * re-routed once.
 */
async function callWalk(
  supabase: { rpc: (name: string, args: Record<string, unknown>) => unknown },
  input: GraphRecallInput,
  embedding: number[]
): Promise<RpcResult> {
  const mode = resolveWalkMode(input.walk);
  const tryBoosted = mode === 'boosted' || (mode === 'auto' && !boostedUnavailable);

  if (tryBoosted) {
    try {
      const res = (await supabase.rpc(
        BOOSTED_GRAPH_RPC,
        buildRpcArgs(input, embedding, true)
      )) as { data: unknown; error: { message?: string } | null };
      if (!res?.error) {
        return {
          rows: (res?.data ?? []) as GraphRecallHit[],
          error: null,
          rpc: BOOSTED_GRAPH_RPC,
          boosted: true,
        };
      }
      if (mode === 'boosted') {
        return {
          rows: [],
          error: res.error.message ?? 'unknown error',
          rpc: BOOSTED_GRAPH_RPC,
          boosted: true,
        };
      }
      boostedUnavailable = true;
    } catch (err) {
      if (mode === 'boosted') {
        return {
          rows: [],
          error: (err as Error).message,
          rpc: BOOSTED_GRAPH_RPC,
          boosted: true,
        };
      }
      boostedUnavailable = true;
    }
  }

  const res = (await supabase.rpc(
    LEGACY_GRAPH_RPC,
    buildRpcArgs(input, embedding, false)
  )) as { data: unknown; error: { message?: string } | null };
  return {
    rows: (res?.data ?? []) as GraphRecallHit[],
    error: res?.error?.message ?? null,
    rpc: LEGACY_GRAPH_RPC,
    boosted: false,
  };
}

/**
 * Backfill the columns the legacy walk doesn't return, and the one NEITHER
 * walk returns (`source_agent`). One batch select over memory_items — the same
 * shape `src/recall.ts:180-197` uses for its own source_agent filter, and the
 * same table the quarantine proof allows read surfaces to touch.
 *
 * Skipped entirely when nothing needs it: the boosted walk already carries
 * privacy_tags/source_type/metadata, and source_agent is only needed when the
 * caller actually set that filter.
 */
async function hydrateRows(
  supabase: any,
  rows: GraphRecallHit[],
  opts: { needsColumns: boolean; needsAgent: boolean }
): Promise<{ rows: GraphRecallHit[]; agents: Map<string, string | null>; error: string | null }> {
  if (!opts.needsColumns && !opts.needsAgent) {
    return { rows, agents: new Map(), error: null };
  }
  const ids = rows.map((r) => r.memory_id);
  const { data, error } = await supabase
    .from('memory_items')
    .select('id, source_type, metadata, privacy_tags, created_at, source_agent')
    .in('id', ids);

  if (error) {
    // Fail CLOSED, matching the house precedent at src/recall.ts:186-192: a
    // privacy gate we cannot evaluate must not be assumed open. The caller
    // gets the error, not a silently unfiltered set.
    return { rows: [], agents: new Map(), error: error.message };
  }

  const byId = new Map<string, any>(((data ?? []) as any[]).map((r) => [r.id, r]));
  const agents = new Map<string, string | null>(
    ((data ?? []) as any[]).map((r) => [r.id, r.source_agent ?? null])
  );
  const hydrated = rows.map((r) => {
    const extra = byId.get(r.memory_id);
    if (!extra) return r;
    return {
      ...r,
      source_type: r.source_type ?? extra.source_type ?? null,
      metadata: r.metadata ?? extra.metadata ?? null,
      privacy_tags: r.privacy_tags ?? extra.privacy_tags ?? null,
      created_at: r.created_at ?? extra.created_at ?? null,
    };
  });
  return { rows: hydrated, agents, error: null };
}

/**
 * Privacy + source_agent gates, same semantics as `memoryRecall`:
 * privacy is UNCONDITIONAL default-deny with any-overlap opt-in; source_agent
 * only filters when set, and NULL-provenance rows drop unless opted back in.
 */
function applyRowGates<T extends { memory_id: string; privacy_tags?: string[] | null }>(
  rows: T[],
  opts: {
    sourceAgents: string[] | null;
    includeNullSource: boolean;
    includePrivacy: string[] | null;
    agents: Map<string, string | null>;
  }
): T[] {
  let out = rows;
  if (opts.sourceAgents) {
    out = out.filter((r) => {
      const agent = opts.agents.get(r.memory_id);
      if (!agent) return opts.includeNullSource;
      return opts.sourceAgents!.includes(agent);
    });
  }
  return out.filter((r) => {
    const tags = r.privacy_tags ?? [];
    if (tags.length === 0) return true;
    if (!opts.includePrivacy) return false;
    return tags.some((t) => opts.includePrivacy!.includes(t));
  });
}

/**
 * The community index: every consolidation_summary, keyed by the member ids it
 * compiled. Membership lives in `metadata.consolidation.member_ids` (written
 * by the nightly graph-consolidation job; pinned unique by
 * migrations/034_graph_layer.sql:919-921).
 *
 * NOT project-filtered on purpose. A community is identified by member ids,
 * which the walk has already scoped; filtering by the summary's own `project`
 * would drop a legitimately cross-project community for no gain at 51 rows.
 */
async function fetchCommunities(supabase: any, project: string | null): Promise<Community[]> {
  const { data, error } = await supabase
    .from('memory_items')
    .select('id, content, project, metadata, created_at, privacy_tags')
    .eq('source_type', 'consolidation_summary')
    .limit(HUB_COMMUNITY_FETCH_LIMIT);

  if (error) {
    // Hub collapse is an ENHANCEMENT over a correct result — unlike the
    // privacy hydrate above, losing it degrades presentation, not safety.
    // Fail open, loudly, and return the raw walk.
    console.error('[mnestra-recall-graph] community index fetch failed:', error.message);
    return [];
  }

  const rows = (data ?? []) as CommunityRow[];
  if (rows.length >= HUB_COMMUNITY_FETCH_LIMIT) {
    console.error(
      `[mnestra-recall-graph] community index hit the ${HUB_COMMUNITY_FETCH_LIMIT}-row cap — ` +
        'hub collapse may be incomplete. Raise HUB_COMMUNITY_FETCH_LIMIT or index by member id.'
    );
  }

  const communities: Community[] = [];
  for (const row of rows) {
    const consolidation = (row.metadata as any)?.consolidation;
    if (!consolidation || consolidation.kind !== 'community_summary') continue;
    const memberIds: unknown = consolidation.member_ids;
    if (!Array.isArray(memberIds) || memberIds.length === 0) continue;
    const key = String(consolidation.community_key ?? row.id);
    communities.push({
      summary: { ...row, project: row.project ?? project ?? '' },
      community_key: key,
      member_ids: new Set(memberIds.map(String)),
      member_count: Number(consolidation.member_count ?? memberIds.length),
    });
  }
  return communities;
}

/**
 * Hub coarse-to-fine collapse.
 *
 * Ordering contract: the walk arrives sorted by final_score desc, and a hub is
 * emitted at the position of its BEST member — so collapse rewrites WHAT is at
 * a rank, never the rank order itself. No re-sort, and the result stays
 * meaningful even if a caller hands over unsorted rows (hub lands at the first
 * member it sees).
 *
 * Communities are considered most-matched first, ties broken by community_key,
 * so two overlapping communities collapse deterministically and no row is
 * claimed twice.
 */
export function collapseHubs(
  rows: GraphRecallHit[],
  communities: Community[],
  minMembers: number
): { units: GraphRecallUnit[]; hub_count: number } {
  const asUnits = (): GraphRecallUnit[] => rows.map((r) => ({ ...r, kind: 'memory' as const }));
  if (minMembers <= 0 || communities.length === 0 || rows.length < minMembers) {
    return { units: asUnits(), hub_count: 0 };
  }

  const byId = new Map<string, GraphRecallHit>(rows.map((r) => [r.memory_id, r]));
  const claimed = new Map<string, Community>();

  const candidates = communities
    .map((c) => ({
      community: c,
      matched: rows.filter((r) => c.member_ids.has(r.memory_id)),
    }))
    .filter((c) => c.matched.length >= minMembers)
    .sort(
      (a, b) =>
        b.matched.length - a.matched.length ||
        a.community.community_key.localeCompare(b.community.community_key)
    );

  const hubs = new Map<string, GraphRecallUnit>();
  for (const cand of candidates) {
    // Only rows no earlier (better-matched) hub already took.
    const members = cand.matched.filter((r) => !claimed.has(r.memory_id));
    if (members.length < minMembers) continue;

    const best = members.reduce((a, b) => (b.final_score > a.final_score ? b : a));
    const summary = cand.community.summary;
    const summaryRow = byId.get(summary.id);

    for (const m of members) claimed.set(m.memory_id, cand.community);
    // A summary that surfaced in the walk on its own merit is the SAME unit —
    // claim it too so it can't also appear as a raw row below its own hub.
    if (summaryRow) claimed.set(summaryRow.memory_id, cand.community);

    hubs.set(cand.community.community_key, {
      kind: 'hub',
      memory_id: summary.id,
      content: summary.content,
      project: summary.project,
      source_type: 'consolidation_summary',
      metadata: summary.metadata ?? null,
      privacy_tags: summary.privacy_tags ?? null,
      created_at: summary.created_at ?? null,
      // Synthetic unit: it inherits its best member's position in the ranking
      // and that member's component scores, so a hub never outranks a stronger
      // ordinary hit and never sinks below a weaker one.
      depth: Math.min(...members.map((m) => m.depth)),
      vector_score: best.vector_score,
      edge_weight: best.edge_weight,
      recency_score: best.recency_score,
      final_score: Math.max(best.final_score, summaryRow?.final_score ?? 0),
      path: best.path,
      seed_kind: best.seed_kind ?? null,
      edge_path: best.edge_path ?? null,
      community_key: cand.community.community_key,
      member_count: cand.community.member_count,
      matched_count: members.length,
      citations: members
        .slice()
        .sort((a, b) => b.final_score - a.final_score)
        .map((m) => ({
          memory_id: m.memory_id,
          gist: gistOf(m.content),
          depth: m.depth,
          final_score: m.final_score,
        })),
    });
  }

  if (hubs.size === 0) return { units: asUnits(), hub_count: 0 };

  const emitted = new Set<string>();
  const units: GraphRecallUnit[] = [];
  for (const row of rows) {
    const community = claimed.get(row.memory_id);
    if (!community) {
      units.push({ ...row, kind: 'memory' });
      continue;
    }
    if (emitted.has(community.community_key)) continue;
    emitted.add(community.community_key);
    units.push(hubs.get(community.community_key)!);
  }
  return { units, hub_count: hubs.size };
}

/**
 * Render the tier-0 pinned block. Rendered FIRST and separately from results;
 * tier-0 lines deliberately carry NO `[n]` citation handle, because those
 * handles must stay 1:1 with `memory_recall_log.rank` (see src/recall.ts:253)
 * and tier-0 items are injected context, not retrieval hits — they are never
 * logged, so numbering them would desync every citation after them.
 */
export function renderTier0(tier0: Tier0Item[]): string {
  if (tier0.length === 0) return '';
  const lines = tier0.map((t) => `[T0] ${truncate(t.content, MAX_CONTENT_LENGTH)}`);
  return `${tier0.length} pinned objective${tier0.length === 1 ? '' : 's'} (tier 0):\n\n${lines.join('\n')}\n\n`;
}

export async function memoryRecallGraph(
  input: GraphRecallInput,
  deps: RecallDeps = {}
): Promise<GraphRecallOutput> {
  const query = input.query.trim();
  const empty = (text: string, walk = { rpc: LEGACY_GRAPH_RPC, boosted: false }): GraphRecallOutput => ({
    tier0: [],
    results: [],
    hits: [],
    depth_distribution: {},
    hub_count: 0,
    walk,
    text,
  });
  if (!query) return empty('No relevant memories found.');

  const project = input.project ?? null;
  const supabase = (deps.client ?? getSupabase()) as any;
  const embed = deps.generateEmbedding ?? generateEmbedding;
  const embedding = await embed(query);

  const walk = await callWalk(supabase, input, embedding);
  if (walk.error) {
    console.error(`[mnestra-recall-graph] ${walk.rpc} failed:`, walk.error);
    return empty(`Search error: ${walk.error}`, { rpc: walk.rpc, boosted: walk.boosted });
  }

  // §Seam 1 — tier-0 is fetched independently of the walk and survives an
  // empty result: a pinned objective is context to inject, not a hit to find.
  const tier0 = await resolveTier0(input, deps);

  let rows = walk.rows;
  if (rows.length === 0) {
    return {
      ...empty('No relevant memories found.', { rpc: walk.rpc, boosted: walk.boosted }),
      tier0,
      text: `${renderTier0(tier0)}No relevant memories found.`,
    };
  }

  const sourceAgents =
    Array.isArray(input.source_agents) && input.source_agents.length > 0
      ? input.source_agents
      : null;
  const includePrivacy =
    Array.isArray(input.include_privacy) && input.include_privacy.length > 0
      ? input.include_privacy
      : null;

  const hydrated = await hydrateRows(supabase, rows, {
    // The legacy walk returns none of the gate columns; the boosted one
    // returns all of them (037 return table).
    needsColumns: !walk.boosted,
    needsAgent: sourceAgents !== null,
  });
  if (hydrated.error) {
    console.error('[mnestra-recall-graph] row hydrate failed:', hydrated.error);
    return empty(`Search error: ${hydrated.error}`, { rpc: walk.rpc, boosted: walk.boosted });
  }
  rows = applyRowGates(hydrated.rows, {
    sourceAgents,
    includeNullSource: input.include_null_source === true,
    includePrivacy,
    agents: hydrated.agents,
  });
  if (rows.length === 0) {
    return {
      ...empty('No relevant memories found.', { rpc: walk.rpc, boosted: walk.boosted }),
      tier0,
      text: `${renderTier0(tier0)}No relevant memories found.`,
    };
  }

  const depth_distribution: Record<number, number> = {};
  for (const row of rows) {
    depth_distribution[row.depth] = (depth_distribution[row.depth] ?? 0) + 1;
  }

  const minMembers = input.hub_min_members ?? DEFAULT_HUB_MIN_MEMBERS;
  const communities =
    minMembers > 0 && rows.length >= minMembers ? await fetchCommunities(supabase, project) : [];
  // A summary the caller isn't cleared to see cannot stand in for its members.
  const visibleCommunities = applyRowGates(
    communities.map((c) => ({ ...c, memory_id: c.summary.id, privacy_tags: c.summary.privacy_tags })),
    {
      sourceAgents: null, // a hub's provenance is the job's, not a member agent's
      includeNullSource: true,
      includePrivacy,
      agents: new Map(),
    }
  );
  let { units, hub_count } = collapseHubs(rows, visibleCommunities, minMembers);

  // A-T3 wiring point (staleness downrank). Applied AFTER collapse so a hub is
  // ranked as one unit, and NEVER to tier0 — §Seam 1 pins that block.
  if (deps.applyStaleness) {
    try {
      units = deps.applyStaleness(units);
    } catch (err) {
      console.error('[mnestra-recall-graph] staleness hook failed (ignored):', (err as Error).message);
    }
  }

  const lines = units.slice(0, 20).map((m) => {
    const tag = project ? '' : ` [${m.project}]`;
    const score = m.final_score.toFixed(3);
    if (m.kind === 'hub') {
      const head = `- (hub ${score})${tag} ${truncate(m.content, MAX_CONTENT_LENGTH)}`;
      const cites = (m.citations ?? [])
        .map((c) => `      · ${c.memory_id.slice(0, 8)} — ${c.gist}`)
        .join('\n');
      return `${head}\n    ↳ ${m.matched_count} of ${m.member_count} community members collapsed:\n${cites}`;
    }
    const depthLabel = m.depth === 0 ? 'vec' : `d${m.depth}`;
    return `- (${depthLabel} ${score})${tag} ${truncate(m.content, MAX_CONTENT_LENGTH)}`;
  });

  const distSummary = Object.entries(depth_distribution)
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([d, n]) => `d${d}=${n}`)
    .join(', ');

  // Header parity: with no hub and no tier-0 this is character-for-character
  // the pre-Sprint-70 header, because units.length === rows.length then.
  const header = `${units.length} memories (graph-recall, ${distSummary}${
    project ? `, project: ${project}` : ', all projects'
  }${hub_count > 0 ? `, ${hub_count} hub${hub_count === 1 ? '' : 's'}` : ''}):`;

  // Sprint 78 T3 — fire-and-forget graph-surface telemetry. Logs the RETURNED
  // units (a hub logs as its summary row, which is what the caller was shown).
  // Suppressed when memoryRecall is driving: that path logs once, as 'recall'.
  if (input.log !== false) {
    logRecallHits(
      units.map((m, i) => ({
        memory_id: m.memory_id,
        score: m.final_score,
        rank: i + 1,
        source_type: m.source_type ?? null,
      })),
      { surface: 'graph', query }
    );
  }

  return {
    tier0,
    results: units,
    hits: rows,
    depth_distribution,
    hub_count,
    walk: { rpc: walk.rpc, boosted: walk.boosted },
    text: `${renderTier0(tier0)}${header}\n\n${lines.join('\n')}`,
  };
}

/**
 * Sprint 70/71 cross-deck integration — `MNESTRA_TIER0_INJECT`, default OFF.
 *
 * B-T1 shipped `tier0FetcherForRecall()` and handed the wiring back to this
 * lane ("recall.ts belongs to whoever owns that call path"), which is correct.
 * It is wired here as a DARK DEFAULT rather than a live one, for the same
 * reason `MNESTRA_GRAPH_RECALL` is dark: flipping it changes what every
 * existing `memoryRecall` call returns, and migration 038 is authored but not
 * yet applied to any store. OFF costs exactly zero — no import-time work, no
 * round-trip, no log line — so the default path stays byte-identical and the
 * seam is nonetheless demonstrably end-to-end rather than a stub nobody has
 * ever run. ORCH flips this after 038 is applied.
 */
export function tier0InjectEnabled(): boolean {
  return envFlag('MNESTRA_TIER0_INJECT');
}

/**
 * §Seam 1 resolution order: an explicitly injected `fetchTier0` ALWAYS wins
 * (tests, and any caller with its own objective source), then the env-gated
 * default, then empty.
 *
 * Failure is swallowed on purpose, and twice over — B-T1's `fetchTier0Block`
 * is fail-soft on its own side and this catch covers anything it re-throws or
 * any third-party fetcher that isn't. An agent with no objectives is the
 * pre-Sprint-71 status quo; an agent with no recall is a broken session.
 */
export async function resolveTier0(
  input: { query: string; project?: string | null },
  deps: RecallDeps
): Promise<Tier0Item[]> {
  const fetch =
    deps.fetchTier0 ??
    (tier0InjectEnabled()
      ? tier0FetcherForRecall(deps.client ? { client: deps.client } : {})
      : null);
  if (!fetch) return [];
  try {
    const items = await fetch({ query: input.query, project: input.project ?? null });
    return Array.isArray(items) ? items : [];
  } catch (err) {
    console.error('[mnestra-recall-graph] tier0 fetch failed (ignored):', (err as Error).message);
    return [];
  }
}

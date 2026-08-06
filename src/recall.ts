/**
 * Mnestra — memory_recall
 *
 * Smart retrieval. Calls the memory_hybrid_search SQL function (which
 * already applies Fix 1 tiered decay, Fix 3 source_type weighting, and
 * Fix 5 project affinity), then applies:
 *
 *   Fix 2: always return at least min_results (default 5) results if that
 *   many exist, regardless of score threshold. Token budget trimming
 *   happens AFTER the minimum-result guarantee.
 */

import { randomUUID } from 'node:crypto';

import type { SupabaseClient } from '@supabase/supabase-js';

import { getSupabase } from './db.js';
import { generateEmbedding, formatEmbedding } from './embeddings.js';
import { classifyGranularity } from './granularity.js';
import { logRecallHits } from './recall_log.js';
import { withCalibratedScore } from './calibration.js';
import {
  memoryRecallGraph,
  renderTier0,
  resolveTier0,
  type GraphRecallUnit,
} from './recall_graph.js';
import type { RecallHit, RecallInput } from './types.js';

/**
 * §Seam 1 (Sprint 70, dual-deck) — one pinned tier-0 item.
 *
 * Objectives are INJECTED, not retrieved: a tier-0 item is not a search hit
 * that happened to score well, it is context the caller must see regardless of
 * what the query was. Deck A reserves the shape and emits `[]`; Deck B (B-T1)
 * supplies `RecallDeps.fetchTier0` and the block fills with no change here.
 */
export interface Tier0Item {
  memory_id: string;
  content: string;
  project?: string | null;
  source_type?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface RecallDeps {
  /** Override the Supabase client (tests inject a fake). */
  client?: SupabaseClient;
  /** Override the embedding generator (tests bypass the OpenAI call). */
  generateEmbedding?: (text: string) => Promise<number[]>;
  /**
   * §Seam 1 wiring point. Absent (Deck A, this sprint) → `tier0: []` and not a
   * single extra round-trip. Present (B-T1) → the pinned block renders FIRST,
   * ahead of every retrieved result, on BOTH the default and graph paths.
   */
  fetchTier0?: (input: { query: string; project: string | null }) => Promise<Tier0Item[]>;
  /**
   * A-T3 wiring point — structural-staleness downrank over the graph path's
   * primary units. Pure function, applied after hub collapse and never to
   * tier0. A throw here is logged and ignored: staleness ranks results, it
   * does not get to fail them.
   */
  applyStaleness?: (units: GraphRecallUnit[]) => GraphRecallUnit[];
}

/**
 * Sprint 70 A-T2 — `MNESTRA_GRAPH_RECALL`. OFF (the default, and anything that
 * isn't an explicit truthy value) routes `memory_recall` through
 * memory_hybrid_search exactly as before — same RPC, same args, same text,
 * same telemetry. ON routes it through the graph walk + hub collapse.
 *
 * Read per CALL, not at module load: a env-var read costs nothing next to an
 * embedding round-trip, and a load-time constant would make the flag
 * untestable in-process and un-flippable without a restart.
 */
export function graphRecallEnabled(): boolean {
  const raw = (process.env.MNESTRA_GRAPH_RECALL ?? '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'on' || raw === 'yes';
}

const DEFAULT_TOKEN_BUDGET = 2000;
const DEFAULT_MIN_RESULTS = 5;
const MAX_CONTENT_LENGTH = 300;

const IMPORTANCE_RANK: Record<string, number> = {
  critical: 3,
  important: 2,
  minor: 1,
};

const TYPE_RANK: Record<string, number> = {
  decision: 5,
  bug_fix: 4,
  preference: 4,
  architecture: 3,
  fact: 3,
  code_context: 2,
  session_summary: 1,
  document_chunk: 0,
};

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function truncate(content: string, maxLen: number): string {
  if (content.length <= maxLen) return content;
  return content.slice(0, maxLen).trimEnd() + '...';
}

function dedupByContent<T extends { content: string }>(results: T[]): T[] {
  const seen: string[] = [];
  return results.filter((m) => {
    const normalized = m.content.toLowerCase().replace(/\s+/g, ' ').slice(0, 100);
    for (const prev of seen) {
      const words = new Set(normalized.split(' '));
      const prevWords = prev.split(' ');
      const overlap = prevWords.filter((w) => words.has(w)).length;
      if (overlap / Math.max(words.size, prevWords.length) > 0.7) return false;
    }
    seen.push(normalized);
    return true;
  });
}

function smartRank(results: RecallHit[]): RecallHit[] {
  return [...results].sort((a, b) => {
    const typeDiff = (TYPE_RANK[b.source_type] ?? 1) - (TYPE_RANK[a.source_type] ?? 1);
    if (typeDiff !== 0) return typeDiff;

    const impA = IMPORTANCE_RANK[(a.metadata as { importance?: string })?.importance ?? ''] ?? 1;
    const impB = IMPORTANCE_RANK[(b.metadata as { importance?: string })?.importance ?? ''] ?? 1;
    if (impB !== impA) return impB - impA;

    // Sprint 79 T1 (capture gates): granularity tiebreak. A recipe-graded hit
    // (specific-instance: file:line/sprint/version noise, no kitchen marker)
    // sorts below an otherwise-tied kitchen/unknown hit — 'unknown' is never
    // downweighted, only a confident 'recipe' verdict is. This is the sole
    // consumer that makes granularity.ts's classifier real; it only breaks
    // ties already established above, never overrides type/importance rank.
    const recipeA = classifyGranularity(a.content).granularity === 'recipe';
    const recipeB = classifyGranularity(b.content).granularity === 'recipe';
    if (recipeA !== recipeB) return recipeA ? 1 : -1;

    return (b.score || 0) - (a.score || 0);
  });
}

export interface RecallOutput {
  hits: RecallHit[];
  tokens_used: number;
  text: string;
  /**
   * Sprint 83 T2 (label producer): the id of THIS reinjection event — the same
   * uuid stamped on all K of this call's `memory_recall_log` rows (migration
   * 031). Hand it back to `memory_cite` to turn "I used hit 3" into a positive
   * label on exactly the right row.
   *
   * `null` only on the empty-result early returns (nothing was logged, so
   * there is no group to cite).
   */
  recall_group_id: string | null;
  /**
   * §Seam 1 — the pinned tier-0 block, ALWAYS present and ALWAYS first in
   * `text`. `[]` this sprint on both paths. It lives on the DEFAULT recall
   * envelope (not just the graph one) on purpose: `MNESTRA_GRAPH_RECALL` ships
   * OFF, so a tier0 that only existed on the graph path would be a seam B-T1
   * could never reach.
   */
  tier0: Tier0Item[];
  /**
   * Present only when the graph path ran: the hub-collapsed primary units, so
   * a programmatic caller can see which results are compiled hubs and expand
   * their member citations. Undefined on the default path.
   */
  graph_units?: GraphRecallUnit[];
}

export async function memoryRecall(
  input: RecallInput,
  deps: RecallDeps = {}
): Promise<RecallOutput> {
  const query = input.query.trim();
  if (!query) {
    return {
      hits: [],
      tokens_used: 0,
      text: 'No relevant memories found.',
      recall_group_id: null,
      tier0: [],
    };
  }

  if (graphRecallEnabled()) return recallViaGraph(input, deps);

  // §Seam 1. With no fetchTier0 wired this is a synchronous `[]` — no client
  // call, no awaitable work, so the OFF path stays byte-identical below.
  const tier0 = await resolveTier0({ query, project: input.project ?? null }, deps);
  const pinned = renderTier0(tier0);

  const budget = input.token_budget ?? DEFAULT_TOKEN_BUDGET;
  const minResults = input.min_results ?? DEFAULT_MIN_RESULTS;
  const project = input.project ?? null;
  // Sprint 50 T2: empty array == omitted (no filter). Match the
  // recall-source-agent.test.ts expectation that an explicitly-passed
  // `source_agents: []` is a no-op rather than a "match nothing" filter —
  // empty-string defaults from MCP clients shouldn't accidentally suppress
  // every row.
  const sourceAgents =
    Array.isArray(input.source_agents) && input.source_agents.length > 0
      ? input.source_agents
      : null;
  const includeNullSource = input.include_null_source === true;
  // Privacy-tags PR (Deck B) — opt-in list of privacy categories to surface.
  // Same empty-array-==-omitted convention as source_agents above: an explicit
  // `include_privacy: []` is "no opt-in" (a no-op), not "match nothing", so MCP
  // clients that default the field to [] don't suppress tagged rows differently
  // than omitting it would. null here means "no opt-in" → default-exclude.
  const includePrivacy =
    Array.isArray(input.include_privacy) && input.include_privacy.length > 0
      ? input.include_privacy
      : null;

  // Over-fetch so dedup + rank have material to work with.
  const fetchCount = Math.min(Math.max(Math.floor(budget / 50), 10), 40);

  const supabase = deps.client ?? getSupabase();
  const embed = deps.generateEmbedding ?? generateEmbedding;
  const embedding = await embed(query);

  const { data, error } = await supabase.rpc('memory_hybrid_search', {
    query_text: query,
    query_embedding: formatEmbedding(embedding),
    match_count: fetchCount,
    full_text_weight: 1.0,
    semantic_weight: 1.0,
    rrf_k: 60,
    filter_project: project,
    filter_source_type: null,
  });

  if (error) {
    console.error('[mnestra-search] memory_hybrid_search failed:', error.message);
    return {
      hits: [],
      tokens_used: 0,
      text: `Search error: ${error.message}`,
      recall_group_id: null,
      tier0,
    };
  }

  let rows = (data ?? []) as RecallHit[];
  if (rows.length === 0) {
    return {
      hits: [],
      tokens_used: 0,
      text: `${pinned}No relevant memories found.`,
      recall_group_id: null,
      tier0,
    };
  }

  // Sprint 50 T2 — source_agent filter. memory_hybrid_search doesn't return
  // source_agent (would require a DROP+CREATE on the hot RPC; intentionally
  // out of scope for migration 015). Instead, fetch the column for the
  // candidate rows in a single batch and filter in JS. Zero overhead when
  // the filter is omitted (the common case).
  if (sourceAgents) {
    const ids = rows.map((r) => r.id);
    const { data: agentRows, error: agentErr } = await supabase
      .from('memory_items')
      .select('id, source_agent')
      .in('id', ids);
    if (agentErr) {
      console.error(
        '[mnestra-search] source_agent lookup failed:',
        agentErr.message
      );
      return {
        hits: [],
        tokens_used: 0,
        text: `Search error: ${agentErr.message}`,
        recall_group_id: null,
        tier0,
      };
    }
    const agentMap = new Map<string, string | null>(
      ((agentRows ?? []) as { id: string; source_agent: string | null }[]).map(
        (r) => [r.id, r.source_agent]
      )
    );
    rows = rows.filter((r) => {
      const agent = agentMap.get(r.id);
      // NULL source_agent means historical / unknown provenance. Default
      // behavior is to exclude on explicit filter (Sprint 50 contract);
      // include_null_source=true (Sprint 62 T3) opts NULL rows back in
      // for callers that want the residual slice migration 022
      // deliberately left NULL.
      if (!agent) return includeNullSource;
      return sourceAgents.includes(agent);
    });
    if (rows.length === 0) {
      return {
      hits: [],
      tokens_used: 0,
      text: `${pinned}No relevant memories found.`,
      recall_group_id: null,
      tier0,
    };
    }
  }

  // Privacy-tags PR (Deck B) — privacy_tags filter. Unlike source_agent,
  // migration 023 extends memory_hybrid_search's RETURNS TABLE so each row
  // already carries privacy_tags — no separate batch fetch, no extra Supabase
  // round-trip. Read it as (row.privacy_tags ?? []) so unmigrated / not-yet-
  // applied rows degrade to "untagged" rather than throw. Default behavior
  // EXCLUDES any row carrying a privacy tag; an explicit include_privacy opt-in
  // surfaces rows that share >=1 tag (any-overlap). Untagged rows (the common
  // case) always pass — when include_privacy is omitted this is a bare
  // length check, no set/intersection work. Applied AFTER the source_agent /
  // null-source filters, consistent with the existing pipeline order.
  rows = rows.filter((r) => {
    const tags = r.privacy_tags ?? [];
    if (tags.length === 0) return true; // untagged: always visible
    if (!includePrivacy) return false; // default: hide tagged rows
    return tags.some((t) => includePrivacy.includes(t)); // any-overlap opt-in
  });
  if (rows.length === 0) {
    return {
      hits: [],
      tokens_used: 0,
      text: `${pinned}No relevant memories found.`,
      recall_group_id: null,
      tier0,
    };
  }

  // Pipeline: dedup -> rank. Do NOT drop anything on a score threshold here.
  // The SQL function already applies tiered decay + source_type weighting +
  // project affinity; we trust its ordering as a floor.
  const deduped = dedupByContent(rows);
  const ranked = smartRank(deduped);

  // Fix 2: honour min_results first. Build the minimum slice ignoring
  // token budget, then keep adding more hits until the budget is exhausted.
  const lines: string[] = [];
  const kept: RecallHit[] = [];
  let tokensUsed = 0;

  for (let i = 0; i < ranked.length; i++) {
    const m = ranked[i]!;
    const content = truncate(m.content, MAX_CONTENT_LENGTH);
    const projectTag = project ? '' : ` [${m.project}]`;
    const imp = (m.metadata as { importance?: string })?.importance;
    const impTag = imp ? `/${imp}` : '';
    // Sprint 83 T2: the `[n]` prefix is the CITATION HANDLE. It is the same
    // 1-based value written to memory_recall_log.rank below, so an agent
    // saying "I used [3]" resolves to exactly one log row. Four characters a
    // line, versus 36 for a bare uuid — on a surface whose entire design
    // constraint is a token budget, ordinals are the only affordable handle.
    // `kept.length + 1`, not `i + 1`: the two are equal today (the loop breaks
    // rather than skipping), but the handle MUST track the position in `kept`
    // — that is what logRecallHits stamps as `rank`. Deriving it from the
    // candidate index would silently desync the moment anyone turns that
    // `break` into a `continue`, and the failure would be invisible: every
    // citation would land on the wrong memory.
    const line = `[${kept.length + 1}] (${m.source_type}${impTag})${projectTag} ${content}`;
    const lineTokens = estimateTokens(line);

    const underMinimum = kept.length < minResults;
    const fitsBudget = tokensUsed + lineTokens <= budget;

    if (underMinimum || fitsBudget) {
      lines.push(line);
      kept.push(m);
      tokensUsed += lineTokens;
    } else {
      break;
    }
  }

  // Sprint 83 T2 — mint the reinjection-event id HERE, not inside the
  // fire-and-forget logger, so it can be both stamped on the log rows AND
  // handed to the agent. Those two must be the same value or a citation has
  // nothing to key on.
  const recallGroupId = randomUUID();

  const header = `${kept.length} memories (${tokensUsed} tokens${
    project ? `, project: ${project}` : ', all projects'
  }):`;

  // The cite prompt. This is the label producer's entire user-facing surface:
  // without it the agent has no reason to know memory_cite exists, and the
  // telemetry keeps accumulating rows nobody ever labels. Deliberately last —
  // it is the instruction the model reads immediately before it acts — and
  // deliberately conditioned on "actually used", because citing everything
  // returned would manufacture false positives at exactly the point where a
  // calibration fit is most damaged by them.
  //
  // Suppressed on an empty result for the same reason memoryIndex suppresses
  // its id when logging is off: logRecallHits writes nothing for zero hits, so
  // advertising a group id here would offer a citable group that does not
  // exist, and memory_cite could not distinguish "you cited nothing" from "that
  // id was fiction". Reachable with min_results: 0 and a first hit over budget.
  const citeHint =
    kept.length === 0
      ? ''
      : `\n\nUsed any of these? Call memory_cite(recall_group_id="${recallGroupId}", ` +
        `ranks=[…]) with the [n] of the ones that actually informed your work — not all of them.`;

  // Sprint 78 T3 — fire-and-forget recall telemetry. Log the RETURNED SET
  // ONLY (`kept`, after dedup/rank/token-budget — NOT the 10–40 over-fetched
  // candidate rows from memory_hybrid_search). Never awaited, so recall
  // latency is byte-for-byte unchanged; failures are swallowed inside
  // logRecallHits. `log_surface` is 'webhook' when the call arrived over the
  // wire, else the native 'recall'.
  logRecallHits(
    kept.map((m, i) => ({
      memory_id: m.id,
      score: m.score,
      rank: i + 1,
      source_type: m.source_type,
    })),
    {
      surface: input.log_surface ?? 'recall',
      query,
      sourceSessionId: input.log_session_id ?? null,
      sourceAgent: input.log_source_agent ?? null,
      // Sprint 81: the per-call token budget — same on every hit row of this
      // recall's recall_group_id (see recall_log.ts).
      tokenBudget: budget,
      // Sprint 83 T2: the id the agent was just handed, so memory_cite's
      // group lookup finds these exact rows.
      recallGroupId,
    }
  );

  return {
    // `recall_group_id` also rides on every hit for programmatic callers (the
    // webhook, TermDeck's bridge) that consume `hits` and never parse `text`.
    hits: withCalibratedScore(kept, input.log_surface ?? 'recall').map((h) => ({
      ...h,
      recall_group_id: recallGroupId,
    })),
    tokens_used: tokensUsed,
    // The hint is NOT counted in tokens_used: that field means "tokens of
    // recalled memory content" and every existing caller reads it that way.
    // The header has always sat outside it for the same reason.
    text: `${pinned}${header}\n\n${lines.join('\n')}${citeHint}`,
    recall_group_id: recallGroupId,
    tier0,
  };
}

/**
 * `MNESTRA_GRAPH_RECALL=on` — memory_recall answered by the graph walk.
 *
 * The graph engine owns RETRIEVAL and RANKING (walk, gates, hub collapse,
 * staleness); this function owns PRESENTATION, and it reproduces the default
 * path's contract exactly: `[n]` citation handles, min_results-before-budget,
 * one telemetry write per call, one recall_group_id handed to the agent.
 *
 * The render loop below is a deliberate near-duplicate of the one above rather
 * than a shared helper. A hub renders as a block (headline + member citation
 * lines) and must be budgeted as a block, which the flat loop cannot express —
 * and the flat loop is the byte-identical OFF path, the one thing this sprint
 * is not allowed to perturb. Duplication here is cheaper than a regression
 * there.
 */
async function recallViaGraph(input: RecallInput, deps: RecallDeps): Promise<RecallOutput> {
  const query = input.query.trim();
  const budget = input.token_budget ?? DEFAULT_TOKEN_BUDGET;
  const minResults = input.min_results ?? DEFAULT_MIN_RESULTS;
  const project = input.project ?? null;

  const graph = await memoryRecallGraph(
    {
      query,
      project,
      // Seed count tracks the same over-fetch heuristic the default path uses,
      // so a budget change moves both surfaces the same way.
      k: Math.min(Math.max(Math.floor(budget / 100), 5), 25),
      source_agents: input.source_agents ?? null,
      include_null_source: input.include_null_source === true,
      include_privacy: input.include_privacy ?? null,
      // One log per recall, written below as the caller's surface — not twice,
      // once as 'graph' and once as 'recall'.
      log: false,
    },
    deps
  );

  const pinned = renderTier0(graph.tier0);
  if (graph.results.length === 0) {
    return {
      hits: [],
      tokens_used: 0,
      text: `${pinned}${graph.text.startsWith('Search error:') ? graph.text : 'No relevant memories found.'}`,
      recall_group_id: null,
      tier0: graph.tier0,
      graph_units: [],
    };
  }

  const lines: string[] = [];
  const kept: GraphRecallUnit[] = [];
  let tokensUsed = 0;

  for (const unit of graph.results) {
    const projectTag = project ? '' : ` [${unit.project}]`;
    const handle = kept.length + 1;
    let block: string;
    if (unit.kind === 'hub') {
      const cites = (unit.citations ?? [])
        .map((c) => `      · ${c.memory_id.slice(0, 8)} — ${c.gist}`)
        .join('\n');
      block =
        `[${handle}] (hub: ${unit.matched_count} of ${unit.member_count} members)${projectTag} ` +
        `${truncate(unit.content, MAX_CONTENT_LENGTH)}\n    ↳ collapsed members (expand by id):\n${cites}`;
    } else {
      const depthLabel = unit.depth === 0 ? 'vec' : `d${unit.depth}`;
      block = `[${handle}] (${unit.source_type ?? 'memory'} ${depthLabel})${projectTag} ${truncate(
        unit.content,
        MAX_CONTENT_LENGTH
      )}`;
    }

    const blockTokens = estimateTokens(block);
    const underMinimum = kept.length < minResults;
    const fitsBudget = tokensUsed + blockTokens <= budget;
    if (underMinimum || fitsBudget) {
      lines.push(block);
      kept.push(unit);
      tokensUsed += blockTokens;
    } else {
      break;
    }
  }

  const recallGroupId = randomUUID();
  const hubCount = kept.filter((u) => u.kind === 'hub').length;
  const header = `${kept.length} memories (graph-recall, ${tokensUsed} tokens${
    project ? `, project: ${project}` : ', all projects'
  }${hubCount > 0 ? `, ${hubCount} hub${hubCount === 1 ? '' : 's'}` : ''}):`;
  const citeHint =
    kept.length === 0
      ? ''
      : `\n\nUsed any of these? Call memory_cite(recall_group_id="${recallGroupId}", ` +
        `ranks=[…]) with the [n] of the ones that actually informed your work — not all of them.`;

  logRecallHits(
    kept.map((u, i) => ({
      memory_id: u.memory_id,
      score: u.final_score,
      rank: i + 1,
      source_type: u.source_type ?? null,
    })),
    {
      surface: input.log_surface ?? 'recall',
      query,
      sourceSessionId: input.log_session_id ?? null,
      sourceAgent: input.log_source_agent ?? null,
      tokenBudget: budget,
      recallGroupId,
    }
  );

  // `hits` keeps the RecallHit shape every existing programmatic caller reads.
  // A hub arrives as its consolidation_summary row; its member citations stay
  // on `graph_units`, which is the only place they exist un-flattened.
  const hits: RecallHit[] = kept.map((u) => ({
    id: u.memory_id,
    content: u.content,
    // The store's source_type CHECK carries values the TS union doesn't yet
    // (034 added 'consolidation_summary'); widening SourceType is a types.ts
    // change, out of this lane. Cast, don't lie about the value.
    source_type: (u.source_type ?? 'fact') as RecallHit['source_type'],
    category: null,
    project: u.project,
    score: u.final_score,
    metadata: (u.metadata ?? {}) as Record<string, unknown>,
    created_at: u.created_at ?? '',
    privacy_tags: u.privacy_tags ?? null,
    recall_group_id: recallGroupId,
  }));

  return {
    hits,
    tokens_used: tokensUsed,
    text: `${pinned}${header}\n\n${lines.join('\n')}${citeHint}`,
    recall_group_id: recallGroupId,
    tier0: graph.tier0,
    graph_units: kept,
  };
}

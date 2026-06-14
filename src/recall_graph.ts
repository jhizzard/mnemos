/**
 * Mnestra — memory_recall_graph (Sprint 38 / T3)
 *
 * Graph-aware recall. Calls the memory_recall_graph SQL function (migration
 * 010), which:
 *
 *   1. Vector recall via match_memories — top-K nearest neighbors.
 *   2. Graph expansion via expand_memory_neighborhood — walks
 *      memory_relationships to depth N from each top-K seed.
 *   3. Re-ranks the union by  vector_score × edge_weight × recency_score.
 *
 * The shape returned to callers mirrors `memoryRecall` so the MCP tool
 * surface is interchangeable: same `RecallHit`-ish shape plus per-row
 * `depth` and `final_score` so callers can tell vector hits from
 * graph-expanded neighbors.
 */

import { getSupabase } from './db.js';
import { generateEmbedding, formatEmbedding } from './embeddings.js';
import { logRecallHits } from './recall_log.js';
import type { RecallDeps } from './recall.js';

const DEFAULT_DEPTH = 2;
const DEFAULT_K = 10;
const MAX_CONTENT_LENGTH = 300;

export interface GraphRecallInput {
  query: string;
  project?: string | null;
  depth?: number;
  k?: number;
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
}

export interface GraphRecallOutput {
  hits: GraphRecallHit[];
  depth_distribution: Record<number, number>;
  text: string;
}

function truncate(content: string, maxLen: number): string {
  if (content.length <= maxLen) return content;
  return content.slice(0, maxLen).trimEnd() + '...';
}

export async function memoryRecallGraph(
  input: GraphRecallInput,
  deps: RecallDeps = {}
): Promise<GraphRecallOutput> {
  const query = input.query.trim();
  if (!query) {
    return {
      hits: [],
      depth_distribution: {},
      text: 'No relevant memories found.',
    };
  }

  const depth = input.depth ?? DEFAULT_DEPTH;
  const k = input.k ?? DEFAULT_K;
  const project = input.project ?? null;

  const supabase = deps.client ?? getSupabase();
  const embed = deps.generateEmbedding ?? generateEmbedding;
  const embedding = await embed(query);

  const { data, error } = await supabase.rpc('memory_recall_graph', {
    query_embedding: formatEmbedding(embedding),
    project_filter: project,
    max_depth: depth,
    k,
  });

  if (error) {
    console.error('[mnestra-recall-graph] memory_recall_graph failed:', error.message);
    return {
      hits: [],
      depth_distribution: {},
      text: `Search error: ${error.message}`,
    };
  }

  const rows = (data ?? []) as GraphRecallHit[];
  if (rows.length === 0) {
    return {
      hits: [],
      depth_distribution: {},
      text: 'No relevant memories found.',
    };
  }

  const depth_distribution: Record<number, number> = {};
  for (const row of rows) {
    depth_distribution[row.depth] = (depth_distribution[row.depth] ?? 0) + 1;
  }

  const lines = rows.slice(0, 20).map((m) => {
    const tag = project ? '' : ` [${m.project}]`;
    const depthLabel = m.depth === 0 ? 'vec' : `d${m.depth}`;
    const score = m.final_score.toFixed(3);
    return `- (${depthLabel} ${score})${tag} ${truncate(m.content, MAX_CONTENT_LENGTH)}`;
  });

  const distSummary = Object.entries(depth_distribution)
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([d, n]) => `d${d}=${n}`)
    .join(', ');

  const header = `${rows.length} memories (graph-recall, ${distSummary}${
    project ? `, project: ${project}` : ', all projects'
  }):`;

  // Sprint 78 T3 — fire-and-forget graph-surface telemetry. The full returned
  // set (graph hits use `memory_id` + `final_score`). Never awaited.
  logRecallHits(
    rows.map((m, i) => ({ memory_id: m.memory_id, score: m.final_score, rank: i + 1 })),
    { surface: 'graph', query }
  );

  return {
    hits: rows,
    depth_distribution,
    text: `${header}\n\n${lines.join('\n')}`,
  };
}

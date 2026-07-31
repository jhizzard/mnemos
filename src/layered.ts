/**
 * Mnestra — three-layer progressive disclosure search
 *
 *   memory_index    → compact { id, snippet, source_type, project, created_at }
 *                     results, 80–120 tokens per hit. Drill-down friendly.
 *   memory_timeline → chronologically surrounding memories in the same project,
 *                     centered on either a query hit or a specific observation ID.
 *   memory_get      → batch fetch of full memory_items rows by UUID.
 *
 * Shape parity:
 *   - index + timeline return the same compact row type (IndexHit).
 *   - get returns the full MemoryItem (same shape as GET /observation/:id).
 */

import { getSupabase } from './db.js';
import { generateEmbedding, formatEmbedding } from './embeddings.js';
import { logRecallHits, markRecallCited } from './recall_log.js';
import type { RecallDeps } from './recall.js';
import type { MemoryItem, RecallHit, RecallSurface, SourceType } from './types.js';

const SNIPPET_MAX = 120;
const INDEX_DEFAULT_LIMIT = 20;
const TIMELINE_DEFAULT_RADIUS = 10;
const GET_MAX_BATCH = 100;

export type TimelineWindow = '1h' | '24h' | '7d';

const WINDOW_SECONDS: Record<TimelineWindow, number> = {
  '1h': 3600,
  '24h': 86_400,
  '7d': 7 * 86_400,
};

export interface IndexHit {
  id: string;
  snippet: string;
  source_type: SourceType;
  project: string;
  created_at: string;
  /**
   * Sprint 82 T1 (migration 033): raw cosine similarity to the query embedding.
   * See RecallHit.semantic_similarity — this is the cardinal signal, unlike the
   * ordinal RRF `score` (which the index projection deliberately still omits).
   * `undefined` against a database where 033 has not been applied.
   */
  semantic_similarity?: number | null;
}

export interface IndexInput {
  query: string;
  project?: string | null;
  source_type?: SourceType | null;
  limit?: number;
  /**
   * Sprint 78 T3: telemetry surface for this index call; `null` SUPPRESSES the
   * fire-and-forget log entirely. memoryTimeline's internal anchor probe passes
   * `null` so the anchor isn't double-counted (once as a phantom 'index' hit,
   * once in the timeline window).
   */
  log_surface?: RecallSurface | null;
}

export interface TimelineInput {
  query?: string;
  around_id?: string;
  window: TimelineWindow;
  radius?: number;
}

export interface GetInput {
  ids: string[];
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function snippet(content: string): string {
  const flat = content.replace(/\s+/g, ' ').trim();
  if (flat.length <= SNIPPET_MAX) return flat;
  return flat.slice(0, SNIPPET_MAX - 1).trimEnd() + '…';
}

function toIndexHit(row: {
  id: string;
  content: string;
  source_type: string;
  project: string;
  created_at: string;
  semantic_similarity?: number | null;
}): IndexHit {
  return {
    id: row.id,
    snippet: snippet(row.content),
    source_type: row.source_type as SourceType,
    project: row.project,
    created_at: row.created_at,
    // Sprint 82 T1 (033). `?? null` so a pre-033 database yields an explicit
    // null rather than an absent key — callers branch on one shape, not two.
    semantic_similarity: row.semantic_similarity ?? null,
  };
}

/** memory_index — compact projection of the hybrid search results. */
export async function memoryIndex(
  input: IndexInput,
  deps: RecallDeps = {}
): Promise<IndexHit[]> {
  const query = input.query.trim();
  if (!query) return [];

  const limit = input.limit ?? INDEX_DEFAULT_LIMIT;
  const supabase = deps.client ?? getSupabase();
  const embed = deps.generateEmbedding ?? generateEmbedding;
  const embedding = await embed(query);

  const { data, error } = await supabase.rpc('memory_hybrid_search', {
    query_text: query,
    query_embedding: formatEmbedding(embedding),
    match_count: limit,
    full_text_weight: 1.0,
    semantic_weight: 1.0,
    rrf_k: 60,
    filter_project: input.project ?? null,
    filter_source_type: input.source_type ?? null,
  });

  if (error) {
    console.error('[mnestra-index] memory_hybrid_search failed:', error.message);
    return [];
  }

  const rows = (data ?? []) as RecallHit[];
  // Sprint 78 T3 — fire-and-forget index-surface telemetry (returned set).
  // log_surface:null suppresses it (memoryTimeline's anchor probe) so the
  // anchor isn't double-counted as a phantom 'index' hit.
  if (input.log_surface !== null) {
    logRecallHits(
      rows.map((m, i) => ({
        memory_id: m.id,
        score: m.score,
        rank: i + 1,
        source_type: m.source_type,
      })),
      { surface: input.log_surface ?? 'index', query }
    );
  }
  return rows.map(toIndexHit);
}

/**
 * memory_timeline — memories from the same project chronologically surrounding
 * either a query's top hit or a specific observation ID.
 */
export async function memoryTimeline(
  input: TimelineInput,
  deps: RecallDeps = {}
): Promise<IndexHit[]> {
  const win = WINDOW_SECONDS[input.window];
  if (!win) throw new Error(`invalid window: ${input.window}`);
  const radius = input.radius ?? TIMELINE_DEFAULT_RADIUS;

  const supabase = deps.client ?? getSupabase();

  let anchorProject: string | null = null;
  let anchorCreatedAt: string | null = null;

  if (input.around_id) {
    if (!UUID_RE.test(input.around_id)) {
      throw new Error('around_id must be a UUID');
    }
    const { data, error } = await supabase
      .from('memory_items')
      .select('project, created_at')
      .eq('id', input.around_id)
      .eq('archived', false)
      .maybeSingle();
    if (error) {
      console.error('[mnestra-timeline] anchor lookup failed:', error.message);
      return [];
    }
    if (!data) return [];
    anchorProject = (data as { project: string }).project;
    anchorCreatedAt = (data as { created_at: string }).created_at;
  } else if (input.query) {
    // log_surface:null — this is an internal anchor probe, not a user 'index'
    // call; suppress its telemetry so the anchor isn't double-counted.
    const hits = await memoryIndex({ query: input.query, limit: 1, log_surface: null }, deps);
    if (hits.length === 0) return [];
    const top = hits[0]!;
    anchorProject = top.project;
    anchorCreatedAt = top.created_at;
  } else {
    throw new Error('memory_timeline requires query or around_id');
  }

  const anchorMs = Date.parse(anchorCreatedAt!);
  const fromIso = new Date(anchorMs - win * 1000).toISOString();
  const toIso = new Date(anchorMs + win * 1000).toISOString();

  const { data: rows, error } = await supabase
    .from('memory_items')
    .select('id, content, source_type, project, created_at')
    .eq('project', anchorProject!)
    .eq('is_active', true)
    .eq('archived', false)
    .gte('created_at', fromIso)
    .lte('created_at', toIso)
    .order('created_at', { ascending: true })
    .limit(radius * 2 + 1);

  if (error) {
    console.error('[mnestra-timeline] window query failed:', error.message);
    return [];
  }

  const windowRows = (rows ?? []) as Array<{
    id: string;
    content: string;
    source_type: string;
    project: string;
    created_at: string;
  }>;

  // Sprint 78 T3 — fire-and-forget timeline-surface telemetry. The query is
  // the anchor query (or the around_id when query-less). No per-row score on
  // the window query, so rank only.
  logRecallHits(
    windowRows.map((m, i) => ({
      memory_id: m.id,
      rank: i + 1,
      source_type: m.source_type,
    })),
    { surface: 'timeline', query: input.query ?? input.around_id ?? '' }
  );

  return windowRows.map(toIndexHit);
}

/** memory_get — batch fetch full rows by UUID. Batch-only to discourage N+1. */
export async function memoryGet(
  input: GetInput,
  deps: RecallDeps = {}
): Promise<MemoryItem[]> {
  const ids = input.ids ?? [];
  if (!Array.isArray(ids) || ids.length === 0) {
    throw new Error('memory_get requires a non-empty ids array');
  }
  if (ids.length > GET_MAX_BATCH) {
    throw new Error(`memory_get batch limit is ${GET_MAX_BATCH} (got ${ids.length})`);
  }
  for (const id of ids) {
    if (typeof id !== 'string' || !UUID_RE.test(id)) {
      throw new Error(`invalid uuid: ${id}`);
    }
  }

  // Explicit column list (no `embedding`) so the shape matches the HTTP
  // citation endpoint `GET /observation/:id` exactly. The embedding
  // vector is useless for citations and bloats responses ~6 KB each.
  const supabase = deps.client ?? getSupabase();
  const { data, error } = await supabase
    .from('memory_items')
    .select(
      'id, content, source_type, category, project, metadata, is_active, archived, superseded_by, created_at, updated_at'
    )
    .in('id', ids)
    .eq('archived', false);

  if (error) {
    console.error('[mnestra-get] batch fetch failed:', error.message);
    return [];
  }
  const rows = (data ?? []) as MemoryItem[];

  // Sprint 78 T3 — a memory_get is the STRONGEST "this memory was actually
  // used" signal. Flip cited=true on each fetched row's most-recent recall-log
  // entry (fire-and-forget; never awaited; swallows all errors).
  markRecallCited(rows.map((r) => r.id));

  return rows;
}

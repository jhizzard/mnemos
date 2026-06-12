/**
 * Mnestra — memory_search (low-level)
 *
 * Raw hybrid search with optional filters. Unlike memory_recall, this does
 * NOT apply token budgeting, deduplication, or smart re-ranking. Use it for
 * debugging, admin tooling, or when you need the full scored result set.
 */

import { getSupabase } from './db.js';
import { generateEmbedding, formatEmbedding } from './embeddings.js';
import type { RecallDeps } from './recall.js';
import type { RecallHit, SearchInput } from './types.js';

export async function memorySearch(
  input: SearchInput,
  deps: RecallDeps = {}
): Promise<RecallHit[]> {
  const query = input.query.trim();
  if (!query) return [];

  const limit = input.limit ?? 20;
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
    console.error('[mnestra-search] memory_hybrid_search failed:', error.message);
    return [];
  }

  return (data ?? []) as RecallHit[];
}

/**
 * Mnestra — memory_remember
 *
 * Store a memory with embedding-based deduplication.
 *
 * Fix 4 (loosened dedup): the similarity threshold for "this is the same
 * thing, don't insert twice" is 0.88. The original internal system used
 * 0.92, which let too many near-duplicates through. Consolidation
 * (src/consolidate.ts) sweeps the remaining overlap later.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import { getSupabase } from './db.js';
import { generateEmbedding, formatEmbedding } from './embeddings.js';
import { stripPrivate } from './privacy.js';
import type { RememberInput, RememberResult, SourceType } from './types.js';
import { SOURCE_AGENTS } from './types.js';

export interface RememberDeps {
  /** Override the Supabase client (tests inject a fake). */
  client?: SupabaseClient;
  /** Override the embedding generator (tests bypass the OpenAI call). */
  generateEmbedding?: (text: string) => Promise<number[]>;
}

const DEDUP_SIMILARITY_THRESHOLD = 0.88;
const DEDUP_EXACT_SKIP_THRESHOLD = 0.95;

/**
 * Sprint 74 T1: normalize a writer-supplied source_agent before it reaches
 * the (constraint-free) DB column. Malformed values become NULL with a
 * stderr warning — they are garbage, not provenance. Well-formed values
 * OUTSIDE the known taxonomy are stored as-is (warned, not dropped): the
 * recall filter is exact-match, so an ahead-of-taxonomy agent's rows are
 * merely unfilterable until SOURCE_AGENTS catches up — at which point they
 * become retro-filterable with zero backfill. Nulling them instead would
 * permanently destroy provenance (the migration-022 backfill lesson).
 */
export function normalizeSourceAgent(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim().toLowerCase();
  if (!value) return null;
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(value)) {
    console.error(
      `[mnestra-store] malformed source_agent dropped: ${JSON.stringify(raw.slice(0, 80))}`
    );
    return null;
  }
  if (!(SOURCE_AGENTS as readonly string[]).includes(value)) {
    console.error(
      `[mnestra-store] source_agent '${value}' is outside the known taxonomy — stored as-is (unfilterable until SOURCE_AGENTS adds it)`
    );
  }
  return value;
}

export async function memoryRemember(
  input: RememberInput,
  deps: RememberDeps = {}
): Promise<RememberResult> {
  const rawContent = input.content.trim();
  if (!rawContent) {
    console.error('[mnestra-store] empty content rejected');
    return 'skipped';
  }

  // Strip <private>...</private> blocks BEFORE embedding or storage so
  // no private content ever reaches OpenAI or Supabase.
  const { text: content, hadPrivate } = stripPrivate(rawContent);
  if (!content) {
    console.error('[mnestra-store] content empty after redaction');
    return 'skipped';
  }

  const project = input.project || 'global';
  const sourceType: SourceType = input.source_type || 'fact';
  const category = input.category ?? null;
  const metadata: Record<string, unknown> = { ...(input.metadata || {}) };
  if (hadPrivate) metadata.had_private_content = true;
  const sourceAgent = normalizeSourceAgent(input.source_agent);

  const supabase = deps.client ?? getSupabase();
  const embed = deps.generateEmbedding ?? generateEmbedding;
  const embedding = await embed(content);
  const embeddingLiteral = formatEmbedding(embedding);

  // Look for near-duplicates in the same project.
  const { data: similar, error: matchError } = await supabase.rpc('match_memories', {
    query_embedding: embeddingLiteral,
    match_threshold: DEDUP_SIMILARITY_THRESHOLD,
    match_count: 3,
    filter_project: project,
  });

  if (matchError) {
    console.error('[mnestra-store] match_memories rpc failed:', matchError.message);
  }

  if (similar && similar.length > 0) {
    const top = similar[0];
    if (top.similarity > DEDUP_EXACT_SKIP_THRESHOLD) {
      return 'skipped';
    }

    // Update the existing near-duplicate in place (keeps the id stable
    // for anything that already linked to it). source_agent rides along
    // only when the caller supplied one — the updater is now the latest
    // producer of the content — and is never nulled out by an agent-less
    // update (existing provenance survives).
    const updatePayload: Record<string, unknown> = {
      content,
      embedding: embeddingLiteral,
      metadata,
      updated_at: new Date().toISOString(),
    };
    if (sourceAgent) updatePayload.source_agent = sourceAgent;

    const { error: updateError } = await supabase
      .from('memory_items')
      .update(updatePayload)
      .eq('id', top.id);

    if (updateError) {
      // Surface the real Postgres/Supabase error to the caller instead of
      // returning 'skipped' (which reads as "deduped" — exactly the wrong
      // mental model when the actual failure is e.g. a missing GRANT).
      // The MCP server, webhook server, and summarize.ts all already
      // wrap memoryRemember in a try/catch and render the error message
      // for the user.
      throw new Error(`memory_items update failed: ${updateError.message}`);
    }
    return 'updated';
  }

  const { error: insertError } = await supabase.from('memory_items').insert({
    content,
    embedding: embeddingLiteral,
    source_type: sourceType,
    category,
    project,
    metadata,
    source_agent: sourceAgent,
  });

  if (insertError) {
    throw new Error(`memory_items insert failed: ${insertError.message}`);
  }

  return 'inserted';
}

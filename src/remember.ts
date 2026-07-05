/**
 * Mnestra — memory_remember
 *
 * Store a memory with embedding-based deduplication.
 *
 * Fix 4 (loosened dedup): the similarity threshold for "this is the same
 * thing, don't insert twice" is 0.88. The original internal system used
 * 0.92, which let too many near-duplicates through. Consolidation
 * (src/consolidate.ts) sweeps the remaining overlap later.
 *
 * Sprint 79 T1 (capture gates): the 0.88-0.95 band used to CLOBBER — the
 * update payload replaced content/embedding/metadata wholesale, so a
 * verbose auto-captured restatement of an existing kitchen lesson silently
 * destroyed the original's metadata and any detail only the original had.
 * It now REINFORCES instead: metadata shallow-merges (nothing is dropped),
 * `reinforcement_count` (migration 028) increments, and the OLD content
 * stays canonical unless the caller explicitly asks for `refresh: true` —
 * auto-captured restatements are systematically more verbose than the
 * original, so "longer wins" would let noise overwrite signal by default.
 */

import { createHash } from 'node:crypto';

import type { SupabaseClient } from '@supabase/supabase-js';

import { getSupabase } from './db.js';
import { generateEmbedding, formatEmbedding } from './embeddings.js';
import { classifyGranularity } from './granularity.js';
import { stripPrivate } from './privacy.js';
import { memoryLink } from './relationships.js';
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

/** Ring-buffer cap for metadata.reinforcements[] / .rejected_restatements[]. */
const REINFORCEMENT_LOG_CAP = 10;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

/** Matches Postgres's md5(content) — same digest format as memory_items.content_hash. */
function md5Hex(text: string): string {
  return createHash('md5').update(text, 'utf8').digest('hex');
}

/** Append `entry`, keeping only the most recent `cap` entries (drop-oldest ring buffer). */
function pushCapped<T>(prior: unknown, entry: T, cap: number): T[] {
  const arr = Array.isArray(prior) ? (prior as T[]) : [];
  const next = [...arr, entry];
  return next.length > cap ? next.slice(next.length - cap) : next;
}

interface NearDupMatch {
  id: string;
  similarity: number;
  metadata: Record<string, unknown> | null;
}

/**
 * Best-effort side effects that never block the primary capture: linking
 * `rule_ref` as an `amends_rule` edge, and marking `supersedes` as replaced.
 * Any failure here is logged and swallowed — the row that was just
 * inserted/updated is already durable.
 */
async function applyPostWriteLinks(
  supabase: SupabaseClient,
  newId: string,
  input: RememberInput
): Promise<void> {
  if (input.rule_ref) {
    if (!UUID_RE.test(input.rule_ref)) {
      console.error(`[mnestra-store] rule_ref '${input.rule_ref}' is not a UUID — skipping amends_rule link`);
    } else {
      try {
        const result = await memoryLink(
          { source_id: newId, target_id: input.rule_ref, kind: 'amends_rule' },
          supabase
        );
        if (!result.ok) {
          console.error('[mnestra-store] amends_rule link failed:', result.error);
        }
      } catch (err) {
        console.error('[mnestra-store] amends_rule link threw:', (err as Error).message);
      }
    }
  }

  if (input.supersedes) {
    if (!UUID_RE.test(input.supersedes)) {
      console.error(`[mnestra-store] supersedes '${input.supersedes}' is not a UUID — skipping`);
      return;
    }
    try {
      const { error: supersedeErr } = await supabase
        .from('memory_items')
        .update({
          superseded_by: newId,
          is_active: false,
          updated_at: new Date().toISOString(),
        })
        .eq('id', input.supersedes);
      if (supersedeErr) {
        console.error('[mnestra-store] supersedes column update failed:', supersedeErr.message);
      }
      const result = await memoryLink(
        { source_id: newId, target_id: input.supersedes, kind: 'supersedes' },
        supabase
      );
      if (!result.ok) {
        console.error('[mnestra-store] supersedes link failed:', result.error);
      }
    } catch (err) {
      console.error('[mnestra-store] supersedes handling threw:', (err as Error).message);
    }
  }
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
  const inputMetadata = input.metadata || {};
  const sourceAgent = normalizeSourceAgent(input.source_agent);

  const supabase = deps.client ?? getSupabase();
  const embed = deps.generateEmbedding ?? generateEmbedding;
  const embedding = await embed(content);
  const embeddingLiteral = formatEmbedding(embedding);

  // Sprint 79 T1 — `force: true` bypasses near-dup detection entirely: the
  // caller wants a fresh row even if something embedding-similar exists.
  let match: NearDupMatch | null = null;

  if (!input.force) {
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
      match = similar[0] as NearDupMatch;
    } else {
      // Sprint 79 T1 — cross-project second pass, kitchen-granularity rows
      // ONLY: a generalizable lesson currently re-lands per-project forever
      // because the first pass is project-scoped. Recipe/unknown content
      // stays project-scoped (correctly — a recipe from project A isn't a
      // duplicate of the "same" recipe in project B).
      const granularity = classifyGranularity(content).granularity;
      if (granularity === 'kitchen') {
        const { data: crossSimilar, error: crossErr } = await supabase.rpc('match_memories', {
          query_embedding: embeddingLiteral,
          match_threshold: DEDUP_SIMILARITY_THRESHOLD,
          match_count: 3,
          filter_project: null,
        });
        if (crossErr) {
          console.error('[mnestra-store] cross-project match_memories rpc failed:', crossErr.message);
        } else if (crossSimilar && crossSimilar.length > 0) {
          match = crossSimilar[0] as NearDupMatch;
        }
      }
    }
  }

  if (match) {
    if (match.similarity > DEDUP_EXACT_SKIP_THRESHOLD) {
      return 'skipped';
    }

    // Sprint 79 T1 — reinforce, don't clobber. match_memories doesn't
    // return reinforcement_count (adding it there would touch a function
    // migration 001 explicitly flags as signature-drift-sensitive), so
    // fetch just that one column.
    const { data: existingRow, error: fetchErr } = await supabase
      .from('memory_items')
      .select('reinforcement_count')
      .eq('id', match.id)
      .maybeSingle();
    if (fetchErr) {
      console.error('[mnestra-store] reinforcement_count fetch failed (defaulting to 1):', fetchErr.message);
    }
    const existingCount = (existingRow as { reinforcement_count?: number } | null)?.reinforcement_count ?? 1;
    const existingMetadata = match.metadata ?? {};
    const refresh = input.refresh === true;
    const nowIso = new Date().toISOString();

    // Shallow-merge: new keys win on conflict, nothing from the old row is
    // dropped wholesale (the bug this sprint fixes: the old code did a bare
    // `metadata,` replace here, discarding everything the caller didn't
    // resend).
    const mergedMetadata: Record<string, unknown> = {
      ...existingMetadata,
      ...inputMetadata,
    };
    if (hadPrivate) mergedMetadata.had_private_content = true;

    mergedMetadata.reinforcements = pushCapped(
      existingMetadata.reinforcements,
      { ts: nowIso, source_agent: sourceAgent, sprint_ref: input.sprint_ref ?? null },
      REINFORCEMENT_LOG_CAP
    );

    if (!refresh) {
      // The incoming content lost to keep-canonical — log hash+length only
      // (never the full text; it's already sitting in `existingMetadata`'s
      // lineage if anyone needs it, and duplicating near-identical text
      // into metadata defeats the point of deduping it).
      mergedMetadata.rejected_restatements = pushCapped(
        existingMetadata.rejected_restatements,
        { content_hash: md5Hex(content), length: content.length, ts: nowIso, source_agent: sourceAgent },
        REINFORCEMENT_LOG_CAP
      );
    }

    const updatePayload: Record<string, unknown> = {
      metadata: mergedMetadata,
      reinforcement_count: existingCount + 1,
      updated_at: nowIso,
    };
    if (refresh) {
      updatePayload.content = content;
      updatePayload.embedding = embeddingLiteral;
    }
    // Existing provenance/refs survive when the caller doesn't resupply them
    // — partial UPDATE semantics mean an omitted key is simply untouched.
    if (sourceAgent) updatePayload.source_agent = sourceAgent;
    if (input.sprint_ref) updatePayload.sprint_ref = input.sprint_ref;
    if (input.rule_ref) updatePayload.rule_ref = input.rule_ref;

    const { error: updateError } = await supabase
      .from('memory_items')
      .update(updatePayload)
      .eq('id', match.id);

    if (updateError) {
      // Surface the real Postgres/Supabase error to the caller instead of
      // returning 'skipped' (which reads as "deduped" — exactly the wrong
      // mental model when the actual failure is e.g. a missing GRANT).
      // The MCP server, webhook server, and summarize.ts all already
      // wrap memoryRemember in a try/catch and render the error message
      // for the user. Stamped so a caller inspecting logs can distinguish
      // "dedup ran and updated" from "dedup was bypassed by a DB error".
      throw new Error(`memory_items update failed: ${updateError.message}`);
    }

    await applyPostWriteLinks(supabase, match.id, input);
    return 'updated';
  }

  const insertPayload: Record<string, unknown> = {
    content,
    embedding: embeddingLiteral,
    source_type: sourceType,
    category,
    project,
    metadata: hadPrivate ? { ...inputMetadata, had_private_content: true } : inputMetadata,
    source_agent: sourceAgent,
  };
  if (input.sprint_ref) insertPayload.sprint_ref = input.sprint_ref;
  if (input.rule_ref) insertPayload.rule_ref = input.rule_ref;

  const { data: inserted, error: insertError } = await supabase
    .from('memory_items')
    .insert(insertPayload)
    .select('id')
    .maybeSingle();

  if (insertError) {
    throw new Error(`memory_items insert failed: ${insertError.message}`);
  }

  const newId = (inserted as { id?: string } | null)?.id;
  if (newId) {
    await applyPostWriteLinks(supabase, newId, input);
  }

  return 'inserted';
}

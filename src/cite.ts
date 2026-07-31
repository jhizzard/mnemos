/**
 * Mnestra — memory_cite (Sprint 83 T2, the label producer)
 *
 * THE PROBLEM THIS EXISTS TO FIX. `memory_recall_log` holds ~39k rows and 0
 * real positive labels, so `fit-platt.ts` correctly refuses to fit and every
 * data-driven threshold, pruning and elevation decision downstream is blocked.
 * The cause is structural, not youth: `cited` was only ever written by
 * `markRecallCited` (the `memory_get` path) and the webhook `op:'feedback'`,
 * while ordinary `memory_recall` returns content INLINE and therefore never
 * cites. The dominant path had no producer at all.
 *
 * THE DESIGN, AND THE TWO ALTERNATIVES IT BEAT:
 *
 *   - Hook-side reuse detection (infer a citation from later edits or text
 *     overlap). Rejected as the primary producer: it manufactures labels from
 *     a heuristic, and a calibration fitted on inferred labels is
 *     indistinguishable by inspection from one fitted on real ones. That is
 *     the same class of dishonesty the fit-platt honesty gate already refuses.
 *   - Recall-group follow-up correlation (mark the whole group positive when
 *     the session goes well). Rejected: it labels all K hits positive when
 *     typically one or two were used, injecting false positives exactly where
 *     a probability fit is most damaged by them.
 *   - CHOSEN: the agent explicitly names which hits informed its work. Fewer
 *     labels, but real ones. `ranks` narrowing is the normal path for that
 *     reason — whole-group citation sits behind an explicit `all` flag.
 *
 * FAIL-SOFT, NOT FIRE-AND-FORGET. Unlike the telemetry writes, this is awaited
 * and reports its outcome: an agent told "2 citations recorded" when the group
 * id was stale learns nothing, and a silently dropped label is
 * indistinguishable from one that was never offered. Errors are returned,
 * never thrown.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import { getSupabase } from './db.js';

/**
 * The citation RPC (T1 SCHEMA-READY-2 §2, frozen):
 *
 *   mark_recall_cited_group(p_recall_group_id uuid,
 *                           p_ranks       int[]  default null,
 *                           p_memory_ids  uuid[] default null,
 *                           p_source_agent text  default null) returns int
 *
 * Narrowing by ranks and/or ids; NULL narrowing = the whole group. The return
 * is the POST-CONDITION count of cited rows in the narrowed group, so it is
 * idempotent in both state and value — a repeat call returns the same number
 * rather than 0, which is what makes retrying safe. An unknown or stale group
 * matches nothing and returns 0.
 *
 * Named constant because it is the single point of contact between this lane
 * and 034's label surface.
 */
export const CITATION_RPC = 'mark_recall_cited_group';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Guard against a pasted rank list that would cite half a table. */
const MAX_CITED_PER_CALL = 40;

export interface CiteInput {
  recall_group_id: string;
  /** 1-based `[n]` handles from the recall output. The normal path. */
  ranks?: number[] | null;
  /** Explicit memory UUIDs, for callers that have them (memory_index/get). */
  memory_ids?: string[] | null;
  /**
   * Cite EVERY hit in the group. Opt-in only, and deliberately so: a recall
   * returns K hits of which one or two typically did the work, so a blanket
   * citation manufactures K-2 false positives per call.
   */
  all?: boolean;
  /** Provenance for the citing agent; fills the log's NULL source_agent slice. */
  source_agent?: string | null;
}

export interface CiteResult {
  ok: boolean;
  /** Rows now carrying cited=true in the narrowed group (post-condition). */
  cited: number;
  group_size: number;
  error?: string;
}

export interface CiteDeps {
  client?: SupabaseClient;
  /** Override the RPC binding (tests). */
  rpcName?: string;
}

function fail(error: string, groupSize = 0): CiteResult {
  return { ok: false, cited: 0, group_size: groupSize, error };
}

/**
 * Diagnostic lookup, run ONLY when the RPC cited 0 rows.
 *
 * The happy path is a single round-trip: the RPC narrows server-side against
 * `memory_recall_log.rank` — the same value the recall surface printed as its
 * `[n]` handles. This exists so a zero can be EXPLAINED ("the group has 5
 * hits; you cited rank 9") rather than reported as a bare failure, and it
 * costs nothing on the path that works.
 */
async function describeGroup(
  client: SupabaseClient,
  recallGroupId: string
): Promise<{ size: number; maxRank: number }> {
  try {
    const { data, error } = await client
      .from('memory_recall_log')
      .select('rank')
      .eq('recall_group_id', recallGroupId);
    if (error) return { size: 0, maxRank: 0 };
    const rows = (data ?? []) as Array<{ rank: number | null }>;
    const ranks = rows.map((r) => r.rank ?? 0);
    return { size: rows.length, maxRank: ranks.length > 0 ? Math.max(...ranks) : 0 };
  } catch {
    return { size: 0, maxRank: 0 };
  }
}

/**
 * Record that specific recalled memories actually informed the caller's work.
 * Returns a result; never throws.
 */
export async function memoryCite(input: CiteInput, deps: CiteDeps = {}): Promise<CiteResult> {
  try {
    const groupId = input?.recall_group_id;
    if (typeof groupId !== 'string' || !UUID_RE.test(groupId)) {
      return fail(
        'recall_group_id must be a UUID — the id printed with the recall you are citing'
      );
    }

    const ranks = Array.isArray(input.ranks)
      ? [...new Set(input.ranks.filter((r) => Number.isInteger(r) && r > 0))].slice(
          0,
          MAX_CITED_PER_CALL
        )
      : [];
    const memoryIds = Array.isArray(input.memory_ids)
      ? [...new Set(input.memory_ids.filter((id) => typeof id === 'string' && UUID_RE.test(id)))].slice(
          0,
          MAX_CITED_PER_CALL
        )
      : [];

    if (ranks.length === 0 && memoryIds.length === 0 && input.all !== true) {
      return fail(
        'nothing to cite: pass ranks (the [n] handles of the hits you actually used), ' +
          'or memory_ids, or all:true to cite the whole group'
      );
    }

    let client: SupabaseClient;
    try {
      client = deps.client ?? getSupabase();
    } catch (err) {
      return fail(`no Supabase client: ${(err as Error).message}`);
    }

    // Single round-trip. NULL narrowing means "whole group" server-side, so
    // `all: true` is expressed by sending neither array rather than by
    // enumerating the group here.
    const { data, error } = await client.rpc(deps.rpcName ?? CITATION_RPC, {
      p_recall_group_id: groupId,
      p_ranks: ranks.length > 0 ? ranks : null,
      p_memory_ids: memoryIds.length > 0 ? memoryIds : null,
      p_source_agent: input.source_agent ?? null,
    });

    if (error) {
      return fail(`${deps.rpcName ?? CITATION_RPC} failed: ${error.message}`);
    }

    const cited = typeof data === 'number' ? data : 0;
    if (cited > 0) {
      return { ok: true, cited, group_size: 0 };
    }

    // Zero is ambiguous on its own — explain which zero it is.
    const { size, maxRank } = await describeGroup(client, groupId);
    if (size === 0) {
      return fail(
        'unknown recall_group_id — no logged hits under that id (stale, or telemetry was off for that recall)'
      );
    }
    return {
      ok: false,
      cited: 0,
      group_size: size,
      error:
        `nothing matched: that recall has ${size} hit(s) (ranks 1–${maxRank}); ` +
        `supplied ranks [${ranks.join(', ')}]${memoryIds.length > 0 ? ` and ${memoryIds.length} id(s)` : ''}`,
    };
  } catch (err) {
    return fail(`citation failed: ${(err as Error)?.message}`);
  }
}

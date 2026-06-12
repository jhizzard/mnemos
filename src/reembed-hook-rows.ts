/**
 * Mnestra — re-embed hook-written rows with the recall-side model (Sprint 74
 * T3 scope-add; companion runbook: docs/runbooks/2026-06-11-reembed-hook-rows.md).
 *
 * WHY: the bundled session-end / pre-compact hooks embed their rows with
 * text-embedding-3-small while every recall query embeds with
 * text-embedding-3-large@1536 (src/embeddings.ts). The two models do not share
 * a vector space, so `session_summary` / `pre_compact_snapshot` rows surface
 * on the keyword (FTS) leg of memory_hybrid_search only — their semantic rank
 * is noise. This script re-embeds exactly those rows with the SAME
 * `generateEmbedding` the recall path uses, restoring the semantic leg.
 *
 * SAFETY MODEL
 *   - DRY-RUN IS THE DEFAULT. Without --execute the script is read-only:
 *     it counts the affected rows, prints sample ids and the batch plan,
 *     and exits. --execute is required to write anything.
 *   - Idempotent + resumable: each re-embedded row is stamped
 *     `metadata.embedding_model = 'text-embedding-3-large@1536'` in the SAME
 *     UPDATE as the new vector, and the selection excludes stamped rows.
 *     Crash or abort at any point, re-run, and it continues where it left off.
 *   - `content` and `created_at` are never touched (hybrid-search recency
 *     decay reads created_at). `updated_at` is bumped, honestly: the row was
 *     modified. Metadata is spread-merged over the SELECTed value, never a
 *     blind replace.
 *   - A batch that makes zero progress (every row's embed failed) aborts the
 *     run instead of hot-looping on a poisoned batch or a dead OpenAI key.
 *
 * USAGE
 *   node dist/src/reembed-hook-rows.js                      # dry-run (default)
 *   node dist/src/reembed-hook-rows.js --execute            # do it
 *   node dist/src/reembed-hook-rows.js --execute --max-rows 50   # first slice
 *   flags: --batch-size N (25) --sleep-ms N (500) --max-rows N (unlimited)
 *          --project <slug> --include-archived
 *
 * Env: SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY always; OPENAI_API_KEY with
 * --execute. Same trio `mnestra serve` already needs.
 */

import { pathToFileURL } from 'node:url';
import type { SupabaseClient } from '@supabase/supabase-js';

import { getSupabase } from './db.js';
import { generateEmbedding, formatEmbedding } from './embeddings.js';

/** Marker written into metadata.embedding_model by a completed re-embed. */
export const REEMBED_MARKER = 'text-embedding-3-large@1536';

/** The two source_types only the bundled hooks ever write (Sprint 74 T3 FINDING). */
export const HOOK_SOURCE_TYPES = ['session_summary', 'pre_compact_snapshot'] as const;

/**
 * PostgREST translation of `metadata->>'embedding_model' IS DISTINCT FROM
 * <marker>`: NULL (never stamped) OR a different stamp. `neq` alone would
 * drop NULL rows — Postgres NULL <> x is NULL.
 */
const UNSTAMPED_OR_FILTER = `metadata->>embedding_model.is.null,metadata->>embedding_model.neq."${REEMBED_MARKER}"`;

export interface ReembedOptions {
  execute: boolean;
  batchSize: number;
  sleepMs: number;
  maxRows: number | null;
  project: string | null;
  includeArchived: boolean;
}

export const DEFAULT_OPTIONS: ReembedOptions = {
  execute: false,
  batchSize: 25,
  sleepMs: 500,
  maxRows: null,
  project: null,
  includeArchived: false,
};

export interface ReembedDeps {
  /** Override the Supabase client (tests inject a fake). */
  client?: SupabaseClient;
  /** Override the embedding generator (tests bypass the OpenAI call). */
  generateEmbedding?: (text: string) => Promise<number[]>;
  log?: (msg: string) => void;
  sleep?: (ms: number) => Promise<void>;
  /** Clock override so tests get deterministic stamps. */
  now?: () => string;
}

export interface ReembedStats {
  dryRun: boolean;
  pending: number;
  pendingBySourceType: Record<string, number>;
  sampleIds: string[];
  reembedded: number;
  failed: number;
  batches: number;
}

interface PendingRow {
  id: string;
  content: string;
  metadata: Record<string, unknown> | null;
  source_type: string;
}

/**
 * Minimal structural view of the PostgREST filter builder — the supabase-js
 * generic builder types recurse deeply enough to trip TS2589 when threaded
 * through a helper, so the chain is handled via this narrow interface and the
 * results are typed explicitly at the await sites.
 */
interface Filterable {
  in(col: string, vals: readonly string[]): Filterable;
  or(filter: string): Filterable;
  eq(col: string, val: unknown): Filterable;
  order(col: string, opts: { ascending: boolean }): Filterable;
  limit(n: number): Filterable;
}

function applySelectionFilters(query: Filterable, opts: ReembedOptions): Filterable {
  let q = query.in('source_type', HOOK_SOURCE_TYPES).or(UNSTAMPED_OR_FILTER);
  if (!opts.includeArchived) q = q.eq('is_active', true).eq('archived', false);
  if (opts.project) q = q.eq('project', opts.project);
  return q;
}

async function countPending(
  client: SupabaseClient,
  opts: ReembedOptions,
  sourceType?: string
): Promise<number> {
  let q = applySelectionFilters(
    client
      .from('memory_items')
      .select('id', { count: 'exact', head: true }) as unknown as Filterable,
    opts
  );
  if (sourceType) q = q.eq('source_type', sourceType);
  const { count, error } = await (q as unknown as PromiseLike<{
    count: number | null;
    error: { message: string } | null;
  }>);
  if (error) throw new Error(`count query failed: ${error.message}`);
  return count ?? 0;
}

async function selectBatch(
  client: SupabaseClient,
  opts: ReembedOptions,
  limit: number
): Promise<PendingRow[]> {
  const q = applySelectionFilters(
    client.from('memory_items').select('id, content, metadata, source_type') as unknown as Filterable,
    opts
  )
    .order('created_at', { ascending: true })
    .limit(limit);
  const { data, error } = await (q as unknown as PromiseLike<{
    data: PendingRow[] | null;
    error: { message: string } | null;
  }>);
  if (error) throw new Error(`batch select failed: ${error.message}`);
  return data ?? [];
}

export async function runReembed(
  options: Partial<ReembedOptions> = {},
  deps: ReembedDeps = {}
): Promise<ReembedStats> {
  const opts: ReembedOptions = { ...DEFAULT_OPTIONS, ...options };
  const client = deps.client ?? getSupabase();
  const embed = deps.generateEmbedding ?? generateEmbedding;
  const log = deps.log ?? ((msg: string) => console.error(`[mnestra-reembed] ${msg}`));
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? (() => new Date().toISOString());

  const pendingBySourceType: Record<string, number> = {};
  for (const st of HOOK_SOURCE_TYPES) {
    pendingBySourceType[st] = await countPending(client, opts, st);
  }
  const pending = await countPending(client, opts);
  const sample = await selectBatch(client, opts, 5);
  const sampleIds = sample.map((r) => r.id);

  const stats: ReembedStats = {
    dryRun: !opts.execute,
    pending,
    pendingBySourceType,
    sampleIds,
    reembedded: 0,
    failed: 0,
    batches: 0,
  };

  const planned = opts.maxRows === null ? pending : Math.min(pending, opts.maxRows);
  log(
    `pending=${pending} (${HOOK_SOURCE_TYPES.map((st) => `${st}=${pendingBySourceType[st]}`).join(', ')})` +
      ` planned=${planned} batch-size=${opts.batchSize}` +
      ` batches≈${Math.ceil(planned / opts.batchSize)} marker='${REEMBED_MARKER}'` +
      (opts.project ? ` project=${opts.project}` : '') +
      (opts.includeArchived ? ' include-archived' : '')
  );

  if (!opts.execute) {
    log(`DRY-RUN — no writes. Sample ids: ${sampleIds.join(', ') || '(none)'}`);
    log('Re-run with --execute to re-embed.');
    return stats;
  }

  let processed = 0;
  // One attempt per row per run: a failed row stays unstamped (so the NEXT
  // run retries it) but is not reselected within THIS run. The selection
  // over-fetches by the failed count so known-failed rows can't starve a batch.
  const failedIds = new Set<string>();
  while (opts.maxRows === null || processed < opts.maxRows) {
    const room = opts.maxRows === null ? opts.batchSize : Math.min(opts.batchSize, opts.maxRows - processed);
    const selected = await selectBatch(client, opts, room + failedIds.size);
    const batch = selected.filter((r) => !failedIds.has(r.id)).slice(0, room);
    if (batch.length === 0) break;
    stats.batches += 1;

    let batchOk = 0;
    for (const row of batch) {
      processed += 1;
      try {
        const embedding = await embed(row.content);
        const ts = now();
        const { error } = await client
          .from('memory_items')
          .update({
            embedding: formatEmbedding(embedding),
            metadata: {
              ...(row.metadata ?? {}),
              embedding_model: REEMBED_MARKER,
              reembedded_at: ts,
            },
            updated_at: ts,
          })
          .eq('id', row.id);
        if (error) throw new Error(`update failed: ${error.message}`);
        stats.reembedded += 1;
        batchOk += 1;
      } catch (err) {
        // Skip — the row stays unstamped and the next run retries it.
        failedIds.add(row.id);
        stats.failed += 1;
        log(`row ${row.id} (${row.source_type}) failed: ${(err as Error).message}`);
      }
    }

    log(`batch ${stats.batches}: ${batchOk}/${batch.length} re-embedded (total ${stats.reembedded}, failed ${stats.failed})`);

    if (batchOk === 0) {
      // Every row in the batch failed; the selection would return the same
      // rows again. Abort instead of hot-looping on a poisoned batch.
      log('zero progress in batch — aborting (fix the failure, then re-run; completed rows are stamped)');
      break;
    }
    if (opts.sleepMs > 0) await sleep(opts.sleepMs);
  }

  log(`done: reembedded=${stats.reembedded} failed=${stats.failed} batches=${stats.batches}`);
  return stats;
}

function parseArgs(argv: string[]): Partial<ReembedOptions> {
  const opts: Partial<ReembedOptions> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${arg} requires a value`);
      return v;
    };
    if (arg === '--execute') opts.execute = true;
    else if (arg === '--include-archived') opts.includeArchived = true;
    else if (arg === '--batch-size') opts.batchSize = Math.max(1, parseInt(next(), 10) || 25);
    else if (arg === '--sleep-ms') opts.sleepMs = Math.max(0, parseInt(next(), 10) || 0);
    else if (arg === '--max-rows') opts.maxRows = Math.max(1, parseInt(next(), 10) || 1);
    else if (arg === '--project') opts.project = next();
    else throw new Error(`unknown flag: ${arg}`);
  }
  return opts;
}

async function main(): Promise<void> {
  let opts: Partial<ReembedOptions>;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`[mnestra-reembed] ${(err as Error).message}`);
    process.exit(2);
    return;
  }

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error('[mnestra-reembed] SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
    process.exit(2);
    return;
  }
  if (opts.execute && !process.env.OPENAI_API_KEY) {
    console.error('[mnestra-reembed] OPENAI_API_KEY is required with --execute');
    process.exit(2);
    return;
  }

  const stats = await runReembed(opts);
  // 0 = clean (dry-run, or every selected row re-embedded); 1 = rows skipped.
  process.exit(stats.failed > 0 ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error('[mnestra-reembed] fatal:', err);
    process.exit(1);
  });
}

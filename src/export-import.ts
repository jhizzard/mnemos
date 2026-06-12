/**
 * Mnestra — export / import
 *
 * Streaming JSONL dump and load. Designed as the migration path out of
 * (or into) Mnestra: one row per line, full column set minus nothing,
 * resumable by re-importing into a fresh database.
 *
 * Neither function loads the whole store into memory. Export paginates
 * via `.range()`; import reads stdin line-by-line.
 */

import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import type { SupabaseClient } from '@supabase/supabase-js';

import { getSupabase } from './db.js';
import { generateEmbedding, formatEmbedding } from './embeddings.js';

const EXPORT_BATCH = 500;

const EXPORT_COLUMNS =
  'id, content, source_type, category, project, metadata, is_active, archived, superseded_by, created_at, updated_at, embedding';

export interface ExportOptions {
  project?: string;
  since?: string;
  out: Writable;
  /** Override the Supabase client (tests inject a fake). */
  client?: SupabaseClient;
}

export interface ExportReport {
  rows: number;
}

export async function exportMemories(opts: ExportOptions): Promise<ExportReport> {
  const supabase = opts.client ?? getSupabase();
  let offset = 0;
  let total = 0;

  while (true) {
    let q = supabase
      .from('memory_items')
      .select(EXPORT_COLUMNS)
      .order('created_at', { ascending: true })
      .range(offset, offset + EXPORT_BATCH - 1);

    if (opts.project) q = q.eq('project', opts.project);
    if (opts.since) q = q.gte('created_at', opts.since);

    const { data, error } = await q;
    if (error) throw new Error(`export failed: ${error.message}`);
    if (!data || data.length === 0) break;

    for (const row of data) {
      opts.out.write(`${JSON.stringify(row)}\n`);
      total++;
    }

    if (data.length < EXPORT_BATCH) break;
    offset += data.length;
  }

  return { rows: total };
}

export interface ImportOptions {
  in: Readable;
}

export interface ImportReport {
  processed: number;
  inserted: number;
  skipped: number;
  errors: number;
}

interface RawRow {
  id?: string;
  content?: string;
  source_type?: string;
  category?: string | null;
  project?: string;
  metadata?: Record<string, unknown>;
  is_active?: boolean;
  archived?: boolean;
  superseded_by?: string | null;
  created_at?: string;
  updated_at?: string;
  embedding?: unknown;
}

function normalizeEmbedding(raw: unknown): string | null {
  if (raw == null) return null;
  if (typeof raw === 'string') return raw; // pgvector literal, pass through
  if (Array.isArray(raw) && raw.every((v) => typeof v === 'number')) {
    return formatEmbedding(raw as number[]);
  }
  return null;
}

export async function importMemories(opts: ImportOptions): Promise<ImportReport> {
  const supabase = getSupabase();
  const report: ImportReport = { processed: 0, inserted: 0, skipped: 0, errors: 0 };
  const rl = createInterface({ input: opts.in, crlfDelay: Infinity });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    report.processed++;

    let row: RawRow;
    try {
      row = JSON.parse(trimmed) as RawRow;
    } catch (err) {
      console.error('[mnestra-import] bad JSON line:', (err as Error).message);
      report.errors++;
      continue;
    }

    if (!row.content || typeof row.content !== 'string') {
      console.error('[mnestra-import] row missing content, skipping');
      report.errors++;
      continue;
    }

    // Dedup against existing rows by id.
    if (row.id) {
      const { data: existing, error: checkErr } = await supabase
        .from('memory_items')
        .select('id')
        .eq('id', row.id)
        .maybeSingle();
      if (checkErr) {
        console.error('[mnestra-import] id check failed:', checkErr.message);
        report.errors++;
        continue;
      }
      if (existing) {
        report.skipped++;
        continue;
      }
    }

    // Resolve embedding: pass through if present, compute if absent.
    let embedding = normalizeEmbedding(row.embedding);
    if (!embedding) {
      try {
        const vec = await generateEmbedding(row.content);
        embedding = formatEmbedding(vec);
      } catch (err) {
        console.error('[mnestra-import] embed failed:', (err as Error).message);
        report.errors++;
        continue;
      }
    }

    const payload: Record<string, unknown> = {
      content: row.content,
      embedding,
      source_type: row.source_type ?? 'fact',
      category: row.category ?? null,
      project: row.project ?? 'global',
      metadata: row.metadata ?? {},
    };
    if (row.id) payload.id = row.id;
    if (row.is_active !== undefined) payload.is_active = row.is_active;
    if (row.archived !== undefined) payload.archived = row.archived;
    if (row.superseded_by !== undefined) payload.superseded_by = row.superseded_by;
    if (row.created_at) payload.created_at = row.created_at;
    if (row.updated_at) payload.updated_at = row.updated_at;

    const { error: insertErr } = await supabase.from('memory_items').insert(payload);
    if (insertErr) {
      console.error('[mnestra-import] insert failed:', insertErr.message);
      report.errors++;
      continue;
    }
    report.inserted++;
  }

  return report;
}

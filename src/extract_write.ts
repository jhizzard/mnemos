/**
 * Mnestra — write-time graph extraction (Sprint 83 T2)
 *
 * Memories are written flat: no entities, no typed edges, no problem class.
 * The graph only ever received nightly cosine-similarity edges, which encode
 * "these two look alike" and nothing about WHY. Write time is where the
 * semantic knowledge actually exists and is cheapest to extract.
 *
 * THE CONTRACT — a write NEVER fails because extraction failed:
 *
 *   1. Every entry point returns a report, never throws. The whole body is
 *      wrapped; a thrown error becomes `ok: false` with a reason.
 *   2. Scheduled fire-and-forget from remember.ts, never awaited, so a write's
 *      latency is unchanged. `drainWriteExtractions()` exists for tests and
 *      for short-lived CLI processes that would otherwise exit mid-flight.
 *   3. Hard wall-clock budget, enforced with an AbortSignal on the LLM call.
 *      Past the deadline, remaining work is skipped rather than queued.
 *   4. Every 034 surface is feature-detected ONCE and latched. On a pre-034
 *      database the first attempt fails, the latch flips to unavailable, and
 *      no later write pays the probe again (the Sprint 82 404-capability-latch
 *      precedent).
 *   5. Drop-invalid is SERVER-side. `upsert_memory_edges` / `upsert_memory_entities`
 *      validate every predicate and entity type against the FK-governed
 *      vocabulary tables and drop offenders per-element, returning counts —
 *      so a hallucinated value can never raise a 23503 into a write path, and
 *      this module never transcribes the vocabulary into TypeScript (T1
 *      SCHEMA-READY-2 §4/§5). The vocabulary is read here only to TELL the
 *      model what is legal, never to police it afterwards.
 *
 * WHAT IT WRITES, AND WHAT IT DELIBERATELY DOES NOT:
 *
 *   - Entities + mentions (LLM). Populates `memory_entities` /
 *     `memory_entity_mentions`, the substrate T3's consolidation resolves and
 *     runs community detection over. Resolution here is LIGHT — normalize and
 *     match the exact key. Deep resolution is explicitly T3's, not ours.
 *   - `same_pattern_as` edges between memories that share a problem class
 *     (DETERMINISTIC — no LLM). This is the edge that makes "you solved this
 *     before" fire: the recurrence and the fix are linked because their
 *     problem_signatures agree, not because a model guessed.
 *   - Entity-level triples are EXTRACTED but NOT PERSISTED this sprint.
 *     `memory_relationships` is memory↔memory (both columns FK to
 *     memory_items), and 034 ships no entity↔entity edge table, so a triple
 *     like "recall_log.ts —part_of→ mnestra" has nowhere to live. They are
 *     returned on the report and gated behind SR-7. Writing them into some
 *     other column to look complete would be worse than leaving them unstored.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import { getSupabase } from './db.js';
import type { ProblemSignature } from './problem_signature.js';

// ── tunables ────────────────────────────────────────────────────────────────

/**
 * Wall-clock ceiling for one memory's extraction. Generous relative to a Haiku
 * call, tight relative to a hung socket. Nothing is retried: a write-time
 * extraction that missed is a graph edge that does not exist yet, which the
 * nightly inference job and T3's consolidation both get another shot at.
 */
const DEFAULT_BUDGET_MS = 8_000;

/** Below this, there is no meaningful structure to extract. */
const MIN_CONTENT_CHARS = 80;

/** Ceiling on content handed to the model — cost control, not correctness. */
const MAX_CONTENT_CHARS = 12_000;

/** Caps on what one memory may produce. A runaway response is a budget leak. */
const MAX_ENTITIES = 12;
const MAX_TRIPLES = 12;
const MAX_SAME_PATTERN_EDGES = 5;

/** Concurrent in-flight extractions across the process. */
const MAX_CONCURRENT = 3;

/**
 * Fallback predicate vocabulary — the 14 values migration 034 seeds into
 * `public.memory_relationship_types`. Used ONLY when that table cannot be
 * read (pre-034). The table is the source of truth precisely so this constant
 * cannot drift: it is a cold-start fallback, not a second definition.
 */
const FALLBACK_PREDICATES = [
  'supersedes', 'relates_to', 'contradicts', 'elaborates', 'caused_by',
  'blocks', 'inspired_by', 'cross_project_link', 'amends_rule', 'elevated_to',
  'same_pattern_as', 'fixed_by', 'documented_at', 'part_of',
];

/** Fallback entity-type vocabulary — 034 §3's seed list. Same cold-start role. */
const FALLBACK_ENTITY_TYPES = [
  'file', 'symbol', 'error_class', 'problem_class', 'project', 'sprint',
  'package', 'service', 'command', 'env_var', 'person', 'concept',
];

const INFERRED_BY = 'extract:write-time@1';

// ── module state (all resettable for tests) ─────────────────────────────────

type Capability = 'unknown' | 'available' | 'unavailable';

let edgeCapability: Capability = 'unknown';
let entityCapability: Capability = 'unknown';
let predicateVocab: Set<string> | null = null;
let entityTypeVocab: Set<string> | null = null;
let inFlight = new Set<Promise<unknown>>();
let warnedNoKey = false;

/** Test helper — clear latches, caches, and in-flight tracking between cases. */
export function __resetExtractState(): void {
  edgeCapability = 'unknown';
  entityCapability = 'unknown';
  predicateVocab = null;
  entityTypeVocab = null;
  inFlight = new Set();
  warnedNoKey = false;
}

// ── types ───────────────────────────────────────────────────────────────────

export interface ExtractedEntity {
  /** Surface form as written. The RPC derives entity_key = lower(btrim(name)). */
  name: string;
  /** Must be in `memory_entity_types`; the RPC drops it if not. */
  type: string;
  span?: string | null;
  confidence?: number | null;
}

export interface ExtractedTriple {
  subject: string;
  predicate: string;
  object: string;
}

export interface ExtractReport {
  ok: boolean;
  /** Why nothing happened, when nothing happened. Never an exception. */
  reason?: string;
  entities_written: number;
  mentions_written: number;
  same_pattern_edges: number;
  /** Extracted but unpersistable this sprint — see the header note on SR-7. */
  triples_extracted: ExtractedTriple[];
  dropped_predicates: string[];
  dropped_entity_types: string[];
  budget_ms: number;
  elapsed_ms: number;
}

export interface ExtractInput {
  memory_id: string;
  content: string;
  project: string;
  problem_signature?: ProblemSignature | null;
}

export interface ExtractDeps {
  client?: SupabaseClient;
  /** Tests inject a fake extractor and skip the network entirely. */
  extract?: (
    content: string,
    vocab: { predicates: string[]; entity_types: string[] },
    signal: AbortSignal
  ) => Promise<{ entities: ExtractedEntity[]; triples: ExtractedTriple[] }>;
  budgetMs?: number;
  now?: () => number;
}

function emptyReport(reason: string, budgetMs: number, elapsedMs = 0): ExtractReport {
  return {
    ok: false,
    reason,
    entities_written: 0,
    mentions_written: 0,
    same_pattern_edges: 0,
    triples_extracted: [],
    dropped_predicates: [],
    dropped_entity_types: [],
    budget_ms: budgetMs,
    elapsed_ms: elapsedMs,
  };
}

/**
 * Extraction is OFF unless explicitly enabled. It costs a model call per write
 * and writes to tables that only exist post-034; defaulting it on would change
 * the cost and failure surface of every existing install the moment they
 * upgrade, without anyone opting in.
 */
export function extractionEnabled(): boolean {
  return process.env.MNESTRA_EXTRACT_ENABLED === '1';
}

function budgetFromEnv(explicit?: number): number {
  if (typeof explicit === 'number' && explicit > 0) return explicit;
  const raw = Number(process.env.MNESTRA_EXTRACT_BUDGET_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_BUDGET_MS;
}

// ── vocabulary (read from 034's lookup tables; cached per process) ──────────

/**
 * Read the live vocabulary from the lookup table rather than trusting a TS
 * constant. 034 §2 made the predicate list a TABLE with an FK precisely so
 * widening it is one INSERT; if this filtered against a hardcoded copy, the
 * copy would silently become the real ceiling and a newly-added predicate
 * would be dropped as "out of vocabulary" by the only writer that emits it.
 */
async function loadVocab(
  client: SupabaseClient,
  table: string,
  column: string,
  fallback: string[]
): Promise<Set<string>> {
  try {
    const { data, error } = await client.from(table).select(column);
    if (error || !data || data.length === 0) {
      return new Set(fallback);
    }
    // `as unknown` first: PostgREST's generic row type resolves to
    // GenericStringError[] for a dynamically-named table/column, which does not
    // overlap Record<string, unknown> directly.
    const values = (data as unknown as Array<Record<string, unknown>>)
      .map((r) => r[column])
      .filter((v): v is string => typeof v === 'string' && v.length > 0);
    return values.length > 0 ? new Set(values) : new Set(fallback);
  } catch {
    return new Set(fallback);
  }
}

// ── LLM extraction ──────────────────────────────────────────────────────────

function stripFence(text: string): string {
  let s = text.trim();
  if (s.startsWith('```')) {
    s = s.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
  }
  if (!s.startsWith('{')) {
    const start = s.indexOf('{');
    const end = s.lastIndexOf('}');
    if (start !== -1 && end !== -1) s = s.slice(start, end + 1);
  }
  return s;
}

async function haikuExtract(
  content: string,
  vocab: { predicates: string[]; entity_types: string[] },
  signal: AbortSignal
): Promise<{ entities: ExtractedEntity[]; triples: ExtractedTriple[] }> {
  const apiKey = process.env.ANTHROPIC_API_KEY ?? '';
  if (!apiKey) {
    if (!warnedNoKey) {
      warnedNoKey = true;
      console.error('[mnestra-extract] ANTHROPIC_API_KEY missing — extraction disabled');
    }
    return { entities: [], triples: [] };
  }

  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey });
  const model = process.env.MNESTRA_HAIKU_MODEL || 'claude-haiku-4-5-20251001';

  const response = await client.messages.create(
    {
      model,
      max_tokens: 1024,
      system:
        'You are a JSON-only extraction system. Respond with a single valid JSON object and nothing else.',
      messages: [
        {
          role: 'user',
          content: `Extract the named entities and the relationships between them from this developer memory.

type MUST be exactly one of: ${vocab.entity_types.join(', ')}
predicate MUST be exactly one of: ${vocab.predicates.join(', ')}

Rules:
- Only entities the text actually names. Do not infer, do not generalize.
- name is the surface form exactly as written in the text.
- Both subject and object of a triple MUST be names present in your entities array.
- If nothing is clearly named, return empty arrays. Empty is a correct answer.
- Never emit a type or predicate outside the lists above.
- Do not extract secrets, tokens, or credentials as entities.

Return exactly: {"entities": [{"name": "...", "type": "...", "span": "...", "confidence": 0.0}], "triples": [{"subject": "...", "predicate": "...", "object": "..."}]}

Memory:
${content.slice(0, MAX_CONTENT_CHARS)}`,
        },
      ],
    },
    { signal }
  );

  const block = response.content[0];
  if (!block || block.type !== 'text') return { entities: [], triples: [] };

  const parsed = JSON.parse(stripFence(block.text)) as {
    entities?: unknown;
    triples?: unknown;
  };

  const entities: ExtractedEntity[] = [];
  if (Array.isArray(parsed.entities)) {
    for (const raw of parsed.entities) {
      const e = raw as Record<string, unknown>;
      const name = typeof e.name === 'string' ? e.name.trim() : '';
      const type = typeof e.type === 'string' ? e.type.trim() : '';
      // No entity_key derived here on purpose: the RPC normalizes server-side,
      // so two clients cannot disagree by a trailing space and split one
      // canonical entity into two rows.
      if (!name || !type) continue;
      entities.push({
        name,
        type,
        span: typeof e.span === 'string' ? e.span.slice(0, 200) : null,
        confidence: typeof e.confidence === 'number' ? e.confidence : null,
      });
    }
  }

  const triples: ExtractedTriple[] = [];
  if (Array.isArray(parsed.triples)) {
    for (const raw of parsed.triples) {
      const t = raw as Record<string, unknown>;
      if (
        typeof t.subject === 'string' &&
        typeof t.predicate === 'string' &&
        typeof t.object === 'string'
      ) {
        triples.push({
          subject: t.subject.trim(),
          predicate: t.predicate.trim(),
          object: t.object.trim(),
        });
      }
    }
  }

  return { entities, triples };
}

// ── persistence (T1 SCHEMA-READY-2 §4/§5 — both RPCs are drop-invalid) ─────

const ENTITY_RPC = 'upsert_memory_entities';
const EDGE_RPC = 'upsert_memory_edges';

/**
 * Write entities + mentions via `upsert_memory_entities(p_memory_id, p_entities)`.
 *
 * ONE round-trip, and normalization is SERVER-side (`lower(btrim(name))`) —
 * which is the point. If each client normalized its own keys, two callers
 * disagreeing by a trailing space would split one entity into two canonical
 * rows, and T3's consolidation would then be resolving a mess this layer
 * created. The mention row is `ON CONFLICT DO NOTHING`, so re-extraction on a
 * reinforcement neither errors nor double-counts `mention_count`.
 *
 * Drop-invalid on `type` is enforced against `memory_entity_types` inside the
 * function, so a hallucinated type is dropped server-side rather than raising
 * an FK violation into a write path.
 */
async function writeEntities(
  client: SupabaseClient,
  memoryId: string,
  entities: ExtractedEntity[]
): Promise<{ entities: number; mentions: number; dropped: number }> {
  if (entities.length === 0) return { entities: 0, mentions: 0, dropped: 0 };

  const { data, error } = await client.rpc(ENTITY_RPC, {
    p_memory_id: memoryId,
    // Trim at the persistence boundary, not in the parser: the parser is only
    // one of the extractors that can reach here (tests and future callers
    // supply their own), and `display_name` is stored as-first-seen — so a
    // name arriving with surrounding whitespace would be persisted with it.
    // The RPC's `lower(btrim(name))` protects the dedup KEY, not the display
    // form. Only whitespace is stripped; case and inner spacing are the
    // surface form and belong to the caller.
    p_entities: entities.map((e) => ({
      name: e.name.trim(),
      type: e.type.trim(),
      span: e.span ?? null,
      confidence: e.confidence ?? null,
    })),
  });
  if (error) throw new Error(`${ENTITY_RPC} failed: ${error.message}`);

  const r = (data ?? {}) as { created?: number; linked?: number; dropped?: number };
  return { entities: r.created ?? 0, mentions: r.linked ?? 0, dropped: r.dropped ?? 0 };
}

/**
 * Link this memory to earlier memories carrying the SAME problem class.
 *
 * DETERMINISTIC — no model involved. Two memories are `same_pattern_as` when
 * their problem_signatures agree, which is a fact about stored data rather
 * than a guess, so the edge that powers "you solved this before" does not
 * depend on an API key being present or a model's judgement being right.
 *
 * Goes through `upsert_memory_edges`, which folds in the resurrection
 * semantics (`ON CONFLICT ... DO UPDATE SET invalid_at = null`): an edge that
 * was previously invalidated must come back LIVE on re-assertion, where a
 * plain PostgREST upsert would leave `invalid_at` set and the edge invisible
 * to every live-only traversal — silently.
 *
 * Direction matters and is not arbitrary: `same_pattern_as` is SYMMETRIC per
 * SCHEMA-READY-2 §6, so source/target carry no meaning here and one edge per
 * pair is correct.
 */
async function writeSamePatternEdges(
  client: SupabaseClient,
  memoryId: string,
  project: string,
  signature: ProblemSignature
): Promise<{ accepted: number; dropped_predicates: string[] }> {
  const { data, error } = await client
    .from('memory_items')
    .select('id')
    .eq('project', project)
    .eq('is_active', true)
    .eq('archived', false)
    .neq('id', memoryId)
    .eq('metadata->problem_signature->>class', signature.class)
    .limit(MAX_SAME_PATTERN_EDGES);

  if (error) throw new Error(`same_pattern lookup failed: ${error.message}`);

  const targets = ((data ?? []) as Array<{ id: string }>).map((r) => r.id);
  if (targets.length === 0) return { accepted: 0, dropped_predicates: [] };

  const { data: result, error: edgeErr } = await client.rpc(EDGE_RPC, {
    p_edges: targets.map((targetId) => ({
      source_id: memoryId,
      target_id: targetId,
      predicate: 'same_pattern_as',
      weight: 0.9,
      inferred_by: INFERRED_BY,
    })),
  });
  if (edgeErr) throw new Error(`${EDGE_RPC} failed: ${edgeErr.message}`);

  const r = (result ?? {}) as { accepted?: number; dropped_predicates?: string[] };
  return { accepted: r.accepted ?? 0, dropped_predicates: r.dropped_predicates ?? [] };
}

// ── orchestration ───────────────────────────────────────────────────────────

/**
 * Extract and persist the graph for one memory. Returns a report; NEVER
 * throws. Awaitable so tests can assert on the outcome — production schedules
 * it fire-and-forget through `scheduleWriteExtraction`.
 */
export async function extractGraphForMemory(
  input: ExtractInput,
  deps: ExtractDeps = {}
): Promise<ExtractReport> {
  const budgetMs = budgetFromEnv(deps.budgetMs);
  const clock = deps.now ?? (() => Date.now());
  const startedAt = clock();
  const elapsed = () => clock() - startedAt;

  try {
    if (!extractionEnabled()) return emptyReport('disabled', budgetMs);
    if (!input?.memory_id) return emptyReport('no-memory-id', budgetMs);
    const content = (input.content ?? '').trim();
    if (content.length < MIN_CONTENT_CHARS) return emptyReport('content-too-short', budgetMs);
    if (edgeCapability === 'unavailable' && entityCapability === 'unavailable') {
      return emptyReport('pre-034-latched', budgetMs);
    }

    let client: SupabaseClient;
    try {
      client = deps.client ?? getSupabase();
    } catch {
      // No Supabase env — the same silent no-op the telemetry path takes.
      return emptyReport('no-supabase-client', budgetMs, elapsed());
    }

    if (!predicateVocab) {
      predicateVocab = await loadVocab(
        client,
        'memory_relationship_types',
        'type',
        FALLBACK_PREDICATES
      );
    }
    if (!entityTypeVocab) {
      entityTypeVocab = await loadVocab(
        client,
        'memory_entity_types',
        'entity_type',
        FALLBACK_ENTITY_TYPES
      );
    }

    const report: ExtractReport = {
      ok: true,
      entities_written: 0,
      mentions_written: 0,
      same_pattern_edges: 0,
      triples_extracted: [],
      dropped_predicates: [],
      dropped_entity_types: [],
      budget_ms: budgetMs,
      elapsed_ms: 0,
    };

    // ── deterministic half: same_pattern_as. Runs FIRST and independently of
    // the model, so the edge that powers "you solved this before" still lands
    // when there is no API key, no budget, or a refusing model.
    if (input.problem_signature && edgeCapability !== 'unavailable') {
      try {
        const edges = await writeSamePatternEdges(
          client,
          input.memory_id,
          input.project,
          input.problem_signature
        );
        report.same_pattern_edges = edges.accepted;
        report.dropped_predicates.push(...edges.dropped_predicates);
        edgeCapability = 'available';
      } catch (err) {
        // A missing function/column on a pre-034 database lands here exactly
        // once; the latch keeps every later write off the probe.
        edgeCapability = 'unavailable';
        console.error('[mnestra-extract] same_pattern edges unavailable:', (err as Error).message);
      }
    }

    if (elapsed() >= budgetMs) {
      report.elapsed_ms = elapsed();
      report.reason = 'budget-exhausted-before-llm';
      return report;
    }

    // ── model half: entities + triples, hard-aborted at the deadline.
    const controller = new AbortController();
    const remaining = Math.max(1, budgetMs - elapsed());
    const timer = setTimeout(() => controller.abort(), remaining);
    let extracted: { entities: ExtractedEntity[]; triples: ExtractedTriple[] };
    try {
      const extractFn = deps.extract ?? haikuExtract;
      extracted = await extractFn(
        content,
        {
          predicates: [...(predicateVocab ?? new Set<string>())],
          entity_types: [...(entityTypeVocab ?? new Set<string>())],
        },
        controller.signal
      );
    } catch (err) {
      report.reason = controller.signal.aborted
        ? 'llm-budget-exceeded'
        : `llm-failed: ${(err as Error).message}`;
      report.elapsed_ms = elapsed();
      return report;
    } finally {
      clearTimeout(timer);
    }

    // Cap only. Vocabulary enforcement is the RPCs' job (§4/§5 drop-invalid,
    // validated against the FK-governed tables), so filtering here would just
    // be a second, drifting copy of a list this module is explicitly told not
    // to transcribe. The caps stay because a runaway response is a budget
    // leak regardless of whether every element is valid.
    const entities = extracted.entities.slice(0, MAX_ENTITIES).filter((e) => e.name && e.type);
    report.triples_extracted = extracted.triples.slice(0, MAX_TRIPLES);

    if (entities.length > 0 && entityCapability !== 'unavailable') {
      try {
        const written = await writeEntities(client, input.memory_id, entities);
        report.entities_written = written.entities;
        report.mentions_written = written.mentions;
        // Server-dropped entity types are reported, not swallowed: a model
        // steadily emitting an out-of-vocabulary type is a signal the
        // vocabulary needs widening, and silence would hide it.
        if (written.dropped > 0) {
          report.dropped_entity_types.push(`${written.dropped} dropped by ${ENTITY_RPC}`);
        }
        entityCapability = 'available';
      } catch (err) {
        entityCapability = 'unavailable';
        console.error('[mnestra-extract] entity storage unavailable:', (err as Error).message);
      }
    }

    report.elapsed_ms = elapsed();
    return report;
  } catch (err) {
    // The outermost net. Reaching here means a bug in the guards above, and
    // the write it belongs to has already committed — so it is still only a
    // missing edge, never a lost memory.
    console.error('[mnestra-extract] unexpected failure:', (err as Error)?.message);
    return emptyReport(`unexpected: ${(err as Error)?.message}`, budgetMs, elapsed());
  }
}

/**
 * Fire-and-forget entry point for the write path. Returns void synchronously;
 * the caller must NOT await it. Over the concurrency cap, the extraction is
 * dropped rather than queued — a queue under sustained write pressure grows
 * without bound and turns a best-effort enrichment into a memory leak.
 */
export function scheduleWriteExtraction(input: ExtractInput, deps: ExtractDeps = {}): void {
  try {
    if (!extractionEnabled()) return;
    if (inFlight.size >= MAX_CONCURRENT) return;
    const p = extractGraphForMemory(input, deps)
      .catch(() => undefined)
      .finally(() => inFlight.delete(p));
    inFlight.add(p);
  } catch {
    // Scheduling itself must not throw into a write path.
  }
}

/**
 * Wait for in-flight extractions. For tests, and for short-lived CLI processes
 * that would otherwise exit before a fire-and-forget extraction completes.
 * Bounded — a hung extraction must not hold a process open indefinitely.
 */
export async function drainWriteExtractions(timeoutMs = 15_000): Promise<void> {
  if (inFlight.size === 0) return;
  await Promise.race([
    Promise.allSettled([...inFlight]),
    new Promise((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
}

/**
 * Mnestra — memory_summarize_session
 *
 * Extracts discrete facts from a session transcript (or any text) using
 * Claude Haiku, then stores each as a memory via memoryRemember. The
 * upstream rag-system used this pattern and it works well for
 * post-session ingestion.
 */

import { memoryRemember } from './remember.js';
import type { Category, Importance, RememberResult } from './types.js';

interface ExtractedFact {
  content: string;
  category: Category | null;
  importance: Importance;
}

const VALID_CATEGORIES = new Set<Category>([
  'technical',
  'business',
  'workflow',
  'debugging',
  'architecture',
  'convention',
  'relationship',
]);

const VALID_IMPORTANCE = new Set<Importance>(['critical', 'important', 'minor']);

const IMPORTANCE_RANK: Record<Importance, number> = { minor: 1, important: 2, critical: 3 };

/**
 * Sprint 79 T1 (capture gates, PLANNING §5): a floor on which extracted
 * facts get stored. 'minor' is the lowest rank, so every valid Importance
 * clears it — this sprint the floor is a deliberate no-op. It exists now so
 * a future sprint can raise it (e.g. to 'important') without an API change:
 * droppedCount is already surfaced on SummarizeResult, so raising the floor
 * later is a one-line constant change with pre-existing observability.
 */
const IMPORTANCE_FLOOR: Importance = 'minor';

async function extractFacts(text: string): Promise<ExtractedFact[]> {
  const apiKey = process.env.ANTHROPIC_API_KEY ?? '';
  if (!apiKey) {
    console.error('[mnestra] ANTHROPIC_API_KEY missing — summarize_session returning empty');
    return [];
  }

  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey });

  const model = process.env.MNESTRA_HAIKU_MODEL || 'claude-haiku-4-5-20251001';

  let response;
  try {
    response = await client.messages.create({
      model,
      max_tokens: 4096,
      system: 'You are a JSON-only extraction system. Respond with a valid JSON array and nothing else.',
      messages: [
        {
          role: 'user',
          content: `Extract discrete, self-contained facts from this text. Each fact must make sense without surrounding context.

Categorize each fact as one of: technical, business, workflow, debugging, architecture, convention, relationship
Importance: critical, important, minor

Return a JSON array: [{"content": "...", "category": "...", "importance": "..."}]

DO NOT extract: generic programming knowledge, temporary debugging steps, API keys or secrets, raw code blocks.

Text:
${text.slice(0, 80_000)}`,
        },
      ],
    });
  } catch (err) {
    console.error('[mnestra] extractFacts Anthropic call failed:', err);
    return [];
  }

  const block = response.content[0];
  if (!block || block.type !== 'text') return [];

  let jsonStr = block.text.trim();
  if (jsonStr.startsWith('```')) {
    jsonStr = jsonStr.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
  }
  if (!jsonStr.startsWith('[')) {
    const start = jsonStr.indexOf('[');
    const end = jsonStr.lastIndexOf(']');
    if (start !== -1 && end !== -1) {
      jsonStr = jsonStr.slice(start, end + 1);
    }
  }

  try {
    const parsed = JSON.parse(jsonStr) as Array<{
      content?: unknown;
      category?: unknown;
      importance?: unknown;
    }>;
    const out: ExtractedFact[] = [];
    for (const f of parsed) {
      if (typeof f.content !== 'string' || !f.content.trim()) continue;
      const category =
        typeof f.category === 'string' && VALID_CATEGORIES.has(f.category as Category)
          ? (f.category as Category)
          : null;
      const importance =
        typeof f.importance === 'string' && VALID_IMPORTANCE.has(f.importance as Importance)
          ? (f.importance as Importance)
          : 'minor';
      out.push({ content: f.content.trim(), category, importance });
    }
    return out;
  } catch (err) {
    console.error('[mnestra] extractFacts JSON parse failed:', err);
    return [];
  }
}

export interface SummarizeResult {
  total: number;
  inserted: number;
  updated: number;
  skipped: number;
  /** Sprint 79 T1: facts extracted but rejected by IMPORTANCE_FLOOR before ever reaching memoryRemember. Always 0 while the floor is 'minor' (no-op this sprint). */
  droppedCount: number;
  facts: ExtractedFact[];
}

export async function memorySummarizeSession(
  text: string,
  project = 'global'
): Promise<SummarizeResult> {
  const facts = await extractFacts(text);

  let inserted = 0;
  let updated = 0;
  let skipped = 0;
  let droppedCount = 0;
  const floorRank = IMPORTANCE_RANK[IMPORTANCE_FLOOR];

  for (const fact of facts) {
    if (IMPORTANCE_RANK[fact.importance] < floorRank) {
      droppedCount++;
      continue;
    }
    try {
      const result: RememberResult = await memoryRemember({
        content: fact.content,
        project,
        source_type: 'fact',
        category: fact.category,
        metadata: { importance: fact.importance },
      });
      if (result === 'inserted') inserted++;
      else if (result === 'updated') updated++;
      else skipped++;
    } catch (err) {
      console.error('[mnestra] summarize: remember failed for fact:', err);
      skipped++;
    }
  }

  return { total: facts.length, inserted, updated, skipped, droppedCount, facts };
}

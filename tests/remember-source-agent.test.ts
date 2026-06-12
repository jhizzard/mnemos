/**
 * Mnestra — Sprint 74 T1: source_agent threading through memory_remember
 *
 * Until this sprint, RememberInput had no source_agent field: TermDeck's
 * capture paths have sent the field since Sprint 50 (server index.js
 * stamps `adapter.sourceAgent || adapter.name` into the webhook payload)
 * and mnestra silently dropped it — rows landed with source_agent NULL.
 * These tests pin the threading + normalization contract:
 *
 *   - insert: normalized value lands in the insert payload; omitted → null.
 *   - normalize: trim + lowercase; malformed (shape) → null; well-formed
 *     but outside SOURCE_AGENTS → stored AS-IS (forward-compatible — the
 *     row becomes retro-filterable the day the taxonomy adds the value,
 *     no migration-022-style backfill).
 *   - dedup-update: source_agent included only when the caller supplied
 *     one; an agent-less update never nulls existing provenance.
 *
 * Drives memoryRemember with the RememberDeps seam (fake client + fake
 * embedder) so no Supabase or OpenAI access is required.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { memoryRemember, normalizeSourceAgent } from '../src/remember.js';

interface InsertProbe {
  inserted: Record<string, unknown>[];
  updated: { payload: Record<string, unknown>; id: string }[];
}

function makeFakeClient(
  probe: InsertProbe,
  similar: { id: string; similarity: number }[] = []
): any {
  return {
    rpc: async (name: string, _args: unknown) => {
      assert.equal(name, 'match_memories');
      return { data: similar, error: null };
    },
    from: (table: string) => {
      assert.equal(table, 'memory_items');
      return {
        insert: async (payload: Record<string, unknown>) => {
          probe.inserted.push(payload);
          return { error: null };
        },
        update: (payload: Record<string, unknown>) => ({
          eq: async (col: string, id: string) => {
            assert.equal(col, 'id');
            probe.updated.push({ payload, id });
            return { error: null };
          },
        }),
      };
    },
  };
}

const fakeEmbed = async (_text: string) => new Array(1536).fill(0);

test('insert threads a known source_agent into the row payload', async () => {
  const probe: InsertProbe = { inserted: [], updated: [] };
  const client = makeFakeClient(probe);

  const result = await memoryRemember(
    { content: 'web-chat grok panel captured this', source_agent: 'grok-web' },
    { client, generateEmbedding: fakeEmbed }
  );

  assert.equal(result, 'inserted');
  assert.equal(probe.inserted.length, 1);
  assert.equal(probe.inserted[0]!.source_agent, 'grok-web');
});

test('insert with source_agent omitted writes null (pre-Sprint-74 behavior preserved)', async () => {
  const probe: InsertProbe = { inserted: [], updated: [] };
  const client = makeFakeClient(probe);

  const result = await memoryRemember(
    { content: 'a bare capture with no provenance' },
    { client, generateEmbedding: fakeEmbed }
  );

  assert.equal(result, 'inserted');
  assert.equal(probe.inserted[0]!.source_agent, null);
});

test('insert normalizes case/whitespace: " GROK-WEB " → "grok-web"', async () => {
  const probe: InsertProbe = { inserted: [], updated: [] };
  const client = makeFakeClient(probe);

  await memoryRemember(
    { content: 'sloppy writer casing', source_agent: '  GROK-WEB  ' },
    { client, generateEmbedding: fakeEmbed }
  );

  assert.equal(probe.inserted[0]!.source_agent, 'grok-web');
});

test('insert drops a malformed source_agent to null but still captures the row', async () => {
  const probe: InsertProbe = { inserted: [], updated: [] };
  const client = makeFakeClient(probe);

  const result = await memoryRemember(
    { content: 'garbage provenance must not block capture', source_agent: 'not a slug!!' },
    { client, generateEmbedding: fakeEmbed }
  );

  assert.equal(result, 'inserted', 'capture is unconditional — fail-soft');
  assert.equal(probe.inserted[0]!.source_agent, null);
});

test('insert stores a well-formed unknown agent AS-IS (forward-compatible provenance)', async () => {
  const probe: InsertProbe = { inserted: [], updated: [] };
  const client = makeFakeClient(probe);

  await memoryRemember(
    { content: 'an agent the taxonomy has not met yet', source_agent: 'deepseek' },
    { client, generateEmbedding: fakeEmbed }
  );

  assert.equal(
    probe.inserted[0]!.source_agent,
    'deepseek',
    'unknown-but-well-formed values are preserved, not nulled — retro-filterable once SOURCE_AGENTS adds them'
  );
});

test('dedup-update includes source_agent when the caller supplied one', async () => {
  const probe: InsertProbe = { inserted: [], updated: [] };
  // similarity between 0.88 (dedup) and 0.95 (exact-skip) → update path
  const client = makeFakeClient(probe, [{ id: 'existing-row-id', similarity: 0.9 }]);

  const result = await memoryRemember(
    { content: 'refreshed content from a web panel', source_agent: 'grok-web' },
    { client, generateEmbedding: fakeEmbed }
  );

  assert.equal(result, 'updated');
  assert.equal(probe.updated.length, 1);
  assert.equal(probe.updated[0]!.id, 'existing-row-id');
  assert.equal(probe.updated[0]!.payload.source_agent, 'grok-web');
});

test('agent-less dedup-update omits source_agent entirely (existing provenance survives)', async () => {
  const probe: InsertProbe = { inserted: [], updated: [] };
  const client = makeFakeClient(probe, [{ id: 'existing-row-id', similarity: 0.9 }]);

  const result = await memoryRemember(
    { content: 'refreshed content with no stated producer' },
    { client, generateEmbedding: fakeEmbed }
  );

  assert.equal(result, 'updated');
  assert.ok(
    !('source_agent' in probe.updated[0]!.payload),
    'update payload must not carry source_agent at all — a null would erase the original provenance'
  );
});

// ─── normalizeSourceAgent unit contract ─────────────────────────────────────

test('normalizeSourceAgent edge cases', () => {
  assert.equal(normalizeSourceAgent(undefined), null);
  assert.equal(normalizeSourceAgent(null), null);
  assert.equal(normalizeSourceAgent(42), null);
  assert.equal(normalizeSourceAgent(''), null);
  assert.equal(normalizeSourceAgent('   '), null);
  assert.equal(normalizeSourceAgent('grok-web'), 'grok-web');
  assert.equal(normalizeSourceAgent('Claude-Web'), 'claude-web');
  assert.equal(normalizeSourceAgent('-leading-hyphen'), null, 'must start with a letter');
  assert.equal(normalizeSourceAgent('has space'), null);
  assert.equal(normalizeSourceAgent('has_underscore'), null);
  assert.equal(normalizeSourceAgent('a'.repeat(64)), 'a'.repeat(64), '64 chars is the cap');
  assert.equal(normalizeSourceAgent('a'.repeat(65)), null, '65 chars exceeds the cap');
});

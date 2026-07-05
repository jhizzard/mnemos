/**
 * Mnestra — Sprint 79 T1: reinforcement (merge-not-clobber) dedup rewrite
 *
 * Pins the behavior change this sprint exists to make: the 0.88-0.95
 * embedding-similarity band used to REPLACE content/embedding/metadata
 * wholesale; it now merges metadata (nothing dropped), bumps
 * reinforcement_count, and keeps the OLD content canonical unless the
 * caller passes `refresh: true`. Also covers `force` (bypass dedup
 * entirely), the cross-project kitchen-only second pass, and the
 * best-effort rule_ref/supersedes post-write links.
 *
 * Drives memoryRemember with the RememberDeps seam (fake client + fake
 * embedder) so no Supabase or OpenAI access is required.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { memoryRemember } from '../src/remember.js';

interface Row {
  updated?: Record<string, unknown>;
  inserted?: Record<string, unknown>;
}

interface FakeOpts {
  /** Near-dup results for the IN-PROJECT match_memories call. */
  inProject?: { id: string; similarity: number; metadata?: Record<string, unknown> }[];
  /** Near-dup results for the CROSS-PROJECT (filter_project: null) call. */
  crossProject?: { id: string; similarity: number; metadata?: Record<string, unknown> }[];
  existingReinforcementCount?: number;
}

interface Probe {
  matchCalls: Record<string, unknown>[];
  row: Row;
  relationshipUpserts: { row: Record<string, unknown>; onConflict: string }[];
  supersedeUpdates: { payload: Record<string, unknown>; id: string }[];
}

function makeFakeClient(opts: FakeOpts, probe: Probe): any {
  return {
    rpc: async (name: string, args: Record<string, unknown>) => {
      assert.equal(name, 'match_memories');
      probe.matchCalls.push(args);
      if (args.filter_project === null) {
        return { data: opts.crossProject ?? [], error: null };
      }
      return { data: opts.inProject ?? [], error: null };
    },
    from: (table: string) => {
      if (table === 'memory_relationships') {
        return {
          upsert: (row: Record<string, unknown>, upsertOpts: { onConflict: string }) => {
            probe.relationshipUpserts.push({ row, onConflict: upsertOpts.onConflict });
            return {
              select: (_cols: string) => ({
                maybeSingle: async () => ({
                  data: { id: 'edge-id', created_at: 't0', inferred_at: 't0' },
                  error: null,
                }),
              }),
            };
          },
        };
      }
      assert.equal(table, 'memory_items');
      return {
        insert: (payload: Record<string, unknown>) => {
          probe.row.inserted = payload;
          return {
            select: (_cols: string) => ({
              maybeSingle: async () => ({ data: { id: '33333333-3333-3333-3333-333333333333' }, error: null }),
            }),
          };
        },
        update: (payload: Record<string, unknown>) => ({
          eq: async (col: string, id: string) => {
            assert.equal(col, 'id');
            if (id === 'existing-row-id') {
              probe.row.updated = payload;
            } else {
              probe.supersedeUpdates.push({ payload, id });
            }
            return { error: null };
          },
        }),
        select: (_cols: string) => ({
          eq: (_col: string, _id: string) => ({
            maybeSingle: async () => ({
              data: { reinforcement_count: opts.existingReinforcementCount ?? 1 },
              error: null,
            }),
          }),
        }),
      };
    },
  };
}

const fakeEmbed = async (_text: string) => new Array(1536).fill(0);

function makeProbe(): Probe {
  return { matchCalls: [], row: {}, relationshipUpserts: [], supersedeUpdates: [] };
}

test('merge-not-clobber: metadata shallow-merges, nothing from the old row is dropped', async () => {
  const probe = makeProbe();
  const client = makeFakeClient(
    {
      inProject: [
        {
          id: 'existing-row-id',
          similarity: 0.9,
          metadata: { importance: 'minor', old_only_key: 'preserved' },
        },
      ],
      existingReinforcementCount: 3,
    },
    probe
  );

  const result = await memoryRemember(
    { content: 'restated kitchen lesson', metadata: { importance: 'critical' } },
    { client, generateEmbedding: fakeEmbed }
  );

  assert.equal(result, 'updated');
  const payload = probe.row.updated!;
  const metadata = payload.metadata as Record<string, unknown>;
  assert.equal(metadata.old_only_key, 'preserved', 'a key only the old row had must survive');
  assert.equal(metadata.importance, 'critical', 'a key the new call supplies wins on conflict');
});

test('keep-canonical by default: content/embedding are NOT touched on a reinforcement', async () => {
  const probe = makeProbe();
  const client = makeFakeClient({ inProject: [{ id: 'existing-row-id', similarity: 0.9 }] }, probe);

  await memoryRemember({ content: 'a longer, noisier auto-captured restatement' }, { client, generateEmbedding: fakeEmbed });

  const payload = probe.row.updated!;
  assert.ok(!('content' in payload), 'default (no refresh) must not overwrite content');
  assert.ok(!('embedding' in payload), 'default (no refresh) must not overwrite embedding');
});

test('refresh:true lets the new content and embedding win', async () => {
  const probe = makeProbe();
  const client = makeFakeClient({ inProject: [{ id: 'existing-row-id', similarity: 0.9 }] }, probe);

  await memoryRemember(
    { content: 'a deliberate correction', refresh: true },
    { client, generateEmbedding: fakeEmbed }
  );

  const payload = probe.row.updated!;
  assert.equal(payload.content, 'a deliberate correction');
  assert.ok('embedding' in payload);
});

test('reinforcement_count increments from the fetched existing value', async () => {
  const probe = makeProbe();
  const client = makeFakeClient(
    { inProject: [{ id: 'existing-row-id', similarity: 0.9 }], existingReinforcementCount: 5 },
    probe
  );

  await memoryRemember({ content: 'reinforced again' }, { client, generateEmbedding: fakeEmbed });

  assert.equal(probe.row.updated!.reinforcement_count, 6);
});

test('a non-refresh merge records the rejected restatement (hash+length only, never full text)', async () => {
  const probe = makeProbe();
  const client = makeFakeClient({ inProject: [{ id: 'existing-row-id', similarity: 0.9 }] }, probe);
  const rejectedText = 'this exact text should not appear verbatim in metadata';

  await memoryRemember({ content: rejectedText }, { client, generateEmbedding: fakeEmbed });

  const metadata = probe.row.updated!.metadata as Record<string, unknown>;
  const rejected = metadata.rejected_restatements as Array<{ content_hash: string; length: number }>;
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0]!.length, rejectedText.length);
  assert.match(rejected[0]!.content_hash, /^[0-9a-f]{32}$/, 'must be an md5 hex digest, not the raw text');
  assert.ok(
    !JSON.stringify(metadata).includes(rejectedText),
    'the rejected text itself must never be duplicated into metadata'
  );
});

test('a refresh merge does NOT record a rejected restatement (nothing was rejected)', async () => {
  const probe = makeProbe();
  const client = makeFakeClient({ inProject: [{ id: 'existing-row-id', similarity: 0.9 }] }, probe);

  await memoryRemember({ content: 'accepted correction', refresh: true }, { client, generateEmbedding: fakeEmbed });

  const metadata = probe.row.updated!.metadata as Record<string, unknown>;
  assert.equal(metadata.rejected_restatements, undefined);
});

test('reinforcements[] is a capped ring buffer (cap 10, drop-oldest)', async () => {
  const priorReinforcements = Array.from({ length: 10 }, (_, i) => ({ ts: `t${i}`, source_agent: null, sprint_ref: null }));
  const probe = makeProbe();
  const client = makeFakeClient(
    {
      inProject: [
        { id: 'existing-row-id', similarity: 0.9, metadata: { reinforcements: priorReinforcements } },
      ],
    },
    probe
  );

  await memoryRemember({ content: 'the 11th reinforcement' }, { client, generateEmbedding: fakeEmbed });

  const metadata = probe.row.updated!.metadata as Record<string, unknown>;
  const reinforcements = metadata.reinforcements as unknown[];
  assert.equal(reinforcements.length, 10, 'cap must hold at 10, not grow unbounded');
});

test('similarity > 0.95 (exact-skip band) is unchanged: pure skip, no update at all', async () => {
  const probe = makeProbe();
  const client = makeFakeClient({ inProject: [{ id: 'existing-row-id', similarity: 0.97 }] }, probe);

  const result = await memoryRemember({ content: 'near-exact duplicate' }, { client, generateEmbedding: fakeEmbed });

  assert.equal(result, 'skipped');
  assert.equal(probe.row.updated, undefined, 'exact-skip must not touch the row at all');
});

test('force:true bypasses near-dup detection entirely — match_memories is never called', async () => {
  const probe = makeProbe();
  const client = makeFakeClient({ inProject: [{ id: 'existing-row-id', similarity: 0.99 }] }, probe);

  const result = await memoryRemember(
    { content: 'force a fresh row despite a near-exact match', force: true },
    { client, generateEmbedding: fakeEmbed }
  );

  assert.equal(result, 'inserted');
  assert.equal(probe.matchCalls.length, 0, 'force:true must skip the match_memories RPC entirely');
});

test('cross-project second pass fires ONLY for kitchen-graded content when the in-project pass is empty', async () => {
  const probe = makeProbe();
  const kitchenContent =
    'The general pattern here: this tradeoff recurs across every project, not just one — a recurring kitchen-level principle.';
  const client = makeFakeClient(
    { inProject: [], crossProject: [{ id: 'existing-row-id', similarity: 0.9 }] },
    probe
  );

  const result = await memoryRemember({ content: kitchenContent, project: 'project-a' }, { client, generateEmbedding: fakeEmbed });

  assert.equal(result, 'updated');
  assert.equal(probe.matchCalls.length, 2, 'expects an in-project pass then a cross-project pass');
  assert.equal(probe.matchCalls[0]!.filter_project, 'project-a');
  assert.equal(probe.matchCalls[1]!.filter_project, null);
});

test('cross-project second pass does NOT fire for recipe-graded content (stays project-scoped)', async () => {
  const probe = makeProbe();
  const recipeContent = 'Fixed in sprint 78 migration 26 at src/remember.ts:104, shipped v0.7.0, see PR #26.';
  const client = makeFakeClient(
    { inProject: [], crossProject: [{ id: 'existing-row-id', similarity: 0.9 }] },
    probe
  );

  const result = await memoryRemember({ content: recipeContent, project: 'project-a' }, { client, generateEmbedding: fakeEmbed });

  assert.equal(result, 'inserted', 'recipe content with no in-project match must insert fresh, never cross-project-match');
  assert.equal(probe.matchCalls.length, 1, 'recipe/unknown content must not trigger the cross-project pass');
});

test('rule_ref auto-creates an amends_rule memory_link edge (best-effort, after insert)', async () => {
  const probe = makeProbe();
  const client = makeFakeClient({}, probe);
  const ruleId = '11111111-1111-1111-1111-111111111111';

  await memoryRemember({ content: 'a fact that amends an existing rule', rule_ref: ruleId }, { client, generateEmbedding: fakeEmbed });

  assert.equal(probe.relationshipUpserts.length, 1);
  assert.equal(probe.relationshipUpserts[0]!.row.target_id, ruleId);
  assert.equal(probe.relationshipUpserts[0]!.row.relationship_type, 'amends_rule');
  assert.equal(probe.relationshipUpserts[0]!.row.source_id, '33333333-3333-3333-3333-333333333333');
});

test('supersedes marks the referenced row superseded_by/is_active=false AND links a supersedes edge', async () => {
  const probe = makeProbe();
  const client = makeFakeClient({}, probe);
  const oldId = '22222222-2222-2222-2222-222222222222';

  await memoryRemember({ content: 'a replacement for an old memory', supersedes: oldId }, { client, generateEmbedding: fakeEmbed });

  assert.equal(probe.supersedeUpdates.length, 1);
  assert.equal(probe.supersedeUpdates[0]!.id, oldId);
  assert.equal(probe.supersedeUpdates[0]!.payload.superseded_by, '33333333-3333-3333-3333-333333333333');
  assert.equal(probe.supersedeUpdates[0]!.payload.is_active, false);
  assert.ok(probe.relationshipUpserts.some((u) => u.row.relationship_type === 'supersedes' && u.row.target_id === oldId));
});

test('a malformed (non-UUID) rule_ref is skipped, never blocks the capture', async () => {
  const probe = makeProbe();
  const client = makeFakeClient({}, probe);

  const result = await memoryRemember(
    { content: 'capture must survive a garbage rule_ref', rule_ref: 'not-a-uuid' },
    { client, generateEmbedding: fakeEmbed }
  );

  assert.equal(result, 'inserted');
  assert.equal(probe.relationshipUpserts.length, 0, 'no link attempt for a malformed UUID');
});

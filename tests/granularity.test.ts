/**
 * Mnestra — granularity classifier (Sprint 79 T1, capture gates)
 *
 * Pins the regex-tier contract: kitchen markers always win over recipe
 * density (a kitchen lesson that cites a recipe as evidence stays kitchen);
 * recipe fires only above density with zero kitchen markers; ambiguous
 * content is 'unknown' (never downweighted by the recall.ts consumer).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { classifyGranularity } from '../src/granularity.js';

test('kitchen: a generalizable principle with no recipe markers', () => {
  const { granularity, matched_markers } = classifyGranularity(
    'The general pattern here is that shared-file collision protocols always need additive-only edits — this is a recurring tradeoff, not a one-off.'
  );
  assert.equal(granularity, 'kitchen');
  assert.ok(matched_markers.length > 0);
});

test('recipe: dense specific-instance markers with no kitchen language', () => {
  const { granularity, matched_markers } = classifyGranularity(
    'Fixed in sprint 78 migration 26 at src/remember.ts:104, shipped v0.7.0 on 2026-06-13, see PR #26.'
  );
  assert.equal(granularity, 'recipe');
  assert.ok(matched_markers.length >= 2);
});

test('a kitchen lesson that CITES a recipe as evidence stays kitchen (kitchen overrides density)', () => {
  const { granularity } = classifyGranularity(
    'Why this matters in general: sprint 62 migration 21 (src/db.ts:40) taught us this is a recurring tradeoff across every project, not just that one fix.'
  );
  assert.equal(granularity, 'kitchen');
});

test('one bare recipe marker (below density threshold) is unknown, not recipe', () => {
  const { granularity } = classifyGranularity('See sprint 42 for background.');
  assert.equal(granularity, 'unknown');
});

test('plain content with neither kitchen nor recipe markers is unknown', () => {
  const { granularity, matched_markers } = classifyGranularity('The sky is blue today.');
  assert.equal(granularity, 'unknown');
  assert.deepEqual(matched_markers, []);
});

test('classification is synchronous and pure — same input always yields the same output', () => {
  const input = 'migration 5 and migration 6 both touched src/foo.ts:12 in v1.2.3';
  const first = classifyGranularity(input);
  const second = classifyGranularity(input);
  assert.deepEqual(first, second);
});

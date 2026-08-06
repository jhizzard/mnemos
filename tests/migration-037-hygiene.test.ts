/**
 * Mnestra — migration 037 static hygiene assertions (Sprint 70 A-T1)
 *
 * Pins 037's SCHEMA-READY surface without a database. What belongs here is
 * everything whose failure mode is "somebody edited the migration and nothing
 * noticed" — and for this file that is an unusually sharp set, because three of
 * 037's properties are invisible in a passing behavioural test:
 *
 *   1. THE ARGUMENT LIST, IN ORDER, BY NAME. PostgREST binds RPC arguments by
 *      NAME from the JSON key set, so renaming or reordering one is a breaking
 *      change that no SQL-level test notices — the function still works, and
 *      every caller starts getting "could not find the function".
 *
 *   2. SINGLE OVERLOAD, AND 010 LEFT ALONE. 037's entire compatibility story is
 *      "memory_recall_graph is untouched, so the MNESTRA_GRAPH_RECALL-off path
 *      is byte-identical". A well-meaning future edit that folds the new
 *      arguments into 010, or adds a second memory_recall_graph_boosted
 *      overload, reintroduces the 404 outage documented at 034:87-92.
 *
 *   3. THE GRANT SET. Migration 014:45 grants EXECUTE on new public functions to
 *      anon and authenticated by DEFAULT PRIVILEGE. So the REVOKE is not
 *      defensive tidying — deleting that one line silently publishes a wider
 *      graph walk to the anon key, and every behavioural test still passes.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// Two levels: these run compiled from dist-tests/tests/, not from tests/.
const REPO_ROOT = path.resolve(HERE, '..', '..');
const MIGRATION_PATH = path.join(REPO_ROOT, 'migrations', '037_graph_walk_expansion.sql');

const SQL = fs.readFileSync(MIGRATION_PATH, 'utf8');
/** Comment-stripped view, so a phrase quoted in the prose never satisfies a code assertion. */
const CODE = SQL.split('\n')
  .filter((line) => !line.trimStart().startsWith('--'))
  .join('\n');

const FN = 'memory_recall_graph_boosted';

/** The frozen argument list, in order. Names are the PostgREST contract. */
const FROZEN_ARGS: ReadonlyArray<readonly [string, string, string | null]> = [
  ['query_embedding', 'vector(1536)', null],
  ['query_text', 'text', 'null'],
  ['project_filter', 'text', 'null'],
  ['max_depth', 'int', '2'],
  ['k', 'int', '10'],
  ['p_entity_weight', 'float', '0.45'],
  ['p_community_weight', 'float', '0.35'],
  ['p_entity_hub_cap', 'int', '12'],
  ['p_community_cap', 'int', '40'],
  ['p_max_rows', 'int', '50'],
  ['p_exclude_tier0', 'boolean', 'true'],
];

/**
 * The argument list, balanced-paren matched. A naive indexOf(')') stops inside
 * `vector(1536)` and silently reports a one-argument function.
 */
function argBlock(): string {
  const start = CODE.indexOf(`create or replace function public.${FN}(`);
  assert.notEqual(start, -1, `${FN} definition not found`);
  const open = CODE.indexOf('(', start);
  let depth = 0;
  for (let i = open; i < CODE.length; i++) {
    if (CODE[i] === '(') depth++;
    else if (CODE[i] === ')') {
      depth--;
      if (depth === 0) return CODE.slice(open + 1, i);
    }
  }
  throw new Error(`unbalanced parentheses in ${FN} argument list`);
}

/** Split on commas at paren-depth 0, so `vector(1536)` stays one argument. */
function splitTopLevel(block: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of block) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out.map((a) => a.trim()).filter(Boolean);
}

test('037: the argument list is frozen — names, order, types and defaults', () => {
  const args = splitTopLevel(argBlock());

  assert.equal(
    args.length,
    FROZEN_ARGS.length,
    `argument COUNT changed (${args.length} vs ${FROZEN_ARGS.length}). PostgREST binds by name; ` +
      `adding an argument here is fine only if every caller is updated in the same change.`
  );

  FROZEN_ARGS.forEach(([name, type, dflt], i) => {
    const actual = args[i]!.replace(/\s+/g, ' ');
    assert.ok(
      actual.startsWith(`${name} `),
      `argument ${i} should be named "${name}", got "${actual}" — renaming breaks every PostgREST caller`
    );
    assert.ok(actual.includes(type), `argument "${name}" should be typed ${type}, got "${actual}"`);
    if (dflt === null) {
      assert.ok(!/default/i.test(actual), `argument "${name}" must stay required, got "${actual}"`);
    } else {
      assert.ok(
        new RegExp(`default\\s+${dflt.replace('.', '\\.')}\\b`, 'i').test(actual),
        `argument "${name}" should default to ${dflt}, got "${actual}"`
      );
    }
  });
});

test('037: exactly one definition of the function — no overloads', () => {
  const defs = CODE.match(new RegExp(`create\\s+or\\s+replace\\s+function\\s+public\\.${FN}\\s*\\(`, 'gi')) ?? [];
  assert.equal(defs.length, 1, `${FN} must be defined exactly once; found ${defs.length}`);
});

test('037: migration 010 is left completely alone', () => {
  assert.ok(
    !/create\s+or\s+replace\s+function\s+public\.memory_recall_graph\s*\(/i.test(CODE),
    '037 must not redefine memory_recall_graph — the flag-off path has to stay byte-identical'
  );
  assert.ok(
    !/drop\s+function[^\n;]*memory_recall_graph\s*\(/i.test(CODE),
    '037 must not drop memory_recall_graph'
  );
  // And it asserts 010's continued existence at apply time.
  assert.ok(
    /proname\s*=\s*'memory_recall_graph'/.test(CODE),
    'the receipt should verify memory_recall_graph still has exactly one signature'
  );
});

test('037: [GATE 3] EXECUTE is revoked from PUBLIC/anon/authenticated and granted only to service_role', () => {
  assert.ok(
    /revoke\s+execute\s+on\s+function\s+public\.memory_recall_graph_boosted[\s\S]{0,200}?from\s+public,\s*anon,\s*authenticated/i.test(
      CODE
    ),
    'missing REVOKE EXECUTE ... FROM public, anon, authenticated — migration 014:45 makes new functions anon-executable by default privilege'
  );
  const grants = CODE.match(/grant\s+execute\s+on\s+function\s+public\.memory_recall_graph_boosted[\s\S]{0,220}?;/gi) ?? [];
  assert.equal(grants.length, 1, 'expected exactly one GRANT EXECUTE for the function');
  assert.ok(/to\s+service_role\s*;/i.test(grants[0]!), 'EXECUTE must be granted to service_role');
  assert.ok(
    !/\bto\b[^;]*\b(anon|authenticated|public)\b/i.test(grants[0]!),
    'EXECUTE must NOT be granted to anon/authenticated/public — 037 reaches strictly more memories than 010'
  );
});

test('037: [GATE 4] search_path is pinned in-statement and includes extensions', () => {
  assert.ok(
    /set\s+search_path\s*=\s*public,\s*extensions,\s*pg_catalog/i.test(CODE),
    'search_path must be pinned to `public, extensions, pg_catalog`; `extensions` is required for the vector(1536) argument'
  );
});

test('037: [GATE 5] the function is STABLE and SECURITY INVOKER', () => {
  const body = CODE.slice(CODE.indexOf(`create or replace function public.${FN}(`));
  const header = body.slice(0, body.indexOf('as $$'));
  assert.ok(/\bstable\b/i.test(header), 'must be STABLE — read-only is meant to be structural, not a promise');
  assert.ok(/security\s+invoker/i.test(header), 'must be SECURITY INVOKER');
  assert.ok(!/security\s+definer/i.test(CODE), '037 introduces no SECURITY DEFINER function');
});

test('037: [GATE 2] no policies and no permissive WITH CHECK', () => {
  assert.ok(!/create\s+policy/i.test(CODE), '037 creates no policies');
  assert.ok(!/with\s+check\s*\(\s*true\s*\)/i.test(CODE), 'no WITH CHECK (true) anywhere');
});

test('037: all three expansion arms are present and self-labelling', () => {
  for (const label of ["'typed:'", "'entity:'", "'community:'"]) {
    assert.ok(CODE.includes(label), `edge arm label ${label} missing — a caller cannot tell which arm fired without it`);
  }
  assert.ok(/memory_relationships/.test(CODE), 'typed arm must read memory_relationships');
  assert.ok(/memory_entity_mentions/.test(CODE), 'entity arm must read memory_entity_mentions');
  assert.ok(/community_summary/.test(CODE), 'community arm must read consolidation community summaries');
});

test('037: the typed arm still traverses LIVE edges only', () => {
  assert.ok(/r\.invalid_at\s+is\s+null/i.test(CODE), 'typed arm must filter invalid_at IS NULL (034 §1 temporal validity)');
});

test('037: caps and clamps are enforced inside the function, not trusted from the caller', () => {
  assert.ok(
    /least\(greatest\(coalesce\(max_depth,\s*2\),\s*1\),\s*2\)/i.test(CODE.replace(/\s+/g, ' ')),
    'max_depth must be clamped inside to [1,2]'
  );
  assert.ok(
    /least\(greatest\(coalesce\(p_max_rows,\s*50\),\s*1\),\s*200\)/i.test(CODE.replace(/\s+/g, ' ')),
    'p_max_rows must be clamped inside to [1,200]'
  );
  assert.ok(/mention_count\s*<=\s*greatest\(coalesce\(p_entity_hub_cap/i.test(CODE), 'entity hub cap must be applied');
  assert.ok(/coalesce\(p_community_cap/i.test(CODE), 'community size cap must be applied');
});

test('037: privacy_tags is returned so the caller can apply the privacy gate', () => {
  assert.ok(/privacy_tags\s+text\[\]/i.test(CODE), 'privacy_tags must be in the RETURNS TABLE (034 REQ-1e passthrough)');
  assert.ok(/mi\.privacy_tags/i.test(CODE), 'privacy_tags must actually be selected from memory_items');
});

test('037: [seam §3] the tier-0 belt gates entity seeding, seed admission and traversal', () => {
  const belts = CODE.match(/source_type\s+is\s+distinct\s+from\s+'objective'/gi) ?? [];
  assert.equal(
    belts.length,
    3,
    'the tier-0 belt must appear exactly three times — inside entity_seeds (before its cap), on seed admission, and on the node being traversed into'
  );
  const gated = CODE.match(/not\s+coalesce\(p_exclude_tier0,\s*true\)/gi) ?? [];
  assert.equal(gated.length, 3, 'every belt site must be gated on p_exclude_tier0');
});

/**
 * A-T4 AUDIT-FAIL 2026-08-05 20:22. The entity-seed cap was applied BEFORE the
 * project filter, so out-of-project mentions ate the budget and evicted the
 * in-project seed the caller was entitled to (entity 'helena': 7 mentions in
 * chopin-in-bohemia, 1 in termdeck -> a termdeck recall got zero entity seeds
 * at k=1). Reordering these two lines is a silent, data-dependent recall loss —
 * the canonical query never exposed it because all six of its candidates happen
 * to be in-project. Pinned textually because it is an ORDERING property: the SQL
 * stays valid and every other assertion still passes when it regresses.
 */
test('037: every seed-rejecting predicate runs BEFORE the entity-seed cap', () => {
  const start = CODE.indexOf('entity_seeds as (');
  assert.notEqual(start, -1, 'entity_seeds CTE not found');
  const end = CODE.indexOf('seeds as (', start + 'entity_seeds as ('.length);
  assert.notEqual(end, -1, 'could not delimit the entity_seeds CTE');
  const block = CODE.slice(start, end);

  const limitAt = block.search(/limit\s+least\(\s*4\s*\*/i);
  assert.notEqual(limitAt, -1, 'the entity-seed cap is missing from entity_seeds');

  for (const [what, re] of [
    ['project filter', /project_filter\s+is\s+null\s+or\s+mi\.project\s*=\s*project_filter/i],
    ['tombstone filter', /superseded_by\s+is\s+null/i],
    ['tier-0 belt', /source_type\s+is\s+distinct\s+from\s+'objective'/i],
  ] as const) {
    const at = block.search(re);
    assert.notEqual(at, -1, `${what} is missing from entity_seeds entirely`);
    assert.ok(
      at < limitAt,
      `${what} must be applied BEFORE the cap — after it, a rejected candidate still consumes seed budget and evicts a valid one`
    );
  }
});

test('037: tombstone hygiene is applied to seeds and to every traversed node', () => {
  const tombstoned = CODE.match(/superseded_by\s+is\s+null/gi) ?? [];
  assert.ok(
    tombstoned.length >= 3,
    `expected tombstone filtering on seeds, traversal target and community summaries; found ${tombstoned.length}`
  );
});

test('037: the walk is cycle-guarded', () => {
  assert.ok(/not\s*\(\s*nb\.next_id\s*=\s*any\s*\(\s*w\.path\s*\)\s*\)/i.test(CODE), 'recursive step must carry the cycle guard');
});

test('037: the apply-time receipt is HARD-FAILING, not advisory', () => {
  const receipt = CODE.slice(CODE.lastIndexOf('do $$'));
  const raises = receipt.match(/raise\s+exception/gi) ?? [];
  assert.ok(
    raises.length >= 8,
    `the receipt must RAISE on every gate it checks (apply_migration has a silent-no-op mode); found ${raises.length}`
  );
});

test('037: set-returning functions over jsonb are type-guarded before expansion', () => {
  // A WHERE-clause guard does not protect a lateral SRF — it is evaluated as
  // part of the join. Both jsonb expansions must guard inline instead.
  const guards = CODE.match(/jsonb_typeof\([^)]*\)\s*=\s*'array'/gi) ?? [];
  assert.ok(
    guards.length >= 3,
    `aliases and member_ids expansions must be jsonb_typeof-guarded inline; found ${guards.length}`
  );
});

test('037: entity keys are regex-escaped before interpolation into a pattern', () => {
  const escapes = CODE.match(/regexp_replace\(/gi) ?? [];
  assert.ok(
    escapes.length >= 2,
    'entity_key and alias must both be escaped before being used as a regex — an entity named "c++" is otherwise a bad match at best and an error at worst'
  );
});
